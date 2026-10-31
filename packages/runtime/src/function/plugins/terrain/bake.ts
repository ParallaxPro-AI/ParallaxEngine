/**
 * Baking a terrain spec: the relief (heights) and the splat (layer weights), as functions
 * of a point, and the gameplay grid sampled from them. Pointwise on purpose: the field's
 * grid, every streamed tile and any finer bake read the same two functions, so a road's
 * edge is wherever its spline says at every resolution. Deterministic to the bit (see
 * core/values/ground_math.ts).
 *
 * Relief, in order:
 *   base_height + Σ noise layers (each 0..1 × amplitude) + Σ hills        the natural ground
 *     (a hill is full height `feather` meters inside its footprint, eased to 0 at its edge)
 *   flats, in order: eased toward their height (carve: only down, fill: only up)
 *   paths with "flatten", in order: eased onto the path's profile — the ground sampled
 *     along the centerline and smoothed over a control-point gap each way, + offset
 *
 * Splat, in order (each step blends its cover c of a layer over what is there:
 * w ← w·(1 − c) + c·onehot, so weights always sum to 1):
 *   default_layer everywhere → rules (slope and height bands) → paint → paths
 *
 * Covers ease over `feather` meters outside a footprint (smoothstep), are full inside, and
 * are scaled by `strength`. Paint `noise` pushes the edge in and out by up to
 * noise × feather with value noise, so painted patches don't read as perfect circles.
 */

import {
  catmullRomPolyline, footprintBounds, fractalNoise2, mixSeed, sdFootprint, segmentNearest2, smootherstep, smoothstep, valueNoise2,
} from '../../../core/index.js';
import { jobKey } from '../../../core/index.js';
import type { Bounds2, JobKey } from '../../../core/index.js';
import type { TerrainSpec } from './spec.js';

/** Item lists over a uniform grid of square bins (what can touch a point). */
export class Bins {
  readonly #minX: number;
  readonly #minZ: number;
  readonly #cell: number;
  readonly #cols: number;
  readonly #rows: number;
  readonly #bins: number[][];

  constructor(minX: number, minZ: number, width: number, depth: number, cell: number) {
    this.#minX = minX;
    this.#minZ = minZ;
    this.#cell = cell;
    this.#cols = Math.max(1, Math.ceil(width / cell));
    this.#rows = Math.max(1, Math.ceil(depth / cell));
    this.#bins = Array.from({ length: this.#cols * this.#rows }, () => []);
  }

  #col(x: number): number {
    const c = Math.floor((x - this.#minX) / this.#cell);
    return c < 0 ? 0 : c >= this.#cols ? this.#cols - 1 : c;
  }

  #row(z: number): number {
    const r = Math.floor((z - this.#minZ) / this.#cell);
    return r < 0 ? 0 : r >= this.#rows ? this.#rows - 1 : r;
  }

  /** Items are added in increasing order, so every bin lists them in that order. */
  add(b: Bounds2, item: number): void {
    const c0 = this.#col(b.minX);
    const c1 = this.#col(b.maxX);
    const r0 = this.#row(b.minZ);
    const r1 = this.#row(b.maxZ);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.#bins[r * this.#cols + c]!.push(item);
  }

  at(x: number, z: number): readonly number[] {
    return this.#bins[this.#row(z) * this.#cols + this.#col(x)]!;
  }
}

/** Bin size for a terrain: about 64 bins along the longer side, never under 8 m. */
function binCell(spec: TerrainSpec): number {
  return Math.max(8, Math.max(spec.width, spec.depth) / 64);
}

/** 1 inside, eased to 0 over `feather` beyond the edge (`d` is the signed distance). */
function cover(d: number, feather: number): number {
  if (d <= 0) return 1;
  if (feather <= 0 || d >= feather) return 0;
  return 1 - smoothstep(0, feather, d);
}

interface SplinePath {
  readonly line: Float64Array;
  readonly segments: Bins;
  readonly half: number;
  readonly feather: number;
}

function splinePath(spec: TerrainSpec, points: readonly (readonly [number, number])[], closed: boolean, half: number, feather: number): SplinePath {
  const reach = half + feather;
  const line = catmullRomPolyline(points, closed);
  const minX = -spec.width / 2;
  const minZ = -spec.depth / 2;
  const segments = new Bins(minX, minZ, spec.width, spec.depth, binCell(spec));
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]!;
    const az = line[i + 1]!;
    const bx = line[i + 2]!;
    const bz = line[i + 3]!;
    segments.add({ minX: Math.min(ax, bx) - reach, minZ: Math.min(az, bz) - reach, maxX: Math.max(ax, bx) + reach, maxZ: Math.max(az, bz) + reach }, i / 2);
  }
  return { line, segments, half, feather };
}

/** Nearest point on a path's polyline among the segments binned at (x, z): distance and sample index, or null. */
function nearest(path: SplinePath, x: number, z: number): { distance: number; index: number } | null {
  const candidates = path.segments.at(x, z);
  if (candidates.length === 0) return null;
  const line = path.line;
  let best = Infinity;
  let index = 0;
  for (const s of candidates) {
    const i = s * 2;
    const r = segmentNearest2(x, z, line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!);
    if (r.d2 < best) {
      best = r.d2;
      index = s + r.t;
    }
  }
  return { distance: Math.sqrt(best), index };
}

interface FlattenPath extends SplinePath {
  /** Smoothed ground height (+ offset) at each polyline sample. */
  readonly profile: Float64Array;
}

/** The analytic height of a spec at any point. */
export class Relief {
  readonly #spec: TerrainSpec;
  readonly #hills: Bins;
  readonly #flats: Bins;
  readonly #paths: FlattenPath[] = [];

  constructor(spec: TerrainSpec) {
    this.#spec = spec;
    const minX = -spec.width / 2;
    const minZ = -spec.depth / 2;
    this.#hills = new Bins(minX, minZ, spec.width, spec.depth, binCell(spec));
    spec.hills.forEach((hill, i) => this.#hills.add(footprintBounds(hill.shape, hill.feather), i));
    this.#flats = new Bins(minX, minZ, spec.width, spec.depth, binCell(spec));
    spec.flats.forEach((flat, i) => this.#flats.add(footprintBounds(flat.shape, flat.feather), i));
    for (const path of spec.paths) {
      if (path.flatten === null) continue;
      const half = path.width / 2;
      const base = splinePath(spec, path.points, path.closed, half, path.flatten.feather);
      const samples = base.line.length / 2;
      const raw = new Float64Array(samples);
      for (let i = 0; i < samples; i++) raw[i] = this.#beforePaths(base.line[i * 2]!, base.line[i * 2 + 1]!);
      // Two box passes over a control-point gap each way: a road's profile, not the noise's.
      let profile = raw;
      const window = 8;
      for (let pass = 0; pass < 2; pass++) {
        const next = new Float64Array(samples);
        for (let i = 0; i < samples; i++) {
          let sum = 0;
          let n = 0;
          for (let k = i - window; k <= i + window; k++) {
            const j = path.closed ? ((k % (samples - 1)) + (samples - 1)) % (samples - 1) : k < 0 ? 0 : k >= samples ? samples - 1 : k;
            sum += profile[j]!;
            n++;
          }
          next[i] = sum / n;
        }
        profile = next;
      }
      for (let i = 0; i < samples; i++) profile[i] = profile[i]! + path.flatten.offset;
      this.#paths.push({ ...base, profile });
    }
  }

  /** Base height, noise and hills. */
  natural(x: number, z: number): number {
    const spec = this.#spec;
    let h = spec.baseHeight;
    for (const layer of spec.noise) h += layer.amplitude * fractalNoise2(layer, x, z);
    for (const i of this.#hills.at(x, z)) {
      const hill = spec.hills[i]!;
      const d = sdFootprint(hill.shape, x, z);
      if (d >= 0) continue;
      h += hill.feather > 0 ? hill.height * smootherstep(-d / hill.feather) : hill.height;
    }
    return h;
  }

  #beforePaths(x: number, z: number): number {
    let h = this.natural(x, z);
    const flats = this.#spec.flats;
    for (const i of this.#flats.at(x, z)) {
      const flat = flats[i]!;
      if (flat.mode === 'carve' && flat.height >= h) continue;
      if (flat.mode === 'fill' && flat.height <= h) continue;
      const w = cover(sdFootprint(flat.shape, x, z), flat.feather);
      if (w > 0) h += (flat.height - h) * w;
    }
    return h;
  }

  /** The ground at (x, z): natural, then flats, then path grading. */
  at(x: number, z: number): number {
    let h = this.#beforePaths(x, z);
    for (const path of this.#paths) {
      const near = nearest(path, x, z);
      if (near === null) continue;
      const w = cover(near.distance - path.half, path.feather);
      if (w <= 0) continue;
      const i = Math.floor(near.index);
      const f = near.index - i;
      const a = path.profile[i]!;
      const b = path.profile[Math.min(path.profile.length - 1, i + 1)]!;
      h += (a + (b - a) * f - h) * w;
    }
    return h;
  }
}

/** The analytic splat of a spec at any point. */
export class Splat {
  readonly #spec: TerrainSpec;
  readonly #paint: Bins;
  readonly #paths: (SplinePath & { readonly layer: number; readonly strength: number })[] = [];
  readonly #scratch: Float64Array;

  constructor(spec: TerrainSpec) {
    this.#spec = spec;
    this.#scratch = new Float64Array(spec.layers.length);
    this.#paint = new Bins(-spec.width / 2, -spec.depth / 2, spec.width, spec.depth, binCell(spec));
    spec.paint.forEach((p, i) => this.#paint.add(footprintBounds(p.shape, p.feather * (1 + p.noise)), i));
    for (const path of spec.paths) {
      if (path.layer === null) continue;
      const half = path.width / 2;
      this.#paths.push({ ...splinePath(spec, path.points, path.closed, half, path.feather), layer: path.layer, strength: path.strength });
    }
  }

  /** Weights at (x, z) for ground of `height` and normal y `normalY`, into `out` (one per layer). */
  at(x: number, z: number, height: number, normalY: number, out: Float32Array | Float64Array): void {
    const spec = this.#spec;
    const w = this.#scratch;
    const n = w.length;
    w.fill(0);
    w[spec.defaultLayer] = 1;
    const blend = (layer: number, c: number): void => {
      if (c <= 0) return;
      const keep = 1 - c;
      for (let l = 0; l < n; l++) w[l] = w[l]! * keep;
      w[layer] = w[layer]! + c;
    };
    for (const rule of spec.rules) {
      let c = rule.strength;
      if (rule.slope !== null) c *= 1 - smoothstep(rule.slope.full, rule.slope.from, normalY);
      if (rule.height !== null) {
        const below = rule.height.low - height;
        const above = height - rule.height.high;
        c *= cover(below > above ? below : above, rule.feather);
      }
      blend(rule.layer, c);
    }
    for (const i of this.#paint.at(x, z)) {
      const p = spec.paint[i]!;
      let d = sdFootprint(p.shape, x, z);
      if (p.noise > 0 && p.feather > 0) {
        const scale = p.feather > 0.5 ? p.feather : 0.5;
        d += (valueNoise2(x / scale, z / scale, mixSeed(0x5eed, p.seed)) * 2 - 1) * p.feather * p.noise;
      }
      blend(p.layer, cover(d, p.feather) * p.strength);
    }
    for (const path of this.#paths) {
      const near = nearest(path, x, z);
      if (near !== null) blend(path.layer, cover(near.distance - path.half, path.feather) * path.strength);
    }
    for (let l = 0; l < n; l++) out[l] = w[l]!;
  }
}

/** Which footprints cut the ground away. */
export class HoleMask {
  readonly #spec: TerrainSpec;
  readonly #bins: Bins;

  constructor(spec: TerrainSpec) {
    this.#spec = spec;
    this.#bins = new Bins(-spec.width / 2, -spec.depth / 2, spec.width, spec.depth, binCell(spec));
    spec.holes.forEach((hole, i) => this.#bins.add(footprintBounds(hole, 0), i));
  }

  get any(): boolean {
    return this.#spec.holes.length > 0;
  }

  at(x: number, z: number): boolean {
    for (const i of this.#bins.at(x, z)) if (sdFootprint(this.#spec.holes[i]!, x, z) <= 0) return true;
    return false;
  }
}

/** The gameplay grid's shape: `resolution` quads along the longer side. */
export function gridOf(spec: TerrainSpec): { columns: number; rows: number; cellX: number; cellZ: number } {
  const target = Math.max(spec.width, spec.depth) / spec.resolution;
  const quadsX = Math.max(1, Math.round(spec.width / target));
  const quadsZ = Math.max(1, Math.round(spec.depth / target));
  return { columns: quadsX + 1, rows: quadsZ + 1, cellX: spec.width / quadsX, cellZ: spec.depth / quadsZ };
}

/** A spec baked onto its grid: plain data (it crosses threads). */
export interface TerrainBake {
  readonly spec: TerrainSpec;
  readonly columns: number;
  readonly rows: number;
  readonly cellX: number;
  readonly cellZ: number;
  /** The relief at every vertex (before any deformation). */
  readonly heights: Float32Array;
  readonly normals: Float32Array;
  readonly weights: Float32Array;
  /** One byte per quad, 1 = hole; null when the spec cuts none. */
  readonly holes: Uint8Array | null;
}

/** Smooth vertex normals of a height grid (central differences, one-sided at the edges), into `out` over rows r0..r1, columns c0..c1. */
export function gridNormals(
  heights: Float32Array, columns: number, rows: number, cellX: number, cellZ: number, out: Float32Array,
  c0 = 0, r0 = 0, c1 = columns - 1, r1 = rows - 1,
): void {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ca = c > 0 ? c - 1 : 0;
      const cb = c < columns - 1 ? c + 1 : columns - 1;
      const ra = r > 0 ? r - 1 : 0;
      const rb = r < rows - 1 ? r + 1 : rows - 1;
      const dx = (heights[r * columns + cb]! - heights[r * columns + ca]!) / ((cb - ca) * cellX);
      const dz = (heights[rb * columns + c]! - heights[ra * columns + c]!) / ((rb - ra) * cellZ);
      const length = Math.sqrt(dx * dx + 1 + dz * dz);
      const i = (r * columns + c) * 3;
      out[i] = -dx / length;
      out[i + 1] = 1 / length;
      out[i + 2] = -dz / length;
    }
  }
}

/** The whole-field bake as an engine job (boot/jobs.ts registers it). */
export const TERRAIN_BAKE: JobKey<TerrainSpec, TerrainBake> = jobKey('terrain.bake');

export function bakeTerrain(spec: TerrainSpec): TerrainBake {
  const { columns, rows, cellX, cellZ } = gridOf(spec);
  const minX = -spec.width / 2;
  const minZ = -spec.depth / 2;
  const relief = new Relief(spec);
  const heights = new Float32Array(columns * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) heights[r * columns + c] = relief.at(minX + c * cellX, minZ + r * cellZ);
  }
  const normals = new Float32Array(columns * rows * 3);
  gridNormals(heights, columns, rows, cellX, cellZ, normals);

  const layers = spec.layers.length;
  const weights = new Float32Array(columns * rows * layers);
  const splat = new Splat(spec);
  const out = new Float64Array(layers);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const v = r * columns + c;
      splat.at(minX + c * cellX, minZ + r * cellZ, heights[v]!, normals[v * 3 + 1]!, out);
      for (let l = 0; l < layers; l++) weights[v * layers + l] = out[l]!;
    }
  }

  let holes: Uint8Array | null = null;
  const mask = new HoleMask(spec);
  if (mask.any) {
    holes = new Uint8Array((columns - 1) * (rows - 1));
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < columns - 1; c++) {
        if (mask.at(minX + (c + 0.5) * cellX, minZ + (r + 0.5) * cellZ)) holes[r * (columns - 1) + c] = 1;
      }
    }
  }
  return { spec, columns, rows, cellX, cellZ, heights, normals, weights, holes };
}
