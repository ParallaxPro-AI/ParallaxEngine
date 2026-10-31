/**
 * Ragdolls on Rapier 3D (the `ragdoll` component: rebuilt on the same
 * engine as everything else, not a second one).
 *
 * A ragdoll is a profile — body parts with capsule sizes, masses, joints and limits —
 * laid over a skeleton. The skeleton is the entity's skinned model as it is animated now
 * (the `skeleton` service, render3d) or, without one (Shape-built characters, data-only
 * runs), the profile's own proportions scaled to `height`. Parts are internal Rapier
 * bodies, not entities: they exist only while the ragdoll is on.
 *
 *   limp        `go_limp(impulse, at)`: every part dynamic, joints with limits, nothing
 *               driving them. The entity follows the pelvis (position and rotation), so
 *               cameras and queries follow the body; its own colliders are off.
 *   active      `activate(strength)`: the pelvis follows the entity (kinematic), which
 *               keeps moving as its game moves it; every other part is dynamic and its
 *               joint's motors servo it to the animated pose (critically damped, stiffer
 *               with `strength`): a hit makes the torso and limbs react, and the animation
 *               pulls them back. The motors run inside Rapier's solver, so any strength is
 *               stable; their gains carry the inertia of everything hanging off the joint.
 *   recovering  `recover(blend)`: the parts are removed, the entity stands up where the
 *               pelvis lies (upright, facing the way the chest faced), and the pose blends
 *               from the physics pose back to the animation over `blend` seconds.
 *
 * Renderers read the driven bones through the `ragdoll_pose` service (model space,
 * interpolated between fixed steps) and blend them over the animation by `weight`.
 * Parts never collide with each other (a contact filter); their colliders are in the
 * entity's Collider layer and belong to the entity for queries and events, so a bullet's
 * raycast hits the character it struck.
 *
 * Everything — mode, blend, each part's pose and motion, the rest data it was built from
 * — is in physics3d's snapshot.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import { fail, Quat, rad, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { EntityRecord, Kernel, Schema } from '../../kernel/index.js';
import { SKELETON_SERVICE } from '../../services/index.js';
import type { Pose, RagdollMode, RagdollPose, RagdollPoseSource, SkeletonPose } from '../../services/index.js';
import { lerpVec3, slerp } from './interpolation.js';
import { rapier } from './rapier.js';
import { toQuat, toVec3 } from './values.js';

export const RAGDOLL = 'ragdoll';

export const RAGDOLL_SCHEMA: Schema = {
  profile: t.enum(['humanoid'], { default: 'humanoid' }),
  /** Meters: the size of the profile's own proportions (used without a skinned model). */
  height: t.number({ default: 1.8, min: 0 }),
  /** Kilograms, split across the parts by the profile. */
  mass: t.number({ default: 70, min: 0 }),
  /** How hard an active ragdoll follows its animation (1: firm; 0.2: loose). */
  strength: t.number({ default: 1, min: 0 }),
  /** Seconds `recover()` blends back to the animation, by default. */
  blend: t.number({ default: 0.3, min: 0 }),
};

type Triple = readonly [number, number, number];

interface PartDef {
  readonly name: string;
  readonly parent: number;
  /** Normalized bone names the part starts at, then (for its end) the next part's or its own end bones. */
  readonly bones: readonly string[];
  readonly end: readonly string[];
  /** Proportions (fractions of height, model space: y up, facing +z, left = +x). */
  readonly start: Triple;
  readonly stop: Triple;
  readonly radius: number;
  readonly mass: number;
  readonly joint: 'ball' | 'hinge';
  /** Hinge axis (model space) and limits in degrees; ball: limits about x, y, z. */
  readonly axis?: Triple;
  readonly limits: readonly (readonly [number, number])[];
}

function side(name: string, left: boolean): readonly string[] {
  const l = left ? ['left', 'l'] : ['right', 'r'];
  const table: Record<string, readonly string[]> = {
    upper_arm: [`${l[0]}arm`, `${l[0]}upperarm`, `upperarm${l[1]}`, `${l[1]}upperarm`, `arm${l[1]}`],
    forearm: [`${l[0]}forearm`, `${l[0]}lowerarm`, `forearm${l[1]}`, `lowerarm${l[1]}`, `${l[1]}forearm`],
    hand: [`${l[0]}hand`, `hand${l[1]}`, `${l[1]}hand`],
    thigh: [`${l[0]}upleg`, `${l[0]}thigh`, `${l[0]}upperleg`, `thigh${l[1]}`, `upperleg${l[1]}`, `${l[1]}thigh`],
    shin: [`${l[0]}leg`, `${l[0]}calf`, `${l[0]}shin`, `${l[0]}lowerleg`, `calf${l[1]}`, `shin${l[1]}`, `lowerleg${l[1]}`, `${l[1]}calf`],
    foot: [`${l[0]}foot`, `foot${l[1]}`, `${l[1]}foot`],
  };
  return table[name]!;
}

const HIPS = ['hips', 'pelvis', 'hip'];
const SPINE = ['spine', 'spine01', 'spine1', 'abdomen'];
const NECK = ['neck', 'neck01', 'neck1'];
const HEAD = ['head'];
const HEAD_END = ['headend', 'headtopend', 'headtop', 'headnub'];

function limbs(left: boolean): PartDef[] {
  const x = left ? 1 : -1;
  const base = left ? 3 : 5;
  const legBase = left ? 7 : 9;
  return [
    {
      name: left ? 'upper_arm_l' : 'upper_arm_r', parent: 1, bones: side('upper_arm', left), end: side('forearm', left),
      start: [0.12 * x, 0.81, 0], stop: [0.13 * x, 0.63, 0], radius: 0.028, mass: 0.03, joint: 'ball',
      limits: [[-90, 90], [-60, 60], left ? [-30, 100] : [-100, 30]],
    },
    {
      name: left ? 'forearm_l' : 'forearm_r', parent: base, bones: side('forearm', left), end: side('hand', left),
      // Elbows flex forward: the forearm turns about -x.
      start: [0.13 * x, 0.63, 0], stop: [0.14 * x, 0.43, 0], radius: 0.024, mass: 0.025, joint: 'hinge', axis: [1, 0, 0],
      limits: [[-150, 0]],
    },
    {
      name: left ? 'thigh_l' : 'thigh_r', parent: 0, bones: side('thigh', left), end: side('shin', left),
      start: [0.055 * x, 0.52, 0], stop: [0.055 * x, 0.28, 0], radius: 0.04, mass: 0.12, joint: 'ball',
      limits: [[-100, 30], [-30, 30], left ? [-10, 50] : [-50, 10]],
    },
    {
      name: left ? 'shin_l' : 'shin_r', parent: legBase, bones: side('shin', left), end: side('foot', left),
      // Knees flex backwards: the shin turns about +x.
      start: [0.055 * x, 0.28, 0], stop: [0.055 * x, 0.03, 0], radius: 0.034, mass: 0.06, joint: 'hinge', axis: [1, 0, 0],
      limits: [[0, 150]],
    },
  ];
}

/** The humanoid profile: 11 parts, pelvis first (parents precede children). */
const HUMANOID: readonly PartDef[] = [
  { name: 'pelvis', parent: -1, bones: HIPS, end: SPINE, start: [0, 0.53, 0], stop: [0, 0.62, 0], radius: 0.07, mass: 0.14, joint: 'ball', limits: [] },
  {
    name: 'chest', parent: 0, bones: SPINE, end: NECK, start: [0, 0.62, 0], stop: [0, 0.84, 0], radius: 0.08, mass: 0.31, joint: 'ball',
    limits: [[-30, 45], [-35, 35], [-30, 30]],
  },
  {
    name: 'head', parent: 1, bones: HEAD, end: HEAD_END, start: [0, 0.87, 0], stop: [0, 1, 0], radius: 0.055, mass: 0.08, joint: 'ball',
    limits: [[-40, 50], [-60, 60], [-35, 35]],
  },
  ...limbs(true).slice(0, 2),
  ...limbs(false).slice(0, 2),
  ...limbs(true).slice(2),
  ...limbs(false).slice(2),
];

const PROFILES: Readonly<Record<string, readonly PartDef[]>> = { humanoid: HUMANOID };

/** "mixamorig:LeftUpLeg" → "leftupleg"; "Thigh.L" → "thighl". */
export function normalizeBone(name: string): string {
  return name.toLowerCase().replace(/^.*[:|]/, '').replace(/^mixamorig/, '').replace(/[^a-z0-9]/g, '');
}

/** The rotation turning +y onto the unit vector `d`. */
function fromUp(d: Vec3): Quat {
  const dot = d.y;
  if (dot > 1 - 1e-9) return Quat.IDENTITY;
  if (dot < -1 + 1e-9) return new Quat(1, 0, 0, 0);
  // axis = y × d = (d.z, 0, -d.x)
  const ax = d.z;
  const az = -d.x;
  const s = Math.sqrt((1 + dot) * 2);
  const q = new Quat(ax / s, 0, az / s, s / 2);
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return new Quat(q.x / length, q.y / length, q.z / length, q.w / length);
}

/** Axis-angle (radians) of a unit quaternion, shortest way round. */
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

interface Part {
  readonly def: PartDef;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly joint: RAPIER.ImpulseJoint | undefined;
  /** Rest data (entity-local, unscaled): the part's centre, and from it to its bone's start. */
  readonly center: Vec3;
  readonly boneOffset: Vec3;
  /** The bone's model-space rotation when built. */
  readonly boneRotation: Quat;
  readonly bone: string;
  readonly radius: number;
  prevPosition: Vec3;
  prevRotation: Quat;
  position: Vec3;
  rotation: Quat;
}

interface Rig {
  readonly entity: EntityId;
  mode: RagdollMode;
  strength: number;
  /** Recovering: seconds of blend left and in all. */
  blendLeft: number;
  blendTime: number;
  parts: Part[];
  /** Recovering: the physics pose being blended away (model space). */
  frozen: Map<string, Pose> | undefined;
}

/** Rapier 0.19's JS wrapper sets motors on revolute joints only; its joint set does any axis. */
interface RawJoints {
  jointConfigureMotorModel(handle: number, axis: number, model: number): void;
  jointConfigureMotorPosition(handle: number, axis: number, target: number, stiffness: number, damping: number): void;
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
}

function raw(joint: RAPIER.ImpulseJoint): RawJoints {
  return (joint as unknown as { rawSet: RawJoints }).rawSet;
}

/** Rapier's joint axes (RawJointAxis): the angular ones. */
const ANG_X = 3;
/**
 * RawMotorModel.ForceBased: gains in N·m/rad. (The acceleration-based default doesn't hold
 * a chain of motorized joints between dynamic bodies — measured: an arm on a motorized chest
 * drifts 0.3 m in 2 s — so the gains are scaled by inertia here instead.)
 */
const FORCE_BASED = 1;

interface SavedPart {
  readonly t: readonly number[];
  readonly q: readonly number[];
  readonly v: readonly number[];
  readonly w: readonly number[];
  readonly center: readonly number[];
  readonly boneOffset: readonly number[];
  readonly boneRotation: readonly number[];
  readonly bone: string;
}

export interface SavedRagdoll {
  readonly entity: number;
  readonly mode: RagdollMode;
  readonly strength: number;
  readonly blendLeft: number;
  readonly blendTime: number;
  readonly parts: readonly SavedPart[];
  readonly frozen: ReadonlyArray<{ readonly bone: string; readonly t: readonly number[]; readonly q: readonly number[] }> | null;
}

export interface RagdollHost {
  readonly kernel: Kernel;
  readonly world: RAPIER.World;
  /** The entity's collider interaction groups (its Collider's layer), or every layer. */
  groupsOf(entity: EntityId): number;
  /** Register a part collider as the entity's (queries, events), or forget it. */
  claim(collider: RAPIER.Collider, entity: EntityId): void;
  release(collider: RAPIER.Collider): void;
  /** The entity was ragdolled or released: its own colliders turn off / back on. */
  ragdolled(entity: EntityId, on: boolean): void;
  /** How the entity moved over the last fixed step (m/s), for parts to start with. */
  velocity(entity: EntityId): Vec3;
  where(record: EntityRecord, component: string): string;
}

const ZERO = { x: 0, y: 0, z: 0 };
const v3 = (a: readonly number[]): Vec3 => new Vec3(a[0]!, a[1]!, a[2]!);
const q4 = (a: readonly number[]): Quat => new Quat(a[0]!, a[1]!, a[2]!, a[3]!);
const arr3 = (v: { x: number; y: number; z: number }): number[] => [v.x, v.y, v.z];
const arr4 = (q: { x: number; y: number; z: number; w: number }): number[] => [q.x, q.y, q.z, q.w];

export class Ragdolls implements RagdollPoseSource {
  readonly #host: RagdollHost;
  readonly #rigs = new Map<EntityId, Rig>();
  /** Part collider handles, for the self-contact filter. */
  readonly #partColliders = new Map<number, EntityId>();

  constructor(host: RagdollHost) {
    this.#host = host;
  }

  /** Rapier's contact filter: parts of one ragdoll never touch each other. */
  readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2) => {
      const a = this.#partColliders.get(c1);
      if (a !== undefined && a === this.#partColliders.get(c2)) return null;
      return rapier().SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair: () => true,
  };

  isPart(collider: number): boolean {
    return this.#partColliders.has(collider);
  }

  mode(entity: EntityId): RagdollMode | undefined {
    this.#requireComponent(entity);
    return this.#rigs.get(entity)?.mode;
  }

  modeOf(entity: EntityId): RagdollMode | undefined {
    return this.#rigs.get(entity)?.mode;
  }

  /** True while the parts are simulated (limp or active): the entity's own body stands aside. */
  simulated(entity: EntityId): boolean {
    const mode = this.#rigs.get(entity)?.mode;
    return mode === 'limp' || mode === 'active';
  }

  weight(entity: EntityId): number {
    this.#requireComponent(entity);
    const rig = this.#rigs.get(entity);
    if (rig === undefined) return 0;
    if (rig.mode !== 'recovering') return 1;
    return rig.blendTime === 0 ? 0 : rig.blendLeft / rig.blendTime;
  }

  limp(entity: EntityId, impulse: Vec3 | undefined, at: Vec3 | undefined): void {
    const rig = this.#ensure(entity, 'limp');
    rig.mode = 'limp';
    this.#power(rig, false);
    if (impulse === undefined) return;
    let part = rig.parts[0]!;
    if (at !== undefined) {
      let best = Infinity;
      for (const p of rig.parts) {
        const d = toVec3(p.body.translation()).distance_to(at);
        if (d < best) {
          best = d;
          part = p;
        }
      }
      part.body.applyImpulseAtPoint(impulse, at, true);
    } else {
      part.body.applyImpulse(impulse, true);
    }
  }

  activate(entity: EntityId, strength: number | undefined): void {
    const fields = this.#requireComponent(entity);
    const rig = this.#ensure(entity, 'active');
    rig.mode = 'active';
    rig.strength = strength ?? fields['strength'] as number;
    if (!(rig.strength >= 0)) fail('PP3196', `activate(strength=${rig.strength}): strength can't be negative`);
    this.#power(rig, true);
  }

  recover(entity: EntityId, blend: number | undefined): void {
    const fields = this.#requireComponent(entity);
    const rig = this.#rigs.get(entity);
    if (rig === undefined || rig.mode === 'recovering') return;
    const time = blend ?? fields['blend'] as number;
    if (!(time >= 0)) fail('PP3196', `recover(blend=${time}): the blend can't be negative`);
    const record = this.#host.kernel.world.require(entity);
    if (rig.mode === 'limp') this.#standUp(record, rig);
    rig.frozen = this.#bones(record, rig, 1);
    this.#removeParts(rig);
    rig.mode = 'recovering';
    rig.blendTime = time;
    rig.blendLeft = time;
    this.#host.ragdolled(entity, false);
    if (time === 0) this.#rigs.delete(entity);
  }

  /** The entity is gone (or lost its Ragdoll component). */
  remove(entity: EntityId): void {
    const rig = this.#rigs.get(entity);
    if (rig === undefined) return;
    this.#removeParts(rig);
    this.#rigs.delete(entity);
  }

  /** Before the step: rigs whose component went away are dropped; active rigs follow the entity and its animation. */
  drive(): void {
    for (const rig of [...this.#rigs.values()]) {
      const record = this.#host.kernel.world.get(rig.entity);
      if (record === undefined || !record.components.has(RAGDOLL)) {
        if (rig.parts.length > 0) this.#host.ragdolled(rig.entity, false);
        this.remove(rig.entity);
        continue;
      }
      for (const part of rig.parts) {
        part.prevPosition = part.position;
        part.prevRotation = part.rotation;
      }
      if (rig.mode === 'active') this.#followAnimation(record, rig);
    }
  }

  /** After the step: limp entities follow their pelvis; blends run down. */
  settle(dt: number): void {
    for (const rig of [...this.#rigs.values()]) {
      for (const part of rig.parts) {
        // Springs are for one step (Rapier keeps added forces until they are reset).
        part.body.resetForces(false);
        part.body.resetTorques(false);
        part.position = toVec3(part.body.translation());
        part.rotation = toQuat(part.body.rotation());
      }
      const record = this.#host.kernel.world.get(rig.entity);
      if (record === undefined) continue;
      if (rig.mode === 'limp') this.#follow(record, rig);
      if (rig.mode === 'recovering') {
        rig.blendLeft = Math.max(0, rig.blendLeft - dt);
        if (rig.blendLeft === 0) this.#rigs.delete(rig.entity);
      }
    }
  }

  pose(entity: EntityId): RagdollPose | undefined {
    const rig = this.#rigs.get(entity);
    const record = this.#host.kernel.world.peek(entity);
    if (rig === undefined || record === undefined) return undefined;
    if (rig.mode === 'recovering') {
      return { weight: rig.blendTime === 0 ? 0 : rig.blendLeft / rig.blendTime, bones: rig.frozen ?? new Map() };
    }
    return { weight: 1, bones: this.#bones(record, rig, this.#host.kernel.time.alpha) };
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): SavedRagdoll[] {
    return [...this.#rigs.values()].map((rig) => ({
      entity: rig.entity as number,
      mode: rig.mode,
      strength: rig.strength,
      blendLeft: rig.blendLeft,
      blendTime: rig.blendTime,
      parts: rig.parts.map((p) => ({
        t: arr3(p.body.translation()), q: arr4(p.body.rotation()), v: arr3(p.body.linvel()), w: arr3(p.body.angvel()),
        center: arr3(p.center), boneOffset: arr3(p.boneOffset), boneRotation: arr4(p.boneRotation), bone: p.bone,
      })),
      frozen: rig.frozen === undefined ? null : [...rig.frozen].map(([bone, pose]) => ({ bone, t: arr3(pose.position), q: arr4(pose.rotation) })),
    }));
  }

  /** Remove every rig's parts (before the world is replaced on restore). */
  clear(): void {
    for (const rig of this.#rigs.values()) this.#removeParts(rig);
    this.#rigs.clear();
  }

  /** Build the saved rigs again (after `clear`, in the restored world). */
  restore(saved: readonly SavedRagdoll[]): void {
    this.clear();
    for (const s of saved) {
      const entity = s.entity as EntityId;
      const record = this.#host.kernel.world.get(entity);
      const fields = record?.components.get(RAGDOLL);
      if (record === undefined || fields === undefined) continue;
      const rig: Rig = {
        entity, mode: s.mode, strength: s.strength, blendLeft: s.blendLeft, blendTime: s.blendTime, parts: [],
        frozen: s.frozen === null ? undefined : new Map(s.frozen.map((f) => [f.bone, { position: v3(f.t), rotation: q4(f.q) }])),
      };
      if (s.parts.length > 0) {
        const defs = PROFILES[fields['profile'] as string]!;
        const total = fields['mass'] as number;
        s.parts.forEach((p, i) => {
          const part = this.#part(record, rig, defs[i]!, total, v3(p.t), q4(p.q), v3(p.center), v3(p.boneOffset), q4(p.boneRotation), p.bone);
          part.body.setLinvel(v3(p.v), true);
          part.body.setAngvel(v3(p.w), true);
          rig.parts.push(part);
        });
        this.#joinParts(rig);
        if (rig.mode === 'active') this.#power(rig, true);
        this.#host.ragdolled(entity, true);
      }
      this.#rigs.set(entity, rig);
    }
  }

  // ── Building ─────────────────────────────────────────────────────────────────

  #requireComponent(entity: EntityId): Record<string, unknown> {
    const record = this.#host.kernel.world.require(entity);
    const fields = record.components.get(RAGDOLL);
    if (fields === undefined) fail('PP3195', `${this.#host.where(record, 'ragdoll')}: the entity has no ragdoll component`);
    return fields;
  }

  #ensure(entity: EntityId, to: RagdollMode): Rig {
    const fields = this.#requireComponent(entity);
    const existing = this.#rigs.get(entity);
    if (existing !== undefined && existing.parts.length > 0) return existing;
    if (existing !== undefined) this.#rigs.delete(entity);
    const record = this.#host.kernel.world.require(entity);
    const rig: Rig = { entity, mode: to, strength: fields['strength'] as number, blendLeft: 0, blendTime: 0, parts: [], frozen: undefined };
    this.#build(record, rig, fields);
    this.#rigs.set(entity, rig);
    this.#host.ragdolled(entity, true);
    return rig;
  }

  /** Bone positions (model space) and rotations to lay the profile over. */
  #skeleton(record: EntityRecord, defs: readonly PartDef[], height: number): Map<string, { start: Vec3; end: Vec3; rotation: Quat; bone: string }> {
    const at = this.#host.where(record, 'ragdoll');
    const source = this.#host.kernel.tryService(SKELETON_SERVICE);
    const pose: SkeletonPose | null | undefined = source?.pose(record.id) ?? null;
    if (pose === undefined) {
      fail('PP3197', `${at}: the model's skeleton is still loading`, { fix: 'Ragdoll it once the model has loaded (a frame after it spawns).' });
    }
    const result = new Map<string, { start: Vec3; end: Vec3; rotation: Quat; bone: string }>();
    if (pose === null) {
      for (const def of defs) {
        result.set(def.name, {
          start: new Vec3(def.start[0] * height, def.start[1] * height, def.start[2] * height),
          end: new Vec3(def.stop[0] * height, def.stop[1] * height, def.stop[2] * height),
          rotation: Quat.IDENTITY,
          bone: def.name,
        });
      }
      return result;
    }
    const byName = new Map(pose.bones.map((b) => [normalizeBone(b.name), b]));
    const find = (names: readonly string[]): (typeof pose.bones)[number] | undefined => {
      for (const n of names) {
        const bone = byName.get(n);
        if (bone !== undefined) return bone;
      }
      return undefined;
    };
    const missing: string[] = [];
    for (const def of defs) {
      const bone = find(def.bones);
      if (bone === undefined) {
        missing.push(`${def.name} (${def.bones.slice(0, 3).join('/')})`);
        continue;
      }
      const endBone = find(def.end);
      // No end bone (a head without a tip): extend along the profile's direction by its proportions.
      const length = Math.hypot(def.stop[0] - def.start[0], def.stop[1] - def.start[1], def.stop[2] - def.start[2]) * height;
      const fallbackDir = new Vec3(def.stop[0] - def.start[0], def.stop[1] - def.start[1], def.stop[2] - def.start[2]).normalized();
      const end = endBone?.position ?? bone.position.__add__(fallbackDir.__mul__(length));
      result.set(def.name, { start: bone.position, end, rotation: bone.rotation, bone: bone.name });
    }
    if (missing.length > 0) {
      fail('PP3195', `${at}: the model's skeleton has no bone for ${missing.join(', ')}`, {
        fix: 'Use a humanoid rig with standard bone names (Hips, Spine, Neck, Head, LeftArm, LeftForeArm, LeftUpLeg, LeftLeg, …).',
      });
    }
    return result;
  }

  #modelOffset(record: EntityRecord): Vec3 {
    const offset = record.components.get('model')?.['offset'];
    return offset instanceof Vec3 ? offset : Vec3.ZERO;
  }

  #build(record: EntityRecord, rig: Rig, fields: Record<string, unknown>): void {
    const defs = PROFILES[fields['profile'] as string]!;
    const height = fields['height'] as number;
    const total = fields['mass'] as number;
    const at = this.#host.where(record, 'ragdoll');
    if (!(total > 0) || !(height > 0)) fail('PP3196', `${at}: mass and height must be above 0`);
    const bones = this.#skeleton(record, defs, height);
    const t = record.transform;
    const q = t.worldRotation();
    const p = t.worldPosition();
    const offset = this.#modelOffset(record);
    const velocity = this.#host.velocity(record.id);
    for (const def of defs) {
      const b = bones.get(def.name)!;
      const start = t.toWorld(b.start.__add__(offset));
      const end = t.toWorld(b.end.__add__(offset));
      const centerWorld = start.__add__(end).__mul__(0.5);
      const center = q.inverse().rotate(centerWorld.__sub__(p));
      const boneOffset = q.inverse().rotate(start.__sub__(centerWorld));
      const part = this.#part(record, rig, def, total, centerWorld, q, center, boneOffset, b.rotation, b.bone);
      part.body.setLinvel(velocity, true);
      rig.parts.push(part);
    }
    this.#joinParts(rig);
  }

  /** One part body and its capsule. Its Rapier frame is the entity's (all parts aligned at rest). */
  #part(record: EntityRecord, rig: Rig, def: PartDef, total: number, position: Vec3, rotation: Quat, center: Vec3, boneOffset: Vec3,
    boneRotation: Quat, bone: string): Part {
    const R = rapier();
    const h = record.components.get(RAGDOLL)!['height'] as number;
    // The capsule runs from the bone's start (boneOffset from the centre) to its end (as far the other way).
    const segment = boneOffset.__mul__(-2);
    const length = segment.length();
    const radius = Math.min(def.radius * h, Math.max(length / 2, 0.01));
    const halfHeight = Math.max(0.005, length / 2 - radius);
    const body = this.#host.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z).setRotation(rotation).setCanSleep(false));
    const groups = this.#host.groupsOf(record.id);
    const desc = R.ColliderDesc.capsule(halfHeight, radius)
      .setRotation(length === 0 ? Quat.IDENTITY : fromUp(segment.__mul__(1 / length)))
      .setMass(def.mass * total)
      .setFriction(0.7)
      .setCollisionGroups(groups)
      .setSolverGroups(groups)
      .setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const collider = this.#host.world.createCollider(desc, body);
    this.#partColliders.set(collider.handle, rig.entity);
    this.#host.claim(collider, rig.entity);
    const p = toVec3(body.translation());
    const q = toQuat(body.rotation());
    return {
      def, body, collider, joint: undefined, center, boneOffset, boneRotation, bone, radius,
      prevPosition: p, prevRotation: q, position: p, rotation: q,
    };
  }

  #joinParts(rig: Rig): void {
    const R = rapier();
    const parts = rig.parts;
    parts.forEach((part, i) => {
      if (part.def.parent < 0) return;
      const parent = parts[part.def.parent]!;
      // The joint sits at the child's bone start, in both parts' (aligned) frames.
      const pivotWorld = part.position.__add__(part.rotation.rotate(part.boneOffset));
      const a1 = parent.rotation.inverse().rotate(pivotWorld.__sub__(parent.position));
      const a2 = part.boneOffset;
      let joint: RAPIER.ImpulseJoint;
      if (part.def.joint === 'hinge') {
        const axis = part.def.axis!;
        joint = this.#host.world.createImpulseJoint(R.JointData.revolute(a1, a2, { x: axis[0], y: axis[1], z: axis[2] }), parent.body, part.body, true);
        const [min, max] = part.def.limits[0]!;
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(rad(min), rad(max));
      } else {
        joint = this.#host.world.createImpulseJoint(R.JointData.spherical(a1, a2), parent.body, part.body, true);
        // Rapier 0.19's JS wrapper has no limit setter for spherical joints; its joint set does (per angular axis).
        part.def.limits.forEach(([min, max], axis) => raw(joint).jointSetLimits(joint.handle, ANG_X + axis, rad(min), rad(max)));
      }
      joint.setContactsEnabled(false);
      parts[i] = { ...part, joint };
    });
  }

  #removeParts(rig: Rig): void {
    for (const part of rig.parts) {
      this.#partColliders.delete(part.collider.handle);
      this.#host.release(part.collider);
      this.#host.world.removeRigidBody(part.body);
    }
    rig.parts = [];
  }

  // ── Running ──────────────────────────────────────────────────────────────────

  /** Limp: the entity is wherever its pelvis puts it. */
  #follow(record: EntityRecord, rig: Rig): void {
    const pelvis = rig.parts[0]!;
    const t = record.transform;
    const rotation = pelvis.rotation;
    const position = pelvis.position.__sub__(rotation.rotate(pelvis.center));
    t.setWorldPosition(position);
    t.rotation = t.parent === null ? rotation : this.#host.kernel.world.require(record.parent!).transform.worldRotation().inverse().__mul__(rotation);
  }

  /** Recovering from limp: upright where the pelvis lies, facing where the chest faces, feet on the lowest part. */
  #standUp(record: EntityRecord, rig: Rig): void {
    const chest = rig.parts[1] ?? rig.parts[0]!;
    const forward = chest.rotation.rotate(new Vec3(0, 0, 1));
    const up = chest.rotation.rotate(new Vec3(0, 1, 0));
    // Lying on the back the chest's +z points up: face where its +y (head) points instead.
    const flat = Math.hypot(forward.x, forward.z) > 0.3 ? forward : up;
    const yaw = Math.atan2(flat.x, flat.z);
    const rotation = new Quat(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    let ground = Infinity;
    for (const part of rig.parts) ground = Math.min(ground, part.position.y - part.radius);
    const pelvis = rig.parts[0]!.position;
    const t = record.transform;
    t.setWorldPosition(new Vec3(pelvis.x, ground, pelvis.z));
    t.rotation = t.parent === null ? rotation : this.#host.kernel.world.require(record.parent!).transform.worldRotation().inverse().__mul__(rotation);
  }

  /**
   * Switch the motors on (active) or off (limp). On, the pelvis is kinematic (it follows
   * the entity) and each joint servos with gains for the inertia it carries: the masses
   * of its part and everything beyond it, at their distances from the pivot.
   */
  #power(rig: Rig, on: boolean): void {
    const R = rapier();
    const pelvis = rig.parts[0]!.body;
    pelvis.setBodyType(on ? R.RigidBodyType.KinematicPositionBased : R.RigidBodyType.Dynamic, true);
    if (!on) {
      pelvis.setLinvel(ZERO, true);
      pelvis.setAngvel(ZERO, true);
    }
    const omega = 20 * rig.strength;
    rig.parts.forEach((part, i) => {
      if (part.joint === undefined) return;
      const inertia = on ? this.#carried(rig, i) : 0;
      const axes = part.def.joint === 'hinge' ? 1 : 3;
      for (let a = 0; a < axes; a++) {
        raw(part.joint).jointConfigureMotorModel(part.joint.handle, ANG_X + a, FORCE_BASED);
        raw(part.joint).jointConfigureMotorPosition(part.joint.handle, ANG_X + a, 0, omega * omega * inertia, 2 * omega * inertia);
      }
    });
  }

  /** kg·m² about part i's pivot: its part and every part beyond it (rest pose). */
  #carried(rig: Rig, i: number): number {
    const pivot = rig.parts[i]!.center.__add__(rig.parts[i]!.boneOffset);
    let inertia = 0;
    rig.parts.forEach((part, j) => {
      let k = j;
      while (k > i) k = rig.parts[k]!.def.parent;
      if (k !== i) return;
      const m = part.body.mass();
      const half = part.boneOffset.length();
      // The part as a rod about its own centre, moved out to the pivot.
      inertia += m * (half * half / 3 + part.center.distance_to(pivot) ** 2);
    });
    return inertia;
  }

  /** Active: the pelvis follows the entity and the joints' motor targets follow the animation. */
  #followAnimation(record: EntityRecord, rig: Rig): void {
    const t = record.transform;
    const q = t.worldRotation();
    const pelvis = rig.parts[0]!;
    pelvis.body.setNextKinematicTranslation(t.worldPosition().__add__(q.rotate(pelvis.center)));
    pelvis.body.setNextKinematicRotation(q);
    const targets = this.#targets(record, rig);
    const omega = 20 * rig.strength;
    rig.parts.forEach((part, i) => {
      if (part.joint === undefined) return;
      const inertia = this.#carried(rig, i);
      // The child's goal relative to its parent's goal, as the joint's coordinates.
      const relative = targets[part.def.parent]!.inverse().__mul__(targets[i]!);
      if (part.def.joint === 'hinge') {
        const axis = part.def.axis!;
        const along = relative.x * axis[0] + relative.y * axis[1] + relative.z * axis[2];
        raw(part.joint).jointConfigureMotorPosition(part.joint.handle, ANG_X, 2 * Math.atan2(along, relative.w), omega * omega * inertia, 2 * omega * inertia);
      } else {
        const v = axisAngle(relative);
        [v.x, v.y, v.z].forEach((target, a) => raw(part.joint!).jointConfigureMotorPosition(part.joint!.handle, ANG_X + a, target, omega * omega * inertia, 2 * omega * inertia));
      }
    });
  }

  /** Each part's goal rotation: the animated pose when there is one, else the rest pose. */
  #targets(record: EntityRecord, rig: Rig): Quat[] {
    const q = record.transform.worldRotation();
    const pose = this.#host.kernel.tryService(SKELETON_SERVICE)?.pose(record.id);
    const byName = pose === null || pose === undefined ? undefined : new Map(pose.bones.map((b) => [b.name, b]));
    return rig.parts.map((part) => {
      const bone = byName?.get(part.bone);
      // Part rotation = bone rotation × its rest rotation⁻¹ (parts rest aligned to the entity).
      return bone === undefined ? q : q.__mul__(bone.rotation.__mul__(part.boneRotation.inverse()));
    });
  }

  /** The driven bones in model space, `alpha` of the way from the previous step's pose to the last. */
  #bones(record: EntityRecord, rig: Rig, alpha: number): Map<string, Pose> {
    const t = record.transform;
    const entityRotation = t.worldRotation().inverse();
    const entityPosition = t.worldPosition();
    const scale = t.worldScale();
    const offset = this.#modelOffset(record);
    const bones = new Map<string, Pose>();
    for (const part of rig.parts) {
      const position = alpha >= 1 ? part.position : lerpVec3(part.prevPosition, part.position, alpha);
      const rotation = alpha >= 1 ? part.rotation : slerp(part.prevRotation, part.rotation, alpha);
      const bonePosition = position.__add__(rotation.rotate(part.boneOffset));
      const local = entityRotation.rotate(bonePosition.__sub__(entityPosition));
      bones.set(part.bone, {
        position: new Vec3(local.x / scale.x - offset.x, local.y / scale.y - offset.y, local.z / scale.z - offset.z),
        rotation: entityRotation.__mul__(rotation).__mul__(part.boneRotation),
      });
    }
    return bones;
  }
}
