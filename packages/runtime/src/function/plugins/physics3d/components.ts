/**
 * The `rigidbody` and `collider` components (sdk/parallax/physics.pyi) in 3D. Collider is
 * shape; Rigidbody is motion. A collider without a rigidbody is static; a rigidbody
 * without a collider moves but touches nothing. Rigidbody's methods act on its Rapier body.
 * Same ids and field names as physics2d's: a game has one physics plugin.
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Kernel, Schema } from '../../kernel/index.js';
import { FORCE_FIELD, FORCE_FIELD_SCHEMA } from './fields.js';
import { JOINT, JOINT_SCHEMA } from './joints.js';
import { DEFAULT_LAYER } from './layers.js';
import type { LayerTable } from './layers.js';
import { MATERIAL_FIELD } from './materials.js';
import { RAGDOLL, RAGDOLL_SCHEMA } from './ragdoll.js';
import { COLLIDER, RIGIDBODY, SHAPES_3D } from './sim.js';
import type { Physics3dSim } from './sim.js';
import { arg, describe, finite, splitKeywords, vec3 } from './values.js';

export const RIGIDBODY_SCHEMA: Schema = {
  kind: t.enum(['dynamic', 'kinematic'], { default: 'dynamic' }),
  mass: t.number({ default: 1, min: 0 }),
  /** Degrees per second, world space. Kept current by the simulation; assigning sets it. */
  angular_velocity: t.vec3({ default: Vec3.ZERO }),
  linear_damping: t.number({ default: 0, min: 0 }),
  angular_damping: t.number({ default: 0, min: 0 }),
  gravity_scale: t.number({ default: 1 }),
  lock_rotation: t.bool({ default: false }),
  /** 3D: translation axes held still. */
  lock_axes: t.list({ kind: 'enum', values: ['x', 'y', 'z'] }, { default: [] }),
  /** Rotation axes held still ("y" alone: a piece on a flat board spins only about the vertical). 2D: "z" locks rotation. */
  lock_rotation_axes: t.list({ kind: 'enum', values: ['x', 'y', 'z'] }, { default: [] }),
  continuous: t.bool({ default: false }),
};

/** 'circle' is accepted by the schema (it is the SDK's shared enum) and refused in 3D with a fix. */
export function colliderSchema(layers: LayerTable): Schema {
  return {
    shape: t.enum([...SHAPES_3D, 'circle'], { default: 'box' }),
    size: t.vec3({ default: Vec3.ONE }),
    radius: t.number({ default: 0.5, min: 0 }),
    height: t.number({ default: 1, min: 0 }),
    offset: t.vec3({ default: Vec3.ZERO }),
    trigger: t.bool({ default: false }),
    layer: t.string({ default: DEFAULT_LAYER }),
    /** Default: every declared layer. */
    collides_with: t.list({ kind: 'string' }, { default: [...layers.names] }),
    friction: t.number({ default: 0.5, min: 0 }),
    /** Restitution; a contact bounces with the larger of its two colliders' values. */
    bounce: t.number({ default: 0, min: 0 }),
    /** A declared surface material: its friction and bounce replace the two fields above. */
    material: MATERIAL_FIELD,
  };
}

type Sim = () => Physics3dSim;

/** `teleport(rotation=)`: euler degrees (Vec3) or a Quat in 3D. */
function rotationArg(value: unknown): Quat | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Quat) return value;
  if (value instanceof Vec3) return Quat.from_euler(value);
  return fail('PP3153', `teleport(rotation=) must be euler degrees (Vec3) in 3D, got ${describe(value)}`, {
    fix: 'Pass rotation=vec3(pitch, yaw, roll), e.g. vec3(0, 90, 0).',
  });
}

function withEntity(kernel: () => Kernel, methods: object): object {
  const base = {
    get entity(): unknown {
      return kernel().handles.wrap(componentEntity(this as unknown as Fields));
    },
  };
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(methods));
}

/** Rigidbody's methods; `this` is the component's fields, bound to its entity by the kernel. */
function rigidbodyMethods(sim: Sim): object {
  return {
    get velocity(): Vec3 {
      return sim().velocity(componentEntity(this as unknown as Fields));
    },
    set velocity(value: unknown) {
      sim().setVelocity(componentEntity(this as unknown as Fields), vec3(value, 'velocity'));
    },
    get speed(): number {
      const v = sim().velocity(componentEntity(this as unknown as Fields));
      return Math.hypot(v.x, v.y, v.z);
    },
    impulse(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'impulse', ['impulse', 'at']);
      const at = k['at'];
      sim().applyImpulse(componentEntity(this), vec3(arg(p, k, 0, 'impulse'), 'impulse'),
        at === undefined || at === null ? undefined : vec3(at, 'impulse(at=)'));
    },
    force(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'force', ['force']);
      sim().applyForce(componentEntity(this), vec3(arg(p, k, 0, 'force'), 'force'), undefined);
    },
    teleport(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'teleport', ['position', 'rotation', 'keep_velocity']);
      const position = vec3(arg(p, k, 0, 'position'), 'teleport position');
      sim().teleport(componentEntity(this), position, rotationArg(arg(p, k, 1, 'rotation')), arg(p, k, 2, 'keep_velocity') === true);
    },
  };
}

/** Joint's readouts and `detach`; `this` is the component's fields. */
function jointMethods(sim: Sim): object {
  const self = (fields: unknown): EntityId => componentEntity(fields as Fields);
  return {
    get angle(): number | null {
      return sim().joints.angle(self(this)) ?? null;
    },
    get position(): number | null {
      return sim().joints.position(self(this)) ?? null;
    },
    get distance(): number | null {
      return sim().joints.distance(self(this)) ?? null;
    },
    get load(): number {
      return sim().joints.load(self(this));
    },
    detach(this: Fields, ...args: unknown[]): void {
      if (splitKeywords(args, 'detach', []).positional.length > 0) fail('PP3030', 'detach() takes no arguments');
      sim().joints.detach(componentEntity(this));
    },
  };
}

/** Ragdoll's state and controls; `this` is the component's fields. */
function ragdollMethods(sim: Sim): object {
  return {
    get mode(): string | null {
      return sim().ragdolls.mode(componentEntity(this as unknown as Fields)) ?? null;
    },
    get weight(): number {
      return sim().ragdolls.weight(componentEntity(this as unknown as Fields));
    },
    go_limp(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'go_limp', ['impulse', 'at']);
      const impulse = arg(p, k, 0, 'impulse');
      const at = arg(p, k, 1, 'at');
      sim().ragdolls.limp(componentEntity(this),
        impulse === undefined || impulse === null ? undefined : vec3(impulse, 'go_limp impulse'),
        at === undefined || at === null ? undefined : vec3(at, 'go_limp(at=)'));
    },
    activate(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'activate', ['strength']);
      const strength = arg(p, k, 0, 'strength');
      sim().ragdolls.activate(componentEntity(this), strength === undefined ? undefined : finite(strength, 'activate strength'));
    },
    recover(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'recover', ['blend']);
      const blend = arg(p, k, 0, 'blend');
      sim().ragdolls.recover(componentEntity(this), blend === undefined ? undefined : finite(blend, 'recover blend'));
    },
  };
}

export function physicsComponents(layers: LayerTable, sim: Sim, kernel: () => Kernel): ComponentDef[] {
  return [
    { id: RIGIDBODY, schema: RIGIDBODY_SCHEMA, methods: withEntity(kernel, rigidbodyMethods(sim)) },
    { id: COLLIDER, schema: colliderSchema(layers), methods: withEntity(kernel, {}) },
    { id: JOINT, schema: JOINT_SCHEMA, methods: withEntity(kernel, jointMethods(sim)) },
    { id: FORCE_FIELD, schema: FORCE_FIELD_SCHEMA, methods: withEntity(kernel, {}) },
    { id: RAGDOLL, schema: RAGDOLL_SCHEMA, methods: withEntity(kernel, ragdollMethods(sim)) },
  ];
}
