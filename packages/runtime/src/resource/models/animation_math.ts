/**
 * Quaternion and pose arithmetic for the animation passes: quaternions are `[x, y, z, w]`
 * tuples (engine handedness: +x right, +y up, +z forward), poses are `POSE_STRIDE`
 * numbers per node (animation.ts). Euler angles follow `Quat.from_euler`: degrees, yaw
 * (y) then pitch (x) then roll (z).
 */

import type { ModelAsset } from './gltf.js';

export type Q = [number, number, number, number];
export type V3 = [number, number, number];

export const POSE_STRIDE = 10;
export const IDENTITY_Q: Readonly<Q> = [0, 0, 0, 1];

export function qmul(a: Readonly<Q>, b: Readonly<Q>): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qinv(q: Readonly<Q>): Q {
  const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1;
  return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n];
}

export function qnormalize(q: Readonly<Q>): Q {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qrotate(q: Readonly<Q>, v: Readonly<V3>): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function qslerp(a: Readonly<Q>, b: Readonly<Q>, t: number): Q {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) return qnormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  const theta = Math.acos(Math.min(1, dot));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Shortest rotation turning direction `from` onto `to`. */
export function qfromTo(from: Readonly<V3>, to: Readonly<V3>): Q {
  const f = norm3(from);
  const t = norm3(to);
  const d = dot3(f, t);
  if (d >= 1 - 1e-9) return [0, 0, 0, 1];
  if (d <= -1 + 1e-9) {
    let axis = cross3([1, 0, 0], f);
    if (len3(axis) < 1e-6) axis = cross3([0, 1, 0], f);
    axis = norm3(axis);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross3(f, t);
  return qnormalize([c[0], c[1], c[2], 1 + d]);
}

/** As `Quat.from_euler(Vec3(x, y, z))`: yaw (y) · pitch (x) · roll (z), degrees. */
export function qeuler(x: number, y: number, z: number): Q {
  const r = Math.PI / 360;
  const yaw: Q = [0, Math.sin(y * r), 0, Math.cos(y * r)];
  const pitch: Q = [Math.sin(x * r), 0, 0, Math.cos(x * r)];
  const roll: Q = [0, 0, Math.sin(z * r), Math.cos(z * r)];
  return qmul(qmul(yaw, pitch), roll);
}

/** Heading in degrees: where the rotation turns +z, about +y (+90: toward +x). */
export function qyaw(q: Readonly<Q>): number {
  const f = qrotate(q, [0, 0, 1]);
  return (Math.atan2(f[0], f[2]) * 180) / Math.PI;
}

/** The part of `q` that turns about +y (swing-twist decomposition). */
export function qtwistY(q: Readonly<Q>): Q {
  const l = Math.hypot(q[1], q[3]);
  return l < 1e-9 ? [0, 0, 0, 1] : [0, q[1] / l, 0, q[3] / l];
}

/** Angle of a rotation, degrees (0–180). */
export function qangle(q: Readonly<Q>): number {
  return (2 * Math.acos(Math.min(1, Math.abs(qnormalize(q)[3]))) * 180) / Math.PI;
}

export function dot3(a: Readonly<V3>, b: Readonly<V3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Readonly<V3>, b: Readonly<V3>): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function len3(a: Readonly<V3>): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function norm3(a: Readonly<V3>): V3 {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function sub3(a: Readonly<V3>, b: Readonly<V3>): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add3(a: Readonly<V3>, b: Readonly<V3>): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale3(a: Readonly<V3>, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

// ── Poses ──────────────────────────────────────────────────────────────────────

export function getRotation(pose: ArrayLike<number>, node: number): Q {
  const o = node * POSE_STRIDE + 3;
  return [pose[o]!, pose[o + 1]!, pose[o + 2]!, pose[o + 3]!];
}

export function setRotation(pose: Float32Array, node: number, q: Readonly<Q>): void {
  pose.set(qnormalize(q), node * POSE_STRIDE + 3);
}

export function getTranslation(pose: ArrayLike<number>, node: number): V3 {
  const o = node * POSE_STRIDE;
  return [pose[o]!, pose[o + 1]!, pose[o + 2]!];
}

export function setTranslation(pose: Float32Array, node: number, t: Readonly<V3>): void {
  pose.set(t, node * POSE_STRIDE);
}

/** Every node's rotation in model space (the product of its ancestors' local rotations). */
export function worldRotations(model: ModelAsset, pose: ArrayLike<number>): Q[] {
  const out: Q[] = new Array<Q>(model.nodes.length).fill([0, 0, 0, 1]);
  for (const i of model.order) {
    const parent = model.nodes[i]!.parent;
    const local = getRotation(pose, i);
    out[i] = parent === -1 ? local : qnormalize(qmul(out[parent]!, local));
  }
  return out;
}

/** The model-space position of node `i` from `nodeMatrices` output. */
export function nodePosition(worlds: ArrayLike<number>, i: number): V3 {
  return [worlds[i * 16 + 12]!, worlds[i * 16 + 13]!, worlds[i * 16 + 14]!];
}
