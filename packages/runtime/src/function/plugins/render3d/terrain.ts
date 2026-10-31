/**
 * The terrain as the renderer draws it: CDLOD tiles from the terrain service's tile
 * pyramid (`TerrainTiles`), selected each frame around the cameras (terrain_cdlod.ts), each
 * turned into a world-space `Geometry3d` once per baked tile (palette weights as vertex
 * colors, geomorph target heights in the first texture coordinate, holes left out), plus
 * the terrain's materials (layers: texture or flat color and pattern, tint, roughness,
 * detail, variation, relief) and its water level.
 *
 * A tile that blends more than four layers keeps its four strongest (the rest are folded
 * in); that is reported once as a warning (PP3830) so a scene can move a paint.
 */

import type { Geometry3d, Quality3d, Rgb, TerrainMaterial3d, TerrainPattern3d, TerrainSplat3d, Terrain3d, Texture3d, View3d } from '../../../core/index.js';
import { TILE_QUADS } from '../../services/index.js';
import type { TerrainField, TerrainSplatMap, TerrainTile, TerrainTiles } from '../../services/index.js';
import { frustumPlanes, selectTiles } from './terrain_cdlod.js';

/** Flat tones for untextured, uncolored layers with a common name (sRGB). */
export const NAMED_LAYER_COLORS: Readonly<Record<string, Rgb>> = {
  grass: [0.42, 0.55, 0.3], meadow: [0.45, 0.58, 0.3], moss: [0.33, 0.45, 0.22], forest: [0.3, 0.4, 0.22],
  dirt: [0.48, 0.38, 0.28], mud: [0.36, 0.28, 0.2], soil: [0.45, 0.34, 0.24], path: [0.55, 0.47, 0.36],
  sand: [0.78, 0.71, 0.52], beach: [0.8, 0.74, 0.56], gravel: [0.55, 0.53, 0.5], rock: [0.5, 0.48, 0.45], stone: [0.55, 0.54, 0.52],
  road: [0.3, 0.3, 0.32], asphalt: [0.25, 0.25, 0.27], concrete: [0.62, 0.62, 0.6], pavement: [0.58, 0.57, 0.55],
  snow: [0.9, 0.92, 0.95], ice: [0.75, 0.85, 0.92],
};

/** Procedural surfaces for layers with a common name and no `pattern` (anything else draws soil). */
export const NAMED_LAYER_PATTERNS: Readonly<Record<string, TerrainPattern3d>> = {
  grass: 'grass', meadow: 'grass', moss: 'grass', forest: 'grass', lawn: 'grass', jungle: 'grass',
  rock: 'rock', stone: 'rock', cliff: 'rock', gravel: 'rock',
  sand: 'sand', beach: 'sand', dune: 'sand', desert: 'sand',
  road: 'paved', asphalt: 'paved', concrete: 'paved', pavement: 'paved', tarmac: 'paved',
  snow: 'snow', ice: 'snow',
};

/** Flat tones for other untextured, uncolored layers, by layer index. */
export const UNTEXTURED_LAYER_COLORS: readonly Rgb[] = [
  [0.42, 0.55, 0.3], [0.5, 0.47, 0.42], [0.76, 0.7, 0.52], [0.35, 0.35, 0.37],
  [0.55, 0.45, 0.32], [0.62, 0.62, 0.6], [0.3, 0.42, 0.25], [0.82, 0.84, 0.86],
];

/** Tile ranges in tile sizes, by quality: how far each level reaches before the next coarser one. */
export const RANGE_SCALE: Readonly<Record<Quality3d['level'], number>> = { low: 2, medium: 2.5, high: 3 };
export const MORPH_FRACTION = 0.3;

const V = TILE_QUADS + 1;

/** A baked tile as world-space geometry. */
export function tileGeometry(tile: TerrainTile, id: string): Geometry3d {
  const count = V * V;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let r = 0; r < V; r++) {
    for (let c = 0; c < V; c++) {
      const v = r * V + c;
      positions[v * 3] = tile.x + c * tile.cell;
      positions[v * 3 + 1] = tile.heights[v]!;
      positions[v * 3 + 2] = tile.z + r * tile.cell;
      uvs[v * 2] = tile.morph[v]!;
    }
  }
  const holes = tile.holes;
  let quads = TILE_QUADS * TILE_QUADS;
  if (holes !== null) for (const h of holes) quads -= h;
  const indices = new Uint16Array(quads * 6);
  let i = 0;
  for (let r = 0; r < TILE_QUADS; r++) {
    for (let c = 0; c < TILE_QUADS; c++) {
      if (holes !== null && holes[r * TILE_QUADS + c] === 1) continue;
      const a = r * V + c;
      const b = a + 1;
      const d = a + V;
      const e = d + 1;
      // The terrain service's split: triangles (a, b, e) and (a, e, d), wound so their cross points up.
      indices[i++] = a; indices[i++] = e; indices[i++] = b;
      indices[i++] = a; indices[i++] = d; indices[i++] = e;
    }
  }
  const size = TILE_QUADS * tile.cell;
  return {
    id, positions, normals: tile.normals, uvs, indices, joints: null, weights: null, colors: tile.weights,
    min: [tile.x, Math.min(tile.minHeight, morphMin(tile)), tile.z], max: [tile.x + size, Math.max(tile.maxHeight, morphMax(tile)), tile.z + size],
  };
}

function morphMin(tile: TerrainTile): number {
  let lo = Infinity;
  for (const h of tile.morph) if (h < lo) lo = h;
  return lo;
}

function morphMax(tile: TerrainTile): number {
  let hi = -Infinity;
  for (const h of tile.morph) if (h > hi) hi = h;
  return hi;
}

export function terrainMaterials(field: TerrainField, texture: (path: string) => Texture3d): TerrainMaterial3d[] {
  return field.layers.map((layer, i) => ({
    texture: layer.texture === null ? null : texture(layer.texture),
    normal: layer.texture === null || layer.normal === null ? null : texture(layer.normal),
    recolor: layer.texture !== null && layer.color !== null,
    tile: layer.tile,
    color: layer.color ?? NAMED_LAYER_COLORS[layer.name] ?? UNTEXTURED_LAYER_COLORS[i]!,
    tint: layer.tint,
    roughness: layer.roughness,
    detail: layer.detail === null ? null : texture(layer.detail.texture),
    detailTile: layer.detail?.tile ?? 1,
    detailStrength: layer.detail?.strength ?? 0,
    pattern: layer.pattern ?? NAMED_LAYER_PATTERNS[layer.name] ?? 'soil',
    variation: layer.variation,
    relief: layer.relief,
  }));
}

export interface TerrainFrameStats {
  readonly tiles: number;
  readonly byLevel: readonly number[];
  readonly resident: number;
  readonly pending: number;
}

/** Per-kernel terrain drawing: geometry per baked tile, selection per frame. */
export class TerrainDraws {
  readonly #geometry = new WeakMap<TerrainTile, Geometry3d>();
  #lastSplat: TerrainSplat3d | null = null;
  #dropped = false;
  #stats: TerrainFrameStats = { tiles: 0, byLevel: [], resident: 0, pending: 0 };

  get stats(): TerrainFrameStats {
    return this.#stats;
  }

  /** Whether some drawn tile folded a fifth layer away (reported once). */
  takeDropped(): boolean {
    const d = this.#dropped;
    this.#dropped = false;
    return d;
  }

  draw(field: TerrainField, tiles: TerrainTiles, views: readonly View3d[], quality: Quality3d, texture: (path: string) => Texture3d,
    splatMap: TerrainSplatMap | null = null): Terrain3d {
    const selected = selectTiles({
      levels: tiles.levels,
      originX: tiles.originX,
      originZ: tiles.originZ,
      leafSize: TILE_QUADS * tiles.leafCell,
      width: field.width,
      depth: field.depth,
      minHeight: field.minHeight,
      maxHeight: field.maxHeight,
      get: (level, ix, iz) => tiles.get(level, ix, iz),
      bounds: (tile) => ({ minHeight: Math.min(tile.minHeight, morphMin(tile)), maxHeight: Math.max(tile.maxHeight, morphMax(tile)) }),
    }, {
      cameras: views.map((v) => v.position),
      frusta: views.map((v) => frustumPlanes(v.viewProjection)),
      rangeScale: RANGE_SCALE[quality.level],
      morphFraction: MORPH_FRACTION,
    });
    const byLevel = new Array<number>(tiles.levels).fill(0);
    const out = selected.map((s) => {
      let geometry = this.#geometry.get(s.tile);
      if (geometry === undefined) {
        geometry = tileGeometry(s.tile, `terrain:${field.scene}:${field.version}:${s.level}:${s.ix}:${s.iz}:${s.tile.revision}`);
        this.#geometry.set(s.tile, geometry);
      }
      if (s.tile.dropped) this.#dropped = true;
      byLevel[s.level]!++;
      return { geometry, palette: s.tile.palette, morphStart: s.morphStart, morphEnd: s.morphEnd, level: s.level };
    });
    const st = tiles.stats;
    this.#stats = { tiles: out.length, byLevel, resident: st.resident, pending: st.pending };
    return { tiles: out, materials: terrainMaterials(field, texture), waterLevel: field.waterLevel, splat: this.#splat(field, splatMap) };
  }

  #splat(field: TerrainField, s: TerrainSplatMap | null): TerrainSplat3d | null {
    if (s === null) return null;
    const key = `${s.key}:${s.revision}`;
    if (this.#lastSplat?.key !== key) {
      this.#lastSplat = { key, width: field.width, depth: field.depth, columns: s.map.columns, rows: s.map.rows, planes: s.map.planes, data: s.map.data };
    }
    return this.#lastSplat;
  }
}
