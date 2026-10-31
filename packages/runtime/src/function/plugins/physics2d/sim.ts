/**
 * The Rapier 2D world behind one kernel. Every entity with a `collider` or a `rigidbody`
 * gets one Rapier body: dynamic or kinematic from its Rigidbody, fixed when it has only a
 * Collider. Each fixed step (the kernel's 'physics' hook):
 *
 *   1. reconcile  bodies for new entities, changed component fields, removed ones
 *   2. push       transforms → bodies: kinematic bodies follow their transform; a dynamic
 *                 or fixed body whose transform the game reassigned is moved there
 *   3. step       Rapier, with the kernel's fixed dt
 *   4. pull       dynamic bodies → transforms (x, y and angle; z and scale untouched)
 *   5. events     collided / collision_ended / trigger_entered / trigger_exited, once per
 *                 entity pair (a body across two tile runs of one tilemap still gets one event)
 *
 * Bodies are created in spawn order and Rapier is deterministic, so the same inputs give
 * the same simulation.
 *
 * Scene queries (`ctx.physics.raycast`, `overlap`, …) see colliders where the last step
 * left them: Rapier only rebuilds its query tree while stepping. A collider spawned or
 * moved since the last step is found from the next step on.
 *
 * Around the step it also builds and drives joints (joints.ts), applies force fields
 * (fields.ts), raises `impact` events for surface materials (materials.ts) and records
 * render interpolation tracks (interpolation.ts).
 */

import type RAPIER from '@dimforge/rapier2d-compat';
import { cellCenter, deg, fail, Quat, rad, solidRuns, tileGrid, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { KERNEL_EVENTS } from '../../kernel/index.js';
import type { EntityHandles, EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import { applyFields, FORCE_FIELD } from './fields.js';
import type { FieldHost2d, FieldTarget2d } from './fields.js';
import { PoseHistory } from './interpolation.js';
import { Joints2d } from './joints.js';
import type { JointHost2d, SavedJoint2d } from './joints.js';
import type { LayerTable } from './layers.js';
import { IMPACT } from './materials.js';
import type { MaterialTable } from './materials.js';
import { rapier } from './rapier.js';
import type { XY } from './values.js';

export const COLLIDER = 'collider';
export const RIGIDBODY = 'rigidbody';
/** The visuals plugin's tilemap (read by id): `collide` gives its solid cells static colliders. */
export const TILEMAP = 'tilemap';

/** Physics events: the kernel's shared definitions (every physics plugin emits the same ones). */
export const PHYSICS_EVENTS = {
  collided: KERNEL_EVENTS.collided,
  collisionEnded: KERNEL_EVENTS.collisionEnded,
  triggerEntered: KERNEL_EVENTS.triggerEntered,
  triggerExited: KERNEL_EVENTS.triggerExited,
} as const;

/** Per-body motion Rapier holds and components don't (for snapshots). */
export interface BodyMotion {
  readonly entity: number;
  readonly linvel: readonly [number, number];
  readonly angvel: number;
}

/** physics2d's snapshot: motion, the bodies whose frames joints turned, and world-joint frames. */
export interface SavedPhysics2d {
  readonly motion: readonly BodyMotion[];
  readonly offsets: ReadonlyArray<{ readonly entity: number; readonly offset: number }>;
  readonly joints: readonly SavedJoint2d[];
  /** Network-driven bodies (net clients). */
  readonly driven: readonly number[];
}

interface PreStep {
  readonly linvel: XY;
  readonly angvel: number;
  readonly userForce: XY;
  readonly com: XY;
}

type Kind = 'dynamic' | 'kinematic' | 'fixed';

interface Body {
  readonly entity: EntityId;
  /** Creation order: query results are sorted by it, so they never depend on tree layout. */
  readonly order: number;
  readonly body: RAPIER.RigidBody;
  kind: Kind;
  collider: RAPIER.Collider | undefined;
  rigidbodyFields: Fields | undefined;
  colliderFields: Fields | undefined;
  rigidbodyKey: string;
  colliderKey: string;
  /** The transform values this body last agreed with; a different object means the game moved it. */
  position: Vec3;
  rotation: Quat;
  /** The angular_velocity value last written to the component. */
  angularVelocity: unknown;
  /** A kinematic body's velocity: each step moves its transform by velocity × dt. */
  kinematicVelocity: Vec3;
  forced: boolean;
}

/** Touching collider pairs between two entities: events fire when the first starts and the last stops. */
interface Pair {
  count: number;
  readonly a: EntityId;
  readonly b: EntityId;
}

interface ColliderOwner {
  readonly entity: EntityId;
  readonly sensor: boolean;
  readonly layerBit: number;
  readonly material: string | null;
}

export interface Hit {
  readonly entity: unknown;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

export interface QueryFilter {
  /** Layer bit mask; 0 = every layer. */
  readonly layers: number;
  readonly ignore: ReadonlySet<EntityId>;
}

function key(values: readonly unknown[]): string {
  return values.map((v) => (v instanceof Vec3 ? `${v.x},${v.y},${v.z}` : Array.isArray(v) ? v.join('|') : String(v))).join(';');
}

function rigidbodyKey(fields: Fields): string {
  return key([fields['kind'], fields['mass'], fields['linear_damping'], fields['angular_damping'], fields['gravity_scale'],
    fields['lock_rotation'], fields['lock_axes'], fields['lock_rotation_axes'], fields['continuous']]);
}

function colliderKey(fields: Fields, scale: Vec3, mass: unknown, offset: number): string {
  return key([fields['shape'], fields['size'], fields['radius'], fields['height'], fields['offset'], fields['trigger'],
    fields['layer'], fields['collides_with'], fields['friction'], fields['bounce'], fields['material'], scale, mass, offset]);
}

function worldAngle(record: EntityRecord): number {
  return rad(record.transform.worldRotation().angle());
}

function where(record: EntityRecord, component: string): string {
  return `entity ${record.placedId ?? record.prefab ?? record.id} ${component}`;
}

export class Physics2dSim {
  /** Replaced by a fresh world on restore, so a restored run never depends on what came before. */
  world: RAPIER.World;
  readonly gravity: number;
  readonly #kernel: Kernel;
  readonly #layers: LayerTable;
  readonly #events: RAPIER.EventQueue;
  readonly #bodies = new Map<EntityId, Body>();
  /** Tilemaps with `collide`: one fixed body each, a box per run of solid cells; `key` = the fields it was built from. */
  readonly #tiles = new Map<EntityId, { body: RAPIER.RigidBody; colliders: RAPIER.Collider[]; key: string }>();
  readonly #owners = new Map<number, ColliderOwner>();
  /** Colliders removed since the last step, so their final stop events still name an entity. */
  readonly #retired = new Map<number, ColliderOwner>();
  readonly #pairs = new Map<string, Pair>();
  /** Entity angle = body angle + offset (radians; absent: 0). Kept across body rebuilds. */
  readonly #offsets = new Map<EntityId, number>();
  readonly #pre = new Map<EntityId, PreStep>();
  readonly #fieldEntities = new Set<EntityId>();
  /** Bodies whose pose replication owns: kinematic-follow, never integrated or pulled. */
  readonly #driven = new Set<EntityId>();
  readonly #materials: MaterialTable;
  readonly #joints: Joints2d;
  readonly poses: PoseHistory;
  #nextOrder = 0;

  constructor(kernel: Kernel, gravity: number, layers: LayerTable, materials: MaterialTable, interpolate: boolean) {
    const R = rapier();
    this.#kernel = kernel;
    this.#layers = layers;
    this.#materials = materials;
    this.gravity = gravity;
    this.world = new R.World({ x: 0, y: gravity });
    this.#events = new R.EventQueue(true);
    this.#joints = new Joints2d(this.#jointHost());
    this.poses = new PoseHistory(kernel, interpolate);
  }

  get joints(): Joints2d {
    return this.#joints;
  }

  /** The end of the fixed step's physics phase (after every plugin's 'physics' hook). */
  endStep(): void {
    this.poses.end();
  }

  // ── The fixed step ───────────────────────────────────────────────────────────

  get handles(): EntityHandles {
    return this.#kernel.handles;
  }

  step(dt: number): void {
    // New and removed entities arrive through the kernel's lifecycle; here, only bodies
    // whose components the game edited since the last step need re-syncing.
    for (const body of [...this.#bodies.values()]) {
      const record = this.#kernel.world.get(body.entity);
      if (record === undefined) this.#remove(body);
      else this.reconcile(record);
    }
    // Tilemaps too: rows, tiles or placement edited in place rebuild their colliders (#reconcileTiles keys on them).
    for (const [id] of this.#kernel.world.query([TILEMAP])) this.#reconcileTiles(this.#kernel.world.get(id)!);
    this.#joints.sync();
    this.poses.begin([...this.#bodies.values()].filter((b) => b.kind !== 'fixed').map((b) => b.entity));
    for (const body of this.#bodies.values()) this.#push(body, dt);
    applyFields(this.#fieldHost(), this.#fieldEntities);
    this.#joints.drive(dt);
    this.#capturePreStep();
    this.world.timestep = dt;
    this.world.step(this.#events);
    this.#joints.settle(dt);
    for (const body of this.#bodies.values()) {
      if (body.forced) {
        body.body.resetForces(false);
        body.body.resetTorques(false);
        body.forced = false;
      }
      this.#pull(body);
    }
    this.#drainEvents();
    this.#pre.clear();
    this.#retired.clear();
    this.#purgePairs();
  }

  /** Forget pairs whose entities are gone (their stop events were delivered this step). */
  #purgePairs(): void {
    const present = (e: EntityId): boolean => this.#bodies.has(e) || this.#tiles.has(e);
    for (const [k, pair] of this.#pairs) if (!present(pair.a) || !present(pair.b)) this.#pairs.delete(k);
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
      this.#reconcileTiles(record);
      this.#trackField(record);
    }
  }

  changed(record: EntityRecord): void {
    this.reconcile(record);
    this.#reconcileTiles(record);
    this.#trackField(record);
  }

  /** A tilemap's colliders, rebuilt when its grid, tiles, layer or placement changed. Fixed: a tilemap never moves by physics. */
  #reconcileTiles(record: EntityRecord): void {
    const tm = record.components.get(TILEMAP);
    const existing = this.#tiles.get(record.id);
    const p = record.transform.worldPosition();
    const angle = worldAngle(record);
    const key = tm === undefined || tm['collide'] !== true ? '' : JSON.stringify([tm['rows'], tm['tiles'], tm['tile_size'], tm['offset'], tm['layer'], tm['friction'], p.x, p.y, angle]);
    if (existing !== undefined && existing.key === key) return;
    if (existing !== undefined) {
      for (const c of existing.colliders) this.#retire(c);
      this.world.removeRigidBody(existing.body);
      this.#tiles.delete(record.id);
    }
    if (key === '') return;
    const R = rapier();
    const at = where(record, 'tilemap');
    const grid = tileGrid(tm!, at);
    const tiles = tm!['tiles'] as Readonly<Record<string, Fields>>;
    const layer = tm!['layer'] as string;
    const groups = this.#layers.groups(layer, [...this.#layers.names], `${at}.layer`);
    const layerBit = this.#layers.bit(layer, `${at}.layer`);
    const body = this.world.createRigidBody(new R.RigidBodyDesc(R.RigidBodyType.Fixed).setTranslation(p.x, p.y).setRotation(angle));
    const colliders: RAPIER.Collider[] = [];
    for (const run of solidRuns(grid, (k) => tiles[k]?.['solid'] !== false)) {
      const [x0] = cellCenter(grid, run.col, run.row);
      const [, y] = cellCenter(grid, run.col, run.row);
      const desc = R.ColliderDesc.cuboid(run.length * grid.width / 2, grid.height / 2)
        .setTranslation(x0 - grid.width / 2 + run.length * grid.width / 2, y)
        .setFriction(tm!['friction'] as number)
        .setCollisionGroups(groups)
        .setSolverGroups(groups)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
      const collider = this.world.createCollider(desc, body);
      this.#owners.set(collider.handle, { entity: record.id, sensor: false, layerBit, material: null });
      colliders.push(collider);
    }
    this.#tiles.set(record.id, { body, colliders, key });
  }

  #trackField(record: EntityRecord): void {
    if (record.components.has(FORCE_FIELD)) this.#fieldEntities.add(record.id);
    else this.#fieldEntities.delete(record.id);
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      const body = this.#bodies.get(record.id);
      if (body !== undefined) this.#remove(body);
      const tiles = this.#tiles.get(record.id);
      if (tiles !== undefined) {
        for (const c of tiles.colliders) this.#retire(c);
        this.world.removeRigidBody(tiles.body);
        this.#tiles.delete(record.id);
      }
      this.#offsets.delete(record.id);
      this.#fieldEntities.delete(record.id);
      this.#driven.delete(record.id);
    }
  }

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

  state(entity: EntityId): { kind: Kind; position: Vec3; angle: number; velocity: Vec3 } | undefined {
    const record = this.#kernel.world.get(entity);
    const body = record === undefined ? undefined : this.reconcile(record);
    if (body === undefined) return undefined;
    const p = body.body.translation();
    return {
      kind: body.kind,
      position: new Vec3(p.x, p.y, record!.transform.worldPosition().z),
      angle: deg(body.body.rotation() + this.offsetOf(entity)),
      velocity: this.velocity(entity),
    };
  }

  /** The box around the entity's Collider in its local frame (scale applied); undefined without one. */
  bounds(entity: EntityId): { center: Vec3; halfExtents: Vec3 } | undefined {
    const record = this.#kernel.world.get(entity);
    const col = record?.components.get(COLLIDER);
    if (record === undefined || col === undefined) return undefined;
    const s = record.transform.worldScale();
    const sx = Math.abs(s.x);
    const sy = Math.abs(s.y);
    const o = col['offset'] as Vec3;
    const center = new Vec3(o.x * sx, o.y * sy, 0);
    if (col['shape'] === 'box') {
      const size = col['size'] as Vec3;
      return { center, halfExtents: new Vec3(size.x * sx / 2, size.y * sy / 2, 0) };
    }
    const r = (col['radius'] as number) * (col['shape'] === 'circle' ? Math.max(sx, sy) : sx);
    return { center, halfExtents: new Vec3(r, col['shape'] === 'circle' ? r : (col['height'] as number) * sy / 2, 0) };
  }

  /** Free the Rapier world (its bodies, colliders, joints and controllers go with it) and the event queue. The sim is unusable after. */
  dispose(): void {
    this.world.free();
    this.#events.free();
  }

  snapshot(): SavedPhysics2d {
    return {
      motion: this.motion(),
      offsets: [...this.#offsets].map(([entity, offset]) => ({ entity: entity as number, offset })),
      joints: this.#joints.snapshot(),
      driven: [...this.#driven].map((e) => e as number),
    };
  }

  restore(saved: SavedPhysics2d): void {
    for (const body of [...this.#bodies.values()]) this.#remove(body);
    this.#joints.reset(saved.joints);
    this.world.free();
    this.world = new (rapier().World)({ x: 0, y: this.gravity });
    this.#tiles.clear(); // their bodies went with the old world; reconcileAll rebuilds them
    this.#owners.clear();
    this.#retired.clear();
    this.#pairs.clear();
    this.#events.clear();
    this.#offsets.clear();
    this.#driven.clear();
    for (const e of saved.driven) if (this.#kernel.world.isAlive(e as EntityId)) this.#driven.add(e as EntityId);
    this.poses.clear();
    for (const o of saved.offsets) if (this.#kernel.world.isAlive(o.entity as EntityId)) this.#offsets.set(o.entity as EntityId, o.offset);
    this.#fieldEntities.clear();
    for (const record of this.#kernel.world.live()) this.#trackField(record);
    this.restoreMotion(saved.motion);
  }

  /** Velocities Rapier holds, so a restore can put them back. */
  motion(): BodyMotion[] {
    return [...this.#bodies.values()]
      .filter((b) => b.kind !== 'fixed')
      .map((b) => {
        const v = b.kind === 'kinematic' ? b.kinematicVelocity : b.body.linvel();
        return { entity: b.entity, linvel: [v.x, v.y] as const, angvel: b.kind === 'kinematic' ? 0 : b.body.angvel() };
      });
  }

  /**
   * Rebuild every body from the restored world, then put velocities back. Positions,
   * velocities and contacts match the saved moment; Rapier's internal solver caches are
   * not saved, so a restored run is not bit-identical to an uninterrupted one.
   */
  restoreMotion(saved: readonly BodyMotion[]): void {
    for (const body of [...this.#bodies.values()]) this.#remove(body);
    this.reconcileAll();
    for (const m of saved) {
      const body = this.#bodies.get(m.entity as EntityId);
      if (body === undefined) continue;
      if (body.kind === 'kinematic') {
        body.kinematicVelocity = new Vec3(m.linvel[0], m.linvel[1], 0);
        continue;
      }
      body.body.setLinvel({ x: m.linvel[0], y: m.linvel[1] }, true);
      body.body.setAngvel(m.angvel, true);
    }
  }

  /** Bring every body in line with the world: create, update and remove. */
  reconcileAll(): void {
    for (const body of [...this.#bodies.values()]) {
      if (!this.#kernel.world.isAlive(body.entity)) this.#remove(body);
    }
    for (const record of this.#kernel.world.live()) {
      this.reconcile(record);
      this.#reconcileTiles(record);
    }
  }

  /** One entity's body, created or updated from its components now. Undefined if it has neither. */
  reconcile(record: EntityRecord): Body | undefined {
    const rb = record.components.get(RIGIDBODY);
    const col = record.components.get(COLLIDER);
    let body = this.#bodies.get(record.id);
    if (rb === undefined && col === undefined) {
      if (body !== undefined) this.#remove(body);
      return undefined;
    }
    const kind: Kind = rb === undefined ? 'fixed' : this.#driven.has(record.id) ? 'kinematic' : (rb['kind'] as Kind);
    if (body === undefined) {
      body = this.#create(record, kind);
    } else if (body.kind !== kind) {
      body.body.setBodyType(this.#bodyType(kind), true);
      body.kind = kind;
    }

    let massChanged = false;
    if (rb !== body.rigidbodyFields || (rb !== undefined && rigidbodyKey(rb) !== body.rigidbodyKey)) {
      body.rigidbodyFields = rb;
      body.rigidbodyKey = rb === undefined ? '' : rigidbodyKey(rb);
      if (rb !== undefined) this.#applyRigidbody(body, rb, record);
      massChanged = true;
    }
    if (rb !== undefined && rb['angular_velocity'] !== body.angularVelocity) {
      const value = rb['angular_velocity'] as Vec3;
      const locked = rb['lock_rotation'] === true || (rb['lock_axes'] as readonly string[]).includes('z')
        || ((rb['lock_rotation_axes'] ?? []) as readonly string[]).includes('z');
      if (body.kind === 'dynamic') body.body.setAngvel(locked ? 0 : rad(value.z), true);
      body.angularVelocity = value;
    }

    const scale = record.transform.worldScale();
    const mass = rb === undefined ? undefined : rb['mass'];
    const offset = this.offsetOf(record.id);
    if (col !== body.colliderFields || (col !== undefined && colliderKey(col, scale, mass, offset) !== body.colliderKey)) {
      if (body.collider !== undefined) this.#removeCollider(body);
      body.colliderFields = col;
      body.colliderKey = col === undefined ? '' : colliderKey(col, scale, mass, offset);
      if (col !== undefined) this.#attachCollider(body, col, scale, record);
      massChanged = true;
    }
    if (massChanged) this.#applyMass(body);
    return body;
  }

  /** The body of an entity that has a Rigidbody (component methods); reconciled first. */
  rigidbody(entity: EntityId): RAPIER.RigidBody {
    const record = this.#kernel.world.require(entity);
    const body = this.reconcile(record);
    return body!.body;
  }

  /**
   * How the body moves: Rapier's velocity, or for a kinematic body the velocity it was
   * given (when none, its motion over the last step: a body moved by its transform).
   */
  velocity(entity: EntityId): Vec3 {
    const body = this.reconcile(this.#kernel.world.require(entity))!;
    if (body.kind === 'kinematic' && !body.kinematicVelocity.__eq__(Vec3.ZERO)) return body.kinematicVelocity;
    const v = body.body.linvel();
    return new Vec3(v.x, v.y, 0);
  }

  /**
   * A kinematic body keeps the velocity it is given, and each step moves its transform by
   * velocity × dt (on top of any transform the game assigns).
   */
  setVelocity(entity: EntityId, v: XY): void {
    const body = this.reconcile(this.#kernel.world.require(entity))!;
    if (body.kind === 'kinematic') body.kinematicVelocity = new Vec3(v.x, v.y, 0);
    else body.body.setLinvel(v, true);
  }

  kindOf(entity: EntityId): Kind {
    return this.#bodies.get(entity)?.kind ?? 'fixed';
  }

  markForced(entity: EntityId): void {
    const body = this.#bodies.get(entity);
    if (body !== undefined) body.forced = true;
  }

  /** Move a body and its transform now, without sweeping through what lies between. */
  teleport(entity: EntityId, position: XY, angleDegrees: number | undefined, keepVelocity: boolean): void {
    const record = this.#kernel.world.require(entity);
    const body = this.reconcile(record)!;
    const t = record.transform;
    t.setWorldPosition(new Vec3(position.x, position.y, t.worldPosition().z));
    if (angleDegrees !== undefined) this.#setWorldAngle(record, rad(angleDegrees));
    const angle = worldAngle(record) - this.offsetOf(entity);
    body.body.setTranslation({ x: position.x, y: position.y }, true);
    body.body.setRotation(angle, true);
    if (body.kind === 'kinematic') {
      body.body.setNextKinematicTranslation({ x: position.x, y: position.y });
      body.body.setNextKinematicRotation(angle);
    }
    if (!keepVelocity && body.kind === 'kinematic') body.kinematicVelocity = Vec3.ZERO;
    if (!keepVelocity && body.kind === 'dynamic') {
      body.body.setLinvel({ x: 0, y: 0 }, true);
      body.body.setAngvel(0, true);
    }
    body.position = t.position;
    body.rotation = t.rotation;
    this.poses.snap(entity);
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  raycast(origin: XY, dir: XY, maxDistance: number, filter: QueryFilter): Hit | undefined {
    const R = rapier();
    const hit = this.world.castRayAndGetNormal(new R.Ray(origin, dir), maxDistance, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, this.#predicate(filter));
    if (hit === null) return undefined;
    return this.#hit(this.#owners.get(hit.collider.handle)!.entity, origin, dir, hit.timeOfImpact, hit.normal);
  }

  raycastAll(origin: XY, dir: XY, maxDistance: number, filter: QueryFilter): Hit[] {
    const R = rapier();
    const nearest = new Map<EntityId, Hit>();
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

  /** Entities whose colliders (triggers included) touch the shape, in body creation order. */
  overlap(center: XY, shape: RAPIER.Shape, filter: QueryFilter): EntityId[] {
    const found = new Set<EntityId>();
    this.world.intersectionsWithShape(center, 0, shape, (collider) => {
      found.add(this.#owners.get(collider.handle)!.entity);
      return true;
    }, undefined, undefined, undefined, undefined, this.#predicate(filter));
    return [...found].sort((a, b) => this.#order(a) - this.#order(b));
  }

  /** Push dynamic bodies in `entities` away from `center`, falling off linearly to 0 at `radius`. */
  explode(center: XY, radius: number, strength: number, entities: readonly EntityId[]): void {
    for (const entity of entities) {
      const body = this.#bodies.get(entity);
      if (body === undefined || body.kind !== 'dynamic') continue;
      const p = body.body.translation();
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const distance = Math.hypot(dx, dy);
      const falloff = Math.max(0, 1 - distance / radius);
      // A body exactly at the centre is pushed straight up.
      const [ux, uy] = distance === 0 ? [0, 1] : [dx / distance, dy / distance];
      body.body.applyImpulse({ x: ux * strength * falloff, y: uy * strength * falloff }, true);
    }
  }

  /** Sweep `shape` (at `angle` radians) from `origin` along unit `dir`: the first solid hit; `self` is left out. */
  shapecast(shape: RAPIER.Shape, origin: XY, angle: number, dir: XY, maxDistance: number, filter: QueryFilter, self?: EntityId): Hit | undefined {
    const R = rapier();
    const predicate = this.#predicate(filter);
    const hit = this.world.castShape(origin, angle, dir, shape, 0, maxDistance, true, R.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, undefined, undefined, (c) => this.#owners.get(c.handle)?.entity !== self && predicate(c));
    if (hit === null) return undefined;
    const n = hit.normal1;
    const length = Math.hypot(n.x, n.y) || 1;
    return {
      entity: this.#kernel.handles.wrap(this.#owners.get(hit.collider.handle)!.entity),
      point: new Vec3(hit.witness1.x, hit.witness1.y, 0),
      normal: new Vec3(n.x / length, n.y / length, 0),
      distance: hit.time_of_impact,
    };
  }

  /** The entity's own Collider shape and pose, for `sweep`. */
  colliderPose(entity: EntityId): { shape: RAPIER.Shape; position: XY; angle: number } | undefined {
    const body = this.reconcile(this.#kernel.world.require(entity));
    const collider = body?.collider;
    if (collider === undefined) return undefined;
    return { shape: collider.shape, position: collider.translation(), angle: collider.rotation() };
  }

  // ── Joint and field support ──────────────────────────────────────────────────

  offsetOf(entity: EntityId): number {
    return this.#offsets.get(entity) ?? 0;
  }

  setOffset(entity: EntityId, offset: number): void {
    this.#offsets.set(entity, offset);
    const record = this.#kernel.world.require(entity);
    const body = this.#bodies.get(entity);
    if (body === undefined) return;
    const angle = worldAngle(record) - offset;
    body.body.setRotation(angle, true);
    if (body.kind === 'kinematic') body.body.setNextKinematicRotation(angle);
    this.reconcile(record);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  /** Total contact impulse (N·s) the entity's solid collider received over the last step. */
  contactImpulse(entity: EntityId): XY {
    const body = this.#bodies.get(entity);
    const c = body?.collider;
    const sum = { x: 0, y: 0 };
    if (c === undefined || c.isSensor()) return sum;
    this.world.contactPairsWith(c, (other) => {
      this.world.contactPair(c, other, (manifold, flipped) => {
        const n = manifold.normal();
        let j = 0;
        for (let i = 0; i < manifold.numContacts(); i++) j += manifold.contactImpulse(i);
        const s = flipped ? j : -j;
        sum.x += n.x * s;
        sum.y += n.y * s;
      });
    });
    return sum;
  }

  #jointHost(): JointHost2d {
    const sim = this;
    return {
      get world() { return sim.world; },
      kernel: this.#kernel,
      bodyOf: (entity) => {
        const record = this.#kernel.world.get(entity);
        const body = record === undefined ? undefined : this.reconcile(record);
        return body === undefined ? undefined : { entity, body: body.body, kind: body.kind };
      },
      offsetOf: (entity) => this.offsetOf(entity),
      setOffset: (entity, offset) => this.setOffset(entity, offset),
      markForced: (entity) => this.markForced(entity),
      preStep: (entity) => this.#pre.get(entity),
      contactImpulse: (entity) => this.contactImpulse(entity),
      where,
    };
  }

  #fieldHost(): FieldHost2d {
    const target = (body: Body): FieldTarget2d => ({
      entity: body.entity, body: body.body,
      layerBit: body.collider === undefined ? 0 : this.#owners.get(body.collider.handle)?.layerBit ?? 0,
    });
    return {
      kernel: this.#kernel,
      world: this.world,
      layers: this.#layers,
      dynamicBodies: () => [...this.#bodies.values()].filter((b) => b.kind === 'dynamic').map(target),
      colliderOf: (entity) => this.#bodies.get(entity)?.collider,
      targetOf: (collider) => {
        const entity = this.#owners.get(collider.handle)?.entity;
        const body = entity === undefined ? undefined : this.#bodies.get(entity);
        return body === undefined || body.kind !== 'dynamic' ? undefined : target(body);
      },
      markForced: (entity) => this.markForced(entity),
      where,
    };
  }

  /** How fast two entities were closing along `normal` (from a to b) before the step, at `point`. */
  #closingSpeed(a: EntityId, b: EntityId, point: Vec3, normal: Vec3): number {
    const velocity = (entity: EntityId): XY => {
      const pre = this.#pre.get(entity);
      if (pre !== undefined) {
        const rx = point.x - pre.com.x;
        const ry = point.y - pre.com.y;
        return { x: pre.linvel.x - pre.angvel * ry, y: pre.linvel.y + pre.angvel * rx };
      }
      const body = this.#bodies.get(entity);
      return body?.kind === 'kinematic' ? body.kinematicVelocity : { x: 0, y: 0 };
    };
    const va = velocity(a);
    const vb = velocity(b);
    return Math.max(0, (va.x - vb.x) * normal.x + (va.y - vb.y) * normal.y);
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #order(entity: EntityId): number {
    return this.#bodies.get(entity)?.order ?? Number.MAX_SAFE_INTEGER;
  }

  #predicate(filter: QueryFilter): (collider: RAPIER.Collider) => boolean {
    return (collider) => {
      const owner = this.#owners.get(collider.handle);
      if (owner === undefined || !this.#kernel.world.isAlive(owner.entity)) return false;
      if (filter.ignore.has(owner.entity)) return false;
      return filter.layers === 0 || (filter.layers & owner.layerBit) !== 0;
    };
  }

  #hit(entity: EntityId, origin: XY, dir: XY, distance: number, normal: XY): Hit {
    return {
      entity: this.#kernel.handles.wrap(entity),
      point: new Vec3(origin.x + dir.x * distance, origin.y + dir.y * distance, 0),
      normal: new Vec3(normal.x, normal.y, 0),
      distance,
    };
  }

  #bodyType(kind: Kind): RAPIER.RigidBodyType {
    const R = rapier();
    if (kind === 'dynamic') return R.RigidBodyType.Dynamic;
    if (kind === 'kinematic') return R.RigidBodyType.KinematicPositionBased;
    return R.RigidBodyType.Fixed;
  }

  #create(record: EntityRecord, kind: Kind): Body {
    const R = rapier();
    const p = record.transform.worldPosition();
    const desc = new R.RigidBodyDesc(this.#bodyType(kind)).setTranslation(p.x, p.y).setRotation(worldAngle(record) - this.offsetOf(record.id));
    const body: Body = {
      entity: record.id,
      order: this.#nextOrder++,
      body: this.world.createRigidBody(desc),
      kind,
      collider: undefined,
      rigidbodyFields: undefined,
      colliderFields: undefined,
      rigidbodyKey: '',
      colliderKey: '',
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
    this.world.removeRigidBody(body.body);
    this.#bodies.delete(body.entity);
  }

  #retire(collider: RAPIER.Collider): void {
    const owner = this.#owners.get(collider.handle);
    if (owner !== undefined) this.#retired.set(collider.handle, owner);
    this.#owners.delete(collider.handle);
  }

  #removeCollider(body: Body): void {
    this.#retire(body.collider!);
    this.world.removeCollider(body.collider!, true);
    body.collider = undefined;
  }

  #applyRigidbody(body: Body, rb: Fields, record: EntityRecord): void {
    const where = `entity ${record.prefab ?? record.id} rigidbody`;
    const b = body.body;
    b.setLinearDamping(rb['linear_damping'] as number);
    b.setAngularDamping(rb['angular_damping'] as number);
    b.setGravityScale(rb['gravity_scale'] as number, true);
    const axes = rb['lock_axes'] as readonly string[];
    b.setEnabledTranslations(!axes.includes('x'), !axes.includes('y'), true);
    b.lockRotations(rb['lock_rotation'] === true || axes.includes('z') || ((rb['lock_rotation_axes'] ?? []) as readonly string[]).includes('z'), true);
    b.enableCcd(rb['continuous'] === true);
    const mass = rb['mass'] as number;
    if (!(mass > 0)) fail('PP3301', `${where}.mass is ${mass}; a body's mass must be above 0`);
  }

  /** Mass lives on the collider when there is one (so inertia follows its shape), else on the body. */
  #applyMass(body: Body): void {
    const rb = body.rigidbodyFields;
    if (rb === undefined) return;
    const mass = rb['mass'] as number;
    if (body.collider !== undefined) {
      body.body.setAdditionalMass(0, true);
      body.collider.setMass(mass);
    } else {
      body.body.setAdditionalMass(mass, true);
    }
    // Rapier would otherwise update mass at the next step, after an impulse given now.
    body.body.recomputeMassPropertiesFromColliders();
  }

  #attachCollider(body: Body, col: Fields, scale: Vec3, record: EntityRecord): void {
    const R = rapier();
    const where = `entity ${record.prefab ?? record.id} collider`;
    const sx = Math.abs(scale.x);
    const sy = Math.abs(scale.y);
    const positive = (value: number, name: string): number =>
      value > 0 ? value : fail('PP3302', `${where}.${name} is ${value} (after scale); it must be above 0`);
    let desc: RAPIER.ColliderDesc;
    const shape = col['shape'] as string;
    if (shape === 'box') {
      const size = col['size'] as Vec3;
      desc = R.ColliderDesc.cuboid(positive(size.x * sx, 'size.x') / 2, positive(size.y * sy, 'size.y') / 2);
    } else if (shape === 'circle') {
      desc = R.ColliderDesc.ball(positive((col['radius'] as number) * Math.max(sx, sy), 'radius'));
    } else {
      const radius = positive((col['radius'] as number) * sx, 'radius');
      const height = positive((col['height'] as number) * sy, 'height');
      if (height < 2 * radius) {
        fail('PP3303', `${where}: a capsule ${height} tall can't have radius ${radius}`, {
          fix: '`height` is the full height, end caps included: make it at least 2 × radius.',
        });
      }
      desc = R.ColliderDesc.capsule(height / 2 - radius, radius);
    }
    const offset = col['offset'] as Vec3;
    const trigger = col['trigger'] === true;
    const layer = col['layer'] as string;
    const groups = this.#layers.groups(layer, col['collides_with'] as readonly string[], where);
    const materialName = col['material'] as string | null;
    const material = materialName === null ? undefined : this.#materials.get(materialName, `${where}.material`);
    // The collider sits in the body's frame, which a joint may have turned from the entity's.
    const frame = this.offsetOf(body.entity);
    const ox = offset.x * sx;
    const oy = offset.y * sy;
    desc.setTranslation(ox * Math.cos(frame) - oy * Math.sin(frame), ox * Math.sin(frame) + oy * Math.cos(frame))
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
    this.#owners.set(collider.handle, { entity: body.entity, sensor: trigger, layerBit: this.#layers.bit(layer, where), material: materialName });
  }

  #push(body: Body, dt: number): void {
    const record = this.#kernel.world.get(body.entity)!;
    const t = record.transform;
    if (body.kind === 'kinematic') {
      if (!this.#driven.has(body.entity)) this.#integrateKinematic(body, record, dt);
      const p = t.worldPosition();
      body.body.setNextKinematicTranslation({ x: p.x, y: p.y });
      body.body.setNextKinematicRotation(worldAngle(record) - this.offsetOf(body.entity));
    } else if (t.position !== body.position || t.rotation !== body.rotation) {
      const p = t.worldPosition();
      body.body.setTranslation({ x: p.x, y: p.y }, true);
      body.body.setRotation(worldAngle(record) - this.offsetOf(body.entity), true);
    }
    body.position = t.position;
    body.rotation = t.rotation;
  }

  /** Move a kinematic body's transform by its velocity and angular_velocity.z (degrees per second). */
  #integrateKinematic(body: Body, record: EntityRecord, dt: number): void {
    const t = record.transform;
    const v = body.kinematicVelocity;
    if (v.x !== 0 || v.y !== 0) t.setWorldPosition(t.worldPosition().__add__(new Vec3(v.x * dt, v.y * dt, 0)));
    const w = record.components.get(RIGIDBODY)?.['angular_velocity'];
    if (w instanceof Vec3 && w.z !== 0) this.#setWorldAngle(record, worldAngle(record) + rad(w.z * dt));
  }

  #pull(body: Body): void {
    const record = this.#kernel.world.get(body.entity)!;
    const rb = record.components.get(RIGIDBODY);
    if (rb !== undefined && body.kind === 'dynamic') {
      const value = new Vec3(0, 0, deg(body.body.angvel()));
      rb['angular_velocity'] = value;
      body.angularVelocity = value;
    }
    if (body.kind !== 'dynamic') return;
    const t = record.transform;
    const p = body.body.translation();
    t.setWorldPosition(new Vec3(p.x, p.y, t.worldPosition().z));
    this.#setWorldAngle(record, body.body.rotation() + this.offsetOf(body.entity));
    body.position = t.position;
    body.rotation = t.rotation;
  }

  #setWorldAngle(record: EntityRecord, radians: number): void {
    const t = record.transform;
    const world = Quat.from_angle(deg(radians));
    t.rotation = t.parent === null ? world : t.parent.worldRotation().inverse().__mul__(world);
  }

  #drainEvents(): void {
    const emit = (type: EventDef, payload: Fields): void => {
      if (this.#kernel.world.isAlive(payload['entity'] as EntityId)) {
        this.#kernel.emit(type, { ...payload, entity: this.#kernel.handles.wrap(payload['entity'] as EntityId) });
      }
    };
    this.#events.drainCollisionEvents((h1, h2, started) => {
      const a = this.#owners.get(h1) ?? this.#retired.get(h1);
      const b = this.#owners.get(h2) ?? this.#retired.get(h2);
      if (a === undefined || b === undefined || a.entity === b.entity) return;
      if (a.sensor || b.sensor) {
        const type = started ? PHYSICS_EVENTS.triggerEntered : PHYSICS_EVENTS.triggerExited;
        if (a.sensor && this.#count(`t:${a.entity}:${b.entity}`, a.entity, b.entity, started)) {
          emit(type, { entity: a.entity, target: this.#kernel.handles.wrap(b.entity) });
        }
        if (b.sensor && this.#count(`t:${b.entity}:${a.entity}`, b.entity, a.entity, started)) {
          emit(type, { entity: b.entity, target: this.#kernel.handles.wrap(a.entity) });
        }
        return;
      }
      const [lo, hi] = a.entity < b.entity ? [a.entity, b.entity] : [b.entity, a.entity];
      if (!this.#count(`c:${lo}:${hi}`, lo, hi, started)) return;
      if (!started) {
        emit(PHYSICS_EVENTS.collisionEnded, { entity: a.entity, target: this.#kernel.handles.wrap(b.entity) });
        emit(PHYSICS_EVENTS.collisionEnded, { entity: b.entity, target: this.#kernel.handles.wrap(a.entity) });
        return;
      }
      const contact = this.#contact(h1, h2);
      emit(PHYSICS_EVENTS.collided, {
        entity: a.entity, target: this.#kernel.handles.wrap(b.entity), point: contact.point, normal: contact.normal.__neg__(), impulse: contact.impulse,
      });
      emit(PHYSICS_EVENTS.collided, {
        entity: b.entity, target: this.#kernel.handles.wrap(a.entity), point: contact.point, normal: contact.normal, impulse: contact.impulse,
      });
      if (a.material !== null || b.material !== null) {
        const speed = this.#closingSpeed(a.entity, b.entity, contact.point, contact.normal);
        const impact = (self: ColliderOwner, other: ColliderOwner, normal: Vec3): void => {
          if (self.material === null) return;
          const material = this.#materials.get(self.material, 'impact');
          if (speed < material.impact_speed) return;
          emit(IMPACT, {
            entity: self.entity, target: this.#kernel.handles.wrap(other.entity), point: contact.point, normal, speed,
            material: self.material, target_material: other.material, sound: material.sound,
          });
        };
        impact(a, b, contact.normal.__neg__());
        impact(b, a, contact.normal);
      }
    });
  }

  /**
   * The contact between two colliders after the step: the mean solver contact point, the
   * normal pointing from the first collider to the second, and the total normal impulse.
   */
  #contact(h1: number, h2: number): { point: Vec3; normal: Vec3; impulse: number } {
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    let sx = 0;
    let sy = 0;
    let points = 0;
    let nx = 0;
    let ny = 0;
    let impulse = 0;
    this.world.contactPair(c1, c2, (manifold, flipped) => {
      const n = manifold.normal();
      nx += flipped ? -n.x : n.x;
      ny += flipped ? -n.y : n.y;
      for (let i = 0; i < manifold.numSolverContacts(); i++) {
        const p = manifold.solverContactPoint(i);
        sx += p.x;
        sy += p.y;
        points++;
      }
      for (let i = 0; i < manifold.numContacts(); i++) impulse += manifold.contactImpulse(i);
    });
    const length = Math.hypot(nx, ny);
    if (points === 0 || length === 0) {
      // Rapier reported the start of a contact it resolved without solver contacts (a
      // speculative contact): the best point is between the two shapes' centres.
      const p1 = c1.translation();
      const p2 = c2.translation();
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      return {
        point: new Vec3((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, 0),
        normal: length === 0 ? new Vec3((p2.x - p1.x) / d, (p2.y - p1.y) / d, 0) : new Vec3(nx / length, ny / length, 0),
        impulse,
      };
    }
    return { point: new Vec3(sx / points, sy / points, 0), normal: new Vec3(nx / length, ny / length, 0), impulse };
  }
}
