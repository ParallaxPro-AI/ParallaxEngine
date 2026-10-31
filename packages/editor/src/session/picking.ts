/**
 * Picking through render bounds: what is under a screen point in the last drawn frame.
 *
 *   3D  the ray under the point against every drawn mesh — its box first, then its
 *       triangles (exact); skinned meshes, billboards and text by their boxes. Nearest wins.
 *   2D  the point against every drawn rect, image, ellipse and text, topmost first (draw
 *       order), as the player sees them.
 *
 * Render bounds rather than physics: they exist for every visible entity (with or
 * without a collider), stay right in edit mode (where physics doesn't step), and match
 * the image exactly.
 */

import { Vec3 } from '@parallax/runtime/core';
import type { EntityId } from '@parallax/runtime/core';
import { invert } from '@parallax/runtime/resource';
import { boundsOf, worldCorners } from './drawn.js';
import type { Drawn, Drawn2d, Drawn3d, DrawnFrame } from './drawn.js';
import type { PixelRect, Ray, ScreenView } from './view_math.js';

export interface PickHit {
  /** The entity whose draw was hit. */
  readonly entity: EntityId;
  /** Where (world space); in 2D on the draw's plane. */
  readonly point: Vec3;
  /** Along the ray, meters (3D); 0 in 2D. */
  readonly distance: number;
}

export interface PickOptions {
  /** Entities that can't be picked (the editor's own camera, a gizmo proxy). */
  readonly ignore?: (entity: EntityId) => boolean;
}

/** Ray vs the box [min, max] in the local space a matrix maps to world: the entry distance, or null. */
function rayBox(o: readonly number[], d: readonly number[], min: readonly number[], max: readonly number[]): number | null {
  let near = -Infinity;
  let far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-12) {
      if (o[i]! < min[i]! || o[i]! > max[i]!) return null;
      continue;
    }
    let t1 = (min[i]! - o[i]!) / d[i]!;
    let t2 = (max[i]! - o[i]!) / d[i]!;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  if (far < 0) return null;
  return Math.max(near, 0);
}

/** Möller–Trumbore: the nearest triangle hit of a local-space ray, or null. */
function rayTriangles(o: readonly number[], d: readonly number[], positions: Float32Array, indices: ArrayLike<number>): number | null {
  let best: number | null = null;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    const e1x = positions[b]! - positions[a]!; const e1y = positions[b + 1]! - positions[a + 1]!; const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!; const e2y = positions[c + 1]! - positions[a + 1]!; const e2z = positions[c + 2]! - positions[a + 2]!;
    const px = d[1]! * e2z - d[2]! * e2y; const py = d[2]! * e2x - d[0]! * e2z; const pz = d[0]! * e2y - d[1]! * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = o[0]! - positions[a]!; const ty = o[1]! - positions[a + 1]!; const tz = o[2]! - positions[a + 2]!;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y; const qy = tz * e1x - tx * e1z; const qz = tx * e1y - ty * e1x;
    const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0 && (best === null || t < best)) best = t;
  }
  return best;
}

function toLocal(inverse: ArrayLike<number>, ray: Ray): { o: number[]; d: number[] } {
  const m = inverse;
  const { x, y, z } = ray.origin;
  const { x: dx, y: dy, z: dz } = ray.direction;
  return {
    o: [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!],
    // Not renormalized: the local parameter t is the world distance along the unit world ray.
    d: [m[0]! * dx + m[4]! * dy + m[8]! * dz, m[1]! * dx + m[5]! * dy + m[9]! * dz, m[2]! * dx + m[6]! * dy + m[10]! * dz],
  };
}

/** The distance along `ray` at which it hits a 3D draw, or null. */
export function hitDistance(shape: Drawn3d, ray: Ray): number | null {
  const inverse = invert(shape.matrix);
  if (inverse === null) return null;
  const { o, d } = toLocal(inverse, ray);
  const box = rayBox(o, d, shape.min, shape.max);
  if (box === null) return null;
  const g = shape.geometry;
  if (g === null) return box;
  return rayTriangles(o, d, g.positions, g.indices);
}

/** The nearest drawn 3D entity along a ray. */
export function pickRay(frame: DrawnFrame, ray: Ray, options: PickOptions = {}): PickHit | null {
  let best: PickHit | null = null;
  for (const shape of frame.shapes) {
    if (shape.dimension !== '3d' || options.ignore?.(shape.entity) === true) continue;
    const t = hitDistance(shape, ray);
    if (t === null || (best !== null && t >= best.distance)) continue;
    best = { entity: shape.entity, distance: t, point: ray.origin.__add__(ray.direction.__mul__(t)) };
  }
  return best;
}

function inside2d(shape: Drawn2d, wx: number, wy: number): boolean {
  if (shape.transform === null) return false;
  const [a, b, c, d, e, f] = shape.transform;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return false;
  const px = wx - e;
  const py = wy - f;
  const lx = (d * px - c * py) / det;
  const ly = (-b * px + a * py) / det;
  const hw = shape.size[0] / 2;
  const hh = shape.size[1] / 2;
  if (shape.kind === 'ellipse') return hw > 0 && hh > 0 && (lx / hw) ** 2 + (ly / hh) ** 2 <= 1;
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

/** What is under a screen point in the last frame (3D: nearest; 2D: topmost). */
export function pick(frame: DrawnFrame, view: ScreenView, x: number, y: number, options: PickOptions = {}): PickHit | null {
  const ray = view.ray(x, y);
  if (frame.dimension === '3d') return pickRay(frame, ray, options);
  const wx = ray.origin.x;
  const wy = ray.origin.y;
  let best: Drawn2d | null = null;
  for (const shape of frame.shapes) {
    if (shape.dimension !== '2d' || options.ignore?.(shape.entity) === true || !inside2d(shape, wx, wy)) continue;
    // Later in the list draws on top (the list is sorted back to front).
    if (best === null || shape.order > best.order) best = shape;
  }
  return best === null ? null : { entity: best.entity, point: new Vec3(wx, wy, best.z), distance: 0 };
}

/** Each drawn entity's box on screen (pixels), from all its draws. Entities partly behind the camera use the corners in front. */
export function screenBoxes(frame: DrawnFrame, view: ScreenView): Map<EntityId, PixelRect> {
  const corners = new Map<EntityId, Vec3[]>();
  for (const shape of frame.shapes) {
    const list = corners.get(shape.entity) ?? [];
    list.push(...worldCorners(shape as Drawn));
    corners.set(shape.entity, list);
  }
  const out = new Map<EntityId, PixelRect>();
  for (const [entity, points] of corners) {
    const projected = points.map((p) => view.project(p)).filter((p) => p !== null);
    if (projected.length === 0) continue;
    const box = boundsOf(projected.map((p) => new Vec3(p.x, p.y, 0)))!;
    out.set(entity, { x: box.min.x, y: box.min.y, width: box.max.x - box.min.x, height: box.max.y - box.min.y });
  }
  return out;
}

/** Entities whose screen box overlaps a rectangle (marquee selection), in draw order. */
export function pickRect(frame: DrawnFrame, view: ScreenView, rect: PixelRect, options: PickOptions = {}): EntityId[] {
  const out: EntityId[] = [];
  for (const [entity, box] of screenBoxes(frame, view)) {
    if (options.ignore?.(entity) === true) continue;
    const overlaps = box.x <= rect.x + rect.width && box.x + box.width >= rect.x && box.y <= rect.y + rect.height && box.y + box.height >= rect.y;
    if (overlaps) out.push(entity);
  }
  return out;
}
