import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE, WEATHER_SERVICE } from '../../services/index.js';
import { characters } from '../characters/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { water } from '../water/index.js';
import { weather } from '../weather/index.js';
import type { WeatherPlugin } from '../weather/index.js';
import { LANDING_AIRTIME, stallSpeed, VEHICLE_EVENTS, vehicles } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

interface Vehicle extends Fields {
  drive(k: { throttle?: number; steer?: number; brake?: number; handbrake?: boolean }): void;
  fly(k: { throttle?: number; pitch?: number; roll?: number; yaw?: number; flaps?: number; airbrake?: boolean; brake?: number }): void;
  enter(driver: unknown, k?: { seat?: number }): boolean;
  exit(driver: unknown): boolean;
  readonly seats: unknown[];
  readonly riders: unknown[];
  refuel(liters: number): void;
  readonly driver: unknown;
  readonly speed: number;
  readonly grounded: boolean;
  readonly airborne: boolean;
  readonly slip: number;
  readonly drifting: boolean;
  readonly stalled: boolean;
}

type Log = Array<[string, EntityId, Fields]>;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function listener(log: Log, events: Record<string, EventDef>): BehaviorDef {
  return {
    id: 'watch', params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([method, this['entity'] as EntityId, e]);
    }])) as LogicInstance,
  };
}

const ROAD = { components: { collider: { shape: 'box', size: [2000, 1, 2000], offset: [0, -0.5, 0] } } };
/** racing's car_surge chassis. */
const CAR = { components: {
  rigidbody: { kind: 'dynamic', mass: 1300, linear_damping: 0.025, angular_damping: 0.85 },
  collider: { shape: 'box', size: [1.6, 1.1, 2.25], offset: [0, 0.55, 0], friction: 0.4, bounce: 0.1 },
  vehicle: { kind: 'car', max_speed: 30, acceleration: 10, braking: 20, steering: 35, grip: 1 },
}, behaviors: { watch: {} }, children: [
  { name: 'driver_seat', at: [0, 0.55, 0], components: { seat: { enter_time: 0 } } },
  { name: 'passenger_seat', at: [0.4, 0.55, 0], components: { seat: { enter_time: 0 } } },
] };

function game(prefabs: Record<string, unknown>, entities: unknown[], log: Log = [], extra: KernelPlugin[] = []) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const watch = listener(log, { entered: VEHICLE_EVENTS.entered, exited: VEHICLE_EVENTS.exited, landed: VEHICLE_EVENTS.landed });
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [watch], systems: [] },
    plugins: [physics3d(), characters(), water(), ...extra, vehicles()], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel, log, id,
    pos: (placed: string) => kernel.world.require(id(placed)).transform.position,
    yaw: (placed: string) => kernel.world.require(id(placed)).transform.rotation.to_euler().y,
    vehicle: (placed: string) => kernel.world.require(id(placed)).components.get('vehicle') as Vehicle,
    run: (frames: number, each?: () => void) => {
      for (let i = 0; i < frames; i++) {
        each?.();
        kernel.step(DT);
      }
    },
  };
}

describe('cars', () => {
  it('rests on its wheels just above the road, level', () => {
    const g = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.5, 0] }]);
    g.run(180);
    expect(g.pos('car').y).toBeGreaterThan(0.02);
    expect(g.pos('car').y).toBeLessThan(0.12);
    expect(g.vehicle('car').grounded).toBe(true);
    const r = g.kernel.world.require(g.id('car')).transform.rotation.to_euler();
    expect(Math.abs(r.x) + Math.abs(r.z)).toBeLessThan(0.5);
  });

  it('drives forward (+z) under throttle at `acceleration` up to max_speed, then brakes to a stop', () => {
    const g = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }]);
    g.run(60);
    const car = g.vehicle('car');
    g.run(60, () => car.drive({ throttle: 1 }));
    expect(car.speed).toBeGreaterThan(8);
    expect(car.speed).toBeLessThan(10.5);
    g.run(600, () => car.drive({ throttle: 1 }));
    expect(car.speed).toBeGreaterThan(27);
    expect(car.speed).toBeLessThan(30.5);
    expect(g.pos('car').z).toBeGreaterThan(100);
    expect(Math.abs(g.pos('car').x)).toBeLessThan(1);
    const from = car.speed;
    g.run(60, () => car.drive({ brake: 1 }));
    expect(car.speed).toBeLessThan(from - 15); // 20 m/s² for a second
    g.run(120, () => car.drive({ brake: 1 }));
    expect(Math.abs(car.speed)).toBeLessThan(0.5);
  });

  it('steer > 0 turns right (towards +x when facing +z); reverses at reverse_speed', () => {
    const g = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }]);
    g.run(30);
    const car = g.vehicle('car');
    g.run(120, () => car.drive({ throttle: 1 }));
    g.run(60, () => car.drive({ throttle: 0.5, steer: 1 }));
    expect(g.yaw('car')).toBeGreaterThan(20);
    expect(g.pos('car').x).toBeGreaterThan(1);
    const h = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }]);
    h.run(30);
    h.run(300, () => h.vehicle('car').drive({ throttle: -1 }));
    expect(h.vehicle('car').speed).toBeLessThan(-6);
    expect(h.vehicle('car').speed).toBeGreaterThan(-8.5);
  });

  it('a driverless car nobody drives is parked; handbrake slides into a drift', () => {
    const g = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }]);
    g.run(30);
    const car = g.vehicle('car');
    const svc = g.kernel.service(PHYSICS3D_SERVICE);
    svc.setVelocity(g.id('car'), new Vec3(0, 0, 5));
    g.run(60);
    expect(Math.abs(car.speed)).toBeLessThan(0.5);
    g.run(240, () => car.drive({ throttle: 1 }));
    let slip = 0;
    g.run(40, () => {
      car.drive({ steer: 1, handbrake: true });
      slip = Math.max(slip, Math.abs(car.slip));
    });
    expect(slip).toBeGreaterThan(10);
  });
});

describe('tracked, boats', () => {
  it('a tracked hull turns in place at turn_rate and drives with lock_rotation', () => {
    const tank = { components: {
      rigidbody: { kind: 'dynamic', mass: 1200, lock_rotation: true },
      collider: { shape: 'box', size: [3, 1.1, 4.4] },
      vehicle: { kind: 'tracked', max_speed: 12, reverse_speed: 5, turn_rate: 80, acceleration: 25, braking: 40 },
    } };
    const g = game({ road: ROAD, tank }, [{ prefab: 'road' }, { prefab: 'tank', id: 't', at: [0, 1.2, 0], rotation: [0, 180, 0] }]);
    g.run(60);
    const t = g.vehicle('t');
    const start = g.pos('t');
    g.run(60, () => t.drive({ steer: 1 }));
    expect(((g.yaw('t') + 360) % 360)).toBeCloseTo((180 + 80) % 360, -1);
    expect(g.pos('t').flat().distance_to(start.flat())).toBeLessThan(0.5);
    g.run(120, () => t.drive({ throttle: 1 }));
    expect(t.speed).toBeGreaterThan(10);
  });

  const SEA = { components: { water_body: { kind: 'ocean', waves: 'none' } } };
  const BOAT = { components: {
    rigidbody: { kind: 'dynamic', mass: 2400, linear_damping: 0.08, angular_damping: 0.5 },
    collider: { shape: 'box', size: [3, 0.85, 4.4], offset: [0, 0.43, 0] },
    vehicle: { kind: 'boat', max_speed: 8, acceleration: 2, braking: 3, steering: 35 },
    buoyancy: {},
  } };

  it('a boat floats on its Buoyancy at its draft, sails forward and turns with its rudder', () => {
    const g = game({ sea: SEA, boat: BOAT }, [{ prefab: 'sea' }, { prefab: 'boat', id: 'b', at: [0, 0, 0] }]);
    const b = g.vehicle('b');
    g.run(400);
    // 2400 kg on 3 × 4.4 m: 0.18 m under.
    expect(g.pos('b').y).toBeCloseTo(-2400 / (1000 * 3 * 4.4), 1);
    g.run(300, () => b.drive({ throttle: 1 }));
    expect(b.speed).toBeGreaterThan(7);
    expect(g.pos('b').z).toBeGreaterThan(15);
    expect(b.grounded).toBe(true);
    expect(Math.abs(g.pos('b').y + 0.18)).toBeLessThan(0.1);
    g.run(60, () => b.drive({ throttle: 1, steer: 1 }));
    expect(g.yaw('b')).toBeGreaterThan(30);
  });

  it('stern thrust bites only in the water: a beached boat goes nowhere', () => {
    const shore = { components: { collider: { shape: 'box', size: [40, 1, 40], offset: [0, -0.5, 0] } } };
    const g = game({ shore, boat: BOAT }, [{ prefab: 'shore', at: [0, 2, 0] }, { prefab: 'boat', id: 'b', at: [0, 2.05, 0] }]);
    const b = g.vehicle('b');
    g.run(60);
    g.run(120, () => b.drive({ throttle: 1 }));
    expect(Math.abs(b.speed)).toBeLessThan(0.1);
    expect(b.grounded).toBe(false);
  });

  it('a boat without Buoyancy is PP7311', () => {
    const { buoyancy: _, ...dry } = BOAT.components;
    const g = game({ boat: { components: dry } }, [{ prefab: 'boat', id: 'b', at: [0, 0, 0] }]);
    expect(() => g.run(1)).toThrow(/PP7311/);
  });
});

describe('weather', () => {
  it("tyre grip follows the weather's friction: on a snowed-over road a car turns less for the same steering", () => {
    const corner = (preset: string | undefined): number => {
      const sky: WeatherPlugin = weather();
      const g = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }], [], [sky]);
      // A minute of it: snow settles on the road (friction 1 - 0.6 × cover).
      if (preset !== undefined) sky.control().set({ preset, seconds: 0, fields: {} });
      const car = g.vehicle('car');
      g.run(preset === undefined ? 30 : 3600);
      g.run(150, () => car.drive({ throttle: 1 }));
      g.run(60, () => car.drive({ throttle: 0.6, steer: 1 }));
      if (preset !== undefined) expect(g.kernel.service(WEATHER_SERVICE).conditions().friction).toBeLessThan(0.6);
      return g.yaw('car');
    };
    const dry = corner(undefined);
    const snow = corner('snow');
    expect(snow).toBeLessThan(dry - 8);
  });
});

describe('aircraft', () => {
  const PLANE = { components: {
    rigidbody: { kind: 'dynamic', mass: 1200 },
    collider: { shape: 'box', size: [20, 3.2, 12], offset: [0, 1.6, 0], friction: 0.06 },
    vehicle: { kind: 'plane', max_speed: 85, acceleration: 8, braking: 6, steering: 30, fuel: 160, fuel_capacity: 160, fuel_burn: 0.6 },
  }, behaviors: { watch: {} } };

  it('a plane takes off with throttle and back stick, burns fuel, and stalls when slow in the air', () => {
    const g = game({ road: ROAD, plane: PLANE }, [{ prefab: 'road' }, { prefab: 'plane', id: 'p', at: [0, 0.1, -150] }]);
    g.run(60);
    const p = g.vehicle('p');
    expect(p.grounded).toBe(true);
    let airborneAt = 0;
    g.run(14 * 60, () => {
      p.fly({ throttle: 1, pitch: g.kernel.time.now > 3 ? 0.6 : 0 });
      if (airborneAt === 0 && p.airborne) airborneAt = g.kernel.time.now;
    });
    expect(p.airborne).toBe(true);
    expect(airborneAt).toBeGreaterThan(1);
    expect(g.pos('p').y).toBeGreaterThan(10);
    expect(p['fuel'] as number).toBeCloseTo(160 - 0.6 * 14.5, 0);
    p.refuel(100);
    expect(p['fuel']).toBe(160);
    expect(stallSpeed({ max_speed: 85 } as never, 0)).toBe(17);
    // Slow in the air: stalled. Out of fuel: stalled.
    expect(p.stalled).toBe(false);
    g.kernel.service(PHYSICS3D_SERVICE).teleport(g.id('p'), new Vec3(0, 300, 0), undefined, false);
    g.run(1, () => p.fly({ throttle: 0 }));
    expect(p.airborne && p.stalled).toBe(true);
    p['fuel'] = 0;
    expect(p.stalled).toBe(true);
  });

  it('VehicleLanded after ≥ 0.3 s airborne, with the sink rate and what it touched', () => {
    const log: Log = [];
    const g = game({ road: ROAD, plane: PLANE }, [{ prefab: 'road', id: 'road' }, { prefab: 'plane', id: 'p', at: [0, 4, 0] }], log);
    g.run(120);
    const landed = log.filter(([m]) => m === 'landed');
    expect(landed.length).toBe(1);
    expect(landed[0]![2]['target']).toBe(g.id('road'));
    expect(landed[0]![2]['fall_speed'] as number).toBeGreaterThan(Math.sqrt(2 * 9.8 * 3.5) - 1);
    const h = game({ road: ROAD, plane: PLANE }, [{ prefab: 'road' }, { prefab: 'plane', id: 'p', at: [0, 0.1, 0] }], []);
    h.run(60);
    expect(h.log.filter(([m]) => m === 'landed').length).toBe(0); // a 0.1 m drop is under LANDING_AIRTIME
    expect(LANDING_AIRTIME).toBe(0.3);
  });

  it('a plane is flown, not driven', () => {
    const g = game({ road: ROAD, plane: PLANE }, [{ prefab: 'road' }, { prefab: 'plane', id: 'p', at: [0, 0.2, 0] }]);
    g.run(10);
    expect(() => g.vehicle('p').drive({ throttle: 1 })).toThrow(/PP7310/);
  });
});

describe('seats', () => {
  const PILOT = { components: { character: { acceleration: 1000 } } };

  it('enter mounts the driver (Character.vehicle), drives it along, exit puts it down beside', () => {
    const log: Log = [];
    const g = game({ road: ROAD, car: CAR, pilot: PILOT }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }, { prefab: 'pilot', id: 'me', at: [-4, 0, 0] }], log);
    g.run(30);
    const car = g.vehicle('car');
    const me = g.kernel.world.require(g.id('me')).components.get('character') as Fields & { vehicle: unknown; velocity: Vec3; grounded: boolean };
    expect(car.enter(g.id('me'))).toBe(true);
    expect(me.vehicle).toBe(g.id('car'));
    expect(car.driver).toBe(g.id('me'));
    expect(car.enter(g.id('me'), { seat: 1 })).toBe(false); // already aboard
    expect(() => car.enter(g.id('me'), { seat: 2 })).toThrow(/PP7309/);
    g.run(120, () => car.drive({ throttle: 1 }));
    expect(g.pos('me').distance_to(g.pos('car'))).toBeLessThan(1);
    expect(me.velocity.length()).toBeGreaterThan(5);
    g.run(240, () => car.drive({ brake: 1 }));
    expect(car.exit(g.id('me'))).toBe(true);
    expect(me.vehicle).toBeNull();
    expect(car.driver).toBeNull();
    const local = g.kernel.world.require(g.id('car')).transform.toLocal(g.pos('me'));
    expect(local.x).toBeLessThan(-1);
    g.run(60);
    expect(me.grounded).toBe(true);
    expect(log.map(([m, e, p]) => [m, e, p['source']])).toEqual([['entered', g.id('car'), g.id('me')], ['exited', g.id('car'), g.id('me')]]);
    expect(car.exit(g.id('me'))).toBe(false); // not aboard: refused like leave_seat(), not an error
  });

  it('a vehicle seat is a Seat child: Character.sit / leave_seat work in it and count as entering', () => {
    const log: Log = [];
    const g = game({ road: ROAD, car: CAR, pilot: PILOT }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }, { prefab: 'pilot', id: 'me', at: [-4, 0, 0] }], log);
    g.run(30);
    const car = g.vehicle('car');
    expect(car.seats).toHaveLength(2);
    const me = g.kernel.world.require(g.id('me')).components.get('character') as Fields & { vehicle: unknown; sit(seat: unknown): boolean; leave_seat(): boolean; motion: string };
    expect(me.sit(car.seats[1])).toBe(true);
    g.run(1);
    expect(me.vehicle).toBe(g.id('car'));
    expect(me.motion).toBe('riding');
    expect(car.riders).toEqual([g.id('me')]);
    expect(car.driver).toBeNull(); // seat 1 is a passenger's
    expect(me.leave_seat()).toBe(true);
    g.run(1);
    expect(me.vehicle).toBeNull();
    expect(log.map(([m, , p]) => [m, p['source']])).toEqual([['entered', g.id('me')], ['exited', g.id('me')]]);
  });

  it('a rider without a Character is mounted on the seat; no seats is PP7309', () => {
    const DRONE = { components: {} };
    const g = game({ road: ROAD, car: CAR, drone: DRONE }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }, { prefab: 'drone', id: 'ai', at: [-4, 0, 0] }]);
    g.run(30);
    const car = g.vehicle('car');
    expect(car.enter(g.id('ai'))).toBe(true);
    expect(car.driver).toBe(g.id('ai'));
    expect(g.pos('ai').distance_to(g.kernel.world.require(car.seats[0] as EntityId).transform.worldPosition())).toBeLessThan(0.05);
    expect(car.exit(g.id('ai'))).toBe(true);
    expect(car.driver).toBeNull();
    const bare = game({ road: ROAD, drone: DRONE, v: { components: CAR.components } }, [{ prefab: 'road' }, { prefab: 'v', id: 'v', at: [0, 0.2, 0] }, { prefab: 'drone', id: 'ai' }]);
    expect(() => bare.vehicle('v').enter(bare.id('ai'))).toThrow(/PP7309/);
  });

  it('refuses a chassis without a dynamic Rigidbody and Collider; refuel without a fuel model', () => {
    const g = game({ v: { components: { vehicle: {} } } }, [{ prefab: 'v' }]);
    expect(() => g.run(1)).toThrow(/PP7308/);
    const h = game({ road: ROAD, car: CAR }, [{ prefab: 'road' }, { prefab: 'car', id: 'car' }]);
    expect(() => h.vehicle('car').refuel(1)).toThrow(/PP3189/);
    expect(() => h.vehicle('car').fly({ throttle: 1 })).toThrow(/PP7310/);
    expect(() => h.vehicle('car').drive({ throttle: 2 })).toThrow(/PP7307/);
  });
});

describe('snapshot / restore', () => {
  it('restores seats, speed and controls', () => {
    const g = game({ road: ROAD, car: CAR, pilot: { components: { character: {} } } }, [{ prefab: 'road' }, { prefab: 'car', id: 'car', at: [0, 0.2, 0] }, { prefab: 'pilot', id: 'me', at: [-4, 0, 0] }]);
    g.run(30);
    g.vehicle('car').enter(g.id('me'));
    g.run(60, () => g.vehicle('car').drive({ throttle: 1 }));
    const snap = g.kernel.snapshot();
    const speed = g.vehicle('car').speed;
    g.run(60, () => g.vehicle('car').drive({ brake: 1 }));
    g.kernel.restore(snap);
    expect(g.vehicle('car').driver).toBe(g.id('me'));
    expect(g.vehicle('car').speed).toBeCloseTo(speed, 3);
    g.run(60, () => g.vehicle('car').drive({ throttle: 1 }));
    expect(g.vehicle('car').speed).toBeGreaterThan(speed);
  });
});
