/**
 * The Rapier 3D world behind one kernel. Every entity with a `collider` or a `rigidbody`
 * gets one Rapier body: dynamic or kinematic from its Rigidbody, fixed when it has only a
 * Collider, kinematic when a character claims it. Each fixed step (the kernel's 'physics'
 * hook):
 *
 *   1. scenery    the scene's heightfield (terrain service) as one fixed trimesh per
 *                 terrain chunk (hole quads left out), all rebuilt when the field's
 *                 version changes and one chunk when its `revision` does (a crater);
 *                 static cylinders for foliage layers that `collide` (foliage service),
 *                 rebuilt when its `revision` changes (a felled tree, regrounding);
 *                 one fixed trimesh per active chunk of the block world (voxels
 *                 service), rebuilt when the chunk changes; one fixed trimesh per
 *                 generated mesh (procgen service: sweeps, structures, dungeons),
 *                 rebuilt when its `collisionVersion` changes, its hits naming its entity
 *   2. reconcile  bodies for changed component fields; mesh colliders still loading retry
 *   3. push       transforms → bodies: kinematic bodies follow their transform; a dynamic
 *                 or fixed body whose transform the game reassigned is moved there
 *   4. step       Rapier, with the kernel's fixed dt
 *   5. pull       dynamic bodies → transforms (position and rotation; scale untouched);
 *                 mounted riders are put on their carriers' seats
 *   6. events     collided / collision_ended / trigger_entered / trigger_exited, once per
 *                 entity pair (an entity with two colliders still gets one event)
 *
 * Bodies are created in spawn order and Rapier is deterministic, so the same inputs give
 * the same simulation. Scene queries see colliders where the last step left them.
 *
 * Character controllers (Rapier's KinematicCharacterController) and raycast vehicles
 * (DynamicRayCastVehicleController) are owned here, keyed by entity, and driven through
 * the physics3d service by the characters and vehicles plugins.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import { deg, fail, Quat, rad, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { KERNEL_EVENTS } from '../../kernel/index.js';
import type { EntityHandles, EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import { CITY_SERVICE, FOLIAGE_SERVICE, MODEL_GEOMETRY_SERVICE, PROCGEN_SERVICE, TERRAIN_SERVICE, VOXELS_SERVICE } from '../../services/index.js';
import { modelScaleOf } from '../../../resource/index.js';
import type {
  AxisLocks, BodyKind, BodyState, CastShape, CharacterShape, CharacterStep, ContactForce, LocalBounds, ModelGeometry, Mount,
  TerrainChunk, TerrainField, WheelContact, WheelInput, WheelSpec,
} from '../../services/index.js';
import { applyFields, FORCE_FIELD } from './fields.js';
import type { FieldHost, FieldTarget } from './fields.js';
import { PoseHistory } from './interpolation.js';
import { JOINT, Joints3d } from './joints.js';
import type { JointBody, JointHost, SavedJoint } from './joints.js';
import type { LayerTable } from './layers.js';
import { IMPACT } from './materials.js';
import type { MaterialTable } from './materials.js';
import { Ragdolls } from './ragdoll.js';
import type { RagdollHost, SavedRagdoll } from './ragdoll.js';
import { rapier } from './rapier.js';
import { toQuat, toVec3 } from './values.js';
import type { XYZ } from './values.js';

export const COLLIDER = 'collider';
export const RIGIDBODY = 'rigidbody';
const MODEL = 'model';

/** Physics events: the kernel's shared definitions (every physics plugin emits the same ones). */
export const PHYSICS_EVENTS = {
  collided: KERNEL_EVENTS.collided,
  collisionEnded: KERNEL_EVENTS.collisionEnded,
  triggerEntered: KERNEL_EVENTS.triggerEntered,
  triggerExited: KERNEL_EVENTS.triggerExited,
} as const;

/** The 3D shapes. `size` is a box's full extent; `height` a capsule's or cylinder's full height (caps included), along y. */
export const SHAPES_3D = ['box', 'sphere', 'capsule', 'cylinder', 'mesh', 'convex'] as const;

/** Gap Rapier's character controller keeps between the capsule and what it touches (m). */
export const CHARACTER_SKIN = 0.02;

/** Per-body motion Rapier holds and components don't, plus service state (for snapshots). */
export interface SavedPhysics3d {
  /** Dynamic bodies: Rapier's velocities (rad/s). Kinematic bodies: their set velocity (angvel empty). */
  readonly motion: ReadonlyArray<{ readonly entity: number; readonly linvel: readonly number[]; readonly angvel: readonly number[] }>;
  readonly mounts: ReadonlyArray<{ readonly rider: number; readonly carrier: number; readonly seat: readonly number[]; readonly rotation?: readonly number[] }>;
  readonly locks: ReadonlyArray<{ readonly entity: number; readonly owner: string; readonly translation: boolean[]; readonly rotation: boolean[] }>;
  /** Bodies whose Rapier frame is turned from their entity's (hinges and sliders between turned bodies). */
  readonly offsets: ReadonlyArray<{ readonly entity: number; readonly offset: readonly number[] }>;
  readonly joints: readonly SavedJoint[];
  readonly watches: ReadonlyArray<{ readonly entity: number; readonly owner: string; readonly threshold: number }>;
  readonly ragdolls: readonly SavedRagdoll[];
  /** Network-driven bodies (net clients). */
  readonly driven: readonly number[];
}

interface CharacterClaim {
  shape: CharacterShape;
  controller: RAPIER.KinematicCharacterController | undefined;
  controllerKey: string;
}

interface Body {
  readonly entity: EntityId;
  /** Creation order: query results are sorted by it, so they never depend on tree layout. */
  readonly order: number;
  readonly body: RAPIER.RigidBody;
  kind: BodyKind;
  collider: RAPIER.Collider | undefined;
  /** A mesh/convex collider whose model geometry is still loading (retried every step). */
  colliderPending: boolean;
  /** Geometry of the mesh/convex collider, for bounds. */
  geometryBounds: LocalBounds | undefined;
  characterCollider: RAPIER.Collider | undefined;
  characterKey: string;
  rigidbodyFields: Fields | undefined;
  colliderFields: Fields | undefined;
  rigidbodyKey: string;
  colliderKey: string;
  locksKey: string;
  /** The transform values this body last agreed with; a different object means the game moved it. */
  position: Vec3;
  rotation: Quat;
  /** The angular_velocity value last written to the component. */
  angularVelocity: unknown;
  /** A kinematic body's velocity: each step moves its transform by velocity × dt. */
  kinematicVelocity: Vec3;
  forced: boolean;
}

interface ColliderOwner {
  /** Undefined: scenery — the terrain or a voxel chunk. */
  readonly entity: EntityId | undefined;
  readonly sensor: boolean;
  readonly layerBit: number;
  /** Its interaction groups (restored when a rider dismounts). */
  readonly groups: number;
  /** Its surface material's name, when it has one. */
  readonly material: string | null;
}

/** A dynamic body's motion as the step began (impact speeds, joint loads, contact closing speeds). */
interface PreStep {
  readonly linvel: XYZ;
  readonly angvel: XYZ;
  readonly userForce: XYZ;
  readonly com: XYZ;
}

export interface Hit3d {
  readonly entity: EntityId | undefined;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

export interface QueryFilter {
  /** Layer bit mask; 0 = every layer. */
  readonly layers: number;
  readonly ignore: ReadonlySet<EntityId>;
}

interface VoxelChunkCollider {
  readonly version: number;
  /** Undefined: the chunk has no collision faces. */
  readonly body: RAPIER.RigidBody | undefined;
}

interface Pair {
  count: number;
  readonly a: EntityId;
  readonly b: EntityId;
}

interface WheelSet {
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly key: string;
}

const NO_FILTER: QueryFilter = { layers: 0, ignore: new Set() };

const ZERO_XYZ: XYZ = { x: 0, y: 0, z: 0 };

function key(values: readonly unknown[]): string {
  return values.map((v) => (v instanceof Vec3 ? `${v.x},${v.y},${v.z}` : Array.isArray(v) ? v.join('|') : String(v))).join(';');
}

function rigidbodyKey(fields: Fields): string {
  return key([fields['kind'], fields['mass'], fields['linear_damping'], fields['angular_damping'], fields['gravity_scale'],
    fields['lock_rotation'], fields['lock_axes'], fields['lock_rotation_axes'], fields['continuous']]);
}

function colliderKey(fields: Fields, scale: Vec3, mass: unknown, model: unknown, offset: Quat): string {
  return key([fields['shape'], fields['size'], fields['radius'], fields['height'], fields['offset'], fields['trigger'],
    fields['layer'], fields['collides_with'], fields['friction'], fields['bounce'], fields['material'], scale, mass, model,
    `${offset.x},${offset.y},${offset.z},${offset.w}`]);
}

function where(record: EntityRecord, component: string): string {
  return `entity ${record.placedId ?? record.prefab ?? record.id} ${component}`;
}

/** A model reference as stored in a `model` field (string path, or an api ref with toJSON). */
function modelPath(record: EntityRecord): { path: string; offset: Vec3; rotation: Vec3; scale: number } | undefined {
  const model = record.components.get(MODEL);
  if (model === undefined) return undefined;
  const ref = model['model'];
  const stored = typeof ref === 'object' && ref !== null && typeof (ref as { toJSON?: unknown }).toJSON === 'function'
    ? (ref as { toJSON(): unknown }).toJSON()
    : ref;
  if (typeof stored !== 'string') return undefined;
  const offset = model['offset'];
  const rotation = model['rotation_offset'];
  return {
    path: stored, offset: offset instanceof Vec3 ? offset : Vec3.ZERO, rotation: rotation instanceof Vec3 ? rotation : Vec3.ZERO,
    scale: modelScaleOf(model, where(record, 'model')),
  };
}

/** Vertices (x, y, z triples) turned by `q`. */
function turnVertices(v: ArrayLike<number>, q: Quat): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const r = q.rotate(new Vec3(v[i]!, v[i + 1]!, v[i + 2]!));
    out[i] = r.x; out[i + 1] = r.y; out[i + 2] = r.z;
  }
  return out;
}

export class Physics3dSim {
  /** Replaced by a fresh world on restore, so a restored run never depends on what came before. */
  world: RAPIER.World;
  readonly gravity: number;
  readonly layers: LayerTable;
  readonly #kernel: Kernel;
  readonly #events: RAPIER.EventQueue;
  readonly #bodies = new Map<EntityId, Body>();
  readonly #owners = new Map<number, ColliderOwner>();
  /** Colliders removed since the last step, so their final stop events still name an entity. */
  readonly #retired = new Map<number, ColliderOwner>();
  readonly #pairs = new Map<string, Pair>();
  readonly #claims = new Map<EntityId, CharacterClaim>();
  readonly #wheels = new Map<EntityId, WheelSet>();
  readonly #mounts = new Map<EntityId, Mount>();
  readonly #locks = new Map<EntityId, Map<string, AxisLocks>>();
  /** Entity rotation = body rotation × offset (absent: identity). Kept across body rebuilds. */
  readonly #offsets = new Map<EntityId, Quat>();
  readonly #pre = new Map<EntityId, PreStep>();
  /** Entities with a force_field component. */
  readonly #fieldEntities = new Set<EntityId>();
  /** Bodies whose pose replication owns: kinematic-follow, never integrated or pulled. */
  readonly #driven = new Set<EntityId>();
  /** Contact-force watches: entity → owner → threshold (N). */
  readonly #watches = new Map<EntityId, Map<string, number>>();
  #contactForces: ContactForce[] = [];
  readonly #materials: MaterialTable;
  readonly #joints: Joints3d;
  readonly #ragdolls: Ragdolls;
  /** Render interpolation tracks (presentation only). */
  readonly poses: PoseHistory;
  /** Terrain colliders for one build of the field: per chunk, the revision it was built at. */
  #terrain: { readonly version: number; readonly chunks: Map<number, { readonly revision: number; readonly body: RAPIER.RigidBody | undefined }> } | undefined;
  /** Foliage colliders (one fixed body per colliding layer) for one foliage revision. */
  #foliage: { readonly revision: number; readonly bodies: RAPIER.RigidBody[] } | undefined;
  /** The block world's chunk colliders, by chunk key, for one build of the world. */
  #voxels: { readonly world: number; readonly scene: string; readonly chunks: Map<string, VoxelChunkCollider> } | undefined;
  /** Generated meshes' colliders (procgen service), by mesh key. */
  readonly #procgen = new Map<string, { readonly version: number; readonly body: RAPIER.RigidBody }>();
  #nextOrder = 0;

  constructor(kernel: Kernel, gravity: number, layers: LayerTable, materials: MaterialTable, interpolate: boolean) {
    const R = rapier();
    this.#kernel = kernel;
    this.layers = layers;
    this.gravity = gravity;
    this.#materials = materials;
    this.world = new R.World({ x: 0, y: gravity, z: 0 });
    this.#events = new R.EventQueue(true);
    this.#joints = new Joints3d(this.#jointHost());
    this.#ragdolls = new Ragdolls(this.#ragdollHost());
    this.poses = new PoseHistory(kernel, interpolate);
  }

  get joints(): Joints3d {
    return this.#joints;
  }

  get ragdolls(): Ragdolls {
    return this.#ragdolls;
  }

  /** The end of the fixed step's physics phase (after every plugin's 'physics' hook). */
  endStep(): void {
    this.poses.end();
  }

  get handles(): EntityHandles {
    return this.#kernel.handles;
  }

  // ── The fixed step ───────────────────────────────────────────────────────────

  step(dt: number): void {
    this.syncScenery();
    for (const body of [...this.#bodies.values()]) {
      const record = this.#kernel.world.get(body.entity);
      if (record === undefined) this.#remove(body);
      else this.reconcile(record);
    }
    this.#joints.sync();
    this.poses.begin(this.#moving());
    for (const body of this.#bodies.values()) this.#push(body, dt);
    applyFields(this.#fieldHost(), this.#fieldEntities);
    this.#joints.drive(dt);
    this.#ragdolls.drive();
    this.#capturePreStep();
    this.world.timestep = dt;
    this.world.step(this.#events, this.#ragdolls.hooks);
    this.#joints.settle(dt);
    for (const body of this.#bodies.values()) {
      if (body.forced) {
        body.body.resetForces(false);
        body.body.resetTorques(false);
        body.forced = false;
      }
      this.#pull(body);
    }
    this.#ragdolls.settle(dt);
    this.#placeRiders();
    this.#drainEvents();
    this.#pre.clear();
    this.#retired.clear();
    this.#purgePairs();
  }

  /** Entities physics moves: every body that isn't fixed. */
  *#moving(): Iterable<EntityId> {
    for (const body of this.#bodies.values()) if (body.kind !== 'fixed' || this.#ragdolls.modeOf(body.entity) !== undefined) yield body.entity;
    for (const record of this.#kernel.world.live()) {
      if (!this.#bodies.has(record.id) && this.#ragdolls.modeOf(record.id) !== undefined) yield record.id;
    }
  }

  #capturePreStep(): void {
    this.#pre.clear();
    for (const body of this.#bodies.values()) {
      if (body.kind !== 'dynamic') continue;
      const b = body.body;
      this.#pre.set(body.entity, { linvel: b.linvel(), angvel: b.angvel(), userForce: b.userForce(), com: b.worldCom() });
    }
  }

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.reconcile(record);
      this.#trackField(record);
    }
  }

  /** A component was attached or removed at runtime. */
  changed(record: EntityRecord): void {
    this.reconcile(record);
    this.#trackField(record);
  }

  #trackField(record: EntityRecord): void {
    if (record.components.has(FORCE_FIELD)) this.#fieldEntities.add(record.id);
    else this.#fieldEntities.delete(record.id);
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      const body = this.#bodies.get(record.id);
      if (body !== undefined) this.#remove(body);
      this.#mounts.delete(record.id);
      for (const [rider, mount] of [...this.#mounts]) {
        if (mount.carrier === record.id) this.dismount(rider);
      }
      this.#locks.delete(record.id);
      this.#claims.delete(record.id);
      this.#offsets.delete(record.id);
      this.#watches.delete(record.id);
      this.#fieldEntities.delete(record.id);
      this.#ragdolls.remove(record.id);
      this.#driven.delete(record.id);
    }
  }

  /** Free the Rapier world (its bodies, colliders, joints and controllers go with it) and the event queue. The sim is unusable after. */
  dispose(): void {
    this.world.free();
    this.#events.free();
  }

  snapshot(): SavedPhysics3d {
    const kinematic = [...this.#bodies.values()].filter((b) => b.kind === 'kinematic' && !b.kinematicVelocity.__eq__(Vec3.ZERO)).map((b) => {
      const v = b.kinematicVelocity;
      return { entity: b.entity as number, linvel: [v.x, v.y, v.z], angvel: [] as number[] };
    });
    const motion = [...this.#bodies.values()].filter((b) => b.kind === 'dynamic').map((b) => {
      const v = b.body.linvel();
      const w = b.body.angvel();
      return { entity: b.entity as number, linvel: [v.x, v.y, v.z], angvel: [w.x, w.y, w.z] };
    });
    const mounts = [...this.#mounts].map(([rider, m]) => ({ rider: rider as number, carrier: m.carrier as number, seat: [m.seat.x, m.seat.y, m.seat.z], rotation: [m.rotation.x, m.rotation.y, m.rotation.z, m.rotation.w] }));
    const locks = [...this.#locks].flatMap(([entity, owners]) => [...owners].map(([owner, l]) => ({
      entity: entity as number, owner, translation: [...l.translation], rotation: [...l.rotation],
    })));
    const offsets = [...this.#offsets].map(([entity, q]) => ({ entity: entity as number, offset: [q.x, q.y, q.z, q.w] }));
    const watches = [...this.#watches].flatMap(([entity, owners]) => [...owners].map(([owner, threshold]) => ({ entity: entity as number, owner, threshold })));
    return { motion: [...motion, ...kinematic], mounts, locks, offsets, joints: this.#joints.snapshot(), watches, ragdolls: this.#ragdolls.snapshot(),
      driven: [...this.#driven].map((e) => e as number) };
  }

  /**
   * Rebuild every body from the restored world, then put velocities, mounts and locks
   * back. Controllers (characters, wheels) are rebuilt on their next use. Rapier's solver
   * caches are not saved, so a restored run is not bit-identical to an uninterrupted one
   * (a settled stack stays within 1e-3 m and 1e-4 m/s: the 'resting stack' test bounds it).
   */
  restore(saved: SavedPhysics3d): void {
    for (const body of [...this.#bodies.values()]) this.#remove(body);
    for (const set of this.#wheels.values()) this.world.removeVehicleController(set.controller);
    this.#wheels.clear();
    for (const claim of this.#claims.values()) {
      if (claim.controller !== undefined) this.world.removeCharacterController(claim.controller);
    }
    this.#claims.clear();
    this.#mounts.clear();
    this.#locks.clear();
    this.#pairs.clear();
    this.#offsets.clear();
    this.#watches.clear();
    this.#contactForces = [];
    this.#joints.reset(saved.joints);
    this.#ragdolls.clear();
    this.poses.clear();
    if (this.#terrain !== undefined) this.#removeTerrain();
    if (this.#foliage !== undefined) this.#removeFoliage();
    if (this.#voxels !== undefined) this.#removeVoxels();
    this.#removeProcgen();
    // A fresh Rapier world: a restored run never depends on the bodies that came and went before.
    this.world.free();
    this.world = new (rapier().World)({ x: 0, y: this.gravity, z: 0 });
    this.#owners.clear();
    this.#retired.clear();
    this.#events.clear();
    const alive = (id: number): boolean => this.#kernel.world.isAlive(id as EntityId);
    this.#driven.clear();
    for (const e of saved.driven) if (alive(e)) this.#driven.add(e as EntityId);
    for (const o of saved.offsets) {
      if (alive(o.entity)) this.#offsets.set(o.entity as EntityId, new Quat(o.offset[0]!, o.offset[1]!, o.offset[2]!, o.offset[3]!));
    }
    for (const w of saved.watches) {
      if (!alive(w.entity)) continue;
      const owners = this.#watches.get(w.entity as EntityId) ?? new Map<string, number>();
      owners.set(w.owner, w.threshold);
      this.#watches.set(w.entity as EntityId, owners);
    }
    this.#fieldEntities.clear();
    for (const l of saved.locks) {
      if (!alive(l.entity)) continue;
      const owners = this.#locks.get(l.entity as EntityId) ?? new Map<string, AxisLocks>();
      owners.set(l.owner, { translation: l.translation as unknown as [boolean, boolean, boolean], rotation: l.rotation as unknown as [boolean, boolean, boolean] });
      this.#locks.set(l.entity as EntityId, owners);
    }
    for (const m of saved.mounts) {
      if (alive(m.rider) && alive(m.carrier)) {
        const r = m.rotation;
        const rotation = r === undefined ? Quat.IDENTITY : new Quat(r[0]!, r[1]!, r[2]!, r[3]!);
        this.#mounts.set(m.rider as EntityId, { carrier: m.carrier as EntityId, seat: new Vec3(m.seat[0]!, m.seat[1]!, m.seat[2]!), rotation });
      }
    }
    this.syncScenery();
    for (const record of this.#kernel.world.live()) {
      this.reconcile(record);
      this.#trackField(record);
    }
    for (const m of saved.motion) {
      const body = this.#bodies.get(m.entity as EntityId);
      if (body?.kind === 'kinematic') {
        body.kinematicVelocity = new Vec3(m.linvel[0]!, m.linvel[1]!, m.linvel[2]!);
      }
      if (body === undefined || body.kind !== 'dynamic') continue;
      body.body.setLinvel({ x: m.linvel[0]!, y: m.linvel[1]!, z: m.linvel[2]! }, true);
      body.body.setAngvel({ x: m.angvel[0]!, y: m.angvel[1]!, z: m.angvel[2]! }, true);
    }
    this.#ragdolls.restore(saved.ragdolls);
  }

  // ── Bodies ───────────────────────────────────────────────────────────────────

  /** One entity's body, created or updated from its components now. Undefined if it has none. */
  reconcile(record: EntityRecord): Body | undefined {
    const rb = record.components.get(RIGIDBODY);
    const col = record.components.get(COLLIDER);
    const claim = this.#claims.get(record.id);
    let body = this.#bodies.get(record.id);
    if (rb === undefined && col === undefined && claim === undefined) {
      if (body !== undefined) this.#remove(body);
      return undefined;
    }
    if (claim !== undefined && rb !== undefined) {
      fail('PP3157', `${where(record, 'character')} also has a Rigidbody; a Character moves itself`, {
        fix: 'Remove the rigidbody component from this prefab (keep a Collider for its layer, if needed).',
      });
    }
    const kind: BodyKind = claim !== undefined || (rb !== undefined && this.#driven.has(record.id)) ? 'kinematic' : rb === undefined ? 'fixed' : (rb['kind'] as BodyKind);
    if (body === undefined) {
      body = this.#create(record, kind);
    } else if (body.kind !== kind) {
      body.body.setBodyType(this.#bodyType(kind), true);
      body.kind = kind;
    }

    let massChanged = false;
    const locks = this.#locks.get(record.id);
    const locksKey = locks === undefined ? '' : JSON.stringify([...locks]);
    if (rb !== body.rigidbodyFields || (rb !== undefined && rigidbodyKey(rb) !== body.rigidbodyKey) || locksKey !== body.locksKey) {
      body.rigidbodyFields = rb;
      body.rigidbodyKey = rb === undefined ? '' : rigidbodyKey(rb);
      body.locksKey = locksKey;
      this.#applyRigidbody(body, rb, record);
      massChanged = true;
    }
    if (rb !== undefined && rb['angular_velocity'] !== body.angularVelocity) {
      const value = rb['angular_velocity'] as Vec3;
      if (body.kind === 'dynamic') body.body.setAngvel({ x: rad(value.x), y: rad(value.y), z: rad(value.z) }, true);
      body.angularVelocity = value;
    }

    const scale = record.transform.worldScale();
    const mass = rb === undefined ? undefined : rb['mass'];
    const model = col !== undefined && (col['shape'] === 'mesh' || col['shape'] === 'convex') ? modelPath(record) : undefined;
    const modelKey = model === undefined ? '' : `${model.path}@${model.offset.toString()}@${model.rotation.toString()}@${model.scale}`;
    const offset = this.offsetOf(record.id);
    if (col !== body.colliderFields || body.colliderPending
      || (col !== undefined && colliderKey(col, scale, mass, modelKey, offset) !== body.colliderKey)) {
      if (body.collider !== undefined) this.#removeCollider(body, 'collider');
      body.colliderFields = col;
      body.colliderKey = col === undefined ? '' : colliderKey(col, scale, mass, modelKey, offset);
      body.colliderPending = false;
      body.geometryBounds = undefined;
      if (col !== undefined) this.#attachCollider(body, col, scale, record);
      massChanged = true;
    }

    const characterKey = claim === undefined ? '' : key([claim.shape.radius, claim.shape.height, col?.['layer'], col?.['collides_with'], scale]);
    if (characterKey !== body.characterKey) {
      if (body.characterCollider !== undefined) this.#removeCollider(body, 'characterCollider');
      body.characterKey = characterKey;
      if (claim !== undefined) this.#attachCharacterCollider(body, claim.shape, col, record);
    }
    if (massChanged) this.#applyMass(body);
    this.#applyEnabled(body);
    return body;
  }

  #requireBody(entity: EntityId, what: string): Body {
    const record = this.#kernel.world.require(entity);
    const body = this.reconcile(record);
    if (body === undefined) {
      fail('PP3156', `${what}: ${where(record, '')}has no physics body`, { fix: 'Give it a rigidbody and a collider.' });
    }
    return body;
  }

  #requireDynamic(entity: EntityId, what: string): Body {
    const body = this.#requireBody(entity, what);
    if (body.kind !== 'dynamic') {
      const record = this.#kernel.world.require(entity);
      fail('PP3156', `${what} acts on dynamic bodies; ${where(record, 'rigidbody')} is ${body.kind}`, {
        fix: 'Move a kinematic body by setting its transform.position (or teleport it), or make it "dynamic".',
      });
    }
    return body;
  }

  kindOf(entity: EntityId): BodyKind | undefined {
    return this.#bodies.get(entity)?.kind;
  }

  rigidbody(entity: EntityId): RAPIER.RigidBody {
    return this.#requireBody(entity, 'rigidbody').body;
  }

  state(entity: EntityId): BodyState | undefined {
    const record = this.#kernel.world.get(entity);
    if (record === undefined) return undefined;
    const body = this.reconcile(record);
    if (body === undefined) return undefined;
    const w = body.body.angvel();
    return {
      kind: body.kind,
      position: toVec3(body.body.translation()),
      rotation: this.#entityRotation(entity, toQuat(body.body.rotation())),
      velocity: toVec3(body.body.linvel()),
      angularVelocity: new Vec3(deg(w.x), deg(w.y), deg(w.z)),
      mass: body.kind === 'dynamic' ? body.body.mass() : 0,
    };
  }

  bounds(entity: EntityId): LocalBounds | undefined {
    const record = this.#kernel.world.get(entity);
    if (record === undefined) return undefined;
    const body = this.reconcile(record);
    const col = record.components.get(COLLIDER);
    if (body === undefined || col === undefined) return undefined;
    const s = record.transform.worldScale();
    const sx = Math.abs(s.x);
    const sy = Math.abs(s.y);
    const sz = Math.abs(s.z);
    const offset = col['offset'] as Vec3;
    const center = new Vec3(offset.x * sx, offset.y * sy, offset.z * sz);
    const shape = col['shape'] as string;
    const radius = col['radius'] as number;
    const height = col['height'] as number;
    if (shape === 'box') {
      const size = col['size'] as Vec3;
      return { center, halfExtents: new Vec3(size.x * sx / 2, size.y * sy / 2, size.z * sz / 2) };
    }
    if (shape === 'sphere') {
      const r = radius * Math.max(sx, sy, sz);
      return { center, halfExtents: new Vec3(r, r, r) };
    }
    if (shape === 'capsule' || shape === 'cylinder') {
      const r = radius * Math.max(sx, sz);
      return { center, halfExtents: new Vec3(r, height * sy / 2, r) };
    }
    return body.geometryBounds;
  }

  /**
   * How the body moves: Rapier's velocity, or for a kinematic body the velocity it was
   * given (when none, its motion over the last step: a body moved by its transform).
   */
  velocity(entity: EntityId): Vec3 {
    const body = this.#requireBody(entity, 'velocity');
    if (body.kind === 'kinematic' && !body.kinematicVelocity.__eq__(Vec3.ZERO)) return body.kinematicVelocity;
    return toVec3(body.body.linvel());
  }

  /**
   * A kinematic body keeps the velocity it is given, and each step moves its transform by
   * velocity × dt (on top of any transform the game assigns), as kinematic bodies move in
   * every major engine. A character's body is moved by its Character instead.
   */
  setVelocity(entity: EntityId, v: XYZ): void {
    const body = this.#requireBody(entity, 'Setting velocity');
    if (body.kind === 'kinematic' && !this.#claims.has(entity)) {
      body.kinematicVelocity = new Vec3(v.x, v.y, v.z);
      return;
    }
    this.#requireDynamic(entity, 'Setting velocity').body.setLinvel(v, true);
  }

  setAngularVelocity(entity: EntityId, degreesPerSecond: XYZ): void {
    const record = this.#kernel.world.require(entity);
    const rb = record.components.get(RIGIDBODY);
    if (rb !== undefined && this.#requireBody(entity, 'Setting angular velocity').kind === 'kinematic') {
      rb['angular_velocity'] = new Vec3(degreesPerSecond.x, degreesPerSecond.y, degreesPerSecond.z);
      return;
    }
    const body = this.#requireDynamic(entity, 'Setting angular velocity');
    body.body.setAngvel({ x: rad(degreesPerSecond.x), y: rad(degreesPerSecond.y), z: rad(degreesPerSecond.z) }, true);
  }

  applyForce(entity: EntityId, force: XYZ, at: XYZ | undefined): void {
    const body = this.#requireDynamic(entity, 'force()');
    if (at === undefined) body.body.addForce(force, true);
    else body.body.addForceAtPoint(force, at, true);
    body.forced = true;
  }

  applyImpulse(entity: EntityId, impulse: XYZ, at: XYZ | undefined): void {
    const body = this.#requireDynamic(entity, 'impulse()');
    if (at === undefined) body.body.applyImpulse(impulse, true);
    else body.body.applyImpulseAtPoint(impulse, at, true);
  }

  /** Move a body and its transform now, without sweeping through what lies between. */
  teleport(entity: EntityId, position: Vec3 | undefined, rotation: Quat | undefined, keepVelocity: boolean): void {
    const record = this.#kernel.world.require(entity);
    const body = this.reconcile(record);
    const t = record.transform;
    if (position !== undefined) t.setWorldPosition(position);
    if (rotation !== undefined) this.#setWorldRotation(record, rotation);
    if (body === undefined) return;
    const p = t.worldPosition();
    const q = this.#bodyRotation(entity, t.worldRotation());
    body.body.setTranslation(p, true);
    body.body.setRotation(q, true);
    if (body.kind === 'kinematic') {
      body.body.setNextKinematicTranslation(p);
      body.body.setNextKinematicRotation(q);
    }
    if (!keepVelocity && body.kind === 'kinematic') body.kinematicVelocity = Vec3.ZERO;
    if (!keepVelocity && body.kind === 'dynamic') {
      body.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    body.position = t.position;
    body.rotation = t.rotation;
    this.poses.snap(entity);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  constrain(entity: EntityId, owner: string, locks: AxisLocks | undefined): void {
    const owners = this.#locks.get(entity) ?? new Map<string, AxisLocks>();
    if (locks === undefined) owners.delete(owner);
    else owners.set(owner, { translation: [...locks.translation], rotation: [...locks.rotation] });
    if (owners.size === 0) this.#locks.delete(entity);
    else this.#locks.set(entity, owners);
    const record = this.#kernel.world.get(entity);
    if (record !== undefined) this.reconcile(record);
  }

  /** Solid colliders the entity touches, one entry per other entity (the terrain: entity undefined). */
  contacts(entity: EntityId): Array<{ entity: EntityId | undefined; normal: Vec3 }> {
    const body = this.#bodies.get(entity);
    if (body === undefined) return [];
    const found = new Map<EntityId | undefined, { x: number; y: number; z: number }>();
    for (const c of [body.collider, body.characterCollider]) {
      if (c === undefined || this.#mounts.has(entity) || c.isSensor()) continue;
      this.world.contactPairsWith(c, (other) => {
        const owner = this.#owners.get(other.handle);
        if (owner === undefined || owner.sensor || owner.entity === entity) return;
        this.world.contactPair(c, other, (manifold, flipped) => {
          if (manifold.numContacts() === 0) return;
          const n = manifold.normal();
          // n points from `c` to `other` (flipped: the other way); the contact normal points to us.
          const s = flipped ? 1 : -1;
          const sum = found.get(owner.entity) ?? { x: 0, y: 0, z: 0 };
          sum.x += s * n.x;
          sum.y += s * n.y;
          sum.z += s * n.z;
          found.set(owner.entity, sum);
        });
      });
    }
    return [...found].map(([e, n]) => {
      const length = Math.hypot(n.x, n.y, n.z) || 1;
      return { entity: e, normal: new Vec3(n.x / length, n.y / length, n.z / length) };
    });
  }

  // ── Characters ───────────────────────────────────────────────────────────────

  moveCharacter(entity: EntityId, shape: CharacterShape, delta: Vec3, snap: boolean): CharacterStep {
    const R = rapier();
    this.syncScenery();
    const record = this.#kernel.world.require(entity);
    let claim = this.#claims.get(entity);
    if (claim === undefined) {
      claim = { shape, controller: undefined, controllerKey: '' };
      this.#claims.set(entity, claim);
    }
    claim.shape = shape;
    const body = this.reconcile(record)!;
    if (this.#ragdolls.simulated(entity)) {
      return { moved: Vec3.ZERO, grounded: false, ground: undefined, groundVelocity: Vec3.ZERO, blockedAbove: false };
    }
    const collider = body.characterCollider!;
    const controllerKey = key([shape.radius, shape.stepHeight, shape.maxSlope]);
    if (claim.controller === undefined || claim.controllerKey !== controllerKey) {
      if (claim.controller !== undefined) this.world.removeCharacterController(claim.controller);
      const controller = this.world.createCharacterController(CHARACTER_SKIN);
      controller.setUp({ x: 0, y: 1, z: 0 });
      controller.setSlideEnabled(true);
      controller.setMaxSlopeClimbAngle(rad(shape.maxSlope));
      controller.setMinSlopeSlideAngle(rad(shape.maxSlope));
      if (shape.stepHeight > 0) controller.enableAutostep(shape.stepHeight, shape.radius / 2, false);
      else controller.disableAutostep();
      claim.controller = controller;
      claim.controllerKey = controllerKey;
    }
    const controller = claim.controller;
    // Rapier 0.19's snap-to-ground sinks through large cuboids (float32 shape casts against
    // a 600 m floor end up 0.7 m inside it); snapping is done below with an exact raycast.
    controller.disableSnapToGround();

    // The game may have moved the character through its transform (or a teleport):
    // start the move from there.
    const t = record.transform;
    const at = t.worldPosition();
    const current = body.body.translation();
    if (Math.abs(current.x - at.x) + Math.abs(current.y - at.y) + Math.abs(current.z - at.z) > 1e-9) {
      body.body.setTranslation(at, true);
      body.body.setNextKinematicTranslation(at);
      this.world.propagateModifiedBodyPositionsToColliders();
    }

    const predicate = this.#predicate(NO_FILTER, entity);
    controller.computeColliderMovement(collider, delta, R.QueryFilterFlags.EXCLUDE_SENSORS, collider.collisionGroups(), predicate);
    const m = controller.computedMovement();
    let grounded = controller.computedGrounded();

    const minUp = Math.cos(rad(shape.maxSlope)) - 1e-3;
    let groundCollider: RAPIER.Collider | undefined;
    let bestUp = -Infinity;
    let blockedAbove = false;
    for (let i = 0; i < controller.numComputedCollisions(); i++) {
      const c = controller.computedCollision(i);
      if (c === null || c.collider === null) continue;
      // normal1 is on the character's shape (pointing out of it, towards the obstacle).
      const up = -c.normal1.y;
      if (up < -0.5 && delta.y > 0) blockedAbove = true;
      if (up >= minUp && up > bestUp) {
        bestUp = up;
        groundCollider = c.collider;
      }
    }

    // The ground under the capsule's centre, by an exact raycast: it snaps the feet down
    // over small drops (when asked) and lifts them back out of a floor the controller's
    // float32 shape casts let them sink into (large cuboids).
    let position = at.__add__(new Vec3(m.x, m.y, m.z));
    const reach = Math.max(shape.stepHeight, 0.05);
    const ray = new R.Ray({ x: position.x, y: position.y + shape.radius, z: position.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRayAndGetNormal(ray, shape.radius + reach + CHARACTER_SKIN * 2, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, collider.collisionGroups(), undefined, undefined, predicate);
    if (hit !== null && hit.normal.y >= minUp && delta.y <= 0) {
      const surface = position.y + shape.radius - hit.timeOfImpact;
      const gap = position.y - surface;
      // Sunk below the skin (Rapier keeps the feet CHARACTER_SKIN above the ground), or
      // above it within snapping reach while not grounded: put the feet back on the skin.
      if (gap < CHARACTER_SKIN / 2 || (snap && !grounded && gap <= reach + CHARACTER_SKIN)) {
        position = position.with_y(surface + CHARACTER_SKIN);
        grounded = true;
        groundCollider ??= hit.collider;
      } else if (grounded) {
        groundCollider ??= hit.collider;
      }
    }
    const moved = position.__sub__(at);

    let ground: EntityId | undefined;
    let groundVelocity = Vec3.ZERO;
    if (grounded && groundCollider !== undefined) {
      ground = this.#owners.get(groundCollider.handle)?.entity;
      const parent = groundCollider.parent();
      if (parent !== null && !parent.isFixed()) groundVelocity = toVec3(parent.velocityAtPoint(position));
    }

    t.setWorldPosition(position);
    body.position = t.position;
    return { moved, grounded, ground: grounded ? ground : undefined, groundVelocity, blockedAbove };
  }

  releaseCharacter(entity: EntityId): void {
    const claim = this.#claims.get(entity);
    if (claim === undefined) return;
    if (claim.controller !== undefined) this.world.removeCharacterController(claim.controller);
    this.#claims.delete(entity);
    const record = this.#kernel.world.get(entity);
    if (record !== undefined) this.reconcile(record);
  }

  // ── Wheeled vehicles ─────────────────────────────────────────────────────────

  driveWheels(entity: EntityId, specs: readonly WheelSpec[], inputs: readonly WheelInput[], dt: number): WheelContact[] {
    const R = rapier();
    if (specs.length !== inputs.length) fail('PP9151', `driveWheels got ${specs.length} wheels and ${inputs.length} inputs`);
    const body = this.#requireDynamic(entity, 'A wheeled vehicle');
    if (!this.offsetOf(entity).is_close(Quat.IDENTITY, 1e-12)) {
      fail('PP3184', 'A wheeled vehicle can\'t be held by a hinge or slider that turns its frame', { fix: 'Hitch it with a ball joint (a trailer), or not at all.' });
    }
    const wheelsKey = JSON.stringify(specs.map((w) => [w.connection.toJSON(), w.radius, w.restLength, w.maxTravel, w.stiffness, w.damping, w.maxForce]));
    let set = this.#wheels.get(entity);
    if (set === undefined || set.key !== wheelsKey || set.controller.chassis() !== body.body) {
      if (set !== undefined) this.world.removeVehicleController(set.controller);
      const controller = this.world.createVehicleController(body.body);
      controller.indexUpAxis = 1;
      controller.setIndexForwardAxis = 2;
      specs.forEach((w, i) => {
        controller.addWheel(w.connection, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, w.restLength, w.radius);
        controller.setWheelSuspensionStiffness(i, w.stiffness);
        controller.setWheelSuspensionCompression(i, w.damping);
        controller.setWheelSuspensionRelaxation(i, w.damping);
        controller.setWheelMaxSuspensionTravel(i, w.maxTravel);
        controller.setWheelMaxSuspensionForce(i, w.maxForce);
      });
      set = { controller, key: wheelsKey };
      this.#wheels.set(entity, set);
    }
    const controller = set.controller;
    inputs.forEach((input, i) => {
      controller.setWheelEngineForce(i, input.engineForce);
      // Rapier's brake is the most rolling-friction impulse per step.
      controller.setWheelBrake(i, input.brake * dt);
      // Rapier steers about +y: positive turns +z towards +x (right).
      controller.setWheelSteering(i, rad(input.steering));
      controller.setWheelFrictionSlip(i, input.frictionSlip);
      controller.setWheelSideFrictionStiffness(i, input.sideStiffness);
    });
    const groups = (body.collider ?? body.characterCollider)?.collisionGroups();
    controller.updateVehicle(dt, R.QueryFilterFlags.EXCLUDE_SENSORS, groups, this.#predicate(NO_FILTER, entity));
    return specs.map((_, i) => {
      const inContact = controller.wheelIsInContact(i);
      const groundCollider = inContact ? controller.wheelGroundObject(i) : null;
      const ground = groundCollider === null ? undefined : this.#owners.get(groundCollider.handle)?.entity;
      return { inContact, ground };
    });
  }

  releaseWheels(entity: EntityId): void {
    const set = this.#wheels.get(entity);
    if (set === undefined) return;
    this.world.removeVehicleController(set.controller);
    this.#wheels.delete(entity);
  }

  // ── Mounts ───────────────────────────────────────────────────────────────────

  mount(rider: EntityId, carrier: EntityId, seat: Vec3, rotation: Quat = Quat.IDENTITY): void {
    if (rider === carrier) fail('PP3159', 'An entity can\'t ride itself');
    this.#kernel.world.require(carrier);
    this.#mounts.set(rider, { carrier, seat, rotation });
    const record = this.#kernel.world.require(rider);
    const body = this.reconcile(record);
    if (body !== undefined) this.#dropPairsOf(rider);
    this.#placeRider(rider, this.#mounts.get(rider)!);
    this.poses.snap(rider);
  }

  dismount(rider: EntityId): void {
    if (!this.#mounts.delete(rider)) return;
    const record = this.#kernel.world.get(rider);
    if (record !== undefined) this.reconcile(record);
  }

  mountOf(rider: EntityId): Mount | undefined {
    return this.#mounts.get(rider);
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  raycast(origin: XYZ, dir: XYZ, maxDistance: number, filter: QueryFilter): Hit3d | undefined {
    const R = rapier();
    const hit = this.world.castRayAndGetNormal(new R.Ray(origin, dir), maxDistance, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, this.#predicate(filter));
    if (hit === null) return undefined;
    return this.#hit(this.#owners.get(hit.collider.handle)!.entity, origin, dir, hit.timeOfImpact, hit.normal);
  }

  raycastAll(origin: XYZ, dir: XYZ, maxDistance: number, filter: QueryFilter): Hit3d[] {
    const R = rapier();
    const nearest = new Map<EntityId | undefined, Hit3d>();
    this.world.intersectionsWithRay(new R.Ray(origin, dir), maxDistance, true, (i) => {
      const entity = this.#owners.get(i.collider.handle)!.entity;
      const previous = nearest.get(entity);
      if (previous === undefined || i.timeOfImpact < previous.distance) {
        nearest.set(entity, this.#hit(entity, origin, dir, i.timeOfImpact, i.normal));
      }
      return true;
    }, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, this.#predicate(filter));
    return [...nearest.entries()]
      .sort(([a, ha], [b, hb]) => ha.distance - hb.distance || this.#order(a) - this.#order(b))
      .map(([, hit]) => hit);
  }

  /** Entities whose colliders (triggers included) touch the shape, in body creation order. The terrain is not an entity. */
  overlap(center: XYZ, rotation: Quat, shape: RAPIER.Shape, filter: QueryFilter): EntityId[] {
    const found = new Set<EntityId>();
    this.world.intersectionsWithShape(center, rotation, shape, (collider) => {
      const entity = this.#owners.get(collider.handle)?.entity;
      if (entity !== undefined) found.add(entity);
      return true;
    }, undefined, undefined, undefined, undefined, this.#predicate(filter));
    return [...found].sort((a, b) => this.#order(a) - this.#order(b));
  }

  /** Push dynamic bodies in `entities` away from `center`, falling off linearly to 0 at `radius`. */
  explode(center: XYZ, radius: number, strength: number, entities: readonly EntityId[]): void {
    for (const entity of entities) {
      const body = this.#bodies.get(entity);
      if (body === undefined || body.kind !== 'dynamic') continue;
      const p = body.body.translation();
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dz = p.z - center.z;
      const distance = Math.hypot(dx, dy, dz);
      const falloff = Math.max(0, 1 - distance / radius);
      // A body exactly at the centre is pushed straight up.
      const u = distance === 0 ? { x: 0, y: 1, z: 0 } : { x: dx / distance, y: dy / distance, z: dz / distance };
      const j = strength * falloff;
      body.body.applyImpulse({ x: u.x * j, y: u.y * j, z: u.z * j }, true);
    }
  }

  /**
   * Sweep `shape` from `origin` along unit `dir`: the first solid hit (triggers skipped).
   * `self` is left out (a sweep of an entity's own collider).
   */
  shapecast(shape: RAPIER.Shape, origin: XYZ, rotation: Quat, dir: XYZ, maxDistance: number, filter: QueryFilter, self?: EntityId): Hit3d | undefined {
    const R = rapier();
    const hit = this.world.castShape(origin, rotation, dir, shape, 0, maxDistance, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, this.#predicate(filter, self));
    if (hit === null) return undefined;
    // From the scene query, witness 1 and normal 1 are on the hit collider, in world space.
    return {
      entity: this.#owners.get(hit.collider.handle)!.entity,
      point: toVec3(hit.witness1),
      normal: toVec3(hit.normal1).normalized(),
      distance: hit.time_of_impact,
    };
  }

  /** The entity's own Collider shape and its world pose, for `sweep`. */
  colliderPose(entity: EntityId): { shape: RAPIER.Shape; position: XYZ; rotation: Quat } | undefined {
    const record = this.#kernel.world.require(entity);
    const body = this.reconcile(record);
    const collider = body?.collider;
    if (collider === undefined) return undefined;
    return { shape: collider.shape, position: collider.translation(), rotation: toQuat(collider.rotation()) };
  }

  // ── Network-driven bodies ────────────────────────────────────────────────────

  setDriven(entity: EntityId, driven: boolean): void {
    if (driven) this.#driven.add(entity);
    else this.#driven.delete(entity);
    const record = this.#kernel.world.get(entity);
    if (record !== undefined) this.reconcile(record);
  }

  layerOf(entity: EntityId): string | undefined {
    const col = this.#kernel.world.get(entity)?.components.get(COLLIDER);
    return col === undefined ? undefined : col['layer'] as string;
  }

  // ── Contact forces ───────────────────────────────────────────────────────────

  watchContactForces(entity: EntityId, owner: string, threshold: number | undefined): void {
    if (threshold !== undefined && !(threshold >= 0)) fail('PP3193', `A contact-force threshold must be at least 0, got ${threshold}`);
    const owners = this.#watches.get(entity) ?? new Map<string, number>();
    if (threshold === undefined) owners.delete(owner);
    else owners.set(owner, threshold);
    if (owners.size === 0) this.#watches.delete(entity);
    else this.#watches.set(entity, owners);
    const body = this.#bodies.get(entity);
    if (body !== undefined) this.#applyWatch(body);
  }

  contactForces(): readonly ContactForce[] {
    return this.#contactForces;
  }

  #threshold(entity: EntityId): number | undefined {
    const owners = this.#watches.get(entity);
    return owners === undefined ? undefined : Math.min(...owners.values());
  }

  #applyWatch(body: Body): void {
    const R = rapier();
    const collider = body.collider;
    if (collider === undefined || collider.isSensor()) return;
    const threshold = this.#threshold(body.entity);
    collider.setActiveEvents(threshold === undefined ? R.ActiveEvents.COLLISION_EVENTS
      : R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS);
    collider.setContactForceEventThreshold(threshold ?? 0);
  }

  // ── Joint and field support ──────────────────────────────────────────────────

  offsetOf(entity: EntityId): Quat {
    return this.#offsets.get(entity) ?? Quat.IDENTITY;
  }

  /** Turn the body's Rapier frame: entity rotation = body rotation × offset. Its colliders follow. */
  setOffset(entity: EntityId, offset: Quat): void {
    this.#offsets.set(entity, offset);
    const record = this.#kernel.world.require(entity);
    const body = this.#bodies.get(entity);
    if (body === undefined) return;
    body.body.setRotation(this.#bodyRotation(entity, record.transform.worldRotation()), true);
    if (body.kind === 'kinematic') body.body.setNextKinematicRotation(this.#bodyRotation(entity, record.transform.worldRotation()));
    this.reconcile(record);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  #bodyRotation(entity: EntityId, world: Quat): Quat {
    const offset = this.#offsets.get(entity);
    return offset === undefined ? world : world.__mul__(offset.inverse());
  }

  #entityRotation(entity: EntityId, body: Quat): Quat {
    const offset = this.#offsets.get(entity);
    return offset === undefined ? body : body.__mul__(offset);
  }

  markForced(entity: EntityId): void {
    const body = this.#bodies.get(entity);
    if (body !== undefined) body.forced = true;
  }

  /** Total contact impulse (N·s, world) the entity's solid colliders received over the last step. */
  contactImpulse(entity: EntityId): XYZ {
    const body = this.#bodies.get(entity);
    if (body === undefined) return ZERO_XYZ;
    const sum = { x: 0, y: 0, z: 0 };
    for (const c of [body.collider, body.characterCollider]) {
      if (c === undefined || c.isSensor()) continue;
      this.world.contactPairsWith(c, (other) => {
        if (other.parent()?.handle === body.body.handle) return;
        this.world.contactPair(c, other, (manifold, flipped) => {
          const n = manifold.normal();
          let j = 0;
          for (let i = 0; i < manifold.numContacts(); i++) j += manifold.contactImpulse(i);
          // The normal points from the first collider to the second: the first is pushed back along -n.
          const s = flipped ? j : -j;
          sum.x += n.x * s;
          sum.y += n.y * s;
          sum.z += n.z * s;
        });
      });
    }
    return sum;
  }

  #jointHost(): JointHost {
    const sim = this;
    return {
      get world() { return sim.world; },
      kernel: this.#kernel,
      bodyOf: (entity) => {
        const record = this.#kernel.world.get(entity);
        const body = record === undefined ? undefined : this.reconcile(record);
        return body === undefined ? undefined : { entity, body: body.body, kind: body.kind } satisfies JointBody;
      },
      offsetOf: (entity) => this.offsetOf(entity),
      setOffset: (entity, offset) => this.setOffset(entity, offset),
      markForced: (entity) => this.markForced(entity),
      preStep: (entity) => this.#pre.get(entity),
      contactImpulse: (entity) => this.contactImpulse(entity),
      where,
    };
  }

  #ragdollHost(): RagdollHost {
    const sim = this;
    return {
      kernel: this.#kernel,
      get world() { return sim.world; },
      groupsOf: (entity) => {
        const collider = this.#bodies.get(entity)?.collider ?? this.#bodies.get(entity)?.characterCollider;
        const owner = collider === undefined ? undefined : this.#owners.get(collider.handle);
        return owner?.groups ?? this.layers.groups('default', this.layers.names, 'ragdoll');
      },
      claim: (collider, entity) => {
        const groups = collider.collisionGroups();
        this.#owners.set(collider.handle, { entity, sensor: false, layerBit: groups >>> 16, groups, material: null });
      },
      release: (collider) => this.#retire(collider),
      ragdolled: (entity) => {
        const record = this.#kernel.world.get(entity);
        if (record === undefined) return;
        this.#dropPairsOf(entity);
        this.reconcile(record);
        this.poses.snap(entity);
      },
      velocity: (entity) => {
        const body = this.#bodies.get(entity);
        if (body?.kind === 'dynamic') return toVec3(body.body.linvel());
        return this.poses.velocity(entity, this.#kernel.time.fixedStep);
      },
      where,
    };
  }

  #fieldHost(): FieldHost {
    const target = (body: Body): FieldTarget => ({
      entity: body.entity, body: body.body,
      layerBit: body.collider === undefined ? 0 : this.#owners.get(body.collider.handle)?.layerBit ?? 0,
    });
    return {
      kernel: this.#kernel,
      world: this.world,
      layers: this.layers,
      dynamicBodies: () => [...this.#bodies.values()].filter((b) => b.kind === 'dynamic' && !this.#mounts.has(b.entity)).map(target),
      colliderOf: (entity) => this.#bodies.get(entity)?.collider,
      targetOf: (collider) => {
        const entity = this.#owners.get(collider.handle)?.entity;
        const body = entity === undefined ? undefined : this.#bodies.get(entity);
        return body === undefined || body.kind !== 'dynamic' || this.#mounts.has(body.entity) ? undefined : target(body);
      },
      markForced: (entity) => this.markForced(entity),
      where,
    };
  }

  // ── Terrain ──────────────────────────────────────────────────────────────────

  /** Bring every non-entity collider (terrain, foliage, voxel chunks) up to date. */
  syncScenery(): void {
    this.syncTerrain();
    this.syncFoliage();
    this.syncVoxels();
    this.syncProcgen();
  }

  /**
   * Build (or drop) the terrain colliders when the terrain service's field changed: all of
   * them on a new build (`version`), and each chunk whose `revision` moved past the one its
   * collider was built at (deformation, holes). A field without chunks is one chunk.
   */
  syncTerrain(): void {
    const field = this.#kernel.tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (field === null) {
      if (this.#terrain !== undefined) this.#removeTerrain();
      return;
    }
    if (this.#terrain !== undefined && this.#terrain.version !== field.version) this.#removeTerrain();
    const state = this.#terrain ?? { version: field.version, chunks: new Map() };
    this.#terrain = state;
    const chunks = terrainChunks(field);
    chunks.forEach((chunk, i) => {
      const built = state.chunks.get(i);
      if (built !== undefined && built.revision === chunk.revision) return;
      if (built?.body !== undefined) this.#removeScenery(built.body);
      const { vertices, indices } = terrainMesh(field, chunk);
      state.chunks.set(i, { revision: chunk.revision, body: indices.length === 0 ? undefined : this.#scenery(vertices, indices) });
    });
  }

  #removeTerrain(): void {
    for (const built of this.#terrain!.chunks.values()) if (built.body !== undefined) this.#removeScenery(built.body);
    this.#terrain = undefined;
  }

  /**
   * Static cylinders for the standing instances of foliage layers that `collide` (trunks,
   * boulders): radius·scale wide, height·scale tall, standing on the instance's ground
   * point. Rebuilt whenever the foliage `revision` changes (a removal, a new scatter, the
   * ground moving under it).
   */
  syncFoliage(): void {
    const service = this.#kernel.tryService(FOLIAGE_SERVICE);
    if (service === undefined) {
      if (this.#foliage !== undefined) this.#removeFoliage();
      return;
    }
    const revision = service.revision;
    if (this.#foliage?.revision === revision) return;
    if (this.#foliage !== undefined) this.#removeFoliage();
    const R = rapier();
    const bodies: RAPIER.RigidBody[] = [];
    const groups = this.layers.groups('default', this.layers.names, 'terrain');
    const layerBit = this.layers.bit('default', 'terrain');
    for (const layer of service.layers()) {
      if (!layer.collide) continue;
      let body: RAPIER.RigidBody | undefined;
      for (let k = 0; k < layer.count; k++) {
        if (layer.alive[k] === 0) continue;
        const scale = layer.scale[k]!;
        const radius = layer.radius * scale;
        const height = layer.height * scale;
        if (!(radius > 0 && height > 0)) continue;
        body ??= this.world.createRigidBody(R.RigidBodyDesc.fixed());
        const desc = R.ColliderDesc.cylinder(height / 2, radius)
          .setTranslation(layer.x[k]!, layer.y[k]! + height / 2, layer.z[k]!)
          .setCollisionGroups(groups).setSolverGroups(groups);
        const collider = this.world.createCollider(desc, body);
        this.#owners.set(collider.handle, { entity: undefined, sensor: false, layerBit, groups, material: null });
      }
      if (body !== undefined) bodies.push(body);
    }
    this.#foliage = { revision, bodies };
  }

  #removeFoliage(): void {
    for (const body of this.#foliage!.bodies) this.#removeScenery(body);
    this.#foliage = undefined;
  }

  #removeScenery(body: RAPIER.RigidBody): void {
    for (let i = 0; i < body.numColliders(); i++) this.#owners.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  /**
   * One fixed trimesh per generated mesh with collision (procgen service), in world space,
   * rebuilt when its `collisionVersion` changes and dropped when its key goes away. Hits
   * name the mesh's entity (null for scene-level sources).
   */
  syncProcgen(): void {
    const meshes = [...this.#kernel.tryService(PROCGEN_SERVICE)?.meshes() ?? [], ...this.#kernel.tryService(CITY_SERVICE)?.meshes() ?? []];
    const seen = new Set<string>();
    for (const mesh of meshes) {
      if (mesh.collision === null || mesh.collision.indices.length === 0) continue;
      seen.add(mesh.key);
      const built = this.#procgen.get(mesh.key);
      if (built?.version === mesh.collisionVersion) continue;
      if (built !== undefined) this.#removeScenery(built.body);
      const body = this.#scenery(mesh.collision.vertices, mesh.collision.indices, mesh.entity ?? undefined, mesh.layer, `generated mesh ${mesh.key}`);
      this.#procgen.set(mesh.key, { version: mesh.collisionVersion, body });
    }
    for (const [key, built] of this.#procgen) {
      if (seen.has(key)) continue;
      this.#removeScenery(built.body);
      this.#procgen.delete(key);
    }
  }

  #removeProcgen(): void {
    for (const built of this.#procgen.values()) this.#removeScenery(built.body);
    this.#procgen.clear();
  }

  /** A fixed trimesh in the default layer (terrain, voxel chunks) or the given one (generated meshes, which name their `entity`). */
  #scenery(vertices: Float32Array, indices: Uint32Array, entity?: EntityId, layer = 'default', where = 'terrain'): RAPIER.RigidBody {
    const R = rapier();
    const groups = this.layers.groups(layer, this.layers.names, where);
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    const desc = R.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(groups).setSolverGroups(groups);
    const collider = this.world.createCollider(desc, body);
    this.#owners.set(collider.handle, { entity, sensor: false, layerBit: this.layers.bit(layer, where), groups, material: null });
    return body;
  }

  // ── Voxels ───────────────────────────────────────────────────────────────────

  /**
   * Keep one fixed trimesh per active chunk of the scene's block world (voxels service):
   * the chunks the voxels plugin keeps around the streaming sources (its render distance,
   * which is also its collision distance). A chunk's collider is rebuilt when its mesh
   * `version` changes and dropped when it leaves the active set; every collider is
   * dropped when the world is rebuilt (scene load, restore, loaded edits). Like the
   * terrain, chunks are in the "default" layer and are not entities.
   */
  syncVoxels(): void {
    const view = this.#kernel.tryService(VOXELS_SERVICE)?.current() ?? null;
    if (view === null) {
      if (this.#voxels !== undefined) this.#removeVoxels();
      return;
    }
    if (this.#voxels !== undefined && (this.#voxels.world !== view.version || this.#voxels.scene !== view.scene)) this.#removeVoxels();
    const state = this.#voxels ?? { world: view.version, scene: view.scene, chunks: new Map<string, VoxelChunkCollider>() };
    this.#voxels = state;
    const seen = new Set<string>();
    for (const chunk of view.active()) {
      seen.add(chunk.key);
      const built = state.chunks.get(chunk.key);
      if (built?.version === chunk.version) continue;
      if (built?.body !== undefined) this.#removeScenery(built.body);
      const { vertices, indices } = chunk.collision;
      state.chunks.set(chunk.key, { version: chunk.version, body: indices.length === 0 ? undefined : this.#scenery(vertices, indices) });
    }
    for (const [key, built] of state.chunks) {
      if (seen.has(key)) continue;
      if (built.body !== undefined) this.#removeScenery(built.body);
      state.chunks.delete(key);
    }
  }

  #removeVoxels(): void {
    for (const built of this.#voxels!.chunks.values()) if (built.body !== undefined) this.#removeScenery(built.body);
    this.#voxels = undefined;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #order(entity: EntityId | undefined): number {
    return entity === undefined ? -1 : this.#bodies.get(entity)?.order ?? Number.MAX_SAFE_INTEGER;
  }

  #predicate(filter: QueryFilter, self?: EntityId): (collider: RAPIER.Collider) => boolean {
    return (collider) => {
      const owner = this.#owners.get(collider.handle);
      if (owner === undefined) return false;
      if (owner.entity !== undefined) {
        if (owner.entity === self || !this.#kernel.world.isAlive(owner.entity) || this.#mounts.has(owner.entity)) return false;
        if (filter.ignore.has(owner.entity)) return false;
        // A ragdolled entity is its parts: its own (switched-off) colliders aren't there.
        if (this.#ragdolls.simulated(owner.entity) && !this.#ragdolls.isPart(collider.handle)) return false;
      }
      return filter.layers === 0 || (filter.layers & owner.layerBit) !== 0;
    };
  }

  #hit(entity: EntityId | undefined, origin: XYZ, dir: XYZ, distance: number, normal: XYZ): Hit3d {
    return {
      entity,
      point: new Vec3(origin.x + dir.x * distance, origin.y + dir.y * distance, origin.z + dir.z * distance),
      normal: toVec3(normal),
      distance,
    };
  }

  #bodyType(kind: BodyKind): RAPIER.RigidBodyType {
    const R = rapier();
    if (kind === 'dynamic') return R.RigidBodyType.Dynamic;
    if (kind === 'kinematic') return R.RigidBodyType.KinematicPositionBased;
    return R.RigidBodyType.Fixed;
  }

  #create(record: EntityRecord, kind: BodyKind): Body {
    const R = rapier();
    const p = record.transform.worldPosition();
    const desc = new R.RigidBodyDesc(this.#bodyType(kind)).setTranslation(p.x, p.y, p.z)
      .setRotation(this.#bodyRotation(record.id, record.transform.worldRotation()));
    const body: Body = {
      entity: record.id,
      order: this.#nextOrder++,
      body: this.world.createRigidBody(desc),
      kind,
      collider: undefined,
      colliderPending: false,
      geometryBounds: undefined,
      characterCollider: undefined,
      characterKey: '',
      rigidbodyFields: undefined,
      colliderFields: undefined,
      rigidbodyKey: '',
      colliderKey: '',
      locksKey: '',
      position: record.transform.position,
      rotation: record.transform.rotation,
      angularVelocity: undefined,
      kinematicVelocity: Vec3.ZERO,
      forced: false,
    };
    this.#bodies.set(record.id, body);
    return body;
  }

  #remove(body: Body): void {
    if (body.collider !== undefined) this.#retire(body.collider);
    if (body.characterCollider !== undefined) this.#retire(body.characterCollider);
    const wheels = this.#wheels.get(body.entity);
    if (wheels !== undefined) {
      this.world.removeVehicleController(wheels.controller);
      this.#wheels.delete(body.entity);
    }
    this.world.removeRigidBody(body.body);
    this.#bodies.delete(body.entity);
  }

  #retire(collider: RAPIER.Collider): void {
    const owner = this.#owners.get(collider.handle);
    if (owner !== undefined) this.#retired.set(collider.handle, owner);
    this.#owners.delete(collider.handle);
  }

  #removeCollider(body: Body, slot: 'collider' | 'characterCollider'): void {
    const collider = body[slot]!;
    this.#retire(collider);
    this.world.removeCollider(collider, true);
    body[slot] = undefined;
  }

  #applyRigidbody(body: Body, rb: Fields | undefined, record: EntityRecord): void {
    const b = body.body;
    const axes = (rb?.['lock_axes'] ?? []) as readonly string[];
    const lockAll = rb?.['lock_rotation'] === true;
    const t = [axes.includes('x'), axes.includes('y'), axes.includes('z')];
    const spin = (rb?.['lock_rotation_axes'] ?? []) as readonly string[];
    const r = [lockAll || spin.includes('x'), lockAll || spin.includes('y'), lockAll || spin.includes('z')];
    for (const l of this.#locks.get(record.id)?.values() ?? []) {
      for (let i = 0; i < 3; i++) {
        t[i] = t[i]! || l.translation[i]!;
        r[i] = r[i]! || l.rotation[i]!;
      }
    }
    b.setEnabledTranslations(!t[0], !t[1], !t[2], true);
    b.setEnabledRotations(!r[0], !r[1], !r[2], true);
    if (rb === undefined) return;
    b.setLinearDamping(rb['linear_damping'] as number);
    b.setAngularDamping(rb['angular_damping'] as number);
    b.setGravityScale(rb['gravity_scale'] as number, true);
    b.enableCcd(rb['continuous'] === true);
    const mass = rb['mass'] as number;
    if (!(mass > 0)) fail('PP3154', `${where(record, 'rigidbody')}.mass is ${mass}; a body's mass must be above 0`);
  }

  /** Mass lives on the collider when there is one (so inertia follows its shape), else on the body. */
  #applyMass(body: Body): void {
    const rb = body.rigidbodyFields;
    if (rb === undefined || body.kind !== 'dynamic') return;
    const mass = rb['mass'] as number;
    if (body.collider !== undefined) {
      body.body.setAdditionalMass(0, true);
      body.collider.setMass(mass);
    } else {
      body.body.setAdditionalMass(mass, true);
    }
    body.body.recomputeMassPropertiesFromColliders();
  }

  /**
   * Mounted riders' colliders are off while they ride: interaction groups 0 (rapier3d
   * 0.19's `setEnabled(false)` still lets a kinematic body's collider push dynamic ones),
   * and every query skips them.
   */
  #applyEnabled(body: Body): void {
    const mounted = this.#mounts.has(body.entity) || this.#ragdolls.simulated(body.entity);
    for (const c of [body.collider, body.characterCollider]) {
      if (c === undefined) continue;
      const groups = mounted ? 0 : this.#owners.get(c.handle)!.groups;
      if (c.collisionGroups() !== groups) {
        c.setCollisionGroups(groups);
        c.setSolverGroups(groups);
      }
    }
  }

  #geometry(record: EntityRecord, shape: string): { model: { path: string; offset: Vec3; rotation: Vec3; scale: number }; geometry: ModelGeometry | null | undefined } {
    const model = modelPath(record);
    if (model === undefined) {
      fail('PP3160', `${where(record, 'collider')} is a "${shape}" collider, but the entity has no Model to take its shape from`, {
        fix: 'Add a model component naming the asset, or use a box/sphere/capsule/cylinder collider.',
      });
    }
    const source = this.#kernel.tryService(MODEL_GEOMETRY_SERVICE);
    if (source === undefined) {
      fail('PP3161', `${where(record, 'collider')} is a "${shape}" collider of ${model.path}, but no plugin provides model geometry`, {
        fix: MODEL_GEOMETRY_SERVICE.fix,
      });
    }
    return { model, geometry: source.geometry(model.path) };
  }

  #attachCollider(body: Body, col: Fields, scale: Vec3, record: EntityRecord): void {
    const R = rapier();
    const at = where(record, 'collider');
    const sx = Math.abs(scale.x);
    const sy = Math.abs(scale.y);
    const sz = Math.abs(scale.z);
    const positive = (value: number, name: string): number =>
      value > 0 ? value : fail('PP3155', `${at}.${name} is ${value} (after scale); it must be above 0`);
    let desc: RAPIER.ColliderDesc;
    const shape = col['shape'] as string;
    const offset = col['offset'] as Vec3;
    let translation = { x: offset.x * sx, y: offset.y * sy, z: offset.z * sz };
    if (shape === 'box') {
      const size = col['size'] as Vec3;
      desc = R.ColliderDesc.cuboid(positive(size.x * sx, 'size.x') / 2, positive(size.y * sy, 'size.y') / 2, positive(size.z * sz, 'size.z') / 2);
    } else if (shape === 'sphere') {
      desc = R.ColliderDesc.ball(positive((col['radius'] as number) * Math.max(sx, sy, sz), 'radius'));
    } else if (shape === 'capsule' || shape === 'cylinder') {
      const radius = positive((col['radius'] as number) * Math.max(sx, sz), 'radius');
      const height = positive((col['height'] as number) * sy, 'height');
      if (shape === 'cylinder') {
        desc = R.ColliderDesc.cylinder(height / 2, radius);
      } else {
        if (height < 2 * radius) {
          fail('PP3155', `${at}: a capsule ${height} tall can't have radius ${radius}`, {
            fix: '`height` is the full height, end caps included: make it at least 2 × radius.',
          });
        }
        desc = R.ColliderDesc.capsule(height / 2 - radius, radius);
      }
    } else if (shape === 'mesh' || shape === 'convex') {
      if (shape === 'mesh' && body.kind === 'dynamic') {
        fail('PP3162', `${at} is a "mesh" collider on a dynamic body`, {
          fix: 'Triangle meshes are for static and kinematic scenery; use "convex" (or a box/capsule) for a moving body.',
        });
      }
      const { model, geometry } = this.#geometry(record, shape);
      if (geometry === undefined) {
        body.colliderPending = true;
        return;
      }
      // No model file in this run (data-only): the collider has no shape, as the model draws nothing.
      if (geometry === null) return;
      const vertices = new Float32Array(geometry.vertices.length);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const s = [scale.x, scale.y, scale.z];
      const o = [model.offset.x + offset.x, model.offset.y + offset.y, model.offset.z + offset.z];
      // Model.scale and rotation_offset size and turn the model's vertices first, as the renderer draws them.
      const turn = model.rotation.x === 0 && model.rotation.y === 0 && model.rotation.z === 0 ? null : Quat.from_euler(model.rotation);
      const source = turn === null ? geometry.vertices : turnVertices(geometry.vertices, turn);
      const k = model.scale;
      for (let i = 0; i < vertices.length; i++) {
        const axis = i % 3;
        const v = (source[i]! * k + o[axis]!) * s[axis]!;
        vertices[i] = v;
        min[axis] = Math.min(min[axis]!, v);
        max[axis] = Math.max(max[axis]!, v);
      }
      if (vertices.length === 0) {
        fail('PP3163', `${at}: model ${model.path} has no vertices`, { fix: 'Use a model with geometry, or a primitive collider.' });
      }
      body.geometryBounds = {
        center: new Vec3((min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2),
        halfExtents: new Vec3((max[0]! - min[0]!) / 2, (max[1]! - min[1]!) / 2, (max[2]! - min[2]!) / 2),
      };
      translation = { x: 0, y: 0, z: 0 };
      if (shape === 'mesh') {
        desc = R.ColliderDesc.trimesh(vertices, geometry.indices);
      } else {
        const hull = R.ColliderDesc.convexHull(vertices);
        if (hull === null) {
          fail('PP3163', `${at}: model ${model.path} has no convex hull (its vertices are flat or degenerate)`, {
            fix: 'Use "mesh" for flat static geometry, or a primitive collider.',
          });
        }
        desc = hull;
      }
    } else if (shape === 'circle') {
      fail('PP3155', `${at}.shape is "circle", a 2D shape; physics3d is 3D`, { fix: 'Use "sphere" (or "cylinder") in a 3D game.' });
    } else {
      fail('PP3155', `${at}.shape is "${shape}"`, { fix: `3D shapes: ${SHAPES_3D.join(', ')}.` });
    }
    const trigger = col['trigger'] === true;
    const layer = col['layer'] as string;
    const groups = this.layers.groups(layer, col['collides_with'] as readonly string[], at);
    const materialName = col['material'] as string | null;
    const material = materialName === null ? undefined : this.#materials.get(materialName, `${at}.material`);
    // The collider sits in the body's frame, which a joint may have turned from the entity's.
    const frame = this.offsetOf(body.entity);
    const placed = frame.rotate(new Vec3(translation.x, translation.y, translation.z));
    desc.setTranslation(placed.x, placed.y, placed.z)
      .setRotation(frame)
      .setSensor(trigger)
      .setFriction(material?.friction ?? col['friction'] as number)
      .setRestitution(material?.bounce ?? col['bounce'] as number)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Max)
      .setCollisionGroups(groups)
      .setSolverGroups(groups)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
      // Triggers report against everything (a static pickup zone vs a kinematic player);
      // solid contacts are reported where Rapier resolves them (a dynamic body is involved).
      .setActiveCollisionTypes(trigger ? R.ActiveCollisionTypes.ALL : R.ActiveCollisionTypes.DEFAULT);
    const collider = this.world.createCollider(desc, body.body);
    body.collider = collider;
    this.#owners.set(collider.handle, { entity: body.entity, sensor: trigger, layerBit: this.layers.bit(layer, at), groups, material: materialName });
    this.#applyWatch(body);
  }

  /** A character's capsule: feet at the entity origin; in its Collider's layer when it has one. */
  #attachCharacterCollider(body: Body, shape: CharacterShape, col: Fields | undefined, record: EntityRecord): void {
    const R = rapier();
    const at = where(record, 'character');
    if (!(shape.radius > 0 && shape.height >= 2 * shape.radius)) {
      fail('PP3170', `${at}: a character ${shape.height} m tall can't have radius ${shape.radius}`, {
        fix: '`height` is the full height: make radius above 0 and height at least 2 × radius.',
      });
    }
    const layer = col === undefined ? 'default' : col['layer'] as string;
    const collidesWith = col === undefined ? this.layers.names : col['collides_with'] as readonly string[];
    const groups = this.layers.groups(layer, collidesWith, col === undefined ? at : where(record, 'collider'));
    if (!this.offsetOf(record.id).is_close(Quat.IDENTITY, 1e-12)) {
      fail('PP3184', `${at}: a character can't be held by a hinge or slider that turns its frame`, { fix: 'Join a character with a ball joint, or not at all.' });
    }
    const desc = R.ColliderDesc.capsule(shape.height / 2 - shape.radius, shape.radius)
      .setTranslation(0, shape.height / 2, 0)
      .setCollisionGroups(groups)
      .setSolverGroups(groups)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
      .setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT);
    const collider = this.world.createCollider(desc, body.body);
    body.characterCollider = collider;
    this.#owners.set(collider.handle, { entity: body.entity, sensor: false, layerBit: this.layers.bit(layer, at), groups, material: col === undefined ? null : col['material'] as string | null });
  }

  #push(body: Body, dt: number): void {
    const record = this.#kernel.world.get(body.entity)!;
    const t = record.transform;
    if (this.#ragdolls.simulated(body.entity)) {
      // Standing aside while its ragdoll moves it: kept where the entity is, at rest.
      body.body.setTranslation(t.worldPosition(), false);
      body.body.setRotation(this.#bodyRotation(body.entity, t.worldRotation()), false);
      if (body.kind === 'kinematic') {
        body.body.setNextKinematicTranslation(t.worldPosition());
        body.body.setNextKinematicRotation(this.#bodyRotation(body.entity, t.worldRotation()));
      } else if (body.kind === 'dynamic') {
        body.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      }
      body.position = t.position;
      body.rotation = t.rotation;
      return;
    }
    if (body.kind === 'kinematic') {
      if (!this.#claims.has(body.entity) && !this.#driven.has(body.entity)) this.#integrateKinematic(body, record, dt);
      body.body.setNextKinematicTranslation(t.worldPosition());
      body.body.setNextKinematicRotation(this.#bodyRotation(body.entity, t.worldRotation()));
    } else if (t.position !== body.position || t.rotation !== body.rotation) {
      body.body.setTranslation(t.worldPosition(), true);
      body.body.setRotation(this.#bodyRotation(body.entity, t.worldRotation()), true);
    }
    body.position = t.position;
    body.rotation = t.rotation;
  }

  /** Move a kinematic body's transform by its velocity and angular_velocity (degrees per second, world axes). */
  #integrateKinematic(body: Body, record: EntityRecord, dt: number): void {
    const t = record.transform;
    const v = body.kinematicVelocity;
    if (v.x !== 0 || v.y !== 0 || v.z !== 0) t.setWorldPosition(t.worldPosition().__add__(v.__mul__(dt)));
    const w = record.components.get(RIGIDBODY)?.['angular_velocity'];
    if (!(w instanceof Vec3)) return;
    const speed = Math.hypot(w.x, w.y, w.z);
    if (speed === 0) return;
    const half = rad(speed * dt) / 2;
    const s = Math.sin(half) / speed;
    const turn = new Quat(w.x * s, w.y * s, w.z * s, Math.cos(half));
    this.#setWorldRotation(record, turn.__mul__(t.worldRotation()));
  }

  #pull(body: Body): void {
    const record = this.#kernel.world.get(body.entity)!;
    const rb = record.components.get(RIGIDBODY);
    if (rb !== undefined && body.kind === 'dynamic') {
      const w = body.body.angvel();
      const value = new Vec3(deg(w.x), deg(w.y), deg(w.z));
      rb['angular_velocity'] = value;
      body.angularVelocity = value;
    }
    if (body.kind !== 'dynamic' || this.#ragdolls.simulated(body.entity)) return;
    const t = record.transform;
    t.setWorldPosition(toVec3(body.body.translation()));
    this.#setWorldRotation(record, this.#entityRotation(body.entity, toQuat(body.body.rotation())));
    body.position = t.position;
    body.rotation = t.rotation;
  }

  #setWorldRotation(record: EntityRecord, world: Quat): void {
    const t = record.transform;
    t.rotation = t.parent === null ? world : t.parent.worldRotation().inverse().__mul__(world);
  }

  #placeRiders(): void {
    for (const [rider, mount] of this.#mounts) this.#placeRider(rider, mount);
  }

  #placeRider(rider: EntityId, mount: Mount): void {
    const record = this.#kernel.world.get(rider);
    const carrier = this.#kernel.world.get(mount.carrier);
    if (record === undefined || carrier === undefined) return;
    const carried = carrier.transform.worldRotation();
    const position = carrier.transform.worldPosition().__add__(carried.rotate(mount.seat));
    const rotation = carried.__mul__(mount.rotation);
    record.transform.setWorldPosition(position);
    this.#setWorldRotation(record, rotation);
    const body = this.#bodies.get(rider);
    if (body === undefined) return;
    const bodyRotation = this.#bodyRotation(rider, rotation);
    body.body.setTranslation(position, false);
    body.body.setRotation(bodyRotation, false);
    if (body.kind === 'kinematic') {
      body.body.setNextKinematicTranslation(position);
      body.body.setNextKinematicRotation(bodyRotation);
    } else if (body.kind === 'dynamic') {
      body.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    }
    body.position = record.transform.position;
    body.rotation = record.transform.rotation;
  }

  #dropPairsOf(entity: EntityId): void {
    for (const [k, pair] of this.#pairs) {
      if (pair.a === entity || pair.b === entity) this.#pairs.delete(k);
    }
  }

  /** Forget pairs whose entities are gone (their stop events were delivered this step). */
  #purgePairs(): void {
    for (const [k, pair] of this.#pairs) {
      if (!this.#bodies.has(pair.a) || !this.#bodies.has(pair.b)) this.#pairs.delete(k);
    }
  }

  /** Count one collider pair starting or stopping; true when the entity pair starts or ends. */
  #count(k: string, a: EntityId, b: EntityId, started: boolean): boolean {
    const pair = this.#pairs.get(k);
    if (started) {
      if (pair === undefined) {
        this.#pairs.set(k, { count: 1, a, b });
        return true;
      }
      pair.count++;
      return false;
    }
    if (pair === undefined) return false;
    pair.count--;
    if (pair.count > 0) return false;
    this.#pairs.delete(k);
    return true;
  }

  #drainEvents(): void {
    const handles = this.#kernel.handles;
    const emit = (type: EventDef, entity: EntityId, payload: Fields): void => {
      if (this.#kernel.world.isAlive(entity)) this.#kernel.emit(type, { entity: handles.wrap(entity), ...payload });
    };
    this.#events.drainCollisionEvents((h1, h2, started) => {
      const a = this.#owners.get(h1) ?? this.#retired.get(h1);
      const b = this.#owners.get(h2) ?? this.#retired.get(h2);
      // The terrain is not an entity: its contacts raise no events.
      if (a?.entity === undefined || b?.entity === undefined || a.entity === b.entity) return;
      const ea = a.entity;
      const eb = b.entity;
      if (a.sensor || b.sensor) {
        const type = started ? PHYSICS_EVENTS.triggerEntered : PHYSICS_EVENTS.triggerExited;
        if (a.sensor && this.#count(`t:${ea}:${eb}`, ea, eb, started)) emit(type, ea, { target: handles.wrap(eb) });
        if (b.sensor && this.#count(`t:${eb}:${ea}`, eb, ea, started)) emit(type, eb, { target: handles.wrap(ea) });
        return;
      }
      const [lo, hi] = ea < eb ? [ea, eb] : [eb, ea];
      if (!this.#count(`c:${lo}:${hi}`, lo, hi, started)) return;
      if (!started) {
        emit(PHYSICS_EVENTS.collisionEnded, ea, { target: handles.wrap(eb) });
        emit(PHYSICS_EVENTS.collisionEnded, eb, { target: handles.wrap(ea) });
        return;
      }
      const contact = this.#contact(h1, h2);
      emit(PHYSICS_EVENTS.collided, ea, { target: handles.wrap(eb), point: contact.point, normal: contact.normal.__neg__(), impulse: contact.impulse });
      emit(PHYSICS_EVENTS.collided, eb, { target: handles.wrap(ea), point: contact.point, normal: contact.normal, impulse: contact.impulse });
      if (a.material !== null || b.material !== null) {
        const speed = this.#closingSpeed(ea, eb, contact.point, contact.normal);
        const impact = (self: ColliderOwner, other: ColliderOwner, normal: Vec3): void => {
          if (self.material === null) return;
          const material = this.#materials.get(self.material, 'impact');
          if (speed < material.impact_speed) return;
          emit(IMPACT, self.entity!, {
            target: handles.wrap(other.entity!), point: contact.point, normal, speed,
            material: self.material, target_material: other.material, sound: material.sound,
          });
        };
        impact(a, b, contact.normal.__neg__());
        impact(b, a, contact.normal);
      }
    });
    this.#drainContactForces();
  }

  /** Watched contacts that pressed past their thresholds this step. */
  #drainContactForces(): void {
    const found: ContactForce[] = [];
    this.#events.drainContactForceEvents((event) => {
      const h1 = event.collider1();
      const h2 = event.collider2();
      const a = this.#owners.get(h1) ?? this.#retired.get(h1);
      const b = this.#owners.get(h2) ?? this.#retired.get(h2);
      if (a === undefined || b === undefined) return;
      const force = event.totalForceMagnitude();
      const report = (self: ColliderOwner, other: ColliderOwner, selfHandle: number, otherHandle: number): void => {
        if (self.entity === undefined) return;
        const threshold = this.#threshold(self.entity);
        if (threshold === undefined || force < threshold) return;
        const contact = this.#contact(selfHandle, otherHandle);
        found.push({
          entity: self.entity, other: other.entity, force, point: contact.point,
          // The normal points from the watched collider to the other; the force pushes back into it.
          direction: contact.normal.__neg__(),
          speed: this.#closingSpeed(self.entity, other.entity, contact.point, contact.normal),
        });
      };
      report(a, b, h1, h2);
      report(b, a, h2, h1);
    });
    this.#contactForces = found.sort((x, y) => this.#order(x.entity) - this.#order(y.entity) || this.#order(x.other) - this.#order(y.other));
  }

  /** How fast the two were closing along `normal` (pointing from a to b) before the step, at `point`. */
  #closingSpeed(a: EntityId | undefined, b: EntityId | undefined, point: Vec3, normal: Vec3): number {
    const velocity = (entity: EntityId | undefined): Vec3 => {
      if (entity === undefined) return Vec3.ZERO;
      const pre = this.#pre.get(entity);
      if (pre !== undefined) {
        // v + ω × r, from the motion the body had when the step began.
        const r = new Vec3(point.x - pre.com.x, point.y - pre.com.y, point.z - pre.com.z);
        return toVec3(pre.linvel).__add__(toVec3(pre.angvel).cross(r));
      }
      const body = this.#bodies.get(entity);
      if (body?.kind === 'kinematic') return body.kinematicVelocity;
      return Vec3.ZERO;
    };
    return Math.max(0, velocity(a).__sub__(velocity(b)).dot(normal));
  }

  /**
   * The contact between two colliders after the step: the mean solver contact point, the
   * normal pointing from the first collider to the second, and the total normal impulse.
   */
  #contact(h1: number, h2: number): { point: Vec3; normal: Vec3; impulse: number } {
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    const p1 = c1?.translation() ?? { x: 0, y: 0, z: 0 };
    const p2 = c2?.translation() ?? { x: 0, y: 0, z: 0 };
    const sum = { x: 0, y: 0, z: 0 };
    const n = { x: 0, y: 0, z: 0 };
    let points = 0;
    let impulse = 0;
    if (c1 !== null && c2 !== null) {
      this.world.contactPair(c1, c2, (manifold, flipped) => {
        const m = manifold.normal();
        const s = flipped ? -1 : 1;
        n.x += s * m.x;
        n.y += s * m.y;
        n.z += s * m.z;
        for (let i = 0; i < manifold.numSolverContacts(); i++) {
          const p = manifold.solverContactPoint(i);
          sum.x += p.x;
          sum.y += p.y;
          sum.z += p.z;
          points++;
        }
        for (let i = 0; i < manifold.numContacts(); i++) impulse += manifold.contactImpulse(i);
      });
    }
    const length = Math.hypot(n.x, n.y, n.z);
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) || 1;
    const normal = length === 0
      ? new Vec3((p2.x - p1.x) / d, (p2.y - p1.y) / d, (p2.z - p1.z) / d)
      : new Vec3(n.x / length, n.y / length, n.z / length);
    if (points === 0) {
      // A contact Rapier resolved without solver contacts (speculative): between the shapes' centres.
      return { point: new Vec3((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, (p1.z + p2.z) / 2), normal, impulse };
    }
    return { point: new Vec3(sum.x / points, sum.y / points, sum.z / points), normal, impulse };
  }
}

/** A service cast shape as a Rapier shape. */
export function rapierShape(shape: CastShape): RAPIER.Shape {
  const R = rapier();
  const positive = (value: number, what: string): number =>
    value > 0 ? value : fail('PP3158', `A cast ${shape.kind}'s ${what} is ${value}; it must be above 0`);
  if (shape.kind === 'sphere') return new R.Ball(positive(shape.radius, 'radius'));
  if (shape.kind === 'box') {
    return new R.Cuboid(positive(shape.halfExtents.x, 'size.x'), positive(shape.halfExtents.y, 'size.y'), positive(shape.halfExtents.z, 'size.z'));
  }
  const radius = positive(shape.radius, 'radius');
  const height = positive(shape.height, 'height');
  if (height < 2 * radius) fail('PP3158', `A cast capsule ${height} tall can't have radius ${radius}`, { fix: '`height` is the full height, caps included: at least 2 × radius.' });
  return new R.Capsule(height / 2 - radius, radius);
}

/** The field's chunks, or the whole field as one chunk when it lists none. */
function terrainChunks(field: TerrainField): readonly TerrainChunk[] {
  if (field.chunks.length > 0) return field.chunks;
  return [{ column: 0, row: 0, columns: field.columns - 1, rows: field.rows - 1, minHeight: field.minHeight, maxHeight: field.maxHeight, revision: field.revision }];
}

/**
 * The terrain field (or one chunk of it) as triangles, split exactly as the terrain
 * service documents: A = (c,r),(c+1,r),(c+1,r+1) and B = (c,r),(c+1,r+1),(c,r+1), wound to
 * face +y. Hole quads (`field.holes`) are left out.
 */
export function terrainMesh(field: TerrainField, chunk?: TerrainChunk): { vertices: Float32Array; indices: Uint32Array } {
  const c0 = chunk?.column ?? 0;
  const r0 = chunk?.row ?? 0;
  const quadsX = chunk?.columns ?? field.columns - 1;
  const quadsZ = chunk?.rows ?? field.rows - 1;
  const columns = quadsX + 1;
  const vertices = new Float32Array(columns * (quadsZ + 1) * 3);
  for (let r = 0; r <= quadsZ; r++) {
    for (let c = 0; c <= quadsX; c++) {
      const v = (r * columns + c) * 3;
      vertices[v] = field.minX + (c0 + c) * field.cellX;
      vertices[v + 1] = field.heights[(r0 + r) * field.columns + c0 + c]!;
      vertices[v + 2] = field.minZ + (r0 + r) * field.cellZ;
    }
  }
  const holes = field.holes;
  const quads: number[] = [];
  for (let r = 0; r < quadsZ; r++) {
    for (let c = 0; c < quadsX; c++) {
      if (holes !== null && holes[(r0 + r) * (field.columns - 1) + c0 + c] === 1) continue;
      const v00 = r * columns + c;
      const v10 = v00 + 1;
      const v01 = v00 + columns;
      const v11 = v01 + 1;
      quads.push(v00, v11, v10, v00, v01, v11);
    }
  }
  return { vertices, indices: Uint32Array.from(quads) };
}

