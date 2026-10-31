import { beforeEach, describe, expect, it } from 'vitest';
import { Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { Behavior, behavior, Game, kw, resetDeclarations, rt, state } from '../api/index.js';
import { physics2d } from '../api/physics.js';
import { sceneRef } from '../api/project.js';
import { EffectRef } from '../api/types.js';
import { MemoryStore } from '../platform/index.js';
import { JOBS_SERVICE } from '../function/services/index.js';
import { HeadlessAudio, ManualClock, ManualDisplay, MemoryBinaryFiles, RecordingSurface2d, RecordingSurface3d } from '../platform/index.js';
import { bootHeadless } from './headless.js';
import { GameLoop } from './loop.js';
import { BootFailure, diagnosticsOf, startGame } from './start.js';
import { ENGINE_MODULES, gameModules, migrationModules, missingEngineModule } from './modules.js';
import type { BuildManifest } from './modules.js';
import { HeadlessInput } from '../function/plugins/input/index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const DROP_FILES = {
  'prefabs/ball.prefab.json': {
    components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.5 } },
    behaviors: { counter: {} },
  },
  'prefabs/floor.prefab.json': { components: { collider: { shape: 'box', size: [20, 1] } } },
  'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 6 } } },
  'scenes/main/scene.json': {
    entities: [
      { prefab: 'ball', id: 'ball', at: [0, 5] }, { prefab: 'floor', id: 'floor', at: [0, 0] },
      { prefab: 'camera', id: 'camera', at: [0, 3] },
    ],
  },
};

/** game/main.py and game/behaviors.py of a tiny 2D game, as the transpiler emits them. */
function dropGame(): Record<string, unknown> {
  class Counter extends Behavior {
    static __annotations__ = { ticks: () => rt.int };
    static ticks = state(0);
    declare ticks: number;
    update(): void { this.ticks += 1; }
  }
  behavior('counter')(Counter);
  const game = new Game(kw({
    id: 'drop', title: 'Drop', sdk: '1.0', mode: '2d', plugins: [physics2d(kw({ gravity: -10 }))], start_scene: sceneRef('main'),
  }));
  return { game, Counter };
}

beforeEach(() => resetDeclarations());

describe('bootHeadless', () => {
  it('starts a game and runs it frame by frame through the loop, with physics', async () => {
    const h = await bootHeadless({ entry: dropGame(), files: files(DROP_FILES) });
    const ball = () => [...h.runtime.kernel.world.live()].find((r) => r.placedId === 'ball')!;
    expect(ball().transform.position.y).toBe(5);
    h.frames(30);
    const midAir = ball().transform.position.y;
    expect(midAir).toBeLessThan(5);
    h.frames(150);
    // Resting on the floor (top at 0.5) with its 0.5 radius.
    expect(ball().transform.position.y).toBeCloseTo(1, 1);
    expect(h.runtime.kernel.time.frame).toBe(180);
    const counter = h.runtime.kernel.world.require(ball().id).behaviors[0]!.instance as unknown as { ticks: number };
    expect(counter.ticks).toBe(180);
  });

  it('pauses while the display is hidden and does not count the hidden time', async () => {
    const h = await bootHeadless({ entry: dropGame(), files: files(DROP_FILES) });
    h.frames(10);
    h.display.setVisible(false);
    h.frames(100);
    expect(h.runtime.kernel.time.frame).toBe(10);
    h.display.setVisible(true);
    h.frame();
    expect(h.runtime.kernel.time.frame).toBe(11);
    expect(h.runtime.kernel.time.now).toBeCloseTo(11 / 60, 6);
  });

  it('rethrows what the game threw and refuses frames after stop()', async () => {
    const h = await bootHeadless({ entry: dropGame(), files: files(DROP_FILES) });
    h.stop();
    expect(() => h.frame()).toThrow(/PP9506/);
  });

  it('is reproducible: the same seed gives the same run', async () => {
    const run = async (): Promise<number> => {
      resetDeclarations();
      const h = await bootHeadless({ entry: dropGame(), files: files(DROP_FILES), seed: 7 });
      h.frames(5);
      return h.runtime.seed;
    };
    expect(await run()).toBe(await run());
  });
});

const CRATE_FILES = {
  'prefabs/crate.prefab.json': { components: { model: { model: 'models/crate' } } },
  'prefabs/camera.prefab.json': { components: { camera: {} } },
  'scenes/main/scene.json': {
    entities: [{ prefab: 'crate', id: 'crate', at: [0, 0, 0] }, { prefab: 'camera', id: 'camera', at: [0, 2, -6] }],
  },
};

function crateGame(): Record<string, unknown> {
  return { game: new Game(kw({ id: 'crates', title: 'Crates', sdk: '1.0', mode: '3d', start_scene: sceneRef('main') })) };
}

describe('3D games', () => {
  it('draw through render3d on RecordingSurface3d; a data-only run has no model files and still plays, with ctx.vfx', async () => {
    const h = await bootHeadless({ entry: crateGame(), files: files(CRATE_FILES) });
    expect(h.runtime.render3d).toBeDefined();
    const vfx = (h.runtime.ctx as unknown as Record<string, { play(...args: unknown[]): void }>)['vfx']!;
    vfx.play(new EffectRef('vfx/sparks'), kw({ at: new Vec3(0, 1, 0) }));
    h.frames(3);
    expect(h.surface3d.drawn).toBe(3);
    expect(h.surface.drawn).toBe(0);
  });

  it('preload model files before the first frame; one that fails to load stops the boot', async () => {
    const listed = { ...files(CRATE_FILES), list: () => [...files(CRATE_FILES).list(), 'assets/models/crate.glb'] };
    const error = await startGame({
      entry: crateGame(), files: listed, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: ['assets/models/crate.glb'],
      surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}), seed: 1,
    }).catch((e: unknown) => e);
    expect(diagnosticsOf(error).map((d) => d.code)).toEqual(['PP3804']);
  });

  it('a 3D game without a 3D surface is PP9507', async () => {
    await expect(startGame({
      entry: crateGame(), files: files(CRATE_FILES), devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null,
      surface: new RecordingSurface2d(), seed: 1,
    })).rejects.toThrow(/PP9507/);
  });
});

describe('startGame', () => {
  it('requires the entry to export `game = Game(...)` (PP9503)', async () => {
    await expect(startGame({ entry: { gmae: 1 }, files: files(DROP_FILES), devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, surface: new RecordingSurface2d(), seed: 1 }))
      .rejects.toThrow(/PP9503.*game = Game/);
  });

  it('stops on project data errors with every diagnostic', async () => {
    const broken = { ...DROP_FILES, 'scenes/main/scene.json': { entities: [{ prefab: 'bal', at: [0, 0] }] } };
    const error = await startGame({ entry: dropGame(), files: files(broken), devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, surface: new RecordingSurface2d(), seed: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootFailure);
    const ds = diagnosticsOf(error);
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((d) => d.code.startsWith('PP') && d.severity === 'error')).toBe(true);
  });

  it('the device tier is Settings.quality on a first run; a saved profile keeps the player\'s choice; jobs are provided', async () => {
    const start = (store: MemoryStore) => startGame({
      entry: dropGame(), files: files(DROP_FILES), devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null,
      surface: new RecordingSurface2d(), seed: 1, store, defaultQuality: 'low',
    });
    const store = new MemoryStore();
    const first = await start(store);
    expect(first.runtime.kernel.resource('settings')['quality']).toBe('low');
    expect(first.runtime.kernel.service(JOBS_SERVICE).mode).toBe('inline');
    first.runtime.kernel.resource('settings')['quality'] = 'high';
    first.runtime.step(1 / 60);
    resetDeclarations();
    const again = await start(store);
    expect(again.runtime.kernel.resource('settings')['quality']).toBe('high');
  });

  it('an attribute read on None is AttributeError (PP9508), as in Python', () => {
    let error: unknown;
    try { (null as unknown as { get(): void }).get(); } catch (e) { error = e; }
    const [d] = diagnosticsOf(error);
    expect([d!.code, d!.message]).toEqual(['PP9508', "AttributeError: 'NoneType' object has no attribute 'get'"]);
  });

  it('reads Firefox\'s and Safari\'s wording of a None attribute read too', () => {
    for (const message of [`can't access property "get", ctx.target is null`, "null is not an object (evaluating 'ctx.target.get')"]) {
      const [d] = diagnosticsOf(new TypeError(message));
      expect([d!.code, d!.message]).toEqual(['PP9508', "AttributeError: 'NoneType' object has no attribute 'get'"]);
    }
  });

  it('turns foreign errors into PP9500 diagnostics', () => {
    const [d] = diagnosticsOf(new TypeError('x is undefined'));
    expect(d!.code).toBe('PP9500');
    expect(d!.message).toBe('TypeError: x is undefined');
    expect(d!.fix).toMatch(/console/);
  });
});

describe('GameLoop', () => {
  function loop(maxFrameTime?: number) {
    const clock = new ManualClock();
    const display = new ManualDisplay();
    const steps: number[] = [];
    const errors: unknown[] = [];
    let fail = false;
    const l = new GameLoop({
      target: { step: (dt) => { if (fail) throw new Error('boom'); steps.push(dt); } },
      clock, display, onError: (e) => errors.push(e), ...(maxFrameTime !== undefined && { maxFrameTime }),
    });
    return { l, clock, display, steps, errors, breakNext: () => { fail = true; } };
  }

  it('steps by real time, clamping stalls', () => {
    const t = loop(0.1);
    t.l.start();
    t.clock.advance(0.016);
    t.display.refresh();
    t.clock.advance(5);
    t.display.refresh();
    expect(t.steps).toEqual([0.016, 0.1]);
  });

  it('keeps stepping while hidden on whileHidden (a hosting browser), and stops it when shown or stopped', () => {
    const clock = new ManualClock();
    const display = new ManualDisplay();
    const steps: number[] = [];
    let tick: (() => void) | undefined;
    const l = new GameLoop({
      target: { step: (dt) => steps.push(dt) }, clock, display, onError: () => {},
      whileHidden: (fn) => { tick = fn; return () => { tick = undefined; }; },
    });
    l.start();
    display.setVisible(false);
    clock.advance(0.05);
    tick!();
    expect(steps).toEqual([0.05]);
    display.setVisible(true);
    expect(tick).toBeUndefined();
    display.setVisible(false);
    l.stop();
    expect(tick).toBeUndefined();
  });

  it('skips refreshes without elapsed time', () => {
    const t = loop();
    t.l.start();
    t.display.refresh();
    expect(t.steps).toEqual([]);
  });

  it('stops on an error and reports it', () => {
    const t = loop();
    t.l.start();
    t.breakNext();
    t.clock.advance(0.016);
    t.display.refresh();
    expect(t.errors).toHaveLength(1);
    expect(t.l.running).toBe(false);
    expect(t.display.refreshing).toBe(false);
  });

  it('does not refresh while hidden at start, and resumes when shown', () => {
    const t = loop();
    t.display.setVisible(false);
    t.l.start();
    expect(t.l.paused).toBe(true);
    t.clock.advance(3);
    t.display.setVisible(true);
    t.clock.advance(0.02);
    t.display.refresh();
    expect(t.steps.map((s) => Number(s.toFixed(6)))).toEqual([0.02]);
    t.l.stop();
    t.display.setVisible(false);
    t.display.setVisible(true);
    expect(t.display.refreshing).toBe(false);
  });
});

describe('engine modules', () => {
  it('maps every SDK module and names a missing one with PP9501', () => {
    expect(ENGINE_MODULES['parallax']).toBe('api/index.ts');
    expect(ENGINE_MODULES['parallax/physics']).toBe('api/physics.ts');
    expect(missingEngineModule('parallax/combat', 'game/x.js').message).toMatch(/not implemented by this engine build/);
    const unknown = missingEngineModule('os', 'game/x.js');
    expect(unknown.code).toBe('PP9501');
    expect(unknown.path).toBe('game/x.js');
  });

  it('splits a build into game modules and save migrations (tests in neither)', () => {
    const manifest: BuildManifest = {
      entry: 'game/main.js',
      modules: [
        { source: 'game/main.py', output: 'game/main.js' },
        { source: 'game/hud.py', output: 'game/hud.js' },
        { source: 'migrations/0002_bag.py', output: 'migrations/0002_bag.js' },
        { source: 'tests/test_bag.py', output: 'tests/test_bag.js' },
        { source: 'features/shop/migrations/0003_prices.py', output: 'features/shop/migrations/0003_prices.js' },
        { source: 'game/broken.py', output: null },
      ],
    };
    expect(gameModules(manifest)).toEqual(['game/hud.js']);
    expect(migrationModules(manifest)).toEqual(['migrations/0002_bag.js', 'features/shop/migrations/0003_prices.js']);
  });
});
