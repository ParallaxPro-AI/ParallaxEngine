/**
 * 4×4 matrix math for the renderer, column-major (`m[col * 4 + row]`), on plain
 * Float32Arrays. Left-handed, y-up, +z forward; projections map depth to clip z 0..1.
 */

export type M4 = Float32Array;

export function identity(): M4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a · b (b applies first). `out` may be `a` or `b`. */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: M4 = new Float32Array(16)): M4 {
  // Every input is read before `out` is written, so aliasing is safe without a temporary array.
  const a0 = a[0]!; const a1 = a[1]!; const a2 = a[2]!; const a3 = a[3]!;
  const a4 = a[4]!; const a5 = a[5]!; const a6 = a[6]!; const a7 = a[7]!;
  const a8 = a[8]!; const a9 = a[9]!; const a10 = a[10]!; const a11 = a[11]!;
  const a12 = a[12]!; const a13 = a[13]!; const a14 = a[14]!; const a15 = a[15]!;
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!; const b1 = b[c * 4 + 1]!; const b2 = b[c * 4 + 2]!; const b3 = b[c * 4 + 3]!;
    out[c * 4] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    out[c * 4 + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    out[c * 4 + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    out[c * 4 + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
  }
  return out;
}

/** Translation · rotation (unit quaternion x, y, z, w) · scale. */
export function compose(
  tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number,
  out: M4 = new Float32Array(16),
): M4 {
  const xx = qx * qx; const yy = qy * qy; const zz = qz * qz;
  const xy = qx * qy; const xz = qx * qz; const yz = qy * qz;
  const wx = qw * qx; const wy = qw * qy; const wz = qw * qz;
  out[0] = (1 - 2 * (yy + zz)) * sx; out[1] = 2 * (xy + wz) * sx; out[2] = 2 * (xz - wy) * sx; out[3] = 0;
  out[4] = 2 * (xy - wz) * sy; out[5] = (1 - 2 * (xx + zz)) * sy; out[6] = 2 * (yz + wx) * sy; out[7] = 0;
  out[8] = 2 * (xz + wy) * sz; out[9] = 2 * (yz - wx) * sz; out[10] = (1 - 2 * (xx + yy)) * sz; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

export function translation(x: number, y: number, z: number): M4 {
  return compose(x, y, z, 0, 0, 0, 1, 1, 1, 1);
}

export function scaling(x: number, y: number, z: number): M4 {
  return compose(0, 0, 0, 0, 0, 0, 1, x, y, z);
}

/** The inverse, or null when the matrix is singular. */
export function invert(m: ArrayLike<number>): M4 | null {
  const a00 = m[0]!; const a01 = m[1]!; const a02 = m[2]!; const a03 = m[3]!;
  const a10 = m[4]!; const a11 = m[5]!; const a12 = m[6]!; const a13 = m[7]!;
  const a20 = m[8]!; const a21 = m[9]!; const a22 = m[10]!; const a23 = m[11]!;
  const a30 = m[12]!; const a31 = m[13]!; const a32 = m[14]!; const a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10; const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10; const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11; const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30; const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30; const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31; const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-20) return null;
  const d = 1 / det;
  const out = new Float32Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/** A point transformed by m (w = 1, divided by the result's w). */
export function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
}

/** A direction transformed by m's upper 3×3. */
export function transformDirection(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

export function normalize3(v: readonly [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l === 0 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
}

export function cross3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

export function dot3(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** World → camera space for a camera at `eye` with unit axes right/up/forward (camera looks along +z). */
export function viewMatrix(eye: readonly number[], right: readonly number[], up: readonly number[], forward: readonly number[]): M4 {
  const m = new Float32Array(16);
  m[0] = right[0]!; m[4] = right[1]!; m[8] = right[2]!; m[12] = -dot3(right, eye);
  m[1] = up[0]!; m[5] = up[1]!; m[9] = up[2]!; m[13] = -dot3(up, eye);
  m[2] = forward[0]!; m[6] = forward[1]!; m[10] = forward[2]!; m[14] = -dot3(forward, eye);
  m[15] = 1;
  return m;
}

/** Left-handed perspective, vertical fov in degrees, depth near..far → z 0..1. */
export function perspective(fovDeg: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (far - near);
  m[11] = 1;
  m[14] = (-near * far) / (far - near);
  return m;
}

/** Left-handed orthographic box → x, y -1..1, depth near..far → z 0..1. */
export function orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): M4 {
  const m = new Float32Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = 1 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -near / (far - near);
  m[15] = 1;
  return m;
}

/** Quaternion slerp (shortest path), into `out` at `o`. */
export function slerp(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, t: number, out: Float32Array, o: number): void {
  let bx = b[bi]!; let by = b[bi + 1]!; let bz = b[bi + 2]!; let bw = b[bi + 3]!;
  const ax = a[ai]!; const ay = a[ai + 1]!; const az = a[ai + 2]!; const aw = a[ai + 3]!;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka: number;
  let kb: number;
  if (cos > 0.9995) {
    ka = 1 - t;
    kb = t;
  } else {
    const angle = Math.acos(cos);
    const s = Math.sin(angle);
    ka = Math.sin((1 - t) * angle) / s;
    kb = Math.sin(t * angle) / s;
  }
  let x = ka * ax + kb * bx; let y = ka * ay + kb * by; let z = ka * az + kb * bz; let w = ka * aw + kb * bw;
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}
