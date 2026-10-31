/**
 * Static geometry merging (the `static_mesh` component): meshes of an entity marked static,
 * and of everything under it, are baked into world-space geometry per chunk of the world
 * (`chunk` meters, by each mesh's origin) and material, so a level of hundreds of distinct
 * props is a handful of draws, each culled as one box.
 *
 * Merging is cached: a chunk's geometry is rebuilt only when its members change (an entity
 * added or removed, a mesh swapped, or a member moved — static means rarely, not never),
 * so on ordinary frames the same `Geometry3d` objects are handed over and the surface keeps
 * their GPU buffers. Left out of merging (drawn as usual): blended surfaces (they sort per
 * instance), skinned and morphed meshes, the viewmodel layer, level-of-detail entities and
 * outlined entities. A merged draw has no per-entity picking (`entities` is [null]).
 */

import type { EntityId, Geometry3d, Material3d, MeshBatch, Rgba, Xyz } from '../../../core/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import type { BatchSink, DrawStyle } from './draw.js';

export const STATIC_MESH = 'static_mesh';

/** Which entities are static (a `static_mesh` on themselves or an ancestor), and their chunk size, per frame. */
export class StaticRoots {
  readonly #world: World;
  readonly #chunks = new Map<EntityId, number | null>();

  constructor(world: World) {
    this.#world = world;
  }

  frame(): void {
    this.#chunks.clear();
  }

  /** The chunk size of the entity's static root, or null when it isn't static. */
  chunkOf(record: EntityRecord): number | null {
    const known = this.#chunks.get(record.id);
    if (known !== undefined) return known;
    const own = record.components.get(STATIC_MESH);
    let chunk: number | null = null;
    if (own !== undefined) chunk = own['chunk'] as number;
    else if (record.parent !== null) {
      const parent = this.#world.peek(record.parent);
      chunk = parent === undefined ? null : this.chunkOf(parent);
    }
    this.#chunks.set(record.id, chunk);
    return chunk;
  }
}

interface Member {
  readonly geometry: Geometry3d;
  readonly matrix: Float32Array;
  readonly tint: Rgba;
}

interface Group {
  readonly material: Material3d;
  readonly castShadows: boolean;
  readonly members: Member[];
}

interface Merged {
  readonly members: readonly Member[];
  readonly geometry: Geometry3d;
}

/** Collects the static entities' meshes over a frame (as `Batches` does for the rest). */
export class StaticMerge implements BatchSink {
  /** Meters per chunk side for meshes added next (the static root's `chunk`). */
  chunk = 32;
  /** Where meshes that can't be merged go (blended, morphed): the frame's ordinary batches. */
  fallback: BatchSink | null = null;
  #groups = new Map<string, Group>();
  /** Last frame's merged geometry by group key. */
  #merged = new Map<string, Merged>();
  #rebuilt = 0;

  /** Chunks rebuilt since the last call (tests, stats). */
  takeRebuilt(): number {
    const n = this.#rebuilt;
    this.#rebuilt = 0;
    return n;
  }

  add(geometry: Geometry3d, material: Material3d, castShadows: boolean, matrix: ArrayLike<number>, tint: Rgba, entity: number | null, style?: DrawStyle): void {
    if (material.alphaMode === 'blend' || (material.layers?.transmission ?? 0) > 0 || geometry.version !== undefined || tint[3] < 1) {
      this.fallback?.add(geometry, material, castShadows, matrix, tint, entity, style);
      return;
    }
    const cx = Math.floor(matrix[12]! / this.chunk);
    const cy = Math.floor(matrix[13]! / this.chunk);
    const cz = Math.floor(matrix[14]! / this.chunk);
    const key = `${this.chunk}|${cx},${cy},${cz}|${material.id}|${castShadows}`;
    let group = this.#groups.get(key);
    if (group === undefined) this.#groups.set(key, (group = { material, castShadows, members: [] }));
    group.members.push({ geometry, matrix: Float32Array.from({ length: 16 }, (_, i) => matrix[i]!), tint });
  }

  /** This frame's merged batches (one instance each); unchanged chunks reuse last frame's geometry. */
  close(): MeshBatch[] {
    const out: MeshBatch[] = [];
    const next = new Map<string, Merged>();
    for (const [key, group] of this.#groups) {
      const before = this.#merged.get(key);
      const merged = before !== undefined && sameMembers(before.members, group.members) ? before : this.#build(key, group.members);
      next.set(key, merged);
      out.push({
        geometry: merged.geometry, material: group.material, count: 1, instances: IDENTITY_INSTANCE, entities: [null], castShadows: group.castShadows,
      });
    }
    this.#merged = next;
    this.#groups = new Map();
    return out;
  }

  #build(key: string, members: readonly Member[]): Merged {
    this.#rebuilt++;
    return { members, geometry: mergeGeometry(`static:${key}#${this.#rebuilt}`, members) };
  }
}

function toLinear(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** One instance record: the identity matrix, white tint. */
const IDENTITY_INSTANCE = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1]);

function sameMembers(a: readonly Member[], b: readonly Member[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.geometry !== y.geometry || x.tint.some((c, k) => c !== y.tint[k])) return false;
    for (let k = 0; k < 16; k++) if (x.matrix[k] !== y.matrix[k]) return false;
  }
  return true;
}

/**
 * Members' geometry in world space, end to end: positions by each matrix, normals by its
 * inverse-transpose (renormalized), the tint baked into the vertex colors (in linear light,
 * as surfaces apply it). A member whose
 * matrix mirrors (negative determinant) has its winding reversed so front faces stay front.
 */
export function mergeGeometry(id: string, members: readonly Member[]): Geometry3d {
  let vertices = 0;
  let indexCount = 0;
  for (const m of members) {
    vertices += m.geometry.positions.length / 3;
    indexCount += m.geometry.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const colors = new Float32Array(vertices * 4);
  const indices = new Uint32Array(indexCount);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let v0 = 0;
  let i0 = 0;
  for (const { geometry: g, matrix: m, tint } of members) {
    const n = g.positions.length / 3;
    // Surfaces multiply vertex colors by the instance tint in linear light (layout.ts packInstance).
    const linearTint = [toLinear(tint[0]), toLinear(tint[1]), toLinear(tint[2]), tint[3]];
    // Inverse-transpose of the upper 3×3: the cofactors divided by the determinant. Normals are renormalized, so only
    // the determinant's sign matters, but it does: a mirroring matrix (det < 0) would otherwise turn every normal inward.
    const a = m[0]!; const b = m[4]!; const c = m[8]!;
    const d = m[1]!; const e = m[5]!; const f = m[9]!;
    const gg = m[2]!; const h = m[6]!; const k = m[10]!;
    const det = a * (e * k - f * h) - b * (d * k - f * gg) + c * (d * h - e * gg);
    const sign = det < 0 ? -1 : 1;
    const nm = [e * k - f * h, -(b * k - c * h), b * f - c * e, -(d * k - f * gg), a * k - c * gg, -(a * f - c * d), d * h - e * gg, -(a * h - b * gg), a * e - b * d]
      .map((x) => x * sign);
    for (let v = 0; v < n; v++) {
      const x = g.positions[v * 3]!; const y = g.positions[v * 3 + 1]!; const z = g.positions[v * 3 + 2]!;
      const o = (v0 + v) * 3;
      for (let r = 0; r < 3; r++) {
        const p = m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!;
        positions[o + r] = p;
        if (p < lo[r]!) lo[r] = p;
        if (p > hi[r]!) hi[r] = p;
      }
      const nx = g.normals[v * 3]!; const ny = g.normals[v * 3 + 1]!; const nz = g.normals[v * 3 + 2]!;
      const wx = nm[0]! * nx + nm[3]! * ny + nm[6]! * nz;
      const wy = nm[1]! * nx + nm[4]! * ny + nm[7]! * nz;
      const wz = nm[2]! * nx + nm[5]! * ny + nm[8]! * nz;
      const l = Math.hypot(wx, wy, wz) || 1;
      normals[o] = wx / l; normals[o + 1] = wy / l; normals[o + 2] = wz / l;
      uvs[(v0 + v) * 2] = g.uvs[v * 2]!;
      uvs[(v0 + v) * 2 + 1] = g.uvs[v * 2 + 1]!;
      for (let ch = 0; ch < 4; ch++) colors[(v0 + v) * 4 + ch] = (g.colors?.[v * 4 + ch] ?? 1) * linearTint[ch]!;
    }
    const flip = det < 0;
    for (let t = 0; t < g.indices.length; t += 3) {
      indices[i0 + t] = g.indices[t]! + v0;
      indices[i0 + t + 1] = g.indices[flip ? t + 2 : t + 1]! + v0;
      indices[i0 + t + 2] = g.indices[flip ? t + 1 : t + 2]! + v0;
    }
    v0 += n;
    i0 += g.indices.length;
  }
  const min: Xyz = vertices === 0 ? [0, 0, 0] : [lo[0]!, lo[1]!, lo[2]!];
  const max: Xyz = vertices === 0 ? [0, 0, 0] : [hi[0]!, hi[1]!, hi[2]!];
  return { id, positions, normals, uvs, indices, joints: null, weights: null, colors, min, max };
}
