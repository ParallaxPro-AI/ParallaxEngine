/**
 * The live terrain field: a bake (bake.ts) plus the deformation layer, with the queries the
 * `terrain` service documents. Deformation edits (craters, trenches, flattening, holes)
 * change the grid in place, recompute normals and chunk bounds only where they reach, and
 * bump `revision` (and each touched chunk's), so colliders and tiles rebuild what changed.
 * Edits are deterministic like the bake: the same list applied to the same scene gives the
 * same bits, which is how a snapshot restores them (the list is saved, not the grid).
 */

import { fail, sdFootprint, sdSegment, smootherstep, smoothstep, Vec3 } from '../../../core/index.js';
import type { BrushVolume, TerrainChunk, TerrainEdit, TerrainField, TerrainLayer, TerrainPathLine } from '../../services/index.js';
import { footprintBounds } from '../../../core/index.js';
import { gridNormals, Relief, Splat } from './bake.js';
import type { TerrainBake } from './bake.js';
import { paintSplatMap } from './splat_map.js';
import type { SplatMap, SplatMapInput } from './splat_map.js';

export const CHUNK_QUADS = 64;

interface MutableChunk extends TerrainChunk {
  minHeight: number;
  maxHeight: number;
  revision: number;
}

export class Field implements TerrainField {
  readonly version: number;
  readonly scene: string;
  readonly width: number;
  readonly depth: number;
  readonly minX: number;
  readonly minZ: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly heights: Float32Array;
  readonly normals: Float32Array;
  readonly waterLevel: number | null;
  readonly layers: readonly TerrainLayer[];
  readonly weights: Float32Array;
  readonly brush: readonly BrushVolume[];
  readonly paths: readonly TerrainPathLine[];
  readonly chunkQuads = CHUNK_QUADS;
  readonly chunks: MutableChunk[] = [];
  readonly #bake: TerrainBake;
  #holes: Uint8Array | null;
  #offset: Float32Array | null = null;
  #revision = 0;
  #minHeight = Infinity;
  #maxHeight = -Infinity;
  #relief: Relief | undefined;
  #splat: Splat | undefined;
  #splatMap: SplatMap | null = null;
  #splatRevision = 0;
  readonly #chunkColumns: number;

  constructor(bake: TerrainBake, scene: string, version: number) {
    const spec = bake.spec;
    this.#bake = bake;
    this.version = version;
    this.scene = scene;
    this.width = spec.width;
    this.depth = spec.depth;
    this.minX = -spec.width / 2;
    this.minZ = -spec.depth / 2;
    this.columns = bake.columns;
    this.rows = bake.rows;
    this.cellX = bake.cellX;
    this.cellZ = bake.cellZ;
    this.heights = bake.heights.slice();
    this.normals = bake.normals.slice();
    this.weights = bake.weights.slice();
    this.#holes = bake.holes === null ? null : bake.holes.slice();
    this.waterLevel = spec.waterLevel;
    this.layers = spec.layers;
    this.paths = spec.paths.map((p): TerrainPathLine => ({
      paint: p.layer === null ? null : spec.layers[p.layer]!.name, points: p.points, width: p.width, closed: p.closed,
    }));
    this.brush = spec.brush.map((b): BrushVolume => {
      const bounds = footprintBounds(b.shape, 0);
      return { id: b.id, tags: b.tags, height: b.height, ...bounds, contains: (x, z) => sdFootprint(b.shape, x, z) <= 0 };
    });
    this.#chunkColumns = Math.ceil((this.columns - 1) / CHUNK_QUADS);
    for (let row = 0; row < this.rows - 1; row += CHUNK_QUADS) {
      for (let column = 0; column < this.columns - 1; column += CHUNK_QUADS) {
        this.chunks.push({
          column, row, columns: Math.min(CHUNK_QUADS, this.columns - 1 - column), rows: Math.min(CHUNK_QUADS, this.rows - 1 - row),
          minHeight: 0, maxHeight: 0, revision: 0,
        });
      }
    }
    for (const chunk of this.chunks) this.#bound(chunk);
    this.#totals();
  }

  get revision(): number {
    return this.#revision;
  }

  get minHeight(): number {
    return this.#minHeight;
  }

  get maxHeight(): number {
    return this.#maxHeight;
  }

  get holes(): Uint8Array | null {
    return this.#holes;
  }

  #at(c: number, r: number): number {
    return this.heights[r * this.columns + c]!;
  }

  #bound(chunk: MutableChunk): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = chunk.row; r <= chunk.row + chunk.rows; r++) {
      for (let c = chunk.column; c <= chunk.column + chunk.columns; c++) {
        const h = this.#at(c, r);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    chunk.minHeight = lo;
    chunk.maxHeight = hi;
  }

  #totals(): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const chunk of this.chunks) {
      if (chunk.minHeight < lo) lo = chunk.minHeight;
      if (chunk.maxHeight > hi) hi = chunk.maxHeight;
    }
    this.#minHeight = lo;
    this.#maxHeight = hi;
  }

  contains(x: number, z: number): boolean {
    return x >= this.minX && x <= this.minX + this.width && z >= this.minZ && z <= this.minZ + this.depth;
  }

  /** The quad under (x, z) and the local coordinates in it; PP3203 outside. */
  #locate(x: number, z: number, what: string): { c: number; r: number; fx: number; fz: number } {
    if (!Number.isFinite(x) || !Number.isFinite(z)) fail('PP3202', `terrain ${what}: x and z must be finite numbers, got (${x}, ${z})`);
    if (!this.contains(x, z)) {
      fail('PP3203', `terrain ${what}(${x}, ${z}) is outside the terrain (x ${this.minX}..${this.minX + this.width}, z ${this.minZ}..${this.minZ + this.depth})`, {
        fix: 'Check terrain bounds first, or keep the point within the scene\'s "terrain" "size".',
      });
    }
    const gx = (x - this.minX) / this.cellX;
    const gz = (z - this.minZ) / this.cellZ;
    const c = Math.min(this.columns - 2, Math.floor(gx));
    const r = Math.min(this.rows - 2, Math.floor(gz));
    return { c, r, fx: gx - c, fz: gz - r };
  }

  heightAt(x: number, z: number): number {
    const { c, r, fx, fz } = this.#locate(x, z, 'height_at');
    const h00 = this.#at(c, r);
    const h11 = this.#at(c + 1, r + 1);
    if (fx >= fz) {
      const h10 = this.#at(c + 1, r);
      return h00 + fx * (h10 - h00) + fz * (h11 - h10);
    }
    const h01 = this.#at(c, r + 1);
    return h00 + fz * (h01 - h00) + fx * (h11 - h01);
  }

  normalAt(x: number, z: number): Vec3 {
    const { c, r, fx, fz } = this.#locate(x, z, 'normal_at');
    const h00 = this.#at(c, r);
    const h11 = this.#at(c + 1, r + 1);
    let dx: number;
    let dz: number;
    if (fx >= fz) {
      const h10 = this.#at(c + 1, r);
      dx = (h10 - h00) / this.cellX;
      dz = (h11 - h10) / this.cellZ;
    } else {
      const h01 = this.#at(c, r + 1);
      dx = (h11 - h01) / this.cellX;
      dz = (h01 - h00) / this.cellZ;
    }
    const length = Math.sqrt(dx * dx + 1 + dz * dz);
    return new Vec3(-dx / length, 1 / length, -dz / length);
  }

  #weight(c: number, r: number, fx: number, fz: number, l: number): number {
    const n = this.layers.length;
    const w = (c0: number, r0: number): number => this.weights[(r0 * this.columns + c0) * n + l]!;
    const top = w(c, r) + (w(c + 1, r) - w(c, r)) * fx;
    const bottom = w(c, r + 1) + (w(c + 1, r + 1) - w(c, r + 1)) * fx;
    return top + (bottom - top) * fz;
  }

  weightAt(x: number, z: number, layer: number): number {
    const { c, r, fx, fz } = this.#locate(x, z, 'weight_at');
    return this.#weight(c, r, fx, fz, layer);
  }

  surfaceAt(x: number, z: number): string {
    const { c, r, fx, fz } = this.#locate(x, z, 'surface_at');
    let best = 0;
    let bestWeight = -1;
    for (let l = 0; l < this.layers.length; l++) {
      const value = this.#weight(c, r, fx, fz, l);
      if (value > bestWeight + 1e-9) {
        best = l;
        bestWeight = value;
      }
    }
    return this.layers[best]!.name;
  }

  ground(point: Vec3): Vec3 {
    return new Vec3(point.x, this.heightAt(point.x, point.z), point.z);
  }

  holeAt(x: number, z: number): boolean {
    if (this.#holes === null || !this.contains(x, z)) return false;
    const c = Math.min(this.columns - 2, Math.floor((x - this.minX) / this.cellX));
    const r = Math.min(this.rows - 2, Math.floor((z - this.minZ) / this.cellZ));
    return this.#holes[r * (this.columns - 1) + c] === 1;
  }

  brushAt(x: number, y: number, z: number): BrushVolume | null {
    if (this.brush.length === 0 || !this.contains(x, z)) return null;
    for (const volume of this.brush) {
      if (x < volume.minX || x > volume.maxX || z < volume.minZ || z > volume.maxZ || !volume.contains(x, z)) continue;
      if (y <= this.heightAt(x, z) + volume.height) return volume;
    }
    return null;
  }

  splatAt(x: number, z: number, height: number, normalY: number, out: Float32Array): void {
    this.#splat ??= new Splat(this.#bake.spec);
    this.#splat.at(x, z, height, normalY, out);
  }

  reliefAt(x: number, z: number): number {
    this.#relief ??= new Relief(this.#bake.spec);
    return this.#relief.at(x, z);
  }

  deformationAt(x: number, z: number): number {
    const offset = this.#offset;
    if (offset === null) return 0;
    const gx = Math.min(this.columns - 1, Math.max(0, (x - this.minX) / this.cellX));
    const gz = Math.min(this.rows - 1, Math.max(0, (z - this.minZ) / this.cellZ));
    const c = Math.min(this.columns - 2, Math.floor(gx));
    const r = Math.min(this.rows - 2, Math.floor(gz));
    const fx = gx - c;
    const fz = gz - r;
    const o = (c0: number, r0: number): number => offset[r0 * this.columns + c0]!;
    const top = o(c, r) + (o(c + 1, r) - o(c, r)) * fx;
    const bottom = o(c, r + 1) + (o(c + 1, r + 1) - o(c, r + 1)) * fx;
    return top + (bottom - top) * fz;
  }

  revisionIn(minX: number, minZ: number, maxX: number, maxZ: number): number {
    if (this.#revision === 0) return 0;
    const span = this.#vertexSpan(minX, minZ, maxX, maxZ, 0);
    if (span === null) return 0;
    let best = 0;
    for (let cr = Math.floor(span.r0 / CHUNK_QUADS); cr <= Math.floor(Math.max(span.r0, span.r1 - 1) / CHUNK_QUADS); cr++) {
      for (let cc = Math.floor(span.c0 / CHUNK_QUADS); cc <= Math.floor(Math.max(span.c0, span.c1 - 1) / CHUNK_QUADS); cc++) {
        const chunk = this.chunks[cr * this.#chunkColumns + cc];
        if (chunk !== undefined && chunk.revision > best) best = chunk.revision;
      }
    }
    return best;
  }

  /** Vertex index ranges covering a world rectangle grown by `pad` meters, clamped to the grid; null when off it. */
  #vertexSpan(minX: number, minZ: number, maxX: number, maxZ: number, pad: number): { c0: number; c1: number; r0: number; r1: number } | null {
    const c0 = Math.max(0, Math.floor((minX - pad - this.minX) / this.cellX));
    const c1 = Math.min(this.columns - 1, Math.ceil((maxX + pad - this.minX) / this.cellX));
    const r0 = Math.max(0, Math.floor((minZ - pad - this.minZ) / this.cellZ));
    const r1 = Math.min(this.rows - 1, Math.ceil((maxZ + pad - this.minZ) / this.cellZ));
    return c0 > c1 || r0 > r1 ? null : { c0, c1, r0, r1 };
  }

  /** Apply one edit (validated by the caller). */
  apply(edit: TerrainEdit): void {
    let reach: number;
    let x0 = edit.x;
    let z0 = edit.z;
    let x1 = edit.x;
    let z1 = edit.z;
    if (edit.kind === 'crater') reach = edit.radius * 1.5;
    else if (edit.kind === 'trench') {
      reach = edit.width / 2 + edit.feather;
      x0 = Math.min(edit.x, edit.x2);
      x1 = Math.max(edit.x, edit.x2);
      z0 = Math.min(edit.z, edit.z2);
      z1 = Math.max(edit.z, edit.z2);
    } else if (edit.kind === 'flatten') reach = edit.radius + edit.feather;
    else reach = edit.radius;
    const span = this.#vertexSpan(x0, z0, x1, z1, reach);
    if (span === null) return;
    this.#revision++;

    if (edit.kind === 'hole') {
      this.#holes ??= new Uint8Array((this.columns - 1) * (this.rows - 1));
      for (let r = span.r0; r < span.r1; r++) {
        for (let c = span.c0; c < span.c1; c++) {
          const dx = this.minX + (c + 0.5) * this.cellX - edit.x;
          const dz = this.minZ + (r + 0.5) * this.cellZ - edit.z;
          if (dx * dx + dz * dz <= edit.radius * edit.radius) this.#holes[r * (this.columns - 1) + c] = 1;
        }
      }
      this.#touch(span);
      return;
    }

    this.#offset ??= new Float32Array(this.columns * this.rows);
    const offset = this.#offset;
    const layers = this.layers.length;
    const paint = edit.kind === 'flatten' ? null : edit.layer;
    for (let r = span.r0; r <= span.r1; r++) {
      for (let c = span.c0; c <= span.c1; c++) {
        const v = r * this.columns + c;
        const px = this.minX + c * this.cellX;
        const pz = this.minZ + r * this.cellZ;
        let delta = 0;
        let cover = 0;
        if (edit.kind === 'crater') {
          const dx = px - edit.x;
          const dz = pz - edit.z;
          const d = Math.sqrt(dx * dx + dz * dz) / edit.radius;
          if (d < 1) delta -= edit.depth * (1 - d * d);
          const ring = d > 1.1 ? d - 1.1 : 1.1 - d;
          if (edit.rim !== 0 && ring < 0.4) delta += edit.rim * (1 - smootherstep(ring / 0.4));
          cover = editCover(edit, px, pz);
        } else if (edit.kind === 'trench') {
          cover = editCover(edit, px, pz);
          delta = -edit.depth * cover;
        } else {
          const dx = px - edit.x;
          const dz = pz - edit.z;
          const beyond = Math.sqrt(dx * dx + dz * dz) - edit.radius;
          const w = beyond <= 0 ? 1 : edit.feather > 0 && beyond < edit.feather ? 1 - smoothstep(0, edit.feather, beyond) : 0;
          delta = (edit.height - this.heights[v]!) * w;
        }
        if (delta !== 0) {
          offset[v] = offset[v]! + delta;
          this.heights[v] = this.heights[v]! + delta;
        }
        if (paint !== null && cover > 0) {
          const keep = 1 - cover;
          for (let l = 0; l < layers; l++) this.weights[v * layers + l] = this.weights[v * layers + l]! * keep;
          this.weights[v * layers + paint] = this.weights[v * layers + paint]! + cover;
        }
      }
    }
    gridNormals(this.heights, this.columns, this.rows, this.cellX, this.cellZ, this.normals,
      Math.max(0, span.c0 - 1), Math.max(0, span.r0 - 1), Math.min(this.columns - 1, span.c1 + 1), Math.min(this.rows - 1, span.r1 + 1));
    if (paint !== null) this.#paintMap(edit, paint, x0 - reach, z0 - reach, x1 + reach, z1 + reach);
    this.#touch(span);
  }

  /** The splat map (splat_map.ts) once attached, or null. */
  get splatMap(): SplatMap | null {
    return this.#splatMap;
  }

  /** Changes to the splat map since it was attached. */
  get splatRevision(): number {
    return this.#splatRevision;
  }

  /** The authored grid the splat map is baked from. */
  splatMapInput(): SplatMapInput {
    const b = this.#bake;
    return { spec: b.spec, columns: b.columns, rows: b.rows, heights: b.heights, normals: b.normals };
  }

  /** Attach a baked splat map, painting the edits made so far onto it. */
  attachSplatMap(map: SplatMap, edits: readonly TerrainEdit[]): void {
    this.#splatMap = map;
    for (const edit of edits) {
      if (edit.kind !== 'crater' && edit.kind !== 'trench') continue;
      if (edit.layer === null) continue;
      const reach = edit.kind === 'crater' ? edit.radius * 1.5 : edit.width / 2 + edit.feather;
      const x2 = edit.kind === 'trench' ? edit.x2 : edit.x;
      const z2 = edit.kind === 'trench' ? edit.z2 : edit.z;
      this.#paintMap(edit, edit.layer, Math.min(edit.x, x2) - reach, Math.min(edit.z, z2) - reach, Math.max(edit.x, x2) + reach, Math.max(edit.z, z2) + reach);
    }
    this.#splatRevision++;
  }

  #paintMap(edit: TerrainEdit, layer: number, x0: number, z0: number, x1: number, z1: number): void {
    const map = this.#splatMap;
    if (map === null) return;
    if (paintSplatMap(map, this.layers.length, layer, this.minX, this.minZ, { x0, z0, x1, z1 }, (x, z) => editCover(edit, x, z))) this.#splatRevision++;
  }

  #touch(span: { c0: number; c1: number; r0: number; r1: number }): void {
    // A vertex on a chunk's edge belongs to both chunks it borders.
    const cc0 = Math.max(0, Math.floor((span.c0 - 1) / CHUNK_QUADS));
    const cc1 = Math.min(this.#chunkColumns - 1, Math.floor(span.c1 / CHUNK_QUADS));
    const chunkRows = Math.ceil((this.rows - 1) / CHUNK_QUADS);
    const cr0 = Math.max(0, Math.floor((span.r0 - 1) / CHUNK_QUADS));
    const cr1 = Math.min(chunkRows - 1, Math.floor(span.r1 / CHUNK_QUADS));
    for (let cr = cr0; cr <= cr1; cr++) {
      for (let cc = cc0; cc <= cc1; cc++) {
        const chunk = this.chunks[cr * this.#chunkColumns + cc]!;
        chunk.revision = this.#revision;
        this.#bound(chunk);
      }
    }
    this.#totals();
  }
}

/** How much a crater or trench paints its layer at (x, z), 0..1 (0 for other edits). */
export function editCover(edit: TerrainEdit, x: number, z: number): number {
  if (edit.kind === 'crater') {
    const dx = x - edit.x;
    const dz = z - edit.z;
    const d = Math.sqrt(dx * dx + dz * dz) / edit.radius;
    return d < 1.1 ? 1 - smoothstep(0.8, 1.1, d) : 0;
  }
  if (edit.kind === 'trench') {
    const beyond = sdSegment(x, z, edit.x, edit.z, edit.x2, edit.z2) - edit.width / 2;
    return beyond <= 0 ? 1 : edit.feather > 0 && beyond < edit.feather ? 1 - smoothstep(0, edit.feather, beyond) : 0;
  }
  return 0;
}

/** Build a field from a bake (the job half is `bakeTerrain`). */
export function fieldOf(bake: TerrainBake, scene: string, version: number): Field {
  return new Field(bake, scene, version);
}
