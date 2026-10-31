/**
 * physics3d's depth: joints (each kind, limits, motors, breaking, turned bodies), force
 * fields, surface materials, shape casts, contact forces, ragdolls and render
 * interpolation — headless, with measured physics (pendulum periods, spring periods,
 * rope lengths) rather than "something moved".
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, GameDefinition, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE, RAGDOLL_POSE_SERVICE, RENDER_POSE_SERVICE, SKELETON_SERVICE } from '../../services/index.js';
import type { Physics3dService, SkeletonBone } from '../../services/index.js';
import { IMPACT, initPhysics3d, JOINT_BROKEN, physics3d } from './index.js';
import type { Physics3dNamespace, Physics3dOptions } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
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

interface Ragdoll extends Fields {
  readonly mode: string | null;
  readonly weight: number;
  go_limp(impulse?: Vec3, options?: { at?: Vec3 }): void;
  activate(strength?: number): void;
  recover(blend?: number): void;
}

interface World3d {
  readonly kernel: Kernel;
  readonly physics: Physics3dNamespace;
  readonly service: Physics3dService;
  id(placed: string): EntityId;
  pos(placed: string): Vec3;
  rot(placed: string): Quat;
  get<T extends Fields>(placed: string, component: string): T;
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
    pos: (placed) => kernel.world.require(id(placed)).transform.worldPosition(),
    rot: (placed) => kernel.world.require(id(placed)).transform.worldRotation(),
    get: <T extends Fields>(placed: string, component: string) => kernel.world.require(id(placed)).components.get(component) as T,
    steps: (n) => {
      for (let i = 0; i < n; i++) kernel.step(DT);
    },
  };
}

function listener(id: string, log: Array<[string, Fields]>, events: Record<string, EventDef>): BehaviorDef {
  return {
    id, params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([method, e]);
    }])) as LogicInstance,
  };
}

const FLOOR = { components: { collider: { shape: 'box', size: [40, 1, 40], offset: [0, -0.5, 0] } } };
const BOB = { components: { rigidbody: { mass: 1 }, collider: { shape: 'sphere', radius: 0.05 } } };

/** Times (s) at which `x` crosses zero going up, over `steps` fixed steps. */
function upCrossings(g: World3d, read: () => number, steps: number): number[] {
  const times: number[] = [];
  let previous = read();
  for (let i = 1; i <= steps; i++) {
    g.steps(1);
    const now = read();
    if (previous < 0 && now >= 0) times.push((i - 1 + -previous / (now - previous)) * DT);
    previous = now;
  }
  return times;
}

describe('joints', () => {
  it('a ball joint to the world swings as a pendulum of the right period', () => {
    const L = 2;
    const theta = 10 * Math.PI / 180;
    const g = world({
      prefabs: { bob: BOB },
      // The anchor is the pivot, L up the rod from the bob: where it is when built becomes the world anchor.
      entities: [{ prefab: 'bob', id: 'bob', at: [L * Math.sin(theta), 5 - L * Math.cos(theta), 0], components: { joint: { kind: 'ball', anchor: [-L * Math.sin(theta), L * Math.cos(theta), 0] } } }],
    });
    const crossings = upCrossings(g, () => g.pos('bob').x, 60 * 8);
    const periods = crossings.slice(1).map((t, i) => t - crossings[i]!);
    const expected = 2 * Math.PI * Math.sqrt((L * L + 0.4 * 0.05 * 0.05) / (9.8 * L)) * (1 + theta * theta / 16);
    expect(periods.length).toBeGreaterThanOrEqual(2);
    for (const p of periods) expect(Math.abs(p - expected) / expected).toBeLessThan(0.01);
    // The anchor holds: the bob stays L from the pivot.
    expect(g.pos('bob').distance_to(new Vec3(0, 5, 0))).toBeCloseTo(L, 2);
  });

  it('a hinge stops at its limits, and reads its angle in degrees from the pose it was built in', () => {
    const g = world({
      prefabs: { bar: { components: { rigidbody: { mass: 1 }, collider: { shape: 'box', size: [1, 0.1, 0.1] } } } },
      // Hinged at its left end about +z: gravity swings the free end down (negative about +z).
      entities: [{ prefab: 'bar', id: 'bar', at: [0.5, 3, 0], components: { joint: { kind: 'hinge', anchor: [-0.5, 0, 0], axis: [0, 0, 1], limits: [-30, 45] } } }],
    });
    const joint = g.get<Joint>('bar', 'joint');
    expect(joint.angle).toBeCloseTo(0, 6);
    g.steps(180);
    expect(joint.angle!).toBeGreaterThan(-31);
    expect(joint.angle!).toBeLessThan(-28);
    expect(g.rot('bar').to_euler().z).toBeCloseTo(joint.angle!, 0);
    // The pivot stayed put.
    const tip = g.kernel.world.require(g.id('bar')).transform.toWorld(new Vec3(-0.5, 0, 0));
    expect(tip.distance_to(new Vec3(0, 3, 0))).toBeLessThan(0.01);
  });

  it('a slider moves only along its axis, between its limits', () => {
    const g = world({
      prefabs: { box: { components: { rigidbody: { mass: 2 }, collider: { shape: 'box', size: [0.5, 0.5, 0.5] } } } },
      entities: [{ prefab: 'box', id: 'box', at: [0, 4, 0], rotation: [0, 0, 30], components: { joint: { kind: 'slider', axis: [0, 1, 0], limits: [-1.5, 0] } } }],
    });
    g.steps(120);
    const joint = g.get<Joint>('box', 'joint');
    expect(joint.position!).toBeCloseTo(-1.5, 2);
    // Its axis is the box's local y (turned 30° about z): it slid down and to the right.
    const travelled = g.pos('box').__sub__(new Vec3(0, 4, 0));
    const axis = Quat.from_euler(new Vec3(0, 0, 30)).rotate(new Vec3(0, 1, 0));
    expect(travelled.dot(axis)).toBeCloseTo(-1.5, 2);
    expect(travelled.cross(axis).length()).toBeLessThan(1e-3);
    expect(g.rot('box').to_euler().z).toBeCloseTo(30, 2);
  });

  it('a hinge motor runs at its speed, a servo reaches its target, and max force caps the effort', () => {
    const g = world({
      prefabs: {
        wheel: { components: { rigidbody: { mass: 3, gravity_scale: 0 }, collider: { shape: 'cylinder', radius: 0.5, height: 0.2 } } },
        arm: { components: { rigidbody: { mass: 1, angular_damping: 3 }, collider: { shape: 'box', size: [1, 0.1, 0.1] } } },
      },
      entities: [
        { prefab: 'wheel', id: 'spin', at: [0, 3, 0], components: { joint: { kind: 'hinge', axis: [0, 1, 0], motor_speed: 90 } } },
        { prefab: 'wheel', id: 'servo', at: [5, 3, 0], components: { joint: { kind: 'hinge', axis: [0, 1, 0], motor_target: 45, motor_speed: 120 } } },
        // Holding a 1 kg, 1 m arm level needs 4.9 N·m; this motor has 2.
        { prefab: 'arm', id: 'weak', at: [10.5, 3, 0], components: { joint: { kind: 'hinge', anchor: [-0.5, 0, 0], axis: [0, 0, 1], motor_target: 0, motor_max_force: 2 } } },
        { prefab: 'arm', id: 'strong', at: [15.5, 3, 0], components: { joint: { kind: 'hinge', anchor: [-0.5, 0, 0], axis: [0, 0, 1], motor_target: 0, motor_max_force: 20 } } },
      ],
    });
    g.steps(60);
    expect(g.get<Fields>('spin', 'rigidbody')['angular_velocity']).toBeInstanceOf(Vec3);
    expect((g.get<Fields>('spin', 'rigidbody')['angular_velocity'] as Vec3).y).toBeCloseTo(90, 0);
    expect(g.get<Joint>('servo', 'joint').angle!).toBeCloseTo(45, 0);
    g.steps(60);
    expect(g.get<Joint>('servo', 'joint').angle!).toBeCloseTo(45, 0);
    g.steps(180);
    // It sags until gravity's torque, 4.9·cos(θ) N·m, is all the motor can give: θ = −acos(2/4.9) ≈ −66°.
    expect(g.get<Joint>('weak', 'joint').angle!).toBeCloseTo(-Math.acos(2 / 4.9) * 180 / Math.PI, -1);
    expect(Math.abs(g.get<Joint>('strong', 'joint').angle!)).toBeLessThan(2);
  });

  it('a slider motor drives at its speed', () => {
    const g = world({
      prefabs: { cart: { components: { rigidbody: { mass: 5, gravity_scale: 0 }, collider: { shape: 'box', size: [1, 0.5, 1] } } } },
      entities: [{ prefab: 'cart', id: 'cart', at: [0, 1, 0], components: { joint: { kind: 'slider', axis: [1, 0, 0], motor_speed: 2 } } }],
    });
    g.steps(60);
    expect(g.get<Joint>('cart', 'joint').position!).toBeGreaterThan(1.9);
    expect(g.get<Joint>('cart', 'joint').position!).toBeLessThan(2.05);
  });

  it('a rope never lets the anchors part more than its length, and is slack inside it', () => {
    const g = world({
      prefabs: { bob: BOB },
      // Built 1 m from its anchor with a 2 m rope: it falls slack, then swings on the rope.
      entities: [{ prefab: 'bob', id: 'bob', at: [1, 5, 0], components: { joint: { kind: 'rope', connected_anchor: [0, 5, 0], length: 2 } } }],
    });
    let longest = 0;
    let shortest = Infinity;
    for (let i = 0; i < 240; i++) {
      g.steps(1);
      const d = g.pos('bob').distance_to(new Vec3(0, 5, 0));
      longest = Math.max(longest, d);
      shortest = Math.min(shortest, d);
    }
    expect(longest).toBeLessThan(2.02);
    expect(longest).toBeGreaterThan(1.98);
    expect(shortest).toBeLessThan(1.1);
    expect(g.get<Joint>('bob', 'joint').distance!).toBeLessThan(2.02);
  });

  it('a spring oscillates with the period of its stiffness in N/m and the mass it carries', () => {
    const run = (mass: number): number => {
      const g = world({
        prefabs: { weight: { components: { rigidbody: { mass, gravity_scale: 0 }, collider: { shape: 'sphere', radius: 0.1 } } } },
        entities: [{ prefab: 'weight', id: 'w', at: [1.5, 3, 0], components: { joint: { kind: 'spring', connected_anchor: [0, 3, 0], length: 1, stiffness: 100, damping: 0 } } }],
      });
      const crossings = upCrossings(g, () => -(g.pos('w').x - 1), 60 * 4);
      return (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1);
    };
    // T = 2π·√(m/k)
    expect(run(1)).toBeCloseTo(2 * Math.PI * Math.sqrt(1 / 100), 1);
    expect(run(4)).toBeCloseTo(2 * Math.PI * Math.sqrt(4 / 100), 1);
  });

  it('length None is the distance when built, written back to the component', () => {
    const g = world({ prefabs: { bob: BOB }, entities: [{ prefab: 'bob', id: 'bob', at: [3, 4, 0], components: { joint: { kind: 'rope' } } }] });
    g.steps(1);
    const joint = g.get<Joint>('bob', 'joint');
    expect(joint['length']).toBe(0);
    expect((joint['connected_anchor'] as Vec3).toJSON()).toEqual([3, 4, 0]);
  });

  it('a fixed joint welds two bodies as they were built; the pair falls as one', () => {
    const g = world({
      prefabs: { floor: FLOOR, box: { components: { rigidbody: { mass: 1 }, collider: { shape: 'box', size: [0.5, 0.5, 0.5] } } } },
      entities: [
        { prefab: 'floor' },
        { prefab: 'box', id: 'a', at: [0, 3, 0] },
        { prefab: 'box', id: 'b', at: [0.6, 3.3, 0], rotation: [0, 0, 40], components: { joint: { kind: 'fixed', connected: 'a' } } },
      ],
    });
    const start = g.pos('b').__sub__(g.pos('a'));
    g.steps(120);
    const relative = g.rot('a').inverse().rotate(g.pos('b').__sub__(g.pos('a')));
    expect(relative.distance_to(start)).toBeLessThan(0.02);
    expect(g.rot('a').inverse().__mul__(g.rot('b')).is_close(Quat.from_euler(new Vec3(0, 0, 40)), 1e-4)).toBe(true);
  });

  it('a hinge between bodies turned differently keeps both rotations (no snap), and turns about the body\'s own axis', () => {
    const g = world({
      prefabs: {
        head: { components: { rigidbody: { mass: 5, gravity_scale: 0, lock_rotation: true, lock_axes: ['x', 'y', 'z'] }, collider: { shape: 'box', size: [0.4, 0.2, 0.4] } } },
        finger: { components: { rigidbody: { mass: 0.2 }, collider: { shape: 'box', size: [0.05, 0.3, 0.05] } } },
      },
      entities: [
        { prefab: 'head', id: 'head', at: [0, 3, 0] },
        // Yawed 120°, hinged at its top about its own x.
        { prefab: 'finger', id: 'f', at: [0.2, 2.75, 0], rotation: [0, 120, 0], components: { joint: { kind: 'hinge', connected: 'head', anchor: [0, 0.15, 0], axis: [1, 0, 0], limits: [-20, 20] } } },
      ],
    });
    const yaw0 = g.rot('f').to_euler().y;
    g.steps(5);
    expect(g.rot('f').to_euler().y).toBeCloseTo(yaw0, 3);
    // Push the finger's tip along its local z: it swings about its own x, within its limits.
    const body = g.get<{ impulse(j: Vec3, o?: { at?: Vec3 }): void } & Fields>('f', 'rigidbody');
    const tip = g.kernel.world.require(g.id('f')).transform.toWorld(new Vec3(0, -0.15, 0));
    body.impulse(g.rot('f').rotate(new Vec3(0, 0, 0.5)), { at: tip });
    g.steps(60);
    const joint = g.get<Joint>('f', 'joint');
    expect(Math.abs(joint.angle!)).toBeGreaterThan(5);
    expect(Math.abs(joint.angle!)).toBeLessThan(21);
    const euler = g.rot('f').to_euler();
    expect(euler.y).toBeCloseTo(yaw0, 0);
  });

  it('breaks when its load passes break_force, and says so; the load of a hanging weight is its weight', () => {
    const log: Array<[string, Fields]> = [];
    const g = world({
      prefabs: { crate: { components: { rigidbody: { mass: 2 }, collider: { shape: 'box', size: [0.4, 0.4, 0.4] } }, behaviors: { watcher: {} } } },
      entities: [{ prefab: 'crate', id: 'crate', at: [0, 3, 0], components: { joint: { kind: 'ball', anchor: [0, 0.2, 0], break_force: 30 } } }],
    }, {}, [listener('watcher', log, { broke: JOINT_BROKEN })]);
    g.steps(30);
    const joint = g.get<Joint>('crate', 'joint');
    expect(joint.load).toBeCloseTo(2 * 9.8, 0);
    expect(joint['broken']).toBe(false);
    // A yank well past 30 N.
    g.get<{ force(f: Vec3): void } & Fields>('crate', 'rigidbody').force(new Vec3(0, -200, 0));
    g.steps(1);
    expect(joint['broken']).toBe(true);
    expect(log).toHaveLength(1);
    expect(log[0]![1]['force']).toBeGreaterThan(30);
    const y = g.pos('crate').y;
    g.steps(30);
    expect(g.pos('crate').y).toBeLessThan(y - 0.5);
    expect(joint.angle).toBe(null);
    // Setting broken back rebuilds it on its anchors (written back when first built): put the crate back first.
    g.get<{ teleport(p: Vec3): void } & Fields>('crate', 'rigidbody').teleport(new Vec3(0, 3, 0));
    joint['broken'] = false;
    g.steps(30);
    expect(joint['broken']).toBe(false);
    expect(g.pos('crate').y).toBeCloseTo(3, 1);
  });

  it('detach() lets go without an event; a destroyed anchor breaks the joint with one', () => {
    const log: Array<[string, Fields]> = [];
    const g = world({
      prefabs: { bob: { ...BOB, behaviors: { watcher: {} } }, post: { components: { collider: { shape: 'box' } } } },
      entities: [
        { prefab: 'post', id: 'post', at: [0, 6, 0] },
        { prefab: 'bob', id: 'a', at: [0, 4, 0], components: { joint: { kind: 'rope', connected: 'post' } } },
        { prefab: 'bob', id: 'b', at: [3, 4, 0], components: { joint: { kind: 'rope', connected_anchor: [3, 6, 0] } } },
      ],
    }, {}, [listener('watcher', log, { broke: JOINT_BROKEN })]);
    g.steps(5);
    g.get<Joint>('b', 'joint').detach();
    g.kernel.destroy(g.id('post'));
    g.steps(2);
    expect(g.get<Joint>('a', 'joint')['broken']).toBe(true);
    expect(g.get<Joint>('b', 'joint')['broken']).toBe(true);
    expect(log.map(([m]) => m)).toEqual(['broke']);
    expect(log[0]![1]['connected']).toBe(null);
  });

  it('refuses joints that can\'t work, with fixes', () => {
    const make = (joint: Record<string, unknown>, prefabs: Record<string, unknown> = { bob: BOB }) => () => world({
      prefabs, entities: [{ prefab: Object.keys(prefabs)[0]!, id: 'x', at: [0, 2, 0], components: { joint } }],
    }).steps(1);
    expect(make({ kind: 'hinge', axis: [0, 0, 0] })).toThrow(/PP3183/);
    expect(make({ kind: 'hinge', limits: [10, -10] })).toThrow(/PP3185/);
    expect(make({ kind: 'rope', limits: [0, 1] })).toThrow(/PP3185/);
    expect(make({ kind: 'ball', motor_speed: 10 })).toThrow(/PP3186/);
    expect(make({ kind: 'hinge' }, { wall: { components: { collider: {} } } })).toThrow(/PP3182/);
    expect(make({ kind: 'hinge', to_parent: true })).toThrow(/PP3181.*parent/);
  });
});

describe('force fields', () => {
  it('a radial attractor pulls bodies within its radius in, whatever their mass', () => {
    const g = world({
      prefabs: {
        ball: { components: { rigidbody: { mass: 3, gravity_scale: 0 }, collider: { shape: 'sphere', radius: 0.2 } } },
        well: { components: { force_field: { kind: 'radial', strength: -4, radius: 20 } } },
      },
      entities: [{ prefab: 'well', at: [0, 0, 0] }, { prefab: 'ball', id: 'near', at: [5, 0, 0] }, { prefab: 'ball', id: 'far', at: [0, 0, 30] }],
    });
    g.steps(60);
    // 4 m/s² for 1 s, whatever the mass: ½·a·t² ≈ 2 m.
    expect(g.pos('near').x).toBeCloseTo(3, 1);
    expect(g.pos('far').z).toBe(30);
  });

  it('a trigger-shaped updraft holds bodies against gravity inside it only', () => {
    const g = world({
      prefabs: {
        ball: { components: { rigidbody: { mass: 1 }, collider: { shape: 'sphere', radius: 0.2 } } },
        thermal: { components: { collider: { shape: 'box', size: [2, 10, 2], trigger: true }, force_field: { kind: 'directional', strength: 9.8 } } },
      },
      entities: [{ prefab: 'thermal', at: [0, 5, 0] }, { prefab: 'ball', id: 'in', at: [0, 5, 0] }, { prefab: 'ball', id: 'out', at: [5, 5, 0] }],
    });
    // A trigger's contents are known from its first step on: from then, gravity is cancelled.
    g.steps(2);
    const v = g.get<Fields & { velocity: Vec3 }>('in', 'rigidbody').velocity.y;
    g.steps(60);
    expect(g.get<Fields & { velocity: Vec3 }>('in', 'rigidbody').velocity.y).toBeCloseTo(v, 6);
    expect(g.pos('in').y).toBeGreaterThan(4.5);
    expect(g.pos('out').y).toBeLessThan(0.5);
  });

  it('a vortex swirls bodies around its axis', () => {
    const g = world({
      prefabs: {
        ball: { components: { rigidbody: { mass: 1, gravity_scale: 0 }, collider: { shape: 'sphere', radius: 0.2 } } },
        vortex: { components: { force_field: { kind: 'vortex', strength: 3, radius: 10 } } },
      },
      entities: [{ prefab: 'vortex' }, { prefab: 'ball', id: 'b', at: [2, 0, 0] }],
    });
    g.steps(30);
    // Counter-clockwise seen from +y: from +x towards -z.
    expect(g.pos('b').z).toBeLessThan(-0.3);
    expect(Math.abs(g.pos('b').y)).toBeLessThan(1e-6);
  });

  it('refuses a solid field collider and linear falloff without a radius', () => {
    const run = (field: Record<string, unknown>, collider?: Record<string, unknown>) => () => world({
      prefabs: { f: { components: { force_field: field, ...(collider && { collider }) } }, ball: BOB },
      entities: [{ prefab: 'f' }, { prefab: 'ball', at: [0, 1, 0] }],
    }).steps(1);
    expect(run({ falloff: 'linear' })).toThrow(/PP3192/);
    expect(run({}, { shape: 'box' })).toThrow(/PP3192.*collider is solid/);
  });
});

describe('surface materials', () => {
  const materials = {
    ice: { friction: 0, bounce: 0, sound: null, impact_speed: 1 },
    rubber: { friction: 1, bounce: 0.9, sound: 'sfx/boing', impact_speed: 1 },
    stone: { friction: 0.8, bounce: 0, sound: 'sfx/thud', impact_speed: 1 },
  };

  it('a collider\'s material sets its friction and bounce; impacts carry materials, speed and sound', () => {
    const log: Array<[string, Fields]> = [];
    const g = world({
      prefabs: {
        floor: { components: { collider: { shape: 'box', size: [40, 1, 40], offset: [0, -0.5, 0], material: 'stone' } } },
        ball: { components: { rigidbody: {}, collider: { shape: 'sphere', radius: 0.25, material: 'rubber' } }, behaviors: { watcher: {} } },
        puck: { components: { rigidbody: {}, collider: { shape: 'box', size: [0.5, 0.2, 0.5], material: 'ice' } } },
      },
      entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3, 0] }, { prefab: 'puck', id: 'puck', at: [5, 0.1, 0] }],
    }, { materials }, [listener('watcher', log, { impact: IMPACT })]);
    g.get<Fields & { velocity: Vec3 }>('puck', 'rigidbody').velocity = new Vec3(3, 0, 0);
    let top = 0;
    let falling = true;
    for (let i = 0; i < 120; i++) {
      g.steps(1);
      const y = g.pos('ball').y;
      if (falling && g.get<Fields & { velocity: Vec3 }>('ball', 'rigidbody').velocity.y > 0) falling = false;
      if (!falling) top = Math.max(top, y);
    }
    // Rubber on stone bounces back to most of its height (restitution takes the larger).
    expect(top).toBeGreaterThan(1.5);
    // Ice slides on (friction combines as the mean: 0.4), stone would stop it sooner.
    expect(g.pos('puck').x).toBeGreaterThan(5.5);
    const first = log.find(([m]) => m === 'impact')![1];
    expect(first['material']).toBe('rubber');
    expect(first['target_material']).toBe('stone');
    expect(first['sound']).toBe('sfx/boing');
    expect(first['speed'] as number).toBeCloseTo(Math.sqrt(2 * 9.8 * 2.75), 0);
  });

  it('an undeclared material is an error with a suggestion', () => {
    expect(() => world({
      prefabs: { b: { components: { collider: { material: 'rubbr' } } } }, entities: [{ prefab: 'b' }],
    }, { materials })).toThrow(/PP3191.*"rubbr", which is not declared/);
  });
});

describe('shape casts', () => {
  it('sphere, box and capsule casts report how far the shape travelled, where it touched and the surface normal', () => {
    const g = world({
      prefabs: { floor: FLOOR, wall: { components: { collider: { shape: 'box', size: [1, 4, 4] } } } },
      entities: [{ prefab: 'floor' }, { prefab: 'wall', id: 'wall', at: [5, 2, 0] }],
    });
    g.steps(1);
    const down = g.physics.sphere_cast(new Vec3(0, 5, 0), 0.5, new Vec3(0, -1, 0))!;
    expect(down.distance).toBeCloseTo(4.5, 3);
    expect(down.point.y).toBeCloseTo(0, 3);
    expect(down.normal.y).toBeCloseTo(1, 3);
    const side = g.physics.box_cast(new Vec3(0, 2, 0), new Vec3(1, 1, 1), new Vec3(1, 0, 0), 20, { rotation: new Vec3(0, 45, 0) })!;
    // A 1 m cube turned 45° reaches √½ m ahead of its centre; the wall's face is at x = 4.5.
    expect(side.distance).toBeCloseTo(4.5 - Math.SQRT1_2, 3);
    expect(side.entity).toBe(g.id('wall'));
    expect(side.normal.x).toBeCloseTo(-1, 3);
    const capsule = g.physics.capsule_cast(new Vec3(0, 3, 0), 0.3, 2, new Vec3(0, -1, 0))!;
    expect(capsule.distance).toBeCloseTo(2, 3);
    expect(g.physics.sphere_cast(new Vec3(0, 5, 0), 0.5, new Vec3(0, 1, 0))).toBe(null);
    expect(g.physics.sphere_cast(new Vec3(0, 5, 0), 0.5, new Vec3(0, -1, 0), 2)).toBe(null);
  });

  it('sweep casts an entity\'s own collider and ignores the entity itself', () => {
    const g = world({
      prefabs: { wall: { components: { collider: { shape: 'box', size: [1, 4, 4] } } }, crate: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'box', size: [1, 1, 1] } } } },
      entities: [{ prefab: 'wall', id: 'wall', at: [5, 2, 0] }, { prefab: 'crate', id: 'crate', at: [0, 2, 0] }],
    });
    g.steps(1);
    const hit = g.physics.sweep(g.id('crate'), new Vec3(1, 0, 0), 10)!;
    expect(hit.entity).toBe(g.id('wall'));
    expect(hit.distance).toBeCloseTo(4, 3);
    expect(g.physics.sweep(g.id('crate'), new Vec3(-1, 0, 0), 10)).toBe(null);
    expect(() => g.physics.sphere_cast(new Vec3(0, 0, 0), 1, new Vec2(1, 0))).toThrow(/PP3153.*Vec2/);
  });
});

describe('contact forces', () => {
  it('watched entities report contacts pressing past their threshold, with the force, direction and closing speed', () => {
    const g = world({
      prefabs: { floor: FLOOR, plate: { components: { collider: { shape: 'box', size: [2, 0.2, 2], offset: [0, 0.1, 0] } } }, rock: { components: { rigidbody: { mass: 50 }, collider: { shape: 'sphere', radius: 0.3 } } } },
      entities: [{ prefab: 'floor' }, { prefab: 'plate', id: 'plate' }, { prefab: 'rock', id: 'rock', at: [0, 4, 0] }],
    });
    g.service.watchContactForces(g.id('plate'), 'test', 1000);
    const seen: Array<{ force: number; speed: number; y: number }> = [];
    for (let i = 0; i < 90; i++) {
      g.steps(1);
      for (const c of g.service.contactForces()) {
        expect(c.entity).toBe(g.id('plate'));
        expect(c.other).toBe(g.id('rock'));
        seen.push({ force: c.force, speed: c.speed, y: c.direction.y });
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    // The landing: 50 kg at ~8.4 m/s; resting weight alone (490 N) stays under the threshold.
    expect(seen[0]!.force).toBeGreaterThan(1000);
    expect(seen[0]!.speed).toBeCloseTo(Math.sqrt(2 * 9.8 * 3.5), 0);
    expect(seen[0]!.y).toBeLessThan(-0.9);
    expect(g.service.contactForces()).toEqual([]);
    const snap = g.kernel.snapshot();
    g.service.watchContactForces(g.id('plate'), 'test', undefined);
    g.kernel.restore(snap);
    expect((snap.plugins['physics3d'] as { watches: unknown[] }).watches).toEqual([{ entity: g.id('plate'), owner: 'test', threshold: 1000 }]);
  });
});

describe('render interpolation', () => {
  it('draws a moving body between its last two fixed steps at 144 Hz, smoothly', () => {
    const g = world({
      prefabs: { puck: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'sphere', radius: 0.2 } } } },
      entities: [{ prefab: 'puck', id: 'puck' }],
    });
    const poses = g.kernel.service(RENDER_POSE_SERVICE);
    g.get<Fields & { velocity: Vec3 }>('puck', 'rigidbody').velocity = new Vec3(3, 0, 0);
    g.steps(3);
    const frame = 1 / 144;
    const drawn: number[] = [];
    const raw: number[] = [];
    for (let i = 0; i < 144; i++) {
      g.kernel.step(frame);
      drawn.push((poses.local(g.id('puck'))?.position ?? g.pos('puck')).x);
      raw.push(g.pos('puck').x);
    }
    const steps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]!);
    const drawnSteps = steps(drawn);
    const rawSteps = steps(raw);
    // Raw transforms jump a whole fixed step (3/60 m) on some frames and stand still on others;
    // drawn poses advance about 3/144 m every frame.
    expect(Math.max(...rawSteps)).toBeCloseTo(3 / 60, 6);
    expect(Math.min(...rawSteps)).toBe(0);
    for (const s of drawnSteps) expect(s).toBeCloseTo(3 / 144, 2);
    // The drawn pose lags the simulation by under one fixed step.
    expect(raw[raw.length - 1]! - drawn[drawn.length - 1]!).toBeLessThan(3 / 60 + 1e-9);
  });

  it('draws teleports and game moves where they are, and children through their interpolated parent', () => {
    const g = world({
      prefabs: { puck: { components: { rigidbody: { gravity_scale: 0 }, collider: { shape: 'sphere', radius: 0.2 } }, children: [{ name: 'flag', at: [0, 1, 0] }] } },
      entities: [{ prefab: 'puck', id: 'puck' }],
    });
    const poses = g.kernel.service(RENDER_POSE_SERVICE);
    const rb = g.get<Fields & { velocity: Vec3; teleport(p: Vec3): void }>('puck', 'rigidbody');
    rb.velocity = new Vec3(6, 0, 0);
    g.steps(2);
    g.kernel.step(DT / 2);
    const puck = g.id('puck');
    const flag = g.kernel.world.require(puck).children[0]!;
    const drawn = poses.local(puck)!;
    expect(drawn.position.x).toBeLessThan(g.pos('puck').x);
    expect(poses.world(flag).position.x).toBeCloseTo(drawn.position.x, 9);
    expect(poses.world(flag).position.y).toBeCloseTo(1, 9);
    rb.teleport(new Vec3(100, 0, 0));
    g.kernel.step(DT);
    expect(poses.local(puck)?.position.x ?? g.pos('puck').x).toBeCloseTo(g.pos('puck').x, 9);
    // Moved by the game outside the physics phase: drawn as it is.
    g.kernel.world.require(puck).transform.position = new Vec3(-5, 0, 0);
    expect(poses.local(puck)).toBe(undefined);
  });
});

/** A skinned humanoid in mixamo naming, standing 1.8 m tall: what render3d's skeleton service hands over. */
function mixamo(): SkeletonBone[] {
  const bones: Array<[string, number, [number, number, number]]> = [
    ['mixamorig:Hips', -1, [0, 0.95, 0]],
    ['mixamorig:Spine', 0, [0, 1.1, 0]],
    ['mixamorig:Neck', 1, [0, 1.5, 0]],
    ['mixamorig:Head', 2, [0, 1.57, 0]],
    ['mixamorig:HeadTop_End', 3, [0, 1.8, 0]],
    ['mixamorig:LeftArm', 1, [0.2, 1.45, 0]],
    ['mixamorig:LeftForeArm', 5, [0.22, 1.15, 0]],
    ['mixamorig:LeftHand', 6, [0.24, 0.85, 0]],
    ['mixamorig:RightArm', 1, [-0.2, 1.45, 0]],
    ['mixamorig:RightForeArm', 8, [-0.22, 1.15, 0]],
    ['mixamorig:RightHand', 9, [-0.24, 0.85, 0]],
    ['mixamorig:LeftUpLeg', 0, [0.1, 0.92, 0]],
    ['mixamorig:LeftLeg', 11, [0.1, 0.5, 0]],
    ['mixamorig:LeftFoot', 12, [0.1, 0.08, 0]],
    ['mixamorig:RightUpLeg', 0, [-0.1, 0.92, 0]],
    ['mixamorig:RightLeg', 14, [-0.1, 0.5, 0]],
    ['mixamorig:RightFoot', 15, [-0.1, 0.08, 0]],
  ];
  return bones.map(([name, parent, [x, y, z]]) => ({ name, parent, position: new Vec3(x, y, z), rotation: Quat.IDENTITY }));
}

const skeletons = (bones: () => SkeletonBone[] | null): KernelPlugin => ({
  id: 'skeletons',
  install: (k) => k.provide(SKELETON_SERVICE, { pose: () => { const b = bones(); return b === null ? null : { bones: b }; } }),
});

describe('ragdolls', () => {
  const GUARD = { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'capsule', radius: 0.3, height: 1.8, offset: [0, 0.9, 0] }, ragdoll: {} } };

  it('goes limp from its profile\'s proportions, falls to the floor, then recovers upright where it lies and blends back', () => {
    const g = world({ prefabs: { floor: FLOOR, guard: GUARD }, entities: [{ prefab: 'floor' }, { prefab: 'guard', id: 'g', at: [0, 0, 0], rotation: [0, 30, 0] }] });
    const ragdoll = g.get<Ragdoll>('g', 'ragdoll');
    expect(ragdoll.mode).toBe(null);
    expect(ragdoll.weight).toBe(0);
    ragdoll.go_limp(new Vec3(0, 0, 60), { at: new Vec3(0, 1.5, 0) });
    expect(ragdoll.mode).toBe('limp');
    expect(g.service.ragdollOf(g.id('g'))).toBe('limp');
    // Its own capsule stands aside: raycasts find the parts, not the capsule.
    g.steps(180);
    const pose = g.kernel.service(RAGDOLL_POSE_SERVICE).pose(g.id('g'))!;
    expect(pose.weight).toBe(1);
    expect([...pose.bones.keys()]).toContain('head');
    // Every part lies on the floor: none higher than ~a chest's thickness.
    const top = Math.max(...[...pose.bones.values()].map((b) => g.kernel.world.require(g.id('g')).transform.toWorld(b.position).y));
    expect(top).toBeLessThan(0.6);
    const pelvis = g.kernel.world.require(g.id('g')).transform.toWorld(pose.bones.get('pelvis')!.position);
    const hit = g.physics.raycast(new Vec3(pelvis.x, 3, pelvis.z), new Vec3(0, -1, 0));
    expect(hit?.entity).toBe(g.id('g'));
    ragdoll.recover(0.5);
    expect(ragdoll.mode).toBe('recovering');
    expect(ragdoll.weight).toBe(1);
    const e = g.rot('g').to_euler();
    expect(Math.abs(e.x) + Math.abs(e.z)).toBeLessThan(1e-6);
    expect(g.pos('g').y).toBeLessThan(0.2);
    g.steps(15);
    expect(ragdoll.weight).toBeCloseTo(0.5, 1);
    g.steps(16);
    expect(ragdoll.mode).toBe(null);
    expect(g.kernel.service(RAGDOLL_POSE_SERVICE).pose(g.id('g'))).toBe(undefined);
  });

  it('lays its profile over the model\'s skeleton when render3d provides one', () => {
    const g = world({ prefabs: { floor: FLOOR, guard: GUARD }, entities: [{ prefab: 'floor' }, { prefab: 'guard', id: 'g' }] }, {}, [], [skeletons(mixamo)]);
    const ragdoll = g.get<Ragdoll>('g', 'ragdoll');
    ragdoll.go_limp();
    g.kernel.step(DT);
    const bones = g.kernel.service(RAGDOLL_POSE_SERVICE).pose(g.id('g'))!.bones;
    expect([...bones.keys()].sort()).toEqual([
      'mixamorig:Head', 'mixamorig:Hips', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftLeg', 'mixamorig:LeftUpLeg',
      'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightLeg', 'mixamorig:RightUpLeg', 'mixamorig:Spine',
    ]);
    // A step in, the bones are still where the skeleton had them (model space).
    expect(bones.get('mixamorig:Head')!.position.distance_to(new Vec3(0, 1.57, 0))).toBeLessThan(0.05);
    expect(bones.get('mixamorig:LeftLeg')!.position.distance_to(new Vec3(0.1, 0.5, 0))).toBeLessThan(0.05);
  });

  it('refuses a skeleton without the bones its profile needs', () => {
    const g = world({ prefabs: { guard: GUARD }, entities: [{ prefab: 'guard', id: 'g' }] }, {}, [], [skeletons(() => mixamo().filter((b) => !b.name.includes('Left')))]);
    expect(() => g.get<Ragdoll>('g', 'ragdoll').go_limp()).toThrow(/PP3195.*upper_arm_l/);
  });

  it('an active ragdoll holds its pose against gravity and returns to it after a shove', () => {
    const g = world({ prefabs: { floor: FLOOR, guard: GUARD }, entities: [{ prefab: 'floor' }, { prefab: 'guard', id: 'g' }] });
    const ragdoll = g.get<Ragdoll>('g', 'ragdoll');
    ragdoll.activate();
    expect(ragdoll.mode).toBe('active');
    const headY = (): number => {
      const head = g.kernel.service(RAGDOLL_POSE_SERVICE).pose(g.id('g'))!.bones.get('head')!;
      return g.kernel.world.require(g.id('g')).transform.toWorld(head.position).y;
    };
    g.steps(60);
    expect(headY()).toBeGreaterThan(1.5);
    ragdoll.go_limp(new Vec3(40, 0, 0), { at: new Vec3(0, 1.4, 0) });
    ragdoll.activate();
    g.steps(120);
    expect(headY()).toBeGreaterThan(1.5);
    // It stays where the game keeps the entity.
    expect(g.pos('g').length()).toBeLessThan(1e-9);
  });

  it('is in the snapshot: a restored ragdoll carries on exactly as the original does', () => {
    const make = () => world({ prefabs: { floor: FLOOR, guard: GUARD }, entities: [{ prefab: 'floor' }, { prefab: 'guard', id: 'g' }] });
    const g = make();
    g.get<Ragdoll>('g', 'ragdoll').go_limp(new Vec3(0, 0, 30));
    g.steps(20);
    const snap = g.kernel.snapshot();
    const trace = (w: World3d): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        w.steps(1);
        out.push(...w.pos('g').toJSON());
      }
      return out;
    };
    const first = trace(g);
    g.kernel.restore(snap);
    expect(g.get<Ragdoll>('g', 'ragdoll').mode).toBe('limp');
    const second = trace(g);
    g.kernel.restore(snap);
    expect(trace(g)).toEqual(second);
    // Rapier's solver warm-start isn't saved, so restored runs agree with each other exactly, and with
    // the uninterrupted run only roughly (a tumbling body amplifies the difference).
    first.forEach((v, i) => expect(Math.abs(v - second[i]!)).toBeLessThan(0.5));
  });
});

describe('snapshots', () => {
  it('joints rebuild from a snapshot with their frames: a turned hinge keeps its zero', () => {
    const g = world({
      prefabs: { bar: { components: { rigidbody: { mass: 1 }, collider: { shape: 'box', size: [1, 0.1, 0.1] } } } },
      entities: [{ prefab: 'bar', id: 'bar', at: [0.5, 3, 0], rotation: [0, 40, 0], components: { joint: { kind: 'hinge', anchor: [-0.5, 0, 0], axis: [0, 0, 1], limits: [-30, 45] } } }],
    });
    g.steps(30);
    const angle = g.get<Joint>('bar', 'joint').angle!;
    const snap = g.kernel.snapshot();
    g.steps(30);
    g.kernel.restore(snap);
    expect(g.get<Joint>('bar', 'joint').angle!).toBeCloseTo(angle, 6);
    g.steps(120);
    expect(g.get<Joint>('bar', 'joint').angle!).toBeGreaterThan(-31);
    expect(g.get<Joint>('bar', 'joint').angle!).toBeLessThan(-28);
  });

  it('network-driven bodies follow their transform without fighting it, and are in the snapshot', () => {
    const g = world({
      prefabs: { ball: { components: { rigidbody: {}, collider: { shape: 'sphere', radius: 0.5, layer: 'players' } } } },
      entities: [{ prefab: 'ball', id: 'ball', at: [0, 5, 0] }],
    }, { layers: ['players'] });
    expect(g.service.layerOf(g.id('ball'))).toBe('players');
    g.service.setDriven(g.id('ball'), true);
    expect(g.service.body(g.id('ball'))!.kind).toBe('kinematic');
    const t = g.kernel.world.require(g.id('ball')).transform;
    for (let i = 0; i < 30; i++) {
      t.position = new Vec3(i * 0.1, 5, 0);
      g.steps(1);
      expect(t.position.toJSON()).toEqual([i * 0.1, 5, 0]);
    }
    const snap = g.kernel.snapshot();
    g.service.setDriven(g.id('ball'), false);
    g.steps(30);
    expect(g.pos('ball').y).toBeLessThan(5);
    g.kernel.restore(snap);
    expect(g.service.body(g.id('ball'))!.kind).toBe('kinematic');
  });
});
