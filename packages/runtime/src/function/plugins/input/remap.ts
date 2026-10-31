/**
 * Control remapping (DESIGN §4.19: the built-in SettingsPanel remaps every declared
 * action). A player's remaps are a flat map from a *slot* to one binding, stored in the
 * `Settings` resource (`controls`) and persisted with the profile:
 *
 *   "<Set>.<action>:key"        a button's keyboard key           → "KeyJ"
 *   "<Set>.<action>:pad"        a button's gamepad button         → "south"
 *   "<Set>.<action>.<i>:key"    slot i of a button_group (also :pad)
 *   "<Set>.<action>:negative"   an axis1's negative / positive key
 *   "<Set>.<action>:up"         one direction of an axis2's key composite (up/down/left/right)
 *
 * A remap replaces the action's *primary* binding on that device (the first keys part, the
 * first gamepad button, the first composite); alternates the game declared stay. Sticks,
 * triggers, mouse and touch bindings are not remappable. `<Set>` is the class that declared
 * the action (an inherited action is remapped once, for every set that has it).
 */

import type { GamepadButton } from '../../../core/index.js';
import { partsOf } from './declarations.js';
import type { ActionDecl, ActionSetDecl, Binding, BindingPart, Direction } from './declarations.js';

export type Overrides = Readonly<Record<string, string>>;

export const PAD_BUTTONS: readonly GamepadButton[] = [
  'south', 'east', 'west', 'north', 'left_shoulder', 'right_shoulder', 'start', 'select',
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'left_stick', 'right_stick',
];

const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

/** One remappable binding, as the settings menu lists it. */
export interface RemapSlot {
  /** The override key (see the module comment). */
  readonly slot: string;
  /** "<Set>.<action>" (the declaring class). */
  readonly action: string;
  /** The direction / side / group index part ("up", "negative", "2"), or null. */
  readonly part: string | null;
  readonly device: 'keyboard' | 'gamepad';
  /** The binding in effect: the override, else the declared primary (key code or gamepad button name). */
  readonly binding: string;
  /** The declared primary, which `reset` restores. */
  readonly declared: string;
}

export function actionName(action: ActionDecl): string | undefined {
  return action.owner === undefined ? undefined : `${action.owner.set.id}.${action.owner.name}`;
}

/** Whether a captured value fits the slot: a key code for keyboard slots, a gamepad button name for :pad. */
export function slotDevice(slot: string): 'keyboard' | 'gamepad' {
  return slot.endsWith(':pad') ? 'gamepad' : 'keyboard';
}

function firstIndex(binding: Binding, kind: BindingPart['kind']): number {
  return binding.findIndex((p) => p.kind === kind);
}

/** A binding with its primary keys / gamepad button replaced. */
function replaced(binding: Binding, key: string | undefined, pad: string | undefined): Binding {
  let out = [...binding];
  if (key !== undefined) {
    const at = firstIndex(out, 'keys');
    if (at >= 0) out[at] = { kind: 'keys', codes: [key] };
  }
  if (pad !== undefined && (PAD_BUTTONS as readonly string[]).includes(pad)) {
    const at = firstIndex(out, 'pad_button');
    if (at >= 0) out[at] = { kind: 'pad_button', button: pad as GamepadButton };
  }
  if (out.every((p, i) => p === binding[i])) out = binding as BindingPart[];
  return out;
}

/** The action as a player's remaps make it (the same object when nothing applies). */
export function remapped(action: ActionDecl, overrides: Overrides): ActionDecl {
  const name = actionName(action);
  if (name === undefined) return action;
  const get = (suffix: string): string | undefined => overrides[`${name}${suffix}`];
  switch (action.kind) {
    case 'button': {
      const bindings = replaced(action.bindings, get(':key'), get(':pad'));
      return bindings === action.bindings ? action : { ...action, bindings };
    }
    case 'group': {
      let changed = false;
      const slots = action.slots.map((slot, i) => {
        const bindings = replaced(slot.bindings, get(`.${i}:key`), get(`.${i}:pad`));
        if (bindings !== slot.bindings) changed = true;
        return bindings === slot.bindings ? slot : { bindings };
      });
      return changed ? { ...action, slots } : action;
    }
    case 'axis1': {
      const negative = get(':negative');
      const positive = get(':positive');
      if (negative === undefined && positive === undefined) return action;
      return {
        ...action,
        negative: negative !== undefined && action.negative.length > 0 ? [negative] : action.negative,
        positive: positive !== undefined && action.positive.length > 0 ? [positive] : action.positive,
      };
    }
    case 'axis2': {
      const at = firstIndex(action.bindings, 'composite');
      if (at < 0 || DIRECTIONS.every((d) => get(`:${d}`) === undefined)) return action;
      const part = action.bindings[at] as Extract<BindingPart, { kind: 'composite' }>;
      const next = { ...part };
      for (const d of DIRECTIONS) {
        const code = get(`:${d}`);
        if (code !== undefined) (next as Record<Direction, readonly string[]>)[d] = [code];
      }
      const bindings = [...action.bindings];
      bindings[at] = next;
      return { ...action, bindings };
    }
  }
}

/** Every remappable slot of the game's action sets, in declaration order. */
export function remapSlots(sets: readonly ActionSetDecl[], overrides: Overrides): RemapSlot[] {
  const out: RemapSlot[] = [];
  const seen = new Set<ActionDecl>();
  const add = (action: string, part: string | null, suffix: string, declared: string | undefined): void => {
    if (declared === undefined) return;
    const slot = `${action}${suffix}`;
    out.push({ slot, action, part, device: slotDevice(slot), binding: overrides[slot] ?? declared, declared });
  };
  const keyOf = (b: Binding): string | undefined => {
    const p = b.find((x) => x.kind === 'keys');
    return p?.kind === 'keys' ? p.codes[0] : undefined;
  };
  const padOf = (b: Binding): string | undefined => {
    const p = b.find((x) => x.kind === 'pad_button');
    return p?.kind === 'pad_button' ? p.button : undefined;
  };
  for (const set of sets) {
    for (const action of set.actions.values()) {
      if (seen.has(action)) continue;
      seen.add(action);
      const name = actionName(action);
      if (name === undefined) continue;
      switch (action.kind) {
        case 'button':
          add(name, null, ':key', keyOf(action.bindings));
          add(name, null, ':pad', padOf(action.bindings));
          break;
        case 'group':
          action.slots.forEach((slot, i) => {
            add(name, String(i), `.${i}:key`, keyOf(slot.bindings));
            add(name, String(i), `.${i}:pad`, padOf(slot.bindings));
          });
          break;
        case 'axis1':
          add(name, 'negative', ':negative', action.negative[0]);
          add(name, 'positive', ':positive', action.positive[0]);
          break;
        case 'axis2': {
          const composite = action.bindings.find((p) => p.kind === 'composite');
          if (composite?.kind !== 'composite') break;
          for (const d of DIRECTIONS) add(name, d, `:${d}`, composite[d][0]);
          break;
        }
      }
    }
  }
  return out;
}

/** The physical sources an action reads, after remapping (for priority masking). */
export function remappedParts(action: ActionDecl, overrides: Overrides): readonly BindingPart[] {
  return partsOf(remapped(action, overrides));
}
