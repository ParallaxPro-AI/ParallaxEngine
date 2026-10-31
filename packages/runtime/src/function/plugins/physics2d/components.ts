/**
 * The `rigidbody` and `collider` components (sdk/parallax/physics.pyi). Collider is shape;
 * Rigidbody is motion. A collider without a rigidbody is static; a rigidbody without a
 * collider moves but touches nothing. Rigidbody's methods act on its Rapier body.
 */

import { fail, Vec3 } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Schema } from '../../kernel/index.js';
import { FORCE_FIELD, FORCE_FIELD_SCHEMA } from './fields.js';
import { JOINT, JOINT_SCHEMA } from './joints.js';
import { DEFAULT_LAYER } from './layers.js';
import { MATERIAL_FIELD } from './materials.js';
import type { LayerTable } from './layers.js';
import { COLLIDER, RIGIDBODY } from './sim.js';
import type { Physics2dSim } from './sim.js';
import { finite, splitKeywords, xy } from './values.js';

/** The 2D shapes. `size` is a box's full width/height; `height` is a capsule's full height (caps included). */
export const SHAPES_2D = ['box', 'circle', 'capsule'] as const;

export const RIGIDBODY_SCHEMA: Schema = {
  kind: t.enum(['dynamic', 'kinematic'], { default: 'dynamic' }),
  mass: t.number({ default: 1, min: 0 }),
  /** Degrees per second; 2D uses z. Kept current by the simulation; assigning sets it. */
  angular_velocity: t.vec3({ default: Vec3.ZERO }),
  linear_damping: t.number({ default: 0, min: 0 }),
  angular_damping: t.number({ default: 0, min: 0 }),
  gravity_scale: t.number({ default: 1 }),
  lock_rotation: t.bool({ default: false }),
  /** 2D: "x"/"y" lock translation, "z" locks rotation. */
  lock_axes: t.list({ kind: 'enum', values: ['x', 'y', 'z'] }, { default: [] }),
  /** Rotation axes held still ("y" alone: a piece on a flat board spins only about the vertical). 2D: "z" locks rotation. */
  lock_rotation_axes: t.list({ kind: 'enum', values: ['x', 'y', 'z'] }, { default: [] }),
  continuous: t.bool({ default: false }),
};

export function colliderSchema(layers: LayerTable): Schema {
  return {
    shape: t.enum(SHAPES_2D, { default: 'box' }),
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

type Sim = () => Physics2dSim;

function dynamicOnly(sim: Physics2dSim, fields: Fields, what: string): void {
  if (sim.kindOf(componentEntity(fields)) !== 'dynamic') {
    fail('PP3304', `${what} acts on dynamic bodies; this rigidbody is kinematic`, {
      fix: 'Move a kinematic body by setting its transform.position (or teleport it), or make it "dynamic".',
    });
  }
}

/** Rigidbody's methods; `this` is the component's fields, bound to its entity by the kernel. */
function rigidbodyMethods(sim: Sim): object {
  return {
    get velocity(): Vec3 {
      return sim().velocity(componentEntity(this as unknown as Fields));
    },
    set velocity(value: unknown) {
      sim().setVelocity(componentEntity(this as unknown as Fields), xy(value, 'velocity'));
    },
    get speed(): number {
      const v = sim().velocity(componentEntity(this as unknown as Fields));
      return Math.hypot(v.x, v.y);
    },
    impulse(this: Fields, ...args: unknown[]): void {
      const { positional, keywords } = splitKeywords(args, 'impulse', ['impulse', 'at']);
      const world = sim();
      const body = world.rigidbody(componentEntity(this));
      dynamicOnly(world, this, 'impulse()');
      const j = xy(positional[0] ?? keywords['impulse'], 'impulse');
      const at = keywords['at'];
      if (at === undefined || at === null) body.applyImpulse(j, true);
      else body.applyImpulseAtPoint(j, xy(at, 'impulse(at=)'), true);
    },
    force(this: Fields, ...args: unknown[]): void {
      const { positional, keywords } = splitKeywords(args, 'force', ['force']);
      const world = sim();
      const entity = componentEntity(this);
      const body = world.rigidbody(entity);
      dynamicOnly(world, this, 'force()');
      body.addForce(xy(positional[0] ?? keywords['force'], 'force'), true);
      world.markForced(entity);
    },
    teleport(this: Fields, ...args: unknown[]): void {
      const { positional, keywords } = splitKeywords(args, 'teleport', ['position', 'rotation', 'keep_velocity']);
      const at = xy(positional[0] ?? keywords['position'], 'teleport position');
      const rotation = keywords['rotation'];
      let angle: number | undefined;
      if (rotation === undefined || rotation === null) angle = undefined;
      else if (rotation instanceof Vec3) angle = rotation.z;
      else angle = finite(rotation, 'teleport(rotation=)');
      sim().teleport(componentEntity(this), at, angle, keywords['keep_velocity'] === true);
    },
  };
}

/** Joint's readouts and `detach`; `this` is the component's fields. */
function jointMethods(sim: Sim): object {
  const self = (fields: unknown): ReturnType<typeof componentEntity> => componentEntity(fields as Fields);
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

export function physicsComponents(layers: LayerTable, sim: Sim): ComponentDef[] {
  return [
    { id: RIGIDBODY, schema: RIGIDBODY_SCHEMA, methods: rigidbodyMethods(sim) },
    { id: COLLIDER, schema: colliderSchema(layers) },
    { id: JOINT, schema: JOINT_SCHEMA, methods: jointMethods(sim) },
    { id: FORCE_FIELD, schema: FORCE_FIELD_SCHEMA },
  ];
}
