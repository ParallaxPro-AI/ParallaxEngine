/**
 * The `surface_masks` service: the paintable layer volumes of `surface_mask` components
 * (the visuals plugin's surface_mask.ts) as renderers read them. render3d turns one into a
 * `MaterialPaint3d`: the cells as a `pixels` texture and the volume's place on the entity.
 */

import { serviceKey } from '../kernel/index.js';
import type { EntityRecord, Fields, ServiceKey } from '../kernel/index.js';

/** A built mask: a volume of cubic cells in the entity's own space, one RGBA8 texel each. */
export interface SurfaceMaskView {
  /** Cells along x, y, z. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Meters per cell (entity space), and the volume's low corner. */
  readonly cell: number;
  readonly min: readonly [number, number, number];
  /** Slices per row of the texel atlas, and its size in texels. */
  readonly tiles: number;
  readonly width: number;
  readonly height: number;
  /** How many layers it holds (texel channels in use). */
  readonly layers: readonly unknown[];
  /** Grows with every change. */
  readonly version: number;
  /** The amounts as RGBA8 texels: slice z at column `z % tiles`, row `floor(z / tiles)`. */
  texels(): Uint8Array;
}

export interface SurfaceMasksService {
  /** The mask of an entity's surface_mask component, built on first use; undefined while its model is still loading. */
  mask(record: EntityRecord, fields: Fields): SurfaceMaskView | undefined;
}

export const SURFACE_MASKS_SERVICE: ServiceKey<SurfaceMasksService> = serviceKey<SurfaceMasksService>(
  'surface_masks', 'Surface masks are kept by the visuals plugin, which every game has.',
);
