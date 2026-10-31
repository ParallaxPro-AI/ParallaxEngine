/**
 * Joints in 2D (the `joint` component, sdk/parallax/physics.pyi): a constraint between the
 * body of `body` (default: the joint's own entity) and `connected` (another entity, the
 * entity's parent with `to_parent`, or the world), on Rapier 2D's impulse joints. The same
 * component and field names as physics3d's:
 *
 *   fixed   welded at the pose they have when built
 *   hinge   turns about the anchor (revolute), optional `limits` in degrees
 *   slider  moves along `axis` (prismatic, x/y used), optional `limits` in meters
 *   rope    at most `length` apart
 *   spring  pulled towards `length` apart with `stiffness` N/m and `damping` N·s/m
 *
 * ("ball" is a 3D joint: in 2D a hinge already turns freely.) Zero is the pose at build:
 * a world joint gets its own fixed anchor body turned like the body, and between two
 * bodies at different angles the body's Rapier frame is turned to match (an angle offset;
 * its colliders are turned back), since Rapier reads a slider's axis — and a hinge's zero —
 * in both frames.
 *
 * Motors (`motor_speed`, `motor_target`, `motor_max_force`) and breaking (`break_force`,
 * estimated from how the held body moved) work as in physics3d.
 */

import type RAPIER from '@dimforge/rapier2d-compat';
import { deg, fail, rad, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { EntityRecord, EventDef, Fields, FieldSpec, Kernel, Schema } from '../../kernel/index.js';
import { rapier } from './rapier.js';
import type { XY } from './values.js';

export const JOINT = 'joint';
export const JOINT_KINDS_2D = ['fixed', 'hinge', 'slider', 'rope', 'spring'] as const;
type JointKind = typeof JOINT_KINDS_2D[number];

export const JOINT_BROKEN: EventDef = { id: 'joint_broken', target: 'entity' };

const optional = (of: FieldSpec['type']): FieldSpec => ({ type: { kind: 'optional', of }, default: null });

/** The SDK's Joint fields (the kind list is the shared one; "ball" is refused in 2D with a fix). */
export const JOINT_SCHEMA: Schema = {
  kind: t.enum([...JOINT_KINDS_2D, 'ball'], { default: 'hinge' }),
  body: optional({ kind: 'entity' }),
  connected: optional({ kind: 'entity' }),
  to_parent: t.bool({ default: false }),
  anchor: t.vec3({ default: Vec3.ZERO }),
  connected_anchor: optional({ kind: 'vec3' }),
  axis: t.vec3({ default: new Vec3(1, 0, 0) }),
  limits: optional({ kind: 'vec2' }),
  length: optional({ kind: 'number' }),
  stiffness: t.number({ default: 100, min: 0 }),
  damping: t.number({ default: 1, min: 0 }),
  motor_speed: optional({ kind: 'number' }),
  motor_target: optional({ kind: 'number' }),
  motor_max_force: optional({ kind: 'number' }),
  break_force: optional({ kind: 'number' }),
  collide_connected: t.bool({ default: false }),
  broken: t.bool({ default: false }),
};

export interface JointBody2d {
  readonly entity: EntityId;
  readonly body: RAPIER.RigidBody;
  readonly kind: 'dynamic' | 'kinematic' | 'fixed';
}

export interface JointHost2d {
  readonly world: RAPIER.World;
  readonly kernel: Kernel;
  bodyOf(entity: EntityId): JointBody2d | undefined;
  /** Entity angle = body angle + offset (radians). */
  offsetOf(entity: EntityId): number;
  setOffset(entity: EntityId, radians: number): void;
  markForced(entity: EntityId): void;
  preStep(entity: EntityId): { readonly linvel: XY; readonly userForce: XY } | undefined;
  contactImpulse(entity: EntityId): XY;
  where(record: EntityRecord, component: string): string;
}

interface Built {
  readonly key: string;
  readonly joint: RAPIER.ImpulseJoint;
  readonly kind: JointKind;
  readonly body: EntityId;
  readonly connected: EntityId | undefined;
  readonly anchorBody: RAPIER.RigidBody | undefined;
  readonly body1: RAPIER.RigidBody;
  readonly body2: RAPIER.RigidBody;
  readonly a1: XY;
  readonly a2: XY;
  /** Unit slide direction in both (aligned) body frames. */
  readonly axis: XY;
  limitsKey: string;
  load: number;
}

export interface SavedJoint2d {
  readonly entity: number;
  /** The world anchor body's angle (radians). */
  readonly frame: number;
}

const key = (values: readonly unknown[]): string =>
  values.map((v) => (v instanceof Vec3 ? `${v.x},${v.y},${v.z}` : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(';');

function rotate(v: XY, angle: number): XY {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function wrap(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

export class Joints2d {
  readonly #host: JointHost2d;
  readonly #built = new Map<EntityId, Built>();
  #frames = new Map<EntityId, number>();

  constructor(host: JointHost2d) {
    this.#host = host;
  }

  sync(): void {
    const kernel = this.#host.kernel;
    for (const [entity, built] of [...this.#built]) {
      const record = kernel.world.get(entity);
      if (record === undefined || !record.components.has(JOINT)) {
        this.#remove(built);
        this.#built.delete(entity);
      }
    }
    for (const record of kernel.world.live()) {
      const fields = record.components.get(JOINT);
      if (fields !== undefined) this.#sync(record, fields);
    }
  }

  drive(dt: number): void {
    const kernel = this.#host.kernel;
    for (const [entity, built] of this.#built) {
      const fields = kernel.world.get(entity)?.components.get(JOINT);
      if (fields === undefined || !built.joint.isValid()) continue;
      const speed = fields['motor_speed'] as number | null;
      const target = fields['motor_target'] as number | null;
      if (speed === null && target === null) continue;
      if (built.kind !== 'hinge' && built.kind !== 'slider') {
        fail('PP3186', `${this.#host.where(kernel.world.require(entity), 'joint')} has a motor, but a ${built.kind} joint has nothing to drive`, {
          fix: 'Motors drive hinges (degrees) and sliders (meters); remove motor_speed/motor_target.',
        });
      }
      this.#drive(built, fields, speed, target, dt);
    }
  }

  settle(dt: number): void {
    const kernel = this.#host.kernel;
    for (const [entity, built] of [...this.#built]) {
      const record = kernel.world.get(entity);
      const fields = record?.components.get(JOINT);
      if (record === undefined || fields === undefined) continue;
      if (!built.joint.isValid()) {
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

  #expect(entity: EntityId, built: Built, kind: JointKind, what: string): void {
    if (built.kind === kind) return;
    fail('PP3186', `${this.#host.where(this.#host.kernel.world.require(entity), 'joint')}.${what} is for a ${kind} joint; this one is a ${built.kind}`);
  }

  angle(entity: EntityId): number | undefined {
    const built = this.#require(entity, 'angle');
    if (built === undefined) return undefined;
    this.#expect(entity, built, 'hinge', 'angle');
    return deg(this.#coordinate(built));
  }

  position(entity: EntityId): number | undefined {
    const built = this.#require(entity, 'position');
    if (built === undefined) return undefined;
    this.#expect(entity, built, 'slider', 'position');
    return this.#coordinate(built);
  }

  distance(entity: EntityId): number | undefined {
    const built = this.#require(entity, 'distance');
    if (built === undefined) return undefined;
    const [p1, p2] = this.#anchors(built);
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  load(entity: EntityId): number {
    return this.#require(entity, 'load')?.load ?? 0;
  }

  detach(entity: EntityId): void {
    const fields = this.#host.kernel.world.require(entity).components.get(JOINT)!;
    const built = this.#built.get(entity);
    if (built !== undefined) {
      this.#remove(built);
      this.#built.delete(entity);
    }
    fields['broken'] = true;
  }

  snapshot(): SavedJoint2d[] {
    return [...this.#built].filter(([, b]) => b.anchorBody !== undefined).map(([entity, b]) => ({ entity: entity as number, frame: b.anchorBody!.rotation() }));
  }

  reset(saved: readonly SavedJoint2d[]): void {
    for (const built of this.#built.values()) this.#remove(built);
    this.#built.clear();
    this.#frames = new Map(saved.map((s) => [s.entity as EntityId, s.frame]));
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
    const kind = fields['kind'] as JointKind | 'ball';
    if (kind === 'ball') {
      fail('PP3187', `${this.#host.where(record, 'joint')} is a "ball" joint, which is 3D`, { fix: 'In 2D a "hinge" turns freely about its anchor.' });
    }
    const { body, connected } = this.#targets(record, fields);
    const world = this.#host.kernel.world;
    if (!world.isAlive(body) || (connected !== undefined && !world.isAlive(connected))) {
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
    this.#built.set(record.id, this.#build(record, fields, kind, body, connected, k));
  }

  #build(record: EntityRecord, fields: Fields, kind: JointKind, bodyId: EntityId, connectedId: EntityId | undefined, k: string): Built {
    const R = rapier();
    const host = this.#host;
    const kernel = host.kernel;
    const at = host.where(record, 'joint');
    const held = host.bodyOf(bodyId);
    if (held === undefined) fail('PP3181', `${at}: its body has no physics body`, { fix: 'Give the joint\'s body a rigidbody (and a collider).' });
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
    if (kind === 'slider' && Math.hypot(axisField.x, axisField.y) === 0) {
      fail('PP3183', `${at}.axis has no x/y direction`, { fix: 'Give the slide direction in the plane, e.g. axis=vec3(1, 0, 0).' });
    }
    const aligned = kind === 'hinge' || kind === 'slider';
    if (aligned && other !== undefined) this.#align(record, held, other);

    const heldRecord = kernel.world.require(bodyId);
    const scale = heldRecord.transform.worldScale();
    const anchor = fields['anchor'] as Vec3;
    const local2 = rotate({ x: anchor.x * scale.x, y: anchor.y * scale.y }, host.offsetOf(bodyId));
    const p2 = held.body.translation();
    const worldAnchor = { x: p2.x, y: p2.y };
    const turned = rotate(local2, held.body.rotation());
    worldAnchor.x += turned.x;
    worldAnchor.y += turned.y;

    let connectedAnchor = fields['connected_anchor'] as Vec3 | null;
    if (connectedAnchor === null) {
      if (connectedId === undefined) {
        connectedAnchor = new Vec3(worldAnchor.x, worldAnchor.y, 0);
      } else {
        const c = kernel.world.require(connectedId).transform;
        const local = c.toLocal(new Vec3(worldAnchor.x, worldAnchor.y, c.worldPosition().z));
        connectedAnchor = new Vec3(local.x, local.y, 0);
      }
      fields['connected_anchor'] = connectedAnchor;
    }

    let body1: RAPIER.RigidBody;
    let anchorBody: RAPIER.RigidBody | undefined;
    let local1: XY;
    if (other === undefined) {
      const frame = this.#frames.get(record.id) ?? (aligned || kind === 'fixed' ? held.body.rotation() : 0);
      this.#frames.delete(record.id);
      anchorBody = host.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(connectedAnchor.x, connectedAnchor.y).setRotation(frame));
      body1 = anchorBody;
      local1 = { x: 0, y: 0 };
    } else {
      body1 = other.body;
      const s = kernel.world.require(other.entity).transform.worldScale();
      local1 = rotate({ x: connectedAnchor.x * s.x, y: connectedAnchor.y * s.y }, host.offsetOf(other.entity));
    }

    let length = fields['length'] as number | null;
    if ((kind === 'rope' || kind === 'spring') && length === null) {
      const p1 = body1.translation();
      const r1 = rotate(local1, body1.rotation());
      length = Math.hypot(p1.x + r1.x - worldAnchor.x, p1.y + r1.y - worldAnchor.y);
      fields['length'] = length;
    }
    if (length !== null && !(length >= 0)) fail('PP3183', `${at}.length is ${length}; it can't be negative`);

    const unit = Math.hypot(axisField.x, axisField.y) === 0 ? { x: 1, y: 0 } : new Vec2(axisField.x, axisField.y).normalized();
    const axis = rotate({ x: unit.x, y: unit.y }, host.offsetOf(bodyId));
    let data: RAPIER.JointData;
    switch (kind) {
      case 'fixed':
        data = R.JointData.fixed(local1, held.body.rotation() - body1.rotation(), local2, 0);
        break;
      case 'hinge':
        data = R.JointData.revolute(local1, local2);
        break;
      case 'slider':
        data = R.JointData.prismatic(local1, local2, axis);
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
      key: k, joint, kind, body: bodyId, connected: connectedId, anchorBody, body1, body2: held.body,
      a1: local1, a2: local2, axis, limitsKey: '', load: 0,
    };
    this.#applyLimits(built, fields);
    return built;
  }

  /** Give one side an angle offset so both bodies' frames have the same angle now. */
  #align(record: EntityRecord, held: JointBody2d, other: JointBody2d): void {
    const a1 = other.body.rotation();
    const a2 = held.body.rotation();
    if (Math.abs(wrap(a1 - a2)) < 1e-9) return;
    const host = this.#host;
    if (host.offsetOf(held.entity) === 0) {
      host.setOffset(held.entity, a2 - a1);
    } else if (host.offsetOf(other.entity) === 0) {
      host.setOffset(other.entity, a1 - a2);
    } else {
      fail('PP3184', `${host.where(record, 'joint')} joins two bodies already aligned to other joints, and they are turned differently`, {
        fix: 'Build the hinge or slider with both bodies at the same angle (rotate a child visual instead).',
      });
    }
  }

  #applyLimits(built: Built, fields: Fields): void {
    const limits = fields['limits'] as Vec2 | null;
    if (built.kind !== 'hinge' && built.kind !== 'slider') {
      if (limits !== null) {
        fail('PP3185', `${this.#host.where(this.#host.kernel.world.require(built.body), 'joint')} has limits, but a ${built.kind} joint has no free coordinate to limit`, {
          fix: 'Limits are for hinges (degrees) and sliders (meters). A rope limits distance with `length`.',
        });
      }
      return;
    }
    const k = limits === null ? '' : `${limits.x},${limits.y}`;
    if (k === built.limitsKey) return;
    built.limitsKey = k;
    if (limits === null) return;
    if (!(limits.x <= limits.y)) {
      fail('PP3185', `${this.#host.where(this.#host.kernel.world.require(built.body), 'joint')}.limits is (${limits.x}, ${limits.y}); min is above max`, { fix: 'Give (min, max).' });
    }
    const scale = built.kind === 'hinge' ? rad(1) : 1;
    (built.joint as RAPIER.UnitImpulseJoint).setLimits(limits.x * scale, limits.y * scale);
  }

  #anchors(built: Built): [XY, XY] {
    const p1 = built.body1.translation();
    const p2 = built.body2.translation();
    const r1 = rotate(built.a1, built.body1.rotation());
    const r2 = rotate(built.a2, built.body2.rotation());
    return [{ x: p1.x + r1.x, y: p1.y + r1.y }, { x: p2.x + r2.x, y: p2.y + r2.y }];
  }

  #coordinate(built: Built): number {
    if (built.kind === 'hinge') return wrap(built.body2.rotation() - built.body1.rotation());
    const [p1, p2] = this.#anchors(built);
    const axis = rotate(built.axis, built.body1.rotation());
    return (p2.x - p1.x) * axis.x + (p2.y - p1.y) * axis.y;
  }

  #drive(built: Built, fields: Fields, speed: number | null, target: number | null, dt: number): void {
    const b1 = built.body1;
    const b2 = built.body2;
    const dyn1 = b1.isDynamic();
    const dyn2 = b2.isDynamic();
    const hinge = built.kind === 'hinge';
    const unit = hinge ? rad(1) : 1;
    const [, p2] = this.#anchors(built);
    const axis = rotate(built.axis, b1.rotation());
    let velocity: number;
    let invMass: number;
    if (hinge) {
      velocity = b2.angvel() - b1.angvel();
      const about = (b: RAPIER.RigidBody): number => {
        const c = b.worldCom();
        return b.effectiveAngularInertia() + b.mass() * ((p2.x - c.x) ** 2 + (p2.y - c.y) ** 2);
      };
      invMass = (dyn1 ? 1 / about(b1) : 0) + (dyn2 ? 1 / about(b2) : 0);
    } else {
      const v1 = b1.velocityAtPoint(p2);
      const v2 = b2.velocityAtPoint(p2);
      velocity = (v2.x - v1.x) * axis.x + (v2.y - v1.y) * axis.y;
      invMass = (dyn1 ? b1.invMass() : 0) + (dyn2 ? b2.invMass() : 0);
    }
    if (!(invMass > 0)) return;
    const maxSpeed = speed === null ? Infinity : Math.abs(speed) * unit;
    const desired = target === null
      ? speed! * unit
      : Math.max(-maxSpeed, Math.min(maxSpeed, (target * unit - this.#coordinate(built)) / (4 * dt)));
    const limit = fields['motor_max_force'] as number | null;
    let effort = (desired - velocity) / invMass / dt;
    if (limit !== null) effort = Math.max(-limit, Math.min(limit, effort));
    if (hinge) {
      if (dyn2) b2.addTorque(effort, true);
      if (dyn1) b1.addTorque(-effort, true);
    } else {
      if (dyn2) b2.addForceAtPoint({ x: axis.x * effort, y: axis.y * effort }, p2, true);
      if (dyn1) b1.addForceAtPoint({ x: -axis.x * effort, y: -axis.y * effort }, p2, true);
    }
    if (dyn2) this.#host.markForced(built.body);
    if (dyn1 && built.connected !== undefined) this.#host.markForced(built.connected);
  }

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
    return Math.hypot(
      component(v.x - before.linvel.x, g.x, before.userForce.x, j.x, before.linvel.x),
      component(v.y - before.linvel.y, g.y, before.userForce.y, j.y, before.linvel.y),
    );
  }

  #break(record: EntityRecord, fields: Fields, built: Pick<Built, 'body' | 'connected'>, force: number): void {
    fields['broken'] = true;
    const kernel = this.#host.kernel;
    const alive = (id: EntityId | undefined): unknown => (id === undefined || !kernel.world.isAlive(id) ? null : kernel.handles.wrap(id));
    kernel.emit(JOINT_BROKEN, { entity: kernel.handles.wrap(record.id), body: alive(built.body), connected: alive(built.connected), force });
  }

  #remove(built: Built): void {
    const world = this.#host.world;
    if (built.joint.isValid()) world.removeImpulseJoint(built.joint, true);
    if (built.anchorBody !== undefined) world.removeRigidBody(built.anchorBody);
  }
}
