/**
 * The `city` service: the generated city of the current scene (the city plugin, from the
 * scene's `"city"` block), as renderers, physics and nav use it (`kernel.tryService`).
 *
 * `meshes()` uses procgen's `GeneratedMesh` shape (so one renderer hook draws both): one mesh
 * per chunk of the city, at the level of detail its distance to the nearest streaming source
 * asks for, plus the signal lamps and the far skyline. Scene-level meshes: `entity` is null
 * and `world` is the identity. A chunk's `collision` (world space) is the same at every level
 * of detail and its `collisionVersion` changes only when the city is rebuilt, so physics and
 * nav index it once. Part geometry ids name the chunk and level, so a renderer keeps their
 * buffers while a chunk stays at one level.
 *
 * `map()` is the city as a street map draws it (the HUD minimap): blocks, parks, building
 * footprints and street centerlines on the (x, z) plane. The same object comes back until
 * the city is rebuilt, so a reader compares it by identity to know when to redraw.
 */

import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';
import type { GeneratedMesh } from './procgen.js';

export interface CityService {
  /** Increases whenever the mesh list or a mesh's parts change. */
  readonly revision: number;
  meshes(): readonly GeneratedMesh[];
  /** The scene's city as a plan view, or null when the scene has no city. */
  map(): CityMap | null;
}

/** A point on the ground plane: (x, z). */
export type CityMapPoint = readonly [number, number];

export interface CityMapStreet {
  readonly a: CityMapPoint;
  readonly b: CityMapPoint;
  /** Curb to curb (m). */
  readonly width: number;
  /** An avenue (vs a side street): drawn brighter and wider. */
  readonly major: boolean;
}

export interface CityMap {
  /** World bounds of everything built (x0, z0, x1, z1). */
  readonly bounds: readonly [number, number, number, number];
  /** Block platforms (curb lines), parks and plazas included. */
  readonly blocks: readonly (readonly CityMapPoint[])[];
  /** Parks and plazas (inside the sidewalks). */
  readonly parks: readonly (readonly CityMapPoint[])[];
  /** Building footprints. */
  readonly buildings: readonly (readonly CityMapPoint[])[];
  readonly streets: readonly CityMapStreet[];
}

export const CITY_SERVICE: ServiceKey<CityService> = serviceKey<CityService>(
  'city', 'Add city() to Game(plugins=[...]): it builds the scene\'s "city" block.',
);
