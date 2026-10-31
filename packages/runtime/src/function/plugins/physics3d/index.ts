/**
 * physics3d — Rapier 3D. Contributes the `rigidbody` and
 * `collider` components (the same ids and SDK fields as physics2d), the collision/trigger
 * events and `ctx.physics`; steps the world in the kernel's 'physics' hook, once per fixed
 * step; and provides the `physics3d` service (function/services/physics3d.ts) through
 * which the characters and vehicles plugins move. It also turns the terrain service's
 * field (when a terrain plugin is present) into a static collider, builds `"mesh"` /
 * `"convex"` colliders from the model geometry service (render3d provides it; in a
 * data-only run, where models have no files and draw nothing, such a collider has no
 * shape), and gives each chunk of the scene's block world (voxels service) a fixed
 * trimesh collider.
 *
 * It also owns joints, force fields, surface materials, ragdolls, contact-force watches and
 * shape casts, and provides render interpolation (`render_pose`) and ragdoll bone poses
 * (`ragdoll_pose`) to the renderers (function/services/poses.ts).
 *
 * Boot contract: `await initPhysics3d()` before building a kernel with this plugin. One
 * `physics3d(...)` value serves one kernel (its component methods are bound to it).
 */

import { fail } from '../../../core/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import { PHYSICS3D_SERVICE, RAGDOLL_POSE_SERVICE, RENDER_POSE_SERVICE } from '../../services/index.js';
import { physicsComponents } from './components.js';
import { JOINT_BROKEN } from './joints.js';
import { LayerTable } from './layers.js';
import { IMPACT, MaterialTable } from './materials.js';
import type { MaterialSpec } from './materials.js';
import { physicsNamespace } from './namespace.js';
import { physicsService } from './service.js';
import { Physics3dSim } from './sim.js';
import type { SavedPhysics3d } from './sim.js';

export { initPhysics3d, physics3dReady } from './rapier.js';
export { CHARACTER_SKIN, COLLIDER, PHYSICS_EVENTS, RIGIDBODY, SHAPES_3D, terrainMesh } from './sim.js';
export { DEFAULT_LAYER } from './layers.js';
export { colliderSchema, RIGIDBODY_SCHEMA } from './components.js';
export { FORCE_FIELD } from './fields.js';
export { JOINT, JOINT_BROKEN } from './joints.js';
export { IMPACT } from './materials.js';
export type { MaterialSpec } from './materials.js';
export { normalizeBone, RAGDOLL } from './ragdoll.js';
export type { Hit, Physics3dNamespace } from './namespace.js';

export interface Physics3dOptions {
  /** m/s² along y — exactly what is applied. Default -9.8. */
  readonly gravity?: number;
  /** Declared collision layer names, in order; "default" always exists. */
  readonly layers?: readonly string[];
  /** Declared surface materials, by name. */
  readonly materials?: Readonly<Record<string, MaterialSpec>>;
  /** Draw physics-driven entities between fixed steps (default true). Presentation only. */
  readonly interpolate?: boolean;
}

export function physics3d(options: Physics3dOptions = {}): KernelPlugin {
  const gravity = options.gravity ?? -9.8;
  if (!Number.isFinite(gravity)) fail('PP3153', `physics3d gravity must be a finite number, got ${gravity}`);
  const layers = new LayerTable(options.layers ?? []);
  const materials = new MaterialTable(options.materials ?? {});
  let sim: Physics3dSim | undefined;
  let installedOn: Kernel | undefined;
  const current = (): Physics3dSim => {
    if (sim === undefined) fail('PP9152', 'physics3d is used before its kernel was built');
    return sim;
  };
  const kernel = (): Kernel => {
    if (installedOn === undefined) fail('PP9152', 'physics3d is used before its kernel was built');
    return installedOn;
  };

  return {
    id: 'physics3d',
    components: physicsComponents(layers, current, kernel),
    events: [JOINT_BROKEN, IMPACT],
    install(k) {
      if (installedOn !== undefined) {
        fail('PP9153', 'This physics3d plugin is already installed in another kernel', { fix: 'Call physics3d(...) once per kernel.' });
      }
      installedOn = k;
      const created = new Physics3dSim(k, gravity, layers, materials, options.interpolate ?? true);
      sim = created;
      k.provide(PHYSICS3D_SERVICE, physicsService(current));
      k.provide(RENDER_POSE_SERVICE, created.poses);
      k.provide(RAGDOLL_POSE_SERVICE, created.ragdolls);
      k.observeEntities({
        added: (records) => created.added(records),
        removed: (records) => created.removed(records),
        changed: (record) => created.changed(record),
      });
      k.addHook('physics', (dt) => created.step(dt));
      // Interpolation records where each step left things after EVERY plugin's physics work.
      k.addHook('physics', () => created.endStep(), { last: true });
    },
    // The kernel is done (hot reload, a host replacing the game): free the Rapier world it holds.
    dispose() {
      sim?.dispose();
      sim = undefined;
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, state) => current().restore(state as unknown as SavedPhysics3d),
    namespace: {
      name: 'physics',
      create: () => physicsNamespace(current, layers, gravity),
    },
  };
}
