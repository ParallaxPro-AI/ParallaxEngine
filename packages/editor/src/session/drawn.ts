/**
 * What the last frame drew, per entity: the renderer's own frame description (`Frame3d` /
 * `Frame2d`, the port's types) turned into shapes with world bounds. Picking and
 * observation read this, so an entity is found where it was drawn — not where its
 * transform says it might be — and something not drawn is never "on screen".
 */

import { Vec3 } from '@parallax/runtime/core';
import type { Affine2d, EntityId, Frame2d, Frame3d, Geometry3d } from '@parallax/runtime/core';
import { MESH_INSTANCE_STRIDE, BILLBOARD_STRIDE } from '@parallax/runtime/core';
import type { GameRuntime } from '@parallax/runtime/api';
import { view2d, view3d } from './view_math.js';
import type { ScreenView } from './view_math.js';

export interface Box3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A 3D draw: local box under a local → world matrix (column-major). */
export interface Drawn3d {
  readonly dimension: '3d';
  readonly entity: EntityId;
  readonly kind: 'mesh' | 'skinned' | 'billboard' | 'text';
  readonly matrix: readonly number[];
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** Triangles for exact picking (meshes; skinned meshes are boxed in their bind pose). */
  readonly geometry: Geometry3d | null;
  /** Drawing order (later draws are on top in 2D; 3D sorts by depth instead). */
  readonly order: number;
}

/** A 2D draw: a centered local rect (or ellipse) under an affine transform, or world points. */
export interface Drawn2d {
  readonly dimension: '2d';
  readonly entity: EntityId;
  readonly kind: 'image' | 'rect' | 'ellipse' | 'text' | 'points';
  readonly transform: Affine2d | null;
  readonly size: readonly [number, number];
  /** World x, y pairs (particles, lines). */
  readonly points: readonly number[] | null;
  readonly z: number;
  readonly order: number;
}

export type Drawn = Drawn3d | Drawn2d;

export interface DrawnFrame {
  readonly dimension: '2d' | '3d';
  readonly frame: number;
  readonly views: readonly ScreenView[];
  readonly shapes: readonly Drawn[];
}

function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  return new Vec3(
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  );
}

export function boxCorners(shape: Drawn3d): Vec3[] {
  const [x0, y0, z0] = shape.min as [number, number, number];
  const [x1, y1, z1] = shape.max as [number, number, number];
  const out: Vec3[] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push(transformPoint(shape.matrix, x, y, z));
  return out;
}

function corners2d(shape: Drawn2d): Vec3[] {
  if (shape.points !== null) {
    const out: Vec3[] = [];
    for (let i = 0; i + 1 < shape.points.length; i += 2) out.push(new Vec3(shape.points[i]!, shape.points[i + 1]!, shape.z));
    return out;
  }
  const [a, b, c, d, e, f] = shape.transform!;
  const hw = shape.size[0] / 2;
  const hh = shape.size[1] / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new Vec3(a * x! + c * y! + e, b * x! + d * y! + f, shape.z));
}

/** A shape's corners in world space (the 8 of a 3D box; 4 of a 2D rect; a 2D shape's points). */
export function worldCorners(shape: Drawn): Vec3[] {
  return shape.dimension === '3d' ? boxCorners(shape) : corners2d(shape);
}

export function boundsOf(points: readonly Vec3[]): Box3 | null {
  if (points.length === 0) return null;
  let [minX, minY, minZ] = [Infinity, Infinity, Infinity];
  let [maxX, maxY, maxZ] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z);
  }
  return { min: new Vec3(minX, minY, minZ), max: new Vec3(maxX, maxY, maxZ) };
}

function shapes3d(frame: Frame3d): Drawn3d[] {
  const out: Drawn3d[] = [];
  let order = 0;
  for (const batch of frame.meshes) {
    for (let i = 0; i < batch.count; i++) {
      const entity = batch.entities[i];
      if (entity === null || entity === undefined) continue;
      if (batch.fades !== undefined && batch.fades[i]! <= 0) continue;
      const at = i * MESH_INSTANCE_STRIDE;
      out.push({
        dimension: '3d', entity: entity as EntityId, kind: 'mesh', matrix: Array.from(batch.instances.subarray(at, at + 16)),
        min: batch.geometry.min, max: batch.geometry.max, geometry: batch.geometry, order: order++,
      });
    }
  }
  for (const draw of frame.skinned) {
    out.push({
      dimension: '3d', entity: draw.entity as EntityId, kind: 'skinned', matrix: Array.from(draw.model),
      min: draw.geometry.min, max: draw.geometry.max, geometry: null, order: order++,
    });
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const batch of frame.billboards) {
    if (batch.entity === null) continue;
    for (let i = 0; i < batch.count; i++) {
      const d = i * BILLBOARD_STRIDE;
      const [x, y, z, , , w, h] = [...batch.data.subarray(d, d + 7)] as number[];
      const r = Math.max(w!, h!) / 2;
      out.push({
        dimension: '3d', entity: batch.entity as EntityId, kind: 'billboard', matrix: identity,
        min: [x! - r, y! - r, z! - r], max: [x! + r, y! + r, z! + r], geometry: null, order: order++,
      });
    }
  }
  for (const text of frame.texts) {
    const [x, y, z] = text.position;
    const r = text.size;
    out.push({
      dimension: '3d', entity: text.entity as EntityId, kind: 'text', matrix: identity,
      min: [x - r, y - r, z - r], max: [x + r, y + r, z + r], geometry: null, order: order++,
    });
  }
  return out;
}

function shapes2d(frame: Frame2d): Drawn2d[] {
  const out: Drawn2d[] = [];
  frame.commands.forEach((c, order) => {
    if (c.entity === null) return;
    const base = { dimension: '2d' as const, entity: c.entity as EntityId, z: c.z, order };
    switch (c.kind) {
      case 'image':
      case 'rect':
      case 'ellipse':
        out.push({ ...base, kind: c.kind, transform: c.transform, size: [c.size[0], c.size[1]], points: null });
        break;
      case 'text': {
        // Text is centered on its origin; its width is the longest line at about 0.6 em per character.
        const lines = c.spans.map((s) => s.text).join('').split('\n');
        const width = Math.max(...lines.map((l) => l.length)) * c.size * 0.6;
        out.push({ ...base, kind: 'text', transform: c.transform, size: [width, c.size * lines.length], points: null });
        break;
      }
      case 'particles': {
        const points: number[] = [];
        for (let i = 0; i < c.count; i++) points.push(c.data[i * 8]!, c.data[i * 8 + 1]!);
        if (points.length > 0) out.push({ ...base, kind: 'points', transform: null, size: [0, 0], points });
        break;
      }
      case 'line':
        out.push({ ...base, kind: 'points', transform: null, size: [0, 0], points: [...c.points] });
        break;
    }
  });
  return out;
}

/** The last drawn frame of a game, or null before its first frame. */
export function drawnFrame(runtime: GameRuntime): DrawnFrame | null {
  if (runtime.render3d !== undefined) {
    const frame = runtime.render3d.lastFrame;
    if (frame === undefined) return null;
    return { dimension: '3d', frame: frame.frame, views: frame.views.map(view3d), shapes: shapes3d(frame) };
  }
  const frame = runtime.render2d?.lastFrame;
  if (frame === undefined) return null;
  const camera = runtime.visuals.rig.active() ?? null;
  return { dimension: '2d', frame: frame.frame, views: [view2d(frame.view, runtime.visuals.screen, camera)], shapes: shapes2d(frame) };
}

/** The view a camera drew (the editor's), else the first (the main view in split screen). */
export function viewOf(frame: DrawnFrame, camera: number | null = null): ScreenView | null {
  return (camera === null ? undefined : frame.views.find((v) => v.camera === camera)) ?? frame.views[0] ?? null;
}
