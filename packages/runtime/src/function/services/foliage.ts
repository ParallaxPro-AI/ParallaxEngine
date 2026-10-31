/**
 * The `foliage` service: the scene's scattered vegetation and rocks, provided by the
 * foliage plugin from the scene's `"foliage"` block and drawn by render3d (instanced meshes
 * near the camera at two details, lit impostors beyond, GPU-style grass patches in a window
 * around it).
 *
 * Scatter layers hold every instance as plain arrays, grouped into square cells (`cells`,
 * `CELL_SIZE` meters) so a renderer culls and picks a tier per cell. The scatter is a
 * deterministic function of the scene (and the terrain it sits on): same data, same
 * instances, same order. Removing an instance (a felled tree) clears its `alive` byte and
 * bumps `revision`; the removed set is what a snapshot holds.
 *
 * Grass layers are not scattered ahead of time: `densityAt` says how dense the blades are
 * at a point (0..1 of the layer's `density`), and the renderer fills a window around the
 * camera with patches from it.
 */

import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';
import type { Rgb3 } from './terrain.js';

/** Meters per side of a scatter cell. */
export const CELL_SIZE = 32;

export const FOLIAGE_KINDS = ['tree', 'bush', 'plant', 'rock', 'model', 'grass'] as const;
export type FoliageKind = (typeof FOLIAGE_KINDS)[number];

/** Built-in procedural looks per kind (`model` uses a model file; grass has none). */
export const FOLIAGE_SPECIES: Readonly<Record<Exclude<FoliageKind, 'model' | 'grass'>, readonly string[]>> = {
  tree: ['broadleaf', 'pine', 'birch', 'willow', 'acacia', 'palm', 'dead'],
  bush: ['round', 'sprawl'],
  plant: ['fern', 'reed'],
  rock: ['boulder', 'slab'],
};

export interface FoliageCell {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** Ground height range of the cell's instances. */
  readonly minY: number;
  readonly maxY: number;
  /** The cell's instances: indices `start … start + count - 1` of the layer's arrays. */
  readonly start: number;
  readonly count: number;
}

export interface FoliageLayer {
  readonly id: string;
  readonly kind: Exclude<FoliageKind, 'grass'>;
  /** Built-in look (procedural kinds), or null for `model`. */
  readonly species: string | null;
  /** Project path of the model (`model` kind), else null. */
  readonly model: string | null;
  /** sRGB tint for leaves (trees, bushes, plants) or stone (rocks). */
  readonly color: Rgb3;
  /** 0..1: how much wind bends it. */
  readonly sway: number;
  /** Whether it blocks movement (physics reads these). */
  readonly collide: boolean;
  /** Meters: the instance's trunk/stone radius and height at scale 1 (collision, queries). */
  readonly radius: number;
  readonly height: number;
  readonly count: number;
  /** Per instance: ground position, yaw (degrees), uniform scale. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly scale: Float32Array;
  /** 1 while the instance stands, 0 once removed. */
  readonly alive: Uint8Array;
  readonly cells: readonly FoliageCell[];
}

export interface GrassLayer {
  readonly id: string;
  /** Blades per square meter at full density. */
  readonly density: number;
  /** Blade height range, meters. */
  readonly bladeHeight: readonly [number, number];
  /** sRGB blade color (tips are lighter). */
  readonly color: Rgb3;
  readonly sway: number;
  /** Meters around the camera that grass is drawn. */
  readonly radius: number;
  /** 0..1 of `density` at (x, z): its terrain layers, avoided layers, area and exclusions. */
  densityAt(x: number, z: number): number;
}

/** One instance, as queries return it. */
export interface FoliageHit {
  readonly layer: string;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
}

export interface FoliageService {
  layers(): readonly FoliageLayer[];
  grass(): readonly GrassLayer[];
  /** Increases whenever instances are scattered anew or removed. */
  readonly revision: number;
  /** Standing instances within `radius` of (x, z), nearest first; `layer` narrows to one layer id. */
  near(x: number, z: number, radius: number, layer?: string): FoliageHit[];
  /** Remove one instance (PP3231 when it doesn't exist or is already gone). */
  remove(layer: string, index: number): void;
}

export const FOLIAGE_SERVICE: ServiceKey<FoliageService> = serviceKey<FoliageService>(
  'foliage', 'Add foliage() to Game(plugins=[...]) and a "foliage" block to the scene.',
);
