/**
 * The state behind the on-screen touch controls, without the DOM: which finger holds which
 * control, and what each control reads at a poll (core's `TouchControlSnapshot`). The DOM
 * adapter (`touch.ts`) decides what a finger landed on and forwards its movement here;
 * `touch.test.ts` drives this directly.
 *
 *   joystick    floating: the base centres where the finger lands; fixed: the base stays at
 *               its rest point. x/y = offset / radius, clamped to length 1, +y up
 *   steer       a joystick that reads x only (a steering wheel)
 *   stick_edge  held while its side's joystick is pushed past EDGE (pressed on crossing)
 *   button      held while any finger holds it; a `toggle` button latches on a tap instead;
 *               a disabled one swallows the finger (no press, no gesture)
 *   stepper     two halves: x = -1 / +1 while the minus / plus half is held
 *   dpad        four-way (diagonals when both offsets are large): analog x/y in -1, 0, 1, and
 *               each direction as a digital control (`dpad:up`)
 *   area        a finger on the play area (not on a control) feeds the gestures:
 *                 tap         released within TAP_MS, moved under TAP_PX
 *                 double_tap  a tap within DOUBLE_TAP_MS and DOUBLE_TAP_PX of the last one
 *                 long_press  held LONG_PRESS_MS without moving TAP_PX (pressed once, then held)
 *                 swipe       released within SWIPE_MS, moved at least SWIPE_PX: its dominant
 *                             direction (`swipe` analog: the unit vector on that poll; `swipe:dir`)
 *                 drag        pixels moved since the last poll (+y up), while held
 *                 look        the same, for fingers that land on the right half (when `look`
 *                             is in the layout; drag then reads the others)
 *                 pinch       two fingers (when pinch or scroll is listed): the change in their
 *                             spread, and scroll their mean vertical travel, in notches of
 *                             NOTCH_PX; those fingers feed no other gesture
 */

import type { TouchControlSnapshot, TouchControlSpec } from '../../core/index.js';

export const JOYSTICK_RADIUS = 56;
const TAP_MS = 300;
const TAP_PX = 12;
const SWIPE_MS = 700;
const SWIPE_PX = 40;
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 60;
export const LONG_PRESS_MS = 360;
/** A joystick pushed this far (of its radius) is at its rim: `stick_edge`. */
export const EDGE = 0.92;
/** Pinch / two-finger scroll pixels per wheel notch. */
export const NOTCH_PX = 40;

/** A finger, in stage pixels (y down) and milliseconds. */
export interface Finger {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

type Grab =
  | { readonly kind: 'joystick'; readonly control: string; readonly cx: number; readonly cy: number; readonly radius: number; readonly xOnly: boolean; x: number; y: number }
  | { readonly kind: 'button'; readonly control: string; readonly t: number }
  | { readonly kind: 'stepper'; readonly control: string; readonly half: -1 | 1 }
  | { readonly kind: 'dpad'; readonly cx: number; readonly cy: number; x: number; y: number }
  | { readonly kind: 'swallowed' }
  | {
    readonly kind: 'area'; readonly sx: number; readonly sy: number; readonly st: number; lx: number; ly: number;
    readonly look: boolean; moved: number; long: boolean; two: boolean;
  };

type Area = Extract<Grab, { kind: 'area' }>;

const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] } as const;
const AREA_SHAPES = new Set(['tap', 'swipe', 'drag', 'look', 'double_tap', 'long_press', 'pinch', 'scroll']);

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

export class TouchState {
  #specs: readonly TouchControlSpec[] = [];
  #byId = new Map<string, TouchControlSpec>();
  readonly #grabs = new Map<number, Grab>();
  #pressed = new Set<string>();
  #deltas = new Map<string, [number, number]>();
  #swipe: [number, number] | null = null;
  /** Toggle buttons latched on. */
  readonly #latched = new Set<string>();
  /** A toggle group's last pressed segment (when the game doesn't say which is selected). */
  readonly #chosen = new Map<string, string>();
  #lastTap: { t: number; x: number; y: number } | null = null;
  /** The two fingers of a pinch, and their spread / mean y at the last move. */
  #pair: { a: number; b: number; dist: number; my: number } | null = null;

  get specs(): readonly TouchControlSpec[] {
    return this.#specs;
  }

  /** The controls in play now; fingers on controls that left the layout (or were disabled) let go. */
  setLayout(specs: readonly TouchControlSpec[]): void {
    this.#specs = specs;
    this.#byId = new Map(specs.map((s) => [s.id, s]));
    for (const [id, grab] of this.#grabs) {
      if (grab.kind !== 'joystick' && grab.kind !== 'button' && grab.kind !== 'stepper') continue;
      const spec = this.#byId.get(grab.control);
      if (spec === undefined || spec.disabled === true) this.#grabs.delete(id);
    }
    for (const id of this.#latched) if (!this.has(id)) this.#latched.delete(id);
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  spec(id: string): TouchControlSpec | undefined {
    return this.#byId.get(id);
  }

  /** Whether the play area reads gestures (a gesture is in the layout). */
  get readsArea(): boolean {
    return this.#specs.some((s) => AREA_SHAPES.has(s.shape));
  }

  holding(id: number): boolean {
    return this.#grabs.has(id);
  }

  /**
   * A finger on a stick. Floating, the base centres on the finger; with `center` (a fixed
   * stick) it stays there and the finger's offset from it counts at once.
   */
  joystickDown(f: Finger, control: string, center?: { readonly x: number; readonly y: number }, radius = JOYSTICK_RADIUS): void {
    const xOnly = this.#byId.get(control)?.shape === 'steer';
    const grab: Grab = { kind: 'joystick', control, cx: center?.x ?? f.x, cy: center?.y ?? f.y, radius, xOnly, x: 0, y: 0 };
    this.#grabs.set(f.id, grab);
    this.#pressed.add(control);
    if (center !== undefined) this.move(f);
  }

  buttonDown(f: Finger, control: string): void {
    const spec = this.#byId.get(control);
    if (spec?.disabled === true) {
      this.#grabs.set(f.id, { kind: 'swallowed' });
      return;
    }
    this.#grabs.set(f.id, { kind: 'button', control, t: f.t });
    if (spec?.group !== undefined) this.#chosen.set(spec.group, control);
    if (spec?.toggle === true) {
      if (this.#latched.delete(control)) return;
      this.#latched.add(control);
    }
    this.#pressed.add(control);
  }

  /** A finger on a stepper's minus (-1) or plus (+1) half. */
  stepperDown(f: Finger, control: string, half: -1 | 1): void {
    if (this.#byId.get(control)?.disabled === true) {
      this.#grabs.set(f.id, { kind: 'swallowed' });
      return;
    }
    this.#grabs.set(f.id, { kind: 'stepper', control, half });
    this.#pressed.add(control);
  }

  /** A finger on the d-pad, whose centre is (cx, cy). */
  dpadDown(f: Finger, cx: number, cy: number): void {
    const grab: Grab = { kind: 'dpad', cx, cy, x: 0, y: 0 };
    this.#grabs.set(f.id, grab);
    this.#pressed.add('dpad');
    this.#aimDpad(grab, f);
  }

  /** A finger on the play area of a stage `width` pixels wide. */
  areaDown(f: Finger, width: number): void {
    const look = this.has('look') && f.x > width / 2;
    const grab: Area = { kind: 'area', sx: f.x, sy: f.y, st: f.t, lx: f.x, ly: f.y, look, moved: 0, long: false, two: false };
    if ((this.has('pinch') || this.has('scroll')) && this.#pair === null) {
      for (const [id, other] of this.#grabs) {
        if (other.kind !== 'area' || other.two) continue;
        other.two = true;
        grab.two = true;
        this.#pair = { a: id, b: f.id, dist: Math.hypot(f.x - other.lx, f.y - other.ly), my: (f.y + other.ly) / 2 };
        break;
      }
    }
    this.#grabs.set(f.id, grab);
    if (!grab.two) this.#pressed.add(look ? 'look' : 'drag');
  }

  move(f: Finger): void {
    const grab = this.#grabs.get(f.id);
    if (grab === undefined) return;
    switch (grab.kind) {
      case 'joystick': {
        let x = (f.x - grab.cx) / grab.radius;
        let y = grab.xOnly ? 0 : -(f.y - grab.cy) / grab.radius;
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len; }
        const was = Math.hypot(grab.x, grab.y);
        grab.x = x;
        grab.y = y;
        if (was < EDGE && Math.hypot(x, y) >= EDGE) this.#pressed.add(`${grab.control}:edge`);
        return;
      }
      case 'dpad':
        this.#aimDpad(grab, f);
        return;
      case 'area': {
        grab.moved = Math.max(grab.moved, Math.hypot(f.x - grab.sx, f.y - grab.sy));
        if (grab.two) {
          grab.lx = f.x;
          grab.ly = f.y;
          this.#movePair();
          return;
        }
        const key = grab.look ? 'look' : 'drag';
        const d = this.#deltas.get(key) ?? [0, 0];
        this.#deltas.set(key, [d[0] + (f.x - grab.lx), d[1] - (f.y - grab.ly)]);
        grab.lx = f.x;
        grab.ly = f.y;
        return;
      }
      default:
        return;
    }
  }

  #movePair(): void {
    const pair = this.#pair;
    if (pair === null) return;
    const a = this.#grabs.get(pair.a);
    const b = this.#grabs.get(pair.b);
    if (a?.kind !== 'area' || b?.kind !== 'area') return;
    const dist = Math.hypot(a.lx - b.lx, a.ly - b.ly);
    const my = (a.ly + b.ly) / 2;
    const add = (key: string, v: number): void => {
      const d = this.#deltas.get(key) ?? [0, 0];
      this.#deltas.set(key, [d[0] + v, d[1]]);
    };
    add('pinch', (dist - pair.dist) / NOTCH_PX);
    add('scroll', -(my - pair.my) / NOTCH_PX);
    pair.dist = dist;
    pair.my = my;
  }

  up(f: Finger): void {
    const grab = this.#grabs.get(f.id);
    if (grab === undefined) return;
    this.move(f);
    this.#release(f.id);
    if (grab.kind !== 'area' || grab.two || grab.long) return;
    const dx = f.x - grab.sx;
    const dy = f.y - grab.sy;
    const dist = Math.hypot(dx, dy);
    const ms = f.t - grab.st;
    if (ms <= TAP_MS && dist < TAP_PX) {
      this.#pressed.add('tap');
      const last = this.#lastTap;
      if (last !== null && f.t - last.t <= DOUBLE_TAP_MS && Math.hypot(f.x - last.x, f.y - last.y) < DOUBLE_TAP_PX) {
        this.#pressed.add('double_tap');
        this.#lastTap = null;
      } else {
        this.#lastTap = { t: f.t, x: f.x, y: f.y };
      }
    } else if (ms <= SWIPE_MS && dist >= SWIPE_PX) {
      const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      this.#swipe = [DIRS[dir][0], DIRS[dir][1]];
      this.#pressed.add('swipe');
      this.#pressed.add(`swipe:${dir}`);
    }
  }

  /** The browser took the finger away (a system gesture): it lets go without a tap or swipe. */
  cancel(id: number): void {
    this.#release(id);
  }

  #release(id: number): void {
    this.#grabs.delete(id);
    if (this.#pair !== null && (this.#pair.a === id || this.#pair.b === id)) this.#pair = null;
  }

  /** Where a held stick's knob and base are, for drawing: offsets -1..1, +y up. */
  knob(control: string): { readonly cx: number; readonly cy: number; readonly x: number; readonly y: number } | undefined {
    for (const grab of this.#grabs.values()) if (grab.kind === 'joystick' && grab.control === control) return grab;
    return undefined;
  }

  /** The d-pad's direction now (for drawing). */
  dpad(): readonly [number, number] {
    let x = 0;
    let y = 0;
    for (const grab of this.#grabs.values()) {
      if (grab.kind !== 'dpad') continue;
      x = grab.x;
      y = grab.y;
    }
    return [x, y];
  }

  /** A button is down: a finger on it, or latched (toggle). */
  buttonHeld(control: string): boolean {
    if (this.#latched.has(control)) return true;
    for (const grab of this.#grabs.values()) if (grab.kind === 'button' && grab.control === control) return true;
    return false;
  }

  /** A stepper's halves held now: -1, +1, or 0 (neither, or both). */
  stepper(control: string): -1 | 0 | 1 {
    let minus = false;
    let plus = false;
    for (const grab of this.#grabs.values()) {
      if (grab.kind !== 'stepper' || grab.control !== control) continue;
      if (grab.half < 0) minus = true;
      else plus = true;
    }
    return minus === plus ? 0 : minus ? -1 : 1;
  }

  /** 0..1 of a `hold=` button's hold (its spec's `holdMs`), at `now` (ms), or 0 when it isn't held. */
  holdProgress(control: string, now: number): number {
    const ms = this.#byId.get(control)?.holdMs;
    if (ms === undefined) return 0;
    for (const grab of this.#grabs.values()) {
      if (grab.kind === 'button' && grab.control === control) return Math.max(0, Math.min(1, (now - grab.t) / ms));
    }
    return 0;
  }

  /** Whether a button is drawn as selected: the game says, else a toggle group's last pressed segment. */
  selected(control: string): boolean {
    const spec = this.#byId.get(control);
    if (spec === undefined) return false;
    if (spec.selected !== undefined) return spec.selected;
    return spec.group !== undefined && this.#chosen.get(spec.group) === control;
  }

  #aimDpad(grab: Extract<Grab, { kind: 'dpad' }>, f: Finger): void {
    const dx = f.x - grab.cx;
    const dy = -(f.y - grab.cy);
    const len = Math.hypot(dx, dy);
    const wasX = grab.x;
    const wasY = grab.y;
    grab.x = len < 8 ? 0 : Math.abs(dx) > 0.38 * len ? sign(dx) : 0;
    grab.y = len < 8 ? 0 : Math.abs(dy) > 0.38 * len ? sign(dy) : 0;
    for (const [dir, [vx, vy]] of Object.entries(DIRS)) {
      const on = (vx !== 0 && grab.x === vx) || (vy !== 0 && grab.y === vy);
      const was = (vx !== 0 && wasX === vx) || (vy !== 0 && wasY === vy);
      if (on && !was) this.#pressed.add(`dpad:${dir}`);
    }
  }

  /** Long presses due by `now` (ms): fingers held still on the play area long enough. */
  #longPresses(now: number): void {
    for (const grab of this.#grabs.values()) {
      if (grab.kind !== 'area' || grab.two || grab.long || grab.moved >= TAP_PX || now - grab.st < LONG_PRESS_MS) continue;
      grab.long = true;
      this.#pressed.add('long_press');
    }
  }

  /** Every control in the layout, read since the last poll; `now` (ms, the events' clock) times long presses. */
  poll(now?: number): Map<string, TouchControlSnapshot> {
    if (now !== undefined) this.#longPresses(now);
    const out = new Map<string, TouchControlSnapshot>();
    const grabs = [...this.#grabs.values()];
    const [px, py] = this.dpad();
    const delta = (key: string): [number, number] => this.#deltas.get(key) ?? [0, 0];
    for (const spec of this.#specs) {
      const pressed = this.#pressed.has(spec.id);
      switch (spec.shape) {
        case 'joystick':
        case 'steer': {
          const grab = grabs.find((g) => g.kind === 'joystick' && g.control === spec.id) as Extract<Grab, { kind: 'joystick' }> | undefined;
          out.set(spec.id, { held: grab !== undefined, pressed, x: grab?.x ?? 0, y: grab?.y ?? 0 });
          break;
        }
        case 'stick_edge': {
          const stick = `joystick:${spec.side ?? 'left'}`;
          const grab = grabs.find((g) => g.kind === 'joystick' && g.control === stick) as Extract<Grab, { kind: 'joystick' }> | undefined;
          const held = grab !== undefined && Math.hypot(grab.x, grab.y) >= EDGE;
          out.set(spec.id, { held, pressed: this.#pressed.has(`${stick}:edge`), x: 0, y: 0 });
          break;
        }
        case 'button':
          out.set(spec.id, { held: this.buttonHeld(spec.id), pressed, x: 0, y: 0 });
          break;
        case 'stepper': {
          const x = this.stepper(spec.id);
          const held = grabs.some((g) => g.kind === 'stepper' && g.control === spec.id);
          out.set(spec.id, { held, pressed, x, y: 0 });
          break;
        }
        case 'dpad': {
          const held = grabs.some((g) => g.kind === 'dpad');
          if (spec.direction === undefined) {
            out.set(spec.id, { held, pressed, x: px, y: py });
          } else {
            const [vx, vy] = DIRS[spec.direction];
            const on = (vx !== 0 && px === vx) || (vy !== 0 && py === vy);
            out.set(spec.id, { held: on, pressed, x: 0, y: 0 });
          }
          break;
        }
        case 'drag':
        case 'look': {
          const held = grabs.some((g) => g.kind === 'area' && !g.two && g.look === (spec.shape === 'look'));
          const d = delta(spec.shape);
          out.set(spec.id, { held, pressed, x: d[0], y: d[1] });
          break;
        }
        case 'pinch':
        case 'scroll':
          out.set(spec.id, { held: this.#pair !== null, pressed: false, x: delta(spec.shape)[0], y: 0 });
          break;
        case 'long_press':
          out.set(spec.id, { held: grabs.some((g) => g.kind === 'area' && g.long), pressed, x: 0, y: 0 });
          break;
        case 'tap':
        case 'double_tap':
          out.set(spec.id, { held: false, pressed, x: 0, y: 0 });
          break;
        case 'swipe':
          out.set(spec.id, spec.direction === undefined
            ? { held: false, pressed, x: pressed ? this.#swipe?.[0] ?? 0 : 0, y: pressed ? this.#swipe?.[1] ?? 0 : 0 }
            : { held: false, pressed, x: 0, y: 0 });
          break;
      }
    }
    this.#pressed = new Set();
    this.#deltas = new Map();
    this.#swipe = null;
    return out;
  }
}
