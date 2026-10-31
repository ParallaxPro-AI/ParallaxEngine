/**
 * The tile pyramid the renderer draws (`TerrainTiles` in the terrain service). A tile is
 * TILE_QUADS² quads; level 0 quads are `leafCell` meters and each level doubles them.
 *
 *   field levels     cell >= the field's cell: vertices sample the live field (its
 *                    triangles, so deformation and holes are exact), built on the spot
 *                    within a per-frame budget
 *   streamed levels  finer than the field (large maps): the authored relief and splat are
 *                    evaluated at the tile's own vertices in the `terrain.tile` job (a
 *                    worker in the browser), then the deformation layer and holes are
 *                    added here. Without a job runner they bake on this thread, a few a frame.
 *
 * Every tile also carries its geomorph targets: each vertex's height on the next coarser
 * level's triangles (same diagonal split), so a renderer can blend a ring of tiles into its
 * parent level without cracks. Each tile keeps the four layers that carry it most (its
 * palette); a vertex's weight on any other layer is folded into the palette and the tile
 * says so (`dropped`), which renderers report.
 *
 * Cached tiles are evicted least recently wanted past `MAX_RESIDENT`, and rebuilt when the
 * field's revision under them moved (a crater).
 */

import { jobKey } from '../../../core/index.js';
import type { JobKey } from '../../../core/index.js';
import { JOBS_SERVICE, TILE_QUADS } from '../../services/index.js';
import type { TerrainTile, TerrainTiles } from '../../services/index.js';
import type { Kernel } from '../../kernel/index.js';
import { Relief, Splat } from './bake.js';
import type { Field } from './field.js';
import type { TerrainSpec } from './spec.js';

/** Most tiles kept baked. */
export const MAX_RESIDENT = 768;
/** Field-level tiles built per frame. */
export const FIELD_BUILDS_PER_FRAME = 16;
/** Streamed tiles baked per frame on this thread (no job runner). */
export const INLINE_BAKES_PER_FRAME = 3;
/** Streamed tile jobs in flight. */
export const MAX_PENDING = 12;
/** Finest streamed cell, meters. */
const FINEST_CELL = 1;
/** Most levels streamed below the field. */
const MAX_STREAMED_LEVELS = 3;

const V = TILE_QUADS + 1;

export interface TileJobInput {
  readonly spec: TerrainSpec;
  /** Min corner, cell, and the terrain bounds every vertex is clamped into. */
  readonly x: number;
  readonly z: number;
  readonly cell: number;
}

export interface TileJobOutput {
  /** Relief at (TILE_QUADS + 3)² points: the tile's vertices with a one-vertex ring (for normals). */
  readonly ring: Float32Array;
  /** Authored splat at the tile's vertices: layers per vertex. */
  readonly splat: Float32Array;
}

/** The streamed-tile job: register it in the engine job table (boot/jobs.ts). */
export const TERRAIN_TILE: JobKey<TileJobInput, TileJobOutput> = jobKey('terrain.tile');

/** The pure half of a streamed tile: relief and splat from the spec alone. */
export function bakeTileRelief(input: TileJobInput): TileJobOutput {
  const { spec, x, z, cell } = input;
  const relief = new Relief(spec);
  const splat = new Splat(spec);
  const R = V + 2;
  const minX = -spec.width / 2;
  const minZ = -spec.depth / 2;
  const maxX = minX + spec.width;
  const maxZ = minZ + spec.depth;
  const ring = new Float32Array(R * R);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < R; c++) ring[r * R + c] = relief.at(clamp(x + (c - 1) * cell, minX, maxX), clamp(z + (r - 1) * cell, minZ, maxZ));
  }
  const layers = spec.layers.length;
  const out = new Float32Array(V * V * layers);
  const weights = new Float32Array(layers);
  for (let r = 0; r < V; r++) {
    for (let c = 0; c < V; c++) {
      const h = ring[(r + 1) * R + c + 1]!;
      const dx = (ring[(r + 1) * R + c + 2]! - ring[(r + 1) * R + c]!) / (2 * cell);
      const dz = (ring[(r + 2) * R + c + 1]! - ring[r * R + c + 1]!) / (2 * cell);
      const ny = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      splat.at(clamp(x + c * cell, minX, maxX), clamp(z + r * cell, minZ, maxZ), h, ny, weights);
      out.set(weights, (r * V + c) * layers);
    }
  }
  return { ring, splat: out };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The pyramid's shape for a field: leaf cell, levels, which level the field starts at. */
export function pyramidOf(field: Field): { leafCell: number; levels: number; fieldLevel: number } {
  const fieldCell = Math.max(field.cellX, field.cellZ);
  let fieldLevel = 0;
  while (fieldLevel < MAX_STREAMED_LEVELS && fieldCell / 2 ** (fieldLevel + 1) >= FINEST_CELL) fieldLevel++;
  const leafCell = fieldCell / 2 ** fieldLevel;
  const longer = Math.max(field.width, field.depth);
  let levels = 1;
  while (TILE_QUADS * leafCell * 2 ** (levels - 1) < longer) levels++;
  return { leafCell, levels, fieldLevel };
}

/** Each vertex's height on the next coarser grid's triangles (diagonal (c,r)→(c+1,r+1)). */
export function morphTargets(heights: Float32Array): Float32Array {
  const morph = new Float32Array(V * V);
  for (let r = 0; r < V; r++) {
    for (let c = 0; c < V; c++) {
      const oddC = c % 2 === 1;
      const oddR = r % 2 === 1;
      const h = (cc: number, rr: number): number => heights[rr * V + cc]!;
      let m: number;
      if (!oddC && !oddR) m = h(c, r);
      else if (oddC && !oddR) m = (h(c - 1, r) + h(c + 1, r)) / 2;
      else if (!oddC && oddR) m = (h(c, r - 1) + h(c, r + 1)) / 2;
      else m = (h(c - 1, r - 1) + h(c + 1, r + 1)) / 2;
      morph[r * V + c] = m;
    }
  }
  return morph;
}

/** The four strongest layers over a tile and the weights folded onto them. */
export function paletteOf(all: Float32Array, layers: number): { palette: number[]; weights: Float32Array; dropped: boolean } {
  const totals = new Float64Array(layers);
  const peak = new Float64Array(layers);
  for (let v = 0; v < V * V; v++) {
    for (let l = 0; l < layers; l++) {
      const w = all[v * layers + l]!;
      totals[l] = totals[l]! + w;
      if (w > peak[l]!) peak[l] = w;
    }
  }
  const order = [...Array(layers).keys()].filter((l) => peak[l]! > 1e-4).sort((a, b) => totals[b]! - totals[a]! || a - b);
  const palette = order.slice(0, 4);
  if (palette.length === 0) palette.push(0);
  const dropped = order.length > 4;
  const weights = new Float32Array(V * V * 4);
  for (let v = 0; v < V * V; v++) {
    let sum = 0;
    for (let p = 0; p < palette.length; p++) sum += all[v * layers + palette[p]!]!;
    for (let p = 0; p < palette.length; p++) weights[v * 4 + p] = sum > 1e-6 ? all[v * layers + palette[p]!]! / sum : p === 0 ? 1 : 0;
  }
  return { palette, weights, dropped };
}

interface Entry {
  tile: TerrainTile | null;
  wanted: number;
  /** A bake for this tile is in flight (streamed). */
  pending: boolean;
}

export class TilePyramid implements TerrainTiles {
  readonly leafCell: number;
  readonly levels: number;
  readonly fieldLevel: number;
  readonly originX: number;
  readonly originZ: number;
  readonly #field: Field;
  readonly #spec: TerrainSpec;
  readonly #kernel: Kernel;
  readonly #entries = new Map<string, Entry>();
  #frame = -1;
  #builds = 0;
  #inline = 0;
  #pending = 0;
  #baked = 0;
  /** Set when the field is replaced: late job results are dropped. */
  #closed = false;
  /** A failed tile job, raised on the next `get`. */
  #failure: unknown = undefined;

  constructor(kernel: Kernel, field: Field, spec: TerrainSpec) {
    this.#kernel = kernel;
    this.#field = field;
    this.#spec = spec;
    const shape = pyramidOf(field);
    this.leafCell = shape.leafCell;
    this.levels = shape.levels;
    this.fieldLevel = shape.fieldLevel;
    this.originX = field.minX;
    this.originZ = field.minZ;
  }

  get stats(): { resident: number; pending: number; baked: number } {
    let resident = 0;
    for (const e of this.#entries.values()) if (e.tile !== null) resident++;
    return { resident, pending: this.#pending, baked: this.#baked };
  }

  close(): void {
    this.#closed = true;
    this.#entries.clear();
  }

  #cell(level: number): number {
    return this.leafCell * 2 ** level;
  }

  get(level: number, ix: number, iz: number): TerrainTile | null {
    if (this.#failure !== undefined) {
      const failure = this.#failure;
      this.#failure = undefined;
      throw failure;
    }
    const frame = this.#kernel.time.frame;
    if (frame !== this.#frame) {
      this.#frame = frame;
      this.#builds = 0;
      this.#inline = 0;
      this.#evict();
    }
    const key = `${level}:${ix}:${iz}`;
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { tile: null, wanted: frame, pending: false };
      this.#entries.set(key, entry);
    }
    entry.wanted = frame;
    const cell = this.#cell(level);
    const x = this.originX + ix * TILE_QUADS * cell;
    const z = this.originZ + iz * TILE_QUADS * cell;
    const size = TILE_QUADS * cell;
    if (entry.tile !== null && this.#field.revisionIn(x, z, x + size, z + size) === entry.tile.revision) return entry.tile;
    if (entry.pending) return entry.tile;
    if (level >= this.fieldLevel) {
      if (this.#builds >= FIELD_BUILDS_PER_FRAME) return entry.tile;
      this.#builds++;
      entry.tile = this.#fromField(level, ix, iz, x, z, cell);
      this.#baked++;
      return entry.tile;
    }
    const input: TileJobInput = { spec: this.#spec, x, z, cell };
    const runner = this.#kernel.tryService(JOBS_SERVICE);
    if (runner === undefined) {
      if (this.#inline >= INLINE_BAKES_PER_FRAME) return entry.tile;
      this.#inline++;
      entry.tile = this.#streamed(level, ix, iz, x, z, cell, bakeTileRelief(input));
      this.#baked++;
      return entry.tile;
    }
    if (this.#pending >= MAX_PENDING) return entry.tile;
    this.#pending++;
    entry.pending = true;
    const target = entry;
    void runner.run(TERRAIN_TILE, input).then((output) => {
      this.#pending--;
      target.pending = false;
      if (this.#closed || this.#entries.get(key) !== target) return;
      target.tile = this.#streamed(level, ix, iz, x, z, cell, output);
      this.#baked++;
    }, (error: unknown) => {
      this.#pending--;
      target.pending = false;
      this.#failure ??= error;
    });
    return entry.tile;
  }

  #evict(): void {
    if (this.#entries.size <= MAX_RESIDENT) return;
    const order = [...this.#entries].filter(([, e]) => !e.pending).sort((a, b) => a[1].wanted - b[1].wanted);
    for (let i = 0; i < order.length && this.#entries.size > MAX_RESIDENT; i++) this.#entries.delete(order[i]![0]);
  }

  #fromField(level: number, ix: number, iz: number, x: number, z: number, cell: number): TerrainTile {
    const f = this.#field;
    const maxX = f.minX + f.width;
    const maxZ = f.minZ + f.depth;
    const heights = new Float32Array(V * V);
    const layers = f.layers.length;
    const all = new Float32Array(V * V * layers);
    for (let r = 0; r < V; r++) {
      const pz = clamp(z + r * cell, f.minZ, maxZ);
      for (let c = 0; c < V; c++) {
        const px = clamp(x + c * cell, f.minX, maxX);
        const v = r * V + c;
        heights[v] = f.heightAt(px, pz);
        for (let l = 0; l < layers; l++) all[v * layers + l] = f.weightAt(px, pz, l);
      }
    }
    const normals = new Float32Array(V * V * 3);
    // Normals across the tile's edges sample the field one cell beyond.
    const sample = (c: number, r: number): number => {
      if (c >= 0 && c < V && r >= 0 && r < V) return heights[r * V + c]!;
      return f.heightAt(clamp(x + c * cell, f.minX, maxX), clamp(z + r * cell, f.minZ, maxZ));
    };
    tileNormals(sample, cell, normals);
    return this.#finish(level, ix, iz, x, z, cell, heights, normals, all);
  }

  #streamed(level: number, ix: number, iz: number, x: number, z: number, cell: number, output: TileJobOutput): TerrainTile {
    const f = this.#field;
    const R = V + 2;
    const maxX = f.minX + f.width;
    const maxZ = f.minZ + f.depth;
    const ring = output.ring;
    if (f.revision > 0) {
      for (let r = 0; r < R; r++) {
        for (let c = 0; c < R; c++) ring[r * R + c] = ring[r * R + c]! + f.deformationAt(clamp(x + (c - 1) * cell, f.minX, maxX), clamp(z + (r - 1) * cell, f.minZ, maxZ));
      }
    }
    const heights = new Float32Array(V * V);
    for (let r = 0; r < V; r++) for (let c = 0; c < V; c++) heights[r * V + c] = ring[(r + 1) * R + c + 1]!;
    const normals = new Float32Array(V * V * 3);
    tileNormals((c, r) => ring[(r + 1) * R + c + 1]!, cell, normals);
    return this.#finish(level, ix, iz, x, z, cell, heights, normals, output.splat);
  }

  #finish(
    level: number, ix: number, iz: number, x: number, z: number, cell: number,
    heights: Float32Array, normals: Float32Array, all: Float32Array,
  ): TerrainTile {
    const f = this.#field;
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (const h of heights) {
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
    let holes: Uint8Array | null = null;
    if (f.holes !== null) {
      for (let r = 0; r < TILE_QUADS; r++) {
        for (let c = 0; c < TILE_QUADS; c++) {
          if (!f.holeAt(x + (c + 0.5) * cell, z + (r + 0.5) * cell)) continue;
          holes ??= new Uint8Array(TILE_QUADS * TILE_QUADS);
          holes[r * TILE_QUADS + c] = 1;
        }
      }
    }
    const { palette, weights, dropped } = paletteOf(all, f.layers.length);
    const size = TILE_QUADS * cell;
    return {
      level, ix, iz, x, z, cell, heights, morph: morphTargets(heights), normals, palette, weights, dropped, holes, minHeight, maxHeight,
      revision: f.revisionIn(x, z, x + size, z + size),
    };
  }
}

/** Smooth normals from central differences of `sample(c, r)` (which may reach one vertex beyond the tile). */
function tileNormals(sample: (c: number, r: number) => number, cell: number, out: Float32Array): void {
  for (let r = 0; r < V; r++) {
    for (let c = 0; c < V; c++) {
      const dx = (sample(c + 1, r) - sample(c - 1, r)) / (2 * cell);
      const dz = (sample(c, r + 1) - sample(c, r - 1)) / (2 * cell);
      const length = Math.sqrt(dx * dx + 1 + dz * dz);
      const i = (r * V + c) * 3;
      out[i] = -dx / length;
      out[i + 1] = 1 / length;
      out[i + 2] = -dz / length;
    }
  }
}
