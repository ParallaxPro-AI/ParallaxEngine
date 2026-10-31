/**
 * `ctx.combat`: questions about the world (CombatApi in sdk/parallax/combat.pyi). Every
 * method takes Python-style arguments: positional values, then optional keywords.
 */

import { fail, Vec3 } from '../../../core/index.js';
import { bind, bool, entityId, finite, nonNegative, optionalEntity, optionalPoint, optionalTag } from './args.js';
import type { Engagement } from './engagement.js';
import { fireCall } from './projectiles.js';
import type { CombatState } from './state.js';

export interface CombatNamespace {
  /** are_enemies(a, b): both have a Side and the sides differ. */
  are_enemies(...args: unknown[]): boolean;
  /** area_damage(center, radius, amount, *, source=None, kind=None, falloff=True, friendly_fire=False) */
  area_damage(...args: unknown[]): unknown[];
  /** aim_assist(origin, direction, *, shooter=None, angle=8, range=100, strength=0.5) -> Vec3 */
  aim_assist(...args: unknown[]): unknown;
  /** aim_target(origin, direction, *, shooter=None, angle=8, range=100) -> Entity | None */
  aim_target(...args: unknown[]): unknown;
  /** fire(prefab, *, at, direction=None, velocity=None, speed=None, source=None, target=None) -> Entity */
  fire(...args: unknown[]): unknown;
}

export function combatNamespace(state: () => CombatState, engaged: () => Engagement): CombatNamespace {
  return {
    are_enemies(...args) {
      const a = bind('are_enemies', args, ['a', 'b'], [], ['a', 'b']);
      const handles = state().kernel.handles;
      return state().areEnemies(entityId(handles, a['a'], 'are_enemies() a'), entityId(handles, a['b'], 'are_enemies() b'));
    },
    area_damage(...args) {
      const a = bind('area_damage', args, ['center', 'radius', 'amount'], ['source', 'kind', 'falloff', 'friendly_fire'],
        ['center', 'radius', 'amount']);
      const s = state();
      const center = optionalPoint(a['center'], 'area_damage() center')
        ?? fail('PP3900', 'area_damage() center must be a Vec3 or Vec2, got None');
      const hit = s.areaDamage(
        center,
        nonNegative(a['radius'], 'area_damage() radius'),
        finite(a['amount'], 'area_damage() amount'),
        optionalEntity(s.kernel.handles, a['source'], 'area_damage() source'),
        optionalTag(a['kind'], 'area_damage() kind'),
        a['falloff'] === undefined ? true : bool(a['falloff'], 'area_damage() falloff'),
        a['friendly_fire'] === undefined ? false : bool(a['friendly_fire'], 'area_damage() friendly_fire'),
      );
      return hit.map((id) => s.kernel.handles.wrap(id));
    },
    aim_assist(...args) {
      const a = aim('aim_assist', args, true);
      return engaged().aimAssist(a.origin, a.direction, a.shooter, a.angle, a.range, a.strength);
    },
    aim_target(...args) {
      const a = aim('aim_target', args, false);
      const hit = engaged().aimTarget(a.origin, a.direction, a.shooter, a.angle, a.range);
      return hit === undefined ? null : state().kernel.handles.wrap(hit.id);
    },
    fire(...args) {
      return fireCall(state(), args);
    },
  };

  function aim(name: string, args: unknown[], withStrength: boolean) {
    const a = bind(name, args, ['origin', 'direction'], ['shooter', 'angle', 'range', ...(withStrength ? ['strength'] : [])], ['origin', 'direction']);
    const vec = (v: unknown, w: string): Vec3 => (v instanceof Vec3 ? v : fail('PP7403', `${name}() ${w} must be a Vec3, got ${String(v)}`));
    const direction = vec(a['direction'], 'direction');
    if (direction.length() < 1e-9) fail('PP7403', `${name}() direction can't be zero`);
    return {
      origin: vec(a['origin'], 'origin'),
      direction,
      shooter: (optionalEntity(state().kernel.handles, a['shooter'], `${name}() shooter`) === null ? undefined
        : entityId(state().kernel.handles, a['shooter'], `${name}() shooter`)),
      angle: a['angle'] === undefined ? 8 : nonNegative(a['angle'], `${name}() angle`),
      range: a['range'] === undefined ? 100 : nonNegative(a['range'], `${name}() range`),
      strength: a['strength'] === undefined ? 0.5 : nonNegative(a['strength'], `${name}() strength`),
    };
  }
}
