/**
 * The vehicle depth components on the real physics3d: drivetrain and gears, surfaces,
 * damage and flooding, simulation tiers, exit points, effects and Model joint drivers,
 * carrier ride.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, EventDef, Fields, LogicInstance } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import { characters } from '../characters/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { water } from '../water/index.js';
import { engagedRpm, freshDrivetrain, LAUNCH_RPM, stepDrivetrain, torqueAt } from './drivetrain.js';
import type { DrivetrainFields } from './drivetrain.js';
import { assignTiers } from './tiers.js';
import { DRIVETRAIN_SCHEMA, VEHICLE_EVENTS, vehicles } from './index.js';
import type { VehiclesOptions } from './index.js';

const DT = 1 / 60;
/** Still sea at y = 0 for the boats (they float on Buoyancy). */
const SEA = { components: { water_body: { kind: 'ocean', waves: 'none' } } };

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

type Log = Array<[string, Fields]>;

function listener(log: Log, events: Record<string, EventDef>): BehaviorDef {
  return {
    id: 'watch', params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([method, e]);
    }])) as LogicInstance,
  };
}

/** Stand-ins for the components other plugins define (the vehicles plugin reads them by id). */
const PRESENTATION: ComponentDef[] = [
  { id: 'particles', schema: { emitting: { type: { kind: 'bool' }, default: false }, rate_scale: { type: { kind: 'number' }, default: 1 } } },
  { id: 'audio_source', schema: {
    playing: { type: { kind: 'bool' }, default: false }, pitch: { type: { kind: 'number' }, default: 1 }, volume: { type: { kind: 'number' }, default: 1 },
  } },
  { id: 'model', schema: { joints: { type: { kind: 'json' }, default: {} }, parts: { type: { kind: 'json' }, default: {} } } },
  { id: 'camera', schema: {} },
];

function game(prefabs: Record<string, unknown>, entities: unknown[], options: VehiclesOptions = {}, log: Log = []) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics.map((d) => d.message)).toEqual([]);
  const watch = listener(log, Object.fromEntries(Object.entries(VEHICLE_EVENTS)));
  const kernel = new Kernel({
    project, game: { components: PRESENTATION, resources: [], events: [], behaviors: [watch], systems: [] },
    plugins: [physics3d({ materials: { ice: { friction: 0.05, bounce: 0, sound: null, impact_speed: 1000 } } }), characters(), water(), vehicles(options)],
    context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  const get = (placed: string, component: string) => kernel.world.require(id(placed)).components.get(component) as Fields & Record<string, any>;
  return {
    kernel, log, id, get,
    pos: (placed: string) => kernel.world.require(id(placed)).transform.position,
    yaw: (placed: string) => kernel.world.require(id(placed)).transform.rotation.to_euler().y,
    vehicle: (placed: string) => get(placed, 'vehicle'),
    body: (placed: string) => kernel.service(PHYSICS3D_SERVICE).body(id(placed))!,
    run: (frames: number, each?: () => void) => {
      for (let i = 0; i < frames; i++) {
        each?.();
        kernel.step(DT);
      }
    },
  };
}

const ROAD = { components: { collider: { shape: 'box', size: [4000, 1, 4000], offset: [0, -0.5, 0] } } };
const ICE = { components: { collider: { shape: 'box', size: [4000, 1, 4000], offset: [0, -0.5, 0], material: 'ice' } } };
const CHASSIS = {
  rigidbody: { kind: 'dynamic', mass: 1300, linear_damping: 0.025, angular_damping: 0.85 },
  collider: { shape: 'box', size: [1.6, 1.1, 2.25], offset: [0, 0.55, 0], friction: 0.4, bounce: 0.1 },
};
const CAR = { components: { ...CHASSIS, vehicle: { kind: 'car', max_speed: 60, acceleration: 10, braking: 20, steering: 35, grip: 1 } } };
const defaults = (schema: Record<string, { default?: unknown }>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default]));

describe('drivetrain (pure)', () => {
  const d = defaults(DRIVETRAIN_SCHEMA) as unknown as DrivetrainFields;

  it('torque curve peaks at peak_rpm and the limiter cuts at the redline', () => {
    expect(torqueAt(d, d.peak_rpm)).toBeCloseTo(d.peak_torque, 6);
    expect(torqueAt(d, d.idle_rpm)).toBeCloseTo(0.55 * d.peak_torque, 6);
    expect(torqueAt(d, d.redline_rpm - 1)).toBeCloseTo(0.7 * d.peak_torque, 0);
    expect(torqueAt(d, d.redline_rpm)).toBe(0);
    expect(torqueAt(d, 3000)).toBeLessThan(torqueAt(d, 4000));
  });

  it('rpm is derived from wheel speed through the gearing; an upshift drops the revs', () => {
    const r = 0.33;
    const first = engagedRpm(d, 1, 10, r);
    expect(first).toBeCloseTo((10 / r) * (60 / (2 * Math.PI)) * 3.4 * 3.9, 6);
    expect(engagedRpm(d, 2, 10, r) / first).toBeCloseTo(2.1 / 3.4, 6);
    const s = freshDrivetrain(d);
    // Run the automatic box up through the gears with speed rising.
    const gears: number[] = [];
    for (let v = 0; v < 80; v += 0.05) {
      stepDrivetrain(d, s, { throttle: 1, speed: v, radius: r, dt: DT });
      if (gears.at(-1) !== s.gear) gears.push(s.gear);
    }
    expect(gears).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.rpm).toBeLessThanOrEqual(d.redline_rpm);
  });

  it('the clutch slips at a standstill; no drive while shifting; reverse from a stop', () => {
    const s = freshDrivetrain(d);
    const out = stepDrivetrain(d, s, { throttle: 1, speed: 0, radius: 0.33, dt: DT });
    expect(s.clutch).toBe(0);
    expect(s.rpm).toBeCloseTo(LAUNCH_RPM, 6);
    expect(out.force).toBeGreaterThan(0);
    const back = freshDrivetrain(d);
    stepDrivetrain(d, back, { throttle: -1, speed: 0, radius: 0.33, dt: DT });
    expect(back.gear).toBe(-1);
    expect(back.shifting).toBeGreaterThan(0);
    expect(stepDrivetrain(d, back, { throttle: -1, speed: 0, radius: 0.33, dt: DT }).force).toBe(0);
    stepDrivetrain(d, back, { throttle: -1, speed: 0, radius: 0.33, dt: d.shift_time });
    expect(stepDrivetrain(d, back, { throttle: -1, speed: 0, radius: 0.33, dt: DT }).force).toBeLessThan(0);
  });
});

describe('cars with a drivetrain', () => {
  const GT = { components: {
    ...CAR.components, drivetrain: { gearbox: 'auto' }, vehicle_effects: { exhaust: 'exhaust', engine_sound: 'engine', tire_smoke: 'smoke' },
  }, children: [
    { name: 'exhaust', prefab: 'fx_particles' }, { name: 'engine', prefab: 'fx_audio' }, { name: 'smoke', prefab: 'fx_particles' },
  ], behaviors: { watch: {} } };
  const FX = { fx_particles: { components: { particles: {} } }, fx_audio: { components: { audio_source: {} } } };

  it('pulls away in first, shifts up through the gears with the revs falling at each shift, effects follow', () => {
    const g = game({ road: ROAD, gt: GT, ...FX }, [{ prefab: 'road' }, { prefab: 'gt', id: 'car', at: [0, 0.2, 0] }]);
    g.run(30);
    const car = g.vehicle('car');
    const dt = g.get('car', 'drivetrain');
    let maxRpm = 0;
    const shifts: number[] = [];
    g.run(20 * 60, () => {
      car.drive({ throttle: 1 });
      maxRpm = Math.max(maxRpm, dt.rpm as number);
      if (dt.gear !== (shifts.at(-1) ?? 1)) shifts.push(dt.gear as number);
    });
    expect(shifts.slice(0, 3)).toEqual([2, 3, 4]);
    expect(dt.gear).toBeGreaterThanOrEqual(4);
    expect(car.speed).toBeGreaterThan(35);
    expect(maxRpm).toBeLessThanOrEqual(6800);
    const exhaust = g.kernel.world.require(g.kernel.world.require(g.id('car')).children[0]!).components.get('particles')!;
    expect(exhaust['emitting']).toBe(true);
    expect(exhaust['rate_scale']).toBeCloseTo(2, 6);
    const engine = [...g.kernel.world.require(g.id('car')).children].map((c) => g.kernel.world.require(c).components.get('audio_source')).find(Boolean)!;
    expect(engine['playing']).toBe(true);
    expect(engine['pitch'] as number).toBeGreaterThan(1);
  });

  it('reports each wheel\'s ground material; only the handbrake at speed skids', () => {
    const run = (ground: object) => {
      const g = game({ ground, gt: GT, ...FX }, [{ prefab: 'ground' }, { prefab: 'gt', id: 'car', at: [0, 0.2, 0] }]);
      g.run(30);
      let skidded = false;
      g.run(180, () => {
        g.vehicle('car').drive({ throttle: 1 });
        skidded ||= g.vehicle('car').skidding;
      });
      let handbrake = false;
      g.run(30, () => {
        g.vehicle('car').drive({ handbrake: true });
        handbrake ||= g.vehicle('car').skidding;
      });
      return { skidded, handbrake, surfaces: g.vehicle('car').surfaces };
    };
    const road = run(ROAD);
    const ice = run(ICE);
    expect(ice.surfaces).toEqual(['ice', 'ice', 'ice', 'ice']);
    expect(road.surfaces).toEqual([null, null, null, null]);
    expect(road.skidded).toBe(false);
    expect(road.handbrake).toBe(true);
  });

  it('snapshot / restore keeps gear and rpm', () => {
    const g = game({ road: ROAD, gt: GT, ...FX }, [{ prefab: 'road' }, { prefab: 'gt', id: 'car', at: [0, 0.2, 0] }]);
    g.run(30);
    g.run(300, () => g.vehicle('car').drive({ throttle: 1 }));
    const snap = g.kernel.snapshot();
    const gear = g.get('car', 'drivetrain').gear;
    const rpm = g.get('car', 'drivetrain').rpm;
    g.run(120, () => g.vehicle('car').drive({ brake: 1 }));
    g.kernel.restore(snap);
    expect(g.get('car', 'drivetrain').gear).toBe(gear);
    expect(g.get('car', 'drivetrain').rpm).toBe(rpm);
  });
});

describe('damage and flooding', () => {
  const PARTS = [
    { name: 'engine', role: 'engine', at: [0, 0.5, 0.9], radius: 0.6, health: 50, model_part: 'hood' },
    { name: 'body', role: 'body', at: [0, 0.6, 0], radius: 1.2, health: 200 },
  ];

  it('a hit at the engine damages it, a dead engine stops the car; repair() restores it', () => {
    const log: Log = [];
    const truck = { components: { ...CAR.components, vehicle_damage: { parts: PARTS }, model: {} }, behaviors: { watch: {} } };
    const g = game({ road: ROAD, t: truck }, [{ prefab: 'road' }, { prefab: 't', id: 't', at: [0, 0.2, 0] }], {}, log);
    g.run(30);
    const dmg = g.get('t', 'vehicle_damage');
    const world = g.kernel.world.require(g.id('t')).transform.toWorld(new Vec3(0, 0.5, 1));
    expect(dmg.damage(20, { at: world })).toBe(20);
    expect(dmg.health).toEqual({ engine: 30 });
    expect(dmg.fraction('engine')).toBeCloseTo(0.6, 9);
    dmg.damage(100, { part: 'engine' });
    g.run(1);
    expect(log.filter(([m]) => m === 'partDestroyed').map(([, e]) => e['part'])).toEqual(['engine']);
    expect(g.get('t', 'model').parts).toEqual({ hood: false });
    expect(dmg.wrecked).toBe(false); // the engine doesn't wreck it; the body would
    g.run(120, () => g.vehicle('t').drive({ throttle: 1 }));
    expect(Math.abs(g.vehicle('t').speed)).toBeLessThan(0.5);
    dmg.repair();
    expect(g.get('t', 'model').parts).toEqual({ hood: true });
    g.run(120, () => g.vehicle('t').drive({ throttle: 1 }));
    expect(g.vehicle('t').speed).toBeGreaterThan(5);
    expect(() => dmg.damage(1, { part: 'wing' })).toThrow(/PP7303/);
    dmg.damage(500, { part: 'body' });
    g.run(1);
    expect(dmg.wrecked).toBe(true);
    expect(log.filter(([m]) => m === 'wrecked').map(([, e]) => e['reason'])).toEqual(['destroyed']);
  });

  it('a holed hull floods, the boat slows and sits lower, then sinks', () => {
    const log: Log = [];
    const boat = { components: {
      rigidbody: { kind: 'dynamic', mass: 2400 },
      collider: { shape: 'box', size: [3, 0.85, 4.4], offset: [0, 0.43, 0] },
      vehicle: { kind: 'boat', max_speed: 8, acceleration: 2, braking: 3 },
      buoyancy: {},
      vehicle_damage: { parts: [{ name: 'hull', role: 'hull', health: 100 }], leak_rate: 0.1, pump_rate: 0.02 },
    }, behaviors: { watch: {} } };
    const g = game({ sea: SEA, boat }, [{ prefab: 'sea' }, { prefab: 'boat', id: 'b', at: [0, -0.18, 0] }], {}, log);
    g.run(600, () => g.vehicle('b').drive({ throttle: 1 }));
    const healthy = g.vehicle('b').speed;
    const afloat = g.pos('b').y;
    const dmg = g.get('b', 'vehicle_damage');
    dmg.damage(60, { part: 'hull' }); // 0.6 lost → 0.06 - 0.02 = 4% a second
    g.run(300, () => g.vehicle('b').drive({ throttle: 1 }));
    expect(dmg.flooded).toBeCloseTo(0.2, 1);
    expect(g.pos('b').y).toBeLessThan(afloat - 0.05);
    expect(g.vehicle('b').speed).toBeLessThan(healthy * 0.92);
    expect(dmg.wrecked).toBe(false);
    dmg.damage(40, { part: 'hull' });
    g.run(60 * 12);
    expect(dmg.wrecked).toBe(true);
    expect(log.filter(([m]) => m === 'wrecked').map(([, e]) => e['reason'])).toEqual(['destroyed']);
  });

  it('a hull leak alone sinks a boat (reason "sunk") when the part survives', () => {
    const log: Log = [];
    const boat = { components: {
      rigidbody: { kind: 'dynamic', mass: 2400 },
      collider: { shape: 'box', size: [3, 0.85, 4.4], offset: [0, 0.43, 0] },
      vehicle: { kind: 'boat' },
      buoyancy: {},
      vehicle_damage: { parts: [{ name: 'hull', role: 'hull', health: 100, wrecks: false }], leak_rate: 0.5, pump_rate: 0, sink_at: 0.5 },
    }, behaviors: { watch: {} } };
    const g = game({ sea: SEA, boat }, [{ prefab: 'sea' }, { prefab: 'boat', id: 'b', at: [0, -0.18, 0] }], {}, log);
    g.run(10);
    g.get('b', 'vehicle_damage').damage(50, { part: 'hull' });
    g.run(150);
    expect(log.filter(([m]) => m === 'wrecked').map(([, e]) => e['reason'])).toEqual(['sunk']);
    const y = g.pos('b').y;
    g.run(60);
    expect(g.pos('b').y).toBeLessThan(y - 1); // full of water, it goes down
  });

  it('impacts over impact_threshold damage the part nearest the contact', () => {
    const car = { components: { ...CAR.components, vehicle_damage: { parts: PARTS, impact_threshold: 5000 } } };
    const wall = { components: { collider: { shape: 'box', size: [10, 4, 1] } } };
    const g = game({ road: ROAD, car, wall }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }, { prefab: 'wall', at: [0, 2, 25] }]);
    g.run(30);
    g.run(240, () => g.vehicle('car').drive({ throttle: 1 }));
    const health = g.get('car', 'vehicle_damage').health as Record<string, number>;
    expect(health['engine'] ?? 50).toBeLessThan(50);
  });
});

describe('simulation tiers', () => {
  it('assigns full / simple / dormant by distance with a full budget, occupied pinned', () => {
    const at = (x: number) => new Vec3(x, 0, 0);
    const c = (e: number, x: number, pinned = false) => ({ entity: e as EntityId, position: at(x), pinned, current: 'full' as const });
    const tiers = assignTiers({ fullRange: 100, simpleRange: 300, maxFull: 2 }, [at(0)], [c(1, 10), c(2, 20), c(3, 30), c(4, 200), c(5, 900), c(6, 950, true)]);
    expect([...tiers]).toEqual([[6, 'full'], [1, 'full'], [2, 'simple'], [3, 'simple'], [4, 'simple'], [5, 'dormant']]);
    expect(assignTiers({ fullRange: 100, simpleRange: 300, maxFull: 2 }, [], [c(1, 1000)]).get(1 as EntityId)).toBe('full');
  });

  it('distant traffic drives on the simple tier (no wheels) and still follows its controls', () => {
    const cam = { components: { camera: {} } };
    const g = game({ road: ROAD, car: CAR, cam }, [
      { prefab: 'road' }, { prefab: 'cam', at: [0, 5, 0] }, { prefab: 'car', id: 'near', at: [0, 0.2, 5] }, { prefab: 'car', id: 'far', at: [300, 0.2, 0] },
      { prefab: 'car', id: 'gone', at: [0, 0.2, 1500] },
    ], { tiers: { fullRange: 100, simpleRange: 600, maxFull: 8 } });
    g.run(30);
    const y = g.pos('far').y;
    const parked = g.pos('gone');
    g.run(180, () => {
      g.vehicle('far').drive({ throttle: 1, steer: 0.05 });
      g.vehicle('gone').drive({ throttle: 1 });
    });
    expect(g.vehicle('far').speed).toBeGreaterThan(15);
    expect(g.yaw('far')).toBeGreaterThan(10);
    expect(Math.abs(g.pos('far').y - y)).toBeLessThan(0.15);
    expect(g.pos('gone').distance_to(parked)).toBeLessThan(0.05); // dormant: not driven at all
  });
});

describe('exits, seats, rig', () => {
  const PILOT = { components: { character: {} } };
  it('exits on the open side when one side is blocked; Seat children place riders', () => {
    const car = { components: CAR.components, children: [
      { name: 'driver_seat', at: [-0.4, 0.6, 0.1], components: { seat: { enter_time: 0 } } },
      { name: 'passenger_seat', at: [0.4, 0.6, 0.1], components: { seat: { enter_time: 0 } } },
    ] };
    const wall = { components: { collider: { shape: 'box', size: [1, 4, 20] } } };
    const g = game({ road: ROAD, car, pilot: PILOT, wall }, [
      { prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }, { prefab: 'pilot', id: 'me', at: [-6, 0, 0] }, { prefab: 'wall', at: [-1.8, 2, 0] },
    ]);
    g.run(30);
    const car_ = g.vehicle('car');
    car_.enter(g.id('me'));
    g.run(2);
    const local = g.kernel.world.require(g.id('car')).transform.toLocal(g.pos('me'));
    expect(local.x).toBeCloseTo(-0.4, 1);
    car_.exit(g.id('me'));
    const out = g.kernel.world.require(g.id('car')).transform.toLocal(g.pos('me'));
    expect(out.x).toBeGreaterThan(1); // the left is walled in: out on the right
  });

  it('the rig rolls wheel joints with distance, poses steering and control joints', () => {
    const car = { components: { ...CAR.components, model: {}, vehicle_rig: { wheels: ['wfl', 'wfr'], steer: ['sfl'], controls: { flap: 'steer' }, control_angle: 10 } } };
    const g = game({ road: ROAD, car }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }]);
    g.run(30);
    g.run(30, () => g.vehicle('car').drive({ throttle: 1, steer: 1 }));
    const joints = g.get('car', 'model').joints as Record<string, number>;
    expect(joints['wfl']).toBeGreaterThan(0);
    expect(joints['wfl']).toBe(joints['wfr']);
    expect(joints['sfl']).toBeGreaterThan(10);
    expect(joints['flap']).toBe(10);
  });
});

describe('carrier ride', () => {
  it('a character standing on a moving, turning boat deck stays aboard', () => {
    const ferry = { components: {
      rigidbody: { kind: 'dynamic', mass: 20000 },
      collider: { shape: 'box', size: [8, 1, 20], offset: [0, 0.5, 0] },
      vehicle: { kind: 'boat', max_speed: 6, acceleration: 1.5, turn_rate: 15 },
      buoyancy: {},
    } };
    // 20 t on 8 × 20 m: 0.125 m under.
    const g = game({ sea: SEA, ferry, pilot: PILOT_ON_DECK }, [
      { prefab: 'sea' }, { prefab: 'ferry', id: 'f', at: [0, -0.125, 0] }, { prefab: 'pilot', id: 'me', at: [0, 0.93, 4] },
    ]);
    g.run(30);
    g.run(600, () => g.vehicle('f').drive({ throttle: 1, steer: 0.5 }));
    expect(g.vehicle('f').speed).toBeGreaterThan(4);
    const local = g.kernel.world.require(g.id('f')).transform.toLocal(g.pos('me'));
    expect(Math.abs(local.x)).toBeLessThan(4);
    expect(Math.abs(local.z)).toBeLessThan(10);
    expect(local.y).toBeGreaterThan(0.9);
  });
});

const PILOT_ON_DECK = { components: { character: {} } };
