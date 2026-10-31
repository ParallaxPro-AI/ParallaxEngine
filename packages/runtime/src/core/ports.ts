/**
 * Ports: what the engine needs from the machine it runs on, declared here and
 * implemented in `platform/` (headless, browser). Engine code depends on these
 * interfaces only; `boot` decides which implementation a game gets.
 */

/** Monotonic time. */
export interface Clock {
  /** Seconds since an arbitrary fixed origin. Never goes backwards. */
  now(): number;
}

/** A project's files: a directory on disk, a server's bundle, or an in-memory map in tests. */
export interface ProjectFiles {
  /** Every file, as project-relative POSIX paths (`prefabs/ball.prefab.json`). */
  list(): readonly string[];
  /** A file's text. Only called for paths returned by `list()`. */
  read(path: string): string;
}

/** Small persistent key/value storage (settings, profile saves). */
export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): string[];
}

// ── Input devices ───────────────────────────────────────────────────────────────

/** Gamepad buttons, in the standard layout's names (SOUTH = A on Xbox, Cross on PlayStation). */
export type GamepadButton =
  | 'south' | 'east' | 'west' | 'north'
  | 'left_shoulder' | 'right_shoulder'
  | 'start' | 'select'
  | 'dpad_up' | 'dpad_down' | 'dpad_left' | 'dpad_right'
  | 'left_stick' | 'right_stick';

/** One connected gamepad, as sampled at `poll()`. */
export interface GamepadSnapshot {
  /** Buttons held now. */
  readonly buttons: ReadonlySet<GamepadButton>;
  /** Buttons that went down since the last poll, even if already released again. */
  readonly pressed: readonly GamepadButton[];
  /** Sticks -1..1 with +y up (the adapter flips the browser's y-down), triggers 0..1. Raw: no dead zone. */
  readonly axes: {
    readonly leftX: number;
    readonly leftY: number;
    readonly rightX: number;
    readonly rightY: number;
    readonly leftTrigger: number;
    readonly rightTrigger: number;
  };
}

export type MouseButton = 'left' | 'right' | 'middle';

/** The mouse, or the primary touch acting as one. Screen pixels, y down. */
export interface PointerSnapshot {
  readonly x: number;
  readonly y: number;
  /** Movement since the last poll (raw, works under pointer lock). */
  readonly dx: number;
  readonly dy: number;
  /** Buttons held now. */
  readonly buttons: ReadonlySet<MouseButton>;
  /** Buttons that went down since the last poll, even if already released again. */
  readonly pressed: readonly MouseButton[];
  /** Wheel notches since the last poll; positive = scrolled up / away from the user. */
  readonly wheel: number;
  /** The last press landed on a UI panel (the adapter hit-tests panels). */
  readonly pressedOverUi: boolean;
}

/**
 * One generated on-screen touch control (joystick, button, d-pad, swipe area…), keyed by
 * the id the input plugin lists in its touch layout. x/y are -1..1 (+y up) for sticks and
 * d-pads, a unit direction on a swipe's frame, and a screen-pixel delta for drag/look.
 */
export interface TouchControlSnapshot {
  readonly held: boolean;
  /** Went down (or swiped / tapped) since the last poll. */
  readonly pressed: boolean;
  readonly x: number;
  readonly y: number;
}

/** Everything the input devices did since the previous poll. */
export interface InputSnapshot {
  /** Key codes held now (`KeyboardEvent.code`: "Space", "KeyW", "ArrowUp"). */
  readonly keys: ReadonlySet<string>;
  /** Key codes that went down since the last poll, even if already released again. */
  readonly keysPressed: readonly string[];
  /** Gamepads by slot; `null` for an empty slot. */
  readonly gamepads: readonly (GamepadSnapshot | null)[];
  readonly pointer: PointerSnapshot;
  readonly touch: ReadonlyMap<string, TouchControlSnapshot>;
  /** Characters typed since the last poll. */
  readonly text: string;
}

/**
 * The kinds of on-screen touch control. Drawn ones:
 *
 *   joystick    a stick on the `side` half (floating, or `fixed` at its rest point): x/y -1..1 (+y up)
 *   button      a labelled button (`label` already localized; `icon` a glyph name, an emoji,
 *               or "auto": picked from the label)
 *   dpad        four arrows: analog (x/y in -1, 0, 1) or one `direction` (digital)
 *   stepper     a -/+ pair (`labels`): x = -1 / +1 while a half is held (pedals: zone "pedals")
 *   steer       a steering wheel on the left: x -1..1, self-centring
 *
 * Gestures on the play area (fingers not on a control):
 *
 *   swipe       a flick: analog (a unit x/y on its frame) or one direction
 *   tap         a short touch (pressed on release)
 *   double_tap  two taps close together (pressed on the second)
 *   long_press  a touch held still (pressed once, held until the finger lifts)
 *   drag        a held touch: x/y = pixels moved since the last poll (+y up)
 *   look        as drag, for touches that start on the right half (camera look)
 *   pinch       two fingers: x = spread since the last poll, in wheel notches (+ = apart)
 *   scroll      two fingers: x = vertical travel since the last poll, in wheel notches (+ = up)
 *   stick_edge  the `side` joystick pushed to its rim (sprint without a button)
 */
export type TouchShape =
  | 'joystick' | 'button' | 'dpad' | 'stepper' | 'steer'
  | 'swipe' | 'tap' | 'double_tap' | 'long_press' | 'drag' | 'look' | 'pinch' | 'scroll' | 'stick_edge';

/**
 * Where a button sits. Unset: the action cluster (its first button becomes the primary).
 *
 *   primary  the big button under the right thumb       actions  an arc around the primary
 *   left     a row under the left thumb                 pedals   tall buttons at the bottom right
 *   hotbar   a strip along the bottom centre            system   small buttons in the top-right corner
 */
export type TouchZone = 'primary' | 'actions' | 'left' | 'pedals' | 'hotbar' | 'system';

/**
 * One on-screen touch control the platform draws while it is listed (the input plugin's
 * touch layout: every live action set's touch bindings, none while a modal is open). The
 * platform reports its state under `id` in `InputSnapshot.touch`. The per-frame fields
 * (`disabled`, `selected`, `cooldown`, and `label` / `icon` after a relabel) come from the
 * game's state each frame; a control the game hides is simply not listed.
 */
export interface TouchControlSpec {
  readonly id: string;
  readonly shape: TouchShape;
  readonly analog: boolean;
  readonly side?: 'left' | 'right';
  readonly label?: string;
  readonly icon?: string;
  readonly direction?: 'up' | 'down' | 'left' | 'right';
  readonly zone?: TouchZone;
  /** stepper: the minus and plus halves' labels. */
  readonly labels?: readonly [string, string];
  /** joystick: drawn at its rest point and read from there (an attitude stick), not floating to the finger. */
  readonly fixed?: boolean;
  /** button: a tap latches it held, the next tap releases it. */
  readonly toggle?: boolean;
  /** button: how long the game wants it held (ms); a fill shows the hold's progress. */
  readonly holdMs?: number;
  /** button: drawn as one segment of this group's strip (a toggle group). */
  readonly group?: string;
  /** Greyed out; presses are swallowed. */
  readonly disabled?: boolean;
  /** Highlighted: the chosen segment of a toggle group. */
  readonly selected?: boolean;
  /** 0..1 of a recharge still to go, drawn as a sweep over the button. */
  readonly cooldown?: number;
  /** button: its size against its zone's default, 0.5..2. */
  readonly size?: number;
  /** button: its centre at this point of the safe area (0..1 from the left, 0..1 from the top), out of its zone's flow. */
  readonly at?: readonly [number, number];
  /** button: its ring (border) colour, CSS. */
  readonly ring?: string;
}

/** The look of the touch controls (`Actions.touch_skin`); CSS colors. Unset fields keep the engine's look. */
export interface TouchSkin {
  readonly fill?: string;
  readonly stroke?: string;
  /** Labels and icons. */
  readonly ink?: string;
  /** A held button's fill. */
  readonly pressed?: string;
  /** The primary button's and a selected segment's fill. */
  readonly accent?: string;
  readonly shape?: 'circle' | 'rounded' | 'square';
  /** 0.2..1 */
  readonly opacity?: number;
  /** Control size multiplier, 0.6..1.6. */
  readonly scale?: number;
  /** A CSS font-family list: a family a panel declares (`@font-face`), the engine's, or one the page loads. */
  readonly font?: string;
  /** Ring width in CSS pixels, 0..8. */
  readonly strokeWidth?: number;
  /** Backdrop blur behind the controls, CSS pixels 0..24. */
  readonly blur?: number;
  /** A held button's scale, 0.8..1.2. */
  readonly pressScale?: number;
  /** A joystick's base and knob fills. */
  readonly joystickBase?: string;
  readonly joystickKnob?: string;
}

/** What the engine asks of the devices each frame. */
export interface InputOutput {
  /** "locked": pointer lock for mouse-look while gameplay input is live; "free": a visible cursor. */
  readonly cursor: 'locked' | 'free';
  /**
   * With `cursor: "free"` in a scene that reads mouse-look (a modal menu over a mouse-look
   * view): a pointer that is already locked stays locked and the platform draws its own
   * cursor over the panels, moved by mouse movement, pressing what it is over. Mouse-look
   * then resumes without a click when the menu closes. Ignored while the pointer is not
   * locked (the OS cursor is the cursor) and on touch.
   */
  readonly virtualCursor?: boolean;
  /** Show an on-screen keyboard: code read typed text last frame (and no live set opted out with `touch_keyboard = False`). */
  readonly textEntry: boolean;
  /**
   * Vibrations requested last frame; `pad` null = the phone / every pad. With `pattern`, a
   * sequence of pulses played one after another — (strength 0..1, seconds), strength 0 a pause
   * — and `strength` / `seconds` are its peak and total length.
   */
  readonly rumble: readonly {
    readonly pad: number | null; readonly strength: number; readonly seconds: number;
    readonly pattern?: readonly (readonly [strength: number, seconds: number])[];
  }[];
  /** On-screen touch controls to draw now (empty: none). */
  readonly touch: readonly TouchControlSpec[];
  /** Their look: the highest-priority live action set's `touch_skin`; absent = the engine's. */
  readonly touchSkin?: TouchSkin;
}

/** Keyboard, mouse, gamepads and touch controls. Polled once per frame by the input plugin. */
export interface InputDevices {
  poll(): InputSnapshot;
  present(output: InputOutput): void;
}
