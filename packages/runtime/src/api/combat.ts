/**
 * `parallax.combat` (sdk/parallax/combat.pyi): the Health, HealthBar, Side, StatusEffects and
 * Projectile handles, the combat events, `DamageHit` (what damage modifiers receive), and the built-in
 * `status_effect` content kind with its `StatModifier` record. The behavior lives in the
 * combat plugin; this module is the Python-facing names for it.
 */

import { fail } from '../core/index.js';
import {
  COMBAT_EVENTS, combat as combatPlugin, EFFECTS, EFFECTS_SCHEMA, ENGAGEMENT_EVENTS, HEALTH, HEALTH_BAR, HEALTH_BAR_SCHEMA,
  HEALTH_SCHEMA, HURTBOX, HURTBOX_SCHEMA, IMPACT_DAMAGE, IMPACT_DAMAGE_SCHEMA, LOCK_ON, LOCK_ON_SCHEMA, PROJECTILE,
  PROJECTILE_EVENTS, PROJECTILE_SCHEMA, SIDE, SIDE_SCHEMA, STATUS_EFFECT, STRIKE, STRIKER, STRIKER_SCHEMA,
} from '../function/plugins/combat/index.js';
import type { DamageModifier, StatusEffectRef, StrikeRef } from '../function/plugins/combat/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import type { Context } from './context.js';
import { content, declareBuiltIns, record } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs, kw } from './kwargs.js';
import { Color, field, Localized, rt, Tag, Vec3 } from './types.js';

export { DamageHit } from '../function/plugins/combat/index.js';
export type { CombatNamespace as CombatApi, DamageModifier } from '../function/plugins/combat/index.js';

/** `entity.get(Health)`: current, max, shield, armor… and damage / heal / kill / revive / protect. */
export const Health = componentHandle({ id: HEALTH, schema: HEALTH_SCHEMA }, 'Health');
export const HealthBar = componentHandle({ id: HEALTH_BAR, schema: HEALTH_BAR_SCHEMA }, 'HealthBar');
/** `Side(side=Blue)`: different sides are enemies; no Side is neutral. */
export const Side = componentHandle({ id: SIDE, schema: SIDE_SCHEMA }, 'Side');
/** `entity.get(StatusEffects).apply(Content.status_effect.venom, 3, strength=1.5)`. */
export const StatusEffects = componentHandle({ id: EFFECTS, schema: EFFECTS_SCHEMA }, 'StatusEffects');

/** `entity.get(Striker).strike(Content.strike.jab)`: active, striking, current; cancel(). */
export const Striker = componentHandle({ id: STRIKER, schema: STRIKER_SCHEMA }, 'Striker');
/** Where strikes land on this entity: capsule zones on sockets with damage multipliers. */
export const Hurtbox = componentHandle({ id: HURTBOX, schema: HURTBOX_SCHEMA }, 'Hurtbox');
/** `entity.get(LockOn).lock()` / cycle(direction) / release(); `target` is kept by the engine. */
export const LockOn = componentHandle({ id: LOCK_ON, schema: LOCK_ON_SCHEMA }, 'LockOn');
/** Contact forces (and, opt-in, breakable damage) into this entity's Health. */
export const ImpactDamage = componentHandle({ id: IMPACT_DAMAGE, schema: IMPACT_DAMAGE_SCHEMA }, 'ImpactDamage');

/** Launched with `ctx.combat.fire(...)`; `retire()` puts one back in the pool. */
export const Projectile = componentHandle({ id: PROJECTILE, schema: PROJECTILE_SCHEMA }, 'Projectile');
export const ProjectileHit = eventHandle(PROJECTILE_EVENTS.projectileHit, 'ProjectileHit');
export const ProjectileExpired = eventHandle(PROJECTILE_EVENTS.projectileExpired, 'ProjectileExpired');

export const StrikeHit = eventHandle(ENGAGEMENT_EVENTS.strikeHit, 'StrikeHit');
export const LockChanged = eventHandle(ENGAGEMENT_EVENTS.lockChanged, 'LockChanged');

class HurtZoneFields {
  static readonly __annotations__ = {
    name: () => rt.str, socket: () => rt.optional(rt.str), offset: () => Vec3, length: () => rt.float, radius: () => rt.float,
    multiplier: () => rt.float,
  };
  static readonly name = '';
  static readonly socket = null;
  static readonly offset = new Vec3(0, 0, 0);
  static readonly length = 0;
  static readonly radius = 0.3;
  static readonly multiplier = 1;
}
/** One Hurtbox zone: a capsule from `offset` up `length` m along the socket's +y. */
export const HurtZone = record(HurtZoneFields);

class StrikeFields {
  static readonly __annotations__ = {
    damage: () => rt.float, kind: () => rt.optional(Tag), socket: () => rt.optional(rt.str), offset: () => Vec3, reach: () => Vec3,
    radius: () => rt.float, active: () => rt.list(rt.float), start_event: () => rt.optional(rt.str), end_event: () => rt.optional(rt.str),
    duration: () => rt.optional(rt.float), max_targets: () => rt.int, friendly_fire: () => rt.bool, knockback: () => rt.float,
    stagger: () => rt.float, reaction: () => rt.optional(rt.str),
  };
  static readonly damage = field(10);
  static readonly kind = field(null);
  static readonly socket = field(null, kw({ doc: 'Model socket the capsule rides; None: the attacker itself.' }));
  static readonly offset = field(new Vec3(0, 0, 0));
  static readonly reach = field(new Vec3(0, 0, 1));
  static readonly radius = field(0.15, kw({ min: 0, unit: 'm' }));
  static readonly active = field([0, 0.2], kw({ unit: 's', doc: '[start, end] after strike(); unused with start_event/end_event.' }));
  static readonly start_event = field(null);
  static readonly end_event = field(null);
  static readonly duration = field(null, kw({ unit: 's' }));
  static readonly max_targets = field(0, kw({ min: 0 }));
  static readonly friendly_fire = field(false);
  static readonly knockback = field(0, kw({ min: 0, unit: 'N·s' }));
  static readonly stagger = field(0, kw({ min: 0, unit: 's' }));
  static readonly reaction = field(null, kw({ doc: 'Animator trigger fired on the target.' }));
}

/** Built-in content kind: melee strikes in content/strike/*.json. */
export const StrikeDef = declareBuiltIns(() => content(STRIKE)(StrikeFields), 'combat');

export const Damaged = eventHandle(COMBAT_EVENTS.damaged, 'Damaged');
export const Died = eventHandle(COMBAT_EVENTS.died, 'Died');
export const Healed = eventHandle(COMBAT_EVENTS.healed, 'Healed');
export const EffectApplied = eventHandle(COMBAT_EVENTS.effectApplied, 'EffectApplied');
export const EffectEnded = eventHandle(COMBAT_EVENTS.effectEnded, 'EffectEnded');

class StatModifierFields {
  static readonly __annotations__ = {
    component: () => rt.str, field: () => rt.str, multiply: () => rt.float, add: () => rt.float,
  };
  static readonly multiply = field(1);
  static readonly add = field(0);
}

/** A modifier a status effect applies while active: component id + field. */
export const StatModifier = record(StatModifierFields);

class StatusEffectFields {
  static readonly __annotations__ = {
    name: () => Localized,
    damage_per_second: () => rt.float,
    damage_kind: () => rt.optional(Tag),
    tick: () => rt.float,
    speed_multiplier: () => rt.float,
    modifiers: () => rt.list(StatModifier),
    tint: () => rt.optional(Color),
    stacking: () => rt.str,
    resisted_by: () => rt.optional(Tag),
  };
  static readonly damage_per_second = field(0, kw({ doc: 'At strength 1.' }));
  static readonly damage_kind = field(null);
  static readonly tick = field(0.5, kw({ unit: 's', doc: 'How often damage is applied (and Damaged emitted).' }));
  static readonly speed_multiplier = field(1, kw({ doc: 'At strength 1; applied as a stat modifier.' }));
  static readonly modifiers = field([]);
  static readonly tint = field(null);
  static readonly stacking = field('refresh', kw({ choices: ['refresh', 'strongest', 'stack'] }));
  static readonly resisted_by = field(null, kw({ doc: 'Entities with this tag are immune.' }));
}

/** Built-in content kind: games add entries in content/status_effect/*.json. */
export const StatusEffectDef = declareBuiltIns(() => content(STATUS_EFFECT)(StatusEffectFields), 'combat');

/**
 * `parallax.plugins.combat(*, modifiers=(), min_damage=0)`: binds Python arguments and
 * builds the kernel plugin. The plugins module re-exports this as `combat`.
 */
export function combat(...args: unknown[]): KernelPlugin {
  const a = bindArgs('combat', args, { keyword: ['modifiers', 'min_damage'] }).args;
  const given = a['modifiers'] ?? [];
  if (typeof given !== 'object' || given === null || !(Symbol.iterator in given)) {
    fail('PP3900', 'combat(modifiers=...) must be a list of functions', { fix: 'Pass modifiers=[my_modifier].' });
  }
  const minDamage = a['min_damage'] ?? 0;
  if (typeof minDamage !== 'number') fail('PP3900', `combat(min_damage=...) must be a number, got ${String(minDamage)}`);
  return combatPlugin({
    modifiers: [...(given as Iterable<DamageModifier>)],
    minDamage,
    host: {
      tag: (id) => Tag.of(id),
      effect: (kernel, id) => (kernel.context as Context).content(StatusEffectDef).get(id) as unknown as StatusEffectRef,
      strike: (kernel, id) => (kernel.context as Context).content(StrikeDef).get(id) as unknown as StrikeRef,
    },
  });
}
