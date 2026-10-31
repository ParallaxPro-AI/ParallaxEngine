/**
 * The `terrain` service: the current scene's heightfield, provided by the terrain plugin
 * (`kernel.service(TERRAIN_SERVICE).current()`). Consumers: render3d draws it (CDLOD tiles
 * from `tiles`), physics3d builds a collider from it, nav reads heights, slopes and water,
 * foliage scatters on its layers, the hud draws it on the map.
 *
 * Layout. The field is a regular grid of `columns × rows` vertices covering the scene's
 * `"terrain": {"size": [width, depth]}`, centered on the world origin. Vertex (c, r) is at
 *
 *   x = minX + c * cellX,   z = minZ + r * cellZ,   y = heights[r * columns + c]
 *
 * (rows run along +z, columns along +x). Each quad (c, r)…(c+1, r+1) is two triangles
 * split along the diagonal from vertex (c, r) to vertex (c+1, r+1):
 *
 *   A = (c, r), (c+1, r), (c+1, r+1)     where the local fx >= fz
 *   B = (c, r), (c+1, r+1), (c, r+1)     where the local fx <  fz
 *
 * `heightAt` and `normalAt` are exactly those triangles (continuous heights, flat
 * per-triangle normals), so a renderer or collider that uses the same split agrees with
 * every query to float precision. A physics heightfield (Rapier's takes `rows - 1` ×
 * `columns - 1` subdivisions, scale (width, 1, depth), centered on its body — place it at
 * the origin) must use the same diagonal, or bodies rest up to one triangle's bend away
 * from `heightAt`; check its cell split against these two triangles when wiring it.
 *
 * Heights are the baked relief plus the deformation layer (craters, trenches, flattening:
 * `TerrainService.deform`), already summed: `heights` is always the surface as it is now.
 *
 * Holes. `holes` marks quads (index `r * (columns - 1) + c`) with no ground — tunnel
 * mouths, pits. Colliders and renderers leave those quads out; `holeAt` asks about a point.
 * Height queries still answer over a hole (the surface the hole was cut from).
 *
 * Surfaces. `layers` are the scene's material layers in order (at most `MAX_LAYERS`);
 * `weights` holds, per vertex, one weight per layer (`weights[v * layers.length + l]`),
 * summing to 1 — the baked splat. `surfaceAt` is the layer with the largest bilinearly
 * interpolated weight (ties: the earlier layer). `splatAt` evaluates the authored splat at
 * any point at full precision (not the grid's): what finer streamed tiles are baked from.
 *
 * Chunks. `chunks` tiles the quads into blocks of at most `chunkQuads × chunkQuads` with
 * their height bounds and the `revision` at which their heights or holes last changed, so
 * a consumer rebuilds only what a deformation touched.
 *
 * Lifetime. A field is built when a scene with a terrain block loads (and again after a
 * snapshot restore), deterministically from the block: same data, same bits. `version`
 * increases with every build; `revision` increases with every change after it (a crater,
 * a hole). `current()` is null in scenes without terrain.
 */

import type { TerrainPattern3d, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';
import type { SceneDoc } from '../../resource/index.js';

/** Most material layers a terrain may declare. */
export const MAX_LAYERS = 8;

export type Rgb3 = readonly [number, number, number];

/**
 * The procedural surface an untextured layer is drawn with (render3d's terrain pass):
 * soil (mottled earth), grass (patchy, lush and dry), rock (strata and cracks, also on
 * cliffs), sand (wind ripples), paved (aggregate speckle), snow (soft drifts).
 */
export { TERRAIN_PATTERNS } from '../../core/index.js';
export type TerrainPattern = TerrainPattern3d;

export interface TerrainLayer {
  readonly name: string;
  /** Project-relative texture path or hosted URL (a named layer's ground material by default), or null: plain. */
  readonly texture: string | null;
  /** Tangent-space normal map (path or URL) for the texture, or null. */
  readonly normal: string | null;
  /** Meters per texture repeat. */
  readonly tile: number;
  /** Linear multiplier on the layer's color (the texture's, or its flat color). */
  readonly tint: Rgb3;
  /** Flat sRGB color for an untextured layer, or a textured layer's average tone; null: the renderer's tone for its index / the texture as is. */
  readonly color: Rgb3 | null;
  /** Surface roughness 0..1 (ground is matte: 0.9 by default). */
  readonly roughness: number;
  /** A finer texture multiplied in near the camera (grain, pebbles), or null. */
  readonly detail: { readonly texture: string; readonly tile: number; readonly strength: number } | null;
  /** The procedural surface of an untextured layer; null: the renderer's default for its name. */
  readonly pattern: TerrainPattern | null;
  /** 0..1: how much the surface varies (mottling, patches, large-scale tone); 0.5 by default. */
  readonly variation: number;
  /** 0..2: bump strength of the surface's relief (from the texture, or the pattern); 1 by default. */
  readonly relief: number;
}

export interface TerrainChunk {
  /** First quad column and row; quad counts along x and z. */
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
  /** Height range of the chunk's vertices (updated by deformation). */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** The field `revision` at which this chunk's heights or holes last changed (0: as built). */
  readonly revision: number;
}

/** A brush volume: tall grass (or reeds, crops) that hides what stands in it. */
export interface BrushVolume {
  readonly id: string;
  readonly tags: readonly string[];
  /** World height of the brush above the ground, meters. */
  readonly height: number;
  /** Bounding box in x/z. */
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** Whether (x, z) is inside the volume's footprint. */
  contains(x: number, z: number): boolean;
}

export interface TerrainPathLine {
  readonly paint: string | null;
  readonly points: readonly (readonly [number, number])[];
  readonly width: number;
  readonly closed: boolean;
}

export interface TerrainField {
  /** Increases with every build (scene load, restore). */
  readonly version: number;
  /** Increases with every change to heights or holes after the build. */
  readonly revision: number;
  /** The scene the field was built for. */
  readonly scene: string;
  readonly width: number;
  readonly depth: number;
  readonly minX: number;
  readonly minZ: number;
  /** Vertex counts along x and z (quads + 1). */
  readonly columns: number;
  readonly rows: number;
  /** Meters between vertices along x and z. */
  readonly cellX: number;
  readonly cellZ: number;
  /** `columns * rows` heights, row-major (index = row * columns + column). Changes in place on deformation. */
  readonly heights: Float32Array;
  /** Smooth per-vertex normals (x, y, z per vertex) for shading; queries use triangle normals. */
  readonly normals: Float32Array;
  /** Over the whole field (updated by deformation). */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** The water plane's height, or null when the scene declares no `water_level`. */
  readonly waterLevel: number | null;
  readonly layers: readonly TerrainLayer[];
  /** `columns * rows * layers.length` splat weights (see the module doc). */
  readonly weights: Float32Array;
  /** One byte per quad, 1 where the ground is cut away; null when the field has no holes. */
  readonly holes: Uint8Array | null;
  readonly brush: readonly BrushVolume[];
  /** The authored paths (roads, trails) as drawn: the layer painted along each (its name; null
   *  for grading-only paths), its centre line in (x, z) and its width. Consumers: the minimap. */
  readonly paths: readonly TerrainPathLine[];
  readonly chunkQuads: number;
  readonly chunks: readonly TerrainChunk[];

  /** Whether (x, z) is on the terrain (edges included). */
  contains(x: number, z: number): boolean;
  /** Height of the surface at (x, z). Outside the terrain: PP3203. */
  heightAt(x: number, z: number): number;
  /** Unit normal of the triangle under (x, z). Outside: PP3203. */
  normalAt(x: number, z: number): Vec3;
  /** Name of the dominant layer at (x, z). Outside: PP3203. */
  surfaceAt(x: number, z: number): string;
  /** The grid's bilinear weight of layer `layer` (an index) at (x, z), 0..1. Outside: PP3203. */
  weightAt(x: number, z: number, layer: number): number;
  /** `point` moved vertically onto the surface. Outside: PP3203. */
  ground(point: Vec3): Vec3;
  /** Whether the quad under (x, z) is a hole (false outside the terrain). */
  holeAt(x: number, z: number): boolean;
  /** The brush volume whose footprint holds (x, z) and whose top is above `y`, or null. */
  brushAt(x: number, y: number, z: number): BrushVolume | null;
  /**
   * The authored splat at (x, z) for a surface of height `height` and normal y `normalY`,
   * written into `out` (`layers.length` weights summing to 1): the rules, paint and paths
   * evaluated at the point rather than read from the grid.
   */
  splatAt(x: number, z: number, height: number, normalY: number, out: Float32Array): void;
  /** The analytic baked relief at (x, z), before deformation (finer than the grid). */
  reliefAt(x: number, z: number): number;
  /** The deformation layer's bilinear offset at (x, z), meters (0 without deformation). */
  deformationAt(x: number, z: number): number;
  /** The highest chunk `revision` overlapping the rectangle (what a cached tile compares). */
  revisionIn(minX: number, minZ: number, maxX: number, maxZ: number): number;
}

// ── Deformation ────────────────────────────────────────────────────────────────

/** One change to the ground, as data (snapshots and replays hold the list). */
export type TerrainEdit =
  /**
   * A bowl `depth` meters deep (negative: a mound) over `radius`, with a raised `rim`
   * (meters) around it; `layer` (an index, or null) is painted over the bowl (scorch, dirt).
   */
  | {
    readonly kind: 'crater'; readonly x: number; readonly z: number; readonly radius: number; readonly depth: number; readonly rim: number;
    readonly layer: number | null;
  }
  /** A channel from (x, z) to (x2, z2), `width` across and `depth` deep, eased over `feather`; `layer` painted along it. */
  | {
    readonly kind: 'trench'; readonly x: number; readonly z: number; readonly x2: number; readonly z2: number;
    readonly width: number; readonly depth: number; readonly feather: number; readonly layer: number | null;
  }
  /** The ground within `radius` eased to `height` (absolute), over `feather` outside it. */
  | { readonly kind: 'flatten'; readonly x: number; readonly z: number; readonly radius: number; readonly height: number; readonly feather: number }
  /** The quads under a disc cut away (a tunnel mouth, a pit). */
  | { readonly kind: 'hole'; readonly x: number; readonly z: number; readonly radius: number };

// ── Tiles (CDLOD) ──────────────────────────────────────────────────────────────

/** Quads along each side of every tile, at every level. */
export const TILE_QUADS = 32;

/**
 * The tile pyramid a renderer draws: level 0 tiles have `leafCell`-meter quads, each level
 * up doubles the cell (and the tile). Tile (level, ix, iz) covers
 * x in [originX + ix·size, originX + (ix+1)·size], size = TILE_QUADS · leafCell · 2^level,
 * and likewise z. Levels whose cell is at least the field's cell sample the field (exact,
 * deformation included); finer levels are streamed: baked from the authored relief and
 * splat at their own resolution, in a job when a job runner is there.
 */
export interface TerrainTiles {
  readonly leafCell: number;
  readonly levels: number;
  readonly originX: number;
  readonly originZ: number;
  /** The finest level sampled from the field (levels below it are streamed). */
  readonly fieldLevel: number;
  /**
   * The tile if it is baked and current, else null — and the tile is queued (streamed
   * levels) or built now (field levels, within `buildBudget`). Call each frame for the
   * tiles you want; least recently wanted tiles are evicted past the cache budget.
   */
  get(level: number, ix: number, iz: number): TerrainTile | null;
  /** Baked tiles held; tiles being baked; tiles baked so far. */
  readonly stats: { readonly resident: number; readonly pending: number; readonly baked: number };
}

/** One baked tile: `(TILE_QUADS + 1)²` vertices, row-major from its min corner. */
export interface TerrainTile {
  readonly level: number;
  readonly ix: number;
  readonly iz: number;
  /** Min corner and meters per quad. */
  readonly x: number;
  readonly z: number;
  readonly cell: number;
  /** Vertex heights. */
  readonly heights: Float32Array;
  /** Each vertex's height on the next coarser level (the geomorph target). */
  readonly morph: Float32Array;
  /** Smooth normals, 3 per vertex. */
  readonly normals: Float32Array;
  /** Up to four layer indices that carry this tile, strongest first. */
  readonly palette: readonly number[];
  /** Weights of the palette's layers, 4 per vertex (unused slots 0), summing to 1. */
  readonly weights: Float32Array;
  /** Whether some vertex here had weight on a layer outside the palette (blended away). */
  readonly dropped: boolean;
  /** One byte per quad, 1 = hole; null when none. */
  readonly holes: Uint8Array | null;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** The field revision it was baked at. */
  readonly revision: number;
}

export interface TerrainSplatMap {
  readonly key: string;
  readonly revision: number;
  readonly map: {
    readonly columns: number;
    readonly rows: number;
    /** Planes of three layers (RGB), stacked: plane p's rows follow plane p − 1's. */
    readonly planes: number;
    /** RGBA8, columns × rows × planes; a byte is a weight × 255. */
    readonly data: Uint8Array;
  };
}

export interface TerrainService {
  /** The current scene's field, or null when it declares no terrain. */
  current(): TerrainField | null;
  /** The current field's tile pyramid, or null without terrain. */
  tiles(): TerrainTiles | null;
  /**
   * The current field's splat map (the authored splat on a grid of at most 1 m, with
   * deformation paint), baked in the job runner on first request: null until it is ready,
   * and without terrain. `key` names the field; `revision` moves with each change.
   */
  splatMap(): TerrainSplatMap | null;
  /** Change the ground (and record the edit for snapshots). No terrain: PP3204. */
  deform(edit: TerrainEdit): void;
  /** The edits applied since the field was built, in order. */
  edits(): readonly TerrainEdit[];
  /**
   * Bake every scene's terrain in the job runner (workers in a browser) ahead of time; boot
   * awaits it before the first frame, and scenes then load from those bakes (the same bits
   * as baking on this thread). Without a job runner it does nothing: scenes bake as they load.
   */
  prebake(): Promise<void>;
}

export const TERRAIN_SERVICE: ServiceKey<TerrainService> = serviceKey<TerrainService>(
  'terrain', 'Add terrain() to Game(plugins=[...]) and a "terrain" block to the scene.',
);

/**
 * Ground another plugin asks the terrain to grade (and optionally paint) when it bakes a
 * scene, in the same shape as a terrain block's `paths` entry (world x/z points). The
 * procgen plugin provides it for race tracks (a Track on a terrain-grounded Spline).
 */
export interface TerrainGradePath {
  /** Terrain layer name painted along the path, or null (grading only). */
  readonly layer: string | null;
  readonly points: readonly (readonly [number, number])[];
  readonly closed: boolean;
  readonly width: number;
  readonly feather: number;
  readonly strength: number;
  readonly flatten: { readonly feather: number; readonly offset: number } | null;
}

export interface TerrainGradingService {
  /** The extra paths for a scene, read from its data alone (it runs before anything spawns). */
  paths(scene: SceneDoc): readonly TerrainGradePath[];
}

export const TERRAIN_GRADING_SERVICE: ServiceKey<TerrainGradingService> = serviceKey<TerrainGradingService>(
  'terrain_grading', 'Add procgen() to Game(plugins=[...]) to grade terrain under Tracks.',
);
