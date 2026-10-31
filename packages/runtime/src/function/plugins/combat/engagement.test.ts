/**
 * Strikes, hit reactions, lock-on, aim assist and impact damage on a bare kernel: a
 * stand-in for the visuals plugin (an `animation_event` event, an Animator with a
 * `trigger` method, a model rig service whose "hand" socket the test swings) and for the
 * destruction plugin's `breakable_damaged`.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { MODEL_RIG_SERVICE } from '../../services/index.js';
import { combat, ENGAGEMENT_EVENTS, segmentDistance } from './index.js';
import type { CombatNamespace, StrikeRef } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

class Ref implements StrikeRef {
  constructor(readonly id: string, readonly kind: string, readonly data: unknown) {}
}
const strike = (id: string, data: Record<string, unknown>): Ref => new Ref(id, 'strike', {
  damage: 10, kind: null, socket: 'hand', offset: [0, 0, 0], reach: [0, 0, 1.2], radius: 0.1, active: [0, 0.2],
  start_event: null, end_event: null, duration: null, max_targets: 0, friendly_fire: false, knockback: 0, stagger: 0, reaction: null,
  ...data,
});

const ANIMATION_EVENT: EventDef = { id: 'animation_event', target: 'entity' };
const BREAKABLE_DAMAGED: EventDef = { id: 'breakable_damaged', target: 'entity' };

function setup(entities: unknown[], strikes: Record<string, Ref> = {}) {
  /** The hand's yaw (deg) about the attacker; the test swings it. */
  const hand = { yaw: -90 };
  const triggered: string[] = [];
  const visuals: KernelPlugin = {
    id: 'fake_visuals',
    events: [ANIMATION_EVENT, BREAKABLE_DAMAGED],
    components: [{
      id: 'animator', schema: {},
      // Declares only the "flinch" trigger, as a real Animator's graph would.
      methods: {
        trigger(this: Fields, name: string) { triggered.push(name); },
        has_param(this: Fields, name: string, kind: string) { return name === 'flinch' && kind === 'trigger'; },
      },
    }],
    install(k) {
      k.provide(MODEL_RIG_SERVICE, {
        rig: () => null,
        socket: (entity, socket) => {
          if (socket !== 'hand') return null;
          const t = k.world.require(entity).transform;
          return { position: t.worldPosition().__add__(new Vec3(0, 1, 0)), rotation: t.worldRotation().__mul__(Quat.from_euler(new Vec3(0, hand.yaw, 0))) };
        },
      });
    },
  };
  const log: Array<[string, Fields]> = [];
  const watch: BehaviorDef = {
    id: 'watch', params: {}, state: {}, requires: [],
    handlers: Object.entries(ENGAGEMENT_EVENTS).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(ENGAGEMENT_EVENTS).map((m) => [m, (_c: unknown, e: Fields) => { log.push([m, e]); }])) as LogicInstance,
  };
  const project = loadProject(files({
    'prefabs/fighter.prefab.json': { components: { health: { max: 100, current: 100, destroy_on_death: false }, striker: {}, side: { side: 'red' } }, behaviors: { watch: {} } },
    'prefabs/dummy.prefab.json': { components: { health: { max: 100, current: 100, destroy_on_death: false }, side: { side: 'blue' }, animator: {} }, behaviors: { watch: {} } },
    'prefabs/ally.prefab.json': { components: { health: { max: 100, current: 100 }, side: { side: 'red' } } },
    'prefabs/head.prefab.json': { components: { health: { max: 100, current: 100 }, side: { side: 'blue' }, hurtbox: { zones: [
      { name: 'body', offset: [0, 0.4, 0], length: 0.8, radius: 0.35 }, { name: 'head', offset: [0, 1.5, 0], length: 0.1, radius: 0.25, multiplier: 2 },
    ] } } },
    'prefabs/player.prefab.json': { components: { health: {}, side: { side: 'red' }, lock_on: { range: 20, angle: 60, line_of_sight: false } }, behaviors: { watch: {} } },
    'prefabs/crate.prefab.json': { components: { health: { max: 50, current: 50 }, impact_damage: { from_breakable: true } } },
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics.map((d) => d.message)).toEqual([]);
  const plugin = combat({
    host: {
      tag: (id) => id,
      effect: () => { throw new Error('no effects here'); },
      strike: (_k, id) => strikes[id]!,
    },
  });
  const kernel = new Kernel({ project, game: { components: [], resources: [], events: [], behaviors: [watch], systems: [] }, plugins: [visuals, plugin], context: {}, fixedStep: DT });
  const ns = plugin.namespace!.create(kernel) as CombatNamespace;
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  const get = (placed: string, c: string) => kernel.world.require(id(placed)).components.get(c) as Fields & Record<string, any>;
  return { kernel, ns, hand, triggered, log, id, get, step: (n = 1, each?: () => void) => { for (let i = 0; i < n; i++) { each?.(); kernel.step(DT); } } };
}

describe('segment distance', () => {
  it('measures closest points between segments', () => {
    const d = segmentDistance(new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 1, -1), new Vec3(0, 1, 1));
    expect(d.distance).toBeCloseTo(1, 9);
    expect(d.point.is_close(new Vec3(0, 0.5, 0))).toBe(true);
    expect(segmentDistance(new Vec3(0, 0, 0), new Vec3(0, 0, 0), new Vec3(3, 0, 0), new Vec3(3, 0, 0)).distance).toBeCloseTo(3, 9);
  });
});

describe('swept strikes', () => {
  const ENTITIES = [{ id: 'a', prefab: 'fighter' }, { id: 'd', prefab: 'dummy', at: [0, 0, 1.5] }];

  it('a swing too fast to touch the target on any frame still hits it (the sweep), once, with its reaction', () => {
    const jab = strike('jab', { knockback: 0, stagger: 0.5, reaction: 'flinch', active: [0, 0.1] });
    const g = setup(ENTITIES, { jab });
    g.get('a', 'striker').strike(jab);
    // Frame 1 at −90°, frame 2 at +90°: the blade passes the dummy between frames.
    g.step(1);
    g.hand.yaw = 90;
    g.step(1);
    expect(g.get('d', 'health').current).toBe(90);
    expect(g.get('d', 'health').staggered).toBe(true);
    expect(g.triggered).toEqual(['flinch']);
    g.hand.yaw = -90;
    g.step(2);
    expect(g.get('d', 'health').current).toBe(90); // one hit per strike
    const hits = g.log.filter(([m]) => m === 'strikeHit');
    expect(hits.length).toBe(1);
    expect(hits[0]![1]['source']).toBe(g.id('a'));
    g.step(40);
    expect(g.get('d', 'health').staggered).toBe(false);
    expect(g.get('a', 'striker').striking).toBe(false);
  });

  it("a reaction the target's Animator doesn't declare is skipped, not raised", () => {
    const jab = strike('jab', { reaction: 'stumble', active: [0, 0.1] });
    const g = setup(ENTITIES, { jab });
    g.get('a', 'striker').strike(jab);
    g.step(1);
    g.hand.yaw = 90;
    g.step(1);
    expect(g.get('d', 'health').current).toBe(90);
    expect(g.triggered).toEqual([]);
  });

  it('only inside its active window: markers open and close it (animation events)', () => {
    const slash = strike('slash', { start_event: 'hit_on', end_event: 'hit_off' });
    const g = setup(ENTITIES, { slash });
    const striker = g.get('a', 'striker');
    striker.strike(slash);
    g.hand.yaw = 0; // the blade sits in the dummy, but the window is shut
    g.step(5);
    expect(striker.active).toBe(false);
    expect(g.get('d', 'health').current).toBe(100);
    g.kernel.emit(ANIMATION_EVENT, { entity: g.id('a'), name: 'hit_on', clip: 'slash', time: 0.1 });
    g.step(1);
    expect(striker.active).toBe(true);
    g.step(1);
    expect(g.get('d', 'health').current).toBe(90);
    g.kernel.emit(ANIMATION_EVENT, { entity: g.id('a'), name: 'hit_off', clip: 'slash', time: 0.3 });
    g.step(2);
    expect(striker.striking).toBe(false);
  });

  it('timed windows: nothing before `active[0]`; sides: allies are spared; zones multiply', () => {
    const late = strike('late', { active: [0.5, 0.6] });
    const g = setup([{ id: 'a', prefab: 'fighter' }, { id: 'f', prefab: 'ally', at: [0, 0, 1.5] }, { id: 'h', prefab: 'head', at: [0, -0.5, 1.5] }], { late });
    g.hand.yaw = 0;
    g.get('a', 'striker').strike(late);
    g.step(25);
    expect(g.get('h', 'health').current).toBe(100);
    g.step(10);
    expect(g.get('f', 'health').current).toBe(100);
    expect(g.get('h', 'health').current).toBe(80); // the hand height meets the head zone: × 2
  });

  it('snapshots keep a strike under way and who it already hit', () => {
    const jab = strike('jab', { active: [0, 1] });
    const g = setup(ENTITIES, { jab });
    g.get('a', 'striker').strike(jab);
    g.hand.yaw = 0;
    g.step(2);
    const snap = g.kernel.snapshot();
    g.step(1);
    g.kernel.restore(snap);
    expect(g.get('a', 'striker').striking).toBe(true);
    g.step(5);
    expect(g.get('d', 'health').current).toBe(90);
    expect(() => g.get('a', 'striker').strike({ id: 'x', kind: 'status_effect', data: {} })).toThrow(ParallaxError);
  });
});

describe('lock-on and aim assist', () => {
  const ENTITIES = [
    { id: 'p', prefab: 'player' },
    { id: 'left', prefab: 'dummy', at: [-4, 0, 8] }, { id: 'ahead', prefab: 'dummy', at: [0, 0, 10] }, { id: 'right', prefab: 'dummy', at: [5, 0, 9] },
    { id: 'behind', prefab: 'dummy', at: [0, 0, -5] }, { id: 'friend', prefab: 'ally', at: [0, 0, 3] },
  ];

  it('locks the best enemy in front, cycles clockwise and back, lets go when the target dies', () => {
    const g = setup(ENTITIES);
    const lock = g.get('p', 'lock_on');
    expect(lock.lock()).toBe(true);
    expect(lock.target).toBe(g.id('ahead'));
    expect(lock.cycle(1)).toBe(true);
    expect(lock.target).toBe(g.id('right'));
    expect(lock.cycle(-1)).toBe(true);
    expect(lock.target).toBe(g.id('ahead'));
    lock.cycle(-1);
    expect(lock.target).toBe(g.id('left'));
    g.get('left', 'health').kill();
    g.step(1);
    expect(lock.target).toBeNull();
    const changes = g.log.filter(([m]) => m === 'lockChanged').map(([, e]) => e['target']);
    expect(changes).toEqual([g.id('ahead'), g.id('right'), g.id('ahead'), g.id('left'), null]);
  });

  it('aim assist bends towards the enemy inside the cone, by strength; allies are ignored', () => {
    const g = setup(ENTITIES);
    const origin = new Vec3(0, 1, 0);
    const off = new Vec3(0.08, 0, 1).normalized(); // ~4.6° right of "ahead"
    const bent = g.ns.aim_assist(origin, off, { shooter: g.id('p'), angle: 8, strength: 1 }) as Vec3;
    const want = g.kernel.world.require(g.id('ahead')).transform.worldPosition().__add__(new Vec3(0, 0.9, 0)).__sub__(origin).normalized();
    expect(bent.dot(want)).toBeGreaterThan(0.9999);
    expect(g.ns.aim_target(origin, Vec3.FORWARD, { shooter: g.id('p') })).toBe(g.id('ahead'));
    expect(g.ns.aim_target(origin, new Vec3(0, 0, -1), { shooter: g.id('p'), angle: 3 })).toBe(g.id('behind'));
    const none = g.ns.aim_assist(origin, new Vec3(1, 0, 0), { shooter: g.id('p') }) as Vec3;
    expect(none.is_close(new Vec3(1, 0, 0))).toBe(true);
  });
});

describe('impacts', () => {
  it('breakable damage feeds Health when from_breakable is set', () => {
    const g = setup([{ id: 'c', prefab: 'crate' }]);
    g.kernel.emit(BREAKABLE_DAMAGED, { entity: g.id('c'), amount: 12, source: null, point: Vec3.ZERO, force: 0 });
    g.step(1);
    expect(g.get('c', 'health').current).toBe(38);
  });
});
