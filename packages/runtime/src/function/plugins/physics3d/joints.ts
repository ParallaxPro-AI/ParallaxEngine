/**
 * Joints in 3D (the `joint` component, sdk/parallax/physics.pyi): a constraint between the
 * body of `body` (default: the joint's own entity) and `connected` (another entity, the
 * entity's parent with `to_parent`, or the world). Built on Rapier's impulse joints:
 *
 *   fixed   welded at the pose they have when built
 *   hinge   turns about `axis` (revolute), optional `limits` in degrees
 *   slider  moves along `axis` (prismatic), optional `limits` in meters
 *   ball    turns freely about the anchor (spherical)
 *   rope    at most `length` apart (a max-distance stop)
 *   spring  pulled towards `length` apart with `stiffness` N/m and `damping` N·s/m
 *
 * Zero is the pose at build. Rapier reads a hinge's or slider's axis in both bodies' local
 * frames, so both frames must agree when the joint is built: a world joint gets its own
 * fixed anchor body turned like the body; between two entities that are turned
 * differently, the body is given a rotation offset (its Rapier frame turned to match the
 * connected one, its colliders turned back), so nothing snaps. Angles and positions are
 * measured in those aligned frames.
 *
 * Motors are applied by the engine, as force/torque before each step: with `motor_target`
 * the joint servos to it (at most `motor_speed` fast, when given); with only `motor_speed`
 * it runs at that speed. `motor_max_force` (N·m for hinges, N for sliders) caps the effort
 * — a claw's grip, a winch's pull — and None means as much as it takes.
 *
 * Breaking: `break_force` (N) is compared with the joint's load every step, estimated from
 * how the body it holds moved: `m·Δv/dt` minus gravity, the forces applied to the body and
 * its contact impulses. A body held by several joints shares one estimate among them.
 * Rapier 0.19 exposes no joint impulse to read instead.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import { deg, fail, Quat, rad, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { EntityRecord, EventDef, Fields, FieldSpec, Kernel, Schema } from '../../kernel/index.js';
import type { BodyKind } from '../../services/index.js';
import { rapier } from './rapier.js';
import type { XYZ } from './values.js';

export const JOINT = 'joint';
export const JOINT_KINDS = ['fixed', 'hinge', 'slider', 'ball', 'rope', 'spring'] as const;
export type JointKind = typeof JOINT_KINDS[number];

/** Emitted on the joint's entity when it breaks under load (or loses one of its bodies). */
export const JOINT_BROKEN: EventDef = { id: 'joint_broken', target: 'entity' };

const optional = (of: FieldSpec['type']): FieldSpec => ({ type: { kind: 'optional', of }, default: null });

export const JOINT_SCHEMA: Schema = {
  kind: t.enum(JOINT_KINDS, { default: 'hinge' }),
  /** The body this joint holds; None: the joint's own entity. */
  body: optional({ kind: 'entity' }),
  /** What it is held to; None: the world (or the entity's parent with `to_parent`). */
  connected: optional({ kind: 'entity' }),
  to_parent: t.bool({ default: false }),
  /** In the body's local space (scale applies, as for Collider.offset). */
  anchor: t.vec3({ default: Vec3.ZERO }),
  /** In the connected entity's local space, or a world point; None: where `anchor` is when built (written back). */
  connected_anchor: optional({ kind: 'vec3' }),
  /** Hinge axis / slider direction, in the body's local space. */
  axis: t.vec3({ default: new Vec3(1, 0, 0) }),
  /** (min, max): degrees for a hinge, meters for a slider. */
  limits: optional({ kind: 'vec2' }),
  /** Rope: the most the anchors can be apart; spring: rest length. None: their distance when built (written back). */
  length: optional({ kind: 'number' }),
  stiffness: t.number({ default: 100, min: 0 }),
  damping: t.number({ default: 1, min: 0 }),
  /** Degrees (or meters) per second. */
  motor_speed: optional({ kind: 'number' }),
  /** Degrees (hinge) or meters (slider). */
  motor_target: optional({ kind: 'number' }),
  /** N·m (hinge) or N (slider); None: unlimited. */
  motor_max_force: optional({ kind: 'number' }),
  /** Newtons; None: unbreakable. */
  break_force: optional({ kind: 'number' }),
  collide_connected: t.bool({ default: false }),
  /** Set when the joint breaks; set it back to false to rebuild it. */
  broken: t.bool({ default: false }),
};

/** What the joint system needs from the simulation's bodies. */
export interface JointBody {
  readonly entity: EntityId;
  readonly body: RAPIER.RigidBody;
  readonly kind: BodyKind;
}

export interface JointHost {
  readonly world: RAPIER.World;
  readonly kernel: Kernel;
  /** The entity's body, reconciled now; undefined when it has none. */
  bodyOf(entity: EntityId): JointBody | undefined;
  /** Entity rotation = body rotation × offset. */
  offsetOf(entity: EntityId): Quat;
  setOffset(entity: EntityId, offset: Quat): void;
  /** The body has forces to clear after this step. */
  markForced(entity: EntityId): void;
  /** Velocities before the step (dynamic bodies), for load estimates. */
  preStep(entity: EntityId): { readonly linvel: XYZ; readonly userForce: XYZ } | undefined;
  /** Contact impulses on the entity's colliders over the last step (N·s, world). */
  contactImpulse(entity: EntityId): XYZ;
  where(record: EntityRecord, component: string): string;
}

interface Built {
  readonly key: string;
  readonly joint: RAPIER.ImpulseJoint;
  readonly kind: JointKind;
  readonly body: EntityId;
  readonly connected: EntityId | undefined;
  /** The fixed body standing in for the world, owned by this joint. */
  readonly anchorBody: RAPIER.RigidBody | undefined;
  /** body1 = connected (or the world anchor), body2 = the held body. */
  readonly body1: RAPIER.RigidBody;
  readonly body2: RAPIER.RigidBody;
  /** Anchors in each body's frame, and the axis (unit) in both. */
  readonly a1: XYZ;
  readonly a2: XYZ;
  readonly axis: XYZ;
  limitsKey: string;
  load: number;
}

/** Saved per joint: the world anchor body's rotation (zero of a world hinge/slider/weld). */
export interface SavedJoint {
  readonly entity: number;
  readonly frame: readonly number[];
}

const key = (values: readonly unknown[]): string =>
  values.map((v) => (v instanceof Vec3 ? `${v.x},${v.y},${v.z}` : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(';');

function vec(v: XYZ): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}

function quat(q: { x: number; y: number; z: number; w: number }): Quat {
  return new Quat(q.x, q.y, q.z, q.w);
}

/** The signed twist of a relative rotation about a unit axis, radians in (−π, π]. */
export function twist(rel: Quat, axis: XYZ): number {
  const along = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
  let angle = 2 * Math.atan2(along, rel.w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/** aᵀ·M·a for a symmetric 3×3 matrix given by its upper triangle. */
function quadratic(m: RAPIER.SdpMatrix3, a: XYZ): number {
  return m.m11 * a.x * a.x + m.m22 * a.y * a.y + m.m33 * a.z * a.z
    + 2 * (m.m12 * a.x * a.y + m.m13 * a.x * a.z + m.m23 * a.y * a.z);
}

export class Joints3d {
  readonly #host: JointHost;
  readonly #built = new Map<EntityId, Built>();
  /** World anchor rotations restored from a snapshot, consumed when each joint is rebuilt. */
  #frames = new Map<EntityId, Quat>();

  constructor(host: JointHost) {
    this.#host = host;
  }

  /** Build, rebuild, update and drop joints to match the world's `joint` components. */
  sync(): void {
    const kernel = this.#host.kernel;
    for (const [entity, built] of [...this.#built]) {
      const record = kernel.world.get(entity);
      if (record === undefined || !record.components.has(JOINT)) this.#drop(entity, built);
    }
    for (const record of kernel.world.live()) {
      const fields = record.components.get(JOINT);
      if (fields !== undefined) this.#sync(record, fields);
    }
  }

  /** Motor efforts for this step (call after sync, before the world steps). */
  drive(dt: number): void {
    const kernel = this.#host.kernel;
    for (const [entity, built] of this.#built) {
      const fields = kernel.world.get(entity)?.components.get(JOINT);
      if (fields === undefined || !built.joint.isValid()) continue;
      const speed = fields['motor_speed'] as number | null;
      const target = fields['motor_target'] as number | null;
      if (speed === null && target === null) continue;
      if (built.kind !== 'hinge' && built.kind !== 'slider') {
        const record = kernel.world.require(entity);
        fail('PP3186', `${this.#host.where(record, 'joint')} has a motor, but a ${built.kind} joint has nothing to drive`, {
          fix: 'Motors drive hinges (degrees) and sliders (meters); remove motor_speed/motor_target.',
        });
      }
      this.#drive(built, fields, speed, target, dt);
    }
  }

  /** After the step: loads, and joints that broke. */
  settle(dt: number): void {
    const kernel = this.#host.kernel;
    for (const [entity, built] of [...this.#built]) {
      const record = kernel.world.get(entity);
      const fields = record?.components.get(JOINT);
      if (record === undefined || fields === undefined) continue;
      if (!built.joint.isValid()) {
        // One of its bodies was removed (Rapier removes their joints with them).
        this.#remove(built);
        this.#built.delete(entity);
        this.#break(record, fields, built, 0);
        continue;
      }
      built.load = this.#load(built, dt);
      const limit = fields['break_force'] as number | null;
      if (limit !== null && built.load > limit) {
        this.#remove(built);
        this.#built.delete(entity);
        this.#break(record, fields, built, built.load);
      }
    }
  }

  // ── Readouts (component methods) ─────────────────────────────────────────────

  #require(entity: EntityId, what: string): Built | undefined {
    const record = this.#host.kernel.world.require(entity);
    const fields = record.components.get(JOINT)!;
    this.#sync(record, fields);
    const built = this.#built.get(entity);
    if (built === undefined && fields['broken'] !== true) {
      fail('PP3181', `${this.#host.where(record, 'joint')}.${what}: the joint isn't built`, { fix: 'Give the body and what it connects to a rigidbody or collider.' });
    }
    return built;
  }

  /** Hinge: degrees from the pose at build. Undefined while broken. */
  angle(entity: EntityId): number | undefined {
    const built = this.#require(entity, 'angle');
    if (built === undefined) return undefined;
    this.#expect(entity, built, 'hinge', 'angle');
    return deg(this.#coordinate(built));
  }

  /** Slider: meters from the pose at build. */
  position(entity: EntityId): number | undefined {
    const built = this.#require(entity, 'position');
    if (built === undefined) return undefined;
    this.#expect(entity, built, 'slider', 'position');
    return this.#coordinate(built);
  }

  /** Meters between the two anchors now. */
  distance(entity: EntityId): number | undefined {
    const built = this.#require(entity, 'distance');
    if (built === undefined) return undefined;
    const [p1, p2] = this.#anchors(built);
    return Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
  }

  /** The load estimate of the last step (N); 0 while broken. */
  load(entity: EntityId): number {
    return this.#require(entity, 'load')?.load ?? 0;
  }

  /** Break the joint now (no event: the game asked). */
  detach(entity: EntityId): void {
    const record = this.#host.kernel.world.require(entity);
    const fields = record.components.get(JOINT)!;
    const built = this.#built.get(entity);
    if (built !== undefined) {
      this.#remove(built);
      this.#built.delete(entity);
    }
    fields['broken'] = true;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): SavedJoint[] {
    return [...this.#built].filter(([, b]) => b.anchorBody !== undefined).map(([entity, b]) => {
      const q = b.anchorBody!.rotation();
      return { entity: entity as number, frame: [q.x, q.y, q.z, q.w] };
    });
  }

  /** Drop every joint (the bodies are being rebuilt); `saved` gives world anchors their frames back. */
  reset(saved: readonly SavedJoint[]): void {
    for (const built of this.#built.values()) this.#remove(built);
    this.#built.clear();
    this.#frames = new Map(saved.map((s) => [s.entity as EntityId, new Quat(s.frame[0]!, s.frame[1]!, s.frame[2]!, s.frame[3]!)]));
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #expect(entity: EntityId, built: Built, kind: JointKind, what: string): void {
    if (built.kind === kind) return;
    const record = this.#host.kernel.world.require(entity);
    fail('PP3186', `${this.#host.where(record, 'joint')}.${what} is for a ${kind} joint; this one is a ${built.kind}`, {
      fix: kind === 'hinge' ? 'Read `position` on sliders, `distance` on ropes and springs.' : 'Read `angle` on hinges, `distance` on ropes and springs.',
    });
  }

  #targets(record: EntityRecord, fields: Fields): { body: EntityId; connected: EntityId | undefined } {
    const handles = this.#host.kernel.handles;
    const at = this.#host.where(record, 'joint');
    const resolve = (value: unknown, name: string): EntityId | undefined => {
      if (value === null || value === undefined) return undefined;
      const id = handles.unwrap(value);
      if (id === undefined) fail('PP3181', `${at}.${name} must be an entity`, { fix: 'Name a placed entity, or leave it None.' });
      return id;
    };
    const body = resolve(fields['body'], 'body') ?? record.id;
    let connected = resolve(fields['connected'], 'connected');
    if (fields['to_parent'] === true) {
      if (connected !== undefined) fail('PP3181', `${at} sets both connected and to_parent`, { fix: 'Use one: to_parent connects to the entity\'s parent.' });
      const holder = this.#host.kernel.world.get(body);
      if (holder === undefined) return { body, connected: undefined };
      if (holder.parent === null) fail('PP3181', `${at} has to_parent, but its body has no parent entity`, { fix: 'Make it a child of what it hangs from, or name `connected`.' });
      connected = holder.parent;
    }
    if (connected === body) fail('PP3181', `${at} connects a body to itself`, { fix: 'Name another entity in `connected`, or leave it None for the world.' });
    return { body, connected };
  }

  #sync(record: EntityRecord, fields: Fields): void {
    const existing = this.#built.get(record.id);
    if (fields['broken'] === true) {
      if (existing !== undefined) {
        this.#remove(existing);
        this.#built.delete(record.id);
      }
      return;
    }
    const kind = fields['kind'] as JointKind;
    const { body, connected } = this.#targets(record, fields);
    const world = this.#host.kernel.world;
    if (!world.isAlive(body) || (connected !== undefined && !world.isAlive(connected))) {
      // What it held (or was held to) is gone: the joint breaks.
      if (existing !== undefined) {
        this.#remove(existing);
        this.#built.delete(record.id);
      }
      this.#break(record, fields, { body, connected }, 0);
      return;
    }
    const k = key([kind, body, connected ?? 'world', fields['anchor'], fields['connected_anchor'], fields['axis'], fields['length'],
      fields['stiffness'], fields['damping'], fields['collide_connected'], fields['limits'] === null]);
    if (existing !== undefined && existing.key === k && existing.joint.isValid()) {
      this.#applyLimits(existing, fields);
      return;
    }
    if (existing !== undefined) {
      this.#remove(existing);
      this.#built.delete(record.id);
    }
    const built = this.#build(record, fields, kind, body, connected);
    if (built !== undefined) this.#built.set(record.id, built);
  }

  #build(record: EntityRecord, fields: Fields, kind: JointKind, bodyId: EntityId, connectedId: EntityId | undefined): Built | undefined {
    const R = rapier();
    const host = this.#host;
    const kernel = host.kernel;
    const at = host.where(record, 'joint');
    const held = host.bodyOf(bodyId);
    if (held === undefined) {
      fail('PP3181', `${at}: its body has no physics body`, { fix: 'Give the joint\'s body a rigidbody (and a collider).' });
    }
    const other = connectedId === undefined ? undefined : host.bodyOf(connectedId);
    if (connectedId !== undefined && other === undefined) {
      fail('PP3181', `${at}: what it connects to has no physics body`, { fix: 'Give the connected entity a collider (static) or a rigidbody.' });
    }
    if (held.kind !== 'dynamic' && (other === undefined || other.kind !== 'dynamic')) {
      fail('PP3182', `${at} holds a ${held.kind} body to ${other === undefined ? 'the world' : `a ${other.kind} body`}; nothing can move`, {
        fix: 'At least one side of a joint must be a dynamic rigidbody.',
      });
    }
    const axisField = fields['axis'] as Vec3;
    if ((kind === 'hinge' || kind === 'slider') && axisField.length() === 0) {
      fail('PP3183', `${at}.axis is zero`, { fix: 'Give the hinge axis or slide direction, e.g. axis=vec3(0, 1, 0).' });
    }
    const unitAxis = axisField.length() === 0 ? new Vec3(1, 0, 0) : axisField.normalized();
    const needsFrame = kind === 'hinge' || kind === 'slider';

    // Align the two frames for a hinge or slider between entities turned differently.
    if (needsFrame && other !== undefined) this.#align(record, held, other);

    const heldRecord = kernel.world.require(bodyId);
    const scale = heldRecord.transform.worldScale();
    const anchor = fields['anchor'] as Vec3;
    const local2 = host.offsetOf(bodyId).rotate(new Vec3(anchor.x * scale.x, anchor.y * scale.y, anchor.z * scale.z));
    const q2 = quat(held.body.rotation());
    const p2 = vec(held.body.translation());
    const worldAnchor = p2.__add__(q2.rotate(local2));

    let connectedAnchor = fields['connected_anchor'] as Vec3 | null;
    if (connectedAnchor === null) {
      if (connectedId === undefined) {
        connectedAnchor = worldAnchor;
      } else {
        const c = kernel.world.require(connectedId).transform;
        const s = c.worldScale();
        const local = c.worldRotation().inverse().rotate(worldAnchor.__sub__(c.worldPosition()));
        connectedAnchor = new Vec3(local.x / s.x, local.y / s.y, local.z / s.z);
      }
      fields['connected_anchor'] = connectedAnchor;
    }

    let body1: RAPIER.RigidBody;
    let anchorBody: RAPIER.RigidBody | undefined;
    let local1: Vec3;
    if (other === undefined) {
      const frame = this.#frames.get(record.id) ?? (needsFrame || kind === 'fixed' ? q2 : Quat.IDENTITY);
      this.#frames.delete(record.id);
      anchorBody = host.world.createRigidBody(R.RigidBodyDesc.fixed()
        .setTranslation(connectedAnchor.x, connectedAnchor.y, connectedAnchor.z).setRotation(frame));
      body1 = anchorBody;
      local1 = Vec3.ZERO;
    } else {
      body1 = other.body;
      const c = kernel.world.require(other.entity).transform;
      const s = c.worldScale();
      local1 = host.offsetOf(other.entity).rotate(new Vec3(connectedAnchor.x * s.x, connectedAnchor.y * s.y, connectedAnchor.z * s.z));
    }

    let length = fields['length'] as number | null;
    if ((kind === 'rope' || kind === 'spring') && length === null) {
      const p1 = vec(body1.translation()).__add__(quat(body1.rotation()).rotate(local1));
      length = p1.__sub__(worldAnchor).length();
      fields['length'] = length;
    }
    if (length !== null && !(length >= 0)) fail('PP3183', `${at}.length is ${length}; it can't be negative`);

    // The axis in the body's (aligned) frame — the same vector in body1's frame.
    const axis = host.offsetOf(bodyId).rotate(unitAxis);
    let data: RAPIER.JointData;
    switch (kind) {
      case 'fixed': {
        const q1 = quat(body1.rotation());
        data = R.JointData.fixed(local1, q1.inverse().__mul__(q2), local2, Quat.IDENTITY);
        break;
      }
      case 'hinge':
        data = R.JointData.revolute(local1, local2, axis);
        break;
      case 'slider':
        data = R.JointData.prismatic(local1, local2, axis);
        break;
      case 'ball':
        data = R.JointData.spherical(local1, local2);
        break;
      case 'rope':
        data = R.JointData.rope(length!, local1, local2);
        break;
      case 'spring':
        data = R.JointData.spring(length!, fields['stiffness'] as number, fields['damping'] as number, local1, local2);
        break;
    }
    const joint = host.world.createImpulseJoint(data, body1, held.body, true);
    joint.setContactsEnabled(fields['collide_connected'] === true);
    const built: Built = {
      key: key([kind, bodyId, connectedId ?? 'world', fields['anchor'], fields['connected_anchor'], fields['axis'], fields['length'],
        fields['stiffness'], fields['damping'], fields['collide_connected'], fields['limits'] === null]),
      joint, kind, body: bodyId, connected: connectedId, anchorBody, body1, body2: held.body,
      a1: local1, a2: local2, axis, limitsKey: '', load: 0,
    };
    this.#applyLimits(built, fields);
    return built;
  }

  /** Give one side a rotation offset so the two bodies' frames coincide now. */
  #align(record: EntityRecord, held: JointBody, other: JointBody): void {
    const q1 = quat(other.body.rotation());
    const q2 = quat(held.body.rotation());
    if (q1.is_close(q2, 1e-9)) return;
    const host = this.#host;
    const free = (entity: EntityId): boolean => host.offsetOf(entity).is_close(Quat.IDENTITY, 1e-12);
    const entityRotation = (b: JointBody): Quat => quat(b.body.rotation()).__mul__(host.offsetOf(b.entity));
    if (free(held.entity)) {
      host.setOffset(held.entity, q1.inverse().__mul__(entityRotation(held)));
    } else if (free(other.entity)) {
      host.setOffset(other.entity, q2.inverse().__mul__(entityRotation(other)));
    } else {
      fail('PP3184', `${host.where(record, 'joint')} joins two bodies already aligned to other joints, and they are turned differently`, {
        fix: 'Build the hinge or slider with both bodies turned the same way (rotate a child visual instead), or use a ball joint.',
      });
    }
  }

  #applyLimits(built: Built, fields: Fields): void {
    if (built.kind !== 'hinge' && built.kind !== 'slider') {
      if (fields['limits'] !== null) {
        const record = this.#host.kernel.world.require(built.body);
        fail('PP3185', `${this.#host.where(record, 'joint')} has limits, but a ${built.kind} joint has no free coordinate to limit`, {
          fix: 'Limits are for hinges (degrees) and sliders (meters). A rope limits distance with `length`.',
        });
      }
      return;
    }
    const limits = fields['limits'] as { x: number; y: number } | null;
    const k = limits === null ? '' : `${limits.x},${limits.y}`;
    if (k === built.limitsKey) return;
    built.limitsKey = k;
    if (limits === null) return;
    if (!(limits.x <= limits.y)) {
      const record = this.#host.kernel.world.require(built.body);
      fail('PP3185', `${this.#host.where(record, 'joint')}.limits is (${limits.x}, ${limits.y}); min is above max`, { fix: 'Give (min, max).' });
    }
    const scale = built.kind === 'hinge' ? rad(1) : 1;
    (built.joint as RAPIER.UnitImpulseJoint).setLimits(limits.x * scale, limits.y * scale);
  }

  /** World anchors of body1 and body2. */
  #anchors(built: Built): [Vec3, Vec3] {
    const p1 = vec(built.body1.translation()).__add__(quat(built.body1.rotation()).rotate(vec(built.a1)));
    const p2 = vec(built.body2.translation()).__add__(quat(built.body2.rotation()).rotate(vec(built.a2)));
    return [p1, p2];
  }

  /** Hinge angle (radians) or slider position (meters) from the pose at build. */
  #coordinate(built: Built): number {
    const q1 = quat(built.body1.rotation());
    if (built.kind === 'hinge') return twist(q1.inverse().__mul__(quat(built.body2.rotation())), built.axis);
    const [p1, p2] = this.#anchors(built);
    const axis = q1.rotate(vec(built.axis));
    return p2.__sub__(p1).dot(axis);
  }

  #drive(built: Built, fields: Fields, speed: number | null, target: number | null, dt: number): void {
    const b1 = built.body1;
    const b2 = built.body2;
    const dyn1 = b1.isDynamic();
    const dyn2 = b2.isDynamic();
    const axis = quat(b1.rotation()).rotate(vec(built.axis));
    const hinge = built.kind === 'hinge';
    const [, p2] = this.#anchors(built);
    const unit = hinge ? rad(1) : 1;
    let velocity: number;
    let invMass: number;
    if (hinge) {
      const w1 = b1.angvel();
      const w2 = b2.angvel();
      velocity = (w2.x - w1.x) * axis.x + (w2.y - w1.y) * axis.y + (w2.z - w1.z) * axis.z;
      // Each body turns about the pivot: its inertia about the axis there (parallel axes).
      const about = (b: RAPIER.RigidBody): number => {
        const c = b.worldCom();
        const r = new Vec3(p2.x - c.x, p2.y - c.y, p2.z - c.z);
        return quadratic(b.effectiveAngularInertia(), axis) + b.mass() * axis.cross(r).length_squared();
      };
      invMass = (dyn1 ? 1 / about(b1) : 0) + (dyn2 ? 1 / about(b2) : 0);
    } else {
      const v1 = b1.velocityAtPoint(p2);
      const v2 = b2.velocityAtPoint(p2);
      velocity = (v2.x - v1.x) * axis.x + (v2.y - v1.y) * axis.y + (v2.z - v1.z) * axis.z;
      invMass = (dyn1 ? b1.invMass() : 0) + (dyn2 ? b2.invMass() : 0);
    }
    if (!(invMass > 0)) return;
    const maxSpeed = speed === null ? Infinity : Math.abs(speed) * unit;
    let desired: number;
    if (target === null) {
      desired = speed! * unit;
    } else {
      // A servo: close the gap over a few steps, no faster than motor_speed.
      const gap = target * unit - this.#coordinate(built);
      desired = Math.max(-maxSpeed, Math.min(maxSpeed, gap / (4 * dt)));
    }
    const limit = fields['motor_max_force'] as number | null;
    let effort = (desired - velocity) / invMass / dt;
    if (limit !== null) effort = Math.max(-limit, Math.min(limit, effort));
    const f = { x: axis.x * effort, y: axis.y * effort, z: axis.z * effort };
    const minus = { x: -f.x, y: -f.y, z: -f.z };
    if (hinge) {
      if (dyn2) b2.addTorque(f, true);
      if (dyn1) b1.addTorque(minus, true);
    } else {
      if (dyn2) b2.addForceAtPoint(f, p2, true);
      if (dyn1) b1.addForceAtPoint(minus, p2, true);
    }
    if (dyn2) this.#host.markForced(built.body);
    if (dyn1 && built.connected !== undefined) this.#host.markForced(built.connected);
  }

  /** The force (N) the joint exerted on the dynamic body it holds, over the last step. */
  #load(built: Built, dt: number): number {
    const host = this.#host;
    const pick = built.body2.isDynamic() ? { body: built.body2, entity: built.body }
      : built.connected !== undefined && built.body1.isDynamic() ? { body: built.body1, entity: built.connected } : undefined;
    if (pick === undefined) return 0;
    const before = host.preStep(pick.entity);
    if (before === undefined) return 0;
    const m = pick.body.mass();
    const v = pick.body.linvel();
    const g = host.world.gravity;
    const gs = pick.body.gravityScale();
    const c = pick.body.linearDamping();
    const j = host.contactImpulse(pick.entity);
    const damp = c / (1 + dt * c);
    const component = (dv: number, gravity: number, user: number, contact: number, v0: number): number =>
      m * dv / dt - m * gravity * gs - user - contact / dt + m * damp * v0;
    const fx = component(v.x - before.linvel.x, g.x, before.userForce.x, j.x, before.linvel.x);
    const fy = component(v.y - before.linvel.y, g.y, before.userForce.y, j.y, before.linvel.y);
    const fz = component(v.z - before.linvel.z, g.z, before.userForce.z, j.z, before.linvel.z);
    return Math.hypot(fx, fy, fz);
  }

  #break(record: EntityRecord, fields: Fields, built: Pick<Built, 'body' | 'connected'>, force: number): void {
    fields['broken'] = true;
    const kernel = this.#host.kernel;
    const alive = (id: EntityId | undefined): unknown => (id === undefined || !kernel.world.isAlive(id) ? null : kernel.handles.wrap(id));
    kernel.emit(JOINT_BROKEN, { entity: kernel.handles.wrap(record.id), body: alive(built.body), connected: alive(built.connected), force });
  }

  #drop(entity: EntityId, built: Built): void {
    this.#remove(built);
    this.#built.delete(entity);
  }

  #remove(built: Built): void {
    const world = this.#host.world;
    if (built.joint.isValid()) world.removeImpulseJoint(built.joint, true);
    if (built.anchorBody !== undefined) world.removeRigidBody(built.anchorBody);
  }
}
