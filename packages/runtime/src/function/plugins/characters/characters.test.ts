import { beforeAll, describe, expect, it } from 'vitest';
import { Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, KERNEL_EVENTS } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { weather } from '../weather/index.js';
import type { WeatherPlugin } from '../weather/index.js';
import { CHARACTER_EVENTS, characters, COYOTE_TIME } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

interface Character extends Fields {
  move(direction: Vec3, options?: { speed?: number; run?: boolean }): void;
  jump(): boolean;
  launch(v: Vec3): void;
  knockback(v: Vec3): void;
  stop(): void;
  face(yaw: number): void;
  teleport(p: Vec3, options?: { yaw?: number }): void;
  readonly grounded: boolean;
  readonly ground: unknown;
  readonly velocity: Vec3;
  readonly vehicle: unknown;
}

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

type Log = Array<[string, EntityId, Fields]>;

function listener(log: Log, events: Record<string, EventDef>): BehaviorDef {
  return {
    id: 'watch', params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([method, this['entity'] as EntityId, e]);
    }])) as LogicInstance,
  };
}

const FLOOR = { components: { collider: { shape: 'box', size: [60, 1, 60], offset: [0, -0.5, 0] } } };
const HERO = { components: { character: { walk_speed: 4, run_speed: 8, acceleration: 1000 } }, behaviors: { watch: {} } };

function game(prefabs: Record<string, unknown>, entities: unknown[], gravity = -9.8, log: Log = [], extra: KernelPlugin[] = []) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const watch = listener(log, { landed: CHARACTER_EVENTS.landed, jumped: CHARACTER_EVENTS.jumped, entered: KERNEL_EVENTS.triggerEntered });
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [watch], systems: [] },
    plugins: [physics3d({ gravity, layers: ['hero', 'wall', 'pickup'] }), characters(), ...extra], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel, log, id,
    pos: (placed: string) => kernel.world.require(id(placed)).transform.position,
    character: (placed: string) => kernel.world.require(id(placed)).components.get('character') as Character,
    /** Frames, with `each` run before each (as a behavior's update would). */
    run: (frames: number, each?: () => void) => {
      for (let i = 0; i < frames; i++) {
        each?.();
        kernel.step(DT);
      }
    },
  };
}

describe('weather', () => {
  it("ground traction follows the weather's friction in the open, and not under a roof", () => {
    // How far a character runs in 10 frames from a standstill: acceleration × friction.
    const startUp = (snowed: boolean, roofed: boolean): number => {
      const sky: WeatherPlugin = weather();
      const roof = { components: { collider: { shape: 'box', size: [40, 0.5, 40] } } };
      const hero = { components: { character: { walk_speed: 4, acceleration: 10 } } };
      const g = game({ floor: FLOOR, hero, roof }, [
        { prefab: 'floor' }, { prefab: 'hero', id: 'hero', at: [0, 0.05, 0] }, ...(roofed ? [{ prefab: 'roof', at: [0, 6, 0] }] : []),
      ], -9.8, [], [sky]);
      if (snowed) sky.control().set({ preset: 'snow', seconds: 0, fields: {} });
      g.run(snowed ? 3600 : 60);
      const c = g.character('hero');
      const z = g.pos('hero').z;
      g.run(10, () => c.move(new Vec3(0, 0, 1)));
      return g.pos('hero').z - z;
    };
    const dry = startUp(false, false);
    expect(startUp(true, false)).toBeLessThan(dry * 0.7);
    expect(startUp(true, true)).toBeCloseTo(dry, 2);
  });
});

describe('standing and walking', () => {
  it('a character placed on the floor lands, stays on it and is grounded on it', () => {
    const g = game({ floor: FLOOR, hero: HERO }, [{ prefab: 'floor', id: 'floor' }, { prefab: 'hero', id: 'hero', at: [0, 0.5, 0] }], -9.8, []);
    g.run(120);
    const c = g.character('hero');
    expect(c.grounded).toBe(true);
    expect(c.ground).toBe(g.id('floor'));
    expect(g.pos('hero').y).toBeGreaterThanOrEqual(0);
    expect(g.pos('hero').y).toBeLessThan(0.05);
    expect(g.log.filter(([m]) => m === 'landed').length).toBe(1);
    g.run(120);
    expect(Math.abs(g.pos('hero').y)).toBeLessThan(0.05);
    expect(c.velocity.length()).toBe(0);
  });

  it('stays on very large floors (Rapier 0.19 snap-to-ground sank through them)', () => {
    // cargo_plane's ocean is a 5.4 km box; voxel_survival's player steps 0.55 m.
    const sea = { components: { collider: { shape: 'box', size: [5400, 2, 5400], offset: [0, -1, 0] } } };
    const g = game({ sea, hero: { components: { character: { radius: 0.3, height: 1.8, step_height: 0.55 } } } },
      [{ prefab: 'sea' }, { prefab: 'hero', id: 'hero', at: [0, 0.2, 0] }]);
    let lowest = Infinity;
    g.run(300, () => {
      g.character('hero').move(new Vec3(1, 0, 1));
      lowest = Math.min(lowest, g.pos('hero').y);
    });
    expect(g.character('hero').grounded).toBe(true);
    expect(lowest).toBeGreaterThan(0.005);
    expect(g.pos('hero').y).toBeLessThan(0.05);
  });

  it('walks at walk_speed, runs at run_speed, scales by stick length, then stops when not steered', () => {
    const g = game({ floor: FLOOR, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    g.run(10);
    const c = g.character('hero');
    const x0 = g.pos('hero').x;
    g.run(60, () => c.move(new Vec3(1, 0, 0)));
    expect(c.velocity.x).toBeCloseTo(4, 3);
    expect(g.pos('hero').x - x0).toBeCloseTo(4, 1);
    g.run(10, () => c.move(new Vec3(0, 0, 1), { run: true }));
    expect(c.velocity.z).toBeCloseTo(8, 3);
    g.run(10, () => c.move(new Vec3(0, 0, 0.5)));
    expect(c.velocity.z).toBeCloseTo(2, 3);
    g.run(10, () => c.move(new Vec3(0, 0, 5), { speed: 3 }));
    expect(c.velocity.length()).toBeCloseTo(3, 3);
    g.run(3);
    expect(c.velocity.length()).toBe(0);
  });

  it('accelerates at `acceleration`, and air_control scales it in the air', () => {
    const g = game({ floor: FLOOR, hero: { components: { character: { acceleration: 10, walk_speed: 5, air_control: 0.5 } } } },
      [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    g.run(5);
    const c = g.character('hero');
    g.run(12, () => c.move(new Vec3(1, 0, 0)));
    expect(c.velocity.x).toBeCloseTo(2, 3); // 10 m/s² · 0.2 s
    c.launch(new Vec3(c.velocity.x, 5, 0));
    g.run(12, () => c.move(new Vec3(1, 0, 0)));
    expect(c.velocity.x).toBeCloseTo(3, 3); // + 5 m/s² · 0.2 s
  });

  it('walls stop it; it climbs steps up to step_height and not higher', () => {
    const wall = { components: { collider: { shape: 'box', size: [1, 3, 10], offset: [0, 1.5, 0] } } };
    const step = { components: { collider: { shape: 'box', size: [20, 0.2, 10], offset: [0, 0.1, 0] } } };
    const ledge = { components: { collider: { shape: 'box', size: [4, 0.6, 10], offset: [0, 0.3, 0] } } };
    const g = game({ floor: FLOOR, hero: HERO, wall, step, ledge }, [
      { prefab: 'floor' }, { prefab: 'wall', at: [3, 0, 0] }, { prefab: 'hero', id: 'a' },
      { prefab: 'step', at: [11, 0, 20] }, { prefab: 'hero', id: 'b', at: [0, 0, 20] },
      { prefab: 'ledge', at: [3, 0, -20] }, { prefab: 'hero', id: 'c', at: [0, 0, -20] },
    ]);
    g.run(120, () => {
      for (const h of ['a', 'b', 'c']) g.character(h).move(new Vec3(1, 0, 0));
    });
    expect(g.pos('a').x).toBeLessThan(2.5 - 0.35 + 0.05);
    expect(g.pos('a').x).toBeGreaterThan(2);
    expect(g.pos('b').x).toBeGreaterThan(4); // climbed the 0.2 m step
    expect(g.pos('b').y).toBeGreaterThan(0.15);
    expect(g.pos('c').x).toBeLessThan(1.2); // 0.6 m is a wall
  });

  it('lock_axes keeps it on its lane: input, knockback, a curved wall and moving ground never move it along z', () => {
    const lane = { components: { character: { walk_speed: 4, acceleration: 1000, lock_axes: ['z'] } } };
    const pillar = { components: { collider: { shape: 'sphere', radius: 1 } } };
    const platform = { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'box', size: [6, 0.5, 6], offset: [0, -0.25, 0] } } };
    const g = game({ floor: FLOOR, lane, pillar, platform }, [
      { prefab: 'floor' }, { prefab: 'lane', id: 'a', at: [0, 0, 0.5] }, { prefab: 'pillar', at: [3, 0.6, 0.9] },
      { prefab: 'platform', id: 'p', at: [0, 5, 20] }, { prefab: 'lane', id: 'b', at: [0, 5.1, 20] },
    ]);
    g.run(10);
    const a = g.character('a');
    a.knockback(new Vec3(0, 0, 9));
    g.run(60, () => a.move(new Vec3(1, 0, 1)));
    expect(g.pos('a').z).toBe(0.5);
    expect(a.velocity.z).toBe(0);
    expect(g.pos('a').x).toBeGreaterThan(1); // still runs along x (and up against the pillar)
    const t = g.kernel.world.require(g.id('p')).transform;
    g.run(60, () => { t.position = t.position.__add__(new Vec3(DT, 0, 1.5 * DT)); });
    expect(g.pos('b').z).toBe(20);
    expect(g.pos('b').x).toBeCloseTo(1, 0);
    g.character('b').teleport(new Vec3(0, 5.1, 21));
    g.run(2);
    expect(g.pos('b').z).toBe(21); // teleport still sets it
  });

  it('rides a moving kinematic platform', () => {
    const platform = { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'box', size: [4, 0.5, 4], offset: [0, -0.25, 0] } } };
    const g = game({ platform, hero: HERO }, [{ prefab: 'platform', id: 'p', at: [0, 5, 0] }, { prefab: 'hero', id: 'hero', at: [0, 5.1, 0] }]);
    g.run(30);
    const t = g.kernel.world.require(g.id('p')).transform;
    expect(g.character('hero').ground).toBe(g.id('p'));
    g.run(60, () => { t.position = t.position.__add__(new Vec3(1.5 * DT, 0, 0)); });
    expect(g.pos('hero').x).toBeCloseTo(1.5, 0);
    expect(g.character('hero').grounded).toBe(true);
  });

  it('turns its heading with a spinning deck (and rides it round)', () => {
    const platform = { components: { rigidbody: { kind: 'kinematic' }, collider: { shape: 'box', size: [8, 0.5, 8], offset: [0, -0.25, 0] } } };
    const g = game({ platform, hero: HERO }, [{ prefab: 'platform', id: 'p', at: [0, 5, 0] }, { prefab: 'hero', id: 'hero', at: [2, 5.1, 0] }]);
    g.run(30);
    const t = g.kernel.world.require(g.id('p')).transform;
    const heading = (): number => g.kernel.world.require(g.id('hero')).transform.worldRotation().to_euler().y;
    const start = heading();
    let angle = 0;
    // 45°/s about +y for one second.
    g.run(60, () => { angle += 45 * DT; t.rotation = Quat.from_euler(new Vec3(0, angle, 0)); });
    const turned = ((heading() - start + 540) % 360) - 180;
    expect(turned).toBeCloseTo(45, -0.5);
    // Riding round: at radius 2, 45° about +y carries +x toward -z.
    expect(g.pos('hero').z).toBeLessThan(-0.8);
  });
});

describe('jumping', () => {
  it('jumps to jump_height under the configured gravity, emits Jumped then Landed', () => {
    const log: Log = [];
    const g = game({ floor: FLOOR, hero: { ...HERO, components: { character: { jump_height: 2 } } } }, [{ prefab: 'floor', id: 'floor' }, { prefab: 'hero', id: 'hero' }], -40, log);
    g.run(5);
    const c = g.character('hero');
    log.length = 0;
    expect(c.jump()).toBe(true);
    expect(c.grounded).toBe(false);
    let peak = 0;
    g.run(60, () => { peak = Math.max(peak, g.pos('hero').y); });
    expect(peak).toBeCloseTo(2, 1);
    expect(c.grounded).toBe(true);
    expect(log.map(([m, , p]) => [m, p['in_air'] ?? p['fall_speed']])).toEqual([['jumped', false], ['landed', expect.closeTo(Math.sqrt(2 * 40 * 2), 0)]]);
    expect(log[1]![2]['target']).toBe(g.id('floor'));
  });

  it('allows air_jumps extra jumps, and coyote time after walking off a ledge', () => {
    const ledge = { components: { collider: { shape: 'box', size: [2, 1, 2], offset: [0, -0.5, 0] } } };
    const g = game({ ledge, hero: { ...HERO, components: { character: { air_jumps: 1, acceleration: 1000 } } } }, [{ prefab: 'ledge' }, { prefab: 'hero', id: 'hero' }]);
    g.run(5);
    const c = g.character('hero');
    expect(c.jump()).toBe(true);
    g.run(10);
    expect(c.jump()).toBe(true); // the air jump
    g.run(5);
    expect(c.jump()).toBe(false);
    g.run(120);
    // Off the ledge's edge: still jumps within COYOTE_TIME.
    // Walking off the edge: it falls.
    const h = game({ ledge, hero: HERO }, [{ prefab: 'ledge' }, { prefab: 'hero', id: 'hero', at: [0.5, 0, 0] }]);
    h.run(5);
    const d = h.character('hero');
    h.run(120, () => d.move(new Vec3(1, 0, 0)));
    expect(d.grounded).toBe(false);
    expect(h.pos('hero').y).toBeLessThan(-1);
    // Jumping just after leaving it: coyote time.
    const k = game({ ledge, hero: HERO }, [{ prefab: 'ledge' }, { prefab: 'hero', id: 'hero', at: [0.5, 0, 0] }]);
    k.run(5);
    const e = k.character('hero');
    let jumped: boolean | undefined;
    let air = 0;
    k.run(120, () => {
      if (jumped !== undefined) return;
      if (!e.grounded) {
        air += DT;
        if (air >= COYOTE_TIME / 2) jumped = e.jump();
      } else {
        e.move(new Vec3(1, 0, 0));
      }
    });
    expect(jumped).toBe(true);
  });

  it('launch sets velocity and leaves the ground; knockback adds to it; stop zeroes it', () => {
    const g = game({ floor: FLOOR, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    g.run(5);
    const c = g.character('hero');
    c.launch(new Vec3(0, 6, 0));
    expect(c.grounded).toBe(false);
    g.run(10);
    expect(g.pos('hero').y).toBeGreaterThan(0.5);
    c.knockback(new Vec3(2, 0, 0));
    expect(c.velocity.x).toBe(2);
    c.stop();
    expect(c.velocity.length()).toBe(0);
  });
});

describe('facing, teleport and layers', () => {
  it('turns toward its movement at turn_speed; face() and teleport(yaw=) set it now', () => {
    const g = game({ floor: FLOOR, hero: { components: { character: { turn_speed: 90 } } } }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    const yaw = (): number => g.kernel.world.require(g.id('hero')).transform.rotation.to_euler().y;
    g.run(30, () => g.character('hero').move(new Vec3(1, 0, 0)));
    expect(yaw()).toBeCloseTo(45, 0);
    g.run(60, () => g.character('hero').move(new Vec3(1, 0, 0)));
    expect(yaw()).toBeCloseTo(90, 3);
    g.character('hero').face(-30);
    expect(yaw()).toBeCloseTo(-30, 3);
    g.character('hero').stop();
    g.character('hero').teleport(new Vec3(10, 2, 10), { yaw: 180 });
    expect(g.pos('hero').toJSON()).toEqual([10, 2, 10]);
    expect(Math.abs(yaw())).toBeCloseTo(180, 3);
    g.run(60);
    expect(g.pos('hero').x).toBeCloseTo(10, 3);
    expect(g.pos('hero').y).toBeLessThan(0.05);
  });

  it('takes its Collider\'s layer: triggers that collide only with it fire once per pair', () => {
    const log: Log = [];
    const keeper = { components: {
      character: { acceleration: 1000 },
      // As twin_stick_roguelite's keeper: a centred capsule beside the character's own.
      collider: { shape: 'capsule', radius: 0.4, height: 1.7, layer: 'hero', collides_with: ['wall', 'pickup'] },
    } };
    const pickup = { components: { collider: { shape: 'sphere', radius: 0.8, trigger: true, layer: 'pickup', collides_with: ['hero'] } }, behaviors: { watch: {} } };
    const floor = { components: { collider: { ...FLOOR.components.collider, layer: 'wall' } } };
    const g = game({ floor, keeper, pickup }, [{ prefab: 'floor' }, { prefab: 'keeper', id: 'k' }, { prefab: 'pickup', id: 'p', at: [3, 0.5, 0] }], -9.8, log);
    g.run(90, () => g.character('k').move(new Vec3(1, 0, 0)));
    expect(log.filter(([m]) => m === 'entered').map(([, e, p]) => [e, p['target']])).toEqual([[g.id('p'), g.id('k')]]);
    expect(g.pos('k').y).toBeLessThan(0.05); // stands on the 'wall' floor
  });

  it('refuses a Rigidbody, 2D modes and Vec2 directions with fixes', () => {
    const bad = game({ floor: FLOOR, a: { components: { character: {}, rigidbody: {} } } }, [{ prefab: 'floor' }, { prefab: 'a' }]);
    expect(() => bad.run(1)).toThrow(/PP3157[\s\S]*Remove the rigidbody/);
    const flat = game({ a: { components: { character: { mode: 'platformer2d' } } } }, [{ prefab: 'a' }]);
    expect(() => flat.run(1)).toThrow(/PP3171/);
    const g = game({ floor: FLOOR, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    expect(() => g.character('hero').move(new Vec2(1, 0) as unknown as Vec3)).toThrow(/PP3172[\s\S]*relative/);
  });

  it('needs physics3d, found at use', () => {
    const project = loadProject(files({ 'prefabs/a.prefab.json': { components: { character: {} } }, 'scenes/main/scene.json': { entities: [{ prefab: 'a' }] } }));
    const kernel = new Kernel({ project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins: [characters()], context: {}, fixedStep: DT });
    kernel.start('main');
    expect(() => kernel.step(DT)).toThrow(/PP9005[\s\S]*physics3d\(\)/);
  });
});

describe('snapshot / restore', () => {
  it('restores mid-jump motion exactly enough to land the same way', () => {
    const g = game({ floor: FLOOR, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    g.run(5);
    g.character('hero').jump();
    g.run(10, () => g.character('hero').move(new Vec3(1, 0, 0)));
    const snap = g.kernel.snapshot();
    const v = g.character('hero').velocity;
    g.run(40);
    const after = g.pos('hero');
    g.kernel.restore(snap);
    expect(g.character('hero').velocity.toJSON()).toEqual(v.toJSON());
    expect(g.character('hero').grounded).toBe(false);
    g.run(40);
    expect(g.pos('hero').distance_to(after)).toBeLessThan(1e-3);
    expect(g.kernel.service(PHYSICS3D_SERVICE).body(g.id('hero'))!.kind).toBe('kinematic');
  });
});
