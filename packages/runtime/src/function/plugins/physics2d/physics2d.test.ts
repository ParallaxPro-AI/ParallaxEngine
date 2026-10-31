import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, GameDefinition, LogicInstance } from '../../kernel/index.js';
import { initPhysics2d, PHYSICS_EVENTS, physics2d } from './index.js';
import { rapier } from './rapier.js';
import type { Hit, Physics2dOptions, PhysicsNamespace } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics2d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface Rigidbody extends Fields {
  get velocity(): Vec3;
  set velocity(value: Vec2 | Vec3);
  readonly speed: number;
  impulse(impulse: Vec2 | Vec3, options?: { at?: Vec2 | Vec3 }): void;
  force(force: Vec2 | Vec3): void;
  teleport(position: Vec2 | Vec3, options?: { rotation?: number; keep_velocity?: boolean }): void;
}

interface Game {
  readonly kernel: Kernel;
  readonly physics: PhysicsNamespace;
  id(placed: string): EntityId;
  pos(placed: string): Vec3;
  body(placed: string): Rigidbody;
  steps(n: number): void;
}

function game(
  data: { prefabs: Record<string, unknown>; entities: unknown[] },
  options: Physics2dOptions = {},
  behaviors: BehaviorDef[] = [],
): Game {
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
    kernel,
    physics,
    id,
    pos: (placed) => kernel.world.require(id(placed)).transform.position,
    body: (placed) => kernel.world.require(id(placed)).components.get('rigidbody') as Rigidbody,
    steps: (n) => {
      for (let i = 0; i < n; i++) kernel.step(DT);
    },
  };
}

/** A behavior that logs every listed event it hears as `[method, self, payload]`. */
function listener(id: string, log: Array<[string, EntityId, Fields]>, events: Record<string, EventDef>): BehaviorDef {
  return {
    id,
    params: {},
    state: {},
    requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([method, this['entity'] as EntityId, e]);
    }])) as LogicInstance,
  };
}

const BALL = { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.5 } } };
const FLOOR = { components: { collider: { shape: 'box', size: [20, 1] } } };

describe('dispose', () => {
  it('kernel.dispose() frees the Rapier world and its event queue; a second runtime runs', () => {
    const worldFree = vi.spyOn(rapier().World.prototype, 'free');
    const queueFree = vi.spyOn(rapier().EventQueue.prototype, 'free');
    try {
      const first = game({ prefabs: { ball: BALL, floor: FLOOR }, entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3] }] });
      first.steps(10);
      first.kernel.dispose();
      expect(worldFree).toHaveBeenCalledTimes(1);
      expect(queueFree).toHaveBeenCalledTimes(1);
      const second = game({ prefabs: { ball: BALL, floor: FLOOR }, entities: [{ prefab: 'floor' }, { prefab: 'ball', id: 'ball', at: [0, 3] }] });
      second.steps(120);
      expect(second.pos('ball').y).toBeCloseTo(1, 1);
    } finally {
      worldFree.mockRestore();
      queueFree.mockRestore();
    }
  });
});

describe('gravity', () => {
  it('defaults to exactly -9.8 m/s² and applies nothing more', () => {
    const g = game({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [0, 10] }] });
    expect(g.physics.gravity).toBe(-9.8);
    g.steps(60);
    // Semi-implicit Euler at 60 Hz: v = g·t exactly, y = y0 + g·dt²·n(n+1)/2.
    expect(g.body('ball').velocity.y).toBeCloseTo(-9.8, 4);
    expect(g.pos('ball').y).toBeCloseTo(10 - 4.9, 0);
    expect(Math.abs(g.pos('ball').y - (10 - 4.9))).toBeLessThan(0.1);
  });

  it('uses the configured gravity and gravity_scale', () => {
    const g = game({
      prefabs: { ball: BALL, floaty: { components: { rigidbody: { gravity_scale: 0.5 } } } },
      entities: [{ prefab: 'ball', id: 'still', at: [0, 3] }, { prefab: 'floaty', id: 'floaty', at: [5, 3] }],
    }, { gravity: 0 });
    g.steps(30);
    expect(g.pos('still').y).toBe(3);
    const h = game({ prefabs: { floaty: { components: { rigidbody: { gravity_scale: 0.5 } } } }, entities: [{ prefab: 'floaty', id: 'f', at: [0, 0] }] }, { gravity: -20 });
    h.steps(60);
    expect(h.body('f').velocity.y).toBeCloseTo(-10, 4);
  });
});

describe('contacts', () => {
  it('a ball with bounce=1 keeps bouncing to its starting height on a static floor', () => {
    const g = game({
      prefabs: { ball: { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.5, bounce: 1 } } }, floor: FLOOR },
      entities: [{ prefab: 'floor', at: [0, -0.5] }, { prefab: 'ball', id: 'ball', at: [0, 5] }],
    });
    const peaks: number[] = [];
    let rising = false;
    let last = g.pos('ball').y;
    for (let i = 0; i < 60 * 8; i++) {
      g.steps(1);
      const y = g.pos('ball').y;
      if (rising && y < last) peaks.push(last);
      rising = y > last;
      last = y;
    }
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    for (const peak of peaks) expect(peak).toBeGreaterThan(5 * 0.97);
    expect(g.pos('ball').y).toBeGreaterThan(0.45); // never sinks into the floor
  });

  it('nothing collides without a collider; a rigidbody alone falls through', () => {
    const g = game({
      prefabs: { ghost: { components: { rigidbody: {} } }, floor: FLOOR },
      entities: [{ prefab: 'floor', at: [0, -0.5] }, { prefab: 'ghost', id: 'ghost', at: [0, 1] }],
    });
    g.steps(60);
    expect(g.pos('ghost').y).toBeLessThan(-3);
  });

  it('emits collided to each participant only, with the normal pointing at it', () => {
    const log: Array<[string, EntityId, Fields]> = [];
    const events = { hit: PHYSICS_EVENTS.collided, ended: PHYSICS_EVENTS.collisionEnded, entered: PHYSICS_EVENTS.triggerEntered };
    const g = game({
      prefabs: {
        ball: { ...BALL, behaviors: { ball_log: {} } },
        floor: { ...FLOOR, behaviors: { floor_log: {} } },
      },
      entities: [
        { prefab: 'floor', id: 'floor', at: [0, -0.5] },
        { prefab: 'ball', id: 'faller', at: [0, 1] },
        { prefab: 'ball', id: 'bystander', at: [50, 1] },
      ],
    }, {}, [listener('ball_log', log, events), listener('floor_log', log, events)]);
    g.steps(60);
    const hits = log.filter(([method]) => method === 'hit');
    expect(hits.length).toBe(2);
    const [toFaller, toFloor] = [g.id('faller'), g.id('floor')].map((id) => hits.find(([, self]) => self === id)!);
    expect(toFaller![2]['entity']).toBe(g.id('faller'));
    expect(toFaller![2]['target']).toBe(g.id('floor'));
    expect((toFaller![2]['normal'] as Vec3).y).toBeCloseTo(1, 3);
    expect((toFloor![2]['normal'] as Vec3).y).toBeCloseTo(-1, 3);
    expect((toFaller![2]['point'] as Vec3).y).toBeCloseTo(0, 1);
    expect(toFaller![2]['impulse']).toBeGreaterThan(0);
    expect(log.some(([, self]) => self === g.id('bystander'))).toBe(false);
    expect(log.some(([method]) => method === 'entered')).toBe(false);
  });

  it('emits trigger_entered and trigger_exited to the trigger, and triggers do not block', () => {
    const log: Array<[string, EntityId, Fields]> = [];
    const events = { entered: PHYSICS_EVENTS.triggerEntered, exited: PHYSICS_EVENTS.triggerExited, hit: PHYSICS_EVENTS.collided };
    const g = game({
      prefabs: {
        ball: { ...BALL, behaviors: { ball_log: {} } },
        zone: { components: { collider: { size: [4, 1], trigger: true } }, behaviors: { zone_log: {} } },
      },
      entities: [{ prefab: 'zone', id: 'zone', at: [0, 0] }, { prefab: 'ball', id: 'ball', at: [0, 3] }],
    }, {}, [listener('ball_log', log, events), listener('zone_log', log, events)]);
    g.steps(90);
    expect(g.pos('ball').y).toBeLessThan(-2);
    expect(log.map(([method, self, e]) => [method, self, e['entity'], e['target']])).toEqual([
      ['entered', g.id('zone'), g.id('zone'), g.id('ball')],
      ['exited', g.id('zone'), g.id('zone'), g.id('ball')],
    ]);
  });

  it('a static trigger reports a kinematic body moved through it', () => {
    const log: Array<[string, EntityId, Fields]> = [];
    const g = game({
      prefabs: {
        runner: { components: { rigidbody: { kind: 'kinematic' }, collider: { size: [1, 1] } } },
        coin: { components: { collider: { shape: 'circle', radius: 0.5, trigger: true } }, behaviors: { coin_log: {} } },
      },
      entities: [{ prefab: 'coin', id: 'coin', at: [3, 0] }, { prefab: 'runner', id: 'runner', at: [0, 0] }],
    }, {}, [listener('coin_log', log, { entered: PHYSICS_EVENTS.triggerEntered })]);
    const runner = g.kernel.world.require(g.id('runner')).transform;
    for (let i = 0; i < 30; i++) {
      runner.position = runner.position.__add__(new Vec3(0.2, 0, 0));
      g.steps(1);
    }
    expect(log.map(([, self, e]) => [self, e['target']])).toEqual([[g.id('coin'), g.id('runner')]]);
  });
});

describe('layers', () => {
  const prefabs = {
    enemy_wall: { components: { collider: { size: [1, 4], layer: 'enemy' } } },
    player_wall: { components: { collider: { size: [1, 4], layer: 'player' } } },
    sensor: { components: { collider: { size: [1, 4], trigger: true } } },
  };
  const entities = [
    { prefab: 'sensor', id: 'sensor', at: [2, 0] },
    { prefab: 'enemy_wall', id: 'enemy', at: [5, 0] },
    { prefab: 'player_wall', id: 'player', at: [10, 0] },
  ];

  it('raycasts hit the nearest solid collider, filtered by layer and ignore', () => {
    const g = game({ prefabs, entities }, { layers: ['player', 'enemy'] });
    g.steps(1);
    const ray = (options = {}): Hit | null => g.physics.raycast(Vec2.ZERO, Vec2.RIGHT, 1000, options);
    expect(ray()).toMatchObject({ entity: g.id('enemy'), distance: 4.5 });
    expect(ray()!.point.is_close(new Vec3(4.5, 0, 0))).toBe(true);
    expect(ray()!.normal.is_close(new Vec3(-1, 0, 0))).toBe(true);
    expect(ray({ layers: [{ name: 'player' }] })).toMatchObject({ entity: g.id('player'), distance: 9.5 });
    expect(ray({ ignore: [g.id('enemy')] })).toMatchObject({ entity: g.id('player') });
    expect(g.physics.raycast(Vec2.ZERO, Vec2.RIGHT, 4)).toBeNull();
    expect(g.physics.raycast_all(new Vec3(0, 0, 7), new Vec3(1, 0, 0)).map((h) => h.entity)).toEqual([g.id('enemy'), g.id('player')]);
    expect(() => ray({ layers: ['enemey'] })).toThrow(/PP3104[\s\S]*Did you mean "enemy"/);
  });

  it('takes Python keyword arguments (the api passes them as a trailing Kwargs value)', () => {
    class Kwargs { constructor(readonly values: Record<string, unknown>) {} }
    const g = game({ prefabs, entities }, { layers: ['player', 'enemy'] });
    g.steps(1);
    expect(g.physics.raycast(Vec2.ZERO, Vec2.RIGHT, new Kwargs({ max_distance: 6, layers: ['player'] }))).toBeNull();
    expect(g.physics.raycast(Vec2.ZERO, new Kwargs({ direction: Vec2.RIGHT, layers: ['player'] }))).toMatchObject({ distance: 9.5 });
    expect(() => g.physics.raycast(Vec2.ZERO, Vec2.RIGHT, new Kwargs({ layer: ['player'] }))).toThrow(/PP3030/);
  });

  it('overlap queries include triggers and honour layers', () => {
    const g = game({ prefabs, entities }, { layers: ['player', 'enemy'] });
    g.steps(1);
    expect(g.physics.overlap(new Vec2(3.5, 0), 1.2)).toEqual([g.id('sensor'), g.id('enemy')]);
    expect(g.physics.overlap(new Vec2(3.5, 0), 1.2, { layers: ['enemy'] })).toEqual([g.id('enemy')]);
    expect(g.physics.overlap_box(new Vec2(7.5, 0), new Vec2(6, 1))).toEqual([g.id('enemy'), g.id('player')]);
  });

  it('a pair collides only when each side lists the other layer', () => {
    const g = game({
      prefabs: {
        ghost: { components: { rigidbody: {}, collider: { shape: 'circle', layer: 'ghost', collides_with: ['player'] } } },
        ball: BALL,
        floor: FLOOR,
      },
      entities: [{ prefab: 'floor', at: [0, -0.5] }, { prefab: 'ghost', id: 'ghost', at: [0, 1] }, { prefab: 'ball', id: 'ball', at: [5, 1] }],
    }, { layers: ['player', 'ghost'] });
    g.steps(60);
    expect(g.pos('ghost').y).toBeLessThan(-3);
    expect(g.pos('ball').y).toBeCloseTo(0.5, 1);
  });

  it('rejects an undeclared collider layer with a suggestion, when the scene loads', () => {
    expect(() => game({
      prefabs: { wall: { components: { collider: { layer: 'playr' } } } },
      entities: [{ prefab: 'wall' }],
    }, { layers: ['player'] })).toThrow(/PP3104[\s\S]*"player"/);
  });
});

describe('rigidbody methods', () => {
  it('velocity reads and takes a Vec2 or Vec3; impulse and one-step force scale by mass', () => {
    const g = game({
      prefabs: { puck: { components: { rigidbody: { mass: 2 }, collider: { shape: 'circle' } } } },
      entities: [{ prefab: 'puck', id: 'puck' }],
    }, { gravity: 0 });
    const body = g.body('puck');
    body.velocity = new Vec2(3, 4);
    expect(body.speed).toBeCloseTo(5);
    body.velocity = Vec3.ZERO;
    body.impulse(new Vec2(4, 0));
    expect(body.velocity.x).toBeCloseTo(2);
    body.force(new Vec2(120, 0));
    g.steps(1);
    expect(body.velocity.x).toBeCloseTo(2 + 120 / 2 * DT);
    g.steps(1);
    expect(body.velocity.x).toBeCloseTo(2 + 120 / 2 * DT); // the force lasted one step
    expect(g.pos('puck').x).toBeGreaterThan(0);
    expect(() => { body.velocity = 3 as unknown as Vec2; }).toThrow(/PP3300/);
  });

  it('angular_velocity is degrees per second, read back each step; lock_rotation holds the angle', () => {
    const g = game({
      prefabs: {
        spinner: { components: { rigidbody: {}, collider: {} } },
        locked: { components: { rigidbody: { lock_rotation: true }, collider: {} } },
      },
      entities: [{ prefab: 'spinner', id: 'spinner' }, { prefab: 'locked', id: 'locked', at: [5, 0] }],
    }, { gravity: 0 });
    g.body('spinner')['angular_velocity'] = new Vec3(0, 0, 90);
    g.body('locked')['angular_velocity'] = new Vec3(0, 0, 90);
    g.steps(60);
    const angle = (placed: string): number => g.kernel.world.require(g.id(placed)).transform.rotation.angle();
    expect(angle('spinner')).toBeCloseTo(90, 1);
    expect((g.body('spinner')['angular_velocity'] as Vec3).z).toBeCloseTo(90, 2);
    expect(angle('locked')).toBeCloseTo(0, 6);
  });

  it('teleport moves body and transform now, zeroing velocity unless kept', () => {
    const g = game({ prefabs: { ball: BALL }, entities: [{ prefab: 'ball', id: 'ball', at: [0, 10] }] });
    g.steps(30);
    const body = g.body('ball');
    body.teleport(new Vec2(3, 4), { rotation: 45 });
    expect(g.pos('ball').is_close(new Vec3(3, 4, 0))).toBe(true);
    expect(body.velocity.is_close(Vec3.ZERO)).toBe(true);
    g.steps(1);
    expect(g.pos('ball').x).toBeCloseTo(3);
    expect(g.pos('ball').y).toBeLessThan(4);
    expect(g.pos('ball').y).toBeGreaterThan(4 - 9.8 * DT * DT * 1.01);
    expect(g.kernel.world.require(g.id('ball')).transform.rotation.angle()).toBeCloseTo(45);
    const before = body.velocity.y;
    body.teleport(new Vec3(0, 20, 0), { keep_velocity: true });
    expect(body.velocity.y).toBe(before);
  });

  it('a kinematic body follows its transform and pushes dynamic bodies', () => {
    const g = game({
      prefabs: {
        paddle: { components: { rigidbody: { kind: 'kinematic' }, collider: { size: [1, 2] } } },
        box: { components: { rigidbody: {}, collider: {} } },
      },
      entities: [{ prefab: 'paddle', id: 'paddle', at: [0, 0] }, { prefab: 'box', id: 'box', at: [3, 0] }],
    }, { gravity: 0 });
    const paddle = g.kernel.world.require(g.id('paddle')).transform;
    for (let i = 0; i < 60; i++) {
      paddle.position = paddle.position.__add__(new Vec3(0.05, 0, 0));
      g.steps(1);
    }
    expect(g.body('paddle').velocity.x).toBeCloseTo(3, 4);
    expect(paddle.position.x).toBeCloseTo(3);
    expect(g.pos('box').x).toBeGreaterThan(3.5); // pushed ahead of the paddle
    g.steps(1);
    expect(g.physics.raycast(new Vec2(3, 5), Vec2.DOWN)).toMatchObject({ entity: g.id('paddle') });
  });

  it('a kinematic body moves by its velocity and angular_velocity each step', () => {
    const g = game({
      prefabs: { paddle: { components: { rigidbody: { kind: 'kinematic' }, collider: { size: [1, 2] } } } },
      entities: [{ prefab: 'paddle', id: 'paddle', at: [0, 0] }],
    }, { gravity: 0 });
    const body = g.body('paddle');
    body.velocity = new Vec2(3, 0);
    expect(body.velocity.x).toBe(3);
    g.steps(60);
    expect(g.pos('paddle').x).toBeCloseTo(3, 6);
    expect(body.velocity.x).toBeCloseTo(3, 4);
    const snap = g.kernel.snapshot();
    body.velocity = Vec2.ZERO;
    g.kernel.restore(snap);
    g.steps(60);
    expect(g.pos('paddle').x).toBeCloseTo(6, 6);
    g.body('paddle').teleport(new Vec3(0, 0, 0)); // clears the velocity: it stays put below
    g.body('paddle').angular_velocity = new Vec3(0, 0, 90);
    g.steps(30);
    expect(g.kernel.world.require(g.id('paddle')).transform.rotation.angle()).toBeCloseTo(45, 3);
    expect(g.pos('paddle').x).toBe(0);
  });

  it('a static collider moved by its transform is moved in the simulation', () => {
    const g = game({ prefabs: { wall: FLOOR }, entities: [{ prefab: 'wall', id: 'wall', at: [0, 0] }] });
    g.steps(1);
    g.kernel.world.require(g.id('wall')).transform.position = new Vec3(0, -3, 0);
    g.steps(1);
    expect(g.physics.raycast(Vec2.ZERO, Vec2.DOWN)?.distance).toBeCloseTo(2.5);
  });
});

describe('lifecycle', () => {
  it('a destroyed entity loses its body', () => {
    const g = game({
      prefabs: { ball: BALL, floor: FLOOR },
      entities: [{ prefab: 'floor', id: 'floor', at: [0, -0.5] }, { prefab: 'ball', id: 'ball', at: [0, 1] }],
    });
    g.steps(60);
    expect(g.pos('ball').y).toBeCloseTo(0.5, 1);
    const ball = g.id('ball');
    g.kernel.destroy(g.id('floor'));
    // Already gone from queries in the same frame (dead entities are filtered)…
    expect(g.physics.raycast(new Vec2(5, 5), Vec2.DOWN)).toBeNull();
    g.steps(60);
    // …and from the simulation after the next step: the ball falls.
    expect(g.kernel.world.require(ball).transform.position.y).toBeLessThan(-3);
  });

  it('spawned entities get bodies; scene reloads replace them', () => {
    const g = game({ prefabs: { ball: BALL, floor: FLOOR }, entities: [{ prefab: 'floor', at: [0, -0.5] }] });
    const ball = g.kernel.spawn('ball', { at: [0, 2] });
    ball.components.get('rigidbody')!['velocity'] = new Vec2(1, 0);
    g.steps(60);
    expect(ball.transform.position.y).toBeCloseTo(0.5, 1);
    expect(ball.transform.position.x).toBeGreaterThan(0.5);
    g.kernel.requestScene('main');
    g.steps(1); // the reload happens at the end of this frame
    g.steps(1); // and the new scene's first physics step
    expect(g.physics.overlap(new Vec2(0, -0.5), 0.1)).toEqual([...g.kernel.world.live()].map((r) => r.id));
  });

  it('is deterministic: the same inputs give the same positions', () => {
    const run = (): number[] => {
      const g = game({
        prefabs: { ball: { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.4, bounce: 0.3 } } }, floor: FLOOR },
        entities: [
          { prefab: 'floor', at: [0, -0.5] },
          ...Array.from({ length: 12 }, (_, i) => ({ prefab: 'ball', at: [(i % 4) * 0.5 - 1, 1 + i * 0.9] })),
        ],
      });
      g.steps(240);
      return [...g.kernel.world.live()].flatMap((r) => [r.transform.position.x, r.transform.position.y, r.transform.rotation.z]);
    };
    expect(run()).toEqual(run());
  });
});

describe('explode', () => {
  it('pushes dynamic bodies in range away from the centre and returns what it touched', () => {
    const g = game({
      prefabs: { box: { components: { rigidbody: {}, collider: {} } }, wall: FLOOR },
      entities: [
        { prefab: 'box', id: 'left', at: [-2, 0] },
        { prefab: 'box', id: 'right', at: [2, 0] },
        { prefab: 'box', id: 'far', at: [20, 0] },
        { prefab: 'wall', id: 'wall', at: [0, -3] },
      ],
    }, { gravity: 0 });
    g.steps(1);
    const touched = g.physics.explode(Vec2.ZERO, 4, 10);
    expect(touched).toEqual([g.id('left'), g.id('right'), g.id('wall')]);
    expect(g.body('left').velocity.x).toBeCloseTo(-5);
    expect(g.body('right').velocity.x).toBeCloseTo(5);
    expect(g.body('far').velocity.x).toBe(0);
  });
});

describe('snapshot and restore', () => {
  it('bring bodies back with their positions and velocities', () => {
    const g = game({
      prefabs: { ball: { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.5 } } } },
      entities: [{ prefab: 'ball', id: 'ball', at: [0, 10] }],
    });
    g.steps(30);
    const saved = g.kernel.snapshot();
    g.steps(30);
    const first = [g.pos('ball').y, g.body('ball').velocity.y];
    g.kernel.restore(saved);
    g.steps(30);
    expect([g.pos('ball').y, g.body('ball').velocity.y]).toEqual(first);
  });
});
