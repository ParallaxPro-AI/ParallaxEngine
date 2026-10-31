/**
 * Input actions, Python-facing (sdk/parallax/__init__.pyi "Input: actions"): `Actions`,
 * `button` / `axis1` / `axis2` / `button_group`, and the binding constants `keys`,
 * `gamepad`, `mouse`, `touch`. They build the input plugin's declarations; `ctx.input`
 * itself is the plugin's `InputApi`.
 *
 *     class Controls(Actions):
 *         move = axis2(keyboard=keys.WASD, gamepad=gamepad.LEFT_STICK)
 *         jump = button(keyboard="Space", gamepad=gamepad.SOUTH)
 *
 * Registration: CPython calls `Actions.__init_subclass__` when the class body ends; the
 * compiled class must do the same (`Controls.__init_subclass__()`), which records the set.
 */

import { closestMatch, Color, fail, Vec2 } from '../core/index.js';
import { InputApi, PointerApi, TOUCH_PRESETS } from '../function/plugins/input/index.js';
import type {
  ActionDecl, ActionSetDecl, Axis1Decl, Axis2Decl, BindingPart, ButtonDecl, Direction, GroupDecl, TouchControl,
  TouchControlState, TouchPreset, TouchSkin as TouchSkinSpec, TouchZone,
} from '../function/plugins/input/index.js';
import type { SceneScope } from '../function/kernel/index.js';
import type { DialogueInput } from '../function/services/index.js';
import { bindArgs, splitArgs } from './kwargs.js';
import { truthy } from './py.js';
import { SceneRef, Tag } from './types.js';

export { InputApi as Input, PointerApi as Pointer };

// ── Key names ──────────────────────────────────────────────────────────────────

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`);
const DIGITS = '0123456789'.split('').map((d) => `Digit${d}`);
const NUMPAD = [...'0123456789'.split('').map((d) => `Numpad${d}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter'];
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

/** Every key code a binding may name (`KeyboardEvent.code`). */
export const KEY_CODES: ReadonlySet<string> = new Set([
  ...LETTERS, ...DIGITS, ...NUMPAD, ...FUNCTION_KEYS,
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
]);

function keyCodes(value: unknown, where: string): string[] {
  const codes = typeof value === 'string' ? [value] : iterable(value) ? [...value] : undefined;
  if (codes === undefined || codes.length === 0 || !codes.every((c) => typeof c === 'string')) {
    fail('PP4401', `${where} takes a key code ("Space") or a tuple of them, got ${String(value)}`);
  }
  for (const code of codes as string[]) {
    if (!KEY_CODES.has(code)) {
      const guess = closestMatch(code, KEY_CODES);
      fail('PP4401', `${where}: "${code}" is not a key code`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Use KeyboardEvent.code names: "KeyW", "Space", "ArrowUp", "Digit1".',
      });
    }
  }
  return codes as string[];
}

function iterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

// ── Bindings ───────────────────────────────────────────────────────────────────

/** One or more physical inputs; `a | b` binds both. */
export class Binding {
  readonly parts: readonly BindingPart[];

  constructor(parts: readonly BindingPart[]) {
    this.parts = parts;
  }

  __or__(o: unknown): Binding {
    if (!(o instanceof Binding)) fail('PP4402', `Only bindings combine with |, got ${String(o)}`);
    return new Binding([...this.parts, ...o.parts]);
  }

  toString(): string {
    return `Binding(${this.parts.map((p) => p.kind).join(' | ')})`;
  }
}

const bind = (part: BindingPart): Binding => new Binding([part]);
const composite = (up: string[], left: string[], down: string[], right: string[]): Binding =>
  bind({ kind: 'composite', up, left, down, right });

export class keys {
  static readonly WASD = composite(['KeyW'], ['KeyA'], ['KeyS'], ['KeyD']);
  static readonly ARROWS = composite(['ArrowUp'], ['ArrowLeft'], ['ArrowDown'], ['ArrowRight']);
  static readonly AD = bind({ kind: 'key_axis', axis: 'x', negative: ['KeyA'], positive: ['KeyD'] });
  static readonly WS = bind({ kind: 'key_axis', axis: 'y', negative: ['KeyS'], positive: ['KeyW'] });
  static readonly LEFT_RIGHT = bind({ kind: 'key_axis', axis: 'x', negative: ['ArrowLeft'], positive: ['ArrowRight'] });
  static readonly UP_DOWN = bind({ kind: 'key_axis', axis: 'y', negative: ['ArrowDown'], positive: ['ArrowUp'] });

  /** Any four keys as a 2D axis (IJKL, numpad). */
  static composite(...args: unknown[]): Binding {
    const a = bindArgs('keys.composite', args, { keyword: ['up', 'left', 'down', 'right'], required: ['up', 'left', 'down', 'right'] }).args;
    return composite(keyCodes(a['up'], 'composite up'), keyCodes(a['left'], 'composite left'),
      keyCodes(a['down'], 'composite down'), keyCodes(a['right'], 'composite right'));
  }
}

export class gamepad {
  static readonly LEFT_STICK = bind({ kind: 'pad_stick', stick: 'left' });
  static readonly RIGHT_STICK = bind({ kind: 'pad_stick', stick: 'right' });
  static readonly LEFT_STICK_X = bind({ kind: 'pad_axis', axis: 'left_x' });
  static readonly LEFT_STICK_Y = bind({ kind: 'pad_axis', axis: 'left_y' });
  static readonly RIGHT_STICK_X = bind({ kind: 'pad_axis', axis: 'right_x' });
  static readonly RIGHT_STICK_Y = bind({ kind: 'pad_axis', axis: 'right_y' });
  static readonly DPAD = bind({ kind: 'pad_dpad' });
  static readonly DPAD_UP = bind({ kind: 'pad_button', button: 'dpad_up' });
  static readonly DPAD_DOWN = bind({ kind: 'pad_button', button: 'dpad_down' });
  static readonly DPAD_LEFT = bind({ kind: 'pad_button', button: 'dpad_left' });
  static readonly DPAD_RIGHT = bind({ kind: 'pad_button', button: 'dpad_right' });
  static readonly SOUTH = bind({ kind: 'pad_button', button: 'south' });
  static readonly EAST = bind({ kind: 'pad_button', button: 'east' });
  static readonly WEST = bind({ kind: 'pad_button', button: 'west' });
  static readonly NORTH = bind({ kind: 'pad_button', button: 'north' });
  static readonly LEFT_SHOULDER = bind({ kind: 'pad_button', button: 'left_shoulder' });
  static readonly RIGHT_SHOULDER = bind({ kind: 'pad_button', button: 'right_shoulder' });
  static readonly LEFT_TRIGGER = bind({ kind: 'pad_trigger', trigger: 'left' });
  static readonly RIGHT_TRIGGER = bind({ kind: 'pad_trigger', trigger: 'right' });
  static readonly START = bind({ kind: 'pad_button', button: 'start' });
  static readonly SELECT = bind({ kind: 'pad_button', button: 'select' });
}

export class mouse {
  static readonly DELTA = bind({ kind: 'mouse_delta' });
  static readonly WHEEL = bind({ kind: 'mouse_wheel' });
  static readonly LEFT = bind({ kind: 'mouse_button', button: 'left' });
  static readonly RIGHT = bind({ kind: 'mouse_button', button: 'right' });
}

const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

function direction(value: unknown, where: string): Direction | undefined {
  if (value === undefined || value === null) return undefined;
  if (!DIRECTIONS.includes(value as Direction)) fail('PP4402', `${where}: direction must be "up", "down", "left" or "right", got ${String(value)}`);
  return value as Direction;
}

const touchBind = (control: TouchControl): Binding => bind({ kind: 'touch', control });

const ZONES: readonly TouchZone[] = ['primary', 'actions', 'left', 'pedals', 'hotbar', 'system'];

function zoneOf(value: unknown, where: string): TouchZone | undefined {
  if (value === undefined || value === null) return undefined;
  if (!ZONES.includes(value as TouchZone)) {
    fail('PP4402', `${where} zone= must be one of ${ZONES.map((z) => `"${z}"`).join(', ')}, got ${String(value)}`);
  }
  return value as TouchZone;
}

function labelArg(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') fail('PP4402', `${where} needs a label (a non-empty str)`);
  return value;
}

function callable(value: unknown, where: string): ((ctx: unknown) => unknown) | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'function') fail('PP4402', `${where} takes a function of ctx, got ${String(value)}`, { fix: `${where.split(' ').pop()}=lambda ctx: ...` });
  return value as (ctx: unknown) => unknown;
}

/** `relabel=`'s result: a label, (label, icon), or None for the declared ones. */
function relabelOf(value: unknown): { label?: string; icon?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { label: value };
  const pair = iterable(value) ? [...value] : [];
  if (pair.length === 2 && (typeof pair[0] === 'string' || pair[0] === null) && (typeof pair[1] === 'string' || pair[1] === null)) {
    return { ...(typeof pair[0] === 'string' && { label: pair[0] }), ...(typeof pair[1] === 'string' && { icon: pair[1] }) };
  }
  return fail('PP4402', `touch.button relabel= must return a label, (label, icon) or None, got ${String(value)}`);
}

/** The per-frame state functions of a touch button. */
function stateOf(a: Record<string, unknown>, where: string): TouchControlState | undefined {
  const visible = callable(a['visible_when'], `${where} visible_when`);
  const enabled = callable(a['enabled_when'], `${where} enabled_when`);
  const relabel = callable(a['relabel'], `${where} relabel`);
  const cooldown = callable(a['cooldown'], `${where} cooldown`);
  if (visible === undefined && enabled === undefined && relabel === undefined && cooldown === undefined) return undefined;
  return {
    ...(visible !== undefined && { visible: (ctx: unknown) => truthy(visible(ctx)) }),
    ...(enabled !== undefined && { enabled: (ctx: unknown) => truthy(enabled(ctx)) }),
    ...(relabel !== undefined && { relabel: (ctx: unknown) => relabelOf(relabel(ctx)) }),
    ...(cooldown !== undefined && {
      cooldown: (ctx: unknown) => {
        const v = cooldown(ctx);
        return typeof v === 'number' ? v : truthy(v) ? 1 : 0;
      },
    }),
  };
}

/**
 * The touch buttons of a `button_group` (`button_group(touch=touch.hotbar(...))`): one per
 * slot, `None` for a slot without one.
 */
export class TouchGroup {
  readonly controls: readonly (TouchControl | null)[];
  constructor(controls: readonly (TouchControl | null)[]) {
    this.controls = controls;
  }

  toString(): string {
    return `TouchGroup(${this.controls.map((c) => c?.label ?? 'None').join(', ')})`;
  }
}

function touchGroup(kind: 'hotbar' | 'toggle_group', args: unknown[]): TouchGroup {
  const { args: a, rest } = bindArgs(`touch.${kind}`, args, { keyword: ['selected_when'], rest: true });
  const labels = rest;
  if (labels.length === 0) fail('PP4402', `touch.${kind} needs a label per slot (None for a slot without a button)`);
  if (!labels.every((l) => (typeof l === 'string' && l !== '') || l === null)) fail('PP4402', `touch.${kind} takes a label (str) or None per slot`);
  const selected = callable(a['selected_when'], `touch.${kind} selected_when`);
  const key = `${kind === 'hotbar' ? 'hotbar' : 'toggle'}:${labels.map((l) => l ?? '').join('|')}`;
  return new TouchGroup(labels.map((label, i) => (label === null ? null : {
    id: `${key}:${i}`, shape: 'button', analog: false, label: label as string, zone: 'hotbar',
    ...(kind === 'toggle_group' && { group: key }),
    ...(selected !== undefined && { state: { selected: (ctx: unknown) => selected(ctx) === i } }),
  })));
}

/** `at=(x, y)`: a button's centre as fractions of the safe area (x from the left, y from the top). */
function atOf(value: unknown): readonly [number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  const pair = value instanceof Vec2 ? [value.x, value.y] : iterable(value) ? [...value] : [];
  if (pair.length !== 2 || !pair.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) {
    fail('PP4402', `touch.button at= takes (x, y), each 0..1 of the screen (x from the left, y from the top), got ${String(value)}`, { fix: 'at=(0.88, 0.62): right side, a little below the middle.' });
  }
  return [pair[0] as number, pair[1] as number];
}

/** `touch=touch.NONE`: no touch control, not even from `touch_preset`. */
const NO_TOUCH = new Binding([]);

export class touch {
  static readonly DRAG = touchBind({ id: 'drag', shape: 'drag', analog: true });
  static readonly TAP = touchBind({ id: 'tap', shape: 'tap', analog: false });
  static readonly LOOK = touchBind({ id: 'look', shape: 'look', analog: true });
  static readonly DOUBLE_TAP = touchBind({ id: 'double_tap', shape: 'double_tap', analog: false });
  static readonly LONG_PRESS = touchBind({ id: 'long_press', shape: 'long_press', analog: false });
  static readonly PINCH = touchBind({ id: 'pinch', shape: 'pinch', analog: true });
  static readonly SCROLL = touchBind({ id: 'scroll', shape: 'scroll', analog: true });
  static readonly NONE = NO_TOUCH;

  static joystick(...args: unknown[]): Binding {
    const a = bindArgs('touch.joystick', args, { positional: ['side'], keyword: ['fixed'], required: ['side'] }).args;
    const side = a['side'];
    if (side !== 'left' && side !== 'right') fail('PP4402', `touch.joystick side must be "left" or "right", got ${String(side)}`);
    const fixed = truthy(a['fixed'] ?? false);
    return touchBind({ id: `joystick:${side}`, shape: 'joystick', analog: true, side, ...(fixed && { fixed }) });
  }

  /** `label` is a locale key when it matches one. */
  static button(...args: unknown[]): Binding {
    if ('hold_ms' in splitArgs(args).keywords) {
      fail('PP3030', 'touch.button() hold_ms= was renamed to hold= (seconds, like every duration)', {
        fix: 'Write hold=0.8 instead of hold_ms=800.',
      });
    }
    const a = bindArgs('touch.button', args, {
      positional: ['label'],
      keyword: ['icon', 'zone', 'toggle', 'hold', 'visible_when', 'enabled_when', 'relabel', 'cooldown', 'size', 'at', 'ring'],
      required: ['label'],
    }).args;
    const label = labelArg(a['label'], 'touch.button');
    const icon = a['icon'] ?? undefined;
    if (icon !== undefined && typeof icon !== 'string') fail('PP4402', 'touch.button icon= must be a string');
    const zone = zoneOf(a['zone'], 'touch.button');
    const toggle = truthy(a['toggle'] ?? false);
    const hold = a['hold'] ?? undefined;
    if (hold !== undefined && (typeof hold !== 'number' || !(hold > 0))) fail('PP4402', `touch.button hold= must be a positive number of seconds, got ${String(hold)}`);
    if (toggle && hold !== undefined) fail('PP4402', 'touch.button takes toggle=True or hold=, not both');
    // The touch layer times holds in milliseconds; the SDK speaks seconds.
    const holdMs = hold !== undefined ? (hold as number) * 1000 : undefined;
    const state = stateOf(a, 'touch.button');
    const size = a['size'] ?? undefined;
    if (size !== undefined && (typeof size !== 'number' || !(size >= 0.5 && size <= 2))) fail('PP4402', `touch.button size= must be 0.5..2 (times the zone's button), got ${String(size)}`);
    const at = atOf(a['at']);
    const ring = cssColor(a['ring'], 'touch.button ring');
    return touchBind({
      id: `button:${label}`, shape: 'button', analog: false, label,
      ...(icon !== undefined && { icon }), ...(zone !== undefined && { zone }), ...(toggle && { toggle }),
      ...(holdMs !== undefined && { holdMs }), ...(state !== undefined && { state }),
      ...(size !== undefined && { size: size as number }), ...(at !== undefined && { at }), ...(ring !== undefined && { ring }),
    });
  }

  /** One direction (a button), or all four as a 2D axis. */
  static swipe(...args: unknown[]): Binding {
    const dir = direction(bindArgs('touch.swipe', args, { positional: ['direction'] }).args['direction'], 'touch.swipe');
    return dir === undefined
      ? touchBind({ id: 'swipe', shape: 'swipe', analog: true })
      : touchBind({ id: `swipe:${dir}`, shape: 'swipe', analog: false, direction: dir });
  }

  /** An on-screen d-pad (2D), or one of its directions (a button). */
  static dpad(...args: unknown[]): Binding {
    const dir = direction(bindArgs('touch.dpad', args, { positional: ['direction'] }).args['direction'], 'touch.dpad');
    return dir === undefined
      ? touchBind({ id: 'dpad', shape: 'dpad', analog: true })
      : touchBind({ id: `dpad:${dir}`, shape: 'dpad', analog: false, direction: dir });
  }

  /** A −/+ pair for an axis1: -1 while minus is held, +1 while plus is. */
  static stepper(...args: unknown[]): Binding {
    const a = bindArgs('touch.stepper', args, { positional: ['minus', 'plus'], keyword: ['zone'] }).args;
    const minus = labelArg(a['minus'] ?? '−', 'touch.stepper minus');
    const plus = labelArg(a['plus'] ?? '+', 'touch.stepper plus');
    const zone = zoneOf(a['zone'], 'touch.stepper');
    return touchBind({ id: `stepper:${minus}|${plus}`, shape: 'stepper', analog: true, labels: [minus, plus], ...(zone !== undefined && { zone }) });
  }

  /** Brake and gas pedals at the bottom right, for an axis1: brake -1, gas +1. */
  static pedals(...args: unknown[]): Binding {
    const a = bindArgs('touch.pedals', args, { positional: ['brake', 'gas'] }).args;
    const brake = labelArg(a['brake'] ?? 'Brake', 'touch.pedals brake');
    const gas = labelArg(a['gas'] ?? 'Gas', 'touch.pedals gas');
    return touchBind({ id: `pedals:${brake}|${gas}`, shape: 'stepper', analog: true, zone: 'pedals', labels: [brake, gas] });
  }

  /** A steering wheel under the left thumb, for an axis1: -1 (left) .. 1 (right). */
  static steer(...args: unknown[]): Binding {
    bindArgs('touch.steer', args, {});
    return touchBind({ id: 'steer', shape: 'steer', analog: true });
  }

  /** A button held while the `side` joystick is pushed to its rim (sprint with no button). */
  static stick_edge(...args: unknown[]): Binding {
    const { side } = bindArgs('touch.stick_edge', args, { positional: ['side'], required: ['side'] }).args;
    if (side !== 'left' && side !== 'right') fail('PP4402', `touch.stick_edge side must be "left" or "right", got ${String(side)}`);
    return touchBind({ id: `joystick:${side}:edge`, shape: 'stick_edge', analog: false, side });
  }

  /** A `button_group`'s slots as a strip along the bottom: `touch.hotbar("Sword", "Bow", None)`. */
  static hotbar(...args: unknown[]): TouchGroup {
    return touchGroup('hotbar', args);
  }

  /** A `button_group`'s slots as one segmented control; the chosen segment stays lit. */
  static toggle_group(...args: unknown[]): TouchGroup {
    return touchGroup('toggle_group', args);
  }
}

// ── Touch skin ─────────────────────────────────────────────────────────────────

const SKIN_SHAPES: readonly NonNullable<TouchSkinSpec['shape']>[] = ['circle', 'rounded', 'square'];

/** A Color as CSS; `where` names the argument ("TouchSkin fill", "touch.button ring"). */
function cssColor(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Color)) fail(where.startsWith('touch.') ? 'PP4402' : 'PP4405', `${where}= takes a Color, got ${String(value)}`, { fix: 'Color.hex("#ffd95a") or Color(1, 0.85, 0.35, 0.6).' });
  const c = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${c(value.r)}, ${c(value.g)}, ${c(value.b)}, ${Math.max(0, Math.min(1, value.a))})`;
}

/** The look of the touch controls: `Actions.touch_skin = TouchSkin(...)`. */
export class TouchSkin {
  readonly __touch_skin__: TouchSkinSpec;

  constructor(...args: unknown[]) {
    const a = bindArgs('TouchSkin', args, {
      keyword: ['fill', 'stroke', 'ink', 'pressed', 'accent', 'joystick_base', 'joystick_knob', 'shape', 'opacity', 'scale', 'stroke_width', 'blur', 'press_scale', 'font'],
    }).args;
    const shape = a['shape'] ?? undefined;
    if (shape !== undefined && !SKIN_SHAPES.includes(shape as NonNullable<TouchSkinSpec['shape']>)) {
      fail('PP4405', `TouchSkin shape= must be one of ${SKIN_SHAPES.map((x) => `"${x}"`).join(', ')}, got ${String(shape)}`);
    }
    const ranged = (key: string, lo: number, hi: number): number | undefined => {
      const v = a[key] ?? undefined;
      if (v !== undefined && (typeof v !== 'number' || !(v >= lo && v <= hi))) fail('PP4405', `TouchSkin ${key}= must be ${lo}..${hi}, got ${String(v)}`);
      return v as number | undefined;
    };
    const opacity = ranged('opacity', 0.2, 1);
    const scale = ranged('scale', 0.6, 1.6);
    const strokeWidth = ranged('stroke_width', 0, 8);
    const blur = ranged('blur', 0, 24);
    const pressScale = ranged('press_scale', 0.8, 1.2);
    const font = a['font'] ?? undefined;
    if (font !== undefined && (typeof font !== 'string' || /[;{}<>]|url\(/i.test(font))) fail('PP4405', `TouchSkin font= takes a CSS font-family list, got ${String(font)}`);
    const colors: Record<string, string> = {};
    for (const [key, field] of [['fill', 'fill'], ['stroke', 'stroke'], ['ink', 'ink'], ['pressed', 'pressed'], ['accent', 'accent'],
      ['joystick_base', 'joystickBase'], ['joystick_knob', 'joystickKnob']] as const) {
      const css = cssColor(a[key], `TouchSkin ${key}`);
      if (css !== undefined) colors[field] = css;
    }
    this.__touch_skin__ = {
      ...colors,
      ...(shape !== undefined && { shape: shape as TouchSkinSpec['shape'] }),
      ...(opacity !== undefined && { opacity }), ...(scale !== undefined && { scale }),
      ...(strokeWidth !== undefined && { strokeWidth }), ...(blur !== undefined && { blur }), ...(pressScale !== undefined && { pressScale }),
      ...(font !== undefined && { font: font as string }),
    };
  }
}

// ── Actions ────────────────────────────────────────────────────────────────────

/** A digital action. */
export class Button {
  readonly __action__: ButtonDecl;
  constructor(decl: ButtonDecl) { this.__action__ = decl; }
}

/** A -1..1 analog action. */
export class Axis1 {
  readonly __action__: Axis1Decl;
  constructor(decl: Axis1Decl) { this.__action__ = decl; }
}

/** A 2D analog action. */
export class Axis2 {
  readonly __action__: Axis2Decl;
  constructor(decl: Axis2Decl) { this.__action__ = decl; }
}

/** N buttons read as one action. */
export class ButtonGroup {
  readonly __action__: GroupDecl;
  constructor(decl: GroupDecl) { this.__action__ = decl; }
  __len__(): number { return this.__action__.slots.length; }
}

type PartKind = BindingPart['kind'];

/** Parts a device argument may contain, for each action type. */
function parts(value: unknown, where: string, allowed: readonly PartKind[], touchAnalog?: boolean): BindingPart[] {
  if (value === undefined || value === null) return [];
  if (!(value instanceof Binding)) fail('PP4402', `${where} takes a binding (keys.WASD, gamepad.SOUTH…), got ${String(value)}`);
  for (const part of value.parts) {
    const ok = allowed.includes(part.kind) && (part.kind !== 'touch' || touchAnalog === undefined || part.control.analog === touchAnalog);
    if (!ok) {
      const name = part.kind === 'touch' ? `touch ${part.control.shape}${part.control.direction !== undefined ? ` "${part.control.direction}"` : ''}` : part.kind.replace('_', ' ');
      fail('PP4402', `${where} can't use a ${name} binding`, { fix: `Bind this action with ${allowed.join(', ').replace(/_/g, ' ')}.` });
    }
  }
  return [...value.parts];
}

/** `touch=touch.NONE`. */
const noTouch = (value: unknown): boolean => value === NO_TOUCH;

function repeatOf(value: unknown, where: string): readonly [number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  const pair = iterable(value) ? [...value] : [];
  if (pair.length !== 2 || !pair.every((n) => typeof n === 'number' && n > 0)) {
    fail('PP4403', `${where} repeat= takes (delay, interval) in positive seconds, got ${String(value)}`);
  }
  return [pair[0] as number, pair[1] as number];
}

function needsBinding(found: number, where: string): void {
  if (found === 0) fail('PP4404', `${where} has no binding`, { fix: 'Bind at least one of keyboard=, gamepad=, mouse=, touch=.' });
}

export function button(...args: unknown[]): Button {
  const a = bindArgs('button', args, { keyword: ['keyboard', 'gamepad', 'mouse', 'touch', 'repeat'] }).args;
  const keyboard = a['keyboard'] instanceof Binding
    ? parts(a['keyboard'], 'button keyboard=', ['keys'])
    : a['keyboard'] === undefined || a['keyboard'] === null ? [] : [{ kind: 'keys', codes: keyCodes(a['keyboard'], 'button keyboard=') } as const];
  const bindings = [
    ...keyboard,
    ...parts(a['gamepad'], 'button gamepad=', ['pad_button', 'pad_trigger']),
    ...parts(a['mouse'], 'button mouse=', ['mouse_button', 'mouse_wheel']),
    ...parts(a['touch'], 'button touch=', ['touch'], false),
  ];
  needsBinding(bindings.length, 'button()');
  const repeat = repeatOf(a['repeat'], 'button');
  return new Button({ kind: 'button', bindings, ...(repeat !== undefined && { repeat }), ...(noTouch(a['touch']) && { noTouch: true }) });
}

export function axis1(...args: unknown[]): Axis1 {
  const a = bindArgs('axis1', args, { keyword: ['negative', 'positive', 'gamepad', 'mouse', 'touch'] }).args;
  const side = (key: 'negative' | 'positive'): string[] =>
    a[key] === undefined || a[key] === null ? [] : keyCodes(a[key], `axis1 ${key}=`);
  const negative = side('negative');
  const positive = side('positive');
  if ((negative.length === 0) !== (positive.length === 0)) {
    fail('PP4402', 'axis1 needs both negative= and positive= keys, or neither');
  }
  const pad = parts(a['gamepad'], 'axis1 gamepad=', ['pad_axis', 'pad_trigger', 'pad_button']);
  if (pad.length > 2) fail('PP4402', 'axis1 gamepad= takes one axis or a pair (negative | positive)');
  const other = [
    ...parts(a['mouse'], 'axis1 mouse=', ['mouse_wheel']),
    ...parts(a['touch'], 'axis1 touch=', ['touch']),
  ];
  needsBinding(negative.length + pad.length + other.length, 'axis1()');
  const touchParts = other.filter((p) => p.kind === 'touch');
  if (touchParts.length > 2 || (touchParts.length === 2 && touchParts.some((p) => p.kind === 'touch' && p.control.analog))) {
    fail('PP4402', 'axis1 touch= takes one control, or two buttons as a pair (the first reads -1, the second +1)', { fix: 'touch=touch.stepper() or touch=touch.button("Back") | touch.button("Forward").' });
  }
  return new Axis1({ kind: 'axis1', negative, positive, gamepad: pad, other, ...(noTouch(a['touch']) && { noTouch: true }) });
}

export function axis2(...args: unknown[]): Axis2 {
  const a = bindArgs('axis2', args, { keyword: ['keyboard', 'gamepad', 'mouse', 'touch', 'repeat'] }).args;
  const bindings = [
    ...parts(a['keyboard'], 'axis2 keyboard=', ['composite', 'key_axis']),
    ...parts(a['gamepad'], 'axis2 gamepad=', ['pad_stick', 'pad_dpad']),
    ...parts(a['mouse'], 'axis2 mouse=', ['mouse_delta']),
    ...parts(a['touch'], 'axis2 touch=', ['touch'], true),
  ];
  needsBinding(bindings.length, 'axis2()');
  const repeat = repeatOf(a['repeat'], 'axis2');
  return new Axis2({ kind: 'axis2', bindings, ...(repeat !== undefined && { repeat }), ...(noTouch(a['touch']) && { noTouch: true }) });
}

export function button_group(...args: unknown[]): ButtonGroup {
  const a = bindArgs('button_group', args, { keyword: ['keyboard', 'gamepad', 'touch_labels', 'touch'], required: ['keyboard'] }).args;
  const list = (value: unknown, where: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!iterable(value) || typeof value === 'string') fail('PP4402', `${where} takes a sequence`);
    return [...value];
  };
  const board = list(a['keyboard'], 'button_group keyboard=');
  const pads = list(a['gamepad'], 'button_group gamepad=');
  const labels = list(a['touch_labels'], 'button_group touch_labels=');
  if (board.length === 0) fail('PP4402', 'button_group needs at least one button');
  if (pads.length > board.length) fail('PP4402', 'button_group gamepad= has more slots than keyboard=');
  if (labels.length > board.length) fail('PP4402', 'button_group touch_labels= has more slots than keyboard=');
  if (!labels.every((l) => typeof l === 'string' || l === null)) {
    fail('PP4402', 'button_group touch_labels= takes a label (str) or None per slot', { fix: 'touch_labels=(None, None, "Grenade") puts a touch button on the third slot only.' });
  }
  const group = a['touch'] ?? undefined;
  if (group !== undefined && !(group instanceof TouchGroup) && !noTouch(group)) {
    fail('PP4402', `button_group touch= takes touch.hotbar(...), touch.toggle_group(...) or touch.NONE, got ${String(group)}`);
  }
  if (group !== undefined && labels.length > 0) fail('PP4402', 'button_group takes touch= or touch_labels=, not both');
  if (group instanceof TouchGroup && group.controls.length > board.length) fail('PP4402', 'button_group touch= has more slots than keyboard=');
  const slots = board.map((k, i) => ({
    bindings: [
      ...(k === null ? [] : [{ kind: 'keys', codes: keyCodes(k, `button_group keyboard[${i}]`) } as const]),
      ...(pads[i] === undefined || pads[i] === null ? [] : parts(pads[i], `button_group gamepad[${i}]`, ['pad_button', 'pad_trigger'])),
      // A labelled slot gets an on-screen touch button (the same control as touch.button(label)).
      ...(typeof labels[i] === 'string' ? [{ kind: 'touch', control: { id: `button:${labels[i] as string}`, shape: 'button', analog: false, label: labels[i] as string } } as const] : []),
      ...(group instanceof TouchGroup && group.controls[i] != null ? [{ kind: 'touch', control: group.controls[i]! } as const] : []),
    ],
  }));
  const touchLabels = group instanceof TouchGroup ? group.controls.map((c) => c?.label ?? null) : labels as (string | null)[];
  return new ButtonGroup({ kind: 'group', slots, touchLabels, ...(noTouch(group) && { noTouch: true }) });
}

// ── Action sets ────────────────────────────────────────────────────────────────

/** A scene ref or scene tag list (`scenes=`) as the kernel's scopes. */
export function sceneScopes(value: unknown, where: string): SceneScope[] {
  if (value === undefined || value === null) return [];
  if (!iterable(value) || typeof value === 'string') fail('PP4405', `${where} scenes= takes a list of scenes or scene tags`);
  return [...value].map((x) => {
    if (x instanceof SceneRef) return { scene: x.id };
    if (x instanceof Tag) return { tag: x.id };
    return fail('PP4405', `${where} scenes= takes scenes (Scenes.<id>) or scene Tags, got ${String(x)}`);
  });
}

const SETS = new WeakMap<Function, ActionSetDecl>();
let registered: Function[] = [];

/**
 * Base of a game's action sets. Subclass it and declare actions as class attributes;
 * `priority`, `scenes` and `active_when(ctx, owner)` are optional.
 */
export class Actions {
  static priority = 0;
  static scenes: unknown = [];
  /** A genre's touch scheme ("fps", "racer"…): fills in touch controls for actions without one. */
  static touch_preset: unknown = null;
  /** `TouchSkin(...)`: the touch controls' look while this set is live. */
  static touch_skin: unknown = null;
  /** False: while this set is live, reading `ctx.input.text` never opens the phone's keyboard. */
  static touch_keyboard: unknown = true;

  static active_when(_ctx: unknown, _owner: unknown): unknown {
    return true;
  }

  /** CPython calls this when a subclass's body ends; it registers the set. */
  static __init_subclass__(this: typeof Actions): void {
    registerActions(this);
  }
}

function isActionsClass(value: unknown): value is typeof Actions {
  return typeof value === 'function' && value.prototype instanceof Actions;
}

/** The plugin declaration of an `Actions` subclass (built once per class). */
export function actionSetOf(cls: unknown): ActionSetDecl {
  if (!isActionsClass(cls)) fail('PP4406', `${String(cls)} is not an Actions subclass`);
  const cached = SETS.get(cls);
  if (cached !== undefined) return cached;
  const base = Object.getPrototypeOf(cls) as unknown;
  const parent = isActionsClass(base) ? actionSetOf(base) : undefined;
  const actions = new Map<string, ActionDecl>(parent?.actions ?? []);
  for (const name of Object.getOwnPropertyNames(cls)) {
    const value = (cls as unknown as Record<string, unknown>)[name];
    if (value instanceof Button || value instanceof Axis1 || value instanceof Axis2 || value instanceof ButtonGroup) {
      actions.set(name, value.__action__);
    }
  }
  const priority = cls.priority;
  if (typeof priority !== 'number' || !Number.isInteger(priority)) fail('PP4405', `${cls.name}.priority must be an int`);
  const when = cls.active_when;
  const preset = cls.touch_preset ?? undefined;
  if (preset !== undefined && !TOUCH_PRESETS.includes(preset as TouchPreset)) {
    const guess = typeof preset === 'string' ? closestMatch(preset, TOUCH_PRESETS) : undefined;
    fail('PP4405', `${cls.name}.touch_preset must be one of ${TOUCH_PRESETS.map((p) => `"${p}"`).join(', ')}, got ${String(preset)}`, {
      ...(guess !== undefined && { fix: `Did you mean "${guess}"?` }),
    });
  }
  const skin = cls.touch_skin ?? undefined;
  if (skin !== undefined && !(skin instanceof TouchSkin)) fail('PP4405', `${cls.name}.touch_skin takes a TouchSkin(...), got ${String(skin)}`);
  const keyboard = cls.touch_keyboard;
  if (typeof keyboard !== 'boolean') fail('PP4405', `${cls.name}.touch_keyboard must be True or False, got ${String(keyboard)}`);
  const set: ActionSetDecl = {
    id: cls.name,
    priority,
    scenes: sceneScopes(cls.scenes, cls.name),
    actions,
    ...(when !== Actions.active_when && { activeWhen: (ctx: unknown, owner: unknown) => truthy(when.call(cls, ctx, owner)) }),
    ...(parent !== undefined && { parent }),
    ...(preset !== undefined && { touchPreset: preset as TouchPreset }),
    ...(skin instanceof TouchSkin && { touchSkin: skin.__touch_skin__ }),
    ...(!keyboard && { touchKeyboard: false as const }),
  };
  SETS.set(cls, set);
  return set;
}

/** Record an `Actions` subclass for the game (idempotent). */
export function registerActions(cls: unknown): ActionSetDecl {
  const set = actionSetOf(cls);
  if (!registered.includes(cls as Function)) registered.push(cls as Function);
  return set;
}

/** Every registered action set, in declaration order. */
export function registeredActionSets(): ActionSetDecl[] {
  return registered.map((cls) => actionSetOf(cls));
}

/** Forget registered action sets (a fresh module realm; tests). */
export function resetActionSets(): void {
  registered = [];
}

/**
 * What `dialogueInput` needs from the input engine: whether any button action was pressed
 * this frame on a seat, whatever its set's liveness (`active_when`, scenes) and a modal's
 * mute — a conversation advances on any press, and its panel is modal.
 */
export interface AnyPress {
  readonly seats: readonly { readonly index: number }[];
  anyButtonPressed(seat: number): boolean;
}

/** The `dialogue_input` service (runtime: `kernel.provide(DIALOGUE_INPUT_SERVICE, dialogueInput(inputEngine))`). */
export function dialogueInput(engine: AnyPress): DialogueInput {
  return { confirmPressed: () => engine.seats.some((seat) => engine.anyButtonPressed(seat.index)) };
}
