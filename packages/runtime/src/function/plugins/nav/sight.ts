/**
 * Line of sight for `ctx.nav.can_see`: a segment against the static colliders (each a
 * footprint extruded over its height range; a model collider's triangles exactly) and,
 * with terrain, against the ground sampled every half meter. Moving things (bodies, characters, agents) never occlude.
 */

import type { EntityId, Vec3 } from '../../../core/index.js';
import type { TerrainField } from '../../services/index.js';
import type { Footprint, Obstacles } from './world.js';

/** Whether the part [t0, t1] of the segment p + t·d crosses the footprint. */
function clipFootprint(foot: Exclude<Footprint, { kind: 'tri' }>, px: number, pz: number, dx: number, dz: number, t0: number, t1: number): boolean {
  if (foot.kind === 'circle') {
    // Closest approach of the clipped segment to the center.
    const len2 = dx * dx + dz * dz;
    let t = len2 === 0 ? t0 : ((foot.cx - px) * dx + (foot.cz - pz) * dz) / len2;
    t = Math.min(t1, Math.max(t0, t));
    return Math.hypot(px + dx * t - foot.cx, pz + dz * t - foot.cz) <= foot.r;
  }
  // Slabs in the rectangle's own axes.
  const ox = px - foot.cx;
  const oz = pz - foot.cz;
  const lp = [ox * foot.ux + oz * foot.uz, -ox * foot.uz + oz * foot.ux];
  const ld = [dx * foot.ux + dz * foot.uz, -dx * foot.uz + dz * foot.ux];
  const half = [foot.hx, foot.hz];
  let lo = t0;
  let hi = t1;
  for (let a = 0; a < 2; a++) {
    if (Math.abs(ld[a]!) < 1e-12) {
      if (Math.abs(lp[a]!) > half[a]!) return false;
      continue;
    }
    let ta = (-half[a]! - lp[a]!) / ld[a]!;
    let tb = (half[a]! - lp[a]!) / ld[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    lo = Math.max(lo, ta);
    hi = Math.min(hi, tb);
    if (lo > hi) return false;
  }
  return true;
}

/** Whether the segment p + t·d, t in [0, 1], crosses the triangle (Möller–Trumbore, either side). */
function crossesTriangle(px: number, py: number, pz: number, dx: number, dy: number, dz: number, q: readonly number[]): boolean {
  const e1x = q[3]! - q[0]!; const e1y = q[4]! - q[1]!; const e1z = q[5]! - q[2]!;
  const e2x = q[6]! - q[0]!; const e2y = q[7]! - q[1]!; const e2z = q[8]! - q[2]!;
  const hx = dy * e2z - dz * e2y; const hy = dz * e2x - dx * e2z; const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det;
  const sx = px - q[0]!; const sy = py - q[1]!; const sz = pz - q[2]!;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y; const qy = sz * e1x - sx * e1z; const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return false;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t >= 0 && t <= 1;
}

export function segmentBlocked(obstacles: Obstacles, terrain: TerrainField | null, a: Vec3, b: Vec3, ignore: ReadonlySet<EntityId>): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  for (const shape of obstacles.near(Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.z, b.z), Math.max(a.z, b.z))) {
    if (ignore.has(shape.entity)) continue;
    if (shape.foot.kind === 'tri') {
      if (crossesTriangle(a.x, a.y, a.z, dx, dy, dz, shape.foot.p)) return true;
      continue;
    }
    let t0 = 0;
    let t1 = 1;
    if (Math.abs(dy) < 1e-12) {
      if (a.y < shape.yMin || a.y > shape.yMax) continue;
    } else {
      let ta = (shape.yMin - a.y) / dy;
      let tb = (shape.yMax - a.y) / dy;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(0, ta);
      t1 = Math.min(1, tb);
      if (t0 > t1) continue;
    }
    if (clipFootprint(shape.foot, a.x, a.z, dx, dz, t0, t1)) return true;
  }
  if (terrain !== null) {
    const samples = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      if (terrain.contains(x, z) && terrain.heightAt(x, z) > a.y + dy * t) return true;
    }
  }
  return false;
}
