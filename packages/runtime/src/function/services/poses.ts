/**
 * Poses the renderers draw for things the physics world moves, provided by the physics
 * plugin (physics2d or physics3d; a game has one):
 *
 *   - `RENDER_POSE_SERVICE`: render interpolation. Physics moves bodies once per fixed
 *     step; a 144 Hz screen draws two or three frames per step. Drawing the transform as
 *     the last step left it makes motion judder, so a renderer draws each physics-driven
 *     entity between its pose after the previous fixed step and its pose after the latest
 *     one, at `kernel.time.alpha`. Only entities whose transform is still exactly what the
 *     physics phase left are interpolated: anything the game moved since (an `update`
 *     assignment, a teleport) is drawn where it is.
 *   - `RAGDOLL_POSE_SERVICE`: the bones a ragdoll drives, for skinning. A renderer that
 *     animates a skinned model blends these over its animated pose by `weight`.
 *   - `SKELETON_SERVICE`: the other direction — the animated pose of an entity's skinned
 *     model, which a ragdoll starts from (going limp) and follows (active ragdolls). It is
 *     provided by whatever animates models (the models plugin), and is optional: without it a
 *     ragdoll uses its profile's own proportions.
 *
 * Positions are meters and rotations unit quaternions; nothing here exposes Rapier.
 */

import type { EntityId, Quat, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface RenderPoseSource {
  /**
   * The entity's pose relative to its parent (as `transform.position` / `rotation` are) to
   * draw this frame, or undefined: draw its transform as it is. Scale is never
   * interpolated. A renderer composes these up the hierarchy exactly as it composes
   * transforms, so a child of an interpolated body moves with it.
   */
  local(entity: EntityId): Pose | undefined;
  /** The entity's drawn world pose (interpolated where its chain is), for cameras and listeners following it. */
  world(entity: EntityId): Pose;
}

export const RENDER_POSE_SERVICE: ServiceKey<RenderPoseSource> = serviceKey<RenderPoseSource>(
  'render_pose', 'Render interpolation comes from the physics plugin: add physics2d() or physics3d() to Game(plugins=[...]).',
);

/** One bone of an animated skeleton, in the model's space (before `Model.offset`, after nothing else). */
export interface SkeletonBone {
  readonly name: string;
  /** Index of the parent bone in `bones`, or -1 for a root. */
  readonly parent: number;
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface SkeletonPose {
  /** Parents come before their children. */
  readonly bones: readonly SkeletonBone[];
}

export interface SkeletonSource {
  /**
   * The current animated pose of the entity's skinned model in model space; undefined while
   * the model loads, null when the entity has no skinned model in this run (data-only runs,
   * models without skins).
   */
  pose(entity: EntityId): SkeletonPose | null | undefined;
}

export const SKELETON_SERVICE: ServiceKey<SkeletonSource> = serviceKey<SkeletonSource>(
  'skeleton', 'Ragdolls read a skinned model\'s animated pose from render3d: add a Model with a skinned glTF.',
);

export interface RagdollPose {
  /** 0: the animation as it plays; 1: the physics pose. Between: blending back after `recover`. */
  readonly weight: number;
  /** Each driven bone's pose in model space (the space of `SkeletonBone`), interpolated for this frame. */
  readonly bones: ReadonlyMap<string, Pose>;
}

export interface RagdollPoseSource {
  /** Undefined when the entity isn't ragdolled (its animation plays untouched). */
  pose(entity: EntityId): RagdollPose | undefined;
}

export const RAGDOLL_POSE_SERVICE: ServiceKey<RagdollPoseSource> = serviceKey<RagdollPoseSource>(
  'ragdoll_pose', 'Ragdolls come from physics3d: add physics3d() to Game(plugins=[...]).',
);
