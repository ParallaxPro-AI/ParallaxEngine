/**
 * The cinematic tracks beyond camera/transform/visibility/property/event, one by one, on a
 * bare kernel with stand-ins: `camera` (with a recording `shake`), `animator` and `sprite`
 * (recording `play`), `depth_of_field`, and recording audio, environment (grade) and
 * actions services and a recording vfx host. Then the dialogue hold, skip's end state and
 * snapshot/restore mid-hold.
 */

import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import type { JsonObject } from '../../../resource/index.js';
import { loadProject } from '../../../resource/index.js';
import { componentEntity, Kernel, t } from '../../kernel/index.js';
import type { Fields, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { ACTIONS_SERVICE, AUDIO_SERVICE, ENVIRONMENT_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { PluginSound, TerrainField, TerrainService } from '../../services/index.js';
import { CAMERA_GROUND_CLEARANCE, CINEMATIC_EVENTS, cinematics, dialogueAt, parseCinematic, subtitleAt } from './index.js';
import type { CinematicsPlugin, Presentation } from './index.js';

const DT = 1 / 60;
const SKIP = { action: 'skip' };
const ADVANCE = { action: 'advance' };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

interface Log {
  readonly calls: string[];
  readonly sounds: PluginSound[];
  readonly music: Array<[string | null, number]>;
  readonly grades: Array<[JsonObject | null, number]>;
  readonly vfx: Array<[string, Vec3, number]>;
}

interface Rig {
  readonly kernel: Kernel;
  readonly plugin: CinematicsPlugin;
  readonly log: Log;
  readonly keys: { skip: boolean; advance: boolean };
  step(frames?: number): void;
  id(placed: string): EntityId;
  play(id: string): void;
  view(): Presentation | null;
}

function rig(cinematic: Record<string, unknown>, extra: { prefabs?: Record<string, unknown>; vfx?: boolean; ground?: (x: number, z: number) => number; hole?: (x: number, z: number) => boolean } = {}): Rig {
  const keys = { skip: false, advance: false };
  const log: Log = { calls: [], sounds: [], music: [], grades: [], vfx: [] };
  let kernel: Kernel | undefined;
  const name = (fields: Fields): string => kernel!.world.get(componentEntity(fields))?.placedId ?? String(componentEntity(fields));
  const stand: KernelPlugin = {
    id: 'stand_in',
    components: [
      {
        id: 'camera',
        schema: { rig: t.enum(['fixed', 'follow', 'orbit', 'first_person'], { default: 'fixed' }), fov: t.number({ default: 60 }) },
        methods: { shake(this: Fields, intensity: number, seconds: number) { log.calls.push(`${kernel!.time.frame} shake ${name(this)} ${intensity} ${seconds}`); } },
      },
      {
        id: 'animator', schema: {},
        methods: {
          play(this: Fields, clip: string, o: Record<string, unknown>) { log.calls.push(`${kernel!.time.frame} play ${name(this)} ${clip} ${JSON.stringify(o)}`); },
          play_once(this: Fields, clip: string, o: Record<string, unknown>) { log.calls.push(`${kernel!.time.frame} play_once ${name(this)} ${clip} ${JSON.stringify(o)}`); },
        },
      },
      {
        id: 'sprite', schema: {},
        methods: { play(this: Fields, clip: string) { log.calls.push(`${kernel!.time.frame} sprite ${name(this)} ${clip}`); } },
      },
      {
        id: 'depth_of_field',
        schema: { focus_distance: t.number({ default: 10 }), focus_range: t.number({ default: 4 }), max_blur: t.number({ default: 6 }) },
      },
    ],
    install(k) {
      k.provide(ACTIONS_SERVICE, {
        pressed: (a) => (a === SKIP && keys.skip) || (a === ADVANCE && keys.advance), held: () => false, live: () => true,
        device: () => 'keyboard', find: () => undefined, names: () => [], glyphs: () => [],
      });
      k.provide(AUDIO_SERVICE, {
        play: (s) => { log.sounds.push(s); log.calls.push(`${k.time.frame} sound ${s.sound}`); },
        loop: () => {}, stop: () => {},
        music: (track, fade) => { log.music.push([track, fade]); log.calls.push(`${k.time.frame} music ${track}`); },
      });
      if (extra.ground !== undefined) {
        const ground = extra.ground;
        const field = { contains: (x: number, z: number) => Math.abs(x) <= 100 && Math.abs(z) <= 100, heightAt: ground, holeAt: extra.hole ?? (() => false) } as unknown as TerrainField;
        k.provide(TERRAIN_SERVICE, { current: () => field } as unknown as TerrainService);
      }
      k.provide(ENVIRONMENT_SERVICE, {
        resolve: () => { throw new Error('not drawn here'); }, persist: () => ({}), load: () => {},
        grade: (look, weight) => { log.grades.push([look, weight]); },
      });
    },
  };
  const listener: SystemDef = {
    id: 'listener', scenes: [],
    handlers: [{ event: CINEMATIC_EVENTS.marker, method: 'marker' }, { event: CINEMATIC_EVENTS.ended, method: 'ended' }],
    create: () => ({
      marker: (_c: unknown, e: Fields) => log.calls.push(`${kernel!.time.frame} marker ${String(e['name'])}${e['skipped'] === true ? ' skipped' : ''}`),
      ended: (_c: unknown, e: Fields) => log.calls.push(`${kernel!.time.frame} ended${e['skipped'] === true ? ' skipped' : ''}`),
    }),
  };
  const plugin = cinematics({
    skip: SKIP, advance: ADVANCE,
    host: {
      ref: (_k, id) => id,
      ...(extra.vfx !== false && { vfx: (_k: Kernel, effect: string, at: Vec3, o: { scale: number }) => { log.vfx.push([effect, at, o.scale]); } }),
    },
  });
  const project = loadProject(files({
    'prefabs/cam.prefab.json': { components: { camera: { rig: 'follow', fov: 60 } } },
    'prefabs/actor.prefab.json': { components: { animator: {} } },
    'prefabs/flat.prefab.json': { components: { sprite: {} } },
    'prefabs/thing.prefab.json': { components: {} },
    'prefabs/gull.prefab.json': { components: {} },
    ...(extra.prefabs ?? {}),
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'cam', id: 'cam', at: [0, 10, -20] },
        { prefab: 'actor', id: 'hero', at: [1, 0, 0] },
        { prefab: 'flat', id: 'sign', at: [0, 0, 0] },
        { prefab: 'thing', id: 'gate', at: [0, 2, 5] },
      ],
    },
    'content/cinematic/c.json': cinematic,
  }));
  expect(project.diagnostics).toEqual([]);
  kernel = new Kernel({ project, game: { components: [], events: [], behaviors: [], systems: [listener], resources: [] }, plugins: [stand, plugin] });
  kernel.start('main');
  const k = kernel;
  return {
    kernel: k, plugin, log, keys,
    step(frames = 1) { for (let i = 0; i < frames; i++) k.step(DT); },
    id(placed) {
      for (const record of k.world.live()) if (record.placedId === placed) return record.id;
      throw new Error(`no ${placed}`);
    },
    play(id) { plugin.engine().play(id, new Map()); },
    view() { return plugin.engine().presentation(); },
  };
}

/** The calls the log heard, without frame numbers. */
const heard = (r: Rig): string[] => r.log.calls.map((c) => c.replace(/^\d+ /, ''));

describe('parsing the new tracks', () => {
  it('reads every track type in the documented form', () => {
    const { cinematic, diagnostics } = parseCinematic('all', {
      tracks: [
        { type: 'animation', target: 'hero', keys: [{ t: 0, clip: 'wave', loop: false, fade: 0.1 }] },
        { type: 'audio', keys: [{ t: 0, music: 'assets/music/boss.ogg' }, { t: 0, sound: 'assets/sfx/a.ogg', at: 'gate' }, { t: 1, music: null }] },
        { type: 'letterbox', keys: [{ t: 0, amount: 0 }, { t: 0.5, amount: 1 }] },
        { type: 'grade', post: { preset: 'noir', vignette: 0.5 }, keys: [{ t: 1, weight: 1 }] },
        { type: 'time_scale', keys: [{ t: 1, value: 0.2 }] },
        { type: 'shake', keys: [{ t: 1 }, { t: 1, intensity: 1, seconds: 0.2 }] },
        { type: 'focus', keys: [{ t: 0, distance: 3, range: 2, blur: 8 }, { t: 1, distance: 9 }] },
        { type: 'subtitle', keys: [{ t: 0, text: 'Dawn.' }, { t: 2, text: 'Later.', seconds: 4 }] },
        { type: 'spawn', keys: [{ t: 0, prefab: 'gull', name: 'g', position: [0, 1, 0], keep: true }, { t: 1, despawn: 'g' }] },
        { type: 'vfx', keys: [{ t: 1, effect: 'assets/vfx/dust.vfx.json', at: [0, 0, 0], color: '#ff8800', scale: 2 }] },
        { type: 'dialogue', keys: [{ t: 0, speaker: 'Hero', text: 'Hi.' }, { t: 1, text: 'Bye.', wait: false, seconds: 1 }] },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(cinematic!.tracks.map((tr) => tr.type)).toEqual([
      'animation', 'audio', 'letterbox', 'grade', 'time_scale', 'shake', 'focus', 'subtitle', 'spawn', 'vfx', 'dialogue',
    ]);
    // The duration covers the last subtitle's seconds (2 + 4), not just its key.
    expect(cinematic!.duration).toBe(6);
    const shake = cinematic!.tracks[5]!;
    expect(shake.type === 'shake' && shake.keys.map((k) => [k.intensity, k.seconds])).toEqual([[0.3, 0.4], [1, 0.2]]);
    const vfx = cinematic!.tracks[9]!;
    expect(vfx.type === 'vfx' && vfx.keys[0]!.color).toEqual(Color.hex('#ff8800'));
  });

  it('reports the new tracks\' mistakes with pointers', () => {
    const { cinematic, diagnostics } = parseCinematic('bad', {
      tracks: [
        { type: 'letterbox', keys: [{ t: 0, amount: 2 }] },
        { type: 'letterbox', keys: [{ t: 0, amount: 1 }] },
        { type: 'audio', keys: [{ t: 0, sound: 'a', music: 'b' }, { t: 1 }] },
        { type: 'grade', post: { preset: 'sepia' }, keys: [{ t: 0, weight: 1 }] },
        { type: 'dialogue', keys: [{ t: 0, text: 'x', seconds: 2 }] },
        { type: 'spawn', keys: [{ t: 0, name: 'x' }, { t: 1, despawn: 'x', prefab: 'y' }] },
        { type: 'animation', keys: [{ t: 0 }] },
        { type: 'subtitle', keys: [{ t: 1, text: 'a' }, { t: 1, text: 'b' }] },
      ],
    });
    expect(cinematic).toBeUndefined();
    expect(diagnostics.map((d) => `${d.code} ${d.pointer}`)).toEqual([
      'PP7204 /tracks/0/keys/0/amount',
      'PP7204 /tracks/2/keys/0',
      'PP7204 /tracks/2/keys/1',
      'PP7201 /tracks/3/post/preset',
      'PP7204 /tracks/4/keys/0/seconds',
      'PP7204 /tracks/5/keys/0',
      'PP7204 /tracks/5/keys/1/prefab',
      'PP7204 /tracks/6/keys/0/clip',
      'PP7201 /tracks/6/target',
      'PP7202 /tracks/7/keys/1/t',
      'PP7201 /tracks',
    ]);
  });

  it('subtitles show for their seconds, else until the next key (at most 3 s); auto lines clear', () => {
    const subs = [{ t: 0, text: 'a', seconds: null }, { t: 1, text: 'b', seconds: 0.5 }, { t: 5, text: 'c', seconds: null }];
    expect([0, 0.99, 1, 1.49, 1.5, 4.9, 5, 7.9, 8].map((s) => subtitleAt(subs, s))).toEqual(['a', 'a', 'b', 'b', null, null, 'c', 'c', null]);
    const lines = [
      { t: 0, text: 'held', speaker: null, portrait: null, wait: true, seconds: null },
      { t: 2, text: 'auto', speaker: null, portrait: null, wait: false, seconds: 1 },
    ];
    expect([0, 1.9, 2, 2.9, 3].map((s) => dialogueAt(lines, s)?.text ?? null)).toEqual(['held', 'held', 'auto', 'auto', null]);
  });
});

describe('trigger tracks', () => {
  it('animation: each clip once at its time — looping through play, one-shots through play_once, sprites by name', () => {
    const r = rig({
      duration: 1,
      tracks: [
        { type: 'animation', target: 'hero', keys: [{ t: 0, clip: 'idle' }, { t: 0.5, clip: 'wave', loop: false, fade: 0.1, speed: 2 }] },
        { type: 'animation', target: 'sign', keys: [{ t: 0.5, clip: 'flash' }] },
      ],
    });
    r.play('c');
    r.step(40);
    expect(r.log.calls.filter((c) => !c.includes('ended'))).toEqual([
      '0 play hero idle {"speed":1,"loop":true}',
      '30 play_once hero wave {"speed":2,"fade":0.1}',
      '30 sprite sign flash',
    ]);
  });

  it('animation: a target without an Animator or Sprite is PP7218', () => {
    const r = rig({ tracks: [{ type: 'animation', target: 'gate', keys: [{ t: 0, clip: 'open' }] }] });
    expect(code(() => r.play('c'))).toBe('PP7218');
  });

  it('audio: one-shots at a point or a target, and the music override', () => {
    const r = rig({
      duration: 1,
      tracks: [{ type: 'audio', keys: [
        { t: 0, music: 'assets/music/boss.ogg', fade: 2 },
        { t: 0.5, sound: 'assets/sfx/clang.ogg', at: 'gate', volume: 0.5, duck: true },
        { t: 0.5, sound: 'assets/sfx/wind.ogg' },
      ] }],
    });
    r.play('c');
    r.step(40);
    expect(r.log.music).toEqual([['assets/music/boss.ogg', 2]]);
    expect(r.log.sounds.map((s) => [s.sound, s.at?.toString() ?? null, s.volume, s.duck])).toEqual([
      ['assets/sfx/clang.ogg', new Vec3(0, 2, 5).toString(), 0.5, true],
      ['assets/sfx/wind.ogg', null, 1, false],
    ]);
  });

  it('shake: the directed camera shakes at each key', () => {
    const r = rig({ duration: 1, tracks: [{ type: 'shake', keys: [{ t: 0.25, intensity: 0.8, seconds: 0.3 }, { t: 0.5 }] }] });
    r.play('c');
    r.step(40);
    expect(r.log.calls.filter((c) => c.includes('shake'))).toEqual(['15 shake cam 0.8 0.3', '30 shake cam 0.3 0.4']);
  });

  it('vfx: an effect at a point or at a target where it is now', () => {
    const r = rig({ duration: 1, tracks: [{ type: 'vfx', keys: [{ t: 0, effect: 'assets/vfx/a.vfx.json', at: [1, 2, 3] }, { t: 0.5, effect: 'assets/vfx/b.vfx.json', at: 'gate', scale: 3 }] }] });
    r.play('c');
    r.kernel.world.get(r.id('gate'))!.transform.position = new Vec3(9, 9, 9);
    r.step(40);
    expect(r.log.vfx).toEqual([['assets/vfx/a.vfx.json', new Vec3(1, 2, 3), 1], ['assets/vfx/b.vfx.json', new Vec3(9, 9, 9), 3]]);
    // A game without effects can't play a vfx track.
    const bare = rig({ tracks: [{ type: 'vfx', keys: [{ t: 0, effect: 'x', at: [0, 0, 0] }] }] }, { vfx: false });
    expect(code(() => bare.play('c'))).toBe('PP7220');
  });

  it('spawn: prefabs appear at their keys, despawn by name, and leave at the end unless kept', () => {
    const r = rig({
      duration: 1,
      tracks: [{ type: 'spawn', keys: [
        { t: 0.2, prefab: 'gull', name: 'g1', position: [0, 5, 0], rotation: [0, 90, 0] },
        { t: 0.2, prefab: 'gull', name: 'g2', keep: true },
        { t: 0.5, despawn: 'g1' },
        { t: 0.6, despawn: 'gate' },
      ] }],
    });
    const count = (): number => [...r.kernel.world.live()].filter((e) => e.prefab === 'gull').length;
    r.play('c');
    r.step(13);
    expect(count()).toBe(2);
    const g1 = [...r.kernel.world.live()].find((e) => e.name === 'g1')!;
    expect(g1.transform.position.is_close(new Vec3(0, 5, 0))).toBe(true);
    r.step(18);
    expect(count()).toBe(1);
    r.step(10);
    expect([...r.kernel.world.live()].some((e) => e.placedId === 'gate')).toBe(false);
    r.step(30);
    expect(r.plugin.engine().playing).toBe(false);
    // The kept gull stays; the placed gate stays despawned (an ordinary end state).
    expect([...r.kernel.world.live()].map((e) => e.name).filter((n) => n === 'g2')).toEqual(['g2']);
    // An unknown prefab is caught before anything starts.
    const bad = rig({ tracks: [{ type: 'spawn', keys: [{ t: 0, prefab: 'gul' }] }] });
    expect(code(() => bad.play('c'))).toBe('PP7219');
  });
});

describe('presentation tracks', () => {
  it('letterbox ramps from 0 and is gone when the cinematic ends', () => {
    const r = rig({ duration: 1, tracks: [{ type: 'letterbox', keys: [{ t: 0.5, amount: 1, ease: 'linear' }] }] });
    r.play('c');
    expect(r.view()!.letterbox).toBe(0);
    r.step(15);
    expect(r.view()!.letterbox).toBeCloseTo(0.5, 6);
    r.step(15);
    expect(r.view()!.letterbox).toBeCloseTo(1, 6);
    r.step(31);
    expect(r.view()).toBeNull();
  });

  it('grade: the environment gets the post block at the sampled weight, then none', () => {
    const post = { preset: 'noir', vignette: 0.6 };
    const r = rig({ duration: 1, tracks: [{ type: 'grade', post, keys: [{ t: 1, weight: 1, ease: 'linear' }] }] });
    r.play('c');
    r.step(30);
    const [look, weight] = r.log.grades[r.log.grades.length - 1]!;
    expect(look).toEqual(post);
    expect(weight).toBeCloseTo(0.5, 6);
    r.step(31);
    expect(r.log.grades[r.log.grades.length - 1]).toEqual([null, 0]);
  });

  it('time_scale: sets the game\'s scale while the cinematic itself runs on real time, then puts it back', () => {
    const r = rig({ duration: 1, tracks: [{ type: 'time_scale', keys: [{ t: 0, value: 0.25 }, { t: 0.5, value: 0, cut: true }] }] });
    r.kernel.time.scale = 0.9;
    r.play('c');
    expect(r.kernel.time.scale).toBe(0.25);
    r.step(15);
    // 15 real frames: a quarter second of the cinematic, though the game moved a quarter as far.
    expect(r.plugin.engine().time).toBeCloseTo(0.25, 6);
    r.step(15);
    expect(r.kernel.time.scale).toBe(0);
    r.step(10);
    // A freeze frame: the game stops, the shot goes on.
    expect(r.plugin.engine().time).toBeGreaterThan(0.6);
    r.step(30);
    expect(r.plugin.engine().playing).toBe(false);
    expect(r.kernel.time.scale).toBe(0.9);
  });

  it('focus: adds the camera\'s DepthOfField (range 4, blur 6), pulls it, and removes it after', () => {
    const r = rig({ duration: 1, tracks: [{ type: 'focus', keys: [{ t: 0, distance: 2 }, { t: 1, distance: 12, blur: 10, ease: 'linear' }] }] });
    const dof = (): Fields | undefined => r.kernel.world.get(r.id('cam'))!.components.get('depth_of_field');
    r.play('c');
    expect(dof()).toMatchObject({ focus_distance: 2, focus_range: 4, max_blur: 6 });
    r.step(30);
    expect(dof()!['focus_distance']).toBeCloseTo(7, 6);
    expect(dof()!['max_blur']).toBeCloseTo(8, 6);
    r.step(31);
    expect(dof()).toBeUndefined();
  });

  it('focus: a camera with its own DepthOfField gets its values back', () => {
    const r = rig({ duration: 0.5, tracks: [{ type: 'focus', keys: [{ t: 0.5, distance: 1, range: 0.5 }] }] }, {
      prefabs: { 'prefabs/cam.prefab.json': { components: { camera: {}, depth_of_field: { focus_distance: 30, focus_range: 9, max_blur: 3 } } } },
    });
    r.play('c');
    r.step(15);
    const dof = r.kernel.world.get(r.id('cam'))!.components.get('depth_of_field')!;
    expect(dof['focus_distance'] as number).toBeLessThan(30);
    r.step(20);
    expect(dof).toMatchObject({ focus_distance: 30, focus_range: 9, max_blur: 3 });
  });

  it('subtitle: the caption showing now', () => {
    const r = rig({ duration: 2, tracks: [{ type: 'subtitle', keys: [{ t: 0, text: 'Dawn.' }, { t: 0.5, text: 'The gate.', seconds: 0.25 }] }] });
    r.play('c');
    expect(r.view()!.subtitle).toBe('Dawn.');
    r.step(31);
    expect(r.view()!.subtitle).toBe('The gate.');
    r.step(16);
    expect(r.view()!.subtitle).toBeNull();
  });
});

describe('dialogue', () => {
  const SCRIPT = {
    tracks: [
      { type: 'dialogue', keys: [
        { t: 0.5, speaker: 'Hero', portrait: 'assets/images/hero.png', text: 'Open it.' },
        { t: 1, text: 'Thanks!', wait: false, seconds: 0.5 },
      ] },
      { type: 'event', keys: [{ t: 0.75, name: 'gate' }] },
    ],
  };

  it('a waiting line holds playback until the player advances; an auto line clears by itself', () => {
    const r = rig(SCRIPT);
    r.play('c');
    expect(r.view()!.dialogue).toBeNull();
    r.step(60);
    // Held at the line's time, however long the player reads.
    expect(r.plugin.engine().time).toBeCloseTo(0.5, 9);
    expect(r.view()!.dialogue).toEqual({ text: 'Open it.', speaker: 'Hero', portrait: 'assets/images/hero.png', awaiting: true });
    expect(heard(r)).toEqual([]);
    r.keys.advance = true;
    r.step();
    r.keys.advance = false;
    expect(r.plugin.engine().awaiting).toBe(false);
    r.step(30);
    expect(heard(r)).toEqual(['marker gate']);
    expect(r.view()!.dialogue).toMatchObject({ text: 'Thanks!', awaiting: false });
    r.step(31);
    expect(heard(r)).toEqual(['marker gate', 'ended']);
  });

  it('advance() from code; false when nothing waits', () => {
    const r = rig(SCRIPT);
    r.play('c');
    expect(r.plugin.engine().advance()).toBe(false);
    r.step(31);
    expect(r.plugin.engine().advance()).toBe(true);
    r.step(70);
    expect(r.plugin.engine().playing).toBe(false);
  });

  it('skip passes every hold, fires the markers, and lands on the end state', () => {
    const r = rig({
      tracks: [
        ...SCRIPT.tracks,
        { type: 'animation', target: 'hero', keys: [{ t: 0.2, clip: 'walk' }, { t: 0.9, clip: 'idle' }] },
        { type: 'audio', keys: [{ t: 0.8, sound: 'assets/sfx/x.ogg' }, { t: 0.9, music: 'assets/music/calm.ogg' }] },
        { type: 'spawn', keys: [{ t: 0.8, prefab: 'gull', name: 'temp' }, { t: 0.8, prefab: 'gull', name: 'kept', keep: true }] },
        { type: 'shake', keys: [{ t: 0.8 }] },
      ],
    });
    r.play('c');
    r.step(31);
    r.keys.skip = true;
    r.step();
    // (Markers are events: delivered after the skip's direct calls.)
    expect(heard(r)).toEqual(['play hero walk {"speed":1,"loop":true}', 'play hero idle {"speed":1,"loop":true}', 'music assets/music/calm.ogg', 'marker gate skipped', 'ended skipped']);
    expect([...r.kernel.world.live()].map((e) => e.name).filter((n) => n === 'kept' || n === 'temp')).toEqual(['kept']);
  });

  it('a snapshot taken while held resumes held, with what it spawned', () => {
    const script = { tracks: [...SCRIPT.tracks, { type: 'spawn', keys: [{ t: 0.25, prefab: 'gull', name: 'g' }] }] };
    const a = rig(script);
    a.play('c');
    a.step(40);
    const saved = a.kernel.snapshot();
    const b = rig(script);
    b.kernel.restore(saved);
    expect(b.plugin.engine().awaiting).toBe(true);
    expect(b.view()!.dialogue!.text).toBe('Open it.');
    b.plugin.engine().advance();
    b.step(90);
    expect(b.plugin.engine().playing).toBe(false);
    // The spawned gull was the cinematic's: removed at its end on the restored copy too.
    expect([...b.kernel.world.live()].some((e) => e.prefab === 'gull')).toBe(false);
  });
});

describe('camera tracks over terrain', () => {
  // The ground is a 40 m plateau over x < 50, sea level beyond; a hole at (0, 30).
  const ground = (x: number): number => (x < 50 ? 40 : 0);
  const hole = (x: number, z: number): boolean => Math.hypot(x, z - 30) < 3;
  const cut = (position: [number, number, number]) => ({
    duration: 1, tracks: [{ type: 'camera', keys: [{ t: 0, cut: true, position, look_at: [0, 0, 0] }, { t: 1, position, look_at: [0, 0, 0] }] }],
  });
  const shot = (position: [number, number, number]): Vec3 => {
    const r = rig(cut(position), { ground, hole });
    r.play('c');
    r.step(2);
    return r.kernel.world.get(r.id('cam'))!.transform.position;
  };

  it('never cuts the camera under the ground: a key below it is held just above it', () => {
    expect(shot([0, 10, -20]).is_close(new Vec3(0, 40 + CAMERA_GROUND_CLEARANCE, -20))).toBe(true);
    // Above the ground, off the field and down a hole: where it was put.
    expect(shot([0, 60, -20]).is_close(new Vec3(0, 60, -20))).toBe(true);
    expect(shot([60, 10, -20]).is_close(new Vec3(60, 10, -20))).toBe(true);
    expect(shot([0, 10, 30]).is_close(new Vec3(0, 10, 30))).toBe(true);
    expect(shot([0, -5, 500]).is_close(new Vec3(0, -5, 500))).toBe(true);
  });
});
