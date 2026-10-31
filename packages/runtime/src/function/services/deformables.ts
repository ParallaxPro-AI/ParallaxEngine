/**
 * Deformable meshes: geometry that plugins build and change at run time — cloth and soft
 * bodies (softbody plugin) — as renderers draw them. Each provider has its own key; a
 * renderer draws every source in `DEFORMABLE_MESH_SOURCES` it finds (`kernel.tryService(key)`),
 * with the same code it draws procgen's meshes with: the mesh shape is procgen's `GeneratedMesh`.
 *
 * Dynamic geometry. A cloth or a soft body keeps ONE `Geometry3d` object per part for its
 * whole life and rewrites `positions`, `normals`, `min` and `max` in place every fixed
 * step; its `version` increases each time (render3d port: "a surface re-uploads them when
 * it differs"). A renderer hands that geometry to the surface as is — it must not cache by
 * `id` alone for these.
 *
 * Spaces. Cloth and soft-body surfaces are simulated in world space: their `world` is the
 * identity.
 *
 * Collision is null for every deformable mesh: the solvers collide on their own.
 */

import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';
import type { GeneratedMesh } from './procgen.js';

export interface DeformableMeshSource {
  /** Increases whenever a mesh is added or removed, or a part's geometry is replaced (not on in-place updates). */
  readonly revision: number;
  /** Every mesh this source draws in the current scene, sorted by `key`. */
  meshes(): readonly GeneratedMesh[];
}

export const SOFTBODY_MESHES: ServiceKey<DeformableMeshSource> = serviceKey<DeformableMeshSource>(
  'softbody_meshes', 'Add softbody() to Game(plugins=[...]): it simulates Cloth and SoftBody components.',
);

/** Every deformable mesh source, in drawing order (a renderer draws whichever are provided). */
export const DEFORMABLE_MESH_SOURCES: readonly ServiceKey<DeformableMeshSource>[] = [SOFTBODY_MESHES];
