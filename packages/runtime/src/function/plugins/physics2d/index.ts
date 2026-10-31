/**
 * physics2d — Rapier 2D. Contributes the `rigidbody` and
 * `collider` components, the collision/trigger events and `ctx.physics`; steps the world
 * in the kernel's 'physics' hook, once per fixed step.
 *
 * Boot contract: `await initPhysics2d()` before building a kernel with this plugin. One
 * `physics2d(...)` value serves one kernel (its component methods are bound to it).
 */

import { fail } from '../../../core/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import { PHYSICS2D_SERVICE, RENDER_POSE_SERVICE } from '../../services/index.js';
import { physicsComponents } from './components.js';
import { JOINT_BROKEN } from './joints.js';
import { LayerTable } from './layers.js';
import { IMPACT, MaterialTable } from './materials.js';
import type { MaterialSpec } from './materials.js';
import { physicsNamespace } from './namespace.js';
import { physicsService } from './service.js';
import { Physics2dSim } from './sim.js';
import type { SavedPhysics2d } from './sim.js';

export { initPhysics2d, physics2dReady } from './rapier.js';
export { COLLIDER, PHYSICS_EVENTS, RIGIDBODY } from './sim.js';
export type { Hit } from './sim.js';
export { DEFAULT_LAYER } from './layers.js';
export { SHAPES_2D } from './components.js';
export type { PhysicsNamespace } from './namespace.js';
export { FORCE_FIELD } from './fields.js';
export { JOINT, JOINT_BROKEN } from './joints.js';
export { IMPACT } from './materials.js';
export type { MaterialSpec } from './materials.js';

export interface Physics2dOptions {
  /** m/s² along y — exactly what is applied. Default -9.8. */
  readonly gravity?: number;
  /** Declared collision layer names, in order; "default" always exists. */
  readonly layers?: readonly string[];
  /** Declared surface materials, by name. */
  readonly materials?: Readonly<Record<string, MaterialSpec>>;
  /** Draw physics-driven entities between fixed steps (default true). Presentation only. */
  readonly interpolate?: boolean;
}

export function physics2d(options: Physics2dOptions = {}): KernelPlugin {
  const gravity = options.gravity ?? -9.8;
  if (!Number.isFinite(gravity)) fail('PP3300', `physics2d gravity must be a finite number, got ${gravity}`);
  const layers = new LayerTable(options.layers ?? []);
  const materials = new MaterialTable(options.materials ?? {});
  let sim: Physics2dSim | undefined;
  let installedOn: Kernel | undefined;
  const current = (): Physics2dSim => {
    if (sim === undefined) fail('PP9302', 'physics2d is used before its kernel was built');
    return sim;
  };

  return {
    id: 'physics2d',
    components: physicsComponents(layers, current),
    events: [JOINT_BROKEN, IMPACT],
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP9303', 'This physics2d plugin is already installed in another kernel', {
          fix: 'Call physics2d(...) once per kernel.',
        });
      }
      installedOn = kernel;
      const created = new Physics2dSim(kernel, gravity, layers, materials, options.interpolate ?? true);
      sim = created;
      kernel.provide(PHYSICS2D_SERVICE, physicsService(current, layers));
      kernel.provide(RENDER_POSE_SERVICE, created.poses);
      kernel.observeEntities({
        added: (records) => created.added(records),
        removed: (records) => created.removed(records),
        changed: (record) => created.changed(record),
      });
      kernel.addHook('physics', (dt) => created.step(dt));
      // Interpolation records where each step left things after EVERY plugin's physics work.
      kernel.addHook('physics', () => created.endStep(), { last: true });
    },
    // The kernel is done (hot reload, a host replacing the game): free the Rapier world it holds.
    dispose() {
      sim?.dispose();
      sim = undefined;
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, state) => current().restore(state as unknown as SavedPhysics2d),
    namespace: {
      name: 'physics',
      create: () => physicsNamespace(current, layers, gravity),
    },
  };
}
