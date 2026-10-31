/**
 * Force fields (the `force_field` component): wind tunnels, updrafts, conveyor pushes,
 * attractors, repulsors and whirlpools. Each fixed step, before the world steps, a field
 * pushes the dynamic bodies in its region:
 *
 *   region     inside the entity's trigger Collider when it has one (what the trigger held
 *              after the last step); else bodies whose centre of mass is within `radius` of
 *              the entity; with neither, everywhere
 *   directional along `direction` (the entity's local space)
 *   radial     away from the entity (negative strength: towards it)
 *   vortex     around the axis `direction` through the entity, counter-clockwise seen
 *              from its tip
 *
 * `strength` is an acceleration in m/s² (every mass moves alike, as under gravity) or, with
 * `mode="force"`, newtons. `falloff` scales it by distance from the entity: "linear" to 0
 * at `radius`; "inverse_square" as 1/d² (d in meters, at least 1). Fields hold no state
 * of their own: everything is in the component.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { EntityRecord, Fields, Kernel, Schema } from '../../kernel/index.js';
import type { LayerTable } from './layers.js';

export const FORCE_FIELD = 'force_field';

export const FORCE_FIELD_SCHEMA: Schema = {
  kind: t.enum(['directional', 'radial', 'vortex'], { default: 'directional' }),
  strength: t.number({ default: 10 }),
  mode: t.enum(['acceleration', 'force'], { default: 'acceleration' }),
  direction: t.vec3({ default: new Vec3(0, 1, 0) }),
  radius: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
  falloff: t.enum(['none', 'linear', 'inverse_square'], { default: 'none' }),
  /** Collision layers it pushes; empty: every layer. */
  layers: t.list({ kind: 'string' }, { default: [] }),
  enabled: t.bool({ default: true }),
};

export interface FieldTarget {
  readonly entity: EntityId;
  readonly body: RAPIER.RigidBody;
  /** Layer bit of its collider; 0 without one (pushed only by fields that name no layers). */
  readonly layerBit: number;
}

export interface FieldHost {
  readonly kernel: Kernel;
  readonly world: RAPIER.World;
  readonly layers: LayerTable;
  /** Dynamic bodies, in creation order. */
  dynamicBodies(): readonly FieldTarget[];
  /** The entity's own Collider, when it has one. */
  colliderOf(entity: EntityId): RAPIER.Collider | undefined;
  /** The dynamic body a collider belongs to. */
  targetOf(collider: RAPIER.Collider): FieldTarget | undefined;
  markForced(entity: EntityId): void;
  where(record: EntityRecord, component: string): string;
}

export function applyFields(host: FieldHost, fields: ReadonlySet<EntityId>): void {
  for (const id of fields) {
    const record = host.kernel.world.get(id);
    const field = record?.components.get(FORCE_FIELD);
    if (record === undefined || field === undefined || field['enabled'] !== true) continue;
    applyField(host, record, field);
  }
}

function applyField(host: FieldHost, record: EntityRecord, field: Fields): void {
  const at = host.where(record, 'force_field');
  const kind = field['kind'] as string;
  const strength = field['strength'] as number;
  const radius = field['radius'] as number | null;
  const falloff = field['falloff'] as string;
  if (falloff === 'linear' && radius === null) {
    fail('PP3192', `${at} falls off linearly but has no radius`, { fix: 'Give it a radius, or falloff="none" / "inverse_square".' });
  }
  const mask = host.layers.mask(field['layers'] as readonly string[], `${at}.layers`);
  const center = record.transform.worldPosition();
  const rotation = record.transform.worldRotation();
  const local = field['direction'] as Vec3;
  if (kind !== 'radial' && local.length() === 0) fail('PP3192', `${at}.direction is zero`, { fix: 'Give the push (or vortex axis) a direction.' });
  const direction = kind === 'radial' ? Vec3.ZERO : rotation.rotate(local.normalized());

  const targets: FieldTarget[] = [];
  const collider = host.colliderOf(record.id);
  if (collider !== undefined) {
    if (!collider.isSensor()) {
      fail('PP3192', `${at}: the field's collider is solid, so it would block what it pushes`, { fix: 'Make its collider a trigger ("trigger": true).' });
    }
    const seen = new Set<EntityId>();
    host.world.intersectionPairsWith(collider, (other) => {
      const target = host.targetOf(other);
      if (target !== undefined && !seen.has(target.entity)) {
        seen.add(target.entity);
        targets.push(target);
      }
    });
    const order = new Map(host.dynamicBodies().map((b, i) => [b.entity, i]));
    targets.sort((a, b) => order.get(a.entity)! - order.get(b.entity)!);
  } else if (radius !== null) {
    for (const body of host.dynamicBodies()) {
      const p = body.body.worldCom();
      if (Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) <= radius) targets.push(body);
    }
  } else {
    targets.push(...host.dynamicBodies());
  }

  for (const target of targets) {
    if (target.entity === record.id) continue;
    if (mask !== 0 && (target.layerBit & mask) === 0) continue;
    const p = target.body.worldCom();
    const offset = new Vec3(p.x - center.x, p.y - center.y, p.z - center.z);
    const d = offset.length();
    let scale = 1;
    if (falloff === 'linear') scale = Math.max(0, 1 - d / radius!);
    else if (falloff === 'inverse_square') scale = 1 / Math.max(1, d * d);
    if (scale === 0) continue;
    let push: Vec3;
    if (kind === 'directional') {
      push = direction;
    } else if (kind === 'radial') {
      if (d === 0) continue;
      push = offset.__mul__(1 / d);
    } else {
      // Tangent of the circle about the axis through the field: axis × (offset off the axis).
      const radial = offset.__sub__(direction.__mul__(offset.dot(direction)));
      const r = radial.length();
      if (r === 0) continue;
      push = direction.cross(radial).__mul__(1 / r);
    }
    const magnitude = strength * scale * (field['mode'] === 'force' ? 1 : target.body.mass());
    target.body.addForce({ x: push.x * magnitude, y: push.y * magnitude, z: push.z * magnitude }, true);
    host.markForced(target.entity);
  }
}
