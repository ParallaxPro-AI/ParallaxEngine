/**
 * Muscles (the `muscle` component, physics3d): the building block of active ragdolls made
 * of entities — a torso that balances upright, a head that wobbles back, arms that swing
 * to a punch pose — while staying fully physical (hits knock them about, joints hold them
 * together, a weak muscle lets them flop).
 *
 * Each fixed step, before the world steps, a muscle turns its dynamic body toward
 * `target` (Euler degrees: the entity's goal rotation, in world space or, with
 * `relative_to`, in that entity's frame) by a torque — a critically damped spring with
 * natural frequency `stiffness` (1/s) and damping ratio `damping`, scaled by the body's
 * inertia so the same numbers feel the same on a fist and a torso, and solved implicitly
 * (backward Euler) so any stiffness is stable at the fixed step:
 *
 *   Δω = dt·(k²·θ − 2ζk·ω) / (1 + 2ζk·dt + k²·dt²)     τ = I·Δω / dt · strength
 *
 * θ is the rotation still to go (axis × angle), ω the body's angular velocity relative to
 * `relative_to`'s. A relative muscle is internal: the opposite torque turns `relative_to`
 * (when it is dynamic), so a limb's swing never spins the whole body; a world muscle is
 * the balance assist physics-driven characters rely on. `axes` limits what it holds:
 *
 *   all    the full rotation
 *   tilt   only which way the body's up (+y) points — free to turn about it (balance)
 *   yaw    only the heading about world/parent +y — free to tip (turning to face)
 *
 * `strength` scales the torque (0: limp, a knocked-out body), `max_torque` (N·m) caps it.
 * Muscles hold no state of their own: everything is in the component.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { FieldSpec, Kernel, Schema } from '../../kernel/index.js';

export const MUSCLE = 'muscle';
export const MUSCLE_AXES = ['all', 'tilt', 'yaw'] as const;

const optional = (of: FieldSpec['type']): FieldSpec => ({ type: { kind: 'optional', of }, default: null });

export const MUSCLE_SCHEMA: Schema = {
  /** Euler degrees: the entity's goal rotation (world, or in `relative_to`'s frame). */
  target: t.vec3({ default: Vec3.ZERO }),
  /** The entity the target is relative to (it takes the opposite torque); None: the world. */
  relative_to: optional({ kind: 'entity' }),
  /** Natural frequency, 1/s: how quickly it gets there. */
  stiffness: t.number({ default: 10, min: 0 }),
  /** Damping ratio: 1 arrives without overshoot; below 1 wobbles. */
  damping: t.number({ default: 1, min: 0 }),
  /** Scales the torque: 1 full, 0 limp. */
  strength: t.number({ default: 1, min: 0 }),
  /** N·m; None: as much as it takes. */
  max_torque: optional({ kind: 'number' }),
  axes: t.enum(MUSCLE_AXES, { default: 'all' }),
  enabled: t.bool({ default: true }),
};

export interface MuscleBody {
  readonly body: RAPIER.RigidBody;
  readonly dynamic: boolean;
}

export interface MuscleHost {
  readonly kernel: Kernel;
  /** The entity's body, when it has one. */
  bodyOf(entity: EntityId): MuscleBody | undefined;
  /** Entity rotation = body rotation × offset. */
  offsetOf(entity: EntityId): Quat;
  markForced(entity: EntityId): void;
}

type M3 = readonly [number, number, number, number, number, number, number, number, number];

/** Rapier's symmetric matrix (upper triangle, row major: m11 m12 m13 m22 m23 m33) as a full 3×3. */
function full(m: RAPIER.SdpMatrix3): M3 {
  const e = m.elements;
  return [e[0]!, e[1]!, e[2]!, e[1]!, e[3]!, e[4]!, e[2]!, e[4]!, e[5]!];
}

function mulMV(m: M3, v: Vec3): Vec3 {
  return new Vec3(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z);
}

function invert(m: M3): M3 | undefined {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-18)) return undefined;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

/** Axis × angle (radians) of a unit quaternion, the short way round. */
function axisAngle(q: Quat): Vec3 {
  const sign = q.w < 0 ? -1 : 1;
  const x = q.x * sign;
  const y = q.y * sign;
  const z = q.z * sign;
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return Vec3.ZERO;
  const angle = 2 * Math.atan2(s, q.w * sign);
  return new Vec3(x / s * angle, y / s * angle, z / s * angle);
}

const UP = new Vec3(0, 1, 0);
const FORWARD = new Vec3(0, 0, 1);

/** The rotation (axis × angle) turning unit `from` onto unit `to`. */
function between(from: Vec3, to: Vec3): Vec3 {
  const axis = from.cross(to);
  const s = axis.length();
  const c = Math.max(-1, Math.min(1, from.dot(to)));
  if (s < 1e-9) {
    if (c > 0) return Vec3.ZERO;
    // Opposite: any axis square to `from`.
    const side = Math.abs(from.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
    return from.cross(side).normalized().__mul__(Math.PI);
  }
  return axis.__mul__(Math.atan2(s, c) / s);
}

/** Heading (radians about +y) of a rotation's forward, in the frame whose rotation is `frame`. */
function heading(frame: Quat, q: Quat): number {
  const f = frame.inverse().__mul__(q).rotate(FORWARD);
  return Math.atan2(f.x, f.z);
}

export function applyMuscles(host: MuscleHost, muscles: ReadonlySet<EntityId>, dt: number): void {
  if (!(dt > 0)) return;
  for (const id of muscles) {
    const record = host.kernel.world.get(id);
    const fields = record?.components.get(MUSCLE);
    if (record === undefined || fields === undefined || fields['enabled'] !== true) continue;
    const strength = fields['strength'] as number;
    const k = fields['stiffness'] as number;
    if (!(strength > 0) || !(k > 0)) continue;
    const self = host.bodyOf(id);
    if (self === undefined || !self.dynamic) continue;
    // An entity field holds a handle (set from game code) or an id (placed data).
    const named = fields['relative_to'];
    const relativeId = named === null || named === undefined ? null : host.kernel.handles.unwrap(named) ?? null;
    if (named !== null && named !== undefined && relativeId === null) continue;
    const other = relativeId === null ? undefined : host.bodyOf(relativeId);
    if (relativeId !== null && (other === undefined || host.kernel.world.get(relativeId) === undefined)) continue;

    const body = self.body;
    const r = body.rotation();
    // The entity's rotation now, and its goal, in world space.
    const current = new Quat(r.x, r.y, r.z, r.w).__mul__(host.offsetOf(id));
    let frame = Quat.IDENTITY;
    if (other !== undefined) {
      const o = other.body.rotation();
      frame = new Quat(o.x, o.y, o.z, o.w).__mul__(host.offsetOf(relativeId!));
    }
    const goal = frame.__mul__(Quat.from_euler(fields['target'] as Vec3));

    const axes = fields['axes'] as string;
    let theta: Vec3;
    if (axes === 'tilt') {
      theta = between(current.rotate(UP), goal.rotate(UP));
    } else if (axes === 'yaw') {
      let d = heading(frame, goal) - heading(frame, current);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      theta = frame.rotate(UP).__mul__(d);
    } else {
      theta = axisAngle(goal.__mul__(current.inverse()));
    }

    const w = body.angvel();
    let omega = new Vec3(w.x, w.y, w.z);
    if (other !== undefined) {
      const wo = other.body.angvel();
      omega = omega.__sub__(new Vec3(wo.x, wo.y, wo.z));
    }
    // Only the turning this muscle holds is damped (a tilt muscle leaves spin about up alone).
    if (axes === 'tilt') {
      const up = current.rotate(UP);
      omega = omega.__sub__(up.__mul__(omega.dot(up)));
    } else if (axes === 'yaw') {
      const up = frame.rotate(UP);
      omega = up.__mul__(omega.dot(up));
    }

    const zeta = fields['damping'] as number;
    const denominator = 1 + 2 * zeta * k * dt + k * k * dt * dt;
    const dw = theta.__mul__(k * k).__sub__(omega.__mul__(2 * zeta * k)).__mul__(dt / denominator);
    if (dw.x === 0 && dw.y === 0 && dw.z === 0) continue;

    // Inertia the change turns: the body's own, or (relative, both dynamic) the pair's reduced inertia.
    let inverse = full(body.effectiveWorldInvInertia());
    const reacts = other !== undefined && other.dynamic;
    if (reacts) {
      const io = full(other.body.effectiveWorldInvInertia());
      inverse = inverse.map((v, i) => v + io[i]!) as unknown as M3;
    }
    const inertia = invert(inverse);
    if (inertia === undefined) continue;
    let torque = mulMV(inertia, dw).__mul__(strength / dt);
    const cap = fields['max_torque'] as number | null;
    const size = torque.length();
    if (cap !== null && size > cap) torque = torque.__mul__(cap / size);
    if (!Number.isFinite(torque.x) || !Number.isFinite(torque.y) || !Number.isFinite(torque.z)) continue;
    body.addTorque(torque, true);
    host.markForced(id);
    if (reacts) {
      other.body.addTorque({ x: -torque.x, y: -torque.y, z: -torque.z }, true);
      host.markForced(relativeId!);
    }
  }
}
