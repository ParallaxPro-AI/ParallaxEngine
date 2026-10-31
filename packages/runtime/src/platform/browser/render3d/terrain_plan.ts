/**
 * Packing the terrain uniform block (`TERRAIN_FIELDS`, terrain_shaders.ts) for one tile
 * palette and level: the palette's four materials (flat color or recolor tone × tint, mode
 * and material index, tint and tile, roughness, detail and array layer, relief, pattern and
 * variation), the level's geomorph window, the splat map's shape and the water level.
 */

import { TERRAIN_PATTERNS } from '../../../core/index.js';
import type { TerrainMaterial3d } from '../../../core/index.js';
import { linearRgb, offsetOf, TERRAIN_FIELDS } from './layout.js';

const COLOR = offsetOf(TERRAIN_FIELDS, 'layerColor');
const TINT = offsetOf(TERRAIN_FIELDS, 'layerTint');
const SURFACE = offsetOf(TERRAIN_FIELDS, 'layerSurface');
const RELIEF = offsetOf(TERRAIN_FIELDS, 'layerRelief');
const SPLAT = offsetOf(TERRAIN_FIELDS, 'terrainSplat');
const PATTERN = offsetOf(TERRAIN_FIELDS, 'layerPattern');
const PARAMS = offsetOf(TERRAIN_FIELDS, 'terrainParams');

/** The water level packed for a terrain without water: far below any ground. */
export const NO_WATER = -1e9;

/** A pattern and its variation in one float: the pattern's index + variation × 0.5 (the shader splits them). */
export function packPattern(pattern: TerrainMaterial3d['pattern'], variation: number): number {
  return Math.max(0, TERRAIN_PATTERNS.indexOf(pattern)) + Math.min(1, Math.max(0, variation)) * 0.5;
}

/** A slot's mode word: 0 untextured / 1 textured / 2 recolored, + 4 with a normal map, + 8 × the material's index. */
export function packLayerMode(material: TerrainMaterial3d, index: number): number {
  const mode = material.texture === null ? 0 : material.recolor ? 2 : 1;
  return mode + (material.texture !== null && material.normal !== null ? 4 : 0) + 8 * index;
}

export interface TerrainBlockFrame {
  /** Each material's layer in the terrain arrays (absent: its index among the textured materials). */
  readonly layers?: readonly number[];
  readonly waterLevel?: number | null;
  /** The splat map's shape, or null: blend by the vertex weights. */
  readonly splat?: { readonly width: number; readonly depth: number; readonly rows: number; readonly planes: number } | null;
}

export function packTerrainBlock(
  materials: readonly TerrainMaterial3d[], palette: readonly number[], morphStart: number, morphEnd: number, out: Float32Array, o: number,
  frame: TerrainBlockFrame = {},
): void {
  const textured = materials.filter((m) => m.texture !== null);
  for (let i = 0; i < 4; i++) {
    const index = palette[i];
    const m = index === undefined ? undefined : materials[index];
    if (m === undefined) {
      out.set([0, 0, 0, 0], o + COLOR + i * 4);
      out.set([1, 1, 1, 1], o + TINT + i * 4);
      out.set([1, 1, 0, 0], o + SURFACE + i * 4);
      out[o + RELIEF + i] = 0;
      out[o + PATTERN + i] = 0;
      continue;
    }
    const color = linearRgb(m.color);
    out.set([color[0] * m.tint[0], color[1] * m.tint[1], color[2] * m.tint[2], packLayerMode(m, index!)], o + COLOR + i * 4);
    out.set([m.tint[0], m.tint[1], m.tint[2], m.tile], o + TINT + i * 4);
    const layer = m.texture === null ? 0 : frame.layers?.[index!] ?? Math.max(0, textured.indexOf(m));
    out.set([m.roughness, m.detailTile, m.detail === null ? 0 : m.detailStrength, layer], o + SURFACE + i * 4);
    out[o + RELIEF + i] = m.relief;
    out[o + PATTERN + i] = packPattern(m.pattern, m.variation);
  }
  const s = frame.splat ?? null;
  out.set(s === null ? [1, 1, 1, 0] : [s.width, s.depth, s.rows, s.planes], o + SPLAT);
  out.set([palette.length, morphStart, morphEnd, frame.waterLevel ?? NO_WATER], o + PARAMS);
}
