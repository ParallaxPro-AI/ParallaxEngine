/**
 * The one footprint schema every scene block uses for a region of the ground (terrain
 * hills/flats/holes/paint/brush, foliage area/exclude, city area/exclude, water lakes and
 * pools), in world [x, z] meters:
 *
 *   {"center": [x, z], "radius": r}                          a circle
 *   {"center": [x, z], "size": [w, d], "rotation": deg}      a rectangle (`size` is its full
 *                                                            width and depth; rotation optional)
 *   {"points": [[x, z], [x, z], [x, z], …]}                  a polygon
 *
 * The caller passes its own `fail` so errors carry its code, scene and pointer.
 */

import { rectFootprint } from './ground_math.js';
import type { Footprint } from './ground_math.js';

export const FOOTPRINT_KEYS: readonly string[] = ['center', 'radius', 'size', 'rotation', 'points'];

/** Fails with (pointer, message, fix); never returns. */
export type FootprintFail = (pointer: string, message: string, fix: string) => never;

const EXAMPLE = '{"center": [x, z], "radius": r}, {"center": [x, z], "size": [w, d]} or {"points": [[x, z], …]}';

function pair(value: unknown, pointer: string, fail: FootprintFail): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return fail(pointer, `${pointer.split('/').pop()} must be 2 numbers`, 'Write [x, z].');
  }
  return [value[0] as number, value[1] as number];
}

/**
 * A footprint from JSON. `other` lists further keys the caller's object may carry next to the
 * shape (a terrain paint's "feather"); any other key fails. Older region spellings (corner
 * pairs, [x0, z0, x1, z1] rectangles, "min"/"max", "polygon") fail naming the schema.
 */
export function readFootprint(value: unknown, pointer: string, fail: FootprintFail, other: readonly string[] = []): Footprint {
  if (Array.isArray(value)) {
    return fail(pointer, 'a region is a footprint object, not a list of corners or numbers',
      `Write ${EXAMPLE}: [[x0, z0], [x1, z1]] is {"center": [(x0+x1)/2, (z0+z1)/2], "size": [|x1-x0|, |z1-z0|]}.`);
  }
  if (typeof value !== 'object' || value === null) return fail(pointer, 'a footprint must be an object', `Write ${EXAMPLE}.`);
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (FOOTPRINT_KEYS.includes(key) || other.includes(key)) continue;
    const hint = key === 'polygon' ? 'Write "points": [[x, z], …].'
      : key === 'min' || key === 'max' || key === 'bounds' ? 'Write "center": [x, z] and "size": [w, d] (full extents).'
      : `Footprint keys: ${FOOTPRINT_KEYS.join(', ')}.`;
    fail(`${pointer}/${key}`, `unknown footprint key "${key}"`, hint);
  }
  if (o['points'] !== undefined) {
    for (const key of ['center', 'radius', 'size', 'rotation']) {
      if (o[key] !== undefined) fail(`${pointer}/${key}`, `a polygon ("points") takes no "${key}"`, 'Give either points, or a center with a radius or size.');
    }
    const points = o['points'];
    if (!Array.isArray(points) || points.length < 3) return fail(`${pointer}/points`, 'a polygon needs at least 3 points', 'Write "points": [[x, z], [x, z], [x, z]].');
    return { kind: 'polygon', points: points.map((p, i) => pair(p, `${pointer}/points/${i}`, fail)) };
  }
  if (o['center'] === undefined) return fail(`${pointer}/center`, 'needs a "center" (or "points")', 'Add "center": [x, z] and a "radius" or "size".');
  const [x, z] = pair(o['center'], `${pointer}/center`, fail);
  const hasRadius = o['radius'] !== undefined;
  if (hasRadius === (o['size'] !== undefined)) {
    fail(pointer, hasRadius ? 'has both "radius" and "size"' : 'needs a "radius" or a "size"', 'Give "radius" for a circle or "size": [w, d] for a rectangle.');
  }
  if (hasRadius) {
    if (o['rotation'] !== undefined) fail(`${pointer}/rotation`, 'a circle takes no "rotation"', 'Remove "rotation".');
    const radius = o['radius'];
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) return fail(`${pointer}/radius`, 'radius must be a number above 0', 'Give the radius in meters.');
    return { kind: 'circle', x, z, radius };
  }
  const [w, d] = pair(o['size'], `${pointer}/size`, fail);
  if (!(w > 0 && d > 0)) fail(`${pointer}/size`, 'size must be positive', 'Give the full width and depth above 0.');
  const rotation = o['rotation'] ?? 0;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return fail(`${pointer}/rotation`, 'rotation must be a number (degrees)', 'Write "rotation": 0.');
  return rectFootprint(x, z, w, d, rotation);
}

/** Whether a point is inside (or within `margin` of) a footprint. */
export function footprintHits(shape: Footprint, x: number, z: number, margin = 0): boolean {
  if (shape.kind === 'circle') {
    const dx = x - shape.x;
    const dz = z - shape.z;
    const r = shape.radius + margin;
    return dx * dx + dz * dz <= r * r;
  }
  if (shape.kind === 'rect') {
    const dx = x - shape.x;
    const dz = z - shape.z;
    return Math.abs(dx * shape.cos + dz * shape.sin) <= shape.hx + margin && Math.abs(-dx * shape.sin + dz * shape.cos) <= shape.hz + margin;
  }
  let inside = false;
  const pts = shape.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j]!;
    const [bx, bz] = pts[i]!;
    if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
  }
  if (inside || margin <= 0) return inside;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j]!;
    const [bx, bz] = pts[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
    const px = ax + ex * t - x;
    const pz = az + ez * t - z;
    if (px * px + pz * pz <= margin * margin) return true;
  }
  return false;
}

/** A point that is inside the footprint (its center, or a polygon's first vertex). */
export function footprintAnchor(shape: Footprint): readonly [number, number] {
  return shape.kind === 'polygon' ? shape.points[0]! : [shape.x, shape.z];
}
