/**
 * Browser input devices: keyboard (on the window), mouse and the primary touch as the
 * pointer (pointer events on the stage, chorded buttons from the `buttons` bitmask),
 * wheel, pointer lock for mouse-look, gamepads in the standard layout, rumble and typed
 * text. Everything between two polls is queued, so a tap shorter than a frame still counts.
 *
 * Pointer coordinates are screen pixels from the stage's top-left, y down: the canvas's
 * backing pixels, which cameras map to the world (`screenScale`: CSS pixels × the device
 * pixel ratio), so `pointer.world` lands under the pointer on a high-DPI display too. The
 * movement (dx/dy) stays in CSS pixels, the mouse's own units. A press counts as
 * over the UI when it lands inside the panels layer (but not on the layer itself). On a
 * touch screen the first finger down (not on a touch control) is the pointer; the touch
 * controls (`touch.ts`) are polled with the rest.
 *
 * The virtual cursor (`ui/virtual_cursor.ts`): when the engine frees the cursor over a
 * mouse-look scene (`InputOutput.virtualCursor`, a modal menu) and the pointer is locked, the
 * lock stays; movement moves the drawn cursor, presses and the wheel go to the panel under it
 * (a press there counts as over the UI), and the pointer's x/y is the cursor's. A game whose
 * `Cursor` is "system" unlocks instead.
 *
 * A host page can lock the pointer at once from its own user gesture (`lock()`: an editor's
 * Play button for a game played with mouse-look) instead of waiting for a press on the
 * stage. A lock the host took is held through scenes without mouse-look too (a title menu):
 * wherever the cursor is free the virtual cursor is drawn, as over a modal, until Escape
 * releases it. A host can also suspend the devices while
 * it shows something else in the game's place (`setSuspended`: an editor's scene view): the
 * game then reads nothing, keys and the pointer are left to the page, and the lock is let go.
 */

import { diagnostic } from '../../core/index.js';
import { virtualCursorFor } from './ui/virtual_cursor.js';
import type { VirtualCursor } from './ui/virtual_cursor.js';
import type {
  Diagnostic, GamepadButton, GamepadSnapshot, InputDevices, InputOutput, InputSnapshot, MouseButton,
  TouchControlSnapshot,
} from '../../core/index.js';

/** The standard gamepad layout's buttons by index (https://w3c.github.io/gamepad/#remapping). */
const STANDARD_BUTTONS: readonly (GamepadButton | null)[] = [
  'south', 'east', 'west', 'north', 'left_shoulder', 'right_shoulder',
  null, null, // 6, 7: triggers, read as axes
  'select', 'start', 'left_stick', 'right_stick', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
];

/** `PointerEvent.buttons` bits. */
const MOUSE_BITS: readonly (readonly [number, MouseButton])[] = [[1, 'left'], [2, 'right'], [4, 'middle']];

/** Browser shortcuts the game never swallows. */
const PASS_THROUGH = /^F\d+$/;

const NO_TOUCH: ReadonlyMap<string, TouchControlSnapshot> = new Map();

/** The page objects the adapter listens to; `globalThis` in a browser. */
export interface InputHost {
  /** Receives keyboard events and focus loss. */
  readonly window: EventTarget;
  readonly document: EventTarget & {
    readonly pointerLockElement: Element | null;
    readonly activeElement: Element | null;
    exitPointerLock(): void;
  };
  readonly navigator: {
    getGamepads?(): readonly (Gamepad | null)[];
    vibrate?(pattern: number | number[]): boolean;
  };
}

export interface BrowserInputOptions {
  /** The game's area: pointer events, wheel, pointer lock. */
  readonly stage: HTMLElement;
  /** The panels layer; a press inside it is a press on the UI. With it, the stage gets the virtual cursor. */
  readonly ui?: Element;
  /** A text field focused while the game reads typed text, so phones show their keyboard. */
  readonly textInput?: HTMLInputElement;
  /** The on-screen touch controls: drawn from the engine's touch layout, read as `touch`. */
  readonly touch?: { present(specs: InputOutput['touch'], skin?: InputOutput['touchSkin']): void; poll(): ReadonlyMap<string, TouchControlSnapshot> };
  readonly host?: InputHost;
  /** Non-fatal device problems (an unmapped gamepad), each reported once. */
  readonly onProblem?: (d: Diagnostic) => void;
  /**
   * Screen pixels per CSS pixel of the stage: the canvas's backing scale (the device pixel
   * ratio), read at each poll. Cameras resolve the screen in backing pixels. Default 1.
   */
  readonly screenScale?: () => number;
}

function defaultHost(): InputHost {
  const g = globalThis as unknown as { window: EventTarget; document: InputHost['document']; navigator: InputHost['navigator'] };
  return { window: g.window, document: g.document, navigator: g.navigator };
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (el === null || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

/** One printable character (not "Enter", "ArrowUp", …). */
function printable(key: string): boolean {
  return [...key].length === 1;
}

export class BrowserInput implements InputDevices {
  readonly #stage: HTMLElement;
  readonly #ui: Element | undefined;
  readonly #cursor: VirtualCursor | undefined;
  readonly #text: HTMLInputElement | undefined;
  readonly #touch: BrowserInputOptions['touch'];
  readonly #host: InputHost;
  readonly #onProblem: (d: Diagnostic) => void;
  readonly #screenScale: () => number;
  readonly #dispose: (() => void)[] = [];

  readonly #keys = new Set<string>();
  #keysPressed: string[] = [];
  #typed = '';

  #x = 0;
  #y = 0;
  #dx = 0;
  #dy = 0;
  #wheel = 0;
  #bits = 0;
  #pointerId: number | undefined;
  readonly #buttons = new Set<MouseButton>();
  #pressed: MouseButton[] = [];
  #pressedOverUi = false;
  /** Buttons whose virtual-cursor press went into a scripted panel's frame (the frame decides). */
  #framePressed = 0;
  /** Buttons held in the presses a non-modal frame handed back under the virtual cursor. */
  #replayBits = 0;
  /** The pointer type of the last pointer event (follow mode draws a cursor only for a mouse). */
  #lastType = 'mouse';

  #wantLock = false;
  /** A lock the host asked for (`lock()`): asked, then held once granted, off after it is released. */
  #hostLock: 'off' | 'asked' | 'held' = 'off';
  #suspended = false;
  readonly #padHeld = new Map<number, ReadonlySet<GamepadButton>>();
  readonly #reportedPads = new Set<string>();

  constructor(options: BrowserInputOptions) {
    this.#stage = options.stage;
    this.#ui = options.ui;
    const ui = options.ui as HTMLElement | undefined;
    this.#cursor = ui !== undefined && typeof ui.ownerDocument?.createElement === 'function' && typeof ui.getBoundingClientRect === 'function'
      ? virtualCursorFor(ui) : undefined;
    this.#text = options.textInput;
    this.#touch = options.touch;
    this.#host = options.host ?? defaultHost();
    this.#onProblem = options.onProblem ?? (() => {});
    this.#screenScale = options.screenScale ?? (() => 1);

    this.#listen(this.#host.window, 'keydown', (e) => this.#keyDown(e as KeyboardEvent));
    this.#listen(this.#host.window, 'keyup', (e) => this.#keyUp(e as KeyboardEvent));
    this.#listen(this.#host.window, 'blur', () => this.#releaseAll());
    this.#listen(this.#stage, 'pointerdown', (e) => this.#pointer(e as PointerEvent, true));
    this.#listen(this.#stage, 'pointermove', (e) => this.#pointer(e as PointerEvent, false));
    this.#listen(this.#stage, 'pointerup', (e) => this.#pointer(e as PointerEvent, false));
    this.#listen(this.#stage, 'pointercancel', (e) => this.#pointerCancel(e as PointerEvent));
    this.#listen(this.#stage, 'wheel', (e) => this.#wheelEvent(e as WheelEvent), { passive: false });
    this.#listen(this.#stage, 'contextmenu', (e) => e.preventDefault());
    if (this.#text !== undefined) this.#listen(this.#text, 'input', (e) => this.#textInput(e as InputEvent));
  }

  poll(): InputSnapshot {
    if (this.#suspended) return this.#idle();
    const snapshot: InputSnapshot = {
      keys: new Set(this.#keys),
      keysPressed: this.#keysPressed,
      gamepads: this.#pollPads(),
      pointer: {
        ...this.#screen(),
        dx: this.#dx,
        dy: this.#dy,
        buttons: new Set(this.#buttons),
        pressed: this.#pressed,
        wheel: this.#wheel,
        pressedOverUi: this.#pressedOverUi,
      },
      touch: this.#touch?.poll() ?? NO_TOUCH,
      text: this.#typed,
    };
    this.#keysPressed = [];
    this.#typed = '';
    this.#dx = 0;
    this.#dy = 0;
    this.#wheel = 0;
    this.#pressed = [];
    this.#pressedOverUi = false;
    return snapshot;
  }

  present(output: InputOutput): void {
    if (this.#suspended) {
      this.#touch?.present([], output.touchSkin);
      return;
    }
    this.#wantLock = output.cursor === 'locked';
    const doc = this.#host.document;
    const locked = doc.pointerLockElement === this.#stage;
    if (this.#hostLock === 'asked' && locked) this.#hostLock = 'held';
    else if (this.#hostLock === 'held' && !locked) this.#hostLock = 'off'; // Escape (or the page) let it go
    // A menu over mouse-look keeps the lock and draws the virtual cursor (unless the game's
    // cursor is the OS one); so does any free cursor under a lock the host took.
    const keep = output.virtualCursor === true || this.#hostLock !== 'off';
    const virtual = output.cursor === 'free' && keep && this.#cursor !== undefined && this.#cursor.look.visual !== 'system';
    // Locking needs a user gesture: it is requested on the next press (see #pointer).
    if (!this.#wantLock && locked && !virtual) doc.exitPointerLock();
    this.#cursor?.setMode(virtual && locked ? 'virtual' : output.cursor === 'free' && !locked && this.#lastType === 'mouse' ? 'follow' : 'off');
    if (this.#cursor?.mode === 'virtual') ({ x: this.#x, y: this.#y } = this.#cursor.position);

    if (this.#text !== undefined) {
      const focused = doc.activeElement === this.#text;
      if (output.textEntry && !focused) this.#text.focus({ preventScroll: true });
      else if (!output.textEntry && focused) this.#text.blur();
    }

    for (const rumble of output.rumble) {
      if (rumble.pattern !== undefined) this.#rumblePattern(rumble.pad, rumble.pattern);
      else this.#rumble(rumble.pad, rumble.strength, rumble.seconds);
    }
    this.#touch?.present(output.touch, output.touchSkin);
  }

  /**
   * Lock the pointer to the stage now, and hold it through scenes without mouse-look (the
   * virtual cursor is drawn wherever the cursor is free) until it is released. Browsers lock
   * only during a user gesture, so call this from one (a click or key handler); a refusal is
   * ignored (a later press on the stage asks again while the game wants mouse-look).
   */
  lock(): void {
    if (this.#suspended) return;
    this.#hostLock = this.#host.document.pointerLockElement === this.#stage ? 'held' : 'asked';
    if (this.#hostLock === 'held') return;
    try {
      const done = this.#stage.requestPointerLock() as unknown;
      if (done instanceof Promise) done.catch(() => { /* refused: no gesture, or the page lost focus */ });
    } catch {
      // No pointer lock here (an embedded frame without the permission).
    }
  }

  /** Whether the devices are suspended (`setSuspended`). */
  get suspended(): boolean {
    return this.#suspended;
  }

  /**
   * Suspend the devices while the host shows something else in the game's place: the game
   * reads no keys, pointer, pads or touch controls (nothing stays held), the page gets its
   * keys back uncancelled, the pointer lock is let go and the drawn cursor is hidden.
   */
  setSuspended(suspended: boolean): void {
    if (suspended === this.#suspended) return;
    this.#suspended = suspended;
    this.#releaseAll();
    this.#keysPressed = [];
    this.#typed = '';
    this.#pressed = [];
    this.#pressedOverUi = false;
    this.#dx = 0;
    this.#dy = 0;
    this.#wheel = 0;
    if (!suspended) return;
    this.#hostLock = 'off';
    this.#cursor?.setMode('off');
    const doc = this.#host.document;
    if (doc.pointerLockElement === this.#stage) doc.exitPointerLock();
    if (this.#text !== undefined && doc.activeElement === this.#text) this.#text.blur();
  }

  /** The pointer in screen pixels (it is kept in CSS pixels: the cursor's and the events' units). */
  #screen(): { x: number; y: number } {
    const k = this.#screenScale();
    const scale = Number.isFinite(k) && k > 0 ? k : 1;
    return { x: this.#x * scale, y: this.#y * scale };
  }

  /** What a suspended adapter reports: nothing held or pressed, the pointer where it was. */
  #idle(): InputSnapshot {
    return {
      keys: new Set(),
      keysPressed: [],
      gamepads: [],
      pointer: { ...this.#screen(), dx: 0, dy: 0, buttons: new Set(), pressed: [], wheel: 0, pressedOverUi: false },
      touch: NO_TOUCH,
      text: '',
    };
  }

  /** Remove every listener. */
  dispose(): void {
    for (const fn of this.#dispose.splice(0)) fn();
    this.#cursor?.dispose();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  #keyDown(e: KeyboardEvent): void {
    if (this.#suspended) return;
    if (isEditable(e.target) && e.target !== this.#text) return;
    // A cancelled keydown never types: on the focused text field only Tab (which would move
    // focus off it) is cancelled, so the field still gets its `input` events.
    const onField = this.#text !== undefined && e.target === this.#text;
    const cancel = onField ? e.code === 'Tab' : !e.ctrlKey && !e.metaKey && !e.altKey && !PASS_THROUGH.test(e.code);
    if (cancel) e.preventDefault();
    this.#keys.add(e.code);
    if (!e.repeat) this.#keysPressed.push(e.code);
    // Typed text comes from the text field's own input events while it has focus.
    if (e.target !== this.#text && printable(e.key) && !e.ctrlKey && !e.metaKey) this.#typed += e.key;
  }

  #keyUp(e: KeyboardEvent): void {
    this.#keys.delete(e.code);
  }

  #textInput(e: InputEvent): void {
    if (typeof e.data === 'string') this.#typed += e.data;
    if (this.#text !== undefined) this.#text.value = '';
  }

  /** Focus left the page: nothing stays held (a key released elsewhere never reports). */
  #releaseAll(): void {
    this.#keys.clear();
    this.#buttons.clear();
    this.#bits = 0;
    this.#framePressed = 0;
    this.#replayBits = 0;
    this.#pointerId = undefined;
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────

  #pointer(e: PointerEvent, down: boolean): void {
    if (this.#suspended) return;
    // The virtual cursor's own presses bubbling back up through the stage.
    if (this.#cursor?.dispatching === true) return;
    this.#lastType = e.pointerType;
    // One finger is the pointer: the first to land while none is (a finger on a touch
    // control never arrives here, so a tap beside a held joystick still moves the pointer).
    if (e.pointerType !== 'mouse') {
      if (down && this.#pointerId !== undefined && e.pointerId !== this.#pointerId) return;
      if (!down && e.pointerId !== this.#pointerId) return;
    }
    if (down) this.#pointerId = e.pointerId;

    const locked = this.#host.document.pointerLockElement === this.#stage;
    const rect = this.#stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const virtual = locked && this.#cursor?.mode === 'virtual';
    // Under the virtual cursor, a non-modal scripted panel hands a press off its controls back
    // (replayed on the panels layer itself): that is the game's press, at the cursor.
    if (virtual && this.#ui !== undefined && e.target === this.#ui) {
      this.#replay(e.buttons);
      return;
    }
    if (locked) {
      this.#dx += e.movementX;
      this.#dy += e.movementY;
      if (virtual && (e.movementX !== 0 || e.movementY !== 0)) {
        this.#cursor!.move(e.movementX, e.movementY, e.buttons);
        this.#x = this.#cursor!.position.x;
        this.#y = this.#cursor!.position.y;
      }
    } else {
      this.#cursor?.follow(x, y);
      this.#dx += x - this.#x;
      this.#dy += y - this.#y;
      this.#x = x;
      this.#y = y;
    }

    const bits = e.buttons;
    for (const [bit, button] of MOUSE_BITS) {
      const now = (bits & bit) !== 0;
      const before = (this.#bits & bit) !== 0;
      const index = button === 'left' ? 0 : button === 'middle' ? 1 : 2;
      if (now && !before) {
        const hit = virtual ? this.#cursor!.button(true, index, bits) : 'none';
        if (hit === 'frame') {
          // The frame answers: its control's action, or the press handed back (#replay).
          this.#framePressed |= bit;
          continue;
        }
        this.#buttons.add(button);
        this.#pressed.push(button);
        this.#pressedOverUi = virtual
          ? hit === 'panel'
          : this.#ui !== undefined && e.target !== this.#ui && this.#ui.contains(e.target as Node);
      } else if (!now && before) {
        if ((this.#framePressed & bit) === 0) this.#buttons.delete(button);
        this.#framePressed &= ~bit;
        if (virtual) this.#cursor!.button(false, index, bits);
      }
    }
    this.#bits = bits;
    if (bits === 0 && e.type === 'pointerup') this.#pointerId = undefined;

    if (down && this.#wantLock && !locked && !this.#pressedOverUi) this.#stage.requestPointerLock();
  }

  /** A frame's handed-back press under the virtual cursor: press edges at the cursor, not over the UI. */
  #replay(bits: number): void {
    for (const [bit, button] of MOUSE_BITS) {
      const now = (bits & bit) !== 0;
      const before = (this.#replayBits & bit) !== 0;
      if (now && !before) {
        this.#buttons.add(button);
        this.#pressed.push(button);
        this.#pressedOverUi = false;
      } else if (!now && before) {
        this.#buttons.delete(button);
      }
    }
    this.#replayBits = bits;
  }

  #pointerCancel(e: PointerEvent): void {
    if (e.pointerId !== this.#pointerId) return;
    this.#buttons.clear();
    this.#bits = 0;
    this.#framePressed = 0;
    this.#replayBits = 0;
    this.#pointerId = undefined;
  }

  #wheelEvent(e: WheelEvent): void {
    if (this.#suspended) return;
    e.preventDefault();
    // Notches: deltaMode 0 = pixels (~100 per notch), 1 = lines (~3 per notch), 2 = pages.
    const unit = e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1;
    this.#wheel += -e.deltaY / unit;
    if (this.#cursor?.mode === 'virtual') this.#cursor.wheel(e.deltaY * (e.deltaMode === 0 ? 1 : e.deltaMode === 1 ? 16 : 400));
  }

  // ── Gamepads ────────────────────────────────────────────────────────────────

  #pollPads(): (GamepadSnapshot | null)[] {
    const pads = this.#host.navigator.getGamepads?.() ?? [];
    const out: (GamepadSnapshot | null)[] = [];
    for (let slot = 0; slot < pads.length; slot++) {
      const pad = pads[slot] ?? null;
      if (pad === null || !pad.connected) {
        this.#padHeld.delete(slot);
        out.push(null);
        continue;
      }
      if (pad.mapping !== 'standard') {
        if (!this.#reportedPads.has(pad.id)) {
          this.#reportedPads.add(pad.id);
          this.#onProblem(diagnostic('PP9521', `Gamepad "${pad.id}" has no standard button layout and is ignored`, {
            severity: 'warning',
            fix: 'Use a controller the browser maps to the standard layout (most Xbox, PlayStation and Switch Pro pads).',
          }));
        }
        out.push(null);
        continue;
      }
      out.push(this.#padSnapshot(slot, pad));
    }
    return out;
  }

  #padSnapshot(slot: number, pad: Gamepad): GamepadSnapshot {
    const buttons = new Set<GamepadButton>();
    STANDARD_BUTTONS.forEach((name, i) => {
      if (name !== null && pad.buttons[i]?.pressed === true) buttons.add(name);
    });
    const before = this.#padHeld.get(slot) ?? new Set<GamepadButton>();
    this.#padHeld.set(slot, buttons);
    const axis = (i: number): number => pad.axes[i] ?? 0;
    return {
      buttons,
      pressed: [...buttons].filter((b) => !before.has(b)),
      axes: {
        leftX: axis(0),
        leftY: -axis(1),
        rightX: axis(2),
        rightY: -axis(3),
        leftTrigger: pad.buttons[6]?.value ?? 0,
        rightTrigger: pad.buttons[7]?.value ?? 0,
      },
    };
  }

  #rumble(pad: number | null, strength: number, seconds: number): void {
    const effect = { duration: seconds * 1000, strongMagnitude: strength, weakMagnitude: strength };
    const pads = this.#host.navigator.getGamepads?.() ?? [];
    pads.forEach((p, slot) => {
      if (p === null || (pad !== null && slot !== pad)) return;
      p.vibrationActuator?.playEffect('dual-rumble', effect).catch((error: unknown) => this.#rumbleFailed(p.id, error));
    });
    if (pad === null) this.#host.navigator.vibrate?.(Math.round(seconds * 1000));
  }

  /**
   * Pulses in turn. Pads: one effect per pulse, started at its offset. The phone: the
   * Vibration API's on/off milliseconds (it has no strength: any pulse above 0 is on).
   */
  #rumblePattern(pad: number | null, pattern: readonly (readonly [number, number])[]): void {
    let at = 0;
    for (const [strength, seconds] of pattern) {
      if (strength > 0) {
        const start = at;
        if (start === 0) this.#rumbleGamepads(pad, strength, seconds);
        else setTimeout(() => this.#rumbleGamepads(pad, strength, seconds), start * 1000);
      }
      at += seconds;
    }
    if (pad === null) this.#host.navigator.vibrate?.(vibrationPattern(pattern));
  }

  #rumbleGamepads(pad: number | null, strength: number, seconds: number): void {
    const effect = { duration: seconds * 1000, strongMagnitude: strength, weakMagnitude: strength };
    const pads = this.#host.navigator.getGamepads?.() ?? [];
    pads.forEach((p, slot) => {
      if (p === null || (pad !== null && slot !== pad)) return;
      p.vibrationActuator?.playEffect('dual-rumble', effect).catch((error: unknown) => this.#rumbleFailed(p.id, error));
    });
  }

  #rumbleFailed(id: string, error: unknown): void {
    const key = `rumble:${id}`;
    if (this.#reportedPads.has(key)) return;
    this.#reportedPads.add(key);
    this.#onProblem(diagnostic('PP9522', `Gamepad "${id}" refused to rumble: ${(error as Error).message}`, {
      severity: 'warning',
      fix: 'Nothing to change in the game; this controller or browser has no rumble support.',
    }));
  }

  #listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    this.#dispose.push(() => target.removeEventListener(type, fn, options));
  }
}

/**
 * A rumble pattern as the Vibration API's alternating on/off milliseconds: runs of pulses
 * (strength > 0) and of pauses merge, and it always starts with an "on" entry (0 ms when the
 * pattern opens with a pause).
 */
export function vibrationPattern(pattern: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [strength, seconds] of pattern) {
    const on = strength > 0;
    const ms = Math.round(seconds * 1000);
    const wantOn = out.length % 2 === 0;
    if (out.length > 0 && on !== wantOn) out[out.length - 1]! += ms;
    else if (out.length === 0 && !on) out.push(0, ms);
    else out.push(ms);
  }
  return out;
}
