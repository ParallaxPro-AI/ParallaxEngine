/**
 * The cinematics plugin on a bare kernel with stand-in `camera` and `light` components and
 * a stand-in actions service: easing and channel sampling, the parser's diagnostics, a
 * full timeline (camera, transform, visibility, property, markers), skip, restore, trigger
 * volumes, scene autoplay, and snapshot/restore mid-cinematic.
 */

import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { Fields, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { ACTIONS_SERVICE } from '../../services/index.js';
import { CINEMATIC_EVENTS, cinematics, ease, EASE_NAMES, parseCinematic, sample, slerp } from './index.js';
import type { CinematicsPlugin } from './index.js';

const DT = 1 / 60;
const SKIP = { action: 'skip' };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

const INTRO = {
  duration: 2,
  tracks: [
    { type: 'camera', keys: [
      { t: 0, position: [0, 5, -10], look_at: 'hero', fov: 50 },
      { t: 1, position: [0, 2, -4], relative_to: 'hero', look_at: 'hero', fov: 30, ease: 'linear' },
      { t: 1.5, position: [10, 3, 0], rotation: [0, -90, 0], cut: true },
    ] },
    { type: 'transform', target: 'gate', keys: [{ t: 1, position: [0, 4, 5], ease: 'linear' }] },
    { type: 'visibility', target: 'ghost', keys: [{ t: 0.5, visible: false }] },
    { type: 'property', target: 'lamp', field: 'light.intensity', restore: true, keys: [{ t: 0, value: 0 }, { t: 2, value: 4, ease: 'linear' }] },
    { type: 'property', target: 'lamp', field: 'light.color', keys: [{ t: 2, value: '#ff0000', ease: 'linear' }] },
    { type: 'event', keys: [{ t: 0, name: 'begin' }, { t: 1, name: 'gate' }] },
  ],
};

function data(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'prefabs/cam.prefab.json': { components: { camera: { rig: 'follow', fov: 60 } } },
    'prefabs/thing.prefab.json': { components: {} },
    'prefabs/hero.prefab.json': { components: {}, tags: ['player'] },
    'prefabs/lamp.prefab.json': { components: { light: { intensity: 1 } } },
    'prefabs/zone.prefab.json': { components: { cinematic_trigger: { cinematic: 'walk_in', radius: 2, activator: 'player' } } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'cam', id: 'cam', at: [0, 10, -20] },
        { prefab: 'hero', id: 'hero', at: [0, 0, 0] },
        { prefab: 'thing', id: 'gate', at: [0, 0, 5] },
        { prefab: 'thing', id: 'ghost', at: [3, 0, 0] },
        { prefab: 'lamp', id: 'lamp', at: [0, 3, 0] },
      ],
    },
    'content/cinematic/intro.json': INTRO,
    ...extra,
  };
}

interface Rig {
  readonly kernel: Kernel;
  readonly plugin: CinematicsPlugin;
  readonly heard: string[];
  readonly keys: { skip: boolean };
  step(frames?: number): void;
  id(placed: string): EntityId;
  fields(placed: string, component: string): Fields;
}

function rig(contents: Record<string, unknown>, options: { skip?: boolean } = {}): Rig {
  const keys = { skip: false };
  const heard: string[] = [];
  const stand: KernelPlugin = {
    id: 'stand_in',
    components: [
      { id: 'camera', schema: { rig: t.enum(['fixed', 'follow', 'orbit', 'first_person'], { default: 'fixed' }), fov: t.number({ default: 60 }) } },
      { id: 'light', schema: { intensity: t.number({ default: 1 }), color: t.color({ default: Color.WHITE }), on: t.bool({ default: true }) } },
    ],
    install(k) {
      k.provide(ACTIONS_SERVICE, {
        pressed: (a) => a === SKIP && keys.skip, held: () => false, live: () => true, device: () => 'keyboard',
        find: () => undefined, names: () => [], glyphs: () => [],
      });
    },
  };
  let kernel: Kernel | undefined;
  const listener: SystemDef = {
    id: 'listener', scenes: [],
    handlers: [
      { event: CINEMATIC_EVENTS.started, method: 'started' },
      { event: CINEMATIC_EVENTS.marker, method: 'marker' },
      { event: CINEMATIC_EVENTS.ended, method: 'ended' },
    ],
    create: () => ({
      started: (_c: unknown, e: Fields) => heard.push(`${kernel!.time.frame} started ${String(e['cinematic'])}`),
      marker: (_c: unknown, e: Fields) => heard.push(`${kernel!.time.frame} marker ${String(e['name'])}@${String(e['time'])}${e['skipped'] === true ? ' skipped' : ''}`),
      ended: (_c: unknown, e: Fields) => heard.push(`${kernel!.time.frame} ended ${String(e['cinematic'])}${e['skipped'] === true ? ' skipped' : ''}`),
    }),
  };
  const plugin = cinematics({ host: { ref: (_k, id) => `ref:${id}` }, ...(options.skip === true && { skip: SKIP }) });
  const project = loadProject(files(contents));
  expect(project.diagnostics).toEqual([]);
  kernel = new Kernel({ project, game: { components: [], events: [], behaviors: [], systems: [listener], resources: [] }, plugins: [stand, plugin] });
  kernel.start('main');
  const k = kernel;
  const r: Rig = {
    kernel: k, plugin, heard, keys,
    step(frames = 1) { for (let i = 0; i < frames; i++) k.step(DT); },
    id(placed) {
      for (const record of k.world.live()) if (record.placedId === placed) return record.id;
      throw new Error(`no ${placed}`);
    },
    fields(placed, component) { return k.world.get(r.id(placed))!.components.get(component)!; },
  };
  return r;
}

const pos = (r: Rig, placed: string): Vec3 => r.kernel.world.get(r.id(placed))!.transform.position;

describe('easing and sampling', () => {
  it('every ease maps 0 → 0 and 1 → 1; in_out_quad is symmetric', () => {
    for (const name of EASE_NAMES) {
      expect(ease(name, 0)).toBeCloseTo(0, 9);
      expect(ease(name, 1)).toBeCloseTo(1, 9);
    }
    expect(ease('in_out_quad', 0.5)).toBeCloseTo(0.5, 9);
    expect(ease('in_quad', 0.5)).toBeCloseTo(0.25, 9);
    expect(ease('linear', 2)).toBe(1);
  });

  it('a channel blends from the implicit start, holds before a cut, and holds after the last key', () => {
    const keys = [
      { t: 1, ease: 'linear', cut: false, value: 10 },
      { t: 2, ease: 'linear', cut: true, value: 20 },
    ];
    const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
    expect(sample(keys, 0, 0, lerp)).toBe(0);
    expect(sample(keys, 0, 0.5, lerp)).toBe(5);
    expect(sample(keys, 0, 1, lerp)).toBe(10);
    expect(sample(keys, 0, 1.99, lerp)).toBe(10);
    expect(sample(keys, 0, 2, lerp)).toBe(20);
    expect(sample(keys, 0, 9, lerp)).toBe(20);
    // A key at 0 replaces the start; step channels never blend.
    expect(sample([{ t: 0, ease: 'linear', cut: false, value: 3 }, ...keys], 0, 0.5, lerp)).toBe(6.5);
    expect(sample(keys, 0, 0.5, lerp, true)).toBe(0);
  });

  it('slerp takes the short arc', () => {
    const a = Quat.from_euler(new Vec3(0, 0, 0));
    const b = Quat.from_euler(new Vec3(0, 90, 0));
    expect(slerp(a, b, 0.5).to_euler().y).toBeCloseTo(45, 6);
    expect(slerp(a, new Quat(-b.x, -b.y, -b.z, -b.w), 0.5).to_euler().y).toBeCloseTo(45, 6);
  });
});

describe('parseCinematic', () => {
  it('reads the documented form; duration defaults to the last key', () => {
    const { cinematic, diagnostics } = parseCinematic('intro', { ...INTRO, duration: undefined });
    expect(diagnostics).toEqual([]);
    expect(cinematic!.duration).toBe(2);
    expect(cinematic!.skippable).toBe(true);
    expect(cinematic!.tracks.map((tr) => tr.type)).toEqual(['camera', 'transform', 'visibility', 'property', 'property', 'event']);
  });

  it('reports every problem with a pointer', () => {
    const { cinematic, diagnostics } = parseCinematic('bad', {
      duration: 1,
      colour: 1,
      tracks: [
        { type: 'transform', target: 'a', keys: [{ t: 2, position: [0, 0, 0] }, { t: 1, position: [0, 0] }] },
        { type: 'property', target: 'a', field: 'intensity', keys: [{ t: 0, value: 1 }] },
        { type: 'camera', keys: [{ t: 0, position: [0, 0, 0], ease: 'bouncy' }] },
        { type: 'camera', keys: [{ t: 0, fov: 40 }] },
        { type: 'sound', keys: [] },
      ],
    }, 'content/cinematic/bad.json');
    expect(cinematic).toBeUndefined();
    expect(diagnostics.map((d) => `${d.code} ${d.pointer}`)).toEqual([
      'PP7200 /colour',
      'PP7202 /tracks/0/keys/1/t',
      'PP7204 /tracks/0/keys/1/position',
      'PP7205 /tracks/1/field',
      'PP7203 /tracks/2/keys/0/ease',
      'PP7201 /tracks/4/type',
      'PP7201 /tracks',
      'PP7202 /duration',
    ]);
    expect(diagnostics.every((d) => d.path === 'content/cinematic/bad.json')).toBe(true);
  });
});

describe('cinematics', () => {
  it('plays every track on time; markers fire once on their frame; the end state stays and the camera is handed back', () => {
    const r = rig(data());
    r.step();
    const engine = r.plugin.engine();
    const lampStart = r.fields('lamp', 'light')['intensity'];
    expect(lampStart).toBe(1);
    engine.play('intro', new Map());
    const startFrame = r.kernel.time.frame;
    expect(engine.playing).toBe(true);
    // t = 0 applied at once: the camera takes the first shot, its rig is held.
    const cam = r.kernel.world.get(r.id('cam'))!;
    expect(cam.components.get('camera')!['rig']).toBe('fixed');
    expect(cam.transform.position.is_close(new Vec3(0, 5, -10))).toBe(true);
    expect(cam.components.get('camera')!['fov']).toBe(50);
    expect(cam.transform.rotation.rotate(Vec3.FORWARD).is_close(new Vec3(0, -5, 10).normalized())).toBe(true);
    expect(r.fields('lamp', 'light')['intensity']).toBe(0);

    r.step(30); // t = 0.5
    expect(pos(r, 'gate').is_close(new Vec3(0, 2, 5))).toBe(true);
    expect(r.kernel.world.get(r.id('ghost'))!.visible).toBe(false);
    expect(r.fields('lamp', 'light')['intensity']).toBeCloseTo(1, 9);
    expect(cam.components.get('camera')!['fov']).toBeCloseTo(40, 9);

    r.step(30); // t = 1
    expect(r.heard.filter((h) => h.includes('marker'))).toEqual([`${startFrame + 1} marker begin@0`, `${startFrame + 60} marker gate@1`]);
    // relative_to the hero, looking at it.
    expect(cam.transform.position.is_close(new Vec3(0, 2, -4))).toBe(true);
    r.kernel.world.get(r.id('hero'))!.transform.position = new Vec3(1, 0, 0);
    r.step(15); // t = 1.25: following the moving hero; the cut at 1.5 holds the shot
    expect(cam.transform.position.is_close(new Vec3(1, 2, -4))).toBe(true);
    r.step(15); // t = 1.5: the cut lands
    expect(cam.transform.position.is_close(new Vec3(10, 3, 0))).toBe(true);
    expect(cam.transform.rotation.is_close(Quat.from_euler(new Vec3(0, -90, 0)))).toBe(true);

    r.step(30); // t = 2: ends
    expect(engine.playing).toBe(false);
    expect(r.heard.at(-1)).toBe(`${startFrame + 120} ended ref:intro`);
    expect(r.heard.filter((h) => h.includes('marker'))).toHaveLength(2);
    expect(pos(r, 'gate').is_close(new Vec3(0, 4, 5))).toBe(true);
    expect((r.fields('lamp', 'light')['color'] as Color).__eq__(new Color(1, 0, 0))).toBe(true);
    // restore: the intensity track puts the starting value back.
    expect(r.fields('lamp', 'light')['intensity']).toBe(1);
    expect(cam.components.get('camera')!['rig']).toBe('follow');
    expect(cam.components.get('camera')!['fov']).toBe(60);
  });

  it('skip lands on the end state exactly and fires the markers left, flagged skipped', () => {
    const r = rig(data(), { skip: true });
    r.step();
    r.plugin.engine().play('intro', new Map());
    r.step(10);
    r.keys.skip = true;
    r.step();
    r.keys.skip = false;
    const engine = r.plugin.engine();
    expect(engine.playing).toBe(false);
    expect(pos(r, 'gate').is_close(new Vec3(0, 4, 5))).toBe(true);
    expect(r.kernel.world.get(r.id('ghost'))!.visible).toBe(false);
    expect((r.fields('lamp', 'light')['color'] as Color).__eq__(new Color(1, 0, 0))).toBe(true);
    expect(r.fields('lamp', 'light')['intensity']).toBe(1);
    expect(r.heard.slice(-2).map((h) => h.replace(/^\d+ /, ''))).toEqual(['marker gate@1 skipped', 'ended ref:intro skipped']);
    expect(engine.skip()).toBe(false);
  });

  it('the skip action leaves an unskippable cinematic alone; code can still skip it', () => {
    const r = rig(data({ 'content/cinematic/intro.json': { ...INTRO, skippable: false } }), { skip: true });
    r.step();
    const engine = r.plugin.engine();
    engine.play('intro', new Map());
    r.keys.skip = true;
    r.step(5);
    expect(engine.playing).toBe(true);
    expect(engine.skip()).toBe(true);
    expect(engine.playing).toBe(false);
  });

  it('snapshot / restore mid-cinematic resumes on the same path', () => {
    const r = rig(data());
    r.step();
    r.plugin.engine().play('intro', new Map());
    r.step(40);
    const snap = r.kernel.snapshot();
    const heardAt = r.heard.length;
    const trace = (): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 90; i++) {
        r.step();
        const cam = r.kernel.world.get(r.id('cam'))!;
        out.push(`${cam.transform.position} ${String(cam.components.get('camera')!['fov'])} ${pos(r, 'gate')} ${String(r.fields('lamp', 'light')['intensity'])}`);
      }
      return out;
    };
    const first = trace();
    const firstHeard = r.heard.slice(heardAt).map((h) => h.replace(/^\d+ /, ''));
    r.kernel.restore(snap);
    expect(r.plugin.engine().playing).toBe(true);
    expect(r.plugin.engine().time).toBeCloseTo(40 * DT, 9);
    const before = r.heard.length;
    expect(trace()).toEqual(first);
    expect(r.heard.slice(before).map((h) => h.replace(/^\d+ /, ''))).toEqual(firstHeard);
    expect(r.fields('lamp', 'light')['intensity']).toBe(1);
    expect(r.kernel.world.get(r.id('cam'))!.components.get('camera')!['rig']).toBe('follow');
  });

  it('a trigger volume plays when its activator walks in, binding "activator"; once means once', () => {
    const walkIn = { bind: ['activator'], tracks: [{ type: 'transform', target: 'activator', keys: [{ t: 0.5, scale: 2 }] }] };
    const contents = data({ 'content/cinematic/walk_in.json': walkIn });
    (contents['scenes/main/scene.json'] as { entities: unknown[] }).entities.push({ prefab: 'zone', id: 'zone', at: [0, 0, 10] });
    const r = rig(contents);
    r.step(3);
    expect(r.plugin.engine().playing).toBe(false);
    const hero = r.kernel.world.get(r.id('hero'))!;
    hero.transform.position = new Vec3(0, 0, 9);
    r.step();
    expect(r.plugin.engine().current).toBe('walk_in');
    r.step(40);
    expect(hero.transform.scale.is_close(new Vec3(2, 2, 2))).toBe(true);
    expect(r.fields('zone', 'cinematic_trigger')).toMatchObject({ fired: true, occupied: true });
    hero.transform.position = Vec3.ZERO;
    r.step();
    hero.transform.position = new Vec3(0, 0, 9);
    r.step();
    expect(r.plugin.engine().playing).toBe(false);
  });

  it('plays by itself when a listed scene loads; a scene load drops a running one', () => {
    const r = rig(data({ 'content/cinematic/intro.json': { ...INTRO, scenes: ['main'] } }));
    expect(r.plugin.engine().current).toBe('intro');
    r.step(10);
    r.kernel.requestScene('main');
    r.step();
    // Dropped (ended, skipped) by the reload, then started again by it.
    expect(r.heard.filter((h) => !h.includes('marker')).map((h) => h.replace(/^\d+ /, ''))).toEqual([
      'started ref:intro', 'ended ref:intro skipped', 'started ref:intro',
    ]);
    expect(r.plugin.engine().time).toBeLessThan(0.05);
  });

  it('coded errors: double play, unknown targets, binds, fields, cameras, autoplay conflicts', () => {
    const r = rig(data({
      'content/cinematic/needs_hero.json': { bind: ['star'], tracks: [{ type: 'transform', target: 'star', keys: [{ t: 1, scale: 2 }] }] },
      'content/cinematic/lost.json': { tracks: [{ type: 'visibility', target: 'nobody', keys: [{ t: 1, visible: false }] }] },
      'content/cinematic/bad_field.json': { tracks: [{ type: 'property', target: 'lamp', field: 'light.brightness', keys: [{ t: 1, value: 1 }] }] },
      'content/cinematic/no_light.json': { tracks: [{ type: 'property', target: 'gate', field: 'light.intensity', keys: [{ t: 1, value: 1 }] }] },
    }));
    r.step();
    const engine = r.plugin.engine();
    expect(code(() => engine.play('nope', new Map()))).toBe('PP7211');
    expect(code(() => engine.play('lost', new Map()))).toBe('PP7212');
    expect(code(() => engine.play('needs_hero', new Map()))).toBe('PP7213');
    expect(code(() => engine.play('needs_hero', new Map([['star', r.id('hero')], ['extra', r.id('hero')]])))).toBe('PP7213');
    expect(code(() => engine.play('bad_field', new Map()))).toBe('PP7214');
    expect(code(() => engine.play('no_light', new Map()))).toBe('PP7214');
    engine.play('needs_hero', new Map([['star', r.id('hero')]]));
    expect(code(() => engine.play('intro', new Map()))).toBe('PP7210');

    const noCam = data();
    (noCam['scenes/main/scene.json'] as { entities: Array<{ id: string }> }).entities.splice(0, 1);
    const r2 = rig(noCam);
    expect(code(() => r2.plugin.engine().play('intro', new Map()))).toBe('PP7215');

    expect(code(() => rig(data({
      'content/cinematic/intro.json': { ...INTRO, scenes: ['main'] }, 'content/cinematic/other.json': { scenes: ['main'], tracks: [] },
    })))).toBe('PP7217');
    expect(code(() => rig(data({ 'content/cinematic/broken.json': { tracks: [{ type: 'event', keys: [{ t: -1, name: 'x' }] }] } })))).toBe('PP7202');
  });
});
