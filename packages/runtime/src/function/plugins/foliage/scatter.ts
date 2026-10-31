/**
 * Scattering a foliage layer, deterministically.
 *
 * Suitability (0..1) at a point is the product of: inside the `area` (and the terrain),
 * outside every `exclude` footprint, not in a terrain hole or under water, the listed
 * terrain layers' strongest weight eased up through `min_weight`, the avoided layers'
 * strongest eased down through `avoid_weight`, the slope under `slope` and the height in
 * `height` (the platform engine's foliage rules: max weight, 0.5 and 0.35 thresholds).
 *
 * Scatter: a jittered grid over the area's bounds, cell size s = max(1/√density, spacing/0.6),
 * one candidate per cell at a hashed position (jitter range 1 − spacing/s, so neighbours
 * stay `spacing` apart), kept with probability suitability × density × s². Cells are
 * indexed in world coordinates, so moving the area's edge doesn't reshuffle what's inside.
 * Density is capped at `max` over the area, so `max` caps the candidates before
 * suitability thins them (as the platform engine did); should jitter still exceed `max`,
 * the candidates with the lowest hashed rank are kept (thinning evenly instead of cutting
 * off one side). Rocks then get a skewed size spread. Instances are grouped into
 * CELL_SIZE cells (stable order).
 */

import { footprintBounds, footprintArea, hash2, mixSeed, sdFootprint, smoothstep, valueNoise2 } from '../../../core/index.js';
import { CELL_SIZE } from '../../services/index.js';
import type { FoliageCell, TerrainField } from '../../services/index.js';
import type { FoliageLayerSpec } from './spec.js';

export interface Scattered {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly scale: Float32Array;
  readonly cells: FoliageCell[];
}

/** Terrain layer indices a spec names (resolved against the field). */
export interface Resolved {
  readonly on: readonly number[];
  readonly avoid: readonly number[];
}

/**
 * `soft` (grass) widens every edge into a ragged band instead of a line: listed terrain
 * layers ease in over SOFT_BAND of weight below `min_weight` (full from it up), avoided
 * layers over ±SOFT_AVOID_BAND around `avoid_weight`; the weights are read at a point
 * warped by up to SOFT_WARP meters and jittered by two octaves of value noise (~2.5 m and
 * ~0.9 m) in proportion to how partial they are (full interiors and bare cores stay exactly
 * 1 and 0); `exclude` footprints and the `area` fade over SOFT_MARGIN meters (also
 * jittered). Grass thins out unevenly toward a path, with a few stragglers past it.
 */
export const SOFT_BAND = 0.32;
export const SOFT_AVOID_BAND = 0.12;
export const SOFT_MARGIN = 1.6;
export const SOFT_WARP = 1.2;

/** A weight moved by `jitter` in proportion to how partial it is: 0 and 1 stay exactly put. */
function edgeJitter(w: number, jitter: number): number {
  const c = w <= 0 ? 0 : w >= 1 ? 1 : w;
  return c + jitter * 4 * c * (1 - c);
}

export function suitability(spec: FoliageLayerSpec, field: TerrainField | null, resolved: Resolved, x: number, z: number, soft = false): number {
  const jitter = soft ? (valueNoise2(x / 2.5, z / 2.5, mixSeed(spec.seed, 11)) - 0.5) * 0.55 + (valueNoise2(x / 0.9, z / 0.9, mixSeed(spec.seed, 12)) - 0.5) * 0.3 : 0;
  let c = 1;
  if (spec.area !== null) {
    const d = sdFootprint(spec.area, x, z);
    if (d > 0) return 0;
    if (soft) c *= smoothstep(0, SOFT_MARGIN, -d + jitter * SOFT_MARGIN);
  }
  for (const shape of spec.exclude) {
    const d = sdFootprint(shape, x, z);
    if (d <= 0) return 0;
    if (soft) c *= smoothstep(0, SOFT_MARGIN, d + jitter * SOFT_MARGIN);
  }
  if (c <= 0) return 0;
  if (field === null) return c;
  if (!field.contains(x, z) || field.holeAt(x, z)) return 0;
  const h = field.heightAt(x, z);
  if (field.waterLevel !== null && h < field.waterLevel) return 0;
  if (spec.heightBand !== null && (h < spec.heightBand[0] || h > spec.heightBand[1])) return 0;
  const band = soft ? SOFT_BAND : 0.1;
  // Soft: terrain-layer weights are read at a noise-warped point (±SOFT_WARP m), so the
  // boundary wanders even where the painted edge is sharp.
  let wx = x;
  let wz = z;
  if (soft) {
    const px = x + (valueNoise2(x / 3.1, z / 3.1, mixSeed(spec.seed, 13)) - 0.5) * SOFT_WARP * 2;
    const pz = z + (valueNoise2(x / 3.1, z / 3.1, mixSeed(spec.seed, 14)) - 0.5) * SOFT_WARP * 2;
    if (field.contains(px, pz)) {
      wx = px;
      wz = pz;
    }
  }
  if (spec.maxSlopeNormalY !== null) {
    const ny = field.normalAt(x, z).y;
    c *= smoothstep(spec.maxSlopeNormalY - 0.03, spec.maxSlopeNormalY + 0.03, ny);
    if (c <= 0) return 0;
  }
  if (resolved.on.length > 0) {
    let w = 0;
    for (const l of resolved.on) w = Math.max(w, field.weightAt(wx, wz, l));
    const jw = soft ? edgeJitter(w, jitter) : w;
    // Full density from `min_weight` up (the platform engine's hard threshold); soft grass
    // eases in over the band below it, so blends of the listed layers stay full.
    c *= spec.minWeight <= 0 ? 1 : soft
      ? smoothstep(Math.max(0, spec.minWeight - band), spec.minWeight, jw)
      : smoothstep(spec.minWeight - 0.1, spec.minWeight + 0.1, jw);
  }
  if (resolved.avoid.length > 0 && c > 0) {
    let w = 0;
    for (const l of resolved.avoid) w = Math.max(w, field.weightAt(wx, wz, l));
    const jw = soft ? edgeJitter(w, jitter) : w;
    // Around `avoid_weight` (the platform engine's 0.35 cut), narrowly, so grass runs up to the path's edge.
    const ab = soft ? SOFT_AVOID_BAND : 0.1;
    c *= 1 - smoothstep(Math.max(0.02, spec.avoidWeight - ab), Math.min(1, spec.avoidWeight + ab), jw);
  }
  return c;
}

/** Where a layer may scatter: its area, clipped to the terrain. Null when they don't meet. */
export function scatterBounds(spec: FoliageLayerSpec, field: TerrainField | null): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  let b = spec.area === null ? null : footprintBounds(spec.area, 0);
  if (field !== null) {
    const t = { minX: field.minX, minZ: field.minZ, maxX: field.minX + field.width, maxZ: field.minZ + field.depth };
    b = b === null ? t : { minX: Math.max(b.minX, t.minX), minZ: Math.max(b.minZ, t.minZ), maxX: Math.min(b.maxX, t.maxX), maxZ: Math.min(b.maxZ, t.maxZ) };
  }
  return b === null || b.minX >= b.maxX || b.minZ >= b.maxZ ? null : b;
}

export function scatter(spec: FoliageLayerSpec, field: TerrainField | null, resolved: Resolved): Scattered {
  const bounds = scatterBounds(spec, field);
  if (bounds === null) return { count: 0, x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0), yaw: new Float32Array(0), scale: new Float32Array(0), cells: [] };
  const boundsArea = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);
  const area = spec.area === null ? boundsArea : Math.min(boundsArea, footprintArea(spec.area));
  // `max` caps the candidates, before suitability thins them (the platform engine's rule:
  // count = min(max, density × area)), so a layer over mostly-unsuitable ground holds fewer.
  const density = Math.min(spec.density, spec.max / Math.max(area, 1e-6));
  const s = Math.max(1 / Math.sqrt(density), spec.spacing / 0.6);
  const range = spec.spacing > 0 ? Math.max(0.4, 1 - spec.spacing / s) : 1;
  const keep = density * s * s;
  const seed = spec.seed;
  const sx = mixSeed(seed, 1);
  const sz = mixSeed(seed, 2);
  const sa = mixSeed(seed, 3);
  const sr = mixSeed(seed, 4);

  const xs: number[] = [];
  const zs: number[] = [];
  const ranks: number[] = [];
  const keys: [number, number][] = [];
  const i0 = Math.floor(bounds.minX / s);
  const i1 = Math.ceil(bounds.maxX / s);
  const j0 = Math.floor(bounds.minZ / s);
  const j1 = Math.ceil(bounds.maxZ / s);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = (i + (1 - range) / 2 + hash2(i, j, sx) * range) * s;
      const z = (j + (1 - range) / 2 + hash2(i, j, sz) * range) * s;
      if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
      const roll = hash2(i, j, sa);
      if (roll >= keep) continue;
      const c = suitability(spec, field, resolved, x, z);
      if (roll >= keep * c) continue;
      xs.push(x);
      zs.push(z);
      ranks.push(hash2(i, j, sr));
      keys.push([i, j]);
    }
  }
  let order = xs.map((_, k) => k);
  if (order.length > spec.max) {
    order.sort((a, b) => ranks[a]! - ranks[b]! || a - b);
    order = order.slice(0, spec.max).sort((a, b) => a - b);
  }
  // Group by CELL_SIZE cell (row-major), keeping scatter order inside each cell.
  const cellOf = (k: number): [number, number] => [Math.floor(xs[k]! / CELL_SIZE), Math.floor(zs[k]! / CELL_SIZE)];
  order.sort((a, b) => {
    const [ax, az] = cellOf(a);
    const [bx, bz] = cellOf(b);
    return az - bz || ax - bx || a - b;
  });
  const n = order.length;
  const out: Scattered = {
    count: n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), yaw: new Float32Array(n), scale: new Float32Array(n), cells: [],
  };
  const syaw = mixSeed(seed, 5);
  const sscale = mixSeed(seed, 6);
  let start = 0;
  for (let k = 0; k < n; k++) {
    const src = order[k]!;
    const [i, j] = keys[src]!;
    out.x[k] = xs[src]!;
    out.z[k] = zs[src]!;
    out.y[k] = field === null ? 0 : field.heightAt(xs[src]!, zs[src]!);
    out.yaw[k] = hash2(i, j, syaw) * 360;
    out.scale[k] = spec.scale[0] + (spec.scale[1] - spec.scale[0]) * hash2(i, j, sscale);
    // Rocks come in a skewed spread of sizes, many small and a few large (×0.55 … ×1.75).
    if (spec.kind === 'rock') out.scale[k]! *= 0.55 + 1.2 * hash2(i, j, mixSeed(seed, 7)) ** 2.2;
    const [cx, cz] = cellOf(src);
    const next = k + 1 < n ? cellOf(order[k + 1]!) : null;
    if (next === null || next[0] !== cx || next[1] !== cz) {
      out.cells.push(cellBounds(out, start, k + 1 - start, cx, cz));
      start = k + 1;
    }
  }
  return out;
}

export function cellBounds(s: Pick<Scattered, 'y'>, start: number, count: number, cx: number, cz: number): FoliageCell {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = start; k < start + count; k++) {
    const y = s.y[k]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX: cx * CELL_SIZE, minZ: cz * CELL_SIZE, maxX: (cx + 1) * CELL_SIZE, maxZ: (cz + 1) * CELL_SIZE, minY, maxY, start, count };
}
