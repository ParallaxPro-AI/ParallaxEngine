/**
 * A scriptable `InputDevices` for tests and headless runs: hold keys, tap them, move
 * sticks, click, type. Taps register as pressed even when released before the next poll,
 * exactly as fast real input does. Once `platform/headless` exists it should host this.
 */

import type {
  GamepadButton, GamepadSnapshot, InputDevices, InputOutput, InputSnapshot, MouseButton, TouchControlSnapshot,
} from '../../../core/index.js';

type Axes = { -readonly [K in keyof GamepadSnapshot['axes']]: number };

interface Pad {
  buttons: Set<GamepadButton>;
  pressed: GamepadButton[];
  axes: Axes;
}

interface Touch {
  held: boolean;
  pressed: boolean;
  x: number;
  y: number;
  /** Momentary: cleared after one poll (taps, swipes, drag deltas). */
  momentary: boolean;
}

export class HeadlessInput implements InputDevices {
  readonly #keys = new Set<string>();
  #keysPressed: string[] = [];
  readonly #pads: (Pad | null)[] = [];
  #x = 0;
  #y = 0;
  #dx = 0;
  #dy = 0;
  readonly #buttons = new Set<MouseButton>();
  #pressedButtons: MouseButton[] = [];
  #wheel = 0;
  #overUi = false;
  #text = '';
  readonly #touch = new Map<string, Touch>();
  /** What the engine asked for at the last frame. */
  output: InputOutput | undefined;

  // ── Keyboard ────────────────────────────────────────────────────────────────

  keyDown(code: string): void {
    if (!this.#keys.has(code)) this.#keysPressed.push(code);
    this.#keys.add(code);
  }

  keyUp(code: string): void {
    this.#keys.delete(code);
  }

  /** Down and up before the next frame. */
  tapKey(code: string): void {
    this.keyDown(code);
    this.keyUp(code);
  }

  type(text: string): void {
    this.#text += text;
  }

  // ── Gamepads ────────────────────────────────────────────────────────────────

  connectPad(slot = 0): void {
    this.#pads[slot] ??= {
      buttons: new Set(), pressed: [], axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0, leftTrigger: 0, rightTrigger: 0 },
    };
  }

  disconnectPad(slot = 0): void {
    this.#pads[slot] = null;
  }

  #pad(slot: number): Pad {
    this.connectPad(slot);
    return this.#pads[slot]!;
  }

  padDown(button: GamepadButton, slot = 0): void {
    const pad = this.#pad(slot);
    if (!pad.buttons.has(button)) pad.pressed.push(button);
    pad.buttons.add(button);
  }

  padUp(button: GamepadButton, slot = 0): void {
    this.#pad(slot).buttons.delete(button);
  }

  /** Stick x/y (-1..1, +y up) or trigger (0..1). */
  padAxis(axis: keyof Axes, value: number, slot = 0): void {
    this.#pad(slot).axes[axis] = value;
  }

  // ── Mouse ───────────────────────────────────────────────────────────────────

  pointerMove(x: number, y: number): void {
    this.#dx += x - this.#x;
    this.#dy += y - this.#y;
    this.#x = x;
    this.#y = y;
  }

  /** Raw movement without moving the cursor (pointer lock). */
  mouseMotion(dx: number, dy: number): void {
    this.#dx += dx;
    this.#dy += dy;
  }

  pointerDown(button: MouseButton = 'left', options: { overUi?: boolean } = {}): void {
    if (!this.#buttons.has(button)) this.#pressedButtons.push(button);
    this.#buttons.add(button);
    this.#overUi = options.overUi ?? false;
  }

  pointerUp(button: MouseButton = 'left'): void {
    this.#buttons.delete(button);
  }

  click(button: MouseButton = 'left', options: { overUi?: boolean } = {}): void {
    this.pointerDown(button, options);
    this.pointerUp(button);
  }

  wheel(notches: number): void {
    this.#wheel += notches;
  }

  // ── Touch controls (ids from the input engine's touch layout) ───────────────

  touchHold(id: string, x = 0, y = 0): void {
    const was = this.#touch.get(id);
    this.#touch.set(id, { held: true, pressed: !(was?.held ?? false), x, y, momentary: false });
  }

  touchRelease(id: string): void {
    this.#touch.delete(id);
  }

  /** One-frame tap, swipe or drag delta. */
  touchPulse(id: string, x = 0, y = 0): void {
    this.#touch.set(id, { held: false, pressed: true, x, y, momentary: true });
  }

  // ── InputDevices ────────────────────────────────────────────────────────────

  poll(): InputSnapshot {
    const touch = new Map<string, TouchControlSnapshot>();
    for (const [id, t] of this.#touch) touch.set(id, { held: t.held, pressed: t.pressed, x: t.x, y: t.y });
    const snapshot: InputSnapshot = {
      keys: new Set(this.#keys),
      keysPressed: this.#keysPressed,
      gamepads: this.#pads.map((pad) => pad === null || pad === undefined ? null : {
        buttons: new Set(pad.buttons), pressed: pad.pressed, axes: { ...pad.axes },
      }),
      pointer: {
        x: this.#x, y: this.#y, dx: this.#dx, dy: this.#dy,
        buttons: new Set(this.#buttons), pressed: this.#pressedButtons, wheel: this.#wheel, pressedOverUi: this.#overUi,
      },
      touch,
      text: this.#text,
    };
    this.#keysPressed = [];
    for (const pad of this.#pads) if (pad !== null && pad !== undefined) pad.pressed = [];
    this.#pressedButtons = [];
    this.#dx = 0;
    this.#dy = 0;
    this.#wheel = 0;
    this.#text = '';
    for (const [id, t] of this.#touch) {
      if (t.momentary) this.#touch.delete(id);
      else t.pressed = false;
    }
    return snapshot;
  }

  present(output: InputOutput): void {
    this.output = output;
  }
}
