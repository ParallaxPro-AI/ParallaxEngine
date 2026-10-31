/**
 * The splat map: the authored splat (bake.ts `Splat`) on a grid finer than the field, at
 * most SPLAT_MAP_CELL meters, so a renderer blends materials per pixel instead of between
 * mesh vertices (whose spacing grows with distance: a 2 m path drawn through 4 m vertices
 * comes out as a staircase). Rules read the field's authored heights and normals,
 * interpolated; paint and paths are evaluated exactly at each point.
 *
 * Layout: three layers per plane (RGB; alpha is always 255, so no image path can
 * premultiply the weights away), planes stacked: plane p's `rows` rows follow plane p−1's.
 * A byte is a weight × 255. Deformation paint (a crater's layer) is applied to it as to the
 * field (`paintSplatMap`), and `revision` counts those changes.
 */

import { jobKey } from '../../../core/index.js';
import type { JobKey } from '../../../core/index.js';
import { Splat } from './bake.js';
import type { TerrainSpec } from './spec.js';

/** Coarsest splat-map cell, meters. */
export const SPLAT_MAP_CELL = 1;
/** Most texels per side. */
export const SPLAT_MAP_MAX = 2048;
/** Layers per plane. */
export const SPLAT_PLANE_LAYERS = 3;

export interface SplatMapInput {
  readonly spec: TerrainSpec;
  /** The field's authored grid (bake heights and normals). */
  readonly columns: number;
  readonly rows: number;
  readonly heights: Float32Array;
  readonly normals: Float32Array;
}

export interface SplatMap {
  readonly columns: number;
  readonly rows: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly planes: number;
  /** RGBA8, `columns` × `rows × planes`. */
  readonly data: Uint8Array;
}

export const TERRAIN_SPLAT_MAP: JobKey<SplatMapInput, SplatMap> = jobKey('terrain.splat_map');

/** The splat map's grid for a terrain: cells of at most SPLAT_MAP_CELL, at most SPLAT_MAP_MAX per side. */
export function splatMapGrid(spec: TerrainSpec): { columns: number; rows: number; cellX: number; cellZ: number } {
  const columns = Math.min(SPLAT_MAP_MAX, Math.ceil(spec.width / SPLAT_MAP_CELL) + 1);
  const rows = Math.min(SPLAT_MAP_MAX, Math.ceil(spec.depth / SPLAT_MAP_CELL) + 1);
  return { columns, rows, cellX: spec.width / (columns - 1), cellZ: spec.depth / (rows - 1) };
}

export function bakeSplatMap(input: SplatMapInput): SplatMap {
  const { spec, heights, normals } = input;
  const { columns, rows, cellX, cellZ } = splatMapGrid(spec);
  const layers = spec.layers.length;
  const planes = Math.ceil(layers / SPLAT_PLANE_LAYERS);
  const data = new Uint8Array(columns * rows * planes * 4);
  const splat = new Splat(spec);
  const weights = new Float64Array(layers);
  const fc = input.columns;
  const fr = input.rows;
  const minX = -spec.width / 2;
  const minZ = -spec.depth / 2;
  for (let r = 0; r < rows; r++) {
    const z = minZ + r * cellZ;
    const gz = Math.min(fr - 1.000001, Math.max(0, (r / (rows - 1)) * (fr - 1)));
    const r0 = Math.floor(gz);
    const tz = gz - r0;
    for (let c = 0; c < columns; c++) {
      const x = minX + c * cellX;
      const gx = Math.min(fc - 1.000001, Math.max(0, (c / (columns - 1)) * (fc - 1)));
      const c0 = Math.floor(gx);
      const tx = gx - c0;
      const at = (a: Float32Array, stride: number, k: number): number => {
        const v00 = a[(r0 * fc + c0) * stride + k]!;
        const v10 = a[(r0 * fc + c0 + 1) * stride + k]!;
        const v01 = a[((r0 + 1) * fc + c0) * stride + k]!;
        const v11 = a[((r0 + 1) * fc + c0 + 1) * stride + k]!;
        return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
      };
      splat.at(x, z, at(heights, 1, 0), at(normals, 3, 1), weights);
      writeTexel(data, columns, rows, c, r, weights);
    }
  }
  return { columns, rows, cellX, cellZ, planes, data };
}

function writeTexel(data: Uint8Array, columns: number, rows: number, c: number, r: number, weights: ArrayLike<number>): void {
  const planes = Math.ceil(weights.length / SPLAT_PLANE_LAYERS);
  for (let p = 0; p < planes; p++) {
    const o = ((p * rows + r) * columns + c) * 4;
    for (let k = 0; k < SPLAT_PLANE_LAYERS; k++) {
      const w = weights[p * SPLAT_PLANE_LAYERS + k] ?? 0;
      data[o + k] = Math.round(Math.min(1, Math.max(0, w)) * 255);
    }
    data[o + 3] = 255;
  }
}

/** One layer's weight at a texel, 0..1. */
export function splatMapWeight(map: SplatMap, c: number, r: number, layer: number): number {
  const p = Math.floor(layer / SPLAT_PLANE_LAYERS);
  return map.data[((p * map.rows + r) * map.columns + c) * 4 + (layer % SPLAT_PLANE_LAYERS)]! / 255;
}

/**
 * Paint `layer` over the texels within `bounds` by `coverAt` (0..1), the way the field's
 * vertex weights are painted (blend over: the others scale by 1 − cover).
 */
export function paintSplatMap(
  map: SplatMap, layers: number, layer: number, minX: number, minZ: number,
  bounds: { readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number }, coverAt: (x: number, z: number) => number,
): boolean {
  const c0 = Math.max(0, Math.floor((bounds.x0 - minX) / map.cellX));
  const c1 = Math.min(map.columns - 1, Math.ceil((bounds.x1 - minX) / map.cellX));
  const r0 = Math.max(0, Math.floor((bounds.z0 - minZ) / map.cellZ));
  const r1 = Math.min(map.rows - 1, Math.ceil((bounds.z1 - minZ) / map.cellZ));
  const w = new Float64Array(layers);
  let changed = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cover = coverAt(minX + c * map.cellX, minZ + r * map.cellZ);
      if (!(cover > 0)) continue;
      for (let l = 0; l < layers; l++) w[l] = splatMapWeight(map, c, r, l) * (1 - cover);
      w[layer] = w[layer]! + cover;
      writeTexel(map.data, map.columns, map.rows, c, r, w);
      changed = true;
    }
  }
  return changed;
}
