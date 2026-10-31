/**
 * A character drives its Animator through the Animator's own methods (`set_param`,
 * `trigger`, `take_root_motion`) — the same public surface game code uses — reading which
 * params the graph declares from the Animator's data (`params`: name → number, true/false or
 * "trigger"). The visuals plugin owns the Animator; this file only knows its component id
 * and field names (sdk/parallax/__init__.pyi `Animator`).
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';

export const ANIMATOR = 'animator';

export type ParamKind = 'number' | 'bool' | 'trigger';

/** The params a character sets, by name and kind (sdk/parallax/characters.pyi). */
export const CHARACTER_PARAMS: Readonly<Record<string, ParamKind>> = {
  speed: 'number',
  vertical_speed: 'number',
  stance: 'number',
  forward_speed: 'number',
  strafe_speed: 'number',
  direction: 'number',
  turn_rate: 'number',
  grounded: 'bool',
  running: 'bool',
  crouched: 'bool',
  prone: 'bool',
  swimming: 'bool',
  traversing: 'bool',
  seated: 'bool',
  falling: 'bool',
  gliding: 'bool',
  holding: 'bool',
  carrying: 'bool',
  jumped: 'trigger',
  landed: 'trigger',
  vaulted: 'trigger',
  climbed: 'trigger',
};

interface AnimatorMethods {
  set_param(name: string, value: number | boolean): void;
  trigger(name: string): void;
  take_root_motion(): { offset: Vec3; turn: number };
}

function kindOf(value: unknown): ParamKind | undefined {
  if (value === 'trigger') return 'trigger';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  return undefined;
}

function nameOf(record: EntityRecord): string {
  return `"${record.placedId ?? record.prefab ?? record.id}"`;
}

/** The entity's Animator fields, or undefined. */
export function animatorOf(record: EntityRecord): (Fields & AnimatorMethods) | undefined {
  return record.components.get(ANIMATOR) as (Fields & AnimatorMethods) | undefined;
}

/**
 * Set every declared param among `values` (and fire the declared `triggers`). `extra` names
 * params a seat asked for: those must be declared.
 */
export function driveParams(record: EntityRecord, animator: Fields & AnimatorMethods, values: Readonly<Record<string, number | boolean>>,
  triggers: readonly string[], extra: Readonly<Record<string, boolean>>): void {
  const declared = animator['params'];
  const params = typeof declared === 'object' && declared !== null && !Array.isArray(declared) ? declared as Record<string, unknown> : {};
  const expect = (name: string, kind: ParamKind): boolean => {
    if (!(name in params)) return false;
    const has = kindOf(params[name]);
    if (has !== kind) {
      fail('PP3176', `The animator of ${nameOf(record)} declares "${name}" as a ${has ?? 'value'} param; the character sets it as a ${kind}`, {
        fix: `Declare it "${name}": ${kind === 'trigger' ? '"trigger"' : kind === 'bool' ? 'false' : '0'}, or set Character.animate to false and drive it yourself.`,
      });
    }
    return true;
  };
  for (const [name, value] of Object.entries(values)) {
    if (expect(name, CHARACTER_PARAMS[name]!)) animator.set_param(name, value);
  }
  for (const name of triggers) if (expect(name, 'trigger')) animator.trigger(name);
  for (const [name, value] of Object.entries(extra)) {
    if (!(name in params)) {
      fail('PP3176', `A seat sets the animator param "${name}", which the animator of ${nameOf(record)} doesn't declare`, {
        fix: `Declare "${name}": false in its "params", or remove the seat's "param".`,
      });
    }
    if (expect(name, 'bool')) animator.set_param(name, value);
  }
}

/** Root travel the Animator collected ("character" root motion), or undefined in other modes. */
export function takeRootMotion(animator: Fields & AnimatorMethods): { offset: Vec3; turn: number } | undefined {
  if (animator['root_motion'] !== 'character') return undefined;
  const taken = animator.take_root_motion();
  return { offset: taken.offset, turn: taken.turn };
}
