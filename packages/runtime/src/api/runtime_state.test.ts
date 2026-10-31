/**
 * Field rules and runtime-level state: `@record` equality, `Ease`, `choices=`, `Handle`
 * fields, `GameRuntime.snapshot()` / `restore()`, and the pointer resolver
 * (`pointer.world` / `pointer.over`).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { initPhysics2d } from '../function/plugins/physics2d/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import {
  activeRandom, Behavior, behavior, component, createRuntime, Ease, Entity, Enum, enum_class, field, Game, kw, record, resetDeclarations,
  PrefabRef, resource, rt, SceneRef, state, Timer, toFieldType, Vec2,
} from './index.js';
import type { Context, GameRuntime } from './index.js';
import { physics2d } from './physics.js';
import { Handle } from './time.js';
import { eq, hash, PyDict } from './pyrt/index.js';
import { schemaOf } from './types.js';
import type { AnyClass } from './types.js';

const STEP = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const CAMERA = { 'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 5 } } } };

function run(data: Record<string, unknown>, plugins: unknown[] = []): GameRuntime {
  const projectFiles = files({ ...CAMERA, ...data });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d', plugins }));
  const runtime = createRuntime(game, project, {
    seed: 3, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
    surface: new RecordingSurface2d({ width: 1000, height: 500 }),
  });
  runtime.start();
  return runtime;
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code; }
  return undefined;
}

beforeAll(async () => { await initPhysics2d(); });
beforeEach(() => resetDeclarations());

describe('@record equality (dataclass eq=True, not frozen)', () => {
  function pair(): new (...a: unknown[]) => Record<string, unknown> {
    class P { static __annotations__ = { col: () => rt.int, row: () => rt.int }; static col = field(0); static row = field(0); }
    return record(P) as unknown as new (...a: unknown[]) => Record<string, unknown>;
  }

  it('compares field by field, only against the same class', () => {
    const P = pair();
    const Q = pair();
    expect(eq(new P(1, 2), new P(1, 2))).toBe(true);
    expect(eq(new P(1, 2), new P(2, 1))).toBe(false);
    expect(eq(new P(1, 2), new Q(1, 2))).toBe(false);
    expect(eq(new P(1, 2), [1, 2])).toBe(false);
  });

  it('is unhashable, as a non-frozen dataclass: not a dict key, hash() raises TypeError', () => {
    const P = pair();
    expect(() => hash(new P(1, 2))).toThrow(/unhashable type/);
    expect(() => PyDict.from([[new P(1, 2), 'x']])).toThrow(/unhashable type/);
  });

  it('keeps an __eq__ or __hash__ the class body defines', () => {
    class K {
      static __annotations__ = { id: () => rt.str };
      static id = field('');
      __eq__(other: unknown): boolean { return (other as { id?: string }).id === (this as unknown as { id: string }).id; }
      __hash__(): number { return 7; }
    }
    const R = record(K) as unknown as new (...a: unknown[]) => object;
    expect(hash(new R('a'))).toBe(7);
    expect(PyDict.from([[new R('a'), 1], [new R('a'), 2]]).__len__()).toBe(1);
  });

  it('applies to the SDK Timer record too', () => {
    expect(eq(Timer.cooldown(2), Timer.cooldown(2))).toBe(true);
    expect(eq(Timer.cooldown(2), Timer.cooldown(3))).toBe(false);
    expect(eq(Timer.cooldown(2), Timer.delay(2))).toBe(false);
    expect(() => hash(Timer.cooldown(2))).toThrow(/unhashable type/);
  });
});

describe('Ease', () => {
  it('is the SDK literal of ease names, usable as a field type', () => {
    expect(toFieldType(Ease)).toEqual({
      kind: 'enum',
      values: ['linear', 'in_quad', 'out_quad', 'in_out_quad', 'in_cubic', 'out_cubic', 'in_out_cubic', 'in_back', 'out_back', 'in_out_back',
        'in_elastic', 'out_elastic', 'in_out_elastic', 'out_bounce'],
    });
  });
});

describe('choices=', () => {
  class Mode extends Enum { static SCATTER = 'scatter'; static CHASE = 'chase'; static FRIGHT = 'fright'; }
  enum_class(Mode);
  const M = Mode as unknown as typeof Mode & Record<string, Enum>;

  it('narrows str, Literal and str-valued Enum fields; numbers keep their type', () => {
    class Hunt {
      static __annotations__ = { phase: () => Mode, look: () => rt.str, lane: () => rt.int, speed: () => rt.float };
      static phase = field(M['SCATTER'], kw({ choices: [M['SCATTER'], M['CHASE']] }));
      static look = field('a', kw({ choices: ['a', 'b'] }));
      static lane = field(1, kw({ choices: [1, 2, 3] }));
      static speed = field(1.5, kw({ choices: [1.5, 3] }));
    }
    const info = schemaOf(Hunt as unknown as AnyClass, 'resource Hunt');
    expect(info.schema['phase']!.type).toEqual({ kind: 'enum', values: ['scatter', 'chase'] });
    expect(info.schema['look']!.type).toEqual({ kind: 'enum', values: ['a', 'b'] });
    expect(info.schema['lane']!.type).toEqual({ kind: 'int' });
    expect(info.schema['speed']!.type).toEqual({ kind: 'number' });
  });

  it('rejects choices that are not values of the field type', () => {
    class A { static __annotations__ = { phase: () => Mode }; static phase = field(M['SCATTER'], kw({ choices: ['scatter'] })); }
    class B { static __annotations__ = { lane: () => rt.int }; static lane = field(1, kw({ choices: [1, 'two'] })); }
    class C { static __annotations__ = { at: () => Vec2 }; static at = field(null, kw({ choices: [Vec2.ZERO] })); }
    expect(code(() => schemaOf(A as unknown as AnyClass, 'A'))).toBe('PP4110');
    expect(code(() => schemaOf(B as unknown as AnyClass, 'B'))).toBe('PP4110');
    expect(code(() => schemaOf(C as unknown as AnyClass, 'C'))).toBe('PP4110');
  });
});

describe('Handle fields (resources and state() only, never saved)', () => {
  it('a resource holds a running handle; snapshots skip it, and after a restore it is inactive', () => {
    class Siege {
      static __annotations__ = { march: () => rt.optional(Handle), wave: () => rt.int };
      static march = field(null);
      static wave = field(0);
    }
    const SiegeR = resource('siege')(Siege);
    const r = run({ 'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] } });
    const siege = r.ctx.get(SiegeR) as unknown as { march: Handle | null; wave: number };
    expect(siege.march).toBeNull();
    siege.march = r.ctx.time.after(5, () => undefined) as Handle;
    const snap = r.snapshot();
    expect(JSON.stringify(snap.resources['siege'])).not.toContain('march');
    r.restore(snap);
    expect(siege.march).not.toBeNull();
    expect(siege.march!.active).toBe(false);
    expect(code(() => { siege.march = 3 as never; r.ctx.get(SiegeR); })).toBe('PP3007');
  });

  it('holds a ui.label() handle like any other (coop_cooking)', () => {
    class Tags {
      static __annotations__ = { tag: () => rt.optional(Handle) };
      static tag = field(null);
    }
    const TagsR = resource('tags')(Tags);
    const r = run({ 'scenes/main/scene.json': { entities: [{ prefab: 'camera', id: 'cam' }] } });
    const tags = r.ctx.get(TagsR) as unknown as { tag: Handle | null };
    const cam = r.ctx.world.spawn(new PrefabRef('camera'));
    tags.tag = (r.ctx as unknown as { ui: { label(e: unknown, t: string): Handle } }).ui.label(cam, 'Chef');
    expect(r.ctx.get(TagsR)).toBe(tags);
    expect(tags.tag).toBeInstanceOf(Handle);
    expect(tags.tag!.active).toBe(true);
    tags.tag!.cancel();
    expect(tags.tag!.active).toBe(false);
  });

  it('a behavior holds one in state(None)', () => {
    class Fuse extends Behavior {
      static __annotations__ = { timer: () => rt.optional(Handle) };
      static timer = state(null);
      start(ctx: Context) { (this as unknown as { timer: unknown }).timer = ctx.time.after(1, () => undefined); }
    }
    behavior('fuse')(Fuse);
    const r = run({
      'prefabs/bomb.prefab.json': { behaviors: { fuse: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'bomb' }] },
    });
    r.step(STEP);
    expect(() => r.snapshot()).not.toThrow();
  });

  it('is rejected elsewhere, and needs None as its default', () => {
    class Fuse { static __annotations__ = { h: () => rt.optional(Handle) }; static h = field(null); }
    component('fuse')(Fuse);
    expect(code(() => run({ 'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] } }))).toBe('PP4109');
    class Step { static __annotations__ = { h: () => rt.optional(Handle) }; static h = field(null); }
    expect(code(() => toFieldType(record(Step)))).toBe('PP4109');
    class Started { static __annotations__ = { h: () => rt.optional(Handle) }; static h = field(1); }
    expect(code(() => schemaOf(Started as unknown as AnyClass, 'Started'))).toBe('PP4109');
    class Many { static __annotations__ = { hs: () => rt.list(Handle) }; static hs = field([]); }
    expect(code(() => schemaOf(Many as unknown as AnyClass, 'Many'))).toBe('PP4109');
  });
});

describe('GameRuntime.snapshot()', () => {
  it('restores the random stream and ctx.seed with the world', () => {
    const r = run({ 'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] } });
    r.step(STEP);
    const snap = r.snapshot();
    const seedAt = r.seed;
    expect((snap.plugins['runtime'] as { seed: number }).seed).toBe(seedAt);
    const first = [activeRandom().next(), activeRandom().next()];
    r.ctx.scenes.load(new SceneRef('main'), kw({ seed: 99 }));
    r.step(STEP);
    expect(r.seed).toBe(99);
    r.restore(snap);
    expect(r.seed).toBe(seedAt);
    expect([activeRandom().next(), activeRandom().next()]).toEqual(first);
    expect(code(() => r.restore({ ...snap, format: 0 }))).toBe('PP9002');
  });
});

describe('pointer', () => {
  const SCENE = {
    'prefabs/disc.prefab.json': { components: { collider: { shape: 'circle', radius: 1, trigger: true } } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'camera' },
        { id: 'low', prefab: 'disc', at: [2, 1, 0] },
        { id: 'high', prefab: 'disc', at: [2.5, 1, 1] },
      ],
    },
  };

  it('world maps the pointer through the active camera; over is the topmost collider under it', () => {
    const devices = new HeadlessInput();
    const projectFiles = files({ ...CAMERA, ...SCENE });
    const project = loadProject(projectFiles);
    const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d', plugins: [physics2d()] }));
    const r = createRuntime(game, project, {
      seed: 1, devices, audio: new HeadlessAudio(), assets: null, files: projectFiles, surface: new RecordingSurface2d({ width: 1000, height: 500 }),
    });
    r.start();
    r.step(STEP);
    const pointer = (r.ctx as unknown as { input: { pointer: { world: { x: number; y: number }; over: Entity | null } } }).input.pointer;
    // 1000×500 px, half-height 5 m: 50 px per meter, (500, 250) is the origin.
    devices.pointerMove(500 + 2.2 * 50, 250 - 1 * 50);
    r.step(STEP);
    expect(pointer.world.x).toBeCloseTo(2.2);
    expect(pointer.world.y).toBeCloseTo(1);
    expect(pointer.over?.name).toBe('high');
    devices.pointerMove(500 + 1.2 * 50, 250 - 1 * 50);
    r.step(STEP);
    expect(pointer.over?.name).toBe('low');
    devices.pointerMove(500 - 4 * 50, 250);
    r.step(STEP);
    expect(pointer.over).toBeNull();
  });

  it('over without a physics plugin is PP3405', () => {
    const r = run({ 'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] } });
    r.step(STEP);
    const pointer = (r.ctx as unknown as { input: { pointer: { over: unknown; world: { x: number } } } }).input.pointer;
    expect(pointer.world.x).toBeCloseTo(-10); // the pointer starts at the top-left pixel
    expect(code(() => pointer.over)).toBe('PP3405');
  });
});
