import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, GameDefinition, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { FOLIAGE_SERVICE, MODEL_GEOMETRY_SERVICE, PHYSICS3D_SERVICE, PROCGEN_SERVICE, TERRAIN_SERVICE, VOXELS_SERVICE } from '../../services/index.js';
import type { FoliageLayer, GeneratedMesh, Physics3dService, TerrainField, VoxelChunkMesh, VoxelWorldView } from '../../services/index.js';
import { initPhysics3d, PHYSICS_EVENTS, physics3d, terrainMesh } from './index.js';
import { rapier } from './rapier.js';
import type { Physics3dNamespace, Physics3dOptions } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface Rigidbody extends Fields {
  get velocity(): Vec3;
  set velocity(value: Vec3);
  readonly speed: number;
  impulse(impulse: Vec3, options?: { at?: Vec3 }): void;
  force(force: Vec3): void;
  teleport(position: Vec3, options?: { rotation?: Vec3; keep_velocity?: boolean }): void;
}

export interface World3d {
  readonly kernel: Kernel;
  readonly physics: Physics3dNamespace;
  readonly service: Physics3dService;
  id(placed: string): EntityId;
  pos(placed: string): Vec3;
  body(placed: string): Rigidbody;
  steps(n: number): void;
}

function world(
  data: { prefabs: Record<string, unknown>; entities: unknown[] },
  options: Physics3dOptions = {},
  behaviors: BehaviorDef[] = [],
  extra: KernelPlugin[] = [],
): World3d {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const plugin = physics3d(options);
  const def: GameDefinition = { components: [], resources: [], events: [], behaviors, systems: [] };
  const kernel = new Kernel({ project, game: def, plugins: [plugin, ...extra], context: {}, fixedStep: DT });
  const physics = plugin.namespace!.create(kernel) as Physics3dNamespace;
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel,
    physics,
    service: kernel.service(PHYSICS3D_SERVICE),
    id,
    pos: (placed) => kernel.world.require(id(placed)).transform.position,
    body: (placed) => kernel.world.require(id(placed)).components.get('rigidbody') as Rigidbody,
    steps: (n) => {
      for (let i = 0; i < n; i++) kernel.step(DT);
    },
  };
}

function listener(id: string, log: Array<[string, EntityId, Fields]>, events: Record<string, EventDef>): BehaviorDef {
  return {
    id, params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([method, this['entity'] as EntityId, e]);
    }])) as LogicInstance,
  };
}

const BALL = { components: { rigidbody: {}, collider: { shape: 'sphere', radius: 0.5 } } };
const FLOOR = { components: { collider: { shape: 'box', size: [40, 1, 40], offset: [0, -0.5, 0] } } };

describe('gravity and stepping', () => {
  it('defaults to exactly -9.8 m/s² along y and applies nothing more', () => {
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [0, 50, 0] }] });
    expect(g.physics.gravity).toBe(-9.8);
    g.steps(60);
    expect(g.body('ball').velocity.y).toBeCloseTo(-9.8, 4);
    expect(g.body('ball').velocity.x).toBe(0);
    // Between explicit (n(n−1)/2) and semi-implicit (n(n+1)/2) Euler: ½·g·t² with nothing extra.
    expect(g.pos('ball').y).toBeLessThan(50 - 9.8 * DT * DT * 60 * 59 / 2);
    expect(g.pos('ball').y).toBeGreaterThan(50 - 9.8 * DT * DT * 60 * 61 / 2);
  });

  it('uses the configured gravity verbatim', () => {
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [0, 50, 0] }] }, { gravity: -40 });
    g.steps(30);
    expect(g.body('ball').velocity.y).toBeCloseTo(-20, 4);
  });

  it('lands a ball on a floor and keeps it there', () => {
    const g = world({ prefabs: { ball: BALL, floor: FLOOR }, entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3, 0] }] });
    g.steps(180);
    expect(g.pos('ball').y).toBeCloseTo(0.5, 2);
    expect(g.body('ball').speed).toBeLessThan(0.01);
  });

  it('is deterministic: two runs give identical transforms', () => {
    const run = (): number[] => {
      const g = world({
        prefabs: { ball: BALL, floor: FLOOR, box: { components: { rigidbody: { mass: 3 }, collider: { shape: 'box', size: [1, 1, 1] } } } },
        entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'a', at: [0, 3, 0] }, { prefab: 'box', id: 'b', at: [0.3, 5, 0.2], rotation: [10, 20, 30] }],
      });
      g.steps(120);
      return [...g.pos('a').toJSON(), ...g.pos('b').toJSON()];
    };
    expect(run()).toEqual(run());
  });
});

describe('rigidbody', () => {
  it('impulse, velocity and force act on dynamic bodies; impulse on a kinematic one refuses with a fix', () => {
    const g = world({
      prefabs: { ball: { components: { rigidbody: { mass: 2, gravity_scale: 0 }, collider: { shape: 'sphere' } } }, k: { components: { rigidbody: { kind: 'kinematic' }, collider: {} } } },
      entities: [{ prefab: 'ball', id: 'ball' }, { prefab: 'k', id: 'k', at: [10, 0, 0] }],
    });
    g.body('ball').impulse(new Vec3(4, 0, 0));
    expect(g.body('ball').velocity.x).toBeCloseTo(2);
    g.body('ball').velocity = new Vec3(0, 0, 3);
    expect(g.body('ball').speed).toBeCloseTo(3);
    g.body('ball').force(new Vec3(0, 120, 0));
    g.steps(1);
    expect(g.body('ball').velocity.y).toBeCloseTo(1); // F·dt/m = 120/60/2
    g.steps(1);
    expect(g.body('ball').velocity.y).toBeCloseTo(1); // force lasts one step
    expect(() => g.body('k').impulse(new Vec3(1, 0, 0))).toThrow(/PP3156/);
    expect(() => { g.body('ball').velocity = new Vec2(1, 0) as unknown as Vec3; }).toThrow(/PP3153.*Vec2/);
  });

  it('teleport moves body and transform now, with euler rotation, and clears velocity unless asked', () => {
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball' }] });
    g.body('ball').velocity = new Vec3(5, 0, 0);
    g.body('ball').teleport(new Vec3(1, 2, 3), { rotation: new Vec3(0, 90, 0) });
    expect(g.pos('ball').toJSON()).toEqual([1, 2, 3]);
    expect(g.body('ball').speed).toBe(0);
    const yaw = g.kernel.world.require(g.id('ball')).transform.rotation.to_euler().y;
    expect(yaw).toBeCloseTo(90);
    g.body('ball').velocity = new Vec3(5, 0, 0);
    g.body('ball').teleport(new Vec3(0, 0, 0), { keep_velocity: true });
    expect(g.body('ball').velocity.x).toBeCloseTo(5);
  });

  it('kinematic bodies follow their transform and push dynamic ones', () => {
    const g = world({
      prefabs: { floor: FLOOR, ball: BALL, pusher: { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'box', size: [1, 2, 1], offset: [0, 1, 0] } } } },
      entities: [{ prefab: 'floor' }, { prefab: 'pusher', id: 'p', at: [-2, 0, 0] }, { prefab: 'ball', id: 'ball', at: [0, 0.5, 0] }],
    });
    const p = g.kernel.world.require(g.id('p')).transform;
    for (let i = 0; i < 60; i++) {
      p.position = p.position.__add__(new Vec3(4 * DT, 0, 0));
      g.steps(1);
    }
    expect(g.pos('ball').x).toBeGreaterThan(2);
  });

  it('a kinematic body moves by its velocity and angular_velocity each step, and pushes dynamic ones', () => {
    const g = world({
      prefabs: { floor: FLOOR, ball: BALL, pusher: { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'box', size: [1, 2, 1], offset: [0, 1, 0] } } } },
      entities: [{ prefab: 'floor' }, { prefab: 'pusher', id: 'p', at: [-2, 0, 0] }, { prefab: 'ball', id: 'ball', at: [0, 0.5, 0] }],
    });
    g.body('p').velocity = new Vec3(4, 0, 0);
    expect(g.body('p').velocity.toJSON()).toEqual([4, 0, 0]);
    expect(g.body('p').speed).toBe(4);
    g.steps(30);
    expect(g.pos('p').x).toBeCloseTo(-2 + 4 * 30 * DT, 6);
    g.steps(30);
    expect(g.pos('ball').x).toBeGreaterThan(2);
    // A transform assignment still applies; velocity carries on from there.
    g.kernel.world.require(g.id('p')).transform.position = new Vec3(10, 0, 0);
    g.steps(1);
    expect(g.pos('p').x).toBeCloseTo(10 + 4 * DT, 6);

    const snap = g.kernel.snapshot();
    g.body('p').velocity = Vec3.ZERO;
    g.kernel.restore(snap);
    expect(g.body('p').velocity.toJSON()).toEqual([4, 0, 0]);

    g.body('p').teleport(new Vec3(0, 0, 5));
    expect(g.body('p').speed).toBe(0);
    g.body('p').angular_velocity = new Vec3(0, 90, 0);
    g.steps(60);
    expect(g.kernel.world.require(g.id('p')).transform.rotation.to_euler().y).toBeCloseTo(90, 3);
    expect(g.pos('p').toJSON()).toEqual([0, 0, 5]);
  });

  it('lock_axes holds translation axes; lock_rotation holds rotation', () => {
    const g = world({
      prefabs: { b: { components: { rigidbody: { lock_axes: ['y'], lock_rotation: true }, collider: { shape: 'box' } } } },
      entities: [{ prefab: 'b', id: 'b', at: [0, 5, 0] }],
    });
    g.body('b').impulse(new Vec3(1, 0, 0), { at: new Vec3(0, 5.5, 0.5) });
    g.steps(30);
    expect(g.pos('b').y).toBe(5);
    expect(g.pos('b').x).toBeGreaterThan(0);
    expect(g.kernel.world.require(g.id('b')).transform.rotation.is_close(Quat.IDENTITY)).toBe(true);
  });
});

describe('flat boards', () => {
  it('lock_axes ["y"] + lock_rotation_axes ["x", "z"]: slides and spins on the plane, never tips', () => {
    const g = world({
      prefabs: { puck: { components: { rigidbody: { gravity_scale: 0, lock_axes: ['y'], lock_rotation_axes: ['x', 'z'] }, collider: { shape: 'box' } } } },
      entities: [{ prefab: 'puck', id: 'p', at: [0, 1, 0] }],
    });
    // Off-center pushes that would roll and lift a free box.
    g.body('p').impulse(new Vec3(1, 1, 0), { at: new Vec3(0.3, 1.5, 0.5) });
    g.steps(30);
    expect(g.pos('p').y).toBe(1);
    expect(g.pos('p').x).toBeGreaterThan(0);
    const up = g.kernel.world.require(g.id('p')).transform.rotation.rotate(new Vec3(0, 1, 0));
    expect(up.y).toBeCloseTo(1, 6);
    expect(g.kernel.world.require(g.id('p')).transform.rotation.is_close(Quat.IDENTITY)).toBe(false);
  });
});

describe('colliders', () => {
  it('builds every primitive shape; a 3D game refuses "circle" with a fix', () => {
    const shapes = ['box', 'sphere', 'capsule', 'cylinder'];
    const g = world({
      prefabs: Object.fromEntries(shapes.map((s) => [s, { components: { collider: { shape: s, radius: 0.5, height: 2 } } }])),
      entities: shapes.map((s, i) => ({ prefab: s, id: s, at: [i * 5, 0, 0] })),
    });
    g.steps(1);
    for (const [i, s] of shapes.entries()) {
      const hit = g.physics.raycast(new Vec3(i * 5, 10, 0), new Vec3(0, -1, 0))!;
      expect(hit.entity, s).toBe(g.id(s));
    }
    // Box 1 m tall, capsule/cylinder 2 m tall around the origin, sphere radius 0.5.
    expect(g.physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))!.point.y).toBeCloseTo(0.5);
    expect(g.physics.raycast(new Vec3(10, 10, 0), new Vec3(0, -1, 0))!.point.y).toBeCloseTo(1);
    expect(() => world({ prefabs: { c: { components: { collider: { shape: 'circle' } } } }, entities: [{ prefab: 'c' }] }))
      .toThrow(/PP3155.*circle.*2D/);
  });

  it('scales shapes with the entity and validates capsules', () => {
    const g = world({ prefabs: { b: { components: { collider: { shape: 'box' } } } }, entities: [{ prefab: 'b', id: 'b', scale: [2, 4, 2] }] });
    g.steps(1);
    expect(g.physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))!.point.y).toBeCloseTo(2);
    expect(g.service.bounds(g.id('b'))!.halfExtents.toJSON()).toEqual([1, 2, 1]);
    expect(() => world({ prefabs: { c: { components: { collider: { shape: 'capsule', radius: 1, height: 1 } } } }, entities: [{ prefab: 'c' }] }))
      .toThrow(/PP3155.*capsule/);
  });

  it('mesh and convex colliders come from model geometry; waiting while it loads; PP3161 without a source', () => {
    const quad = { vertices: new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5, 0, 1, 0]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
    let loaded = false;
    const geometry: KernelPlugin = {
      id: 'geometry',
      install: (k) => k.provide(MODEL_GEOMETRY_SERVICE, { geometry: (path) => (loaded && path === 'assets/models/ground.glb' ? quad : undefined) }),
    };
    const ground = { components: { model: { model: 'assets/models/ground.glb' }, collider: { shape: 'mesh' } } };
    const rock = { components: { model: { model: 'assets/models/ground.glb' }, rigidbody: {}, collider: { shape: 'convex' } } };
    const data = { prefabs: { ground, rock }, entities: [{ prefab: 'ground', id: 'g' }, { prefab: 'rock', id: 'r', at: [20, 0, 0] }] };
    const project = loadProject(files({ 'prefabs/ground.prefab.json': ground, 'prefabs/rock.prefab.json': rock, 'scenes/main/scene.json': { entities: data.entities } }));
    const model = { id: 'model', schema: { model: { type: { kind: 'string' as const } }, offset: { type: { kind: 'vec3' as const }, default: Vec3.ZERO } } };
    const plugin = physics3d();
    const kernel = new Kernel({ project, game: { components: [model], resources: [], events: [], behaviors: [], systems: [] }, plugins: [plugin, geometry], context: {}, fixedStep: DT });
    const physics = plugin.namespace!.create(kernel) as Physics3dNamespace;
    kernel.start('main');
    kernel.step(DT);
    expect(physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))).toBeNull();
    loaded = true;
    kernel.step(DT);
    kernel.step(DT);
    const hit = physics.raycast(new Vec3(1, 10, 1), new Vec3(0, -1, 0))!;
    expect(hit.distance).toBeCloseTo(10);

    const without = new Kernel({ project, game: { components: [model], resources: [], events: [], behaviors: [], systems: [] }, plugins: [physics3d()], context: {}, fixedStep: DT });
    expect(() => without.start('main')).toThrow(/PP3161/);
  });

  it('a model with no file in a data-only run (geometry null) gives a collider with no shape', () => {
    const absent: KernelPlugin = { id: 'geometry', install: (k) => k.provide(MODEL_GEOMETRY_SERVICE, { geometry: () => null }) };
    const ground = { components: { model: { model: 'assets/models/ground.glb' }, collider: { shape: 'mesh' } } };
    const rock = { components: { model: { model: 'assets/models/rock.glb' }, rigidbody: {}, collider: { shape: 'convex' } } };
    const project = loadProject(files({
      'prefabs/ground.prefab.json': ground, 'prefabs/rock.prefab.json': rock,
      'scenes/main/scene.json': { entities: [{ prefab: 'ground', id: 'g' }, { prefab: 'rock', id: 'r', at: [0, 5, 0] }] },
    }));
    const model = { id: 'model', schema: { model: { type: { kind: 'string' as const } }, offset: { type: { kind: 'vec3' as const }, default: Vec3.ZERO } } };
    const plugin = physics3d();
    const kernel = new Kernel({ project, game: { components: [model], resources: [], events: [], behaviors: [], systems: [] }, plugins: [plugin, absent], context: {}, fixedStep: DT });
    const physics = plugin.namespace!.create(kernel) as Physics3dNamespace;
    const service = kernel.service(PHYSICS3D_SERVICE);
    kernel.start('main');
    for (let i = 0; i < 30; i++) kernel.step(DT);
    const r = [...kernel.world.live()].find((rec) => rec.placedId === 'r')!;
    // The rock falls (its body has its Rigidbody's mass, no shape) and passes the ground.
    expect(r.transform.position.y).toBeLessThan(5 - 0.5 * 9.8 * 0.25);
    expect(service.body(r.id)!.mass).toBeCloseTo(1);
    expect(service.bounds(r.id)).toBeUndefined();
    expect(physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))).toBeNull();
  });
});

describe('queries', () => {
  const data = {
    prefabs: {
      wall: { components: { collider: { shape: 'box', size: [1, 4, 4], layer: 'wall' } } },
      foe: { components: { collider: { shape: 'sphere', layer: 'foe' } } },
      zone: { components: { collider: { shape: 'sphere', radius: 2, trigger: true } } },
    },
    entities: [{ prefab: 'wall', id: 'wall', at: [5, 0, 0] }, { prefab: 'foe', id: 'foe', at: [10, 0, 0] }, { prefab: 'zone', id: 'zone', at: [2, 0, 0] }],
  };

  it('raycast finds the nearest solid, skips triggers, filters layers and ignores', () => {
    const g = world(data, { layers: ['wall', 'foe'] });
    g.steps(1);
    const hit = g.physics.raycast(Vec3.ZERO, new Vec3(1, 0, 0))!;
    expect(hit.entity).toBe(g.id('wall'));
    expect(hit.distance).toBeCloseTo(4.5);
    expect(hit.normal.toJSON()).toEqual([-1, 0, 0]);
    expect(g.physics.raycast(Vec3.ZERO, new Vec3(1, 0, 0), 1000, { layers: ['foe'] })!.entity).toBe(g.id('foe'));
    expect(g.physics.raycast(Vec3.ZERO, new Vec3(1, 0, 0), 1000, { ignore: [g.id('wall')] })!.entity).toBe(g.id('foe'));
    expect(g.physics.raycast(Vec3.ZERO, new Vec3(1, 0, 0), 3)).toBeNull();
    expect(g.physics.raycast_all(Vec3.ZERO, new Vec3(1, 0, 0)).map((h) => h.entity)).toEqual([g.id('wall'), g.id('foe')]);
    expect(() => g.physics.raycast(Vec3.ZERO, Vec3.ZERO)).toThrow(/PP3158/);
    expect(() => g.physics.raycast(Vec3.ZERO, new Vec3(1, 0, 0), 1000, { layers: ['wal'] })).toThrow(/PP3152[\s\S]*Did you mean "wall"/);
  });

  it('overlap and overlap_box include triggers; explode pushes dynamic bodies away', () => {
    const g = world(data, { layers: ['wall', 'foe'] });
    g.steps(1);
    expect(g.physics.overlap(new Vec3(3, 0, 0), 1)).toEqual([g.id('zone')]);
    expect(g.physics.overlap_box(new Vec3(5.5, 0, 0), new Vec3(1, 1, 1))).toEqual([g.id('wall')]);
    const b = world({ prefabs: { ball: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'sphere' } } } }, entities: [{ prefab: 'ball', id: 'b', at: [0, 0, 2] }] });
    b.steps(1);
    expect(b.physics.explode(Vec3.ZERO, 4, 10)).toEqual([b.id('b')]);
    expect(b.body('b').velocity.z).toBeCloseTo(5); // impulse 10·(1 − 2/4) on 1 kg
  });
});

describe('events', () => {
  it('collided once per entity pair, then collision_ended, with SDK payloads', () => {
    const log: Array<[string, EntityId, Fields]> = [];
    const watch = listener('watch', log, { collided: PHYSICS_EVENTS.collided, ended: PHYSICS_EVENTS.collisionEnded });
    const g = world({
      prefabs: { floor: { ...FLOOR, behaviors: { watch: {} } }, ball: { components: { rigidbody: {}, collider: { shape: 'sphere', bounce: 0.9 } }, behaviors: { watch: {} } } },
      entities: [{ prefab: 'floor', id: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 2, 0] }],
    }, {}, [watch]);
    g.steps(40);
    const hits = log.filter(([m]) => m === 'collided');
    expect(hits.length).toBe(2);
    const ballSide = hits.find(([, e]) => e === g.id('ball'))![2];
    expect(ballSide['target']).toBe(g.id('floor'));
    expect((ballSide['normal'] as Vec3).y).toBeCloseTo(1, 1); // pushes the ball up
    expect(ballSide['impulse']).toBeGreaterThan(0);
    g.steps(20);
    expect(log.filter(([m]) => m === 'ended').length).toBe(2); // it bounced off
  });

  it('trigger_entered / trigger_exited for kinematic and static colliders', () => {
    const log: Array<[string, EntityId, Fields]> = [];
    const watch = listener('watch', log, { entered: PHYSICS_EVENTS.triggerEntered, exited: PHYSICS_EVENTS.triggerExited });
    const g = world({
      prefabs: { zone: { components: { collider: { shape: 'box', size: [2, 2, 2], trigger: true } }, behaviors: { watch: {} } }, mover: { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'sphere', radius: 0.25 } } } },
      entities: [{ prefab: 'zone', id: 'zone' }, { prefab: 'mover', id: 'm', at: [-3, 0, 0] }],
    }, {}, [watch]);
    const t = g.kernel.world.require(g.id('m')).transform;
    for (let i = 0; i < 120; i++) {
      t.position = new Vec3(-3 + i * 0.05, 0, 0);
      g.steps(1);
    }
    expect(log.map(([m, e, p]) => [m, e, p['target']])).toEqual([['entered', g.id('zone'), g.id('m')], ['exited', g.id('zone'), g.id('m')]]);
  });
});

describe('terrain', () => {
  const field = (version: number): TerrainField => {
    const columns = 3;
    const rows = 3;
    const heights = new Float32Array([0, 0, 0, 0, 2, 0, 0, 0, 0]);
    return {
      version, scene: 'main', width: 20, depth: 20, minX: -10, minZ: -10, columns, rows, cellX: 10, cellZ: 10, heights,
      normals: new Float32Array(27), minHeight: 0, maxHeight: 2, waterLevel: null, layers: [], weights: new Float32Array(0),
      chunkQuads: 2, chunks: [],
      contains: () => true, heightAt: () => 0, normalAt: () => Vec3.UP, surfaceAt: () => '', ground: (p) => p,
      revision: 0, holes: null, brush: [], paths: [], weightAt: () => 0, holeAt: () => false, brushAt: () => null, splatAt: () => undefined,
      reliefAt: () => 0, deformationAt: () => 0, revisionIn: () => 0,
    };
  };

  it('splits quads exactly as the terrain service documents, facing up', () => {
    const { indices, vertices } = terrainMesh(field(1));
    expect([...indices.slice(0, 6)]).toEqual([0, 4, 1, 0, 3, 4]);
    const v = (i: number): Vec3 => new Vec3(vertices[i * 3]!, vertices[i * 3 + 1]!, vertices[i * 3 + 2]!);
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [v(indices[t]!), v(indices[t + 1]!), v(indices[t + 2]!)];
      expect(b.__sub__(a).cross(c.__sub__(a)).y).toBeGreaterThan(0);
    }
  });

  it('collides with the terrain field and rebuilds it when its version changes', () => {
    let current: TerrainField | null = field(1);
    const terrain: KernelPlugin = { id: 'terrain', install: (k) => k.provide(TERRAIN_SERVICE, { current: () => current, tiles: () => null, splatMap: () => null, deform: () => undefined, edits: () => [], prebake: () => Promise.resolve() }) };
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [-15, 5, -15] }] }, {}, [], [terrain]);
    g.steps(1);
    // Quad (1,1) spans x, z in [0, 10] with its high corner (0, 2, 0). Where fx >= fz the
    // documented split gives the plane through (0,2,0), (10,0,0), (10,0,10): y = 2 − x/5.
    // The other diagonal would give y = 2 − x/5 − z/5 = 0 there.
    const a = g.physics.raycast(new Vec3(6, 10, 4), new Vec3(0, -1, 0))!;
    expect(a.point.y).toBeCloseTo(0.8, 4);
    expect(a.entity).toBeNull();
    expect(g.physics.raycast(new Vec3(4, 10, 6), new Vec3(0, -1, 0))!.point.y).toBeCloseTo(0.8, 4);
    current = null;
    g.steps(1);
    expect(g.physics.raycast(new Vec3(6, 10, 4), new Vec3(0, -1, 0))).toBeNull();
  });
});

describe('terrain chunks, holes and foliage', () => {
  /** A flat 4×4-quad field at height 0 in two 2×4 chunks, 1 m cells over x, z in [-2, 2]. */
  const flat = (revisions: [number, number], holes: Uint8Array | null, heights = new Float32Array(25)): TerrainField => ({
    version: 1, revision: Math.max(...revisions), scene: 'main', width: 4, depth: 4, minX: -2, minZ: -2, columns: 5, rows: 5, cellX: 1, cellZ: 1,
    heights, normals: new Float32Array(75), minHeight: 0, maxHeight: 0, waterLevel: null, layers: [], weights: new Float32Array(0), chunkQuads: 2,
    chunks: [
      { column: 0, row: 0, columns: 2, rows: 4, minHeight: 0, maxHeight: 0, revision: revisions[0] },
      { column: 2, row: 0, columns: 2, rows: 4, minHeight: 0, maxHeight: 0, revision: revisions[1] },
    ],
    contains: () => true, heightAt: () => 0, normalAt: () => Vec3.UP, surfaceAt: () => '', ground: (p) => p,
    holes, brush: [], paths: [], weightAt: () => 0, holeAt: () => false, brushAt: () => null, splatAt: () => undefined,
    reliefAt: () => 0, deformationAt: () => 0, revisionIn: () => 0,
  });
  const provide = (get: () => TerrainField): KernelPlugin => ({
    id: 'terrain', install: (k) => k.provide(TERRAIN_SERVICE, { current: get, tiles: () => null, splatMap: () => null, deform: () => undefined, edits: () => [], prebake: () => Promise.resolve() }),
  });
  const down = (g: World3d, x: number, z: number): number | null => g.physics.raycast(new Vec3(x, 20, z), new Vec3(0, -1, 0))?.point.y ?? null;

  it('leaves hole quads out of the collider', () => {
    const holes = new Uint8Array(16);
    holes[1 * 4 + 1] = 1; // quad (c=1, r=1): x, z in [-1, 0]
    const current = flat([0, 0], holes);
    const g = world({ prefabs: {}, entities: [] }, {}, [], [provide(() => current)]);
    g.steps(1);
    expect(down(g, -0.5, -0.5)).toBeNull();
    expect(down(g, 0.5, -0.5)).toBeCloseTo(0, 5);
    expect(down(g, -1.5, -0.5)).toBeCloseTo(0, 5);
  });

  it('rebuilds a chunk whose revision changed (deformation), not only on a new version', () => {
    const heights = new Float32Array(25);
    let current = flat([0, 0], null, heights);
    const g = world({ prefabs: {}, entities: [] }, {}, [], [provide(() => current)]);
    g.steps(1);
    expect(down(g, 1, 1)).toBeCloseTo(0, 5);
    // A crater in the second chunk lowers vertex (3, 3) — the field changes in place.
    heights[3 * 5 + 3] = -1;
    current = flat([0, 1], null, heights);
    g.steps(1);
    expect(down(g, 1, 1)).toBeCloseTo(-1, 4);
    // A hole bumps a chunk's revision too.
    const holes = new Uint8Array(16);
    holes[3 * 4 + 0] = 1;
    current = flat([2, 1], holes, heights);
    g.steps(1);
    expect(down(g, -1.5, 1.5)).toBeNull();
  });

  it('gives foliage layers that collide a static cylinder per standing instance, rebuilt on revision', () => {
    let revision = 1;
    const alive = new Uint8Array([1, 1]);
    const layer = (collide: boolean, id: string): FoliageLayer => ({
      id, kind: 'tree', species: 'pine', model: null, color: [0, 0, 0], sway: 0, collide, radius: 0.5, height: 4, count: 2,
      x: new Float32Array([0, 5]), y: new Float32Array([0, 0]), z: new Float32Array([0, 0]), yaw: new Float32Array(2), scale: new Float32Array([1, 2]), alive,
      cells: [],
    });
    const layers = [layer(true, 'trees'), { ...layer(false, 'ferns'), x: new Float32Array([-5, -5]) }];
    const foliage: KernelPlugin = {
      id: 'foliage',
      install: (k) => k.provide(FOLIAGE_SERVICE, {
        layers: () => layers, grass: () => [], get revision() { return revision; }, near: () => [], remove: () => undefined,
      }),
    };
    const g = world({ prefabs: {}, entities: [] }, {}, [], [foliage]);
    g.steps(1);
    expect(down(g, 0, 0)).toBeCloseTo(4, 4);
    expect(down(g, 5, 0)).toBeCloseTo(8, 4); // scale 2: twice as tall
    expect(down(g, 5.9, 0)).not.toBeNull(); // and twice as wide
    expect(down(g, -5, 0)).toBeNull(); // ferns don't collide
    alive[0] = 0;
    revision = 2;
    g.steps(1);
    expect(down(g, 0, 0)).toBeNull();
    expect(down(g, 5, 0)).toBeCloseTo(8, 4);
  });
});

describe('generated scenery (procgen)', () => {
  it('one fixed collider per generated mesh: rebuilt on collisionVersion, dropped with its key; hits name its entity', () => {
    const quad = (y: number) => ({ vertices: new Float32Array([-5, y, -5, -5, y, 5, 5, y, 5, 5, y, -5]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
    let meshes: GeneratedMesh[] = [];
    const procgen: KernelPlugin = {
      id: 'procgen', install: (k) => k.provide(PROCGEN_SERVICE, { revision: 0, meshes: () => meshes, path: () => undefined, paths: () => [] }),
    };
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'owner', at: [20, 0, 20] }] }, {}, [], [procgen]);
    const owner = g.id('owner');
    const mesh = (y: number, version: number): GeneratedMesh => ({
      key: `structure:${owner}`, entity: owner, version, parts: [], world: new Float32Array(16), collision: quad(y), collisionVersion: version,
    });
    meshes = [mesh(1, 1)];
    g.steps(1);
    const hit = g.physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))!;
    expect(hit.point.y).toBeCloseTo(1, 5);
    expect(hit.entity).toBe(g.kernel.handles.wrap(owner));
    meshes = [mesh(3, 2)];
    g.steps(1);
    expect(g.physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))!.point.y).toBeCloseTo(3, 5);
    meshes = [];
    g.steps(1);
    expect(g.physics.raycast(new Vec3(0, 10, 0), new Vec3(0, -1, 0))).toBeNull();
  });
});

describe('mount seat rotation', () => {
  it('keeps the rider turned by the seat rotation as the carrier turns, through a snapshot', () => {
    const cart = { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'box', size: [2, 1, 2] } } };
    const g = world({ prefabs: { ball: BALL, cart }, entities: [{ prefab: 'cart', id: 'cart', at: [0, 0, 0] }, { prefab: 'ball', id: 'rider', at: [5, 0, 0] }] });
    const back = Quat.from_euler(new Vec3(0, 180, 0));
    g.service.mount(g.id('rider'), g.id('cart'), new Vec3(0, 1, 0), back);
    const cartT = g.kernel.world.require(g.id('cart')).transform;
    cartT.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    g.steps(2);
    const rider = (): Quat => g.kernel.world.require(g.id('rider')).transform.worldRotation();
    expect(rider().is_close(Quat.from_euler(new Vec3(0, 270, 0)), 1e-6)).toBe(true);
    expect(g.service.mountOf(g.id('rider'))!.rotation.is_close(back, 1e-12)).toBe(true);
    const snap = g.kernel.snapshot();
    g.kernel.restore(snap);
    g.steps(1);
    expect(rider().is_close(Quat.from_euler(new Vec3(0, 270, 0)), 1e-6)).toBe(true);
    // Without a rotation the rider takes the carrier's.
    g.service.mount(g.id('rider'), g.id('cart'), new Vec3(0, 1, 0));
    g.steps(1);
    expect(rider().is_close(cartT.worldRotation(), 1e-6)).toBe(true);
  });
});

describe('voxels', () => {
  /** A chunk whose collision is one upward quad at height `y` over x, z in [x0, x0 + 16). */
  const chunk = (cx: number, version: number, y: number): VoxelChunkMesh => {
    const x0 = cx * 16;
    const none = { positions: new Float32Array(), normals: new Float32Array(), uvs: new Float32Array(), blocks: new Uint16Array(), indices: new Uint32Array() };
    return {
      key: `${cx},0,0`, cx, cy: 0, cz: 0, version, opaque: none, transparent: none,
      collision: { vertices: new Float32Array([x0, y, 0, x0, y, 16, x0 + 16, y, 16, x0 + 16, y, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
    };
  };

  it('one fixed collider per active chunk: rebuilt on a chunk version, dropped when it leaves, all dropped on a new world', () => {
    let worldVersion = 1;
    let chunks: VoxelChunkMesh[] = [chunk(0, 1, 2), chunk(1, 1, 2)];
    let present = true;
    const view = (): VoxelWorldView => ({
      version: worldVersion, scene: 'main', mode: 'blocks', chunkSize: 16, yMin: 0, yMax: 16, renderDistance: 4, saveEdits: false, densityAt: () => 0,
      blocks: () => [], blockAt: () => 0, isSolid: () => false, active: () => chunks, exportEdits: () => ({}), loadEdits: () => {},
    });
    const voxels: KernelPlugin = { id: 'voxels', install: (k) => k.provide(VOXELS_SERVICE, { current: () => (present ? view() : null) }) };
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [8, 6, 8] }] }, {}, [], [voxels]);
    const down = (x: number): number | undefined => g.physics.raycast(new Vec3(x, 20, 2), new Vec3(0, -1, 0), 1000, { ignore: [g.id('ball')] })?.point.y;
    g.steps(1);
    const hit = g.physics.raycast(new Vec3(20, 20, 8), new Vec3(0, -1, 0))!;
    expect(hit.point.y).toBeCloseTo(2);
    expect(hit.entity).toBeNull();
    expect(hit.normal.y).toBeCloseTo(1);
    g.steps(90);
    expect(g.pos('ball').y).toBeCloseTo(2.5, 1);

    chunks = [chunk(0, 2, 3), chunk(1, 1, 2)];
    g.steps(1);
    expect(down(8)).toBeCloseTo(3);
    expect(down(20)).toBeCloseTo(2);
    chunks = [chunk(0, 2, 3)];
    g.steps(1);
    expect(down(20)).toBeUndefined();
    // A new build of the world: every chunk is rebuilt, even at an unchanged chunk version.
    worldVersion = 2;
    chunks = [chunk(0, 2, 5)];
    g.steps(1);
    expect(down(8)).toBeCloseTo(5);
    present = false;
    g.steps(1);
    expect(down(8)).toBeUndefined();
  });
});

describe('dispose', () => {
  it("kernel.dispose() frees the Rapier world and its event queue; a second runtime runs", () => {
    const worldFree = vi.spyOn(rapier().World.prototype, 'free');
    const queueFree = vi.spyOn(rapier().EventQueue.prototype, 'free');
    try {
      const first = world({ prefabs: { ball: BALL, floor: FLOOR }, entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3, 0] }] });
      first.steps(10);
      first.kernel.dispose();
      expect(worldFree).toHaveBeenCalledTimes(1);
      expect(queueFree).toHaveBeenCalledTimes(1);
      expect(() => first.kernel.step(DT)).toThrow(/PP9007/);
      const second = world({ prefabs: { ball: BALL, floor: FLOOR }, entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3, 0] }] });
      second.steps(120);
      expect(second.pos('ball').y).toBeCloseTo(0.5, 1);
    } finally {
      worldFree.mockRestore();
      queueFree.mockRestore();
    }
  });
});

describe('snapshot / restore', () => {
  it('puts velocities back on rebuilt bodies', () => {
    const g = world({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [0, 10, 0] }] });
    g.steps(30);
    const snap = g.kernel.snapshot();
    const v = g.body('ball').velocity.y;
    const y = g.pos('ball').y;
    g.steps(30);
    g.kernel.restore(snap);
    expect(g.pos('ball').y).toBeCloseTo(y);
    expect(g.body('ball').velocity.y).toBeCloseTo(v);
    g.steps(1);
    expect(g.body('ball').velocity.y).toBeCloseTo(v - 9.8 * DT, 4);
  });

  it('a resting stack stays at rest after a restore, within the bound of the unsaved solver warm-start', () => {
    // Rapier's contact warm-start (accumulated impulses) is solver-internal and not saved: the
    // first steps after a restore re-converge from zero (measured: the top box settles ~3e-4 m
    // lower over two seconds, every box under 3e-5 m/s). The bound: a settled stack keeps under
    // 1e-4 m/s and within 1e-3 m of the uninterrupted run, and restored runs agree exactly.
    // Exact restores would need Rapier's own world snapshot (binary, tied to the Rapier
    // version and to body handles), which saves and net snapshots can't carry.
    const box = { components: { rigidbody: { mass: 10 }, collider: { shape: 'box', size: [1, 1, 1] } } };
    const g = world({ prefabs: { floor: FLOOR, box }, entities: [
      { prefab: 'floor' }, { prefab: 'box', id: 'a', at: [0, 0.5, 0] }, { prefab: 'box', id: 'b', at: [0, 1.5, 0] }, { prefab: 'box', id: 'c', at: [0, 2.5, 0] },
    ] });
    g.steps(240);
    const snap = g.kernel.snapshot();
    const run = (): number[] => {
      g.steps(120);
      return ['a', 'b', 'c'].flatMap((id) => [...g.pos(id).toJSON(), g.body(id).velocity.length()]);
    };
    const uninterrupted = run();
    g.kernel.restore(snap);
    const restored = run();
    g.kernel.restore(snap);
    expect(run()).toEqual(restored);
    uninterrupted.forEach((v, i) => expect(Math.abs(v - restored[i]!)).toBeLessThan(1e-3));
    for (const id of ['a', 'b', 'c']) expect(g.body(id).velocity.length()).toBeLessThan(1e-4);
  });
});
