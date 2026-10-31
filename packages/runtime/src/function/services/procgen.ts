/**
 * The `procgen` service: geometry the procgen plugin generates from data (swept paths —
 * roads, rails, coasters, pipes, race tracks — structures from character grids, dungeons),
 * as renderers, physics and other plugins use it (`kernel.service(PROCGEN_SERVICE)`, looked
 * up at use).
 *
 * Meshes. `meshes()` lists every generated mesh in the current scene, sorted by `key`.
 * Each belongs to the entity whose component made it (`entity`); its surfaces are in that
 * entity's local space and `world` places them (the entity's world matrix, column-major,
 * scale included). Surfaces are indexed triangle lists, counter-clockwise front faces
 * (seen from where the normal points), unit normals, `uvs` in meters along the surface
 * scaled by the part's texture repeat (v down, glTF's convention). A renderer keeps its GPU
 * buffers while a part's `geometry.id` is unchanged: ids carry the mesh `version`, which
 * increases whenever the source data changes. `world` may change every frame (a moving
 * platform) without a rebuild.
 *
 * Collision. `collision` is the solid triangles in WORLD space (baked with `world`),
 * suitable for one fixed trimesh collider in `layer` (default "default"); null when the
 * source says `collide: false`.
 * `collisionVersion` increases when the triangles change — data or the entity's
 * transform — so physics rebuilds the collider only then. Generated colliders are
 * scenery in the "default" layer, like the terrain and voxel chunks, and their hits name
 * the owning entity.
 *
 * Paths. Every entity with a `spline` component has a sampled centerline (`path`): world
 * space points every `spacing` meters with tangents, rights, ups and bank, arc length and
 * nearest-point queries. Racing AI, lap counting, minimaps and spawners use it.
 */

import type { EntityId, Geometry3d, Rgba } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** How a generated part looks (a renderer turns it into its own material). */
export interface GeneratedMaterial {
  /** Stable key: equal keys are the same material. */
  readonly id: string;
  /** sRGB, multiplied with the texture and the vertex colors. */
  readonly color: Rgba;
  /** Project-relative image path drawn repeating (REPEAT wrapping), or null. */
  readonly texture: string | null;
  /** Tangent-space normal map (linear data), tiled like `texture`; absent or null: none. */
  readonly normal?: string | null;
  readonly roughness: number;
  readonly metallic: number;
  /** Blended (drawn after opaque geometry, far to near) when the color's alpha or vertex alphas are below 1. */
  readonly blend: boolean;
  /** Draw both faces (open profiles seen from below, overlays). */
  readonly doubleSided: boolean;
  /** Ignore lights (overlays that show state, not material). */
  readonly unlit: boolean;
}

export interface GeneratedPart {
  /** Entity-local geometry; `colors` (sRGB RGBA per vertex) when the part has per-vertex tint. */
  readonly geometry: Geometry3d;
  readonly material: GeneratedMaterial;
  readonly castShadows: boolean;
}

/** A walkable connection the mesh makes that its triangles don't show nav (a Structure's flight of stairs), world space. */
export interface GeneratedLink {
  readonly start: readonly [number, number, number];
  readonly end: readonly [number, number, number];
}

export interface GeneratedMesh {
  /** `"<source>:<entity>"`, e.g. `"sweep:12"`, `"structure:40"`, `"mask:lawn"`. */
  readonly key: string;
  /** The entity whose component made it; null for scene-level sources (surface masks). */
  readonly entity: EntityId | null;
  /** Increases whenever the parts are rebuilt. */
  readonly version: number;
  readonly parts: readonly GeneratedPart[];
  /** Entity-local → world, 16 numbers column-major (identity for scene-level sources). */
  readonly world: Float32Array;
  readonly collision: { readonly vertices: Float32Array; readonly indices: Uint32Array } | null;
  readonly collisionVersion: number;
  /**
   * What nav reads instead of `collision` (world space, same version), when the two
   * differ: a Structure's flights as slopes instead of stepped treads.
   */
  readonly navCollision?: { readonly vertices: Float32Array; readonly indices: Uint32Array };
  /** The collision's physics layer (a Structure's or Dungeon's `layer`); absent: "default". */
  readonly layer?: string;
  /**
   * Nav links (kind "stairs", both ways): each flight of a Structure, from just before its
   * foot to just past its head. Stairs are too steep for nav's per-cell clearance to see as
   * floor, so agents path up them through these.
   */
  readonly links?: readonly GeneratedLink[];
}

/** One sample of a path, world space. */
export interface PathSample {
  /** Meters from the start along the curve. */
  readonly distance: number;
  readonly point: readonly [number, number, number];
  /** Unit direction of travel. */
  readonly tangent: readonly [number, number, number];
  /** Unit, to the right of travel, rolled by the bank. */
  readonly right: readonly [number, number, number];
  /** Unit, the surface's up, rolled by the bank. */
  readonly up: readonly [number, number, number];
  /** Degrees of roll about the tangent (positive leans the right side down). */
  readonly bank: number;
}

/** The nearest point of a path to a query point. */
export interface PathHit extends PathSample {
  /** Signed meters along `right` from the centerline to the query point. */
  readonly lateral: number;
  /** Meters from the query point to the centerline point. */
  readonly offset: number;
}

export interface SampledPath {
  readonly entity: EntityId;
  /** Increases when the path changes (data or transform). */
  readonly version: number;
  readonly closed: boolean;
  /** Meters. */
  readonly length: number;
  /** Samples from distance 0 to `length` (a closed path's last sample is not repeated). */
  readonly samples: readonly PathSample[];
  /** The interpolated sample at a distance (wrapped on closed paths, clamped on open ones). */
  at(distance: number): PathSample;
  /** The nearest centerline point to a world point (on closed paths, any distance). */
  nearest(x: number, y: number, z: number): PathHit;
}

export interface ProcgenService {
  /** Increases whenever a mesh is added, removed or rebuilt (not on transform-only moves). */
  readonly revision: number;
  meshes(): readonly GeneratedMesh[];
  /** The path of an entity with a `spline` component, or undefined. */
  path(entity: EntityId): SampledPath | undefined;
  /** Every path in the scene, in entity order. */
  paths(): readonly SampledPath[];
}

export const PROCGEN_SERVICE: ServiceKey<ProcgenService> = serviceKey<ProcgenService>(
  'procgen', 'Add procgen() to Game(plugins=[...]): it builds the meshes of Spline/Sweep/Track/Structure/Dungeon components.',
);
