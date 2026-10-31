import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, EventDef, Fields, GameDefinition, LogicInstance, SystemDef } from '../../kernel/index.js';
import { combat, COMBAT_EVENTS, DamageHit } from './index.js';
import type { CombatNamespace, CombatOptions, DamageModifier, StatusEffectRef } from './index.js';

const DT = 1 / 60;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : `not a ParallaxError: ${String(error)}`;
  }
  return undefined;
}

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** A game-facing tag, as the api's Tag behaves for the plugin (id + stored form + equality). */
class TestTag {
  constructor(readonly id: string) {}
  get __tag_id__(): string { return this.id; }
  __eq__(o: unknown): boolean { return o instanceof TestTag && o.id === this.id; }
  toJSON(): string { return this.id; }
}
const tags = new Map<string, TestTag>();
const tag = (id: string): TestTag => {
  let t = tags.get(id);
  if (t === undefined) tags.set(id, t = new TestTag(id));
  return t;
};

/** A content ref as the api presents it: a class instance (defaults filled, tags as ids). */
class TestRef implements StatusEffectRef {
  constructor(readonly id: string, readonly kind: string, readonly data: unknown) {}
}

function effect(id: string, data: Record<string, unknown>): StatusEffectRef {
  return new TestRef(id, 'status_effect', {
      damage_per_second: 0, damage_kind: null, tick: 0.5, speed_multiplier: 1, modifiers: [], tint: null,
      stacking: 'refresh', resisted_by: null, ...data,
  });
}

const EFFECTS = {
  venom: effect('venom', { damage_per_second: 1, damage_kind: 'poison', tick: 0.5, stacking: 'strongest' }),
  chill: effect('chill', { modifiers: [{ component: 'invader', field: 'speed', multiply: 0, add: 0 }], stacking: 'strongest' }),
  burn: effect('burn', { damage_per_second: 2, tick: 1, stacking: 'stack' }),
  daze: effect('daze', { speed_multiplier: 0.5, resisted_by: 'boss' }),
};

interface Health extends Fields {
  current: number;
  max: number;
  shield: number;
  flat_armor: number;
  armor: number;
  minimum: number;
  invulnerable_after_hit: number;
  destroy_on_death: boolean;
  damage(...args: unknown[]): number;
  add_shield(...args: unknown[]): null;
  drain(...args: unknown[]): null;
  heal(...args: unknown[]): number;
  kill(...args: unknown[]): null;
  revive(...args: unknown[]): null;
  protect(...args: unknown[]): null;
  readonly invulnerable: boolean;
  readonly dead: boolean;
  readonly fraction: number;
  readonly entity: unknown;
}

interface Effects extends Fields {
  apply(...args: unknown[]): null;
  remove(...args: unknown[]): null;
  has(...args: unknown[]): boolean;
  strength(...args: unknown[]): number;
}

type Log = Array<[string, EntityId, Fields]>;

interface Setup {
  readonly kernel: Kernel;
  readonly combat: CombatNamespace;
  readonly log: Log;
  id(placed: string): EntityId;
  health(e: EntityId): Health;
  effects(e: EntityId): Effects;
  steps(n: number): void;
}

const EVENT_NAMES = Object.fromEntries(Object.entries(COMBAT_EVENTS).map(([k, v]) => [v.id, k])) as Record<string, string>;

/** A behavior that logs every combat event its entity hears, and runs `onDied`. */
function listener(log: Log, onDied?: (self: EntityId, k: () => Kernel) => void, kernel?: () => Kernel): BehaviorDef {
  const events: EventDef[] = Object.values(COMBAT_EVENTS);
  return {
    id: 'listen',
    params: {},
    state: {},
    requires: [],
    handlers: events.map((event) => ({ event, method: event.id })),
    create: () => Object.fromEntries(events.map((event) => [event.id, function (this: LogicInstance, _ctx: unknown, e: Fields) {
      log.push([EVENT_NAMES[event.id]!, this['entity'] as EntityId, e]);
      if (event === COMBAT_EVENTS.died && onDied !== undefined) onDied(this['entity'] as EntityId, kernel!);
    }])) as LogicInstance,
  };
}

const GAME_COMPONENTS: ComponentDef[] = [
  { id: 'invader', schema: { speed: t.number({ default: 0, modifiable: true }) } },
  { id: 'character', schema: { walk_speed: t.number({ default: 4, modifiable: true }), run_speed: t.number({ default: 7, modifiable: true }) } },
  { id: 'plating', schema: { points: t.number({ default: 0 }) } },
];

function setup(
  prefabs: Record<string, unknown>, entities: unknown[],
  options: Partial<CombatOptions> = {}, extra: { onDied?: (self: EntityId, k: () => Kernel) => void; systems?: SystemDef[] } = {},
): Setup {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const log: Log = [];
  let kernel: Kernel | undefined;
  const plugin = combat({
    host: {
      tag,
      effect: (_k, id) => EFFECTS[id as keyof typeof EFFECTS] ?? (() => { throw new Error(`no effect ${id}`); })(),
    },
    ...options,
  });
  const game: GameDefinition = {
    components: GAME_COMPONENTS, resources: [], events: [], behaviors: [listener(log, extra.onDied, () => kernel!)],
    systems: extra.systems ?? [],
  };
  kernel = new Kernel({ project, game, plugins: [plugin], context: { game: 'ctx' }, fixedStep: DT });
  const ns = plugin.namespace!.create(kernel) as CombatNamespace;
  kernel.start('main');
  const k = kernel;
  const id = (placed: string): EntityId => [...k.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel: k,
    combat: ns,
    log,
    id,
    health: (e) => k.world.peek(e)!.components.get('health') as Health,
    effects: (e) => k.world.require(e).components.get('status_effects') as Effects,
    steps: (n) => { for (let i = 0; i < n; i++) k.step(DT); },
  };
}

const UNIT = {
  components: { health: { current: 100, max: 100 }, status_effects: {} },
  behaviors: { listen: {} },
};

function one(prefab: Record<string, unknown> = UNIT, options: Partial<CombatOptions> = {}, extra = {}): Setup & { e: EntityId } {
  const g = setup({ unit: prefab }, [{ id: 'u', prefab: 'unit' }], options, extra);
  return Object.assign(g, { e: g.id('u') });
}

describe('the damage pipeline', () => {
  it('runs shield, then flat armor, then fractional armor, and reports what it dealt', () => {
    const g = one({ ...UNIT, components: { health: { current: 100, max: 100, shield: 5, flat_armor: 2, armor: 0.5 } } });
    const h = g.health(g.e);
    const point = new Vec3(1, 2, 3);
    expect(h.damage(15, { kind: tag('fire'), point })).toBe(4); // 15 - 5 shield - 2 flat = 8, halved
    expect(h.current).toBe(96);
    expect(h.shield).toBe(0);
    g.steps(1);
    expect(g.log).toEqual([['damaged', g.e, { entity: g.e, amount: 4, source: null, kind: tag('fire'), point, shield_absorbed: 5 }]]);
  });

  it('min_damage: a hit through the shield deals at least that much, but never more than it had', () => {
    const g = one({ ...UNIT, components: { health: { current: 30, max: 30, flat_armor: 5 } } }, { minDamage: 1 });
    const h = g.health(g.e);
    expect(h.damage(3)).toBe(1);
    expect(h.current).toBe(29);
    expect(h.damage(0.25)).toBe(0.25);
    h.shield = 10;
    expect(h.damage(4)).toBe(0);
    expect(h.current).toBe(28.75);
  });

  it('ignores_armor skips both armors; minimum and lethal=False are floors', () => {
    const g = one({ ...UNIT, components: { health: { current: 10, max: 10, flat_armor: 3, armor: 0.5 } } });
    const h = g.health(g.e);
    expect(h.damage(4, { ignores_armor: true })).toBe(4);
    expect(h.damage(100, { lethal: false })).toBe(5);
    expect(h.current).toBe(1);
    expect(h.dead).toBe(false);
    h.minimum = 1;
    h.current = 5;
    expect(h.damage(100, { ignores_armor: true })).toBe(4);
    expect(h.current).toBe(1);
  });

  it('runs the game modifiers in order on every hit; they may block, rescale and write state', () => {
    const seen: string[] = [];
    const poison = tag('poison');
    const venomPierces: DamageModifier = (ctx, hit) => {
      seen.push(`venom:${JSON.stringify(ctx)}`);
      if (hit.kind === poison) hit.ignores_armor = true;
    };
    const plating: DamageModifier = (_ctx, hit) => {
      seen.push('plating');
      const record = g.kernel.world.require(hit.target as EntityId);
      const plate = record.components.get('plating');
      if (plate === undefined) return;
      const soaked = Math.min(plate['points'] as number, hit.amount / 2);
      plate['points'] = (plate['points'] as number) - soaked;
      hit.amount -= soaked;
    };
    const dodge: DamageModifier = (_ctx, hit) => {
      seen.push('dodge');
      if (hit.source !== null) hit.blocked = true;
    };
    const g = one({ ...UNIT, components: { health: { current: 50, max: 50, flat_armor: 10 }, plating: { points: 3 } } },
      { modifiers: [venomPierces, plating, dodge] });
    const h = g.health(g.e);
    expect(h.damage(8, { kind: poison })).toBe(5);
    expect(seen).toEqual(['venom:{"game":"ctx"}', 'plating', 'dodge']);
    expect(g.kernel.world.require(g.e).components.get('plating')!['points']).toBe(0);
    seen.length = 0;
    expect(h.damage(8, { source: g.e })).toBe(0);
    g.steps(1);
    expect(g.log.filter(([e]) => e === 'damaged')).toHaveLength(1);
  });

  it('invulnerability blocks hits: protect() and invulnerable_after_hit', () => {
    const g = one({ ...UNIT, components: { health: { current: 10, max: 10, invulnerable_after_hit: 0.5 } } });
    const h = g.health(g.e);
    expect(h.damage(2)).toBe(2);
    expect(h.invulnerable).toBe(true);
    expect(h.damage(2)).toBe(0);
    g.steps(31);
    expect(h.invulnerable).toBe(false);
    h.protect(1);
    expect(h.damage(2)).toBe(0);
    g.steps(61);
    expect(h.damage(2)).toBe(2);
    expect(h.current).toBe(6);
  });

  it('checks its arguments with coded errors', () => {
    const g = one();
    const h = g.health(g.e);
    expect(code(() => h.damage('5'))).toBe('PP3900');
    expect(code(() => h.damage(5, { kinde: tag('x') }))).toBe('PP3030');
    expect(code(() => h.damage(5, { kind: 5 }))).toBe('PP3004');
    expect(code(() => h.damage(5, { source: 'me' }))).toBe('PP3901');
    expect(code(() => h.revive({ health: 0 }))).toBe('PP3905');
    expect(code(() => g.effects(g.e).apply(new TestRef('venom', 'item', {}), 1))).toBe('PP3902');
  });
});

describe('death', () => {
  it('Died reaches the dying entity\'s own behaviors and systems, then the entity is destroyed', () => {
    const read: unknown[] = [];
    const watcher: SystemDef = {
      id: 'watch', scenes: [], handlers: [{ event: COMBAT_EVENTS.died, method: 'died' }],
      create: () => ({ died: (_ctx: unknown, e: Fields) => { read.push(g.kernel.world.require(e['entity'] as EntityId).transform.position); } }),
    };
    const g = setup({ unit: UNIT }, [{ id: 'u', prefab: 'unit', at: [3, 4] }], {}, { systems: [watcher] });
    const e = g.id('u');
    const killer = g.kernel.spawn('unit').id;
    g.health(e).damage(60);
    g.health(e).damage(60, { source: killer });
    expect(g.health(e).dead).toBe(true);
    expect(g.kernel.world.isAlive(e)).toBe(true);
    g.steps(1);
    expect(g.log.map(([ev, self]) => [ev, self])).toEqual([['damaged', e], ['damaged', e], ['died', e]]);
    expect(g.log[2]![2]).toEqual({ entity: e, source: killer });
    expect(read).toEqual([new Vec3(3, 4, 0)]);
    expect(g.kernel.world.isAlive(e)).toBe(false);
    expect(g.health(killer).dead).toBe(false);
  });

  it('kill() between frames: one Died, no Damaged; destroy_on_death=False keeps the entity', () => {
    const g = one({ ...UNIT, components: { health: { current: 5, max: 5, destroy_on_death: false } } });
    const h = g.health(g.e);
    h.kill();
    h.kill();
    expect(h.damage(5)).toBe(0);
    g.steps(1);
    expect(g.log.map(([ev]) => ev)).toEqual(['died']);
    expect(g.kernel.world.isAlive(g.e)).toBe(true);
    expect(h.heal(5)).toBe(0);
    h.revive();
    expect(h.current).toBe(5);
    h.revive({ health: 2 });
    expect(h.current).toBe(2);
  });

  it('a Died handler that revives the entity keeps it alive', () => {
    const g = one(UNIT, {}, { onDied: (self: EntityId, k: () => Kernel) => {
      (k().world.require(self).components.get('health') as Health).revive({ health: 10 });
    } });
    g.health(g.e).kill();
    g.steps(1);
    expect(g.kernel.world.isAlive(g.e)).toBe(true);
    expect(g.health(g.e).current).toBe(10);
  });

  it('heals up to max and reports it', () => {
    const g = one();
    const h = g.health(g.e);
    h.current = 90;
    expect(h.heal(25)).toBe(10);
    expect(h.heal(5)).toBe(0);
    expect(h.fraction).toBe(1);
    g.steps(1);
    expect(g.log).toEqual([['healed', g.e, { entity: g.e, amount: 10 }]]);
  });
});

describe('shields, drains and max', () => {
  it('a timed shield soaks hits first and expires by itself; the same key replaces', () => {
    const g = one();
    const h = g.health(g.e);
    h.add_shield(100, { seconds: 2 });
    expect(h.shield).toBe(100);
    h.damage(60);
    expect(h.current).toBe(100);
    expect(h.shield).toBe(40);
    h.add_shield(30, { key: 'vest' });
    h.add_shield(50, { seconds: 2 });
    expect(h.shield).toBe(80);
    g.steps(150);
    expect(h.shield).toBe(30);
    // The vest (no expiry) is used up after timed shields.
    h.add_shield(10, { seconds: 5, key: 'ward' });
    h.damage(15);
    expect(h.shield).toBe(25);
    g.steps(310);
    expect(h.shield).toBe(25);
  });

  it('drain() ticks through the pipeline, idempotent per key; 0 stops it', () => {
    const g = one();
    const h = g.health(g.e);
    for (let i = 0; i < 30; i++) {
      h.drain(4, { key: 'starving' });
      g.steps(1);
    }
    expect(h.current).toBe(98); // one tick of 4 × 0.5 s
    h.drain(10, { key: 'starving' });
    h.drain(2, { key: 'drowning', kind: tag('water'), tick: 0.25 });
    g.steps(30);
    expect(h.current).toBe(98 - 5 - 1);
    h.drain(0, { key: 'starving' });
    h.drain(0, { key: 'drowning' });
    g.steps(120);
    expect(h.current).toBe(92);
    expect(g.log.filter(([e, , p]) => e === 'damaged' && p['kind'] === tag('water'))).toHaveLength(2);
    expect(code(() => h.drain(1))).toBe('PP3030');
  });

  it('raising max with a modifier keeps the health fraction; assigning max does not; lowering clamps', () => {
    const g = one();
    const h = g.health(g.e);
    h.current = 50;
    g.kernel.modify(g.e, 'health', 'max', { key: 'refit', add: 100 });
    expect(h.fraction).toBe(0.5);
    expect(h.current).toBe(100);
    g.kernel.unmodify(g.e, 'refit');
    g.steps(1);
    expect(h.current).toBe(100);
    h.max = 120;
    h.heal(10);
    expect(h.current).toBe(110);
    h.max = 60;
    expect(h.fraction).toBe(1);
    expect(h.current).toBe(60);
  });

  it('an assignment to current right after a max modifier is kept as written', () => {
    const g = one();
    const h = g.health(g.e);
    h.max = 3;
    h.current = 2;
    g.kernel.modify(g.e, 'health', 'max', { key: 'stem', add: 1 });
    h.current = 2;
    h.heal(1);
    expect(h.current).toBe(3);
  });
});

describe('status effects', () => {
  const invader = {
    components: { health: { current: 30, max: 30 }, status_effects: {}, invader: { speed: 3 } },
    behaviors: { listen: {} },
  };
  const venomPierces: DamageModifier = (_ctx, hit) => {
    if (hit.kind instanceof TestTag && hit.kind.__eq__(tag('poison'))) hit.ignores_armor = true;
  };

  it('armor blunts every hit to at least 1; venom ticks ignore it (tower siege)', () => {
    const g = one(invader, { minDamage: 1, modifiers: [venomPierces] });
    const h = g.health(g.e);
    h.flat_armor = 5;
    h.damage(3);
    expect(h.current).toBe(29);
    g.effects(g.e).apply(EFFECTS.venom, 1, { strength: 12 });
    g.steps(60);
    expect(h.current).toBe(29 - 12);
    expect(g.effects(g.e).has(EFFECTS.venom)).toBe(false);
    const kinds = g.log.filter(([e]) => e === 'damaged').map(([, , p]) => p['kind']);
    expect(kinds).toEqual([null, tag('poison'), tag('poison')]);
  });

  it('strongest: a weaker application doesn\'t replace a stronger one; modifiers scale with strength', () => {
    const g = one(invader);
    const fx = g.effects(g.e);
    const speed = (): number => g.kernel.world.require(g.e).components.get('invader')!['speed'] as number;
    fx.apply(EFFECTS.chill, 2, { strength: 0.65 });
    fx.apply(EFFECTS.chill, 2, { strength: 0.5 });
    expect(fx.strength(EFFECTS.chill)).toBe(0.65);
    expect(speed()).toBeCloseTo(3 * 0.35);
    fx.apply(EFFECTS.chill, 2, { strength: 1 });
    expect(speed()).toBe(0);
    g.steps(121);
    expect(fx.has(EFFECTS.chill)).toBe(false);
    expect(speed()).toBe(3);
    g.steps(1);
    expect(g.log.map(([e]) => e)).toEqual(['effectApplied', 'effectApplied', 'effectEnded']);
    expect(g.log[2]![2]).toEqual({ entity: g.e, effect: EFFECTS.chill });
  });

  it('refresh resets duration; stack keeps independent copies', () => {
    const g = one(invader);
    const fx = g.effects(g.e);
    const h = g.health(g.e);
    fx.apply(EFFECTS.burn, 1.5);
    fx.apply(EFFECTS.burn, 1.5, { strength: 2 });
    expect(fx.strength(EFFECTS.burn)).toBe(3);
    g.steps(60);
    expect(h.current).toBe(30 - 2 - 4);
    g.steps(60);
    expect(fx.has(EFFECTS.burn)).toBe(false);
    expect(h.current).toBe(24);
    fx.apply(EFFECTS.chill, 1);
    g.steps(50);
    fx.apply(EFFECTS.chill, 1);
    g.steps(50);
    expect(fx.has(EFFECTS.chill)).toBe(true);
    fx.remove(EFFECTS.chill);
    expect(fx.has(EFFECTS.chill)).toBe(false);
    expect(fx.strength(EFFECTS.chill)).toBe(0);
  });

  it('speed_multiplier slows every speed stat the entity has; resisted_by makes immune', () => {
    const g = setup({
      walker: { components: { status_effects: {}, character: {} } },
      boss: { components: { status_effects: {}, character: {} }, tags: ['boss'] },
    }, [{ id: 'w', prefab: 'walker' }, { id: 'b', prefab: 'boss' }]);
    const w = g.id('w');
    g.effects(w).apply(EFFECTS.daze, 1, { strength: 0.5 });
    const character = g.kernel.world.require(w).components.get('character')!;
    expect(character['walk_speed']).toBeCloseTo(4 * 0.75);
    expect(character['run_speed']).toBeCloseTo(7 * 0.75);
    g.effects(g.id('b')).apply(EFFECTS.daze, 1);
    expect(g.effects(g.id('b')).has(EFFECTS.daze)).toBe(false);
    expect(g.kernel.world.require(g.id('b')).components.get('character')!['walk_speed']).toBe(4);
  });
});

describe('ctx.combat and sides', () => {
  const prefabs = {
    red: { components: { health: { current: 10, max: 10 }, side: { side: 'red' } } },
    blue: { components: { health: { current: 10, max: 10 }, side: { side: 'blue' } } },
    rock: { components: { health: { current: 10, max: 10 } } },
  };
  const scene = [
    { id: 'r1', prefab: 'red', at: [0, 0, 0] }, { id: 'r2', prefab: 'red', at: [2, 0, 0] },
    { id: 'b1', prefab: 'blue', at: [1, 0, 0] }, { id: 'b2', prefab: 'blue', at: [8, 0, 0] }, { id: 'rock', prefab: 'rock', at: [0, 0, 3] },
  ];

  it('different sides are enemies; no Side is neutral; Side.side reads as a Tag', () => {
    const g = setup(prefabs, scene);
    expect(g.combat.are_enemies(g.id('r1'), g.id('b1'))).toBe(true);
    expect(g.combat.are_enemies(g.id('r1'), g.id('r2'))).toBe(false);
    expect(g.combat.are_enemies(g.id('r1'), g.id('rock'))).toBe(false);
    expect(g.combat.are_enemies(g.id('r1'), g.id('r1'))).toBe(false);
    expect(g.kernel.world.require(g.id('r1')).components.get('side')!['side']).toBe(tag('red'));
    expect(code(() => g.combat.are_enemies(g.id('r1')))).toBe('PP3030');
  });

  it('area_damage hits every Health in range with falloff, sparing the source\'s side unless friendly_fire', () => {
    const g = setup(prefabs, scene);
    const hit = g.combat.area_damage(new Vec3(0, 0, 0), 4, 8, { source: g.id('r1') });
    expect(hit).toEqual([g.id('b1'), g.id('rock')]);
    expect(g.health(g.id('b1')).current).toBe(10 - 6);
    expect(g.health(g.id('rock')).current).toBe(10 - 2);
    expect(g.health(g.id('r2')).current).toBe(10);
    const all = g.combat.area_damage(new Vec3(0, 0, 0), 4, 3, { falloff: false, friendly_fire: true, kind: tag('fire') });
    expect(all).toEqual([g.id('r1'), g.id('r2'), g.id('b1'), g.id('rock')]);
    expect(g.health(g.id('r1')).current).toBe(7);
    g.health(g.id('r2')).kill();
    expect(g.combat.area_damage(new Vec3(2, 0, 0), 0.5, 1)).toEqual([]);
  });
});

describe('snapshots', () => {
  it('restores shields, drains, effects and invulnerability exactly', () => {
    const g = one({ ...UNIT, components: { health: { current: 100, max: 100 }, status_effects: {}, invader: { speed: 3 } } });
    const h = g.health(g.e);
    h.add_shield(20, { seconds: 1 });
    h.drain(4, { key: 'starving', kind: tag('hunger') });
    g.effects(g.e).apply(EFFECTS.burn, 2, { strength: 1.5 });
    g.effects(g.e).apply(EFFECTS.chill, 3, { strength: 0.5 });
    h.protect(0.3);
    g.steps(10);
    const snap = JSON.parse(JSON.stringify(g.kernel.snapshot())) as ReturnType<Kernel['snapshot']>;
    const trace = (): unknown[] => {
      const out: unknown[] = [];
      for (let i = 0; i < 200; i++) {
        g.steps(1);
        // A restore builds new component objects: read them fresh.
        const record = g.kernel.world.get(g.e);
        const now = g.health(g.e);
        out.push([now.current, now.shield, now.invulnerable, record?.components.get('invader')!['speed']]);
      }
      return out;
    };
    const first = trace();
    g.kernel.restore(snap);
    const second = trace();
    expect(second).toEqual(first);
  });
});

describe('combat plugin', () => {
  it('serves one kernel and checks its options', () => {
    const plugin = combat({ host: { tag, effect: () => EFFECTS.venom } });
    const project = loadProject(files({ 'scenes/main/scene.json': { entities: [] } }));
    const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
    new Kernel({ project, game, plugins: [plugin] });
    expect(code(() => new Kernel({ project, game, plugins: [plugin] }))).toBe('PP9901');
    expect(code(() => combat({ host: { tag, effect: () => EFFECTS.venom }, minDamage: -1 }))).toBe('PP3900');
    expect(code(() => combat({ host: { tag, effect: () => EFFECTS.venom }, modifiers: [5 as never] }))).toBe('PP3900');
    expect(new DamageHit(1, { amount: 2, source: null, kind: null, point: null, ignoresArmor: false, lethal: true }).blocked).toBe(false);
  });
});
