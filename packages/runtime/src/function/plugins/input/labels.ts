/**
 * Remap slots as a player reads them: key codes and gamepad buttons in words ("KeyW" → "W",
 * "south" → "A / ✕") and one display row per slot — what the built-in SettingsPanel lists
 * and `ctx.input.controls()` returns for a game's own controls menu.
 */

import type { RemapSlot } from './remap.js';

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', Escape: 'Esc',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', Backspace: 'Backspace', Tab: 'Tab',
};
const PAD_NAMES: Readonly<Record<string, string>> = {
  south: 'A / ✕', east: 'B / ○', west: 'X / □', north: 'Y / △', left_shoulder: 'LB', right_shoulder: 'RB',
  start: 'Start', select: 'Select', dpad_up: 'D-pad ↑', dpad_down: 'D-pad ↓', dpad_left: 'D-pad ←', dpad_right: 'D-pad →',
  left_stick: 'L3', right_stick: 'R3',
};

/** A key code or gamepad button as a player reads it ("KeyW" → "W", "south" → "A / ✕"). */
export function bindingText(binding: string, device: 'keyboard' | 'gamepad'): string {
  if (device === 'gamepad') return PAD_NAMES[binding] ?? binding;
  const named = KEY_NAMES[binding];
  if (named !== undefined) return named;
  const short = /^(?:Key|Digit)(.+)$/.exec(binding) ?? /^Numpad(.+)$/.exec(binding);
  return short !== null ? (binding.startsWith('Numpad') ? `Num ${short[1]!}` : short[1]!) : binding;
}

function words(name: string): string {
  const text = name.replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One remappable binding as a controls menu shows it (`ctx.input.controls()`; SDK `ControlBinding`). */
export interface ControlRow {
  /** What `rebind` / `reset_controls` take ("Controls.jump:key"). */
  readonly slot: string;
  /** "Jump", "Move up", "Slots 2"; prefixed by the set ("Driving: Brake") when the game has several. */
  readonly label: string;
  /** "<Set>.<action>". */
  readonly action: string;
  readonly device: 'keyboard' | 'gamepad';
  /** The binding in effect, in words ("W", "A / ✕"). */
  readonly binding: string;
  /** The binding in effect as a code ("KeyW", "south"). */
  readonly code: string;
  /** Remapped away from what the game declared. */
  readonly changed: boolean;
  /** Waiting for the key / button that becomes this slot's binding. */
  readonly capturing: boolean;
}

/** The display rows of remap slots. */
export function controlRows(slots: readonly RemapSlot[], capturing: string | null): ControlRow[] {
  const sets = new Set(slots.map((s) => s.action.slice(0, s.action.indexOf('.'))));
  return slots.map((s) => {
    const [set, action] = [s.action.slice(0, s.action.indexOf('.')), s.action.slice(s.action.indexOf('.') + 1)];
    const part = s.part === null ? '' : /^\d+$/.test(s.part) ? ` ${Number(s.part) + 1}` : ` ${s.part}`;
    return {
      slot: s.slot,
      label: `${sets.size > 1 ? `${set}: ` : ''}${words(action)}${part}`,
      action: s.action,
      device: s.device,
      binding: bindingText(s.binding, s.device),
      code: s.binding,
      changed: s.binding !== s.declared,
      capturing: s.slot === capturing,
    };
  });
}
