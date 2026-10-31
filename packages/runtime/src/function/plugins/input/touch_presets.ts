/**
 * Touch presets (`Actions.touch_preset = "fps"`): a genre's touch scheme, as data. For each
 * action a set declares without a touch binding, the preset fills one in from the action's
 * other bindings, and it places the set's buttons (primary under the right thumb, pause in
 * the system tray, slots on the hotbar). An action with its own touch binding keeps it (only
 * an unset zone is filled); `touch=touch.NONE` opts an action out.
 *
 *   movement   an axis2 on keys / the left stick / the d-pad      joystick, or a drag (rts, click)
 *   look       an axis2 on mouse delta / the right stick          look, an attitude stick (flight), or a drag
 *   a second movement axis2 (twin-stick aim)                      the right joystick
 *   axis1      racer: steering (A/D, ←/→, stick x) → steer; throttle (W/S, ↑/↓, triggers) → pedals
 *              platformer / sidescroller: left/right → ◀ ▶ under the left thumb
 *              the wheel → pinch (rts, click, topdown) or a −/+ stepper; anything else → a stepper
 *   button     mouse left → the primary button, or a tap on the world (rts, click)
 *              mouse right → a button, or a long press on the world (rts, click)
 *              Shift (fps, tps, with a left joystick) → push the stick to its rim
 *              P / Tab / Start / Select only → the system tray (Escape can't be bound: PP4242)
 *              anything else → the action arc; Space is primary when nothing is on mouse left
 *   group      the hotbar, one slot per key ("Digit1" → "1")
 *
 * The derivation is the same on every machine: the engine applies it once per set, when the
 * set is added, and reads the result like any declared binding.
 */

import type { TouchZone } from '../../../core/index.js';
import type {
  ActionDecl, ActionSetDecl, Axis1Decl, Axis2Decl, BindingPart, ButtonDecl, GroupDecl, TouchControl, TouchPreset,
} from './declarations.js';

type Move = 'joystick' | 'drag';
type Look = 'look' | 'attitude' | 'drag' | 'none';

interface Rules {
  readonly move: Move;
  readonly look: Look;
  readonly mouseLeft: 'primary' | 'tap';
  readonly mouseRight: 'button' | 'long_press';
  readonly wheel: 'pinch' | 'stepper';
  /** Shift on a movement stick: pushing the stick to its rim. */
  readonly sprintEdge: boolean;
  /** Steering and throttle axis1s become a wheel and pedals. */
  readonly drive: boolean;
  /** Left/right axis1s become ◀ ▶ buttons under the left thumb. */
  readonly sideButtons: boolean;
  /** Keys whose button is the primary when nothing is on mouse left, best first. */
  readonly primaryKeys: readonly string[];
}

const SHOOTER: Rules = {
  move: 'joystick', look: 'look', mouseLeft: 'primary', mouseRight: 'button', wheel: 'stepper', sprintEdge: true,
  drive: false, sideButtons: false, primaryKeys: ['Space'],
};
const POINT: Rules = {
  move: 'drag', look: 'none', mouseLeft: 'tap', mouseRight: 'long_press', wheel: 'pinch', sprintEdge: false,
  drive: false, sideButtons: false, primaryKeys: ['Space'],
};
const JUMPER: Rules = {
  move: 'joystick', look: 'none', mouseLeft: 'primary', mouseRight: 'button', wheel: 'stepper', sprintEdge: false,
  drive: false, sideButtons: true, primaryKeys: ['Space', 'KeyW', 'ArrowUp'],
};

/** The genre presets of the previous engine's touch overlay, as rules. */
export const PRESET_RULES: Readonly<Record<Exclude<TouchPreset, 'custom'>, Rules>> = {
  fps: SHOOTER,
  tps: SHOOTER,
  topdown: { ...SHOOTER, look: 'drag', wheel: 'pinch', sprintEdge: false },
  platformer: JUMPER,
  sidescroller: JUMPER,
  racer: { ...SHOOTER, look: 'none', sprintEdge: false, drive: true },
  flight: { ...SHOOTER, look: 'attitude', sprintEdge: false },
  rts: POINT,
  click: POINT,
};

const SYSTEM_KEYS = new Set(['Escape', 'KeyP', 'Tab', 'Backquote']);
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
const STEER_KEYS = new Set(['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight']);
const THROTTLE_KEYS = new Set(['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown']);

const control = (c: TouchControl): BindingPart => ({ kind: 'touch', control: c });

const TAP: TouchControl = { id: 'tap', shape: 'tap', analog: false };
const LONG_PRESS: TouchControl = { id: 'long_press', shape: 'long_press', analog: false };
const PINCH: TouchControl = { id: 'pinch', shape: 'pinch', analog: true };
const DRAG: TouchControl = { id: 'drag', shape: 'drag', analog: true };
const LOOK: TouchControl = { id: 'look', shape: 'look', analog: true };
const STEER: TouchControl = { id: 'steer', shape: 'steer', analog: true };
const PEDALS: TouchControl = { id: 'pedals:Brake|Gas', shape: 'stepper', analog: true, zone: 'pedals', labels: ['Brake', 'Gas'] };
const joystick = (side: 'left' | 'right', fixed = false): TouchControl =>
  ({ id: `joystick:${side}`, shape: 'joystick', analog: true, side, ...(fixed && { fixed }) });

/** "switch_weapon" → "Switch Weapon". */
export function titleOf(name: string): string {
  return name.split('_').filter((w) => w !== '').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

/** A key code as a hotbar slot reads it: "Digit1" → "1", "KeyQ" → "Q", "F2" → "F2". */
export function keyLabel(code: string): string {
  const m = /^(?:Digit|Numpad|Key)(.+)$/.exec(code);
  return m !== null ? m[1]! : code;
}

function keysIn(parts: readonly BindingPart[]): string[] {
  return parts.flatMap((p) => {
    switch (p.kind) {
      case 'keys': return [...p.codes];
      case 'composite': return [...p.up, ...p.left, ...p.down, ...p.right];
      case 'key_axis': return [...p.negative, ...p.positive];
      default: return [];
    }
  });
}

const has = (parts: readonly BindingPart[], test: (p: BindingPart) => boolean): boolean => parts.some(test);
const mouseButton = (button: 'left' | 'right') => (p: BindingPart): boolean => p.kind === 'mouse_button' && p.button === button;
const isTouch = (p: BindingPart): p is Extract<BindingPart, { kind: 'touch' }> => p.kind === 'touch';
const notTouch = (parts: readonly BindingPart[]): BindingPart[] => parts.filter((p) => !isTouch(p));

/** The parts of an action other than its touch ones (an axis1's keys count as keys). */
function inputsOf(action: ActionDecl): readonly BindingPart[] {
  switch (action.kind) {
    case 'button':
    case 'axis2':
      return action.bindings;
    case 'axis1':
      return [{ kind: 'keys', codes: [...action.negative, ...action.positive] }, ...action.gamepad, ...action.other];
    case 'group':
      return action.slots.flatMap((s) => s.bindings);
  }
}

function isSystem(parts: readonly BindingPart[]): boolean {
  const keys = keysIn(parts);
  const pads = parts.filter((p) => p.kind === 'pad_button');
  const others = parts.filter((p) => p.kind !== 'keys' && p.kind !== 'pad_button' && !isTouch(p));
  if (others.length > 0 || (keys.length === 0 && pads.length === 0)) return false;
  return keys.every((k) => SYSTEM_KEYS.has(k)) && pads.every((p) => p.kind === 'pad_button' && (p.button === 'start' || p.button === 'select'));
}

/** What an axis2 is for: moving (keys, the left stick, the d-pad) or looking (mouse delta, the right stick). */
function axis2Role(action: Axis2Decl): 'move' | 'look' | undefined {
  const parts = action.bindings;
  if (has(parts, (p) => p.kind === 'mouse_delta')) return 'look';
  if (has(parts, (p) => p.kind === 'composite' || p.kind === 'key_axis' || p.kind === 'pad_dpad' || (p.kind === 'pad_stick' && p.stick === 'left'))) return 'move';
  if (has(parts, (p) => p.kind === 'pad_stick' && p.stick === 'right')) return 'look';
  return undefined;
}

function axis1Role(action: Axis1Decl): 'steer' | 'throttle' | 'wheel' | 'side' | 'other' {
  const keys = [...action.negative, ...action.positive];
  if (has(action.other, (p) => p.kind === 'mouse_wheel') && keys.length === 0) return 'wheel';
  if (keys.length > 0 && keys.every((k) => STEER_KEYS.has(k))) return 'steer';
  if (keys.length > 0 && keys.every((k) => THROTTLE_KEYS.has(k))) return 'throttle';
  if (has(action.gamepad, (p) => p.kind === 'pad_axis' && p.axis.endsWith('_x'))) return 'steer';
  if (has(action.gamepad, (p) => p.kind === 'pad_trigger' || (p.kind === 'pad_axis' && p.axis.endsWith('_y')))) return 'throttle';
  return 'other';
}

/** The set's touch scheme: the preset's choices, made once for every action of the set. */
class Planner {
  readonly #rules: Rules;
  readonly #set: ActionSetDecl;
  /** Joystick sides taken (declared or derived). */
  readonly #sides = new Set<'left' | 'right'>();
  #primary: ActionDecl | undefined;

  constructor(rules: Rules, set: ActionSetDecl) {
    this.#rules = rules;
    this.#set = set;
    const actions = [...set.actions.values()];
    for (const a of actions) {
      for (const p of inputsOf(a)) if (isTouch(p) && p.control.shape === 'joystick' && p.control.side !== undefined) this.#sides.add(p.control.side);
    }
    const buttons = actions.filter((a): a is ButtonDecl => a.kind === 'button' && a.noTouch !== true && !isSystem(a.bindings));
    this.#primary = rules.mouseLeft === 'primary' ? buttons.find((a) => has(a.bindings, mouseButton('left'))) : undefined;
    for (const key of rules.primaryKeys) {
      this.#primary ??= buttons.find((a) => !has(a.bindings, mouseButton('left')) && !has(a.bindings, mouseButton('right')) && keysIn(a.bindings).includes(key));
    }
  }

  /** Every own action of the set with its touch bindings filled in and placed; unchanged ones are left out. */
  plan(): Map<ActionDecl, ActionDecl> {
    const out = new Map<ActionDecl, ActionDecl>();
    // Movement first, so a twin-stick's second stick and the sprint edge know which sides are taken.
    const ordered = [...this.#set.actions.entries()].filter(([, a]) => a.owner?.set === this.#set)
      .sort(([, a], [, b]) => Number(b.kind === 'axis2') - Number(a.kind === 'axis2'));
    for (const [name, action] of ordered) {
      const planned = this.#action(name, action);
      if (planned !== action) out.set(action, planned);
    }
    return out;
  }

  #action(name: string, action: ActionDecl): ActionDecl {
    if (action.noTouch === true) return action;
    switch (action.kind) {
      case 'button': return this.#button(name, action);
      case 'axis1': return this.#axis1(name, action);
      case 'axis2': return this.#axis2(action);
      case 'group': return this.#group(name, action);
    }
  }

  #button(name: string, action: ButtonDecl): ButtonDecl {
    const zone: TouchZone | undefined = isSystem(action.bindings) ? 'system' : action === this.#primary ? 'primary' : undefined;
    const declared = action.bindings.filter(isTouch);
    if (declared.length > 0) {
      if (zone === undefined) return action;
      const placed = declared.map((p) => (p.control.shape === 'button' && p.control.zone === undefined ? control({ ...p.control, zone }) : p));
      return { ...action, bindings: [...notTouch(action.bindings), ...placed] };
    }
    const r = this.#rules;
    let derived: TouchControl | undefined;
    if (has(action.bindings, mouseButton('left')) && r.mouseLeft === 'tap') derived = TAP;
    else if (has(action.bindings, mouseButton('right')) && r.mouseRight === 'long_press') derived = LONG_PRESS;
    else if (r.sprintEdge && this.#sides.has('left') && keysIn(action.bindings).some((k) => SPRINT_KEYS.has(k))) {
      derived = { id: 'joystick:left:edge', shape: 'stick_edge', analog: false, side: 'left' };
    } else if (!has(action.bindings, (p) => p.kind === 'mouse_wheel')) {
      const label = titleOf(name);
      derived = { id: `button:${label}`, shape: 'button', analog: false, label, icon: 'auto', ...(zone !== undefined && { zone }) };
    }
    return derived === undefined ? action : { ...action, bindings: [...action.bindings, control(derived)] };
  }

  #axis1(name: string, action: Axis1Decl): Axis1Decl {
    if (action.other.some(isTouch)) return action;
    const r = this.#rules;
    const role = axis1Role(action);
    let derived: TouchControl;
    if (role === 'wheel' && r.wheel === 'pinch') derived = PINCH;
    else if (role === 'steer' && r.drive) derived = STEER;
    else if (role === 'throttle' && r.drive) derived = PEDALS;
    else if (role === 'steer' && r.sideButtons) {
      derived = { id: `stepper:${name}`, shape: 'stepper', analog: true, zone: 'left', labels: ['◀', '▶'] };
    } else {
      derived = { id: `stepper:${name}`, shape: 'stepper', analog: true, labels: ['−', '+'], label: titleOf(name) };
    }
    return { ...action, other: [...action.other, control(derived)] };
  }

  #axis2(action: Axis2Decl): Axis2Decl {
    if (action.bindings.some(isTouch)) return action;
    const r = this.#rules;
    const role = axis2Role(action);
    let derived: TouchControl | undefined;
    if (role === 'move') {
      if (r.move === 'drag') derived = DRAG;
      else if (!this.#sides.has('left')) derived = joystick('left');
      else if (!this.#sides.has('right')) derived = joystick('right');
    } else if (role === 'look') {
      if (r.look === 'look') derived = LOOK;
      else if (r.look === 'drag') derived = DRAG;
      else if (r.look === 'attitude' && !this.#sides.has('right')) derived = joystick('right', true);
    }
    if (derived === undefined) return action;
    if (derived.shape === 'joystick') this.#sides.add(derived.side!);
    return { ...action, bindings: [...action.bindings, control(derived)] };
  }

  #group(name: string, action: GroupDecl): GroupDecl {
    const declared = action.slots.some((s) => s.bindings.some(isTouch));
    const slots = action.slots.map((slot, i) => {
      if (declared) {
        const placed = slot.bindings.map((p) => (isTouch(p) && p.control.zone === undefined ? control({ ...p.control, zone: 'hotbar' }) : p));
        return { bindings: placed };
      }
      const key = keysIn(slot.bindings)[0];
      const label = key !== undefined ? keyLabel(key) : String(i + 1);
      return { bindings: [...slot.bindings, control({ id: `hotbar:${name}:${i}`, shape: 'button', analog: false, label, zone: 'hotbar' })] };
    });
    return { ...action, slots };
  }
}

/**
 * A set's actions as its touch preset makes them (only the ones it changes, keyed by the
 * declared action). Empty without a preset, or with "custom".
 */
export function presetActions(set: ActionSetDecl): Map<ActionDecl, ActionDecl> {
  const preset = set.touchPreset;
  if (preset === undefined || preset === 'custom') return new Map();
  return new Planner(PRESET_RULES[preset], set).plan();
}
