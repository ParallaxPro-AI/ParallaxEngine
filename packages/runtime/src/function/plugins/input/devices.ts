/**
 * Device state: this frame's and last frame's snapshot, read per seat as digital
 * (held / pressed / released) or analog values, with dead zones applied. Edges count a
 * key that went down and up between two polls as pressed and released in the same frame.
 */

import { Vec2 } from '../../../core/index.js';
import type {
  GamepadButton, GamepadSnapshot, InputSnapshot, MouseButton, PointerSnapshot, TouchControlSnapshot,
} from '../../../core/index.js';
import { touchIsDelta } from './declarations.js';
import type { BindingPart, StickSide } from './declarations.js';

export interface Digital {
  readonly held: boolean;
  readonly pressed: boolean;
  readonly released: boolean;
}

export const UP: Digital = { held: false, pressed: false, released: false };

export function anyOf(states: Iterable<Digital>): Digital {
  let held = false;
  let pressed = false;
  let released = false;
  for (const s of states) {
    held ||= s.held;
    pressed ||= s.pressed;
    released ||= s.released;
  }
  return { held, pressed, released: released && !held };
}

/** Which devices a seat reads. */
export interface SeatDevices {
  readonly keyboard: boolean;
  readonly mouse: boolean;
  readonly touch: boolean;
  /** A pad slot, every pad ("any"), or none. */
  readonly gamepad: number | 'any' | null;
}

export interface DeadZones {
  /** Radial stick dead zone (default 0.2); the rest is rescaled to 0..1. */
  readonly stick: number;
  /** Trigger dead zone (default 0.1). */
  readonly trigger: number;
  /** A trigger counts as a pressed button above this (default 0.5). */
  readonly triggerPress: number;
}

export const DEFAULT_DEAD_ZONES: DeadZones = { stick: 0.2, trigger: 0.1, triggerPress: 0.5 };

const EMPTY_POINTER: PointerSnapshot = {
  x: 0, y: 0, dx: 0, dy: 0, buttons: new Set(), pressed: [], wheel: 0, pressedOverUi: false,
};

export const EMPTY_SNAPSHOT: InputSnapshot = {
  keys: new Set(), keysPressed: [], gamepads: [], pointer: EMPTY_POINTER, touch: new Map(), text: '',
};

const NO_TOUCH: TouchControlSnapshot = { held: false, pressed: false, x: 0, y: 0 };

/** Which part of the engine a mouse press belongs to until its release. */
export type Claim = 'ui' | 'world';

/** Filter on source keys (see `sourcesOf`); priority masking passes a narrower one. */
export type Allowed = (source: string) => boolean;
export const ALLOW_ALL: Allowed = () => true;

function edge(heldNow: boolean, heldBefore: boolean, wentDown: boolean): Digital {
  const pressed = wentDown || (heldNow && !heldBefore);
  return { held: heldNow, pressed, released: (heldBefore && !heldNow) || (pressed && !heldNow) };
}

function deadZone1(value: number, zone: number): number {
  const mag = Math.abs(value);
  if (mag <= zone) return 0;
  return Math.sign(value) * Math.min(1, (mag - zone) / (1 - zone));
}

function deadZoneStick(x: number, y: number, zone: number): Vec2 {
  const mag = Math.hypot(x, y);
  if (mag <= zone) return Vec2.ZERO;
  const scaled = Math.min(1, (mag - zone) / (1 - zone));
  return new Vec2((x / mag) * scaled, (y / mag) * scaled);
}

export class DeviceState {
  #now: InputSnapshot = EMPTY_SNAPSHOT;
  #before: InputSnapshot = EMPTY_SNAPSHOT;
  readonly #zones: DeadZones;
  readonly #claims = new Map<MouseButton, Claim>();

  constructor(zones: DeadZones) {
    this.#zones = zones;
  }

  get snapshot(): InputSnapshot {
    return this.#now;
  }

  update(next: InputSnapshot): void {
    this.#before = this.#now;
    this.#now = next;
    const pointer = next.pointer;
    for (const button of [...this.#claims.keys()]) {
      if (!pointer.buttons.has(button)) this.#claims.delete(button);
    }
    if (pointer.pressedOverUi) for (const button of pointer.pressed) this.#claims.set(button, 'ui');
  }

  /** Mark this frame's mouse presses as handled by the world (`pointer.consume()`). */
  claimPresses(claim: Claim): void {
    for (const button of this.#now.pointer.pressed) if (!this.#claims.has(button)) this.#claims.set(button, claim);
  }

  claimOf(button: MouseButton): Claim | undefined {
    return this.#claims.get(button);
  }

  // ── Raw sources ─────────────────────────────────────────────────────────────

  key(code: string): Digital {
    return edge(this.#now.keys.has(code), this.#before.keys.has(code), this.#now.keysPressed.includes(code));
  }

  #pads(seat: SeatDevices): number[] {
    if (seat.gamepad === null) return [];
    if (seat.gamepad === 'any') return this.#now.gamepads.map((_, i) => i);
    return [seat.gamepad];
  }

  #pad(snapshot: InputSnapshot, index: number): GamepadSnapshot | null {
    return snapshot.gamepads[index] ?? null;
  }

  padButton(seat: SeatDevices, button: GamepadButton): Digital {
    return anyOf(this.#pads(seat).map((i) => {
      const now = this.#pad(this.#now, i);
      const before = this.#pad(this.#before, i);
      return edge(now?.buttons.has(button) ?? false, before?.buttons.has(button) ?? false, now?.pressed.includes(button) ?? false);
    }));
  }

  padTrigger(seat: SeatDevices, side: StickSide): number {
    let best = 0;
    for (const i of this.#pads(seat)) {
      const axes = this.#pad(this.#now, i)?.axes;
      if (axes === undefined) continue;
      best = Math.max(best, deadZone1(side === 'left' ? axes.leftTrigger : axes.rightTrigger, this.#zones.trigger));
    }
    return best;
  }

  padTriggerDigital(seat: SeatDevices, side: StickSide): Digital {
    const threshold = this.#zones.triggerPress;
    return anyOf(this.#pads(seat).map((i) => {
      const read = (s: InputSnapshot): number => {
        const axes = this.#pad(s, i)?.axes;
        return axes === undefined ? 0 : side === 'left' ? axes.leftTrigger : axes.rightTrigger;
      };
      return edge(read(this.#now) > threshold, read(this.#before) > threshold, false);
    }));
  }

  /** The dead-zoned stick with the largest deflection across the seat's pads. */
  padStick(seat: SeatDevices, side: StickSide): Vec2 {
    let best = Vec2.ZERO;
    for (const i of this.#pads(seat)) {
      const axes = this.#pad(this.#now, i)?.axes;
      if (axes === undefined) continue;
      const v = side === 'left'
        ? deadZoneStick(axes.leftX, axes.leftY, this.#zones.stick)
        : deadZoneStick(axes.rightX, axes.rightY, this.#zones.stick);
      if (v.length() > best.length()) best = v;
    }
    return best;
  }

  mouseButton(button: MouseButton): Digital {
    const p = this.#now.pointer;
    return edge(p.buttons.has(button), this.#before.pointer.buttons.has(button), p.pressed.includes(button));
  }

  touch(id: string): TouchControlSnapshot {
    return this.#now.touch.get(id) ?? NO_TOUCH;
  }

  touchDigital(id: string): Digital {
    const now = this.touch(id);
    const before = this.#before.touch.get(id) ?? NO_TOUCH;
    return edge(now.held, before.held, now.pressed);
  }

  // ── Parts ───────────────────────────────────────────────────────────────────

  /** A digital reading of a part; analog-only parts (sticks, deltas) read as up. */
  digital(part: BindingPart, seat: SeatDevices, allowed: Allowed): Digital {
    switch (part.kind) {
      case 'keys':
        return seat.keyboard ? anyOf(part.codes.filter((c) => allowed(`key:${c}`)).map((c) => this.key(c))) : UP;
      case 'pad_button':
        return allowed(`pad:${part.button}`) ? this.padButton(seat, part.button) : UP;
      case 'pad_trigger':
        return allowed(`pad:trigger_${part.trigger}`) ? this.padTriggerDigital(seat, part.trigger) : UP;
      case 'mouse_button':
        if (!seat.mouse || !allowed(`mouse:${part.button}`) || this.#claims.has(part.button)) return UP;
        return this.mouseButton(part.button);
      case 'mouse_wheel': {
        if (!seat.mouse || !allowed('mouse:wheel') || this.#now.pointer.wheel === 0) return UP;
        return { held: false, pressed: true, released: true };
      }
      case 'touch':
        if (!seat.touch || !allowed(`touch:${part.control.id}`)) return UP;
        return part.control.analog ? UP : this.touchDigital(part.control.id);
      default:
        return UP;
    }
  }

  /** A 1D value: keys/buttons 0..1, stick axes -1..1, triggers 0..1, wheel notches, a 2D touch control's x. */
  value(part: BindingPart, seat: SeatDevices, allowed: Allowed): number {
    switch (part.kind) {
      case 'pad_axis': {
        if (!allowed(`pad:stick_${part.axis.startsWith('left') ? 'left' : 'right'}`)) return 0;
        const v = this.padStick(seat, part.axis.startsWith('left') ? 'left' : 'right');
        return part.axis.endsWith('_x') ? v.x : v.y;
      }
      case 'pad_trigger':
        return allowed(`pad:trigger_${part.trigger}`) ? this.padTrigger(seat, part.trigger) : 0;
      case 'mouse_wheel':
        return seat.mouse && allowed('mouse:wheel') ? this.#now.pointer.wheel : 0;
      case 'touch':
        if (!seat.touch || !allowed(`touch:${part.control.id}`)) return 0;
        return part.control.analog ? this.touch(part.control.id).x : (this.touchDigital(part.control.id).held ? 1 : 0);
      default:
        return this.digital(part, seat, allowed).held ? 1 : 0;
    }
  }

  /** A 2D reading. `bounded` is false for deltas (mouse, drag, look), which aren't clamped. */
  vector(part: BindingPart, seat: SeatDevices, allowed: Allowed, latched = false): { readonly v: Vec2; readonly bounded: boolean } {
    // `latched`: a key or button that went down this frame counts even if already up (a tap).
    const held = (codes: readonly string[]): boolean => seat.keyboard && codes.some((c) =>
      allowed(`key:${c}`) && (this.#now.keys.has(c) || (latched && this.#now.keysPressed.includes(c))));
    const axis = (neg: boolean, pos: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0);
    switch (part.kind) {
      case 'composite': {
        const v = new Vec2(axis(held(part.left), held(part.right)), axis(held(part.down), held(part.up)));
        return { v: v.length() > 1 ? v.normalized() : v, bounded: true };
      }
      case 'key_axis': {
        const n = axis(held(part.negative), held(part.positive));
        return { v: part.axis === 'x' ? new Vec2(n, 0) : new Vec2(0, n), bounded: true };
      }
      case 'pad_stick':
        return { v: allowed(`pad:stick_${part.stick}`) ? this.padStick(seat, part.stick) : Vec2.ZERO, bounded: true };
      case 'pad_dpad': {
        const d = (b: GamepadButton): boolean => {
          if (!allowed(`pad:${b}`)) return false;
          const e = this.padButton(seat, b);
          return e.held || (latched && e.pressed);
        };
        const v = new Vec2(axis(d('dpad_left'), d('dpad_right')), axis(d('dpad_down'), d('dpad_up')));
        return { v: v.length() > 1 ? v.normalized() : v, bounded: true };
      }
      case 'mouse_delta': {
        const p = this.#now.pointer;
        return { v: seat.mouse && allowed('mouse:delta') ? new Vec2(p.dx, -p.dy) : Vec2.ZERO, bounded: false };
      }
      case 'touch': {
        if (!seat.touch || !allowed(`touch:${part.control.id}`)) return { v: Vec2.ZERO, bounded: true };
        const c = part.control;
        const s = this.touch(c.id);
        const delta = touchIsDelta(c.shape);
        if (c.analog) return { v: new Vec2(s.x, s.y), bounded: !delta };
        return { v: Vec2.ZERO, bounded: true };
      }
      default:
        return { v: Vec2.ZERO, bounded: true };
    }
  }

  /** The device a seat used most recently this frame, if any. */
  activity(seat: SeatDevices): 'keyboard' | 'gamepad' | 'touch' | undefined {
    const s = this.#now;
    for (const t of s.touch.values()) if (t.held || t.pressed) if (seat.touch) return 'touch';
    for (const i of this.#pads(seat)) {
      const pad = this.#pad(s, i);
      if (pad === null) continue;
      if (pad.pressed.length > 0 || pad.buttons.size > 0) return 'gamepad';
      if (Math.hypot(pad.axes.leftX, pad.axes.leftY) > 0.5 || Math.hypot(pad.axes.rightX, pad.axes.rightY) > 0.5) return 'gamepad';
    }
    if (seat.keyboard && (s.keysPressed.length > 0 || s.keys.size > 0)) return 'keyboard';
    if (seat.mouse && s.pointer.pressed.length > 0) return 'keyboard';
    return undefined;
  }
}
