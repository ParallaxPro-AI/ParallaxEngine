/**
 * Turning bindings into action values, and the per-frame trackers that need history:
 * edges, `repeat`, and `pressed_direction` (one per flick, with hysteresis so a stick
 * resting near the threshold doesn't chatter).
 */

import { Vec2 } from '../../../core/index.js';
import { touchIsDelta } from './declarations.js';
import type { ActionDecl, Axis1Decl, Axis2Decl, Binding, ButtonDecl, GroupDecl } from './declarations.js';
import { anyOf, UP } from './devices.js';
import type { Allowed, DeviceState, Digital, SeatDevices } from './devices.js';

/** Input injected straight into one action (the test harness's `press`, `hold`, `move`). */
export interface VirtualInput {
  held: boolean;
  /** A press is pending for the next frame (a tap leaves `held` false). */
  wentDown: boolean;
  /** Real time at which the hold / value ends; null = until released. */
  until: number | null;
  value: number;
  vec: Vec2;
  slot: number | null;
  /** `held` as the previous frame saw it (injection between frames must not move it). */
  heldLast: boolean;
  // Per-frame, set by `beginFrame`.
  pressedNow: boolean;
  heldBefore: boolean;
}

export function newVirtual(): VirtualInput {
  return {
    held: false, wentDown: false, until: null, value: 0, vec: Vec2.ZERO, slot: null, heldLast: false, pressedNow: false,
    heldBefore: false,
  };
}

/**
 * Start a frame: the edges compare this frame's `held` with the last frame's, so a hold or
 * release injected between frames shows as pressed / released on the next one.
 */
export function beginFrame(v: VirtualInput, realNow: number): void {
  v.heldBefore = v.heldLast;
  if (v.until !== null && realNow > v.until + 1e-9) {
    v.held = false;
    v.value = 0;
    v.vec = Vec2.ZERO;
    v.until = null;
  }
  v.pressedNow = v.wentDown;
  v.wentDown = false;
  v.heldLast = v.held;
}

function virtualDigital(v: VirtualInput | undefined, slot: number | null = null): Digital {
  if (v === undefined || v.slot !== slot) return UP;
  const pressed = v.pressedNow || (v.held && !v.heldBefore);
  return { held: v.held, pressed, released: (v.heldBefore && !v.held) || (pressed && !v.held) };
}

export interface Source {
  readonly devices: DeviceState;
  readonly seat: SeatDevices;
  readonly allowed: Allowed;
  readonly virtual: VirtualInput | undefined;
  /**
   * Count a key or button that went down this frame as held even when it is already up
   * again (a tap between two frames): what direction edges read, so a tap still steps.
   */
  readonly latched?: boolean;
}

/** The source as direction edges read it: this frame's taps count as held. */
export function latched(s: Source): Source {
  return s.latched === true ? s : { ...s, latched: true };
}

function bindingDigital(bindings: Binding, s: Source): Digital {
  return anyOf(bindings.map((part) => s.devices.digital(part, s.seat, s.allowed)));
}

export function buttonNow(decl: ButtonDecl, s: Source): Digital {
  return anyOf([bindingDigital(decl.bindings, s), virtualDigital(s.virtual)]);
}

export function slotNow(decl: GroupDecl, index: number, s: Source): Digital {
  return anyOf([bindingDigital(decl.slots[index]!.bindings, s), virtualDigital(s.virtual, index)]);
}

const clamp1 = (n: number): number => Math.max(-1, Math.min(1, n));

export function axis1Now(decl: Axis1Decl, s: Source): number {
  const keys = (codes: readonly string[]): number => {
    if (codes.length === 0) return 0;
    const d = s.devices.digital({ kind: 'keys', codes }, s.seat, s.allowed);
    return d.held || (s.latched === true && d.pressed) ? 1 : 0;
  };
  let bounded = keys(decl.positive) - keys(decl.negative);
  if (decl.gamepad.length === 2) {
    bounded += Math.abs(s.devices.value(decl.gamepad[1]!, s.seat, s.allowed))
      - Math.abs(s.devices.value(decl.gamepad[0]!, s.seat, s.allowed));
  } else {
    for (const part of decl.gamepad) bounded += s.devices.value(part, s.seat, s.allowed);
  }
  let unbounded = 0;
  // Two digital touch controls are a pair, like two gamepad parts: the first reads -1, the second +1.
  const pair = decl.other.filter((p) => p.kind === 'touch' && !p.control.analog);
  for (const part of decl.other) {
    const v = s.devices.value(part, s.seat, s.allowed);
    if (part.kind === 'mouse_wheel' || (part.kind === 'touch' && touchIsDelta(part.control.shape))) unbounded += v;
    else if (pair.length === 2 && part === pair[0]) bounded -= v;
    else bounded += v;
  }
  return clamp1(bounded + (s.virtual?.value ?? 0)) + unbounded;
}

export function axis2Now(decl: Axis2Decl, s: Source): Vec2 {
  let bounded = Vec2.ZERO;
  let unbounded = Vec2.ZERO;
  for (const part of decl.bindings) {
    const { v, bounded: isBounded } = s.devices.vector(part, s.seat, s.allowed, s.latched === true);
    if (isBounded) bounded = bounded.__add__(v);
    else unbounded = unbounded.__add__(v);
  }
  if (s.virtual !== undefined) bounded = bounded.__add__(s.virtual.vec);
  if (bounded.length() > 1) bounded = bounded.normalized();
  return bounded.__add__(unbounded);
}

// ── Trackers ─────────────────────────────────────────────────────────────────

const ENTER = 0.5;
const STAY = 0.3;
const EPS = 1e-9;

export interface ButtonTracker {
  readonly kind: 'button';
  held: boolean;
  pressed: boolean;
  repeated: boolean;
  released: boolean;
  heldFor: number;
  nextRepeat: number;
}

export interface Axis1Tracker {
  readonly kind: 'axis1';
  dir: -1 | 0 | 1;
  dirPressed: -1 | 1 | null;
}

export interface Axis2Tracker {
  readonly kind: 'axis2';
  dir: Vec2 | null;
  dirPressed: Vec2 | null;
  heldFor: number;
  nextRepeat: number;
}

export interface GroupTracker {
  readonly kind: 'group';
  slots: Digital[];
}

export type Tracker = ButtonTracker | Axis1Tracker | Axis2Tracker | GroupTracker;

export function newTracker(decl: ActionDecl): Tracker {
  switch (decl.kind) {
    case 'button':
      return { kind: 'button', held: false, pressed: false, repeated: false, released: false, heldFor: 0, nextRepeat: 0 };
    case 'axis1':
      return { kind: 'axis1', dir: 0, dirPressed: null };
    case 'axis2':
      return { kind: 'axis2', dir: null, dirPressed: null, heldFor: 0, nextRepeat: 0 };
    case 'group':
      return { kind: 'group', slots: decl.slots.map(() => UP) };
  }
}

/** Advance a repeat clock; true when it fires this frame. */
function repeatFires(t: { heldFor: number; nextRepeat: number }, interval: number, dt: number): boolean {
  t.heldFor += dt;
  if (t.heldFor + EPS < t.nextRepeat) return false;
  while (t.nextRepeat <= t.heldFor + EPS) t.nextRepeat += interval;
  return true;
}

/** The 4-way direction a vector points in, keeping `prev` while it's still pushed that way. */
export function quantize(v: Vec2, prev: Vec2 | null): Vec2 | null {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  if (Math.max(ax, ay) >= ENTER) {
    if (ax === ay && prev !== null && v.dot(prev) >= ENTER) return prev;
    return ax >= ay ? (v.x > 0 ? Vec2.RIGHT : Vec2.LEFT) : (v.y > 0 ? Vec2.UP : Vec2.DOWN);
  }
  if (prev !== null && v.dot(prev) > STAY) return prev;
  return null;
}

function sign1(v: number, prev: -1 | 0 | 1): -1 | 0 | 1 {
  if (Math.abs(v) >= ENTER) return v > 0 ? 1 : -1;
  if (prev !== 0 && v * prev > STAY) return prev;
  return 0;
}

export function advance(decl: ActionDecl, t: Tracker, s: Source, dt: number): void {
  if (decl.kind === 'button' && t.kind === 'button') {
    const now = buttonNow(decl, s);
    const pressed = now.pressed && !t.held;
    t.released = t.held ? !now.held : now.released;
    t.pressed = pressed;
    t.repeated = false;
    if (pressed) {
      t.heldFor = 0;
      t.nextRepeat = decl.repeat?.[0] ?? 0;
    } else if (now.held && t.held && decl.repeat !== undefined) {
      t.repeated = repeatFires(t, decl.repeat[1], dt);
    }
    t.held = now.held;
  } else if (decl.kind === 'axis1' && t.kind === 'axis1') {
    const dir = sign1(axis1Now(decl, latched(s)), t.dir);
    t.dirPressed = dir !== 0 && dir !== t.dir ? dir : null;
    t.dir = dir;
  } else if (decl.kind === 'axis2' && t.kind === 'axis2') {
    const dir = quantize(axis2Now(decl, latched(s)), t.dir);
    t.dirPressed = null;
    if (dir !== null && (t.dir === null || !dir.__eq__(t.dir))) {
      t.dirPressed = dir;
      t.heldFor = 0;
      t.nextRepeat = decl.repeat?.[0] ?? 0;
    } else if (dir !== null && decl.repeat !== undefined && repeatFires(t, decl.repeat[1], dt)) {
      t.dirPressed = dir;
    }
    t.dir = dir;
  } else if (decl.kind === 'group' && t.kind === 'group') {
    t.slots = decl.slots.map((_, i) => {
      const now = slotNow(decl, i, s);
      const before = t.slots[i]!;
      const pressed = now.pressed && !before.held;
      return { held: now.held, pressed, released: before.held ? !now.held : now.released };
    });
  }
}
