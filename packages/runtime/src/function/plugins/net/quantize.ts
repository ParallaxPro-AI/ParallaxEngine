/**
 * Transform quantization for the wire. Positions travel as whole millimetres (integers, so
 * a delta against a baseline is exact on both sides); rotations as "smallest three" unit
 * quaternions packed in 32 bits; scale as floats (it rarely changes, so it rarely travels).
 *
 * The server quantizes before it compares against what a client already has, and the
 * client reconstructs from the same integers, so both agree bit for bit on every pose.
 */

import { Quat, Vec3 } from '../../../core/index.js';

/** Metres per position step. */
export const POSITION_STEP = 0.001;

/** Bits per packed quaternion component (three of them, plus 2 bits for the dropped one). */
const ROTATION_BITS = 10;
const ROTATION_MAX = (1 << ROTATION_BITS) - 1;
const RANGE = Math.SQRT1_2;

/** A pose as it travels: millimetre position, packed rotation, scale. */
export interface QuantPose {
  readonly p: readonly [number, number, number];
  readonly r: number;
  readonly s: readonly [number, number, number];
}

export function quantizePosition(v: Vec3): [number, number, number] {
  return [Math.round(v.x / POSITION_STEP), Math.round(v.y / POSITION_STEP), Math.round(v.z / POSITION_STEP)];
}

export function positionOf(q: readonly number[]): Vec3 {
  return new Vec3(q[0]! * POSITION_STEP, q[1]! * POSITION_STEP, q[2]! * POSITION_STEP);
}

/** Pack a rotation: the largest component is dropped (and made positive); the other three are 10-bit. */
export function packRotation(q: Quat): number {
  const len = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  let c = [q.x / len, q.y / len, q.z / len, q.w / len];
  let largest = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(c[i]!) > Math.abs(c[largest]!)) largest = i;
  if (c[largest]! < 0) c = c.map((x) => -x);
  let packed = largest;
  let shift = 2;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const unit = (Math.max(-RANGE, Math.min(RANGE, c[i]!)) + RANGE) / (2 * RANGE);
    packed += Math.round(unit * ROTATION_MAX) * 2 ** shift;
    shift += ROTATION_BITS;
  }
  return packed;
}

export function unpackRotation(packed: number): Quat {
  const largest = packed % 4;
  let rest = Math.floor(packed / 4);
  const c = [0, 0, 0, 0];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const bits = rest % (ROTATION_MAX + 1);
    rest = Math.floor(rest / (ROTATION_MAX + 1));
    const value = (bits / ROTATION_MAX) * 2 * RANGE - RANGE;
    c[i] = value;
    sum += value * value;
  }
  c[largest] = Math.sqrt(Math.max(0, 1 - sum));
  const n = Math.hypot(c[0]!, c[1]!, c[2]!, c[3]!) || 1;
  return new Quat(c[0]! / n, c[1]! / n, c[2]! / n, c[3]! / n);
}

export function quantizePose(position: Vec3, rotation: Quat, scale: Vec3): QuantPose {
  // Scale travels as float32: round here so both sides hold the same value.
  return { p: quantizePosition(position), r: packRotation(rotation), s: [Math.fround(scale.x), Math.fround(scale.y), Math.fround(scale.z)] };
}

export function samePose(a: QuantPose, b: QuantPose): boolean {
  return a.r === b.r && a.p[0] === b.p[0] && a.p[1] === b.p[1] && a.p[2] === b.p[2]
    && a.s[0] === b.s[0] && a.s[1] === b.s[1] && a.s[2] === b.s[2];
}
