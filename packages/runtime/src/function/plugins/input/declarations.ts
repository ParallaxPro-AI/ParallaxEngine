/**
 * Declarations: the engine form of a game's `Actions` subclasses. The api layer builds
 * these from `button()` / `axis1()` / `axis2()` / `button_group()` and the binding
 * constants (`keys.WASD`, `gamepad.SOUTH`, `touch.joystick("left")`…); the input plugin
 * only ever sees these plain shapes.
 */

import type { GamepadButton, MouseButton, TouchShape, TouchSkin, TouchZone } from '../../../core/index.js';
import type { Condition, SceneScope } from '../../kernel/index.js';

export type StickSide = 'left' | 'right';
export type Direction = 'up' | 'down' | 'left' | 'right';
export type PadAxis = 'left_x' | 'left_y' | 'right_x' | 'right_y';

export type { TouchShape, TouchSkin, TouchZone };

/**
 * A touch control's state from the game, asked once per frame with the context (none while
 * the layout is empty). `visible` false: not drawn, reads as idle. `enabled` false: drawn
 * greyed, reads as idle. `relabel`: a label / icon in place of the declared ones (undefined:
 * the declared). `cooldown`: 0..1 of a recharge to go. `selected`: a toggle-group segment.
 */
export interface TouchControlState {
  readonly visible?: (ctx: unknown) => boolean;
  readonly enabled?: (ctx: unknown) => boolean;
  readonly relabel?: (ctx: unknown) => { readonly label?: string; readonly icon?: string } | undefined;
  readonly cooldown?: (ctx: unknown) => number;
  readonly selected?: (ctx: unknown) => boolean;
}

/** Touch controls are drawn by the platform from these descriptors and reported back by `id`. */
export interface TouchControl {
  /** Stable id the platform reports state under: "joystick:left", "button:Jump", "swipe:up", "dpad"… */
  readonly id: string;
  readonly shape: TouchShape;
  /** Digital (button, tap, one swipe / d-pad direction) or analog (joystick, d-pad, swipe, drag, look, stepper…). */
  readonly analog: boolean;
  readonly side?: StickSide;
  readonly label?: string;
  readonly icon?: string;
  readonly direction?: Direction;
  readonly zone?: TouchZone;
  readonly labels?: readonly [string, string];
  readonly fixed?: boolean;
  readonly toggle?: boolean;
  readonly holdMs?: number;
  readonly group?: string;
  /** Button size against its zone's default (0.5..2). */
  readonly size?: number;
  /** Button centre as fractions of the safe area (x from the left, y from the top). */
  readonly at?: readonly [number, number];
  /** Button ring colour (CSS). */
  readonly ring?: string;
  readonly state?: TouchControlState;
}

/** Touch shapes whose x/y is a per-poll delta (not clamped to -1..1, like mouse delta and wheel). */
export function touchIsDelta(shape: TouchShape): boolean {
  return shape === 'drag' || shape === 'look' || shape === 'pinch' || shape === 'scroll';
}

/**
 * A genre's touch scheme (`Actions.touch_preset`): fills in a touch control for each action
 * the set declares without one, from its keyboard / mouse / gamepad bindings, and places the
 * set's buttons (see touch_presets.ts).
 */
export type TouchPreset = 'fps' | 'tps' | 'topdown' | 'platformer' | 'sidescroller' | 'racer' | 'flight' | 'rts' | 'click' | 'custom';

export const TOUCH_PRESETS: readonly TouchPreset[] = ['fps', 'tps', 'topdown', 'platformer', 'sidescroller', 'racer', 'flight', 'rts', 'click', 'custom'];

/** One physical input a binding reads. `|` on bindings concatenates parts. */
export type BindingPart =
  /** Any of these keys (digital). */
  | { readonly kind: 'keys'; readonly codes: readonly string[] }
  /** Four key sets as a 2D axis (WASD, arrows, IJKL). */
  | { readonly kind: 'composite'; readonly up: readonly string[]; readonly left: readonly string[]; readonly down: readonly string[]; readonly right: readonly string[] }
  /** Two key sets as a horizontal-only or vertical-only 2D axis (keys.AD, keys.WS). */
  | { readonly kind: 'key_axis'; readonly axis: 'x' | 'y'; readonly negative: readonly string[]; readonly positive: readonly string[] }
  | { readonly kind: 'pad_button'; readonly button: GamepadButton }
  | { readonly kind: 'pad_stick'; readonly stick: StickSide }
  | { readonly kind: 'pad_axis'; readonly axis: PadAxis }
  | { readonly kind: 'pad_trigger'; readonly trigger: StickSide }
  | { readonly kind: 'pad_dpad' }
  | { readonly kind: 'mouse_button'; readonly button: MouseButton }
  | { readonly kind: 'mouse_delta' }
  | { readonly kind: 'mouse_wheel' }
  | { readonly kind: 'touch'; readonly control: TouchControl };

export type Binding = readonly BindingPart[];

/** Where an action was declared (assigned when its `Actions` subclass is registered). */
export interface ActionOwner {
  readonly set: ActionSetDecl;
  readonly name: string;
}

interface ActionBase {
  /** Set when the declaring class registers; an action read before that is an error. */
  owner?: ActionOwner;
  /** `touch=touch.NONE`: no touch control, not even one a preset would fill in. */
  readonly noTouch?: boolean;
}

export interface ButtonDecl extends ActionBase {
  readonly kind: 'button';
  readonly bindings: Binding;
  /** (delay, interval) seconds: while held, pressed again after delay, then every interval. */
  readonly repeat?: readonly [number, number];
}

export interface Axis1Decl extends ActionBase {
  readonly kind: 'axis1';
  readonly negative: readonly string[];
  readonly positive: readonly string[];
  /**
   * One part: its value (stick axis -1..1, trigger 0..1, button 0/1). Two parts: a pair,
   * the first reads -1, the second +1 (`LEFT_TRIGGER | RIGHT_TRIGGER`, `DPAD_DOWN | DPAD_UP`).
   */
  readonly gamepad: Binding;
  /** Wheel notches, an analog touch control's x (pinch / scroll: notches), or two touch buttons as a -1 / +1 pair. */
  readonly other: Binding;
}

export interface Axis2Decl extends ActionBase {
  readonly kind: 'axis2';
  readonly bindings: Binding;
  /** Repeat for `pressed_direction` while a direction is held. */
  readonly repeat?: readonly [number, number];
}

export interface GroupSlot {
  readonly bindings: Binding;
}

export interface GroupDecl extends ActionBase {
  readonly kind: 'group';
  readonly slots: readonly GroupSlot[];
  /** Per slot: the touch button's label, or null for no touch button. */
  readonly touchLabels: readonly (string | null)[];
}

export type ActionDecl = ButtonDecl | Axis1Decl | Axis2Decl | GroupDecl;

/** One `Actions` subclass. */
export interface ActionSetDecl {
  /** The class name, for messages. */
  readonly id: string;
  readonly priority: number;
  /** Empty: every scene. */
  readonly scenes: readonly SceneScope[];
  /** Live condition; `owner` is the reading behavior's entity handle, null for systems. */
  readonly activeWhen?: (ctx: unknown, owner: unknown) => boolean;
  /** The set this one subclasses (per-seat overrides resolve actions through it). */
  readonly parent?: ActionSetDecl;
  /** Fills in and places touch controls by genre (inherited from the parent set). */
  readonly touchPreset?: TouchPreset;
  /** The touch controls' look while this set is the highest-priority live one with a skin. */
  readonly touchSkin?: TouchSkin;
  /** False: while this set is live, reading typed text never opens the phone's keyboard (the game draws its own). */
  readonly touchKeyboard?: false;
  /** Every action, inherited ones included, by attribute name. */
  readonly actions: ReadonlyMap<string, ActionDecl>;
}

/** Register an action set: give each action declared on it its owner. */
export function claimActions(set: ActionSetDecl): void {
  for (const [name, action] of set.actions) {
    if (action.owner === undefined) action.owner = { set, name };
  }
}

/** Every binding part of an action (all slots for a group). */
export function partsOf(action: ActionDecl): readonly BindingPart[] {
  switch (action.kind) {
    case 'button':
    case 'axis2':
      return action.bindings;
    case 'axis1':
      return [
        ...(action.negative.length > 0 ? [{ kind: 'keys', codes: action.negative } as const] : []),
        ...(action.positive.length > 0 ? [{ kind: 'keys', codes: action.positive } as const] : []),
        ...action.gamepad,
        ...action.other,
      ];
    case 'group':
      return action.slots.flatMap((slot) => slot.bindings);
  }
}

/**
 * The physical sources a part reads, as stable keys. Two live action sets conflict when
 * they read the same source; the higher priority one keeps it.
 */
export function sourcesOf(part: BindingPart): readonly string[] {
  switch (part.kind) {
    case 'keys':
      return part.codes.map((c) => `key:${c}`);
    case 'composite':
      return [...part.up, ...part.left, ...part.down, ...part.right].map((c) => `key:${c}`);
    case 'key_axis':
      return [...part.negative, ...part.positive].map((c) => `key:${c}`);
    case 'pad_button':
      return [`pad:${part.button}`];
    case 'pad_stick':
      return [`pad:stick_${part.stick}`];
    case 'pad_axis':
      return [`pad:stick_${part.axis.startsWith('left') ? 'left' : 'right'}`];
    case 'pad_trigger':
      return [`pad:trigger_${part.trigger}`];
    case 'pad_dpad':
      return ['pad:dpad_up', 'pad:dpad_down', 'pad:dpad_left', 'pad:dpad_right'];
    case 'mouse_button':
      return [`mouse:${part.button}`];
    case 'mouse_delta':
      return ['mouse:delta'];
    case 'mouse_wheel':
      return ['mouse:wheel'];
    case 'touch':
      return [`touch:${part.control.id}`];
  }
}
