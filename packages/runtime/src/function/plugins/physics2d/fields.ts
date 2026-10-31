/**
 * Force fields in 2D (the `force_field` component; the same fields as physics3d's): each
 * fixed step, before the world steps, a field pushes the dynamic bodies in its region —
 * inside its entity's trigger Collider (what the trigger held after the last step), else
 * bodies whose centre of mass is within `radius`, else everywhere:
 *
 *   directional along `direction` (x/y, the entity's local space)
 *   radial     away from the entity (negative strength: towards it)
 *   vortex     around the entity, counter-clockwise for positive strength
 *
 * `strength` is m/s² (or N with `mode="force"`), scaled by `falloff` with distance:
 * "linear" to 0 at `radius`, "inverse_square" as 1/d² (d at least 1 m).
 */

import type RAPIER from '@dimforge/rapier2d-compat';
import { fail, rad, Vec3 } from '../../../core/index.js';
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
  layers: t.list({ kind: 'string' }, { default: [] }),
  enabled: t.bool({ default: true }),
};

export interface FieldTarget2d {
  readonly entity: EntityId;
  readonly body: RAPIER.RigidBody;
  readonly layerBit: number;
}

export interface FieldHost2d {
  readonly kernel: Kernel;
  readonly world: RAPIER.World;
  readonly layers: LayerTable;
  dynamicBodies(): readonly FieldTarget2d[];
  colliderOf(entity: EntityId): RAPIER.Collider | undefined;
  targetOf(collider: RAPIER.Collider): FieldTarget2d | undefined;
  markForced(entity: EntityId): void;
  where(record: EntityRecord, component: string): string;
}

export function applyFields(host: FieldHost2d, fields: ReadonlySet<EntityId>): void {
  for (const id of fields) {
    const record = host.kernel.world.get(id);
    const field = record?.components.get(FORCE_FIELD);
    if (record === undefined || field === undefined || field['enabled'] !== true) continue;
    applyField(host, record, field);
  }
}

function applyField(host: FieldHost2d, record: EntityRecord, field: Fields): void {
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
  const angle = rad(record.transform.worldRotation().angle());
  const local = field['direction'] as Vec3;
  if (kind === 'directional' && Math.hypot(local.x, local.y) === 0) fail('PP3192', `${at}.direction has no x/y direction`, { fix: 'Give the push a direction in the plane.' });
  const length = Math.hypot(local.x, local.y) || 1;
  const dir = { x: (local.x * Math.cos(angle) - local.y * Math.sin(angle)) / length, y: (local.x * Math.sin(angle) + local.y * Math.cos(angle)) / length };

  const targets: FieldTarget2d[] = [];
  const collider = host.colliderOf(record.id);
  if (collider !== undefined) {
    if (!collider.isSensor()) {
      fail('PP3192', `${at}: the field's collider is solid, so it would block what it pushes`, { fix: 'Make its collider a trigger ("trigger": true).' });
    }
    const seen = new Set<EntityId>();
    host.world.intersectionPairsWith(collider, (other) => {
      const target = host.targetOf(other);
      if (target !== undefined) seen.add(target.entity);
    });
    for (const body of host.dynamicBodies()) if (seen.has(body.entity)) targets.push(body);
  } else if (radius !== null) {
    for (const body of host.dynamicBodies()) {
      const p = body.body.worldCom();
      if (Math.hypot(p.x - center.x, p.y - center.y) <= radius) targets.push(body);
    }
  } else {
    targets.push(...host.dynamicBodies());
  }

  for (const target of targets) {
    if (target.entity === record.id) continue;
    if (mask !== 0 && (target.layerBit & mask) === 0) continue;
    const p = target.body.worldCom();
    const ox = p.x - center.x;
    const oy = p.y - center.y;
    const d = Math.hypot(ox, oy);
    let scale = 1;
    if (falloff === 'linear') scale = Math.max(0, 1 - d / radius!);
    else if (falloff === 'inverse_square') scale = 1 / Math.max(1, d * d);
    if (scale === 0) continue;
    let push: { x: number; y: number };
    if (kind === 'directional') push = dir;
    else if (d === 0) continue;
    else if (kind === 'radial') push = { x: ox / d, y: oy / d };
    else push = { x: -oy / d, y: ox / d };
    const magnitude = strength * scale * (field['mode'] === 'force' ? 1 : target.body.mass());
    target.body.addForce({ x: push.x * magnitude, y: push.y * magnitude }, true);
    host.markForced(target.entity);
  }
}
