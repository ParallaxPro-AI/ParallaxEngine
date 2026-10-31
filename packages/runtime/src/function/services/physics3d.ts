/**
 * The `physics3d` service: the Rapier 3D world as other plugins use it, provided by the
 * physics3d plugin (`kernel.service(PHYSICS3D_SERVICE)`, looked up at use). Characters
 * and vehicles move through it; terrain, nav and voxels can query it. Nothing here
 * exposes Rapier: positions are world-space `Vec3` meters, rotations `Quat`, angular
 * velocities degrees per second, forces newtons, and entities `EntityId`s.
 *
 * Bodies. Every entity with a Rigidbody or a Collider has one body (dynamic, kinematic, or
 * fixed when it has only a Collider). Calls that act on a body reconcile it from its
 * components first, so they work on an entity spawned this frame.
 *
 * Controllers (characters, wheeled vehicles) are keyed by entity and owned by physics3d:
 * a caller passes its shape and inputs on every call and physics3d keeps the Rapier
 * controller in step (rebuilding it after a snapshot restore or a shape change). Callers
 * keep no physics handles of their own.
 *
 * Timing. physics3d steps the world in the kernel's 'physics' hook. A plugin that drives
 * controllers adds its own 'physics' hook; it may run before or after physics3d's step in
 * the same fixed step (plugin order), and either order is deterministic:
 *
 *   - `moveCharacter` resolves the move against the world as the last step left it and
 *     writes the entity's transform at once; the kinematic body follows on the next step.
 *   - `driveWheels` applies wheel impulses to the chassis now; the next step integrates them.
 *
 * Mounts. A rider mounted on a carrier (a driver in a car) has its colliders disabled and
 * its transform kept on the carrier's seat after every step, until dismounted: positioned at
 * `seat` and turned to the carrier's rotation times the seat `rotation` (a chair that faces
 * backwards on a cart). Mounts are part of physics3d's snapshot.
 */

import type { EntityId, Quat, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface WorldFilter {
  /** Collision layer names to hit; absent or empty: every layer. */
  readonly layers?: readonly string[];
  readonly ignore?: readonly EntityId[];
}

export interface WorldHit {
  /** Undefined: the scene's terrain or block world (not an entity). */
  readonly entity: EntityId | undefined;
  readonly point: Vec3;
  /** Surface normal at the hit, pointing out of the hit collider. */
  readonly normal: Vec3;
  readonly distance: number;
}

export type BodyKind = 'dynamic' | 'kinematic' | 'fixed';

export interface BodyState {
  readonly kind: BodyKind;
  /** Body origin = the entity's world position. */
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly velocity: Vec3;
  /** World space, degrees per second. */
  readonly angularVelocity: Vec3;
  /** kg; 0 for fixed and kinematic bodies. */
  readonly mass: number;
}

/** The axis-aligned box around an entity's Collider shape, in the body's local frame (scale applied). */
export interface LocalBounds {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}

export interface Contact {
  /** Undefined: the scene's terrain or block world (not an entity). */
  readonly entity: EntityId | undefined;
  /** Unit contact normal pointing from the other entity towards this one (up when resting on ground). */
  readonly normal: Vec3;
}

/** Axis locks a plugin adds on top of the Rigidbody's own (`lock_axes`, `lock_rotation`). */
export interface AxisLocks {
  readonly translation: readonly [boolean, boolean, boolean];
  readonly rotation: readonly [boolean, boolean, boolean];
}

/** A character's capsule: feet at the entity origin, standing along +y. */
export interface CharacterShape {
  readonly radius: number;
  /** Full height, caps included. */
  readonly height: number;
  /** Steps up to this height are climbed; drops up to it are snapped down when `snap` is set. */
  readonly stepHeight: number;
  /** Degrees; steeper ground is a wall. */
  readonly maxSlope: number;
}

export interface CharacterStep {
  /** The translation actually applied (after collisions, slopes and steps). */
  readonly moved: Vec3;
  readonly grounded: boolean;
  /** What it stands on, when grounded. */
  readonly ground: EntityId | undefined;
  /** The ground's velocity under the feet (moving platforms); zero when not grounded. */
  readonly groundVelocity: Vec3;
  /** It moved up into something (a ceiling). */
  readonly blockedAbove: boolean;
}

/** One wheel of a raycast vehicle, in the chassis' local frame (+z forward, +y up). */
export interface WheelSpec {
  /** Where the suspension attaches. */
  readonly connection: Vec3;
  readonly radius: number;
  readonly restLength: number;
  readonly maxTravel: number;
  /** Suspension force per meter of compression, per kg of chassis mass. */
  readonly stiffness: number;
  /** Damping per m/s of suspension speed, per kg of chassis mass. */
  readonly damping: number;
  /** Most force one wheel's suspension can give (N). */
  readonly maxForce: number;
}

export interface WheelInput {
  /** Newtons along the wheel's forward direction (negative: backwards). */
  readonly engineForce: number;
  /** Newtons of rolling resistance the wheel can give (applied when engineForce is 0). */
  readonly brake: number;
  /** Degrees; positive turns right (towards +x when facing +z). */
  readonly steering: number;
  /** Tire grip: the most forward impulse a wheel transmits, as a multiple of its load. */
  readonly frictionSlip: number;
  /** Lateral grip stiffness (1 = Rapier's default). */
  readonly sideStiffness: number;
}

export interface WheelContact {
  readonly inContact: boolean;
  readonly ground: EntityId | undefined;
}

export interface Mount {
  readonly carrier: EntityId;
  /** The rider's position in the carrier's local frame. */
  readonly seat: Vec3;
  /** The rider's rotation in the carrier's local frame (identity: the carrier's facing). */
  readonly rotation: Quat;
}

/** A shape swept by `shapecast`, centred on the cast's origin. */
export type CastShape =
  | { readonly kind: 'sphere'; readonly radius: number }
  /** Half the box's size along each of its axes. */
  | { readonly kind: 'box'; readonly halfExtents: Vec3 }
  /** Standing along y; `height` is the full height, caps included. */
  | { readonly kind: 'capsule'; readonly radius: number; readonly height: number };

/**
 * A contact that pressed harder than an entity's watched threshold during the last step
 * (`watchContactForces`). One entry per watched entity and other collider, per step.
 */
export interface ContactForce {
  /** The watched entity. */
  readonly entity: EntityId;
  /** Undefined: the scene's terrain or block world. */
  readonly other: EntityId | undefined;
  /** Newtons: the total contact force between the two over the step. */
  readonly force: number;
  /** Mean contact point. */
  readonly point: Vec3;
  /** Unit direction of the largest contact force, pointing into the watched entity. */
  readonly direction: Vec3;
  /** Speed (m/s) at which the two were closing along the contact normal before the step. */
  readonly speed: number;
}

/** What a ragdolled entity is doing (`ragdollOf`); undefined when it isn't one. */
export type RagdollMode = 'limp' | 'active' | 'recovering';

export interface Physics3dService {
  /** m/s² along y, exactly as configured. */
  readonly gravity: number;

  // ── Queries (see the world as the last step left it) ─────────────────────────
  /** Nearest solid hit along a unit `direction`; triggers are skipped. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, filter?: WorldFilter): WorldHit | undefined;
  /**
   * Sweep `shape` (rotated by `rotation`) from `origin` along a unit `direction`: the first
   * solid hit, `distance` being how far the shape travelled before touching. A shape that
   * already overlaps something at the origin hits it at distance 0.
   */
  shapecast(shape: CastShape, origin: Vec3, rotation: Quat, direction: Vec3, maxDistance: number, filter?: WorldFilter): WorldHit | undefined;
  /** Entities whose colliders (triggers included) touch the sphere, in body creation order. */
  overlapSphere(center: Vec3, radius: number, filter?: WorldFilter): EntityId[];
  /**
   * Push dynamic bodies within `radius` of `center` away from it (impulse `strength` N·s at
   * the centre, falling off linearly to 0 at the radius). Returns the entities in range, in
   * body creation order.
   */
  explode(center: Vec3, radius: number, strength: number, filter?: WorldFilter): EntityId[];

  // ── Contact forces ──────────────────────────────────────────────────────────
  /**
   * Report the entity's contacts pressing at least `threshold` newtons (undefined: stop).
   * Watches are per caller (`owner`), so two plugins can watch one entity; the entity is
   * reported once, against the lowest threshold. Part of physics3d's snapshot.
   */
  watchContactForces(entity: EntityId, owner: string, threshold: number | undefined): void;
  /** The watched contacts of the last step, in body creation order of the watched entity. */
  contactForces(): readonly ContactForce[];

  // ── Ragdolls ────────────────────────────────────────────────────────────────
  /**
   * Whether the entity is ragdolled. While it is, its own colliders are off and it doesn't
   * move by itself: `moveCharacter` returns a zero step (not grounded) and its transform
   * follows the ragdoll's pelvis. A Character should stop steering it until it recovers.
   */
  ragdollOf(entity: EntityId): RagdollMode | undefined;

  // ── Networking ──────────────────────────────────────────────────────────────
  /**
   * Network-driven bodies (a client showing replicated state): while driven, a Rigidbody
   * entity's body is kinematic and follows its transform each step (it still pushes what it
   * touches), is never integrated by its velocity, and never writes its transform back — the
   * replication owns the pose, nothing has to teleport it. Undriving gives it back to the
   * simulation as its Rigidbody says. Part of physics3d's snapshot.
   */
  setDriven(entity: EntityId, driven: boolean): void;
  /** The collision layer of the entity's Collider; undefined without one. */
  layerOf(entity: EntityId): string | undefined;

  // ── Bodies ───────────────────────────────────────────────────────────────────
  /** Undefined when the entity has no body (no Rigidbody, Collider or character). */
  body(entity: EntityId): BodyState | undefined;
  /** Bounds of the entity's Collider shape; undefined without a Collider (or a mesh/convex one without geometry). */
  bounds(entity: EntityId): LocalBounds | undefined;
  /** Solid colliders the entity touches now (after the last step). */
  contacts(entity: EntityId): Contact[];
  /** Dynamic bodies only (PP3156 otherwise). */
  setVelocity(entity: EntityId, velocity: Vec3): void;
  setAngularVelocity(entity: EntityId, degreesPerSecond: Vec3): void;
  /** For the next step only; `at` is a world point (adds torque). */
  applyForce(entity: EntityId, force: Vec3, at?: Vec3): void;
  applyImpulse(entity: EntityId, impulse: Vec3, at?: Vec3): void;
  /** Move the body and its transform now; `undefined` keeps that part. */
  teleport(entity: EntityId, position: Vec3 | undefined, rotation: Quat | undefined, keepVelocity: boolean): void;
  /** Add (or with `undefined` remove) axis locks under `owner`'s name (e.g. a boat's waterline). */
  constrain(entity: EntityId, owner: string, locks: AxisLocks | undefined): void;

  // ── Characters ───────────────────────────────────────────────────────────────
  /**
   * Move a character by `delta` meters with Rapier's kinematic character controller.
   * The first call claims the entity's body as kinematic and gives it the capsule (in its
   * Collider's layer when it has one); the entity must not have a Rigidbody (PP3157).
   * `snap` keeps it on the ground over small drops (pass false while moving up).
   */
  moveCharacter(entity: EntityId, shape: CharacterShape, delta: Vec3, snap: boolean): CharacterStep;
  /** Give the body back (the Character component was removed). */
  releaseCharacter(entity: EntityId): void;

  // ── Wheeled vehicles ─────────────────────────────────────────────────────────
  /**
   * Update a raycast vehicle on the entity's dynamic body for this fixed step: suspension,
   * engine, brakes, steering and tire friction. `wheels` and `inputs` are parallel; a
   * different `wheels` list rebuilds the controller.
   */
  driveWheels(entity: EntityId, wheels: readonly WheelSpec[], inputs: readonly WheelInput[], dt: number): WheelContact[];
  releaseWheels(entity: EntityId): void;

  // ── Mounts ───────────────────────────────────────────────────────────────────
  /** Mount `rider` on `carrier` at `seat`, turned by `rotation` (local; default identity). */
  mount(rider: EntityId, carrier: EntityId, seat: Vec3, rotation?: Quat): void;
  dismount(rider: EntityId): void;
  mountOf(rider: EntityId): Mount | undefined;
}

export const PHYSICS3D_SERVICE: ServiceKey<Physics3dService> = serviceKey<Physics3dService>(
  'physics3d', 'Add physics3d() to Game(plugins=[...]): characters and vehicles move through the 3D physics world.',
);

/** Triangles of a model asset in the model's own space (what a renderer draws, before Model.offset). */
export interface ModelGeometry {
  /** x, y, z per vertex. */
  readonly vertices: Float32Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
}

/**
 * Model geometry for `"mesh"` and `"convex"` colliders (physics3d) and for nav's static
 * world, provided by the models plugin from the glTF files it loads (headless too, over
 * `MemoryBinaryFiles`): every mesh node in the rest pose, skinned meshes in their bind pose.
 */
export interface ModelGeometrySource {
  /**
   * The triangles of the model a reference names (a path, `models/<name>` or a bare name,
   * as `Model.model` holds it):
   *
   *   - geometry once loaded;
   *   - undefined while it is still loading (a collider waits and is built when it lands;
   *     a model that fails to load is raised by render3d's next frame);
   *   - null when this run has no file for it: data-only playtests run without the asset
   *     files, where references are checked for form only and models draw nothing. Such a
   *     collider has no shape (nothing collides with it) — exactly as the model is invisible.
   *
   * A reference to a file that isn't in the project, when the asset files are present, is
   * PP2063.
   */
  geometry(model: string): ModelGeometry | null | undefined;
}

export const MODEL_GEOMETRY_SERVICE: ServiceKey<ModelGeometrySource> = serviceKey<ModelGeometrySource>(
  'model_geometry', 'Mesh and convex colliders are built from the entity\'s Model: add render3d (it loads the models and provides their geometry).',
);
