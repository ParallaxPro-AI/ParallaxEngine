import { describe, expect, it, vi } from 'vitest';
import { ParallaxError, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { JsonObject, Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, GameDefinition, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { JOBS_SERVICE, MODEL_GEOMETRY_SERVICE, NAV_SERVICE, PROCGEN_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { GeneratedMesh } from '../../services/index.js';
import type { JobKey, JobRunner } from '../../../core/index.js';
import type { ModelGeometry } from '../../services/index.js';
import { terrain } from '../terrain/index.js';
import { ARRIVED, findPaths, nav, NAV_AGENT, NAV_PATHS } from './index.js';
import type { NavPlugin } from './index.js';
import { Pathfinder } from './search.js';

const ORIGIN = { path: 'x', pointer: '' };

/** physics3d isn't built yet: collider and rigidbody with their SDK fields (nav reads them by id). */
const COLLIDER: ComponentDef = {
  id: 'collider',
  schema: {
    shape: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }),
    layer: t.string({ default: 'default' }),
  },
};
const RIGIDBODY: ComponentDef = { id: 'rigidbody', schema: { kind: t.string({ default: 'dynamic' }) } };
const CHARACTER: ComponentDef = { id: 'character', schema: {} };

const arrivals: unknown[] = [];
const listener: SystemDef = {
  id: 'listener', scenes: [], handlers: [{ event: ARRIVED, method: 'on_arrived' }],
  create: () => ({ on_arrived: (_ctx: unknown, e: { entity: unknown }) => arrivals.push(e.entity) }),
};

function prefab(id: string, components: Record<string, JsonObject>): PrefabDoc {
  return { id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags: [], behaviors: [], children: [] };
}

function place(prefabId: string, at: number[], extra: Partial<Placement> = {}): Placement {
  return { prefab: prefabId, at, components: {}, tags: [], params: {}, origin: ORIGIN, ...extra };
}

const PREFABS = [
  prefab('floor', { collider: { shape: 'box', size: [60, 0.2, 60], offset: [0, -0.1, 0] } }),
  prefab('wall', { collider: { shape: 'box', size: [1, 3, 12], offset: [0, 1.5, 0], layer: 'wall' } }),
  prefab('pillar', { collider: { shape: 'cylinder', radius: 1, height: 4, offset: [0, 2, 0], layer: 'prop' } }),
  prefab('rock', { collider: { shape: 'convex' } }),
  prefab('walker', { nav_agent: { speed: 4, radius: 0.4, stopping_distance: 0.3 } }),
  prefab('crowd', { nav_agent: { speed: 3, radius: 0.5, stopping_distance: 0.3, avoid_others: true } }),
  prefab('tank', { nav_agent: { radius: 1, drives_body: false }, rigidbody: { kind: 'kinematic' } }),
  prefab('ball', { nav_agent: {}, rigidbody: { kind: 'dynamic' } }),
  prefab('hero', { nav_agent: {}, character: {} }),
  prefab('marker', {}),
];

function sceneDoc(id: string, entities: Placement[], plugins: Record<string, JsonObject> = {}): SceneDoc {
  return { id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities, regions: new Map(), plugins };
}

function project(scenes: SceneDoc[]): Project {
  return {
    prefabs: new Map(PREFABS.map((p) => [p.id, p])), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(),
    content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
}

function game(): GameDefinition {
  return { components: [COLLIDER, RIGIDBODY, CHARACTER], resources: [], events: [], behaviors: [], systems: [listener] };
}

interface Started { kernel: Kernel; plugin: NavPlugin; byPrefab(id: string): EntityId[] }

function start(scenes: SceneDoc[], first = scenes[0]!.id, withTerrain = false): Started {
  const plugin = nav({ cellSize: 0.25 });
  const kernel = new Kernel({ project: project(scenes), game: game(), plugins: [...(withTerrain ? [terrain()] : []), plugin], context: {} });
  kernel.start(first);
  const byPrefab = (id: string): EntityId[] => [...kernel.world.live()].filter((r) => r.prefab === id).map((r) => r.id);
  return { kernel, plugin, byPrefab };
}

function agent(kernel: Kernel, id: EntityId): {
  move_to(t: unknown): boolean; stop(): void; moving: boolean; destination: Vec3 | null; desired_velocity: Vec3;
} {
  return kernel.world.require(id).components.get(NAV_AGENT) as never;
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const pos = (kernel: Kernel, id: EntityId): Vec3 => kernel.world.require(id).transform.worldPosition();

const WALLED = sceneDoc('walled', [place('floor', [0, 0, 0]), place('wall', [0, 0, 0]), place('walker', [-5, 0, 0])]);

describe('nav agents', () => {
  it('walk around a wall to a point, staying clear of it, and fire Arrived once', () => {
    arrivals.length = 0;
    const { kernel, byPrefab } = start([WALLED]);
    const [walker] = byPrefab('walker');
    const a = agent(kernel, walker!);
    expect(a.move_to(new Vec3(5, 0, 0))).toBe(true);
    expect(a.moving).toBe(true);
    expect(a.destination).toEqual(new Vec3(5, 0, 0));
    let maxAbsZ = 0;
    for (let i = 0; i < 60 * 15 && arrivals.length === 0; i++) {
      kernel.step(1 / 60);
      const p = pos(kernel, walker!);
      // Never inside the wall's footprint grown by the radius.
      if (Math.abs(p.z) < 6 + 0.39) expect(Math.abs(p.x)).toBeGreaterThan(0.5 + 0.39);
      maxAbsZ = Math.max(maxAbsZ, Math.abs(p.z));
    }
    expect(arrivals).toEqual([walker]);
    expect(maxAbsZ).toBeGreaterThan(6);
    const end = pos(kernel, walker!);
    expect(Math.hypot(end.x - 5, end.z)).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(end.y).toBeCloseTo(0);
    expect(a.moving).toBe(false);
    expect(a.destination).toBeNull();
    expect(a.desired_velocity).toEqual(Vec3.ZERO);
    for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    expect(arrivals).toHaveLength(1);
  });

  it('faces where it walks', () => {
    const { kernel, byPrefab } = start([sceneDoc('open', [place('floor', [0, 0, 0]), place('walker', [0, 0, 0])])]);
    const [walker] = byPrefab('walker');
    agent(kernel, walker!).move_to(new Vec3(10, 0, 0));
    kernel.step(1 / 60);
    const forward = kernel.world.require(walker!).transform.rotation.rotate(Vec3.FORWARD);
    expect(forward.x).toBeCloseTo(1, 5);
  });

  it('follow an entity, arrive, and set off again when it moves away', () => {
    arrivals.length = 0;
    const scene = sceneDoc('follow', [place('floor', [0, 0, 0]), place('walker', [-8, 0, 0]), place('marker', [8, 0, 3])]);
    const { kernel, byPrefab } = start([scene]);
    const [walker] = byPrefab('walker');
    const [marker] = byPrefab('marker');
    const a = agent(kernel, walker!);
    expect(a.move_to(marker!)).toBe(true);
    for (let i = 0; i < 60 * 8 && arrivals.length === 0; i++) kernel.step(1 / 60);
    expect(arrivals).toEqual([walker]);
    expect(a.moving).toBe(false);
    kernel.world.require(marker!).transform.position = new Vec3(-10, 0, -5);
    for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    expect(a.moving).toBe(true);
    for (let i = 0; i < 60 * 10 && arrivals.length === 1; i++) kernel.step(1 / 60);
    expect(arrivals).toEqual([walker, walker]);
    expect(Math.hypot(pos(kernel, walker!).x + 10, pos(kernel, walker!).z + 5)).toBeLessThanOrEqual(0.31);
    kernel.destroy(marker!);
    kernel.step(1 / 60);
    expect(a.moving).toBe(false);
    expect(a.destination).toBeNull();
  });

  it('report unreachable targets with False and do not move', () => {
    const box = sceneDoc('boxed', [
      place('floor', [0, 0, 0]),
      place('wall', [3, 0, 0]), place('wall', [-3, 0, 0]),
      place('wall', [0, 0, 3], { rotation: [0, 90, 0] }), place('wall', [0, 0, -3], { rotation: [0, 90, 0] }),
      place('walker', [0, 0, 0]),
    ]);
    const { kernel, byPrefab } = start([box]);
    const [walker] = byPrefab('walker');
    const a = agent(kernel, walker!);
    expect(a.move_to(new Vec3(15, 0, 0))).toBe(false);
    expect(a.moving).toBe(false);
    kernel.step(1 / 60);
    expect(pos(kernel, walker!)).toEqual(new Vec3(0, 0, 0));
    expect(a.move_to(new Vec3(1, 0, 1))).toBe(true);
  });

  it('see static colliders spawned mid-scene (cover) and their removal', () => {
    const { kernel, plugin } = start([sceneDoc('open', [place('floor', [0, 0, 0])])]);
    const q = plugin.queries();
    const straight = q.path(new Vec3(-5, 0, 0), new Vec3(5, 0, 0));
    expect(straight).toHaveLength(2);
    const wall = kernel.spawn('wall', { at: [0, 0, 0] });
    const around = q.path(new Vec3(-5, 0, 0), new Vec3(5, 0, 0));
    expect(around.length).toBeGreaterThan(2);
    expect(Math.max(...around.map((p) => Math.abs(p.z)))).toBeGreaterThan(6);
    kernel.destroy(wall.id);
    kernel.step(1 / 60);
    expect(q.path(new Vec3(-5, 0, 0), new Vec3(5, 0, 0))).toHaveLength(2);
  });

  it('avoid each other: two agents walking head-on pass without overlapping', () => {
    const scene = sceneDoc('lane', [place('floor', [0, 0, 0]), place('crowd', [-6, 0, 0]), place('crowd', [6, 0, 0.05])]);
    const { kernel, byPrefab } = start([scene]);
    const [a, b] = byPrefab('crowd');
    agent(kernel, a!).move_to(new Vec3(6, 0, 0));
    agent(kernel, b!).move_to(new Vec3(-6, 0, 0));
    let closest = Infinity;
    for (let i = 0; i < 60 * 6; i++) {
      kernel.step(1 / 60);
      closest = Math.min(closest, pos(kernel, a!).distance_to(pos(kernel, b!)));
    }
    expect(closest).toBeGreaterThan(0.6);
    expect(pos(kernel, a!).x).toBeGreaterThan(5);
    expect(pos(kernel, b!).x).toBeLessThan(-5);
  });

  it('with drives_body False, only steer', () => {
    const { kernel, byPrefab } = start([sceneDoc('field', [place('floor', [0, 0, 0]), place('tank', [0, 0, 0])])]);
    const [tank] = byPrefab('tank');
    const a = agent(kernel, tank!);
    expect(a.move_to(new Vec3(0, 0, 10))).toBe(true);
    kernel.step(1 / 60);
    expect(pos(kernel, tank!)).toEqual(Vec3.ZERO);
    expect(a.desired_velocity.z).toBeCloseTo(3.5);
    a.stop();
    expect(a.desired_velocity).toEqual(Vec3.ZERO);
  });

  it('refuse to drive bodies physics or a Character moves, and bad targets', () => {
    const scene = sceneDoc('misc', [place('floor', [0, 0, 0]), place('ball', [0, 0, 0]), place('hero', [2, 0, 0]), place('walker', [4, 0, 0])]);
    const { kernel, byPrefab } = start([scene]);
    expect(code(() => agent(kernel, byPrefab('ball')[0]!).move_to(new Vec3(1, 0, 1)))).toBe('PP3248');
    expect(code(() => agent(kernel, byPrefab('hero')[0]!).move_to(new Vec3(1, 0, 1)))).toBe('PP3248');
    const walker = agent(kernel, byPrefab('walker')[0]!);
    expect(code(() => walker.move_to(new Vec2(1, 1)))).toBe('PP3242');
    expect(code(() => walker.move_to('north'))).toBe('PP3241');
    expect(code(() => walker.move_to(byPrefab('walker')[0]!))).toBe('PP3246');
  });

  it('follow terrain heights and keep their lift above it', () => {
    const scene = sceneDoc('hills', [place('walker', [-20, 0, 0])], {
      terrain: { size: [80, 80], base_height: 0, hills: [{ center: [0, 8], radius: 20, height: 4 }], layers: ['grass'] },
    });
    const { kernel, byPrefab } = start([scene], 'hills', true);
    const [walker] = byPrefab('walker');
    const a = agent(kernel, walker!);
    kernel.world.require(walker!).transform.position = new Vec3(-20, 1, 0);
    expect(a.move_to(new Vec3(20, 0, 0))).toBe(true);
    let highest = 0;
    for (let i = 0; i < 60 * 15 && a.moving; i++) {
      kernel.step(1 / 60);
      highest = Math.max(highest, pos(kernel, walker!).y);
    }
    expect(a.moving).toBe(false);
    expect(highest).toBeGreaterThan(2);
    expect(pos(kernel, walker!).y).toBeCloseTo(1, 3);
  });

  it('snapshot and restore mid-walk continue identically', () => {
    const { kernel, byPrefab } = start([WALLED]);
    const [walker] = byPrefab('walker');
    agent(kernel, walker!).move_to(new Vec3(5, 0, 0));
    for (let i = 0; i < 60; i++) kernel.step(1 / 60);
    const snapshot = JSON.parse(JSON.stringify(kernel.snapshot()));
    for (let i = 0; i < 90; i++) kernel.step(1 / 60);
    const expected = pos(kernel, walker!);
    kernel.restore(snapshot);
    for (let i = 0; i < 90; i++) kernel.step(1 / 60);
    expect(pos(kernel, walker!)).toEqual(expected);
  });
});

describe('ctx.nav queries', () => {
  it('path, reachable and the navmesh obstacle layers', () => {
    const { plugin } = start([WALLED]);
    const q = plugin.queries();
    const path = q.path(new Vec3(-5, 0, 0), new Vec3(5, 0, 0));
    expect(path[0]).toEqual(new Vec3(-5, 0, 0));
    expect(path[path.length - 1]).toEqual(new Vec3(5, 0, 0));
    expect(q.reachable(new Vec3(-5, 0, 0), new Vec3(5, 0, 0))).toBe(true);
    expect(q.path(new Vec3(-5, 0, 0), new Vec3(500, 0, 0)).length).toBeGreaterThan(0);

    const onlyProps = sceneDoc('props', [place('floor', [0, 0, 0]), place('wall', [0, 0, 0])], { navmesh: { obstacles: ['prop'], from: 'assets/models/ground.glb' } });
    expect(start([onlyProps]).plugin.queries().path(new Vec3(-5, 0, 0), new Vec3(5, 0, 0))).toHaveLength(2);
    const bad = sceneDoc('bad', [], { navmesh: { obstacle: ['prop'] } });
    expect(code(() => start([bad]))).toBe('PP3240');
  });

  it('terrain bounds, water and steep slopes are not walkable', () => {
    const scene = sceneDoc('isle', [], {
      terrain: { size: [60, 60], base_height: -2, water_level: 0, hills: [{ center: [0, 0], radius: 20, height: 6 }], layers: ['sand'] },
    });
    const { plugin } = start([scene], 'isle', true);
    const q = plugin.queries();
    expect(q.reachable(new Vec3(-8, 0, 0), new Vec3(8, 0, 0))).toBe(true);
    expect(q.reachable(new Vec3(-8, 0, 0), new Vec3(-27, 0, -27))).toBe(false);
    const path = q.path(new Vec3(-8, 0, 0), new Vec3(8, 0, 0));
    expect(path.every((p) => p.y >= 0)).toBe(true);
    const cliffs = sceneDoc('cliffs', [], { terrain: { size: [40, 40], hills: [{ center: [0, 0], radius: 4, height: 30 }], layers: ['rock'] } });
    const c = start([cliffs], 'cliffs', true).plugin.queries();
    expect(c.reachable(new Vec3(-10, 0, 0), new Vec3(0, 0, 0))).toBe(false);
  });

  it('navmesh wade_depth makes shallow water walkable and keeps deeper water blocked', () => {
    // A river gorge: the bed is 0.8 m under the water at the ford (x = 0) and 3.6 m in the pool (x = 12).
    const terrain = {
      size: [60, 60], water_level: -1.2, layers: ['grass'],
      flats: [
        { center: [0, 0], size: [4, 60], height: -2, mode: 'carve' },
        { center: [12, 0], size: [6, 60], height: -4.8, mode: 'carve' },
      ],
    };
    const dry = start([sceneDoc('dry', [], { terrain })], 'dry', true).kernel.service(NAV_SERVICE);
    expect(dry.standable(new Vec3(0, -2, 0), 0.4)).toBe(false);
    const ford = sceneDoc('ford', [], { terrain, navmesh: { wade_depth: 1 } });
    const { kernel, plugin } = start([ford], 'ford', true);
    const nav = kernel.service(NAV_SERVICE);
    expect(nav.standable(new Vec3(0, -2, 0), 0.4)).toBe(true);
    expect(nav.standable(new Vec3(12, -4.8, 0), 0.4)).toBe(false);
    expect(plugin.queries().reachable(new Vec3(-8, 0, 0), new Vec3(6, 0, 0))).toBe(true);
    const deep = sceneDoc('deep', [], { terrain, navmesh: { wade_depth: 4 } });
    expect(start([deep], 'deep', true).kernel.service(NAV_SERVICE).standable(new Vec3(12, -4.8, 0), 0.4)).toBe(true);
    expect(code(() => start([sceneDoc('bad', [], { terrain, navmesh: { wade_depth: -1 } })], 'bad', true))).toBe('PP3240');
  });

  it('terrain holes are not walkable; a crater re-bakes the grid (revision, not only version)', () => {
    const scene = sceneDoc('pit', [], {
      terrain: { size: [40, 40], layers: ['grass'], holes: [{ center: [0, 0], radius: 3 }] },
    });
    const { kernel, plugin } = start([scene], 'pit', true);
    const q = plugin.queries();
    const nav = kernel.service(NAV_SERVICE);
    expect(nav.standable(new Vec3(0, 0, 0), 0.4)).toBe(false);
    expect(nav.standable(new Vec3(8, 0, 0), 0.4)).toBe(true);
    const around = q.path(new Vec3(-8, 0, 0), new Vec3(8, 0, 0));
    expect(around.length).toBeGreaterThan(2);
    for (let i = 1; i < around.length; i++) {
      const [a, b] = [around[i - 1]!, around[i]!];
      for (let t = 0; t <= 1; t += 0.05) expect(Math.hypot(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)).toBeGreaterThan(2.9);
    }
    // A crater in open ground: before, (10, 10) is walkable; after the deformation (same
    // field version, higher revision) its steep wall isn't.
    expect(nav.standable(new Vec3(12, 0, 10), 0.4)).toBe(true);
    const field = kernel.service(TERRAIN_SERVICE).current()!;
    const version = field.version;
    kernel.service(TERRAIN_SERVICE).deform({ kind: 'crater', x: 10, z: 10, radius: 3, depth: 6, rim: 0, layer: null });
    expect(kernel.service(TERRAIN_SERVICE).current()!.version).toBe(version);
    expect(nav.standable(new Vec3(12, 0, 10), 0.4)).toBe(false);
  });

  it('generated scenery (procgen meshes with collision) is an obstacle, re-read on collisionVersion', () => {
    // A wall 1 m thick, 3 m tall, along z from -6 to 6 at x = 0, as world triangles (two faces).
    const wall = (x: number) => ({
      vertices: new Float32Array([x - 0.5, 0, -6, x - 0.5, 3, -6, x - 0.5, 3, 6, x - 0.5, 0, 6, x + 0.5, 0, -6, x + 0.5, 3, -6, x + 0.5, 3, 6, x + 0.5, 0, 6]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
    });
    let meshes: GeneratedMesh[] = [];
    const procgen: KernelPlugin = {
      id: 'procgen', install: (k) => k.provide(PROCGEN_SERVICE, { revision: 0, meshes: () => meshes, path: () => undefined, paths: () => [] }),
    };
    const scene = sceneDoc('gen', [place('floor', [0, 0, 0])]);
    const kernel = new Kernel({ project: project([scene]), game: game(), plugins: [procgen, nav({ cellSize: 0.25 })], context: {} });
    kernel.start('gen');
    const service = kernel.service(NAV_SERVICE);
    const mesh = (x: number, version: number): GeneratedMesh => ({
      key: 'structure:1', entity: null, version, parts: [], world: new Float32Array(16), collision: wall(x), collisionVersion: version,
    });
    expect(service.lineClear(new Vec3(-3, 1, 0), new Vec3(3, 1, 0), [])).toBe(true);
    meshes = [mesh(0, 1)];
    expect(service.lineClear(new Vec3(-3, 1, 0), new Vec3(3, 1, 0), [])).toBe(false);
    expect(service.path(new Vec3(-3, 0, 0), new Vec3(3, 0, 0), 0.4)!.length).toBeGreaterThan(2);
    meshes = [mesh(10, 2)];
    expect(service.lineClear(new Vec3(-3, 1, 0), new Vec3(3, 1, 0), [])).toBe(true);
    meshes = [];
    expect(service.lineClear(new Vec3(7, 1, 0), new Vec3(13, 1, 0), [])).toBe(true);
  });

  it('perf: a path query syncs generated scenery once, not once per grid column', () => {
    // Regression: the grid read the terrain through `installed()`, so every column it built
    // re-ran procgen's meshes() (a full generator sync); playtests went from ~1 s to 25-60 s.
    let calls = 0;
    const procgen: KernelPlugin = {
      id: 'procgen', install: (k) => k.provide(PROCGEN_SERVICE, { revision: 0, meshes: () => { calls++; return []; }, path: () => undefined, paths: () => [] }),
    };
    const kernel = new Kernel({ project: project([WALLED]), game: game(), plugins: [procgen, nav({ cellSize: 0.25 })], context: {} });
    kernel.start('walled');
    const service = kernel.service(NAV_SERVICE);
    calls = 0;
    expect(service.path(new Vec3(-5, 0, 0), new Vec3(5, 0, 0), 0.4)!.length).toBeGreaterThan(2);
    expect(calls).toBe(1);
  });

  it('perf: move_to the goal already being walked to keeps the path; a changed world replans', () => {
    const { kernel, byPrefab } = start([WALLED]);
    const [walker] = byPrefab('walker');
    const a = agent(kernel, walker!);
    const routes = vi.spyOn(Pathfinder.prototype, 'route');
    expect(a.move_to(new Vec3(5, 0, 0))).toBe(true);
    for (let i = 0; i < 10; i++) {
      kernel.step(1 / 60);
      expect(a.move_to(new Vec3(5, 0, 0))).toBe(true);
      expect(a.move_to(new Vec3(5.05, 0, 0))).toBe(true);
    }
    expect(routes).toHaveBeenCalledTimes(1);
    expect(a.destination).toEqual(new Vec3(5.05, 0, 0));
    expect(a.move_to(new Vec3(5, 0, 3))).toBe(true);
    expect(routes).toHaveBeenCalledTimes(2);
    kernel.spawn('pillar', { at: [3, 0, 3] });
    expect(a.move_to(new Vec3(5, 0, 3))).toBe(true);
    expect(routes).toHaveBeenCalledTimes(3);
    routes.mockRestore();
  });

  it('paths(): batched searches through the nav.paths job when a runner is there, the live path otherwise', async () => {
    const calls: string[] = [];
    const runner: JobRunner = {
      mode: 'inline', threads: 0,
      run: <I, O>(key: JobKey<I, O>, input: I) => {
        calls.push(key.id);
        expect(key).toBe(NAV_PATHS);
        return Promise.resolve(structuredClone(findPaths(structuredClone(input) as never)) as O);
      },
      all: () => Promise.reject(new Error('unused')), share: (b) => b, stats: { completed: 0, inline: 0, inlineSeconds: 0 }, dispose: () => undefined,
    };
    const jobs: KernelPlugin = { id: 'jobs', install: (k) => k.provide(JOBS_SERVICE, runner) };
    const kernel = new Kernel({ project: project([WALLED]), game: game(), plugins: [jobs, nav({ cellSize: 0.25 })], context: {} });
    kernel.start('walled');
    const service = kernel.service(NAV_SERVICE);
    const queries = [
      { start: new Vec3(-5, 0, 0), end: new Vec3(5, 0, 0), radius: 0.4 },
      { start: new Vec3(-5, 0, 3), end: new Vec3(5, 0, -3), radius: 0.4 },
      { start: new Vec3(-5, 0, 0), end: new Vec3(5, 0, 1), radius: 0.6 },
    ];
    const found = await service.paths(queries);
    expect(calls).toEqual(['nav.paths', 'nav.paths']); // one job per radius
    found.forEach((path, i) => {
      const q = queries[i]!;
      expect(path!.map((w) => [w.x, w.z])).toEqual(service.path(q.start, q.end, q.radius)!.map((w) => [w.x, w.z]));
    });
    // Without a runner, the same answers on this thread.
    const { kernel: plain } = start([WALLED]);
    const inline = await plain.service(NAV_SERVICE).paths(queries);
    expect(inline.map((p) => p!.map((w) => [w.x, w.z]))).toEqual(found.map((p) => p!.map((w) => [w.x, w.z])));
  });

  it('random_point is reachable, within the radius and deterministic', () => {
    const { plugin } = start([WALLED]);
    const q = plugin.queries();
    const seeded = (): (() => number) => {
      let s = 7;
      return () => ((s = (s * 16807) % 2147483647) / 2147483647);
    };
    const first = q.randomPoint(new Vec3(-5, 0, 0), 8, seeded())!;
    expect(q.randomPoint(new Vec3(-5, 0, 0), 8, seeded())).toEqual(first);
    expect(Math.hypot(first.x + 5, first.z)).toBeLessThanOrEqual(8);
    expect(q.reachable(new Vec3(-5, 0, 0), first)).toBe(true);
    // Inside the wall the nearest standable surface is its top, and points stay up there.
    expect(q.randomPoint(new Vec3(0, 0, 0), 0.2, seeded())!.y).toBe(3);
  });

  it('can_see: distance, field of view, walls and terrain', () => {
    const scene = sceneDoc('sight', [
      place('floor', [0, 0, 0]), place('wall', [0, 0, 0]),
      place('marker', [-5, 1, 0]), place('marker', [5, 1, 0]), place('marker', [-5, 1, 10]), place('marker', [-5, 1, -8]),
    ]);
    const { kernel, plugin, byPrefab } = start([scene]);
    const [a, b, c, d] = byPrefab('marker');
    const q = plugin.queries();
    kernel.world.require(a!).transform.rotation = kernel.world.require(a!).transform.rotation; // facing +z
    expect(q.canSee(a!, c!, 120, 30)).toBe(true);
    expect(q.canSee(a!, c!, 120, 5)).toBe(false);
    expect(q.canSee(a!, d!, 120, 30)).toBe(false); // behind
    expect(q.canSee(a!, d!, 360, 30)).toBe(true);
    expect(q.canSee(a!, b!, 360, 30)).toBe(false); // the wall
    expect(code(() => q.canSee(a!, 'x', 120, 30))).toBe('PP3245');

    const hill = sceneDoc('ridge', [place('marker', [-10, 1, 0]), place('marker', [10, 1, 0])], {
      terrain: { size: [40, 40], hills: [{ center: [0, 0], radius: 5, height: 5 }], layers: ['grass'] },
    });
    const ridge = start([hill], 'ridge', true);
    const [l, r] = ridge.byPrefab('marker');
    expect(ridge.plugin.queries().canSee(l!, r!, 360, 30)).toBe(false);
  });

  it('lists static mesh/convex colliders it cannot rasterize', () => {
    const { plugin, byPrefab } = start([sceneDoc('rocks', [place('floor', [0, 0, 0]), place('rock', [3, 0, 3])])]);
    expect(plugin.queries().unsupported()).toEqual(byPrefab('rock'));
  });
});

describe('mesh and convex colliders (model geometry service)', () => {
  const MODEL: ComponentDef = { id: 'model', schema: { model: t.string({ default: '' }), offset: t.vec3({ default: Vec3.ZERO }) } };
  /** An axis-aligned box from `min` to `max`, 12 triangles. */
  const box = (min: number[], max: number[]): ModelGeometry => {
    const v: number[] = [];
    for (let i = 0; i < 8; i++) v.push(i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!);
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    return { vertices: new Float32Array(v), indices: new Uint32Array(quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])) };
  };
  /** A ramp 20 m along x rising 4 m, 10 m wide, then flat at y = 4 out to x = 30. */
  const RAMP: ModelGeometry = {
    vertices: new Float32Array([-10, 0, -5, 10, 4, -5, 10, 4, 5, -10, 0, 5, 30, 4, -5, 30, 4, 5]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 1, 2, 5, 1, 5, 4]),
  };
  const MODELS: Record<string, ModelGeometry> = { 'assets/models/rock.glb': box([-1, 0, -1], [1, 2, 1]), 'assets/models/ramp.glb': RAMP };
  const prefabs = [
    prefab('stone', { model: { model: 'assets/models/rock.glb' }, collider: { shape: 'convex' } }),
    prefab('ramp', { model: { model: 'assets/models/ramp.glb' }, collider: { shape: 'mesh', layer: 'ground' } }),
    prefab('lost', { model: { model: 'assets/models/missing.glb' }, collider: { shape: 'mesh' } }),
  ];

  function run(entities: Placement[], loaded: () => boolean = () => true): Started {
    const scene = sceneDoc('models', entities);
    const p = project([scene]);
    for (const extra of prefabs) (p.prefabs as Map<string, PrefabDoc>).set(extra.id, extra);
    const geometry: KernelPlugin = {
      id: 'geometry',
      install: (k) => k.provide(MODEL_GEOMETRY_SERVICE, {
        geometry: (ref) => (ref === 'assets/models/missing.glb' ? null : loaded() ? MODELS[ref] : undefined),
      }),
    };
    const plugin = nav({ cellSize: 0.25 });
    const g = game();
    const kernel = new Kernel({ project: p, game: { ...g, components: [...g.components, MODEL] }, plugins: [geometry, plugin], context: {} });
    kernel.start('models');
    const byPrefab = (id: string): EntityId[] => [...kernel.world.live()].filter((r) => r.prefab === id).map((r) => r.id);
    return { kernel, plugin, byPrefab };
  }

  it('a convex model is an obstacle: agents go around it and it blocks sight', () => {
    arrivals.length = 0;
    const { kernel, plugin, byPrefab } = run([
      place('floor', [0, 0, 0]), place('stone', [0, 0, 0], { scale: [2, 1, 2] }), place('walker', [-6, 0, 0]),
      place('marker', [-4, 1, 0]), place('marker', [4, 1, 0]),
    ]);
    const [walker] = byPrefab('walker');
    expect(agent(kernel, walker!).move_to(new Vec3(6, 0, 0))).toBe(true);
    for (let i = 0; i < 60 * 10 && arrivals.length === 0; i++) {
      kernel.step(1 / 60);
      const p = pos(kernel, walker!);
      // Scaled to 4 × 2 × 4: never inside it grown by the radius.
      expect(Math.max(Math.abs(p.x), Math.abs(p.z))).toBeGreaterThan(2 + 0.39);
    }
    expect(arrivals).toEqual([walker]);
    const [a, b] = byPrefab('marker');
    expect(plugin.queries().canSee(a!, b!, 360, 30)).toBe(false);
    expect(plugin.queries().unsupported()).toEqual([]);
  });

  it('a mesh ground is the ground: paths follow its height, with no implicit plane under it', () => {
    arrivals.length = 0;
    const { kernel, plugin, byPrefab } = run([place('ramp', [0, 0, 0]), place('walker', [-8, 0.4, 0])]);
    const path = plugin.queries().path(new Vec3(-8, 0.4, 0), new Vec3(25, 4, 0));
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]!.y).toBeCloseTo(4, 1);
    const [walker] = byPrefab('walker');
    agent(kernel, walker!).move_to(new Vec3(25, 4, 0));
    for (let i = 0; i < 60 * 15 && arrivals.length === 0; i++) {
      kernel.step(1 / 60);
      const p = pos(kernel, walker!);
      const ground = p.x < 10 ? ((p.x + 10) / 20) * 4 : 4;
      expect(Math.abs(p.y - ground)).toBeLessThan(0.1);
    }
    expect(arrivals).toEqual([walker]);
    // Off the model there is no ground at all (the model replaced the plane only where it is).
    expect(plugin.queries().reachable(new Vec3(-8, 0.4, 0), new Vec3(-8, 0, 20))).toBe(true);
  });

  it('waits for a loading model, and a model with no file (data-only) is no obstacle', () => {
    let loaded = false;
    const { kernel, plugin, byPrefab } = run([
      place('floor', [0, 0, 0]), place('stone', [0, 0, 0]), place('lost', [10, 0, 0]),
      place('marker', [-4, 1, 0]), place('marker', [4, 1, 0]),
    ], () => loaded);
    const [a, b] = byPrefab('marker');
    expect(plugin.queries().canSee(a!, b!, 360, 30)).toBe(true);
    loaded = true;
    kernel.step(1 / 60);
    expect(plugin.queries().canSee(a!, b!, 360, 30)).toBe(false);
    expect(plugin.queries().unsupported()).toEqual([]);
    expect(plugin.queries().reachable(new Vec3(8, 0, 0), new Vec3(12, 0, 0))).toBe(true);
  });
});
