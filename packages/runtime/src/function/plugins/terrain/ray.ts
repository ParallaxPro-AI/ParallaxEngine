/**
 * A ray against the terrain's surface (no physics needed): where the pointer's ray meets the
 * ground, so `pointer.world` lands on a hill or a terrace instead of the y = 0 plane under it.
 * Marches the ray in half-cell steps inside the field's bounds, then bisects the crossing;
 * holes are skipped (the ray falls through them).
 */

import { Vec3 } from '../../../core/index.js';
import type { TerrainField } from '../../services/index.js';

/** The first point where the ray (origin + t·dir, 0 ≤ t ≤ maxDistance) meets the surface, or null. */
export function rayTerrain(field: TerrainField, origin: Vec3, dir: Vec3, maxDistance: number): Vec3 | null {
  const len = dir.length();
  if (len < 1e-12) return null;
  const d = dir.__mul__(1 / len);
  // Clip t to the field's box (x, z bounds and the height band).
  let t0 = 0;
  let t1 = maxDistance;
  const slab = (o: number, v: number, lo: number, hi: number): boolean => {
    if (Math.abs(v) < 1e-12) return o >= lo && o <= hi;
    let a = (lo - o) / v;
    let b = (hi - o) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  const eps = 1e-6;
  if (!slab(origin.x, d.x, field.minX + eps, field.minX + field.width - eps)) return null;
  if (!slab(origin.z, d.z, field.minZ + eps, field.minZ + field.depth - eps)) return null;
  if (!slab(origin.y, d.y, field.minHeight - 1e-3, field.maxHeight + 1e-3)) return null;
  const at = (t: number): Vec3 => origin.__add__(d.__mul__(t));
  const below = (p: Vec3): boolean => !field.holeAt(p.x, p.z) && p.y <= field.heightAt(p.x, p.z);
  const step = Math.max(1e-3, 0.5 * Math.min(field.cellX, field.cellZ));
  let prev = t0;
  if (below(at(prev))) return at(prev);
  for (let t = Math.min(t0 + step, t1); ; t = Math.min(t + step, t1)) {
    if (below(at(t))) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (below(at(mid))) hi = mid;
        else lo = mid;
      }
      const p = at(hi);
      return new Vec3(p.x, field.heightAt(p.x, p.z), p.z);
    }
    if (t >= t1) return null;
    prev = t;
  }
}
