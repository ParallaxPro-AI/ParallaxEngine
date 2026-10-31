/**
 * physics2d's depth: joints (measured), force fields, surface materials, shape casts,
 * render interpolation and the physics2d service (network-driven bodies).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, GameDefinition, LogicInstance } from '../../kernel/index.js';
import { PHYSICS2D_SERVICE, RENDER_POSE_SERVICE } from '../../services/index.js';
import { IMPACT, initPhysics2d, JOINT_BROKEN, physics2d } from './index.js';
import type { Physics2dOptions, PhysicsNamespace } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics2d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface Joint extends Fields {
  readonly angle: number | null;
  readonly position: number | null;
  readonly distance: number | null;
  readonly load: number;
  detach(): void;
}

interface Game {
  readonly kernel: Kernel;
  readonly physics: PhysicsNamespace;
  id(placed: string): EntityId;
  pos(placed: string): Vec3;
  angle(placed: string): number;
  get<T extends Fields>(placed: string, component: string): T;
  steps(n: number): void;
}

function game(data: { prefabs: Record<string, unknown>; entities: unknown[] }, options: Physics2dOptions = {}, behaviors: BehaviorDef[] = []): Game {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const plugin = physics2d(options);
  const def: GameDefinition = { components: [], resources: [], events: [], behaviors, systems: [] };
  const kernel = new Kernel({ project, game: def, plugins: [plugin], context: {}, fixedStep: DT });
  const physics = plugin.namespace!.create(kernel) as PhysicsNamespace;
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel, physics, id,
    pos: (placed) => kernel.world.require(id(placed)).transform.worldPosition(),
    angle: (placed) => kernel.world.require(id(placed)).transform.worldRotation().angle(),
    get: <T extends Fields>(placed: string, component: string) => kernel.world.require(id(placed)).components.get(component) as T,
    steps: (n) => {
      for (let i = 0; i < n; i++) kernel.step(DT);
    },
  };
}

function listener(id: string, log: Fields[], events: Record<string, EventDef>): BehaviorDef {
  return {
    id, params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push({ method, ...e });
    }])) as LogicInstance,
  };
}

const BOB = { components: { rigidbody: { mass: 1 }, collider: { shape: 'circle', radius: 0.05 } } };
const FLOOR = { components: { collider: { shape: 'box', size: [40, 1, 1], offset: [0, -0.5, 0] } } };

describe('2D joints', () => {
  it('a hinge pendulum swings with the right period', () => {
    const L = 2;
    const theta = 10 * Math.PI / 180;
    const g = game({
      prefabs: { bob: BOB },
      entities: [{ prefab: 'bob', id: 'bob', at: [L * Math.sin(theta), 5 - L * Math.cos(theta)], components: { joint: { kind: 'hinge', anchor: [-L * Math.sin(theta), L * Math.cos(theta), 0] } } }],
    });
    const times: number[] = [];
    let previous = g.pos('bob').x;
    for (let i = 1; i <= 60 * 8; i++) {
      g.steps(1);
      const x = g.pos('bob').x;
      if (previous < 0 && x >= 0) times.push((i - 1 + -previous / (x - previous)) * DT);
      previous = x;
    }
    const expected = 2 * Math.PI * Math.sqrt((L * L + 0.5 * 0.05 * 0.05) / (9.8 * L)) * (1 + theta * theta / 16);
    for (let i = 1; i < times.length; i++) expect(Math.abs(times[i]! - times[i - 1]! - expected) / expected).toBeLessThan(0.01);
    expect(times.length).toBeGreaterThanOrEqual(2);
  });

  it('a hinge stops at its limits; a slider moves along its axis within its limits; zero is the built pose', () => {
    const g = game({
      prefabs: { bar: { components: { rigidbody: {}, collider: { shape: 'box', size: [1, 0.1, 1] } } }, box: { components: { rigidbody: {}, collider: { shape: 'box', size: [0.5, 0.5, 1] } } } },
      entities: [
        { prefab: 'bar', id: 'bar', at: [0.5, 3], rotation: 20, components: { joint: { kind: 'hinge', anchor: [-0.5, 0, 0], limits: [-30, 45] } } },
        { prefab: 'box', id: 'box', at: [5, 4], rotation: 30, components: { joint: { kind: 'slider', axis: [0, 1, 0], limits: [-1.5, 0] } } },
      ],
    });
    expect(g.get<Joint>('bar', 'joint').angle).toBeCloseTo(0, 6);
    g.steps(180);
    expect(g.get<Joint>('bar', 'joint').angle!).toBeGreaterThan(-31);
    expect(g.get<Joint>('bar', 'joint').angle!).toBeLessThan(-28);
    expect(g.angle('bar')).toBeCloseTo(20 + g.get<Joint>('bar', 'joint').angle!, 1);
    expect(g.get<Joint>('box', 'joint').position!).toBeCloseTo(-1.5, 2);
    const a = 30 * Math.PI / 180;
    const moved = g.pos('box').__sub__(new Vec3(5, 4, 0));
    expect(moved.x).toBeCloseTo(1.5 * Math.sin(a), 2);
    expect(moved.y).toBeCloseTo(-1.5 * Math.cos(a), 2);
  });

  it('motors: speed, servo and a capped effort', () => {
    const g = game({
      prefabs: {
        wheel: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'circle', radius: 0.5 } } },
        arm: { components: { rigidbody: { angular_damping: 3 }, collider: { shape: 'box', size: [1, 0.1, 1] } } },
      },
      entities: [
        { prefab: 'wheel', id: 'spin', components: { joint: { kind: 'hinge', motor_speed: 90 } } },
        { prefab: 'wheel', id: 'servo', at: [5, 0], components: { joint: { kind: 'hinge', motor_target: -60, motor_speed: 180 } } },
        { prefab: 'arm', id: 'weak', at: [10.5, 0], components: { joint: { kind: 'hinge', anchor: [-0.5, 0, 0], motor_target: 0, motor_max_force: 2 } } },
      ],
    });
    g.steps(240);
    expect((g.get<Fields>('spin', 'rigidbody')['angular_velocity'] as Vec3).z).toBeCloseTo(90, 0);
    expect(g.get<Joint>('servo', 'joint').angle!).toBeCloseTo(-60, 0);
    expect(g.get<Joint>('weak', 'joint').angle!).toBeCloseTo(-Math.acos(2 / 4.9) * 180 / Math.PI, -1);
  });

  it('a rope holds at its length; a spring has the period of its stiffness and mass', () => {
    const g = game({
      prefabs: { bob: BOB, weight: { components: { rigidbody: { mass: 4, gravity_scale: 0 }, collider: { shape: 'circle', radius: 0.1 } } } },
      entities: [
        { prefab: 'bob', id: 'bob', at: [1, 5], components: { joint: { kind: 'rope', connected_anchor: [0, 5, 0], length: 2 } } },
        { prefab: 'weight', id: 'w', at: [11.5, 3], components: { joint: { kind: 'spring', connected_anchor: [10, 3, 0], length: 1, stiffness: 100, damping: 0 } } },
      ],
    });
    let longest = 0;
    const times: number[] = [];
    let previous = -(g.pos('w').x - 11);
    for (let i = 1; i <= 240; i++) {
      g.steps(1);
      longest = Math.max(longest, g.pos('bob').distance_to(new Vec3(0, 5, 0)));
      const x = -(g.pos('w').x - 11);
      if (previous < 0 && x >= 0) times.push(i * DT);
      previous = x;
    }
    expect(longest).toBeLessThan(2.02);
    expect(longest).toBeGreaterThan(1.98);
    expect((times[times.length - 1]! - times[0]!) / (times.length - 1)).toBeCloseTo(2 * Math.PI * Math.sqrt(4 / 100), 1);
  });

  it('breaks under load with an event; "ball" is refused with a fix', () => {
    const log: Fields[] = [];
    const g = game({
      prefabs: { crate: { components: { rigidbody: { mass: 2 }, collider: { shape: 'box', size: [0.4, 0.4, 1] } }, behaviors: { watch: {} } } },
      entities: [{ prefab: 'crate', id: 'crate', at: [0, 3], components: { joint: { kind: 'hinge', anchor: [0, 0.2, 0], break_force: 30 } } }],
    }, {}, [listener('watch', log, { broke: JOINT_BROKEN })]);
    g.steps(30);
    expect(g.get<Joint>('crate', 'joint').load).toBeCloseTo(19.6, 0);
    g.get<Fields & { force(f: Vec2): void }>('crate', 'rigidbody').force(new Vec2(0, -200));
    g.steps(1);
    expect(g.get<Joint>('crate', 'joint')['broken']).toBe(true);
    expect(log).toHaveLength(1);
    expect(() => game({ prefabs: { bob: BOB }, entities: [{ prefab: 'bob', components: { joint: { kind: 'ball' } } }] }).steps(1)).toThrow(/PP3187/);
  });

  it('a hinge between bodies at different angles keeps both angles', () => {
    const g = game({
      prefabs: {
        base: { components: { rigidbody: { lock_axes: ['x', 'y'], lock_rotation: true }, collider: { shape: 'box', size: [1, 0.2, 1] } } },
        arm: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'box', size: [0.1, 1, 1] } } },
      },
      entities: [
        { prefab: 'base', id: 'base', at: [0, 3] },
        { prefab: 'arm', id: 'arm', at: [0, 2.5], rotation: 50, components: { joint: { kind: 'hinge', connected: 'base', anchor: [0, 0.5, 0], limits: [-10, 10] } } },
      ],
    });
    g.steps(30);
    expect(g.angle('arm')).toBeCloseTo(50, 3);
    expect(g.get<Joint>('arm', 'joint').angle).toBeCloseTo(0, 3);
  });
});

describe('2D fields, materials and casts', () => {
  it('an updraft trigger cancels gravity inside it; a vortex swirls counter-clockwise', () => {
    const g = game({
      prefabs: {
        ball: { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.2 } } },
        float: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'circle', radius: 0.2 } } },
        thermal: { components: { collider: { shape: 'box', size: [2, 10, 1], trigger: true }, force_field: { strength: 9.8 } } },
        vortex: { components: { force_field: { kind: 'vortex', strength: 3, radius: 5 } } },
      },
      entities: [{ prefab: 'thermal', at: [0, 5] }, { prefab: 'ball', id: 'in', at: [0, 5] }, { prefab: 'vortex', at: [20, 0] }, { prefab: 'float', id: 'v', at: [22, 0] }],
    });
    g.steps(2);
    const v = g.get<Fields & { velocity: Vec3 }>('in', 'rigidbody').velocity.y;
    g.steps(30);
    expect(g.get<Fields & { velocity: Vec3 }>('in', 'rigidbody').velocity.y).toBeCloseTo(v, 6);
    expect(g.pos('v').y).toBeGreaterThan(0.3);
  });

  it('materials set friction and bounce and raise impacts', () => {
    const log: Fields[] = [];
    const g = game({
      prefabs: {
        floor: { components: { collider: { shape: 'box', size: [40, 1, 1], offset: [0, -0.5, 0], material: 'stone' } } },
        ball: { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.25, material: 'rubber' } }, behaviors: { watch: {} } },
      },
      entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3] }],
    }, {
      materials: { rubber: { friction: 1, bounce: 0.9, sound: 'sfx/boing', impact_speed: 1 }, stone: { friction: 0.8, bounce: 0, sound: null, impact_speed: 1 } },
    }, [listener('watch', log, { impact: IMPACT })]);
    g.steps(60);
    expect(log[0]!['sound']).toBe('sfx/boing');
    expect(log[0]!['target_material']).toBe('stone');
    expect(log[0]!['speed'] as number).toBeCloseTo(Math.sqrt(2 * 9.8 * 2.75), 0);
  });

  it('circle, box and capsule casts and sweeps', () => {
    const g = game({
      prefabs: { floor: FLOOR, wall: { components: { collider: { shape: 'box', size: [1, 4, 1] } } }, crate: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'box', size: [1, 1, 1] } } } },
      entities: [{ prefab: 'floor' }, { prefab: 'wall', id: 'wall', at: [5, 2] }, { prefab: 'crate', id: 'crate', at: [0, 2] }],
    });
    g.steps(1);
    const down = g.physics.circle_cast(new Vec2(-3, 5), 0.5, new Vec2(0, -1))!;
    expect(down.distance).toBeCloseTo(4.5, 3);
    expect(down.point.y).toBeCloseTo(0, 3);
    expect(down.normal.y).toBeCloseTo(1, 3);
    expect(g.physics.box_cast(new Vec2(-3, 2), new Vec2(1, 1), new Vec2(0, -1), 20, { rotation: 45 })!.distance).toBeCloseTo(2 - Math.SQRT1_2, 3);
    expect(g.physics.capsule_cast(new Vec2(-3, 3), 0.3, 2, new Vec2(0, -1))!.distance).toBeCloseTo(2, 3);
    const hit = g.physics.sweep(g.id('crate'), new Vec2(1, 0), 10)!;
    expect(hit.entity).toBe(g.id('wall'));
    expect(hit.distance).toBeCloseTo(4, 3);
  });
});

describe('2D interpolation and the physics2d service', () => {
  it('draws between fixed steps at 144 Hz', () => {
    const g = game({ prefabs: { puck: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'circle', radius: 0.2 } } } }, entities: [{ prefab: 'puck', id: 'puck' }] });
    g.get<Fields & { velocity: Vec2 }>('puck', 'rigidbody').velocity = new Vec2(3, 0);
    g.steps(3);
    const poses = g.kernel.service(RENDER_POSE_SERVICE);
    const drawn: number[] = [];
    for (let i = 0; i < 144; i++) {
      g.kernel.step(1 / 144);
      drawn.push((poses.local(g.id('puck'))?.position ?? g.pos('puck')).x);
    }
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]! - drawn[i - 1]!).toBeCloseTo(3 / 144, 2);
  });

  it('raycasts, bounds, layers, and network-driven bodies that follow their transform without fighting it', () => {
    const g = game({
      prefabs: { floor: FLOOR, ball: { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.5, layer: 'players' } } } },
      entities: [{ prefab: 'floor', id: 'floor' }, { prefab: 'ball', id: 'ball', at: [3, 5] }],
    }, { layers: ['players'] });
    g.steps(1);
    const service = g.kernel.service(PHYSICS2D_SERVICE);
    expect(service.raycast(new Vec3(0, 5, 0), new Vec3(0, -1, 0), 10)!.entity).toBe(g.id('floor'));
    expect(service.layerOf(g.id('ball'))).toBe('players');
    expect(service.bounds(g.id('ball'))!.halfExtents.x).toBe(0.5);
    service.setDriven(g.id('ball'), true);
    expect(service.body(g.id('ball'))!.kind).toBe('kinematic');
    const t = g.kernel.world.require(g.id('ball')).transform;
    for (let i = 0; i < 30; i++) {
      t.position = new Vec3(3 + i * 0.1, 5, 0);
      g.steps(1);
      expect(t.position.y).toBe(5);
    }
    const snap = g.kernel.snapshot();
    service.setDriven(g.id('ball'), false);
    g.steps(30);
    expect(g.pos('ball').y).toBeLessThan(5);
    g.kernel.restore(snap);
    expect(service.body(g.id('ball'))!.kind).toBe('kinematic');
  });
});
