/** The mix around the listener: reverb zones, Doppler, occlusion, ducking, HRTF and banks. */

import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { AudioMix, EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import type { Physics3dService } from '../../services/index.js';
import { HeadlessAudio } from '../../../platform/headless/audio.js';
import { audio, dopplerFactor, reverbAt } from './index.js';
import type { AudioNamespace } from './index.js';

const DT = 1 / 60;
const AUDIO_SOURCE_DEF: ComponentDef = {
  id: 'audio_source',
  schema: {
    sound: t.ref('asset:sound', { default: '' }), playing: t.bool({ default: true }), loop: t.bool({ default: true }),
    volume: t.number({ default: 1 }), pitch: t.number({ default: 1 }), spatial: t.bool({ default: true }),
  },
};
const CAMERA_DEF: ComponentDef = { id: 'camera', schema: {} };
const SOUNDS = ['assets/sfx/hum.ogg', 'assets/sfx/line.ogg', 'assets/sfx/roar.ogg', 'assets/music/theme.ogg'];

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** A wall: a ray crossing x = 5 hits it (the stand-in for the physics3d service). */
const wallAtX5: KernelPlugin = {
  id: 'physics3d',
  install: (k) => k.provide(PHYSICS3D_SERVICE, {
    raycast: (origin: Vec3, direction: Vec3, max: number) => {
      if (direction.x <= 0 || origin.x >= 5) return undefined;
      const distance = (5 - origin.x) / direction.x;
      return distance <= max ? { entity: undefined, point: origin.__add__(direction.__mul__(distance)), normal: new Vec3(-1, 0, 0), distance } : undefined;
    },
  } as unknown as Physics3dService),
};

function setup(entities: unknown[], prefabs: Record<string, unknown> = {}, plugins: KernelPlugin[] = []) {
  const project = loadProject(files({
    'assets/audio.json': {},
    'prefabs/camera.prefab.json': { components: { camera: {} } },
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const out = new HeadlessAudio();
  const plugin = audio({ output: out, assets: SOUNDS, defaults: project.audio, seed: 1, mode: '3d' });
  const game: GameDefinition = {
    components: [AUDIO_SOURCE_DEF, CAMERA_DEF],
    resources: [{ id: 'settings', keep: 'profile', schema: { master_volume: t.number({ default: 1 }), music_volume: t.number({ default: 1 }), sfx_volume: t.number({ default: 1 }) } }],
    events: [], behaviors: [], systems: [],
  };
  const kernel = new Kernel({ project, game, plugins: [...plugins, plugin], context: {}, fixedStep: DT });
  const ctx = plugin.namespace!.create(kernel) as AudioNamespace;
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  const move = (placed: string, at: Vec3): void => { kernel.world.get(id(placed))!.transform.position = at; };
  const mixes = (): AudioMix[] => out.frames.flatMap((f) => f.commands).filter((c): c is AudioMix => c.kind === 'mix');
  return { kernel, out, ctx, id, move, mixes, steps: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); } };
}

describe('reverbAt', () => {
  const zone = (id: number, x: number, fields: Record<string, unknown>) => ({
    id: id as EntityId, at: new Vec3(x, 0, 0), fields: { preset: 'hall', mix: 0.6, radius: 10, blend: 4, priority: 0, ...fields },
  });
  it('fades in over the blend band, and the strongest zone wins (then priority, then the older)', () => {
    expect(reverbAt(new Vec3(20, 0, 0), [zone(1, 0, {})])).toBeNull();
    expect(reverbAt(new Vec3(8, 0, 0), [zone(1, 0, {})])).toEqual({ preset: 'hall', wet: 0.3 });
    expect(reverbAt(new Vec3(0, 0, 0), [zone(1, 0, {})])).toEqual({ preset: 'hall', wet: 0.6 });
    expect(reverbAt(new Vec3(0, 0, 0), [zone(1, 0, {}), zone(2, 0, { preset: 'cave', mix: 0.9 })])).toEqual({ preset: 'cave', wet: 0.9 });
    expect(reverbAt(new Vec3(0, 0, 0), [zone(2, 0, { preset: 'cave' }), zone(1, 0, { priority: 1 })])).toEqual({ preset: 'hall', wet: 0.6 });
    expect(reverbAt(new Vec3(0, 0, 0), [zone(2, 0, { preset: 'cave' }), zone(1, 0, {})])).toEqual({ preset: 'hall', wet: 0.6 });
  });
});

describe('dopplerFactor', () => {
  it('rises approaching, falls receding, scales and clamps, and is 1 when still or frozen', () => {
    const at = new Vec3(0, 0, 0);
    // A source 34.3 m/s toward a still listener: 343 / (343 − 34.3) ≈ 1.111.
    expect(dopplerFactor(new Vec3(-10, 0, 0), new Vec3(-10.5717, 0, 0), at, at, 1 / 60, 1)).toBe(1.11);
    expect(dopplerFactor(new Vec3(-10.5717, 0, 0), new Vec3(-10, 0, 0), at, at, 1 / 60, 1)).toBe(0.91);
    expect(dopplerFactor(new Vec3(-10, 0, 0), new Vec3(-10.5717, 0, 0), at, at, 1 / 60, 0.5)).toBe(1.055);
    expect(dopplerFactor(new Vec3(-10, 0, 0), new Vec3(-10.5717, 0, 0), at, at, 0, 1)).toBe(1);
    expect(dopplerFactor(new Vec3(-10, 0, 0), new Vec3(-100, 0, 0), at, at, 1 / 60, 1)).toBe(2);
  });
});

describe('the audio plugin\'s mix', () => {
  it('sends no mix until a listener component or a zone changes it (existing games are unchanged)', () => {
    const g = setup([{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }]);
    g.steps(3);
    expect(g.mixes()).toEqual([]);
  });

  it('follows the listener into and out of a reverb zone', () => {
    const g = setup([
      { prefab: 'camera', id: 'cam', at: [30, 0, 0] },
      { prefab: 'cave', id: 'cave', at: [0, 0, 0] },
    ], { cave: { components: { reverb_zone: { preset: 'cave', mix: 0.8, radius: 10, blend: 0 } } } });
    g.steps();
    expect(g.mixes()).toEqual([]);
    g.move('cam', new Vec3(2, 0, 0));
    g.steps();
    expect(g.out.mix.reverb).toEqual({ preset: 'cave', wet: 0.8 });
    g.steps(2);
    expect(g.mixes()).toHaveLength(1);
    g.move('cam', new Vec3(30, 0, 0));
    g.steps();
    expect(g.out.mix.reverb).toBeNull();
  });

  it('an audio_listener sets HRTF panning and ducking, and becomes the listener', () => {
    const g = setup([
      { prefab: 'camera', id: 'cam', at: [0, 0, 0] },
      { prefab: 'ears', id: 'ears', at: [4, 0, 0] },
    ], { ears: { components: { audio_listener: { panning: 'hrtf', duck_level: 0.2 } } } });
    g.ctx.play({ sound: 'sfx/line', at: null, volume: 1, pitch: 1, to: null, duck: true });
    g.steps();
    expect(g.out.mix).toMatchObject({ panning: 'hrtf', duckLevel: 0.2 });
    expect(g.out.listener?.position).toEqual([4, 0, 0]);
    expect(g.out.listener).toMatchObject({ right: [1, 0, 0], forward: [0, 0, 1], up: [0, 1, 0] });
    expect(g.out.playsOf('sfx/line')[0]).toMatchObject({ duck: true });
  });

  it('Doppler bends a moving source\'s pitch only with an audio_listener', () => {
    const scene = (listener: boolean) => [
      { prefab: 'camera', id: 'cam', at: [0, 0, 0], ...(listener && { components: { audio_listener: {} } }) },
      { prefab: 'car', id: 'car', at: [-30, 0, 0] },
    ];
    const prefabs = { car: { components: { audio_source: { sound: 'sfx/hum' } } } };
    for (const listener of [false, true]) {
      const g = setup(scene(listener), prefabs);
      g.steps();
      for (let i = 1; i <= 5; i++) { g.move('car', new Vec3(-30 + i * 0.5, 0, 0)); g.steps(); }
      expect(g.out.loops[0]!.pitch).toBe(listener ? 1.095 : 1);
    }
  });

  it('occlusion: a wall between listener and sound marks the voice occluded; stepping past it clears', () => {
    const g = setup([
      { prefab: 'camera', id: 'cam', at: [0, 0, 0], components: { audio_listener: { occlusion: true } } },
      { prefab: 'hum', id: 'hum', at: [10, 0, 0] },
    ], { hum: { components: { audio_source: { sound: 'sfx/hum' } } } }, [wallAtX5]);
    g.steps();
    expect(g.out.loops[0]!.occlusion).toBe(1);
    g.ctx.play({ sound: 'sfx/roar', at: new Vec3(12, 0, 0), volume: 1, pitch: 1, to: null });
    g.ctx.play({ sound: 'sfx/roar', at: new Vec3(-12, 0, 0), volume: 1, pitch: 1, to: null });
    g.steps();
    expect(g.out.playsOf('sfx/roar').map((p) => p.occlusion)).toEqual([1, 0]);
    g.move('cam', new Vec3(6, 0, 0));
    g.steps(4);
    expect(g.out.loops[0]!.occlusion).toBe(0);
  });

  it('a wall within reach of the listener (its own player) is stepped over', () => {
    const g = setup([
      { prefab: 'camera', id: 'cam', at: [3, 0, 0], components: { audio_listener: { occlusion: true } } },
      { prefab: 'hum', id: 'hum', at: [10, 0, 0] },
    ], { hum: { components: { audio_source: { sound: 'sfx/hum' } } } }, [wallAtX5]);
    g.steps();
    expect(g.out.loops[0]!.occlusion).toBe(0);
  });

  it('plays a material\'s impact sound at the contact, scaled by speed, limited per sound, unless turned off', () => {
    const IMPACT = { id: 'impact', target: 'entity' };
    const physics: KernelPlugin = { id: 'physics3d', events: [IMPACT] };
    const g = setup([{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }], {}, [physics]);
    const hit = (speed: number, sound: string | null = 'sfx/roar') => g.kernel.emit(IMPACT, {
      entity: g.id('cam'), other: g.id('cam'), point: new Vec3(1, 0, 0), normal: new Vec3(0, 1, 0), speed,
      material: 'stone', other_material: null, sound,
    });
    hit(4);
    hit(20);
    hit(1, null);
    for (let i = 0; i < 5; i++) hit(8);
    g.steps();
    expect(g.out.playsOf('sfx/roar').map((p) => [p.volume, p.position])).toEqual([[0.5, [1, 0, 0]], [1, [1, 0, 0]], [1, [1, 0, 0]]]);
    g.steps(10);
    g.ctx.impact_sounds = false;
    hit(8);
    g.steps();
    expect(g.out.playsOf('sfx/roar')).toHaveLength(3);
    g.ctx.impact_sounds = true;
    hit(8);
    g.steps();
    expect(g.out.playsOf('sfx/roar')).toHaveLength(4);
  });

  it('banks: preload and unload name sounds by handle; an unknown one is coded', () => {
    const g = setup([{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }]);
    g.ctx.unload(['sfx/roar', 'music/theme']);
    expect(g.out.released).toEqual([['assets/sfx/roar.ogg', 'assets/music/theme.ogg']]);
    expect(g.out.preloaded).not.toContain('assets/sfx/roar.ogg');
    g.ctx.preload(['sfx/roar']);
    expect(g.out.preloaded).toContain('assets/sfx/roar.ogg');
    expect(() => g.ctx.preload(['sfx/rawr'])).toThrow(/PP2063.*Did you mean "sfx\/roar"/s);
  });
});
