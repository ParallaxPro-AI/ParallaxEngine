import { bindArgs } from '../kwargs.js';
import { fail } from '../diagnostics.js';
import { hashNumbers } from '../hash.js';
import { deg, rad } from './angles.js';
import { NotImplemented } from './not_implemented.js';
import { Vec3 } from './vec3.js';

/**
 * Immutable 2D vector. Methods use the SDK's Python names, and the dunder methods are what
 * compiled `a + b`, `v * 2`, `a == b` call.
 */
export class Vec2 {
  static readonly ZERO = new Vec2(0, 0);
  static readonly ONE = new Vec2(1, 1);
  static readonly UP = new Vec2(0, 1);
  static readonly DOWN = new Vec2(0, -1);
  static readonly LEFT = new Vec2(-1, 0);
  static readonly RIGHT = new Vec2(1, 0);

  readonly #x: number;
  readonly #y: number;

  constructor(x = 0, y = 0) {
    this.#x = x;
    this.#y = y;
  }

  get x(): number { return this.#x; }
  set x(_value: number) { immutable('x'); }
  get y(): number { return this.#y; }
  set y(_value: number) { immutable('y'); }

  /** `Vec2.from_angle(degrees, length=1)` (Python arguments: see core/kwargs.ts). */
  static from_angle(...args: unknown[]): Vec2 {
    const a = bindArgs('from_angle', args, { positional: ['degrees', 'length'], required: ['degrees'] }).args;
    const degrees = a['degrees'] as number;
    const length = (a['length'] ?? 1) as number;
    const r = rad(degrees);
    return new Vec2(Math.cos(r) * length, Math.sin(r) * length);
  }

  // Another operand type is NotImplemented: Python then tries its reflected method (a Vec3
  // adds a Vec2 as (x, y, 0), giving a Vec3) or raises its TypeError.
  __add__(o: Vec2): Vec2 { return o instanceof Vec2 ? new Vec2(this.#x + o.#x, this.#y + o.#y) : NOT_A_VEC2; }
  __sub__(o: Vec2): Vec2 { return o instanceof Vec2 ? new Vec2(this.#x - o.#x, this.#y - o.#y) : NOT_A_VEC2; }
  __mul__(s: number): Vec2 { return isScalar(s) ? new Vec2(this.#x * +s, this.#y * +s) : NOT_A_VEC2; }
  __rmul__(s: number): Vec2 { return this.__mul__(s); }
  __neg__(): Vec2 { return new Vec2(-this.#x, -this.#y); }

  __truediv__(s: number): Vec2 {
    if (!isScalar(s)) return NOT_A_VEC2;
    if (+s === 0) fail('PP3021', 'Vector divided by zero', { fix: 'Check the divisor before dividing.' });
    return new Vec2(this.#x / +s, this.#y / +s);
  }

  /** Exact component equality, like Python `==`. Use `is_close` for float tolerance. */
  __eq__(o: unknown): boolean {
    return o instanceof Vec2 && o.#x === this.#x && o.#y === this.#y;
  }

  __hash__(): number { return hashNumbers(this.#x, this.#y); }

  is_close(...args: unknown[]): boolean {
    const a = bindArgs('is_close', args, { positional: ['other', 'tolerance'], required: ['other'] }).args;
    const o = vec2(a['other'], 'is_close');
    const tolerance = (a['tolerance'] ?? 1e-4) as number;
    return Math.abs(this.#x - o.#x) <= tolerance && Math.abs(this.#y - o.#y) <= tolerance;
  }

  length(): number { return Math.hypot(this.#x, this.#y); }
  length_squared(): number { return this.#x * this.#x + this.#y * this.#y; }

  /** Unit vector in the same direction; the zero vector stays zero. */
  normalized(): Vec2 {
    const len = this.length();
    return len === 0 ? Vec2.ZERO : new Vec2(this.#x / len, this.#y / len);
  }

  dot(other: Vec2): number {
    const o = vec2(other, 'dot');
    return this.#x * o.#x + this.#y * o.#y;
  }
  cross(other: Vec2): number {
    const o = vec2(other, 'cross');
    return this.#x * o.#y - this.#y * o.#x;
  }
  distance_to(other: Vec2): number {
    const o = vec2(other, 'distance_to');
    return Math.hypot(this.#x - o.#x, this.#y - o.#y);
  }

  /** Degrees counter-clockwise from +x. */
  angle(): number { return deg(Math.atan2(this.#y, this.#x)); }

  rotated(degrees: number): Vec2 {
    const r = rad(degrees);
    const c = Math.cos(r);
    const s = Math.sin(r);
    return new Vec2(this.#x * c - this.#y * s, this.#x * s + this.#y * c);
  }

  lerp(other: Vec2, t: number): Vec2 {
    const o = vec2(other, 'lerp');
    return new Vec2(this.#x + (o.#x - this.#x) * t, this.#y + (o.#y - this.#y) * t);
  }

  with_x(x: number): Vec2 { return new Vec2(x, this.#y); }
  with_y(y: number): Vec2 { return new Vec2(this.#x, y); }

  /** (x, y, z) — for 2D games. */
  to_vec3(z = 0): Vec3 { return new Vec3(this.#x, this.#y, z); }

  /** (self.x, y, self.y): a stick or plane vector onto the 3D ground plane (x, z). */
  to_ground(...args: unknown[]): Vec3 {
    const y = (bindArgs('to_ground', args, { positional: ['y'] }).args['y'] ?? 0) as number;
    return new Vec3(this.#x, y, this.#y);
  }

  /** The stored form (data files and saves write vectors as number lists). */
  toJSON(): [number, number] { return [this.#x, this.#y]; }
  /** Python `repr`/`str` (pyrt): the same as toString. */
  __repr__(): string { return this.toString(); }

  toString(): string { return `Vec2(${this.#x}, ${this.#y})`; }
}

/** NotImplemented, typed as the operator's result (pyrt checks for it before using one). */
const NOT_A_VEC2 = NotImplemented as Vec2;

function isScalar(s: unknown): s is number {
  return typeof s === 'number' || typeof s === 'boolean';
}

/** A method's vector argument: a Vec2, else PP3007 with the conversion to write. */
function vec2(o: unknown, method: string): Vec2 {
  if (o instanceof Vec2) return o;
  return fail('PP3007', `Vec2.${method}() needs a Vec2, got ${o instanceof Vec3 ? o.toString() : typeof o === 'object' && o !== null ? o.constructor.name : String(o)}`, {
    fix: o instanceof Vec3 ? 'Take its 2D part with v.xy() (a 2D position) or v.xz() (the ground plane).' : 'Pass a vec2(x, y).',
  });
}

function immutable(axis: string): never {
  fail('PP3020', `Vec2 is immutable; cannot assign .${axis}`, {
    fix: `Assign a new vector: \`t.position = t.position.with_${axis}(value)\` or \`t.position += vec2(...)\`.`,
  });
}
