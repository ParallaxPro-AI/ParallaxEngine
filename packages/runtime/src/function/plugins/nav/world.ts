/**
 * The static world as nav sees it: a layered column model over a square grid on the ground
 * plane (x, z), built lazily per tile and cached — no up-front bake, so open worlds of any
 * size cost only the tiles that searches touch.
 *
 * Inputs, read by component id (never through another plugin):
 *   - static colliders: a `collider` that is not a trigger, on an entity with no
 *     `rigidbody`, `nav_agent`, `character` or `vehicle` (SDK: "a static wall has a
 *     Collider and no Rigidbody"); with a scene `"navmesh": {"obstacles": [...]}` only
 *     colliders on those layers count. Box, sphere, cylinder and capsule shapes are
 *     rasterized exactly (upright boxes as oriented rectangles, tilted shapes by their
 *     bounding box). Mesh and convex colliders are their model's triangles, placed as
 *     physics3d places them, read through the model geometry service (render3d): each
 *     triangle no steeper than MAX_SLOPE is a floor at its own height, each steeper one a
 *     wall over its height range (a convex collider is approximated by its model's
 *     surface, not the hull). A model still loading is retried until it lands; one with
 *     no file in this run (data-only) is not an obstacle, as it has no collider either;
 *     without a geometry service at all such colliders are listed in `unsupported`.
 *   - dynamic obstacles: a collider on an entity with a `nav_obstacle` (doors, crates,
 *     parked vehicles — a Rigidbody is allowed). Each fixed step one that moved past its
 *     `move_threshold`, turned, or was switched (`enabled`) is re-indexed, and only the
 *     tiles its old and new footprints touch are rebuilt.
 *   - generated scenery (procgen service: structures, dungeons, sweeps with collision), as
 *     world triangles, re-read when a mesh's `collisionVersion` changes;
 *   - the terrain service's heights, slopes and water level, when the scene has terrain.
 *
 * A column (cell) holds every surface an agent can stand on there, lowest first: the
 * terrain (or, without terrain, the implicit ground plane y = 0) and each collider top or
 * floor triangle, each with AGENT_HEIGHT of clearance above it (ignoring anything lower than
 * STEP_HEIGHT above the feet: curbs, floor slabs). So a road under a bridge, each storey of a
 * building and its roof are separate layers of the same cells. Surfaces within STEP_HEIGHT
 * of each other are one layer (the higher). Terrain steeper than MAX_SLOPE or more than the
 * scene's wade depth (default 0) below the water level is no layer, nor is anything outside the terrain or a terrain hole (only a
 * collider over the hole stands). The grid re-reads the terrain when its `version` or
 * `revision` changes (craters, trenches). An agent of radius r may stand on a layer when no
 * collider that would block it at that height comes within r + cell·√½ of the column's
 * center — so every point of the cell, not only its center, keeps r of clearance.
 *
 * On the implicit ground plane heights are unknown (no floor collider says where it is):
 * agents there keep their own height. A column a model floor triangle covers has no
 * implicit plane: the model is the ground there (a scene whose ground is a mesh).
 *
 * Static colliders spawned or destroyed while the scene runs (cover, generated rooms)
 * update the model at once, tile by tile; a static collider moved by code is not tracked —
 * give anything that moves a NavObstacle (or a kinematic Rigidbody, which nav ignores).
 */

import type { EntityId, Vec3 } from '../../../core/index.js';
import { Quat, Vec3 as V3 } from '../../../core/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import type { ModelGeometrySource, TerrainField } from '../../services/index.js';
import { modelScaleOf } from '../../../resource/index.js';
import { segmentBlocked } from './sight.js';

/** Agent standing height (m): what needs clearing above a surface. */
export const AGENT_HEIGHT = 1.8;
/** Highest ledge an agent steps up or down without a ramp (m). */
export const STEP_HEIGHT = 0.4;
/** Steepest walkable terrain (degrees) — as its normal's y component. */
export const MAX_SLOPE = 45;
/** Most walkable layers one column keeps (lowest first). */
export const MAX_LAYERS = 8;
/** Tile edge in cells: the unit a change rebuilds. */
export const TILE = 16;
/** The component that makes a collider a dynamic obstacle. */
export const NAV_OBSTACLE = 'nav_obstacle';
const MIN_NORMAL_Y = Math.SQRT1_2;
/** Rise per meter of the steepest walkable slope (tan MAX_SLOPE). */
const MAX_SLOPE_RISE = Math.tan((MAX_SLOPE * Math.PI) / 180);
const BUCKET = 8;
const EPS = 1e-6;

const MOVING_COMPONENTS = ['rigidbody', 'character', 'vehicle'] as const;

export type Footprint =
  | { readonly kind: 'rect'; readonly cx: number; readonly cz: number; readonly ux: number; readonly uz: number; readonly hx: number; readonly hz: number }
  | { readonly kind: 'circle'; readonly cx: number; readonly cz: number; readonly r: number }
  /** A model triangle, world space: x, y, z of its three corners. */
  | { readonly kind: 'tri'; readonly p: readonly number[]; readonly floor: boolean };

export interface StaticShape {
  readonly entity: EntityId;
  /** Which shape of the entity (a model collider has one per triangle). */
  readonly part: number;
  readonly layer: string;
  readonly foot: Footprint;
  readonly yMin: number;
  readonly yMax: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface Column {
  /** Surface height; on the implicit ground plane, 0 (for clearance only). */
  readonly h: number;
  /** On the implicit ground plane: agents keep their own height here. */
  readonly implicit: boolean;
}

/** The point of segment (ax, az)–(bx, bz) nearest (x, z), as the segment parameter. */
function segmentParam(ax: number, az: number, bx: number, bz: number, x: number, z: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const len2 = ex * ex + ez * ez;
  return len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2));
}

/** Barycentric weights of (x, z) in a triangle's ground projection; null when it is edge-on. */
function barycentric(p: readonly number[], x: number, z: number): [number, number, number] | null {
  const d = (p[5]! - p[8]!) * (p[0]! - p[6]!) + (p[6]! - p[3]!) * (p[2]! - p[8]!);
  if (Math.abs(d) < 1e-12) return null;
  const a = ((p[5]! - p[8]!) * (x - p[6]!) + (p[6]! - p[3]!) * (z - p[8]!)) / d;
  const b = ((p[8]! - p[2]!) * (x - p[6]!) + (p[0]! - p[6]!) * (z - p[8]!)) / d;
  return [a, b, 1 - a - b];
}

/**
 * The point of a triangle's ground projection nearest (x, z), with the triangle's height
 * there (for an edge-on triangle: the height of the nearest edge point).
 */
function triNearest(p: readonly number[], x: number, z: number): { x: number; z: number; y: number } {
  const w = barycentric(p, x, z);
  if (w !== null && w[0] >= -EPS && w[1] >= -EPS && w[2] >= -EPS) return { x, z, y: w[0] * p[1]! + w[1] * p[4]! + w[2] * p[7]! };
  let best = { x: 0, z: 0, y: 0 };
  let bestD = Infinity;
  for (const [i, j] of [[0, 3], [3, 6], [6, 0]] as const) {
    const t = segmentParam(p[i]!, p[i + 2]!, p[j]!, p[j + 2]!, x, z);
    const px = p[i]! + (p[j]! - p[i]!) * t;
    const pz = p[i + 2]! + (p[j + 2]! - p[i + 2]!) * t;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x: px, z: pz, y: p[i + 1]! + (p[j + 1]! - p[i + 1]!) * t };
    }
  }
  return best;
}

/** Distance from (x, z) to a footprint (0 inside). */
export function footprintDistance(foot: Footprint, x: number, z: number): number {
  if (foot.kind === 'tri') {
    const near = triNearest(foot.p, x, z);
    return Math.hypot(near.x - x, near.z - z);
  }
  const dx = x - foot.cx;
  const dz = z - foot.cz;
  if (foot.kind === 'circle') return Math.max(0, Math.sqrt(dx * dx + dz * dz) - foot.r);
  const lx = Math.abs(dx * foot.ux + dz * foot.uz) - foot.hx;
  const lz = Math.abs(-dx * foot.uz + dz * foot.ux) - foot.hz;
  const ox = Math.max(lx, 0);
  const oz = Math.max(lz, 0);
  return Math.sqrt(ox * ox + oz * oz);
}

/**
 * Whether the collider would block an agent standing at height `h` near (x, z): its
 * height range overlaps the agent's body above the step height. A model floor triangle
 * counts at its height nearest (x, z) (a ramp under a neighbour's feet is not a wall), and
 * only above what a walkable slope (MAX_SLOPE) could climb to over the distance to it: the
 * foot of a ramp or a flight of stairs is where an agent walks onto it, not a wall.
 */
export function blocksAt(shape: StaticShape, h: number, x: number, z: number): boolean {
  if (shape.foot.kind === 'tri' && shape.foot.floor) {
    const near = triNearest(shape.foot.p, x, z);
    const climb = Math.hypot(near.x - x, near.z - z) * MAX_SLOPE_RISE;
    return near.y < h + AGENT_HEIGHT && near.y > h + STEP_HEIGHT + climb;
  }
  return shape.yMin < h + AGENT_HEIGHT && shape.yMax > h + STEP_HEIGHT;
}

/** The height an agent can stand on at (x, z) inside the shape's footprint, or null (walls). */
export function surfaceAt(shape: StaticShape, x: number, z: number): number | null {
  if (shape.foot.kind !== 'tri') return shape.yMax;
  return shape.foot.floor ? triNearest(shape.foot.p, x, z).y : null;
}

function boundsOf(foot: Footprint): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (foot.kind === 'tri') {
    const p = foot.p;
    return { minX: Math.min(p[0]!, p[3]!, p[6]!), maxX: Math.max(p[0]!, p[3]!, p[6]!), minZ: Math.min(p[2]!, p[5]!, p[8]!), maxZ: Math.max(p[2]!, p[5]!, p[8]!) };
  }
  if (foot.kind === 'circle') return { minX: foot.cx - foot.r, maxX: foot.cx + foot.r, minZ: foot.cz - foot.r, maxZ: foot.cz + foot.r };
  const ex = Math.abs(foot.ux) * foot.hx + Math.abs(foot.uz) * foot.hz;
  const ez = Math.abs(foot.uz) * foot.hx + Math.abs(foot.ux) * foot.hz;
  return { minX: foot.cx - ex, maxX: foot.cx + ex, minZ: foot.cz - ez, maxZ: foot.cz + ez };
}

function aabbFootprint(points: readonly Vec3[]): { foot: Footprint; yMin: number; yMax: number } {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  return {
    foot: { kind: 'rect', cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, ux: 1, uz: 0, hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 },
    yMin: minY,
    yMax: maxY,
  };
}

/**
 * Whether a record's collider is part of the nav world: static (no body that moves it), or
 * a NavObstacle's. An agent's own collider never is (agents avoid each other, not themselves).
 */
export function isStaticCollider(record: EntityRecord): boolean {
  const collider = record.components.get('collider');
  if (collider === undefined || collider['trigger'] === true || record.components.has('nav_agent')) return false;
  return record.components.has(NAV_OBSTACLE) || !MOVING_COMPONENTS.some((id) => record.components.has(id));
}

/** Model geometry for mesh/convex colliders: the service, or undefined when no plugin provides it. */
export type GeometryLookup = () => ModelGeometrySource | undefined;

/**
 * The shapes a static collider occupies: one for a primitive, one per triangle for a
 * mesh or convex collider; 'pending' while its model loads; 'unsupported' without a
 * geometry service (or for a shape that isn't 3D). A model with no file in this run (data-only) occupies nothing.
 */
export function shapesOf(record: EntityRecord, collider: Fields, geometry: GeometryLookup): StaticShape[] | 'pending' | 'unsupported' {
  if (collider['shape'] !== 'mesh' && collider['shape'] !== 'convex') {
    const shape = shapeOf(record, collider);
    return shape === null ? 'unsupported' : [shape];
  }
  const model = record.components.get('model');
  const ref = model?.['model'];
  const stored = typeof ref === 'object' && ref !== null && typeof (ref as { toJSON?: unknown }).toJSON === 'function' ? (ref as { toJSON(): unknown }).toJSON() : ref;
  const source = geometry();
  if (source === undefined) return 'unsupported';
  // No Model: physics3d raises PP3160 for this collider.
  if (typeof stored !== 'string') return [];
  const mesh = source.geometry(stored);
  if (mesh === undefined) return 'pending';
  if (mesh === null) return [];
  // As physics3d places it: (vertex × Model.scale, turned by Model.rotation_offset, + Model.offset + collider offset) × scale, then the body.
  const t = record.transform;
  const position = t.worldPosition();
  const q = t.worldRotation();
  const scale = t.worldScale();
  const mo = model!['offset'] instanceof V3 ? model!['offset'] as Vec3 : V3.ZERO;
  const mr = model!['rotation_offset'] instanceof V3 ? Quat.from_euler(model!['rotation_offset'] as Vec3) : null;
  const k = modelScaleOf(model!, `entity ${record.id} model`);
  const co = collider['offset'] as Vec3;
  const layer = typeof collider['layer'] === 'string' ? collider['layer'] : 'default';
  const v = mesh.vertices;
  const world = new Float64Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const r = mr === null ? null : mr.rotate(new V3(v[i]!, v[i + 1]!, v[i + 2]!));
    const x = ((r?.x ?? v[i]!) * k + mo.x + co.x) * scale.x;
    const y = ((r?.y ?? v[i + 1]!) * k + mo.y + co.y) * scale.y;
    const z = ((r?.z ?? v[i + 2]!) * k + mo.z + co.z) * scale.z;
    // q · (x, y, z) · q⁻¹
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    world[i] = position.x + x + q.w * tx + (q.y * tz - q.z * ty);
    world[i + 1] = position.y + y + q.w * ty + (q.z * tx - q.x * tz);
    world[i + 2] = position.z + z + q.w * tz + (q.x * ty - q.y * tx);
  }
  return triangleShapes(record.id, layer, world, mesh.indices);
}

/** World-space triangles as shapes: floors where the face is walkable-flat, walls otherwise. */
export function triangleShapes(entity: EntityId, layer: string, world: ArrayLike<number>, idx: ArrayLike<number>): StaticShape[] {
  const shapes: StaticShape[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const p: number[] = [];
    for (let c = 0; c < 3; c++) p.push(world[idx[i + c]! * 3]!, world[idx[i + c]! * 3 + 1]!, world[idx[i + c]! * 3 + 2]!);
    const ux = p[3]! - p[0]!; const uy = p[4]! - p[1]!; const uz = p[5]! - p[2]!;
    const wx = p[6]! - p[0]!; const wy = p[7]! - p[1]!; const wz = p[8]! - p[2]!;
    const nx = uy * wz - uz * wy; const ny = uz * wx - ux * wz; const nz = ux * wy - uy * wx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    const foot: Footprint = { kind: 'tri', p, floor: Math.abs(ny) / length >= MIN_NORMAL_Y };
    shapes.push({ entity, part: shapes.length, layer, foot, yMin: Math.min(p[1]!, p[4]!, p[7]!), yMax: Math.max(p[1]!, p[4]!, p[7]!), ...boundsOf(foot) });
  }
  return shapes;
}

/** Generated scenery as nav reads it (the procgen service's meshes with collision). */
export interface GeneratedSolid {
  readonly key: string;
  readonly entity: EntityId | null;
  /** Collision layer; absent: "default". */
  readonly layer?: string;
  /** Read instead of `collision` when present (procgen: stairs as slopes). */
  readonly navCollision?: { readonly vertices: Float32Array; readonly indices: Uint32Array };
  readonly collision: { readonly vertices: Float32Array; readonly indices: Uint32Array } | null;
  readonly collisionVersion: number;
}

/** The pseudo entity of scene-level generated scenery (no owning entity). */
const SCENE_SOLID = -1 as EntityId;

/** The shape a primitive static collider occupies (box, sphere, capsule, cylinder); null for a shape physics3d rejects. */
function shapeOf(record: EntityRecord, collider: Fields): StaticShape | null {
  const t = record.transform;
  const rotation = t.worldRotation();
  const scale = t.worldScale();
  const center = t.toWorld(collider['offset'] as Vec3);
  const up = rotation.rotate(V3.UP);
  const upright = Math.abs(up.y) > 0.999;
  const layer = typeof collider['layer'] === 'string' ? collider['layer'] : 'default';
  const done = (foot: Footprint, yMin: number, yMax: number): StaticShape => ({ entity: record.id, part: 0, layer, foot, yMin, yMax, ...boundsOf(foot) });
  const sx = Math.abs(scale.x); const sy = Math.abs(scale.y); const sz = Math.abs(scale.z);

  switch (collider['shape']) {
    case 'box': {
      const size = collider['size'] as Vec3;
      const hx = (size.x * sx) / 2; const hy = (size.y * sy) / 2; const hz = (size.z * sz) / 2;
      if (upright) {
        const axis = rotation.rotate(V3.RIGHT);
        const length = Math.hypot(axis.x, axis.z);
        return done({ kind: 'rect', cx: center.x, cz: center.z, ux: axis.x / length, uz: axis.z / length, hx, hz }, center.y - hy, center.y + hy);
      }
      const corners: Vec3[] = [];
      for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) corners.push(center.__add__(rotation.rotate(new V3(a * hx, b * hy, c * hz))));
      const box = aabbFootprint(corners);
      return done(box.foot, box.yMin, box.yMax);
    }
    case 'sphere': {
      const r = (collider['radius'] as number) * Math.max(sx, sy, sz);
      return done({ kind: 'circle', cx: center.x, cz: center.z, r }, center.y - r, center.y + r);
    }
    case 'cylinder':
    case 'capsule': {
      const r = (collider['radius'] as number) * Math.max(sx, sz);
      const half = Math.max((collider['height'] as number) / 2, collider['shape'] === 'capsule' ? (collider['radius'] as number) : 0) * sy;
      if (upright) return done({ kind: 'circle', cx: center.x, cz: center.z, r }, center.y - half, center.y + half);
      const axis = up.__mul__(half);
      const ends = [center.__add__(axis), center.__sub__(axis)];
      const points = ends.flatMap((e) => [e.__add__(new V3(r, r, r)), e.__sub__(new V3(r, r, r))]);
      const box = aabbFootprint(points);
      return done(box.foot, box.yMin, box.yMax);
    }
    default:
      return null;
  }
}

/** A rectangle on the ground plane (m). */
export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function union(a: Rect | null, b: Rect): Rect {
  if (a === null) return b;
  return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) };
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return a.minX - margin <= b.maxX && a.maxX + margin >= b.minX && a.minZ - margin <= b.maxZ && a.maxZ + margin >= b.minZ;
}

const LOG_LENGTH = 256;

/**
 * Where the world changed, revision by revision: each push is one revision with the
 * rectangle it touched (null: everywhere). Readers that fell further behind than the log
 * keeps treat everything as changed.
 */
export class ChangeLog {
  #revision = 0;
  readonly #entries: Array<{ readonly revision: number; readonly rect: Rect | null }> = [];

  get revision(): number { return this.#revision; }

  push(rect: Rect | null): void {
    this.#entries.push({ revision: ++this.#revision, rect });
    if (this.#entries.length > LOG_LENGTH) this.#entries.shift();
  }

  /** Rectangles changed after `revision`, or null when unknown (everything, or too old). */
  since(revision: number): Rect[] | null {
    if (revision === this.#revision) return [];
    const first = this.#entries[0];
    if (first === undefined || first.revision > revision + 1) return null;
    const out: Rect[] = [];
    for (const entry of this.#entries) {
      if (entry.revision <= revision) continue;
      if (entry.rect === null) return null;
      out.push(entry.rect);
    }
    return out;
  }
}

function boundsOfShapes(shapes: readonly StaticShape[]): Rect | null {
  let rect: Rect | null = null;
  for (const s of shapes) rect = union(rect, s);
  return rect;
}

/** A dynamic obstacle's pose when it was last indexed. */
interface Pose {
  readonly x: number; readonly y: number; readonly z: number;
  readonly qx: number; readonly qy: number; readonly qz: number; readonly qw: number;
  readonly sx: number; readonly sy: number; readonly sz: number;
  readonly enabled: boolean;
}

function poseOf(record: EntityRecord): Pose {
  const p = record.transform.worldPosition();
  const q = record.transform.worldRotation();
  const s = record.transform.worldScale();
  const enabled = record.components.get(NAV_OBSTACLE)?.['enabled'] !== false;
  return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, sx: s.x, sy: s.y, sz: s.z, enabled };
}

/** Whether a dynamic obstacle moved (past `threshold` m), turned, rescaled or was switched since `was`. */
function poseMoved(was: Pose, now: Pose, threshold: number): boolean {
  if (was.enabled !== now.enabled) return true;
  if (!now.enabled) return false;
  if (Math.hypot(now.x - was.x, now.y - was.y, now.z - was.z) > threshold) return true;
  const dot = Math.abs(was.qx * now.qx + was.qy * now.qy + was.qz * now.qz + was.qw * now.qw);
  // About 2°.
  if (dot < 0.99985) return true;
  return Math.abs(now.sx - was.sx) + Math.abs(now.sy - was.sy) + Math.abs(now.sz - was.sz) > 1e-6;
}

/** Static shapes (and NavObstacle shapes) in a spatial hash, with a log of where they changed. */
export class Obstacles {
  readonly #shapes = new Map<EntityId, StaticShape[]>();
  /** Generated scenery (procgen meshes) by mesh key, at the collision version indexed. */
  readonly #generated = new Map<string, { readonly version: number; readonly shapes: StaticShape[] }>();
  readonly #buckets = new Map<number, Set<StaticShape>>();
  readonly #geometry: GeometryLookup;
  /** NavObstacle entities and the pose they were indexed at (`track` re-indexes the ones that moved). */
  readonly #dynamic = new Map<EntityId, Pose>();
  /** Entities whose static collider nav can't rasterize (mesh, convex without a geometry service), in arrival order. */
  readonly unsupported = new Set<EntityId>();
  /** Entities whose collider's model is still loading: `settle` retries them. */
  readonly pending = new Set<EntityId>();
  /** Layers that count (scene "navmesh" obstacles), or null for every layer. */
  layers: readonly string[] | null = null;
  /** Where shapes were added or removed, per revision. */
  readonly changes = new ChangeLog();

  constructor(geometry: GeometryLookup = () => undefined) {
    this.#geometry = geometry;
  }

  get revision(): number { return this.changes.revision; }
  /** Entities with shapes. */
  get size(): number { return this.#shapes.size; }
  /** Whether any NavObstacle is tracked (`track` has work to do). */
  get tracking(): boolean { return this.#dynamic.size > 0; }

  clear(): void {
    this.#shapes.clear();
    this.#generated.clear();
    this.#buckets.clear();
    this.#dynamic.clear();
    this.unsupported.clear();
    this.pending.clear();
    this.changes.push(null);
  }

  #keys(minX: number, maxX: number, minZ: number, maxZ: number, visit: (key: number) => void): void {
    for (let bx = Math.floor(minX / BUCKET); bx <= Math.floor(maxX / BUCKET); bx++) {
      for (let bz = Math.floor(minZ / BUCKET); bz <= Math.floor(maxZ / BUCKET); bz++) visit((bx + 0x100000) * 0x200000 + (bz + 0x100000));
    }
  }

  /** Index (or re-index) a record: kept when it holds a static collider (or a NavObstacle's collider). */
  update(record: EntityRecord): void {
    this.remove(record.id);
    if (!isStaticCollider(record)) return;
    if (record.components.has(NAV_OBSTACLE)) {
      const pose = poseOf(record);
      this.#dynamic.set(record.id, pose);
      if (!pose.enabled) return;
    }
    const collider = record.components.get('collider')!;
    const shapes = shapesOf(record, collider, this.#geometry);
    if (shapes === 'unsupported') {
      this.unsupported.add(record.id);
      return;
    }
    if (shapes === 'pending') {
      this.pending.add(record.id);
      return;
    }
    const layer = typeof collider['layer'] === 'string' ? collider['layer'] : 'default';
    if (shapes.length === 0 || (this.layers !== null && !this.layers.includes(layer))) return;
    this.#shapes.set(record.id, shapes);
    this.#index(shapes);
    this.changes.push(boundsOfShapes(shapes));
  }

  /**
   * Re-index NavObstacles that moved past their `move_threshold`, turned, or were switched
   * on or off since they were indexed (`get` reads a live record). Only the tiles their old
   * and new footprints touch are rebuilt.
   */
  track(get: (id: EntityId) => EntityRecord | undefined): void {
    for (const [id, was] of [...this.#dynamic]) {
      const record = get(id);
      if (record === undefined) {
        this.remove(id);
        continue;
      }
      const threshold = record.components.get(NAV_OBSTACLE)?.['move_threshold'];
      if (poseMoved(was, poseOf(record), typeof threshold === 'number' ? threshold : 0.1)) this.update(record);
    }
  }

  #index(shapes: readonly StaticShape[]): void {
    for (const shape of shapes) {
      this.#keys(shape.minX, shape.maxX, shape.minZ, shape.maxZ, (key) => {
        const set = this.#buckets.get(key) ?? new Set<StaticShape>();
        set.add(shape);
        this.#buckets.set(key, set);
      });
    }
  }

  #unindex(shapes: readonly StaticShape[]): void {
    for (const shape of shapes) this.#keys(shape.minX, shape.maxX, shape.minZ, shape.maxZ, (key) => this.#buckets.get(key)?.delete(shape));
  }

  /**
   * Bring generated scenery (structures, dungeons, sweeps: procgen meshes with collision,
   * world-space triangles in their `layer`, "default" when absent) in line: a mesh is
   * re-read when its `collisionVersion` changes and dropped when its key goes away.
   */
  syncGenerated(meshes: readonly GeneratedSolid[]): void {
    const seen = new Set<string>();
    for (const mesh of meshes) {
      const layer = mesh.layer ?? 'default';
      if (mesh.collision === null || (this.layers !== null && !this.layers.includes(layer))) continue;
      seen.add(mesh.key);
      const had = this.#generated.get(mesh.key);
      if (had?.version === mesh.collisionVersion) continue;
      if (had !== undefined) this.#unindex(had.shapes);
      const solid = mesh.navCollision ?? mesh.collision;
      const shapes = triangleShapes(mesh.entity ?? SCENE_SOLID, layer, solid.vertices, solid.indices);
      this.#generated.set(mesh.key, { version: mesh.collisionVersion, shapes });
      this.#index(shapes);
      const was = had === undefined ? null : boundsOfShapes(had.shapes);
      const now = boundsOfShapes(shapes);
      this.changes.push(was === null ? now : now === null ? was : union(was, now));
    }
    for (const [key, had] of this.#generated) {
      if (seen.has(key)) continue;
      this.#unindex(had.shapes);
      this.#generated.delete(key);
      this.changes.push(boundsOfShapes(had.shapes));
    }
  }

  /** Retry colliders whose models were loading (`get` reads a live record). */
  settle(get: (id: EntityId) => EntityRecord | undefined): void {
    for (const id of [...this.pending]) {
      const record = get(id);
      if (record === undefined) this.pending.delete(id);
      else this.update(record);
    }
  }

  remove(id: EntityId): void {
    this.unsupported.delete(id);
    this.pending.delete(id);
    this.#dynamic.delete(id);
    const shapes = this.#shapes.get(id);
    if (shapes === undefined) return;
    this.#shapes.delete(id);
    this.#unindex(shapes);
    this.changes.push(boundsOfShapes(shapes));
  }

  /**
   * Whether static geometry fills the ground point (x, z) at height y: a shape spanning y
   * whose footprint comes within `reach` of the point. Floors don't count (they are under
   * the point, not around it); a wall triangle has no thickness, so `reach` is what lets a
   * coarse grid (fog of war) see a thin wall between its sample points.
   */
  opaque(x: number, z: number, y: number, reach: number): boolean {
    return this.near(x - reach, x + reach, z - reach, z + reach).some((s) => {
      if (s.foot.kind === 'tri' && s.foot.floor) return false;
      return s.yMin <= y && s.yMax >= y && footprintDistance(s.foot, x, z) <= reach;
    });
  }

  /** Shapes whose bounds overlap the rectangle, in entity id then part order. */
  near(minX: number, maxX: number, minZ: number, maxZ: number): StaticShape[] {
    const found = new Set<StaticShape>();
    this.#keys(minX, maxX, minZ, maxZ, (key) => {
      for (const s of this.#buckets.get(key) ?? []) {
        if (s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ) found.add(s);
      }
    });
    return [...found].sort((a, b) => a.entity - b.entity || a.part - b.part);
  }
}

/** Cell coordinates packed into one number (|index| < 2^20). */
export function cellKey(i: number, k: number): number {
  return (i + 0x100000) * 0x200000 + (k + 0x100000);
}

/** A search node: a cell and one of its layers, packed into one number. */
export function nodeKey(i: number, k: number, layer: number): number {
  return cellKey(i, k) * MAX_LAYERS + layer;
}

/** A point in world space (plain: crosses threads). */
export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What an off-mesh link joins, as the search reads it (links.ts). */
export interface NavLinkData {
  /** The NavLink entity, or -1 for a scene "navmesh" link. */
  readonly entity: number;
  readonly kind: string;
  readonly start: Point3;
  readonly end: Point3;
  readonly bidirectional: boolean;
  /** Extra cost (m) on top of the link's length. */
  readonly cost: number;
}

/**
 * What a path search reads: the walkable layers of each column, standability per layer
 * and agent radius, steps between layers, authored off-mesh links and (for automatic
 * jump/drop links) whether a jump's arc is clear. The live `NavGrid` and a baked copy
 * (jobs.ts) both implement it, so the one search in search.ts runs on either thread.
 */
export interface NavField {
  /** Cell edge (m). */
  readonly cell: number;
  /** Changes whenever anything a search reads changed (search.ts caches link lookups by it). */
  readonly version: number;
  index(v: number): number;
  center(i: number): number;
  /** The walkable layers of cell (i, k), lowest first (at most MAX_LAYERS); empty: none. */
  columns(i: number, k: number): readonly Column[];
  /** Whether an agent of `radius` can stand on layer `layer` of cell (i, k). */
  standable(i: number, k: number, layer: number, radius: number): boolean;
  step(a: Column, b: Column): boolean;
  /** Authored off-mesh links (NavLink components, the scene's "navmesh" links). */
  links(): readonly NavLinkData[];
  /** Whether a jump's arc from a to b crosses no static geometry (a baked field can't tell: true). */
  passable(a: Point3, b: Point3): boolean;
}

/** Whether an agent can step between two adjacent standable columns. */
export function canStep(a: Column, b: Column): boolean {
  return Math.abs(a.h - b.h) <= STEP_HEIGHT + EPS;
}

/** What links.ts gives the grid: the links and where they changed. */
export interface LinkSource {
  readonly changes: ChangeLog;
  list(): readonly NavLinkData[];
}

interface Tile {
  readonly columns: Map<number, readonly Column[]>;
  readonly clear: Map<number, Map<number, boolean>>;
}

const NO_LINKS: LinkSource = { changes: new ChangeLog(), list: () => [] };

/**
 * Layered columns and per-radius standability, cached per TILE×TILE-cell tile. A change to
 * the static world (a collider spawned or destroyed, a NavObstacle moved, generated
 * scenery re-read) drops only the tiles its footprint touches, grown by the widest agent
 * reach seen; a terrain change drops them all. `generation` counts changes and
 * `dirtySince` says whether one touched a rectangle, so agents replan only when their own
 * path was affected.
 */
export class NavGrid implements NavField {
  readonly cell: number;
  readonly #obstacles: Obstacles;
  readonly #terrain: () => TerrainField | null;
  readonly #links: LinkSource;
  #obstaclesSeen = -1;
  #linksSeen = 0;
  #terrainVersion = -1;
  #terrainRevision = -1;
  readonly #tiles = new Map<number, Tile>();
  /** One entry per change the grid took in (its revision is the generation). */
  readonly #log = new ChangeLog();
  /** The widest standability reach asked for: how far a change's footprint spreads. */
  #reach = 0;
  /** Tiles dropped since construction (tests and the editor's stats read it). */
  rebuilt = 0;
  /** How deep (m) terrain may be under the water level and still be walked (wading). */
  #wadeDepth = 0;

  constructor(cell: number, obstacles: Obstacles, terrain: () => TerrainField | null, links: LinkSource = NO_LINKS) {
    this.cell = cell;
    this.#obstacles = obstacles;
    this.#terrain = terrain;
    this.#links = links;
  }

  #fresh(): void {
    const terrain = this.#terrain();
    const version = terrain?.version ?? 0;
    const terrainRevision = terrain?.revision ?? 0;
    const obstacles = this.#obstacles.revision;
    const links = this.#links.changes.revision;
    if (this.#obstaclesSeen === obstacles && this.#linksSeen === links && this.#terrainVersion === version && this.#terrainRevision === terrainRevision) return;
    let everything = this.#terrainVersion !== version || this.#terrainRevision !== terrainRevision;
    this.#terrainVersion = version;
    this.#terrainRevision = terrainRevision;
    const rects: Rect[] = [];
    if (this.#obstaclesSeen !== obstacles) {
      const changed = this.#obstacles.changes.since(this.#obstaclesSeen);
      if (changed === null) everything = true;
      else rects.push(...changed);
      this.#obstaclesSeen = obstacles;
    }
    if (everything) {
      this.rebuilt += this.#tiles.size;
      this.#tiles.clear();
    } else {
      const margin = this.#reach + this.cell;
      const span = TILE * this.cell;
      for (const rect of rects) {
        for (let tx = Math.floor((rect.minX - margin) / span); tx <= Math.floor((rect.maxX + margin) / span); tx++) {
          for (let tz = Math.floor((rect.minZ - margin) / span); tz <= Math.floor((rect.maxZ + margin) / span); tz++) {
            if (this.#tiles.delete(cellKey(tx, tz))) this.rebuilt++;
          }
        }
      }
    }
    if (this.#linksSeen !== links) {
      const changed = this.#links.changes.since(this.#linksSeen);
      if (changed === null) everything = true;
      else rects.push(...changed);
      this.#linksSeen = links;
    }
    if (everything) this.#log.push(null);
    else for (const rect of rects) this.#log.push(rect);
  }

  get wadeDepth(): number {
    return this.#wadeDepth;
  }

  /** Terrain at most this deep under the water level stays walkable; a change re-reads every tile. */
  set wadeDepth(depth: number) {
    if (depth === this.#wadeDepth) return;
    this.#wadeDepth = depth;
    this.rebuilt += this.#tiles.size;
    this.#tiles.clear();
    this.#log.push(null);
  }

  /** Bumped whenever the static world (obstacles, terrain, links) changed since the last read: paths planned at an older one may be stale. */
  get generation(): number {
    this.#fresh();
    return this.#log.revision;
  }

  get version(): number {
    return this.generation;
  }

  /**
   * Whether a change after `generation` touched the rectangle (grown by the widest agent
   * reach): a path planned then that stays inside it may cross something new.
   */
  dirtySince(generation: number, rect: Rect): boolean {
    this.#fresh();
    const changed = this.#log.since(generation);
    if (changed === null) return true;
    const margin = this.#reach + this.cell;
    return changed.some((r) => overlaps(r, rect, margin));
  }

  index(v: number): number {
    return Math.floor(v / this.cell);
  }

  center(i: number): number {
    return (i + 0.5) * this.cell;
  }

  #tile(i: number, k: number): Tile {
    const key = cellKey(Math.floor(i / TILE), Math.floor(k / TILE));
    let tile = this.#tiles.get(key);
    if (tile === undefined) {
      tile = { columns: new Map(), clear: new Map() };
      this.#tiles.set(key, tile);
    }
    return tile;
  }

  columns(i: number, k: number): readonly Column[] {
    this.#fresh();
    const tile = this.#tile(i, k);
    const key = cellKey(i, k);
    const cached = tile.columns.get(key);
    if (cached !== undefined) return cached;
    const layers = this.#surfaces(this.center(i), this.center(k));
    tile.columns.set(key, layers);
    return layers;
  }

  /**
   * Every surface an agent can stand on at (x, z): the ground (terrain, or the implicit
   * plane) and each collider top or floor triangle over it with AGENT_HEIGHT of headroom.
   * Surfaces within STEP_HEIGHT of each other are one layer, the higher (a slab on the
   * ground is stood on, not in). Terrain too steep or deeper under water than the wade depth is no layer; colliders
   * above it still are (a bridge over a river).
   */
  #surfaces(x: number, z: number): readonly Column[] {
    const terrain = this.#terrain();
    let base = 0;
    // Over a terrain hole the ground is gone: only colliders (a bridge, a tunnel floor) stand.
    let hole = false;
    if (terrain !== null) {
      if (!terrain.contains(x, z)) return [];
      base = terrain.heightAt(x, z);
      hole = terrain.holeAt(x, z);
    }
    const spans = this.#obstacles.near(x, x, z, z).filter((s) => footprintDistance(s.foot, x, z) <= EPS);
    // A model floor over the column replaces the implicit ground plane (the model is the ground).
    const hasBase = terrain !== null ? !hole : !spans.some((s) => s.foot.kind === 'tri' && s.foot.floor);
    const candidates: Array<{ h: number; collider: boolean }> = hasBase ? [{ h: base, collider: false }] : [];
    for (const s of spans) {
      const top = surfaceAt(s, x, z);
      if (top !== null && (!hasBase || top >= base - EPS)) candidates.push({ h: top, collider: true });
    }
    candidates.sort((a, b) => a.h - b.h || Number(b.collider) - Number(a.collider));
    const clear: Array<{ h: number; collider: boolean }> = [];
    for (const c of candidates) {
      const last = clear[clear.length - 1];
      if (last !== undefined && Math.abs(last.h - c.h) <= EPS) {
        last.collider ||= c.collider;
        continue;
      }
      if (spans.some((s) => blocksAt(s, c.h, x, z))) continue;
      if (!c.collider && terrain !== null) {
        if (terrain.normalAt(x, z).y < MIN_NORMAL_Y) continue;
        if (terrain.waterLevel !== null && c.h < terrain.waterLevel - this.#wadeDepth) continue;
      }
      clear.push({ ...c });
    }
    const layers: Column[] = [];
    for (let n = 0; n < clear.length && layers.length < MAX_LAYERS; n++) {
      const next = clear[n + 1];
      if (next !== undefined && next.h <= clear[n]!.h + STEP_HEIGHT + EPS) continue;
      layers.push({ h: clear[n]!.h, implicit: terrain === null && !clear[n]!.collider });
    }
    return layers;
  }

  standable(i: number, k: number, layer: number, radius: number): boolean {
    const column = this.columns(i, k)[layer];
    if (column === undefined) return false;
    const tile = this.#tile(i, k);
    let byRadius = tile.clear.get(radius);
    if (byRadius === undefined) {
      byRadius = new Map();
      tile.clear.set(radius, byRadius);
    }
    const key = nodeKey(i, k, layer);
    const cached = byRadius.get(key);
    if (cached !== undefined) return cached;
    const x = this.center(i);
    const z = this.center(k);
    const reach = radius + this.cell * Math.SQRT1_2;
    if (reach > this.#reach) this.#reach = reach;
    const clear = !this.#obstacles.near(x - reach, x + reach, z - reach, z + reach)
      .some((s) => blocksAt(s, column.h, x, z) && footprintDistance(s.foot, x, z) < reach);
    byRadius.set(key, clear);
    return clear;
  }

  step(a: Column, b: Column): boolean {
    return canStep(a, b);
  }

  links(): readonly NavLinkData[] {
    return this.#links.list();
  }

  passable(a: Point3, b: Point3): boolean {
    return !segmentBlocked(this.#obstacles, this.#terrain(), a as Vec3, b as Vec3, new Set());
  }
}
