import { bindArgs } from '../kwargs.js';
import { fail } from '../diagnostics.js';
import { hashNumbers } from '../hash.js';
import { rad } from './angles.js';
import { NotImplemented } from './not_implemented.js';
import { Vec2 } from './vec2.js';

/** Immutable 3D vector. +y is up, +z is forward. Same conventions as Vec2. */
export class Vec3 {
  static readonly ZERO = new Vec3(0, 0, 0);
  static readonly ONE = new Vec3(1, 1, 1);
  static readonly UP = new Vec3(0, 1, 0);
  static readonly DOWN = new Vec3(0, -1, 0);
  static readonly LEFT = new Vec3(-1, 0, 0);
  static readonly RIGHT = new Vec3(1, 0, 0);
  static readonly FORWARD = new Vec3(0, 0, 1);
  static readonly BACK = new Vec3(0, 0, -1);

  readonly #x: number;
  readonly #y: number;
  readonly #z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.#x = x;
    this.#y = y;
    this.#z = z;
  }

  get x(): number { return this.#x; }
  set x(_value: number) { immutable('x'); }
  get y(): number { return this.#y; }
  set y(_value: number) { immutable('y'); }
  get z(): number { return this.#z; }
  set z(_value: number) { immutable('z'); }

  /** Direction from yaw (around +y, 0 = +z) and pitch (up positive), in degrees. */
  /** `Vec3.from_yaw_pitch(yaw, pitch=0, length=1)`, in degrees (Python arguments: see core/kwargs.ts). */
  static from_yaw_pitch(...args: unknown[]): Vec3 {
    const a = bindArgs('from_yaw_pitch', args, { positional: ['yaw', 'pitch', 'length'], required: ['yaw'] }).args;
    const yaw = rad(a['yaw'] as number);
    const pitch = rad((a['pitch'] ?? 0) as number);
    const length = (a['length'] ?? 1) as number;
    const flat = Math.cos(pitch) * length;
    return new Vec3(Math.sin(yaw) * flat, Math.sin(pitch) * length, Math.cos(yaw) * flat);
  }

  // Operators take a Vec3 or a Vec2, which counts as (x, y, 0): the 2D idiom
  // `tf.position += vec2(1, 0)` moves x and y and keeps z (draw order). Any other operand
  // is NotImplemented, so Python raises its TypeError.
  __add__(o: Vec3 | Vec2): Vec3 {
    const v = operand(o);
    return v === null ? NOT_A_VEC3 : new Vec3(this.#x + v.#x, this.#y + v.#y, this.#z + v.#z);
  }
  __radd__(o: Vec2): Vec3 { return this.__add__(o); }
  __sub__(o: Vec3 | Vec2): Vec3 {
    const v = operand(o);
    return v === null ? NOT_A_VEC3 : new Vec3(this.#x - v.#x, this.#y - v.#y, this.#z - v.#z);
  }
  __rsub__(o: Vec2): Vec3 {
    const v = operand(o);
    return v === null ? NOT_A_VEC3 : new Vec3(v.#x - this.#x, v.#y - this.#y, v.#z - this.#z);
  }
  __mul__(s: number): Vec3 { return isScalar(s) ? new Vec3(this.#x * +s, this.#y * +s, this.#z * +s) : NOT_A_VEC3; }
  __rmul__(s: number): Vec3 { return this.__mul__(s); }
  __neg__(): Vec3 { return new Vec3(-this.#x, -this.#y, -this.#z); }

  __truediv__(s: number): Vec3 {
    if (!isScalar(s)) return NOT_A_VEC3;
    if (+s === 0) fail('PP3021', 'Vector divided by zero', { fix: 'Check the divisor before dividing.' });
    return new Vec3(this.#x / +s, this.#y / +s, this.#z / +s);
  }

  __eq__(o: unknown): boolean {
    return o instanceof Vec3 && o.#x === this.#x && o.#y === this.#y && o.#z === this.#z;
  }

  __hash__(): number { return hashNumbers(this.#x, this.#y, this.#z); }

  is_close(...args: unknown[]): boolean {
    const a = bindArgs('is_close', args, { positional: ['other', 'tolerance'], required: ['other'] }).args;
    const o = vec3(a['other'], 'is_close');
    const tolerance = (a['tolerance'] ?? 1e-4) as number;
    return Math.abs(this.#x - o.#x) <= tolerance
      && Math.abs(this.#y - o.#y) <= tolerance
      && Math.abs(this.#z - o.#z) <= tolerance;
  }

  length(): number { return Math.hypot(this.#x, this.#y, this.#z); }
  length_squared(): number { return this.#x * this.#x + this.#y * this.#y + this.#z * this.#z; }

  normalized(): Vec3 {
    const len = this.length();
    return len === 0 ? Vec3.ZERO : new Vec3(this.#x / len, this.#y / len, this.#z / len);
  }

  dot(other: Vec3): number {
    const o = vec3(other, 'dot');
    return this.#x * o.#x + this.#y * o.#y + this.#z * o.#z;
  }

  cross(other: Vec3): Vec3 {
    const o = vec3(other, 'cross');
    return new Vec3(
      this.#y * o.#z - this.#z * o.#y,
      this.#z * o.#x - this.#x * o.#z,
      this.#x * o.#y - this.#y * o.#x,
    );
  }

  distance_to(other: Vec3): number {
    const o = vec3(other, 'distance_to');
    return Math.hypot(this.#x - o.#x, this.#y - o.#y, this.#z - o.#z);
  }

  lerp(other: Vec3, t: number): Vec3 {
    const o = vec3(other, 'lerp');
    return new Vec3(
      this.#x + (o.#x - this.#x) * t,
      this.#y + (o.#y - this.#y) * t,
      this.#z + (o.#z - this.#z) * t,
    );
  }

  /** Same vector with y = 0 (ground-plane direction). */
  flat(): Vec3 { return new Vec3(this.#x, 0, this.#z); }

  /** Rotate around the up axis (yaw), degrees; positive turns +z toward +x. */
  rotated_y(degrees: number): Vec3 {
    const r = rad(degrees);
    const c = Math.cos(r);
    const s = Math.sin(r);
    return new Vec3(this.#x * c + this.#z * s, this.#y, -this.#x * s + this.#z * c);
  }

  with_x(x: number): Vec3 { return new Vec3(x, this.#y, this.#z); }
  with_y(y: number): Vec3 { return new Vec3(this.#x, y, this.#z); }
  with_z(z: number): Vec3 { return new Vec3(this.#x, this.#y, z); }
  xy(): Vec2 { return new Vec2(this.#x, this.#y); }
  xz(): Vec2 { return new Vec2(this.#x, this.#z); }

  /** The stored form (data files and saves write vectors as number lists). */
  toJSON(): [number, number, number] { return [this.#x, this.#y, this.#z]; }
  /** Python `repr`/`str` (pyrt): the same as toString. */
  __repr__(): string { return this.toString(); }

  toString(): string { return `Vec3(${this.#x}, ${this.#y}, ${this.#z})`; }
}

/** NotImplemented, typed as the operator's result (pyrt checks for it before using one). */
const NOT_A_VEC3 = NotImplemented as Vec3;

function isScalar(s: unknown): s is number {
  return typeof s === 'number' || typeof s === 'boolean';
}

function operand(o: unknown): Vec3 | null {
  if (o instanceof Vec3) return o;
  if (o instanceof Vec2) return new Vec3(o.x, o.y, 0);
  return null;
}

/** A method's vector argument: a Vec3, else PP3007 with the conversion to write. */
function vec3(o: unknown, method: string): Vec3 {
  if (o instanceof Vec3) return o;
  return fail('PP3007', `Vec3.${method}() needs a Vec3, got ${o instanceof Vec2 ? o.toString() : typeof o === 'object' && o !== null ? o.constructor.name : String(o)}`, {
    fix: o instanceof Vec2 ? 'Convert it with v.to_vec3(z) (or compare in 2D: position.xy()).' : 'Pass a vec3(x, y, z).',
  });
}

function immutable(axis: string): never {
  fail('PP3020', `Vec3 is immutable; cannot assign .${axis}`, {
    fix: `Assign a new vector: \`t.position = t.position.with_${axis}(value)\` or \`t.position += vec3(...)\`.`,
  });
}
