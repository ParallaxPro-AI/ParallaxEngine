/**
 * Combat's state outside components and the one damage pipeline (sdk/parallax/combat.pyi). Every hit — `Health.damage`, `area_damage`, drains, status-effect
 * ticks — goes through `hit()`:
 *
 *   1. dead or invulnerable (protect window, after-hit window) → nothing happens
 *   2. the game's modifiers in order; one that sets `hit.blocked` ends the hit there
 *   3. shield absorbs (timed shields first, soonest to expire first), then flat armor,
 *      then fractional armor (both skipped if `hit.ignores_armor`); a hit that got
 *      through the shield deals at least `min_damage` (never more than it had left)
 *   4. `Health.minimum` floor; `hit.lethal = False` also stops at 1
 *   5. `damaged` is emitted (also when armor or the floor left 0); `died` at 0
 *
 * Death. `died` is delivered while the entity is still alive, so its own behaviors hear
 * it and every handler reads it; with `destroy_on_death` the entity is destroyed right
 * after delivery (an internal event queued behind `died`), unless a handler revived it.
 *
 * Kept here, saved in snapshots: invulnerability deadlines, timed shields, drains, active
 * status effects. StatusEffects' stat modifiers live on the components (kernel modifiers, keyed
 * `status:<effect>` or `status:<effect>#<n>` for stacked copies), so they are saved there.
 * `Health.max` raised by a modifier keeps the health fraction; any lowering clamps
 * `current` (checked each frame and before every Health operation).
 */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import { describe, finite, tagId } from './args.js';

export const HEALTH = 'health';
export const HEALTH_BAR = 'health_bar';
export const SIDE = 'side';
/** The StatusEffects component (Python `parallax.combat.StatusEffects`). */
export const EFFECTS = 'status_effects';
export const STATUS_EFFECT = 'status_effect';

export const COMBAT_EVENTS = {
  damaged: { id: 'damaged', target: 'entity' },
  died: { id: 'died', target: 'entity' },
  healed: { id: 'healed', target: 'entity' },
  effectApplied: { id: 'effect_applied', target: 'entity' },
  effectEnded: { id: 'effect_ended', target: 'entity' },
} as const satisfies Record<string, EventDef>;

/** Queued right behind `died` for entities destroyed on death. Internal (not snake_case). */
export const TEARDOWN: EventDef = { id: 'combat.teardown', target: 'entity' };

/**
 * Speed stats a status effect's `speed_multiplier` scales, by the SDK's component and
 * field names (characters, nav, vehicles, grid). Only those an entity has are touched.
 */
export const SPEED_STATS: ReadonlyArray<readonly [string, string]> = [
  ['character', 'walk_speed'], ['character', 'run_speed'], ['nav_agent', 'speed'], ['vehicle', 'max_speed'], ['grid_mover', 'speed'],
];

/** Game time is a sum of float frame times; a tick due "at 0.5 s" must fire on the frame reaching 0.4999…. */
const DUE = 1e-9;

/** One hit travelling through the damage pipeline (Python `parallax.combat.DamageHit`): modifiers may change it. */
export class DamageHit {
  target: unknown;
  source: unknown;
  kind: unknown;
  point: unknown;
  amount: number;
  blocked = false;
  ignores_armor: boolean;
  lethal: boolean;

  constructor(target: unknown, init: HitInit) {
    this.target = target;
    this.source = init.source;
    this.kind = init.kind;
    this.point = init.point;
    this.amount = init.amount;
    this.ignores_armor = init.ignoresArmor;
    this.lethal = init.lethal;
  }

  toString(): string {
    return `DamageHit(${this.amount}${this.blocked ? ', blocked' : ''})`;
  }
}

export interface HitInit {
  readonly amount: number;
  readonly source: unknown;
  readonly kind: unknown;
  readonly point: unknown;
  readonly ignoresArmor: boolean;
  readonly lethal: boolean;
}

/** `def modifier(ctx, hit) -> None`. */
export type DamageModifier = (ctx: unknown, hit: DamageHit) => unknown;

/** A `status_effect` content entry as game code holds it (the api's ContentRef). */
export interface StatusEffectRef {
  readonly id: string;
  readonly kind: string;
  readonly data: unknown;
}

/** What the api supplies: game-facing tags, and content refs by id (for restores). */
export interface CombatHost {
  tag(id: string): unknown;
  effect(kernel: Kernel, id: string): StatusEffectRef;
  /** A `strike` content ref by id (for restores). */
  strike?(kernel: Kernel, id: string): { readonly id: string; readonly kind: string; readonly data: unknown };
}

export interface CombatSettings {
  readonly modifiers: readonly DamageModifier[];
  readonly minDamage: number;
  readonly host: CombatHost;
}

interface HealthFields extends Fields {
  current: number;
  max: number;
  shield: number;
  flat_armor: number;
  armor: number;
  minimum: number;
  invulnerable_after_hit: number;
  destroy_on_death: boolean;
}

interface StatChange {
  readonly component: string;
  readonly field: string;
  readonly multiply: number;
  readonly add: number;
}

interface EffectData {
  readonly damagePerSecond: number;
  readonly kind: unknown;
  readonly tick: number;
  readonly speedMultiplier: number;
  readonly modifiers: readonly StatChange[];
  readonly stacking: 'refresh' | 'strongest' | 'stack';
  readonly resistedBy: string | undefined;
}

interface Active {
  readonly ref: StatusEffectRef;
  readonly data: EffectData;
  readonly key: string;
  strength: number;
  ends: number;
  nextTick: number;
  source: unknown;
}

interface Shield {
  readonly key: string;
  amount: number;
  readonly expires: number | null;
}

interface Drain {
  readonly key: string;
  perSecond: number;
  kind: unknown;
  tick: number;
  next: number;
}

/** Health fields whose `current` is an accessor (see #trackCurrent) → the stored value. */
const RAW_CURRENT = new WeakMap<Fields, { value: number }>();

interface Unit {
  until: number;
  shields: Shield[];
  drains: Drain[];
  effects: Active[];
  /** Stacked copies applied so far (keys stay unique). */
  copies: number;
  /** Last seen `max` (base and effective), to tell modifier changes from assignments. */
  max: { base: number; value: number } | undefined;
}

interface SavedUnit {
  readonly id: number;
  readonly until: number;
  readonly shields: ReadonlyArray<{ readonly key: string; readonly amount: number; readonly expires: number | null }>;
  readonly drains: ReadonlyArray<{ readonly key: string; readonly per_second: number; readonly kind: string | null; readonly tick: number; readonly next: number }>;
  readonly effects: ReadonlyArray<{
    readonly effect: string; readonly key: string; readonly strength: number; readonly ends: number; readonly next_tick: number;
    readonly source: number | null;
  }>;
  readonly copies: number;
}

export interface CombatSnapshot {
  readonly units: readonly SavedUnit[];
}

export class CombatState {
  readonly kernel: Kernel;
  readonly #settings: CombatSettings;
  readonly #units = new Map<EntityId, Unit>();
  readonly #seq = new Map<EntityId, number>();
  #nextSeq = 0;

  constructor(kernel: Kernel, settings: CombatSettings) {
    this.kernel = kernel;
    this.#settings = settings;
  }

  get host(): CombatHost {
    return this.#settings.host;
  }

  // ── Entity lifecycle ─────────────────────────────────────────────────────────

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.#seq.set(record.id, this.#nextSeq++);
      this.#observe(record);
    }
  }

  changed(record: EntityRecord): void {
    this.#observe(record);
    const unit = this.#units.get(record.id);
    if (unit === undefined) return;
    if (!record.components.has(EFFECTS)) for (const active of [...unit.effects]) this.#end(record.id, unit, active);
    if (!record.components.has(HEALTH)) {
      unit.until = 0;
      unit.shields = [];
      unit.drains = [];
      unit.max = undefined;
    }
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.#units.delete(record.id);
      this.#seq.delete(record.id);
    }
  }

  /**
   * Present `Side.side` as game code compares it (data holds a tag id; game code passes Tag
   * handles), and start tracking a Health (its frame upkeep and `max` changes).
   */
  #observe(record: EntityRecord): void {
    const side = record.components.get(SIDE);
    if (side !== undefined && typeof side['side'] === 'string') side['side'] = this.host.tag(side['side']);
    const fields = record.components.get(HEALTH) as HealthFields | undefined;
    if (fields !== undefined) {
      this.#trackCurrent(record.id, fields);
      this.#syncMax(record.id, fields);
    }
  }

  /**
   * `current` settles any pending `max` change before every read and write, so a `max`
   * modifier rescales the value it found, and an assignment made after the modifier is
   * kept as written (`modify(Health, "max", ...)` then `h.current = 2` is 2).
   */
  #trackCurrent(id: EntityId, fields: HealthFields): void {
    if (RAW_CURRENT.has(fields)) return;
    const raw = { value: fields.current };
    RAW_CURRENT.set(fields, raw);
    Object.defineProperty(fields, 'current', {
      enumerable: true, configurable: true,
      get: () => { this.#syncMax(id, fields); return raw.value; },
      set: (value: number) => { this.#syncMax(id, fields); raw.value = value; },
    });
  }

  #unit(id: EntityId): Unit {
    let unit = this.#units.get(id);
    if (unit === undefined) {
      unit = { until: 0, shields: [], drains: [], effects: [], copies: 0, max: undefined };
      this.#units.set(id, unit);
    }
    return unit;
  }

  #ordered(): EntityId[] {
    return [...this.#units.keys()].sort((a, b) => (this.#seq.get(a) ?? 0) - (this.#seq.get(b) ?? 0));
  }

  // ── Health ───────────────────────────────────────────────────────────────────

  /** The live entity's Health fields, with `max` changes since last seen applied to `current`. */
  health(id: EntityId): HealthFields {
    const fields = this.kernel.world.require(id).components.get(HEALTH) as HealthFields | undefined;
    if (fields === undefined) fail('PP3001', 'This entity has no Health', { fix: 'Add "health" to its prefab.' });
    this.#syncMax(id, fields);
    return fields;
  }

  #syncMax(id: EntityId, fields: HealthFields): void {
    const value = fields.max;
    const base = this.kernel.base(id, HEALTH, 'max') as number;
    const unit = this.#unit(id);
    const seen = unit.max;
    if (seen !== undefined && seen.value === value && seen.base === base) return;
    unit.max = { base, value };
    if (seen === undefined || seen.value === value) return;
    // Work on the stored value (not the accessor, which would sync again).
    const raw = RAW_CURRENT.get(fields);
    let current = raw === undefined ? fields.current : raw.value;
    if (value > seen.value && base === seen.base && seen.value > 0) current *= value / seen.value;
    if (current > value) current = value;
    if (raw === undefined) fields.current = current;
    else raw.value = current;
  }

  invulnerable(id: EntityId): boolean {
    return this.kernel.time.now < (this.#units.get(id)?.until ?? 0);
  }

  protect(id: EntityId, seconds: number): void {
    const unit = this.#unit(id);
    unit.until = Math.max(unit.until, this.kernel.time.now + seconds);
  }

  /** Run one hit through the pipeline. `landed`: it got past invulnerability and the modifiers. */
  hit(id: EntityId, init: HitInit): { dealt: number; landed: boolean } {
    const fields = this.health(id);
    if (fields.current <= 0 || this.invulnerable(id)) return { dealt: 0, landed: false };
    const kernel = this.kernel;
    const hit = new DamageHit(kernel.handles.wrap(id), init);
    for (const modifier of this.#settings.modifiers) {
      modifier(kernel.context, hit);
      if (hit.blocked === true) return { dealt: 0, landed: false };
    }
    let amount = finite(hit.amount, 'hit.amount (after the damage modifiers)');
    if (amount <= 0) return { dealt: 0, landed: false };

    const absorbed = this.#absorb(id, fields, amount);
    amount -= absorbed;
    if (amount > 0 && hit.ignores_armor !== true) {
      const armored = Math.max(0, amount - fields.flat_armor) * (1 - fields.armor);
      amount = Math.max(armored, Math.min(this.#settings.minDamage, amount));
    }
    const before = fields.current;
    let after = Math.max(0, before - amount);
    after = Math.max(after, Math.min(before, fields.minimum));
    if (hit.lethal === false) after = Math.max(after, Math.min(before, 1));
    fields.current = after;
    const dealt = before - after;
    if (dealt > 0 && fields.invulnerable_after_hit > 0) this.protect(id, fields.invulnerable_after_hit);
    kernel.emit(COMBAT_EVENTS.damaged, {
      entity: hit.target, amount: dealt, source: hit.source, kind: hit.kind, point: hit.point, shield_absorbed: absorbed,
    });
    if (after <= 0) this.#died(id, fields, hit.source);
    return { dealt, landed: true };
  }

  kill(id: EntityId, source: unknown): void {
    const fields = this.health(id);
    if (fields.current <= 0) return;
    fields.current = 0;
    this.#died(id, fields, source);
  }

  #died(id: EntityId, fields: HealthFields, source: unknown): void {
    const entity = this.kernel.handles.wrap(id);
    this.kernel.emit(COMBAT_EVENTS.died, { entity, source });
    if (fields.destroy_on_death) this.kernel.emit(TEARDOWN, { entity });
  }

  /** After `died` was delivered: destroy the entity if it is still dead. */
  teardown(payload: Fields): void {
    const id = this.kernel.handles.unwrap(payload['entity']);
    const record = id === undefined ? undefined : this.kernel.world.get(id);
    const fields = record?.components.get(HEALTH) as HealthFields | undefined;
    if (record !== undefined && fields !== undefined && fields.current <= 0 && fields.destroy_on_death) this.kernel.destroy(record.id);
  }

  heal(id: EntityId, amount: number): number {
    const fields = this.health(id);
    if (fields.current <= 0 || amount <= 0) return 0;
    const before = fields.current;
    const after = Math.max(before, Math.min(fields.max, before + amount));
    fields.current = after;
    const healed = after - before;
    if (healed > 0) this.kernel.emit(COMBAT_EVENTS.healed, { entity: this.kernel.handles.wrap(id), amount: healed });
    return healed;
  }

  revive(id: EntityId, health: number | null): void {
    const fields = this.health(id);
    const value = health ?? fields.max;
    if (!(value > 0)) fail('PP3905', `revive(health=${value}) must bring the entity above 0`, { fix: 'Pass a positive health, or None for full.' });
    fields.current = Math.min(value, fields.max);
  }

  // ── Shields and drains ───────────────────────────────────────────────────────

  addShield(id: EntityId, amount: number, seconds: number | null, key: string): void {
    const fields = this.health(id);
    const unit = this.#unit(id);
    this.#fitShields(unit, fields);
    const old = unit.shields.find((s) => s.key === key);
    if (old !== undefined) {
      fields.shield = Math.max(0, fields.shield - old.amount);
      unit.shields.splice(unit.shields.indexOf(old), 1);
    }
    unit.shields.push({ key, amount, expires: seconds === null ? null : this.kernel.time.now + seconds });
    fields.shield += amount;
  }

  /** Timed shields in the order hits use them up: soonest to expire first, untimed last. */
  #shieldOrder(unit: Unit): Shield[] {
    return [...unit.shields].sort((a, b) => (a.expires ?? Infinity) - (b.expires ?? Infinity));
  }

  /** Game code may lower `shield` directly; keyed shields never hold more than it does. */
  #fitShields(unit: Unit, fields: HealthFields): void {
    let excess = unit.shields.reduce((sum, s) => sum + s.amount, 0) - fields.shield;
    for (const shield of this.#shieldOrder(unit)) {
      if (excess <= 0) break;
      const cut = Math.min(shield.amount, excess);
      shield.amount -= cut;
      excess -= cut;
    }
    unit.shields = unit.shields.filter((s) => s.amount > 0);
  }

  #absorb(id: EntityId, fields: HealthFields, amount: number): number {
    const absorbed = Math.min(fields.shield, amount);
    if (absorbed <= 0) return 0;
    const unit = this.#unit(id);
    this.#fitShields(unit, fields);
    fields.shield -= absorbed;
    let left = absorbed;
    for (const shield of this.#shieldOrder(unit)) {
      const used = Math.min(shield.amount, left);
      shield.amount -= used;
      left -= used;
    }
    unit.shields = unit.shields.filter((s) => s.amount > 0);
    return absorbed;
  }

  drain(id: EntityId, perSecond: number, key: string, kind: unknown, tick: number): void {
    this.health(id);
    const unit = this.#unit(id);
    const existing = unit.drains.find((d) => d.key === key);
    if (perSecond === 0) {
      if (existing !== undefined) unit.drains.splice(unit.drains.indexOf(existing), 1);
      return;
    }
    if (existing !== undefined) {
      existing.perSecond = perSecond;
      existing.kind = kind;
      existing.tick = tick;
      return;
    }
    unit.drains.push({ key, perSecond, kind, tick, next: this.kernel.time.now + tick });
  }

  // ── Status effects ───────────────────────────────────────────────────────────

  #effectData(ref: StatusEffectRef): EffectData {
    const where = `status_effect "${ref.id}"`;
    const data = ref.data as Record<string, unknown>;
    const damagePerSecond = finite(data['damage_per_second'], `${where} damage_per_second`);
    const tick = finite(data['tick'], `${where} tick`);
    if (damagePerSecond !== 0 && !(tick > 0)) {
      fail('PP3903', `${where} deals damage every ${tick} s`, { fix: 'Give it a "tick" greater than 0 (seconds between damage).' });
    }
    const stacking = data['stacking'];
    if (stacking !== 'refresh' && stacking !== 'strongest' && stacking !== 'stack') {
      fail('PP3903', `${where} stacking is ${describe(stacking)}`, { fix: 'Use "refresh", "strongest" or "stack".' });
    }
    const rawKind = data['damage_kind'] ?? null;
    const resisted = data['resisted_by'] ?? null;
    const modifiers = ((data['modifiers'] ?? []) as Array<Record<string, unknown>>).map((m, i) => {
      const at = `${where} modifiers[${i}]`;
      const component = m['component'];
      const field = m['field'];
      if (typeof component !== 'string' || typeof field !== 'string') fail('PP3903', `${at} needs a component and a field name`);
      this.kernel.registry.component(component, at);
      return { component, field, multiply: finite(m['multiply'], `${at} multiply`), add: finite(m['add'], `${at} add`) };
    });
    return {
      damagePerSecond,
      kind: typeof rawKind === 'string' ? this.host.tag(rawKind) : rawKind,
      tick,
      speedMultiplier: finite(data['speed_multiplier'], `${where} speed_multiplier`),
      modifiers,
      stacking,
      resistedBy: resisted === null ? undefined : tagId(resisted, `${where} resisted_by`),
    };
  }

  /** The stat modifiers of one application, at its strength, on the components the entity has. */
  #modify(id: EntityId, active: Active): void {
    const record = this.kernel.world.require(id);
    const s = active.strength;
    for (const m of active.data.modifiers) {
      if (!record.components.has(m.component)) continue;
      this.kernel.modify(id, m.component, m.field, { key: active.key, multiply: 1 + (m.multiply - 1) * s, add: m.add * s });
    }
    if (active.data.speedMultiplier === 1) return;
    for (const [component, field] of SPEED_STATS) {
      if (!record.components.has(component)) continue;
      this.kernel.modify(id, component, field, { key: active.key, multiply: 1 + (active.data.speedMultiplier - 1) * s });
    }
  }

  apply(id: EntityId, ref: StatusEffectRef, seconds: number, strength: number, source: unknown): void {
    const record = this.kernel.world.require(id);
    const data = this.#effectData(ref);
    if (data.resistedBy !== undefined && record.tags.has(data.resistedBy)) return;
    const unit = this.#unit(id);
    const now = this.kernel.time.now;
    const current = unit.effects.find((a) => a.ref.id === ref.id);
    let active: Active;
    if (current !== undefined && data.stacking !== 'stack') {
      if (data.stacking === 'strongest' && strength < current.strength) return;
      const ends = now + seconds;
      current.ends = data.stacking === 'strongest' && strength === current.strength ? Math.max(current.ends, ends) : ends;
      current.strength = strength;
      current.source = source;
      active = current;
    } else {
      const key = data.stacking === 'stack' ? `status:${ref.id}#${++unit.copies}` : `status:${ref.id}`;
      active = { ref, data, key, strength, ends: now + seconds, nextTick: now + data.tick, source };
      unit.effects.push(active);
    }
    this.#modify(id, active);
    this.kernel.emit(COMBAT_EVENTS.effectApplied, { entity: this.kernel.handles.wrap(id), effect: ref });
  }

  #end(id: EntityId, unit: Unit, active: Active): void {
    unit.effects.splice(unit.effects.indexOf(active), 1);
    if (this.kernel.world.isAlive(id)) this.kernel.unmodify(id, active.key);
    if (!unit.effects.some((a) => a.ref.id === active.ref.id)) {
      this.kernel.emit(COMBAT_EVENTS.effectEnded, { entity: this.kernel.handles.wrap(id), effect: active.ref });
    }
  }

  removeEffect(id: EntityId, effectId: string): void {
    this.kernel.world.require(id);
    const unit = this.#units.get(id);
    if (unit === undefined) return;
    for (const active of unit.effects.filter((a) => a.ref.id === effectId)) this.#end(id, unit, active);
  }

  /** Active strength of an effect: the sum over stacked copies; 0 when not active. */
  strength(id: EntityId, effectId: string): number {
    return (this.#units.get(id)?.effects ?? []).filter((a) => a.ref.id === effectId).reduce((sum, a) => sum + a.strength, 0);
  }

  hasEffect(id: EntityId, effectId: string): boolean {
    return (this.#units.get(id)?.effects ?? []).some((a) => a.ref.id === effectId);
  }

  // ── The frame ────────────────────────────────────────────────────────────────

  /** Shields expire, drains and effects tick and expire, `max` changes settle; in spawn order. */
  update(): void {
    const now = this.kernel.time.now;
    for (const id of this.#ordered()) {
      const unit = this.#units.get(id);
      const record = this.kernel.world.get(id);
      if (unit === undefined || record === undefined) continue;
      const fields = record.components.get(HEALTH) as HealthFields | undefined;
      if (fields !== undefined) {
        this.#syncMax(id, fields);
        this.#fitShields(unit, fields);
        for (const shield of unit.shields.filter((s) => s.expires !== null && s.expires <= now + DUE)) {
          fields.shield = Math.max(0, fields.shield - shield.amount);
          unit.shields.splice(unit.shields.indexOf(shield), 1);
        }
        for (const drain of [...unit.drains]) {
          while (drain.next <= now + DUE && unit.drains.includes(drain)) {
            this.hit(id, { amount: drain.perSecond * drain.tick, kind: drain.kind, source: null, point: null, ignoresArmor: false, lethal: true });
            drain.next += drain.tick;
          }
        }
      }
      for (const active of [...unit.effects]) {
        if (!unit.effects.includes(active)) continue;
        const data = active.data;
        if (data.damagePerSecond > 0) {
          while (active.nextTick <= Math.min(active.ends, now) + DUE) {
            if (fields !== undefined) {
              this.hit(id, {
                amount: data.damagePerSecond * active.strength * data.tick, kind: data.kind, source: active.source, point: null,
                ignoresArmor: false, lethal: true,
              });
            }
            active.nextTick += data.tick;
          }
        }
        if (active.ends <= now + DUE) this.#end(id, unit, active);
      }
    }
  }

  // ── Sides and areas ──────────────────────────────────────────────────────────

  /** A side's tag id, or undefined for neutral (also readable while being destroyed). */
  sideOf(id: EntityId): string | undefined {
    const side = this.kernel.world.peek(id)?.components.get(SIDE);
    return side === undefined ? undefined : tagId(side['side'], 'Side.side');
  }

  areEnemies(a: EntityId, b: EntityId): boolean {
    if (a === b) return false;
    const sa = this.sideOf(a);
    const sb = this.sideOf(b);
    return sa !== undefined && sb !== undefined && sa !== sb;
  }

  /** Every living Health within `radius` of `center`, damaged through the pipeline; returns those it landed on. */
  areaDamage(center: Vec3 | Vec2, radius: number, amount: number, source: unknown, kind: unknown, falloff: boolean,
    friendlyFire: boolean): EntityId[] {
    const sourceId = source === null ? undefined : this.kernel.handles.unwrap(source);
    const sourceSide = sourceId === undefined ? undefined : this.sideOf(sourceId);
    const hits: EntityId[] = [];
    for (const [id, fields] of this.kernel.world.query([HEALTH])) {
      if ((fields as HealthFields).current <= 0) continue;
      if (!friendlyFire && (id === sourceId || (sourceSide !== undefined && this.sideOf(id) === sourceSide))) continue;
      const at = this.kernel.world.require(id).transform.worldPosition();
      const d = center instanceof Vec3 ? at.distance_to(center) : Math.hypot(at.x - center.x, at.y - center.y);
      if (d > radius) continue;
      const scaled = falloff && radius > 0 ? amount * (1 - d / radius) : amount;
      const result = this.hit(id, { amount: scaled, source, kind, point: center, ignoresArmor: false, lethal: true });
      if (result.landed) hits.push(id);
    }
    return hits;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): CombatSnapshot {
    const handles = this.kernel.handles;
    const entity = (value: unknown): number | null => (value === null ? null : handles.unwrap(value) ?? null);
    const kind = (value: unknown): string | null => (value === null ? null : tagId(value, 'saved damage kind'));
    return {
      units: this.#ordered().map((id) => {
        const u = this.#units.get(id)!;
        return {
          id,
          until: u.until,
          shields: u.shields.map((s) => ({ key: s.key, amount: s.amount, expires: s.expires })),
          drains: u.drains.map((d) => ({ key: d.key, per_second: d.perSecond, kind: kind(d.kind), tick: d.tick, next: d.next })),
          effects: u.effects.map((a) => ({
            effect: a.ref.id, key: a.key, strength: a.strength, ends: a.ends, next_tick: a.nextTick, source: entity(a.source),
          })),
          copies: u.copies,
        };
      }),
    };
  }

  restore(state: Json): void {
    const saved = state as unknown as CombatSnapshot;
    this.#units.clear();
    this.#seq.clear();
    this.#nextSeq = 0;
    const handles = this.kernel.handles;
    for (const u of saved.units) {
      const id = u.id as EntityId;
      if (!this.kernel.world.isAlive(id)) continue;
      this.#units.set(id, {
        until: u.until,
        shields: u.shields.map((s) => ({ ...s })),
        drains: u.drains.map((d) => ({
          key: d.key, perSecond: d.per_second, kind: d.kind === null ? null : this.host.tag(d.kind), tick: d.tick, next: d.next,
        })),
        effects: u.effects.map((a) => {
          const ref = this.host.effect(this.kernel, a.effect);
          return {
            ref, data: this.#effectData(ref), key: a.key, strength: a.strength, ends: a.ends, nextTick: a.next_tick,
            source: a.source === null ? null : handles.wrap(a.source as EntityId),
          };
        }),
        copies: u.copies,
        max: undefined,
      });
    }
    for (const record of this.kernel.world.live()) {
      this.#seq.set(record.id, this.#nextSeq++);
      this.#observe(record);
    }
  }
}
