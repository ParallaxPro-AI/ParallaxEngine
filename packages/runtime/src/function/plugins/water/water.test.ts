/**
 * The water plugin, headless on Rapier: Gerstner wave sampling (deterministic, matching
 * the displaced mesh), bodies and their footprints, river flow, buoyancy at equilibrium and
 * water drag, splashes and wakes, the water service a swimming Character reads, snapshots.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, Fields, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { AUDIO_SERVICE, WATER_SERVICE, WATER_WORLD_SERVICE } from '../../services/index.js';
import { characters } from '../characters/index.js';
import { terrain } from '../terrain/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { buildWaves, displace, openSea, riverCourse, riverSpot, water, WATER_EVENTS, waveHeight, waveNormal, windWaveScale } from './index.js';
import type { WaterPlugin } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

type Log = Array<[string, Fields]>;

function game(prefabs: Record<string, unknown>, entities: unknown[], extra: KernelPlugin[] = []) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const log: Log = [];
  const watch: BehaviorDef = {
    id: 'watch', params: {}, state: {}, requires: [],
    handlers: [{ event: WATER_EVENTS.entered, method: 'entered' }],
    create: () => ({ entered(this: LogicInstance, _ctx: unknown, e: Fields) { log.push(['entered', e]); } }) as unknown as LogicInstance,
  };
  const plugin: WaterPlugin = water();
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [watch], systems: [] },
    plugins: [physics3d({ gravity: -9.8 }), characters(), plugin, ...extra], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel, log, id, control: plugin.control(),
    pos: (placed: string) => kernel.world.require(id(placed)).transform.worldPosition(),
    fields: (placed: string, component: string) => kernel.world.require(id(placed)).components.get(component)!,
    run: (frames: number, each?: () => void) => {
      for (let i = 0; i < frames; i++) {
        each?.();
        kernel.step(DT);
      }
    },
  };
}

describe('waves', () => {
  const spec = { height: 1.2, wavelength: 20, direction: 30, spread: 35, choppiness: 0.7, seed: 4 };

  it('are deterministic: the same set and the same heights from the same spec and time', () => {
    const a = buildWaves(spec);
    const b = buildWaves(spec);
    expect([...a]).toEqual([...b]);
    expect(waveHeight(a, 12.5, -3, 7.25)).toBe(waveHeight(b, 12.5, -3, 7.25));
    expect([...buildWaves({ ...spec, seed: 5 })]).not.toEqual([...a]);
  });

  it('have the significant height asked for, and still water is flat', () => {
    const set = buildWaves(spec);
    let sum = 0; let n = 0;
    for (let x = 0; x < 400; x += 7) for (let t = 0; t < 30; t += 1.3) { const h = waveHeight(set, x, x * 0.3, t); sum += h * h; n++; }
    // Hs = 4·σ of the surface.
    expect(4 * Math.sqrt(sum / n)).toBeGreaterThan(0.9);
    expect(4 * Math.sqrt(sum / n)).toBeLessThan(1.5);
    expect(waveHeight(buildWaves({ ...spec, height: 0 }), 3, 4, 5)).toBe(0);
  });

  it('sample the height of the displaced mesh: the vertex that lands at (x, z) is at that height', () => {
    const set = buildWaves(spec);
    for (const [x0, z0, t] of [[0, 0, 0], [13, -7, 4.5], [-40, 22, 19]] as const) {
      const p = displace(set, x0, z0, t);
      expect(waveHeight(set, p[0]!, p[2]!, t)).toBeCloseTo(p[1]!, 3);
    }
    const n = waveNormal(set, 5, 5, 2);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    expect(n[1]).toBeGreaterThan(0.5);
  });

  it('grow with a storm wind', () => {
    expect(windWaveScale(3)).toBe(1);
    expect(windWaveScale(14)).toBe(2);
  });
});

describe('bodies', () => {
  const lake = { components: { water_body: { kind: 'lake', area: { center: [0, 0], size: [20, 10] }, waves: 'none' } } };
  const sea = { components: { water_body: { kind: 'ocean', waves: 'none', depth: 30 } } };

  it('a point is in the body whose footprint and depth hold it; the highest surface wins', () => {
    const g = game({ lake, sea }, [{ prefab: 'lake', id: 'lake', at: [0, 5, 0], rotation: [0, 90, 0] }, { prefab: 'sea', at: [0, 0, 0] }]);
    const service = g.kernel.service(WATER_SERVICE);
    // The lake turned 90°: 20 m along world z, 10 along x.
    expect(service.sample(new Vec3(0, 4, 9))?.surface).toBeCloseTo(5, 6);
    expect(service.sample(new Vec3(7, 4, 0))?.surface).toBeCloseTo(0, 6);
    // Below the lake's bed (5 - 6): the sea.
    expect(service.sample(new Vec3(0, -2, 0))?.surface).toBeCloseTo(0, 6);
    expect(service.sample(new Vec3(0, -40, 0))).toBeUndefined();
    expect(g.control.depthAt(new Vec3(0, 3, 0))).toBeCloseTo(2, 6);
    expect(g.control.bodyAt(new Vec3(0, 3, 0))).toBe(g.id('lake'));
    expect(g.control.inWater(new Vec3(0, 6, 0))).toBe(false);
  });

  it('a round lake and an offset, rotated rectangle follow their area footprint', () => {
    const pond = { components: { water_body: { kind: 'lake', area: { center: [0, 0], radius: 5 }, waves: 'none' } } };
    const basin = { components: { water_body: { kind: 'pool', area: { center: [10, 0], size: [4, 20], rotation: 90 } } } };
    const g = game({ pond, basin }, [{ prefab: 'pond', at: [0, 5, 0] }, { prefab: 'basin', at: [0, 5, 0] }]);
    const service = g.kernel.service(WATER_SERVICE);
    expect(service.sample(new Vec3(3, 4, 3))?.surface).toBeCloseTo(5, 6);
    expect(service.sample(new Vec3(4.5, 4, 4.5))).toBeUndefined();
    // The basin: centered at x = 10, turned 90°: 20 m along world x, 4 along z.
    expect(service.sample(new Vec3(19, 4, 0))?.surface).toBeCloseTo(5, 6);
    expect(service.sample(new Vec3(10, 4, 3))).toBeUndefined();
  });

  it('rejects a lake without an area, old size/shape spellings and an unknown wave preset (PP3370)', () => {
    expect(() => game({ bad: { components: { water_body: { kind: 'lake' } } } }, [{ prefab: 'bad' }])).toThrow(/PP3370[\s\S]*area/);
    expect(() => game({ bad: { components: { water_body: { kind: 'lake', area: [[0, 0], [5, 5]] } } } }, [{ prefab: 'bad' }])).toThrow(/PP3370[\s\S]*center/);
    expect(() => game({ bad: { components: { water_body: { kind: 'ocean', waves: 'stormy' } } } }, [{ prefab: 'bad' }])).toThrow(/PP3370[\s\S]*storm/);
  });
});

describe("the terrain's water_level", () => {
  const start = (block: Record<string, unknown>): { kernel: Kernel; plugin: WaterPlugin } => {
    const project = loadProject(files({ 'scenes/main/scene.json': { terrain: block, entities: [] } }));
    expect(project.diagnostics).toEqual([]);
    const plugin = water();
    const kernel = new Kernel({
      project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
      plugins: [terrain(), physics3d({ gravity: -9.8 }), plugin], context: {}, fixedStep: DT,
    });
    kernel.start('main');
    return { kernel, plugin };
  };

  it('is open sea past the terrain when most of its border is under water (an island)', () => {
    const { kernel, plugin } = start({
      size: [200, 200], base_height: -6, water_level: 0, layers: ['grass'],
      hills: [{ center: [0, 0], radius: 50, height: 12, feather: 20 }],
    });
    const bodies = kernel.service(WATER_WORLD_SERVICE).bodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.kind).toBe('ocean');
    expect(plugin.control().heightAt(800, -900)).toBeCloseTo(0, 0);
    expect(openSea(Float32Array.from([-1, -1, -1, -1, 5, -1, -1, -1, -1]), 3, 3, 0)).toBe(true);
    expect(openSea(Float32Array.from([1, 1, 1, 1, -5, 1, 1, 1, 1]), 3, 3, 0)).toBe(false);
  });

  it('is a calm lake over the whole terrain when its border stands above the water, listed with the bodies', () => {
    const project = loadProject(files({
      'scenes/main/scene.json': { terrain: { size: [100, 80], base_height: 2, max_height: 4, seed: 3, water_level: 1, layers: ['grass'], flats: [{ center: [0, 0], radius: 25, height: -2, feather: 5 }] }, entities: [] },
    }));
    expect(project.diagnostics).toEqual([]);
    const plugin = water();
    const kernel = new Kernel({
      project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
      plugins: [terrain(), physics3d({ gravity: -9.8 }), plugin], context: {}, fixedStep: DT,
    });
    kernel.start('main');
    const bodies = kernel.service(WATER_WORLD_SERVICE).bodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.entity).toBeNull();
    expect(bodies[0]!.kind).toBe('lake');
    expect(bodies[0]!.halfX).toBe(50);
    expect(plugin.control().heightAt(10, 10)).toBeCloseTo(1, 0);
    expect(plugin.control().heightAt(60, 0)).toBeUndefined();
  });
});

describe('rivers', () => {
  const river = { components: { water_body: { kind: 'river', points: [[0, 0, 0], [0, -2, 50], [0, -4, 100]], width: 8, flow: 2, waves: 'none' } } };

  it('flow downstream at their mean speed (1.5× at the center, slack at the banks) and descend with the course', () => {
    const bend = riverCourse([new Vec3(0, 0, 0), new Vec3(0, 0, 10), new Vec3(10, 0, 20)]);
    expect(bend.length).toBeGreaterThan(20);
    expect(bend.xs[bend.xs.length - 1]).toBe(10);
    const straight = riverCourse([new Vec3(0, 0, 0), new Vec3(0, -1, 10), new Vec3(0, -2, 20)]);
    const spot = riverSpot(straight, 1, 5);
    // +x is to the right looking downstream (+z).
    expect(spot.across).toBeCloseTo(1, 6);
    expect(spot.along).toBeCloseTo(5, 6);
    expect(spot.y).toBeCloseTo(-0.5, 2);
    expect(spot.dirZ).toBeCloseTo(1, 6);

    const g = game({ river }, [{ prefab: 'river', at: [0, 0, 0] }]);
    const center = g.control.flowAt(new Vec3(0, -1, 25));
    expect(center.z).toBeCloseTo(3, 1);
    expect(Math.abs(center.x)).toBeLessThan(1e-6);
    expect(g.control.flowAt(new Vec3(3.9, -1, 25)).z).toBeLessThan(0.2);
    expect(g.control.heightAt(0, 75)).toBeCloseTo(-3, 1);
    expect(g.control.heightAt(10, 50)).toBeUndefined();
  });

  it('carry a floating crate downstream toward the current', () => {
    const crate = { components: { rigidbody: { mass: 200 }, collider: { shape: 'box', size: [1, 1, 1] }, buoyancy: { drag: 1.5 } } };
    const g = game({ river, crate }, [{ prefab: 'river', at: [0, 0, 0] }, { prefab: 'crate', id: 'crate', at: [0, -1, 10] }]);
    g.run(600);
    const v = g.kernel.world.require(g.id('crate')).components.get('rigidbody')!['velocity'] as Vec3;
    expect(g.pos('crate').z).toBeGreaterThan(20);
    // Near the center line the water runs at ~3 m/s; the crate is taken up toward it.
    expect(v.z).toBeGreaterThan(1.5);
  });
});

describe('buoyancy', () => {
  const pool = { components: { water_body: { kind: 'pool', area: { center: [0, 0], size: [40, 40] }, depth: 10 } } };
  const box = (mass: number, extra: Fields = {}) => ({
    components: { rigidbody: { mass }, collider: { shape: 'box', size: [1, 1, 1] }, buoyancy: { ...extra } },
    behaviors: { watch: {} },
  });

  it('floats a box at the draft of its density: half as dense as water floats half under', () => {
    for (const [mass, draft] of [[500, 0.5], [250, 0.25], [800, 0.8]] as const) {
      const g = game({ pool, box: box(mass) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 0.6, 0] }]);
      g.run(1500);
      // The box's center sits (0.5 - draft) above the surface.
      expect(g.pos('box').y).toBeCloseTo(0.5 - draft, 1);
      expect(g.fields('box', 'buoyancy')['submerged']).toBeCloseTo(draft, 1);
      expect(g.kernel.service(WATER_WORLD_SERVICE).submerged(g.id('box'))).toBeCloseTo(draft, 1);
    }
  });

  it('sinks a body denser than water', () => {
    const g = game({ pool, box: box(1500) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 0, 0] }]);
    g.run(240);
    expect(g.pos('box').y).toBeLessThan(-5);
  });

  it('drags a moving body to rest, faster with more drag', () => {
    const speedAfter = (drag: number): number => {
      const g = game({ pool, box: box(500, { drag }) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 0, 0] }]);
      g.run(300);
      const body = g.kernel.world.require(g.id('box')).components.get('rigidbody') as Fields & { velocity: Vec3 };
      body['velocity'] = new Vec3(4, 0, 0);
      g.run(60);
      return (body['velocity'] as Vec3).flat().length();
    };
    const slow = speedAfter(0.5);
    const fast = speedAfter(2);
    expect(slow).toBeLessThan(4);
    expect(fast).toBeLessThan(slow);
    // Half submerged, drag 2/s: e^(-2·0.5·1 s) ≈ 0.37 of the speed is left (± the step's discretization).
    expect(fast / 4).toBeCloseTo(Math.exp(-1), 1);
  });

  it('a body falling in raises water_entered and splashes; moving fast it leaves a wake', () => {
    const g = game({ pool, box: box(500) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 6, 0] }]);
    g.run(120);
    expect(g.log.filter(([m]) => m === 'entered')).toHaveLength(1);
    expect(g.log[0]![1]['speed'] as number).toBeGreaterThan(5);
    const world = g.kernel.service(WATER_WORLD_SERVICE);
    expect(world.disturbances().some((d) => d.kind === 'splash')).toBe(true);
    const body = g.kernel.world.require(g.id('box')).components.get('rigidbody')!;
    g.run(30, () => { body['velocity'] = new Vec3(6, 0, 0); });
    expect(world.disturbances().filter((d) => d.kind === 'wake').length).toBeGreaterThan(2);
  });

  it("a body's splash_sound plays at each splash, as loud as the splash; without one splashes are silent", () => {
    const heard: Array<[string, number, number]> = [];
    const recorder: KernelPlugin = {
      id: 'audio_recorder',
      install: (kernel) => kernel.provide(AUDIO_SERVICE, {
        play: (s) => { heard.push([s.sound, s.at?.y ?? NaN, s.volume ?? 1]); }, loop: () => {}, stop: () => {},
      }),
    };
    const loud = { components: { water_body: { kind: 'pool', area: { center: [0, 0], size: [40, 40] }, depth: 10, splash_sound: 'sfx/splash' } } };
    const g = game({ pool: loud, box: box(500) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 6, 0] }], [recorder]);
    g.run(120);
    g.control.splash(new Vec3(5, 0, 5), 0.3);
    expect(heard.map(([s]) => s)).toEqual(['sfx/splash', 'sfx/splash']);
    expect(heard[0]![2]).toBeGreaterThan(0.5);
    expect(heard[1]).toEqual(['sfx/splash', 0, 0.3]);
    heard.length = 0;
    const quiet = game({ pool, box: box(500) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 6, 0] }], [recorder]);
    quiet.run(120);
    expect(heard).toEqual([]);
  });

  it('needs a dynamic body (PP3371)', () => {
    const g = game({ pool, rock: { components: { collider: { shape: 'box', size: [1, 1, 1] }, buoyancy: {} } } },
      [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'rock', at: [0, 0, 0] }]);
    expect(() => g.run(1)).toThrow(/PP3371/);
  });

  it('snapshots: splashes and a floating body continue the same after a restore', () => {
    const g = game({ pool, box: box(500) }, [{ prefab: 'pool', at: [0, 0, 0] }, { prefab: 'box', id: 'box', at: [0, 3, 0] }]);
    g.run(50);
    const saved = g.kernel.snapshot();
    g.run(60);
    const after = g.pos('box');
    const splashes = g.kernel.service(WATER_WORLD_SERVICE).disturbances().length;
    g.kernel.restore(saved);
    g.run(60);
    expect(g.pos('box').y).toBeCloseTo(after.y, 5);
    expect(g.kernel.service(WATER_WORLD_SERVICE).disturbances().length).toBe(splashes);
  });
});

describe('swimming', () => {
  it('a Character with swim wades into a lake, splashing, and floats at its float depth', () => {
    const ground = { components: { collider: { shape: 'box', size: [40, 1, 25], offset: [0, -0.5, 0] } } };
    const bed = { components: { collider: { shape: 'box', size: [40, 1, 35], offset: [0, -0.5, 0] } } };
    const lake = { components: { water_body: { kind: 'lake', area: { center: [0, 0], size: [40, 35] }, depth: 3, waves: 'none' } } };
    const hero = { components: { character: { acceleration: 60, swim: {} } } };
    const g = game({ ground, bed, lake, hero }, [
      { prefab: 'ground', at: [0, 0, -7.5] }, { prefab: 'bed', at: [0, -3, 22.5] }, { prefab: 'lake', at: [0, 0, 22.5] },
      { prefab: 'hero', id: 'hero', at: [0, 0, 3] },
    ]);
    const c = g.kernel.world.require(g.id('hero')).components.get('character') as Fields & { move(d: Vec3): void; readonly motion: string };
    g.run(20);
    expect(c.motion).toBe('ground');
    let splashes = 0;
    g.run(90, () => {
      c.move(new Vec3(0, 0, 1));
      splashes = Math.max(splashes, g.kernel.service(WATER_WORLD_SERVICE).disturbances().filter((d) => d.kind === 'splash').length);
    });
    // Stepping off the bank splashed once, where it went in.
    expect(splashes).toBe(1);
    const splash = g.kernel.service(WATER_WORLD_SERVICE).disturbances().find((d) => d.kind === 'splash')!;
    expect(splash.y).toBeCloseTo(0, 3);
    expect(splash.strength).toBeGreaterThan(0.2);
    g.run(240);
    expect(c.motion).toBe('swim');
    expect(g.pos('hero').y).toBeCloseTo(-1.25, 1);
  });
});
