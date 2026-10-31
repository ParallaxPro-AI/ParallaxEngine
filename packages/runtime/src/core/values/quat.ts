import { bindArgs } from '../kwargs.js';
import { fail } from '../diagnostics.js';
import { deg, rad } from './angles.js';
import { Vec3 } from './vec3.js';

/**
 * Immutable unit quaternion. Euler angles are degrees (pitch about x, yaw about y, roll
 * about z), applied yaw → pitch → roll, matching `Transform.euler` in the SDK.
 */
export class Quat {
  static readonly IDENTITY = new Quat(0, 0, 0, 1);

  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;

  constructor(x: number, y: number, z: number, w: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    Object.freeze(this);
  }

  static from_euler(degrees: Vec3): Quat {
    const p = rad(degrees.x) / 2;
    const y = rad(degrees.y) / 2;
    const r = rad(degrees.z) / 2;
    const yaw = new Quat(0, Math.sin(y), 0, Math.cos(y));
    const pitch = new Quat(Math.sin(p), 0, 0, Math.cos(p));
    const roll = new Quat(0, 0, Math.sin(r), Math.cos(r));
    return yaw.__mul__(pitch).__mul__(roll);
  }

  /**
   * `Quat.look_rotation(forward, up=Vec3.UP)`: the rotation that turns +z to `forward`
   * and +y as near to `up` as it can (Python arguments: see core/kwargs.ts).
   */
  static look_rotation(...args: unknown[]): Quat {
    const a = bindArgs('look_rotation', args, { positional: ['forward', 'up'], required: ['forward'] }).args;
    const forward = a['forward'];
    const up = a['up'] ?? Vec3.UP;
    if (!(forward instanceof Vec3) || !(up instanceof Vec3)) {
      fail('PP3022', 'look_rotation() takes Vec3 forward and up', { fix: 'Pass vec3(x, y, z) values.' });
    }
    const length = forward.length();
    if (length === 0) fail('PP3021', 'look_rotation() needs a non-zero forward direction', { fix: 'Check the direction before turning to it.' });
    const f = forward.__mul__(1 / length);
    let r = up.cross(f);
    // Looking straight along `up`: no roll is implied; measure it from +z (or +x) instead.
    if (r.length() < 1e-9) r = (Math.abs(f.z) < 0.9 ? Vec3.FORWARD : Vec3.RIGHT).cross(f);
    r = r.__mul__(1 / r.length());
    const u = f.cross(r);
    // Columns r, u, f of the rotation matrix → quaternion.
    const m00 = r.x, m01 = u.x, m02 = f.x;
    const m10 = r.y, m11 = u.y, m12 = f.y;
    const m20 = r.z, m21 = u.z, m22 = f.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      return new Quat((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s);
    }
    if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      return new Quat(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
    }
    if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      return new Quat((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
    }
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return new Quat((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
  }

  /** Rotation about +z by `degrees` (2D angles). */
  static from_angle(degrees: number): Quat {
    const half = rad(degrees) / 2;
    return new Quat(0, 0, Math.sin(half), Math.cos(half));
  }

  /** Composition: `a * b` applies b first, then a. */
  __mul__(o: Quat): Quat {
    return new Quat(
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y - this.x * o.z + this.y * o.w + this.z * o.x,
      this.w * o.z + this.x * o.y - this.y * o.x + this.z * o.w,
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
    );
  }

  rotate(v: Vec3): Vec3 {
    // v' = v + 2w(q × v) + 2(q × (q × v))
    const tx = 2 * (this.y * v.z - this.z * v.y);
    const ty = 2 * (this.z * v.x - this.x * v.z);
    const tz = 2 * (this.x * v.y - this.y * v.x);
    return new Vec3(
      v.x + this.w * tx + (this.y * tz - this.z * ty),
      v.y + this.w * ty + (this.z * tx - this.x * tz),
      v.z + this.w * tz + (this.x * ty - this.y * tx),
    );
  }

  inverse(): Quat {
    return new Quat(-this.x, -this.y, -this.z, this.w);
  }

  to_euler(): Vec3 {
    // Inverse of yaw → pitch → roll.
    const sinPitch = Math.max(-1, Math.min(1, 2 * (this.w * this.x - this.y * this.z)));
    const pitch = Math.asin(sinPitch);
    const yaw = Math.atan2(2 * (this.w * this.y + this.x * this.z), 1 - 2 * (this.x * this.x + this.y * this.y));
    const roll = Math.atan2(2 * (this.w * this.z + this.x * this.y), 1 - 2 * (this.x * this.x + this.z * this.z));
    return new Vec3(deg(pitch), deg(yaw), deg(roll));
  }

  /** Rotation about +z in degrees (2D). */
  angle(): number {
    return deg(2 * Math.atan2(this.z, this.w));
  }

  toString(): string { return `Quat(${this.x}, ${this.y}, ${this.z}, ${this.w})`; }
  /** Python `repr`/`str` (pyrt): the same as toString. */
  __repr__(): string { return this.toString(); }

  is_close(...args: unknown[]): boolean {
    const a = bindArgs('is_close', args, { positional: ['other', 'tolerance'], required: ['other'] }).args;
    const o = a['other'] as Quat;
    const tolerance = (a['tolerance'] ?? 1e-6) as number;
    // q and -q are the same rotation.
    const dot = Math.abs(this.x * o.x + this.y * o.y + this.z * o.z + this.w * o.w);
    return 1 - dot <= tolerance;
  }
}
