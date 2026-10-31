/**
 * The humanoid tier of Character, headless on Rapier: stances and the capsule, ledge
 * detection and vault/climb traversals, swimming in a water service's volume, free fall and
 * the parachute, holding/throwing items, carrying another character, seats, the Animator
 * params and "character" root motion, validation, and snapshots mid-traversal.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { ANIMATION_CLIPS_SERVICE, CHARACTERS_SERVICE, WATER_SERVICE } from '../../services/index.js';
import type { ClipInfo, RootSample, WaterSample } from '../../services/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { visuals } from '../visuals/index.js';
import { CHARACTER_EVENTS, characters } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

interface Character extends Fields {
  move(direction: Vec3, options?: { speed?: number; run?: boolean }): void;
  jump(): boolean;
  stop(): void;
  set_stance(stance: string): boolean;
  release_parachute(): boolean;
  hold(item: EntityId, options?: { socket?: string }): boolean;
  drop(): unknown;
  throw(velocity: Vec3): unknown;
  place(position: Vec3, options?: { yaw?: number }): unknown;
  lift(other: EntityId): boolean;
  put_down(): unknown;
  sit(seat: EntityId): boolean;
  leave_seat(): boolean;
  readonly grounded: boolean;
  readonly velocity: Vec3;
  readonly motion: string;
  readonly stance: string;
  readonly eye: Vec3;
  readonly ledge: string | null;
  readonly held: unknown;
  readonly carried: unknown;
  readonly carrier: unknown;
  readonly seat: unknown;
  readonly vehicle: unknown;
}

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

const box = (size: [number, number, number]) => ({ components: { collider: { shape: 'box', size, offset: [0, size[1] / 2, 0] } } });
const FLOOR = { components: { collider: { shape: 'box', size: [80, 1, 80], offset: [0, -0.5, 0] } } };

/** Still water: surface at y=0 over x∈[-20, 20], z∈[5, 40], down to the pool bed. */
const POOL_WATER: KernelPlugin = {
  id: 'water',
  install: (kernel) => kernel.provide(WATER_SERVICE, {
    sample: (p: Vec3): WaterSample | undefined => (p.x > -20 && p.x < 20 && p.z > 5 && p.z < 40 && p.y < 0.5 ? { surface: 0, flow: Vec3.ZERO } : undefined),
  }),
};

/** Clip facts as render3d gives them: "stride" travels 1.5 m along z per second. */
const CLIPS: KernelPlugin = {
  id: 'clips',
  install: (kernel) => kernel.provide(ANIMATION_CLIPS_SERVICE, {
    clip: (_e: EntityId, ref: string): ClipInfo | null => {
      if (ref !== 'stride' && ref !== 'idle') fail('PP3805', `no clip ${ref}`);
      return { duration: 1, loop: null, markers: [] };
    },
    root: (_e: EntityId, ref: string, time: number): RootSample | null => (ref === 'stride' ? { x: 0, y: 1, z: 1.5 * Math.min(time, 1), yaw: 0 } : null),
  }),
};

interface Options {
  readonly gravity?: number;
  readonly extra?: KernelPlugin[];
  readonly visuals?: boolean;
}

function game(prefabs: Record<string, unknown>, entities: unknown[], options: Options = {}) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const log: Log = [];
  const watch = listener(log, {
    landed: CHARACTER_EVENTS.landed, jumped: CHARACTER_EVENTS.jumped, traversed: CHARACTER_EVENTS.traversed,
    stance: CHARACTER_EVENTS.stanceChanged, motion: CHARACTER_EVENTS.motionChanged, seated: CHARACTER_EVENTS.seated, left: CHARACTER_EVENTS.leftSeat,
  });
  const plugins: KernelPlugin[] = [physics3d({ gravity: options.gravity ?? -9.8 }), characters(), ...(options.extra ?? [])];
  if (options.visuals === true) plugins.unshift(visuals({ dimension: '3d' }));
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [watch], systems: [] }, plugins, context: {}, fixedStep: DT,
  });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel, log, id,
    pos: (placed: string) => kernel.world.require(id(placed)).transform.worldPosition(),
    character: (placed: string) => kernel.world.require(id(placed)).components.get('character') as Character,
    fields: (placed: string, component: string) => kernel.world.require(id(placed)).components.get(component)!,
    run: (frames: number, each?: () => void) => {
      for (let i = 0; i < frames; i++) {
        each?.();
        kernel.step(DT);
      }
    },
  };
}

const HERO = { components: { character: { acceleration: 1000, stances: { prone: true }, traversal: {} } }, behaviors: { watch: {} } };

describe('stances', () => {
  it('crouching shrinks the capsule (it fits under a low bar), and standing needs the headroom', () => {
    // A bar from 1.4 m to 2 m high across the path at z = 3.
    const bar = { components: { collider: { shape: 'box', size: [6, 0.6, 1], offset: [0, 1.7, 0] } } };
    const g = game({ floor: FLOOR, bar, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'bar', at: [0, 0, 3] }, { prefab: 'hero', id: 'hero' }]);
    g.run(10);
    const c = g.character('hero');
    // Standing, it is stopped by the bar.
    g.run(90, () => c.move(new Vec3(0, 0, 1)));
    expect(g.pos('hero').z).toBeLessThan(2.2);
    expect(c.set_stance('crouch')).toBe(true);
    expect(c.stance).toBe('crouch');
    // Crouched speed is capped (crouch_speed 2) and running doesn't apply.
    g.run(10, () => c.move(new Vec3(0, 0, 1), { run: true }));
    expect(c.velocity.flat().length()).toBeCloseTo(2, 3);
    // Under the bar (z 2.5..3.5): no room to stand.
    for (let i = 0; i < 120 && g.pos('hero').z < 3; i++) g.run(1, () => c.move(new Vec3(0, 0, 1)));
    c.stop();
    g.run(1);
    expect(g.pos('hero').z).toBeGreaterThan(2.9);
    expect(g.pos('hero').z).toBeLessThan(3.2);
    expect(c.set_stance('stand')).toBe(false);
    g.run(60, () => c.move(new Vec3(0, 0, 1)));
    expect(g.pos('hero').z).toBeGreaterThan(4);
    expect(c.set_stance('stand')).toBe(true);
    g.run(1);
    expect(g.log.filter(([m]) => m === 'stance').map(([, e]) => e['stance'])).toEqual(['crouch', 'stand']);
  });

  it('eases the eye height across a stance change, and prone needs the ground', () => {
    const g = game({ floor: FLOOR, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero', at: [0, 2, 0] }]);
    const c = g.character('hero');
    g.run(2);
    expect(c.grounded).toBe(false);
    expect(c.set_stance('prone')).toBe(false);
    g.run(90);
    expect(c.eye.y - g.pos('hero').y).toBeCloseTo(1.62, 3);
    expect(c.set_stance('prone')).toBe(true);
    g.run(3);
    const partway = c.eye.y - g.pos('hero').y;
    expect(partway).toBeLessThan(1.62);
    expect(partway).toBeGreaterThan(0.72);
    g.run(60);
    expect(c.eye.y - g.pos('hero').y).toBeCloseTo(1.62 * 0.8 / 1.8, 3);
    // Prone: no jumping, prone speed.
    expect(c.jump()).toBe(false);
    g.run(20, () => c.move(new Vec3(1, 0, 0)));
    expect(c.velocity.flat().length()).toBeCloseTo(0.8, 3);
    const view = g.kernel.service(CHARACTERS_SERVICE).view(g.id('hero'))!;
    expect(view.stance).toBe('prone');
    expect(view.eye.y).toBeCloseTo(0.72, 3);
  });

  it('raises PP3175 for stances the character lacks', () => {
    const g = game({ floor: FLOOR, plain: { components: { character: {} } }, upright: { components: { character: { stances: {} } } } },
      [{ prefab: 'floor' }, { prefab: 'plain', id: 'plain' }, { prefab: 'upright', id: 'upright', at: [3, 0, 0] }]);
    expect(() => g.character('plain').set_stance('crouch')).toThrow(/PP3175/);
    expect(() => g.character('upright').set_stance('prone')).toThrow(/PP3175[\s\S]*"prone": true/);
  });
});

describe('vault and climb', () => {
  // The hero stands at z = 1 facing +z; obstacles have their near face at z = 1.85.
  const wall = (height: number, depth: number) => box([4, height, depth]);
  const at = (depth: number) => [0, 0, 1.85 + depth / 2];

  it('finds a low thin wall as a vault, and jump() vaults it to the floor beyond', () => {
    const g = game({ floor: FLOOR, wall: wall(1, 0.3), hero: HERO }, [{ prefab: 'floor' }, { prefab: 'wall', at: at(0.3) }, { prefab: 'hero', id: 'hero', at: [0, 0, 1] }]);
    g.run(10);
    const c = g.character('hero');
    expect(c.ledge).toBe('vault');
    expect(c.jump()).toBe(true);
    g.run(2);
    expect(g.log.find(([m]) => m === 'traversed')![1]).toMatchObject({ kind: 'vault' });
    expect(g.log.find(([m]) => m === 'traversed')![1]['height']).toBeCloseTo(1, 1);
    expect(c.motion).toBe('traverse');
    let highest = 0;
    g.run(40, () => { highest = Math.max(highest, g.pos('hero').y); });
    expect(highest).toBeGreaterThan(1);
    expect(g.pos('hero').z).toBeGreaterThan(2.15 + 0.35);
    g.run(30);
    expect(c.motion).toBe('ground');
    expect(g.pos('hero').y).toBeLessThan(0.05);
  });

  it('climbs onto a deep ledge and stands on top', () => {
    const g = game({ floor: FLOOR, block: wall(2, 4), hero: HERO }, [{ prefab: 'floor' }, { prefab: 'block', at: at(4) }, { prefab: 'hero', id: 'hero', at: [0, 0, 1] }]);
    g.run(10);
    const c = g.character('hero');
    expect(c.ledge).toBe('climb');
    // A low deep box (1 m) is also climbed, not vaulted: nothing to vault to.
    expect(c.jump()).toBe(true);
    g.run(80);
    expect(c.motion).toBe('ground');
    expect(g.pos('hero').y).toBeCloseTo(2, 1);
    expect(g.pos('hero').z).toBeGreaterThan(1.85 + 0.35);
    expect(g.log.filter(([m]) => m === 'traversed').map(([, e]) => e['kind'])).toEqual(['climb']);
  });

  it('ignores ledges too high, too low, or without room on top, and jumps instead', () => {
    const lid = { components: { collider: { shape: 'box', size: [4, 0.2, 4], offset: [0, 2.6, 0] } } };
    const cases: Array<[string, Record<string, unknown>, unknown[]]> = [
      ['too high', { tall: wall(3, 2) }, [{ prefab: 'tall', at: at(2) }]],
      ['a step', { kerb: wall(0.2, 2) }, [{ prefab: 'kerb', at: at(2) }]],
      ['no room on top', { block: wall(1.5, 4), lid }, [{ prefab: 'block', at: at(4) }, { prefab: 'lid', at: [0, 0, 1.85 + 2] }]],
    ];
    for (const [, prefabs, placed] of cases) {
      const g = game({ floor: FLOOR, hero: HERO, ...prefabs }, [{ prefab: 'floor' }, ...placed, { prefab: 'hero', id: 'hero', at: [0, 0, 1] }]);
      g.run(10);
      const c = g.character('hero');
      expect(c.ledge).toBeNull();
      expect(c.jump()).toBe(true);
      g.run(1);
      expect(g.log.some(([m]) => m === 'jumped')).toBe(true);
      expect(g.log.some(([m]) => m === 'traversed')).toBe(false);
    }
  });

  it('a snapshot mid-vault restores to the same landing', () => {
    const make = () => game({ floor: FLOOR, wall: wall(1, 0.3), hero: HERO }, [{ prefab: 'floor' }, { prefab: 'wall', at: at(0.3) }, { prefab: 'hero', id: 'hero', at: [0, 0, 1] }]);
    const a = make();
    a.run(10);
    a.character('hero').jump();
    a.run(10);
    const snap = a.kernel.snapshot();
    a.run(60);
    const end = a.pos('hero');
    a.kernel.restore(snap);
    expect(a.character('hero').motion).toBe('traverse');
    a.run(60);
    expect(a.pos('hero').distance_to(end)).toBeLessThan(1e-6);
  });
});

describe('swimming (the water service)', () => {
  // Dry ground for z < 5 (top at y = 0); the pool beyond, its bed at y = -3, the surface at 0.
  const ground = { components: { collider: { shape: 'box', size: [40, 1, 25], offset: [0, -0.5, 0] } } };
  const bed = { components: { collider: { shape: 'box', size: [40, 1, 35], offset: [0, -0.5, 0] } } };
  const SWIMMER = { components: { character: { acceleration: 60, swim: {}, traversal: {} } }, behaviors: { watch: {} } };
  const scene = [{ prefab: 'ground', at: [0, 0, -7.5] }, { prefab: 'bed', at: [0, -3, 22.5] }, { prefab: 'hero', id: 'hero', at: [0, 0, 3] }];

  it('walks in, swims and floats with the surface at float_depth, dives, and climbs out with jump()', () => {
    const g = game({ ground, bed, hero: SWIMMER }, scene, { extra: [POOL_WATER] });
    const c = g.character('hero');
    g.run(20);
    expect(c.motion).toBe('ground');
    g.run(90, () => c.move(new Vec3(0, 0, 1)));
    g.run(240);
    expect(c.motion).toBe('swim');
    expect(g.log.some(([m, e]) => m === 'motion' && e['motion'] === 'swim')).toBe(true);
    // Floating: the surface 1.25 m above the feet.
    expect(g.pos('hero').y).toBeCloseTo(-1.25, 1);
    // Swimming speed, and it dives with a downward direction.
    g.run(60, () => c.move(new Vec3(0, 0, 1)));
    expect(c.velocity.flat().length()).toBeCloseTo(2.8, 1);
    g.run(30, () => c.move(new Vec3(0, -1, 0)));
    expect(g.pos('hero').y).toBeLessThan(-1.6);
    // Back to the edge and out onto the ground.
    g.run(240, () => c.move(new Vec3(0, 0, -1)));
    g.run(1, () => c.move(new Vec3(0, 0, -1)));
    expect(c.ledge).toBe('climb');
    expect(c.jump()).toBe(true);
    g.run(90);
    expect(c.motion).toBe('ground');
    expect(g.pos('hero').y).toBeCloseTo(0, 1);
    expect(g.pos('hero').z).toBeLessThan(5);
  });

  it('needs a water plugin (PP9005)', () => {
    const g = game({ ground, bed, hero: SWIMMER }, scene);
    expect(() => g.run(1)).toThrow(/PP9005[\s\S]*water/);
  });
});

describe('skydiving and the parachute', () => {
  const DIVER = { components: { character: { skydive: {}, parachute: {}, face_movement: true } }, behaviors: { watch: {} } };

  it('enters free fall high up, reaches terminal speed, glides under the canopy and lands', () => {
    const plain = { components: { collider: { shape: 'box', size: [4000, 1, 4000], offset: [0, -0.5, 0] } } };
    const g = game({ floor: plain, hero: DIVER }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero', at: [0, 400, 0] }]);
    const c = g.character('hero');
    g.run(90);
    expect(c.motion).toBe('free_fall');
    g.run(300);
    expect(-c.velocity.y).toBeCloseTo(38, 0);
    // Diving falls faster.
    g.run(120, () => c.move(new Vec3(0, 0, 0), { run: true }));
    expect(-c.velocity.y).toBeGreaterThan(50);
    expect(c.jump()).toBe(true);
    g.run(120, () => c.move(new Vec3(0, 0, 1)));
    expect(c.motion).toBe('glide');
    expect(-c.velocity.y).toBeCloseTo(4.2, 1);
    expect(c.velocity.flat().length()).toBeCloseTo(13, 0);
    // Flaring: pulling back slows the sink.
    g.run(120, () => c.move(new Vec3(0, 0, -1)));
    expect(-c.velocity.y).toBeCloseTo(1.8, 1);
    expect(c.release_parachute()).toBe(true);
    g.run(30);
    expect(c.motion).toBe('free_fall');
    expect(c.jump()).toBe(true);
    g.run(6000);
    expect(c.motion).toBe('ground');
    expect(g.log.filter(([m]) => m === 'landed').length).toBeGreaterThanOrEqual(1);
    expect(g.log.filter(([m]) => m === 'motion').map(([, e]) => e['motion'])).toEqual(['free_fall', 'glide', 'free_fall', 'glide', 'ground']);
  });

  it('a low fall never becomes free fall', () => {
    const g = game({ floor: FLOOR, hero: DIVER }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero', at: [0, 10, 0] }]);
    const seen = new Set<string>();
    g.run(200, () => seen.add(g.character('hero').motion));
    expect(seen.has('free_fall')).toBe(false);
  });
});

describe('holding and carrying', () => {
  const crate = { components: { collider: { shape: 'box', size: [0.4, 0.4, 0.4] }, rigidbody: { kind: 'dynamic', mass: 5 } } };
  const CARRIER = { components: { character: { acceleration: 1000, carry: {} } }, behaviors: { watch: {} } };

  it('holds an item at hold_offset without a Model, carries it along, then drops, throws and places it', () => {
    const g = game({ floor: FLOOR, crate, hero: CARRIER }, [{ prefab: 'floor' }, { prefab: 'crate', id: 'crate', at: [0, 0.2, 1] }, { prefab: 'hero', id: 'hero' }]);
    g.run(10);
    const c = g.character('hero');
    const item = g.id('crate');
    expect(c.hold(item)).toBe(true);
    expect(c.held).toBe(item);
    expect(c.hold(item)).toBe(false);
    g.run(60, () => c.move(new Vec3(1, 0, 0)));
    const hero = g.pos('hero');
    const held = g.pos('crate');
    // On the holder at hold_offset (0.25, 1.1, 0.55) in its frame, untouched by gravity.
    expect(held.y - hero.y).toBeCloseTo(1.1, 2);
    expect(held.distance_to(hero)).toBeCloseTo(new Vec3(0.25, 1.1, 0.55).length(), 2);
    expect(g.kernel.world.require(item).parent).toBe(g.id('hero'));
    // Dropped: it falls to the floor.
    expect(c.drop()).toBe(item);
    expect(c.held).toBeNull();
    expect(g.kernel.world.require(item).parent).toBeNull();
    g.run(90);
    expect(g.pos('crate').y).toBeLessThan(0.25);
    // Thrown: it flies.
    expect(c.hold(item)).toBe(true);
    g.run(2);
    const from = g.pos('crate');
    expect(c.throw(new Vec3(0, 2, 6))).toBe(item);
    g.run(10);
    expect(g.pos('crate').z - from.z).toBeGreaterThan(0.6);
    g.run(120);
    // Placed: exactly there, at rest.
    expect(c.hold(item)).toBe(true);
    expect(c.place(new Vec3(5, 0.2, 5), { yaw: 90 })).toBe(item);
    g.run(30);
    expect(g.pos('crate').distance_to(new Vec3(5, 0.2, 5))).toBeLessThan(0.05);
  });

  it('lifts another character (it is carried and doesn\'t move by itself), slows down, and puts it down where there is room', () => {
    const g = game({ floor: FLOOR, hero: CARRIER, buddy: { components: { character: {} } }, wall: box([2, 2, 2]) },
      [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }, { prefab: 'buddy', id: 'buddy', at: [0, 0, 1] }]);
    g.run(10);
    const c = g.character('hero');
    const buddy = g.character('buddy');
    expect(c.lift(g.id('buddy'))).toBe(true);
    g.run(2);
    expect(buddy.motion).toBe('carried');
    expect(buddy.carrier).toBe(g.id('hero'));
    expect(c.carried).toBe(g.id('buddy'));
    expect(buddy.vehicle).toBeNull();
    expect(buddy.jump()).toBe(false);
    g.run(30, () => c.move(new Vec3(0, 0, 1), { run: true }));
    expect(c.velocity.z).toBeCloseTo(4 * 0.55, 3);
    expect(g.pos('buddy').y - g.pos('hero').y).toBeCloseTo(1.3, 2);
    // Something in the drop spot: it stays on the shoulders.
    const hero = g.pos('hero');
    const spot = hero.__add__(new Vec3(1.1, 0, 0.5));
    g.kernel.spawn('wall', { at: [spot.x, 0, spot.z] });
    g.run(2);
    expect(c.put_down()).toBeNull();
    expect(c.carried).toBe(g.id('buddy'));
    g.run(30, () => c.move(new Vec3(-1, 0, 0)));
    g.run(10);
    expect(c.put_down()).toBe(g.id('buddy'));
    g.run(30);
    expect(buddy.motion).toBe('ground');
    expect(c.carried).toBeNull();
  });

  it('raises PP3198 for impossible carries', () => {
    const g = game({ floor: FLOOR, hero: { components: { character: {} } } }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }, { prefab: 'hero', id: 'other', at: [2, 0, 0] }]);
    expect(() => g.character('hero').lift(g.id('other'))).toThrow(/PP3198[\s\S]*"carry": \{\}/);
    expect(() => g.character('hero').hold(g.id('hero'))).toThrow(/PP3198/);
  });
});

describe('seats', () => {
  const chair = { components: { seat: { offset: [0, 0.5, 0], facing: 180, exits: [[0, 0, 1.2]], enter_time: 0.4 } } };

  it('sits down over enter_time, rides the seat, and stands up at a free exit', () => {
    const g = game({ floor: FLOOR, chair, hero: HERO }, [{ prefab: 'floor' }, { prefab: 'chair', id: 'chair', at: [0, 0, 4] }, { prefab: 'hero', id: 'hero' }]);
    g.run(10);
    const c = g.character('hero');
    expect(c.sit(g.id('chair'))).toBe(true);
    expect(g.fields('chair', 'seat')['occupant']).toBe(g.id('hero'));
    g.run(10);
    expect(c.motion).toBe('seated');
    expect(g.pos('hero').z).toBeGreaterThan(0.2);
    expect(g.pos('hero').z).toBeLessThan(3.8);
    g.run(30);
    expect(g.pos('hero').distance_to(new Vec3(0, 0.5, 4))).toBeLessThan(1e-3);
    expect(c.seat).toBe(g.id('chair'));
    expect(g.log.filter(([m]) => m === 'seated').length).toBe(1);
    expect(c.jump()).toBe(false);
        expect(c.leave_seat()).toBe(true);
    expect(g.fields('chair', 'seat')['occupant']).toBeNull();
    g.run(40);
    expect(c.seat).toBeNull();
    expect(g.pos('hero').x).toBeCloseTo(0, 3);
    expect(g.pos('hero').z).toBeCloseTo(5.2, 1);
    g.run(30);
    expect(c.motion).toBe('ground');
    expect(g.log.filter(([m]) => m === 'left').length).toBe(1);
  });

  it('stays seated when every exit is blocked; a taken seat refuses', () => {
    const g = game({ floor: FLOOR, chair, hero: HERO, wall: box([2, 2, 1]) },
      [{ prefab: 'floor' }, { prefab: 'chair', id: 'chair', at: [0, 0, 4] }, { prefab: 'wall', at: [0, 0, 5.4] }, { prefab: 'hero', id: 'hero' },
        { prefab: 'hero', id: 'late', at: [3, 0, 0] }]);
    g.run(10);
    const c = g.character('hero');
    expect(c.sit(g.id('chair'))).toBe(true);
    g.run(40);
    expect(g.character('late').sit(g.id('chair'))).toBe(false);
    expect(c.leave_seat()).toBe(false);
    g.run(10);
    expect(c.motion).toBe('seated');
    expect(g.pos('hero').distance_to(new Vec3(0, 0.5, 4))).toBeLessThan(1e-3);
  });
});

describe('the Animator', () => {
  it('sets the params the graph declares and fires its triggers', () => {
    const animator = { params: { speed: 0, grounded: false, stance: 0, crouched: false, jumped: 'trigger' } };
    const hero = { components: { character: { acceleration: 1000, stances: {} }, model: { model: 'hero.glb' }, animator } };
    const g = game({ floor: FLOOR, hero }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }], { visuals: true, extra: [CLIPS] });
    const c = g.character('hero');
    const anim = g.fields('hero', 'animator') as Fields & { param(n: string): unknown };
    g.run(30, () => c.move(new Vec3(1, 0, 0)));
    expect(anim.param('speed')).toBeCloseTo(4, 3);
    expect(anim.param('grounded')).toBe(true);
    c.set_stance('crouch');
    g.run(2);
    expect(anim.param('stance')).toBe(1);
    expect(anim.param('crouched')).toBe(true);
  });

  it('raises PP3176 for a declared param of the wrong kind', () => {
    const hero = { components: { character: {}, model: { model: 'hero.glb' }, animator: { params: { grounded: 0 } } } };
    const g = game({ floor: FLOOR, hero }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }], { visuals: true, extra: [CLIPS] });
    expect(() => g.run(2)).toThrow(/PP3176[\s\S]*"grounded"/);
  });

  it('"character" root motion moves the character by the clip through the controller', () => {
    const hero = { components: { character: {}, model: { model: 'hero.glb' }, animator: { default_clip: 'stride', root_motion: 'character' } } };
    const g = game({ floor: FLOOR, hero, wall: box([4, 2, 1]) }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }, { prefab: 'wall', at: [0, 0, 4] }],
      { visuals: true, extra: [CLIPS] });
    g.run(60);
    const z0 = g.pos('hero').z;
    g.run(60);
    expect(g.pos('hero').z - z0).toBeCloseTo(1.5, 1);
    // Walls still stop it.
    g.run(240);
    expect(g.pos('hero').z).toBeLessThan(3.5 - 0.35 + 0.05);
    expect(g.pos('hero').y).toBeLessThan(0.05);
  });
});

describe('ragdolls', () => {
  it('a limp character neither moves nor steers; it walks again once recovered', () => {
    const hero = { components: { character: { acceleration: 1000 }, ragdoll: {} }, behaviors: { watch: {} } };
    const g = game({ floor: FLOOR, hero }, [{ prefab: 'floor' }, { prefab: 'hero', id: 'hero' }]);
    g.run(10);
    const c = g.character('hero');
    const ragdoll = g.fields('hero', 'ragdoll') as Fields & { go_limp(): void; recover(blend?: number): void; readonly mode: string | null };
    ragdoll.go_limp();
    g.run(2);
    expect(c.motion).toBe('ragdoll');
    expect(c.jump()).toBe(false);
    g.run(120, () => c.move(new Vec3(1, 0, 0)));
    expect(c.velocity.length()).toBe(0);
    ragdoll.recover(0.2);
    g.run(30);
    expect(ragdoll.mode).toBeNull();
    const x0 = g.pos('hero').x;
    g.run(60, () => c.move(new Vec3(1, 0, 0)));
    expect(c.motion).toBe('ground');
    expect(g.pos('hero').x - x0).toBeCloseTo(4, 0);
    expect(g.log.filter(([m]) => m === 'motion').map(([, e]) => e['motion'])).toContain('ragdoll');
  });
});

describe('validation', () => {
  it('raises the first rule a character breaks when it arrives', () => {
    const bad = (character: Record<string, unknown>) => () => game({ floor: FLOOR, hero: { components: { character } } }, [{ prefab: 'floor' }, { prefab: 'hero' }]);
    expect(bad({ stances: { crouch_height: 0.5 } })).toThrow(/PP3177[\s\S]*diameter 0\.7/);
    expect(bad({ swim: { exit_depth: 1.5 } })).toThrow(/PP3178/);
    expect(bad({ parachute: {} })).toThrow(/PP3179[\s\S]*"skydive"/);
    expect(bad({ traversal: { vault_height: 3 } })).toThrow(/PP3180/);
  });
});

describe('a humanoid course (headless scenario)', () => {
  it('runs up, vaults a wall, climbs a block, picks up a crate on top, carries it to a bench and sits', () => {
    const crate = { components: { collider: { shape: 'box', size: [0.4, 0.4, 0.4] }, rigidbody: { kind: 'dynamic' } } };
    const bench = { components: { seat: { offset: [0, 2.4, 0], exits: [[0, 2, -1]] } } };
    const RUNNER = { components: { character: { acceleration: 60, stances: {}, traversal: {} } }, behaviors: { watch: {} } };
    const g = game({ floor: FLOOR, wall: box([6, 1, 0.3]), block: box([6, 2, 6]), crate, bench, hero: RUNNER }, [
      { prefab: 'floor' }, { prefab: 'wall', at: [0, 0, 4] }, { prefab: 'block', at: [0, 0, 10] }, { prefab: 'crate', id: 'crate', at: [0, 2.2, 9] },
      { prefab: 'bench', id: 'bench', at: [0, 0, 11] }, { prefab: 'hero', id: 'hero' },
    ]);
    const c = g.character('hero');
    const forward = new Vec3(0, 0, 1);
    // Run at the wall and jump when a ledge is ahead; repeat for the block.
    const kinds: string[] = [];
    for (let i = 0; i < 900 && g.pos('hero').y < 1.9; i++) {
      g.run(1, () => c.move(forward, { run: true }));
      if (c.ledge !== null) {
        kinds.push(c.ledge);
        expect(c.jump()).toBe(true);
        g.run(70);
      }
    }
    expect(kinds).toEqual(['vault', 'climb']);
    expect(g.pos('hero').y).toBeCloseTo(2, 1);
    // On top: pick up the crate, carry it toward the bench, and sit.
    expect(c.hold(g.id('crate'))).toBe(true);
    g.run(30, () => c.move(forward));
    expect(c.sit(g.id('bench'))).toBe(true);
    g.run(40);
    expect(c.motion).toBe('seated');
    expect(c.held).toBe(g.id('crate'));
    expect(g.pos('crate').distance_to(g.pos('hero'))).toBeLessThan(1.3);
    expect(c.leave_seat()).toBe(true);
    g.run(40);
    expect(c.motion).toBe('ground');
    expect(g.log.filter(([m]) => m === 'traversed').map(([, e]) => e['kind'])).toEqual(['vault', 'climb']);
  });
});
