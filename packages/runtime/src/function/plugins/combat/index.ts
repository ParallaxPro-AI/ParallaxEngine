/**
 * combat — health, the damage pipeline, death, sides, status effects and pooled
 * projectiles (sdk/parallax/combat.pyi). Contributes the `health`, `health_bar`,
 * `side`, `effects` and `projectile` components, the `damaged` / `died` / `healed` /
 * `effect_applied` / `effect_ended` / `projectile_hit` / `projectile_expired` events and
 * `ctx.combat` (with `fire`); one engine system ticks shields, drains and effects in
 * `update` (before the game's systems) and destroys the dead after `died`; projectiles
 * move in the kernel's 'physics' hook.
 *
 * One `combat(...)` value serves one kernel (its component methods are bound to it).
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EventDef, Fields, Handler, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { finite } from './args.js';
import { combatComponents } from './components.js';
import { ENGAGEMENT_EVENTS, Engagement } from './engagement.js';
import type { EngagementSnapshot } from './engagement.js';
import { engagementComponents } from './engagement_components.js';
import { combatNamespace } from './namespace.js';
import { PROJECTILE_EVENTS, projectileComponent, stepProjectiles } from './projectiles.js';
import { COMBAT_EVENTS, CombatState, TEARDOWN } from './state.js';
import type { CombatHost, DamageModifier } from './state.js';

export { EFFECTS_SCHEMA, HEALTH_BAR_SCHEMA, HEALTH_SCHEMA, SIDE_SCHEMA } from './components.js';
export { PROJECTILE, PROJECTILE_EVENTS, PROJECTILE_MOTIONS, PROJECTILE_SCHEMA, turnTowards } from './projectiles.js';
export { ENGAGEMENT_EVENTS, HURTBOX, IMPACT_DAMAGE, LOCK_ON, segmentDistance, STRIKE, STRIKER } from './engagement.js';
export type { StrikeRef } from './engagement.js';
export { HURTBOX_SCHEMA, IMPACT_DAMAGE_SCHEMA, LOCK_ON_SCHEMA, STRIKER_SCHEMA } from './engagement_components.js';
export type { CombatNamespace } from './namespace.js';
export { COMBAT_EVENTS, DamageHit, EFFECTS, HEALTH, HEALTH_BAR, SIDE, SPEED_STATS, STATUS_EFFECT } from './state.js';
export type { CombatHost, CombatSnapshot, DamageModifier, HitInit, StatusEffectRef } from './state.js';

/** Other plugins' events combat hears, by id (plugins don't import each other). */
const ANIMATION_EVENT = 'animation_event';
const BREAKABLE_DAMAGED = 'breakable_damaged';

export interface CombatOptions {
  /** Run in list order on every hit. */
  readonly modifiers?: readonly DamageModifier[];
  /** The least a hit that got through armor deals. Default 0. */
  readonly minDamage?: number;
  /** Game-facing tags and status-effect content refs (the api supplies them). */
  readonly host: CombatHost;
}

export function combat(options: CombatOptions): KernelPlugin {
  const modifiers = [...(options.modifiers ?? [])];
  for (const [i, m] of modifiers.entries()) {
    if (typeof m !== 'function') {
      fail('PP3900', `combat(modifiers=...) item ${i} is not a function`, { fix: 'Pass functions: def modifier(ctx, hit) -> None.' });
    }
  }
  const minDamage = finite(options.minDamage ?? 0, 'combat(min_damage=)');
  if (minDamage < 0) fail('PP3900', `combat(min_damage=${minDamage}) can't be negative`);
  let state: CombatState | undefined;
  let engagement: Engagement | undefined;
  let installedOn: Kernel | undefined;
  const current = (): CombatState => {
    if (state === undefined) fail('PP9900', 'The combat plugin is used before its kernel was built');
    return state;
  };
  const engaged = (): Engagement => {
    if (engagement === undefined) fail('PP9900', 'The combat plugin is used before its kernel was built');
    return engagement;
  };
  let handlers: Handler[] | undefined;
  const system: SystemDef = {
    id: 'combat.upkeep',
    scenes: [],
    // Other plugins' events by id, resolved on first delivery: `animation_event` (visuals)
    // times strikes, `breakable_damaged` (destruction) feeds ImpactDamage(from_breakable).
    get handlers(): readonly Handler[] {
      if (handlers === undefined) {
        const byId = (id: string): EventDef | undefined => installedOn?.registry.events.get(id);
        const animation = byId(ANIMATION_EVENT);
        const breakable = byId(BREAKABLE_DAMAGED);
        handlers = [
          { event: TEARDOWN, method: 'teardown', always: true },
          ...(animation === undefined ? [] : [{ event: animation, method: 'animation_event', always: true }]),
          ...(breakable === undefined ? [] : [{ event: breakable, method: 'breakable_damaged', always: true }]),
        ];
      }
      return handlers;
    },
    create: () => ({
      update: () => {
        current().update();
        engaged().impacts();
        engaged().update();
      },
      teardown: (_ctx: unknown, payload: Fields) => current().teardown(payload),
      animation_event: (_ctx: unknown, payload: Fields) => engaged().animationEvent(payload),
      breakable_damaged: (_ctx: unknown, payload: Fields) => engaged().breakableDamaged(payload),
    }),
  };

  return {
    id: 'combat',
    components: [...combatComponents(current, () => engaged()), ...engagementComponents(engaged), projectileComponent(current)],
    events: [...Object.values(COMBAT_EVENTS), ...Object.values(ENGAGEMENT_EVENTS), ...Object.values(PROJECTILE_EVENTS), TEARDOWN],
    systems: [system],
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP9901', 'This combat plugin is already installed in another kernel', { fix: 'Call combat(...) once per kernel.' });
      }
      installedOn = kernel;
      const created = new CombatState(kernel, { modifiers, minDamage, host: options.host });
      state = created;
      const eng = new Engagement(kernel, created, options.host);
      engagement = eng;
      kernel.observeEntities({
        added: (records) => {
          created.added(records);
          for (const r of records) eng.observe(r);
        },
        removed: (records) => {
          created.removed(records);
          eng.removed(records.map((r) => r.id));
        },
        changed: (record) => {
          created.changed(record);
          eng.observe(record);
        },
      });
      // Projectiles move one fixed step at a time, sweeping the world the last physics step left.
      kernel.addHook('physics', (dt) => stepProjectiles(created, dt));
    },
    snapshot: () => ({ ...current().snapshot(), engagement: engaged().snapshot() }) as unknown as Json,
    restore: (_kernel, saved) => {
      current().restore(saved);
      engaged().restore((saved as { engagement?: EngagementSnapshot }).engagement);
    },
    namespace: { name: 'combat', create: () => combatNamespace(current, engaged) },
  };
}
