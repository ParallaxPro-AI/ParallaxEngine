/**
 * The 3D side of `parallax.physics` / `parallax.plugins`: the `physics3d(...)` factory.
 * `Rigidbody`, `Collider`, `Layers`, `layer`, `RayHit` and the event handles live in
 * `./physics.ts` and serve both dimensions — physics2d and physics3d contribute the same
 * component ids (`rigidbody`, `collider`) with the SDK's field names, mount the same
 * `ctx.physics` namespace name and emit the kernel's shared collision events, and a game
 * lists exactly one of them. The behavior lives in the physics3d plugin.
 */

import { physics3d as physics3dPlugin } from '../function/plugins/physics3d/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { physicsOptions } from './physics.js';

export type { Hit as RayHit, Physics3dNamespace as PhysicsApi3d } from '../function/plugins/physics3d/index.js';
export { initPhysics3d } from '../function/plugins/physics3d/index.js';

/**
 * `parallax.plugins.physics3d(*, gravity=-9.8, layers=None, materials=None, interpolate=True)`:
 * binds Python arguments and builds the kernel plugin. Boot must `await initPhysics3d()`
 * before the kernel is built.
 */
export function physics3d(...args: unknown[]): KernelPlugin {
  return physics3dPlugin(physicsOptions('physics3d', args, 'PP3153'));
}
