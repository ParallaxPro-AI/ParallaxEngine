/**
 * The `physics2d` service: the Rapier 2D world as other plugins use it (net's lag
 * compensation and body-aware placement), provided by the physics2d plugin and looked up
 * at use (`kernel.service(PHYSICS2D_SERVICE)`). Positions are world-space `Vec3` meters
 * (z is the entity's draw depth, untouched), angles degrees, entities `EntityId`s. The
 * mirror of `PHYSICS3D_SERVICE` for what 2D needs.
 */

import type { EntityId, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';
import type { WorldFilter } from './physics3d.js';

export interface WorldHit2d {
  readonly entity: EntityId;
  readonly point: Vec3;
  /** Pointing out of the hit collider. */
  readonly normal: Vec3;
  readonly distance: number;
}

export interface BodyState2d {
  readonly kind: 'dynamic' | 'kinematic' | 'fixed';
  readonly position: Vec3;
  /** Degrees. */
  readonly angle: number;
  readonly velocity: Vec3;
}

/** The axis-aligned box around an entity's Collider shape in its body's local frame (scale applied). */
export interface LocalBounds2d {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}

export interface Physics2dService {
  readonly gravity: number;
  /** Nearest solid hit along a unit `direction` (x/y); triggers are skipped. Sees the world as the last step left it. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, filter?: WorldFilter): WorldHit2d | undefined;
  /** Entities whose colliders (triggers included) touch the circle, in body creation order. */
  overlapCircle(center: Vec3, radius: number, filter?: WorldFilter): EntityId[];
  body(entity: EntityId): BodyState2d | undefined;
  bounds(entity: EntityId): LocalBounds2d | undefined;
  /** Move the body and its transform now; `undefined` keeps that part (angle in degrees). */
  teleport(entity: EntityId, position: Vec3, angle: number | undefined, keepVelocity: boolean): void;
  /** The collision layer of the entity's Collider; undefined without one. */
  layerOf(entity: EntityId): string | undefined;
  /**
   * Network-driven bodies (a client showing replicated state): while driven, the body
   * follows its transform each step as a kinematic body would (it still pushes what it
   * touches), is never integrated, and never writes its transform back — the replication
   * owns the pose, nothing has to teleport it. Undriving gives it back to the simulation.
   * Part of physics2d's snapshot.
   */
  setDriven(entity: EntityId, driven: boolean): void;
}

export const PHYSICS2D_SERVICE: ServiceKey<Physics2dService> = serviceKey<Physics2dService>(
  'physics2d', 'Add physics2d() to Game(plugins=[...]).',
);
