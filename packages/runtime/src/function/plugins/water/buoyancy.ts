/**
 * Buoyancy: Archimedes and water drag on a physics3d body, one fixed step at a time.
 *
 * The body's collider box is cut into `samples × 2 × samples` cells (x, y, z in its own
 * frame), each holding an equal share of its `volume` (the box's, or the field). A cell
 * under the surface — waves included, at its own spot — is pushed up by the weight of the
 * water it displaces (ρ·g·V), at the cell, so a hull rights itself and rides the swell; a
 * cell partly under is pushed by its submerged fraction (linear over the cell's height, so
 * the total is exactly proportional to the draft: a box half as dense as the water floats
 * half under). Each submerged cell also drags against the water's own motion (currents):
 * `drag` per second, on the body's mass share at the cell, in proportion to how submerged
 * it is; and the spin decays at `angular_drag` per second times the submerged fraction.
 * Forces go in as impulses over the step (F·dt), whichever side of physics3d's step the
 * water plugin's hook runs on, so the motion lives in the body's velocity and snapshots
 * between steps lose nothing.
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { Fields, Schema } from '../../kernel/index.js';
import type { Physics3dService } from '../../services/index.js';

export const BUOYANCY = 'buoyancy';

export const BUOYANCY_SCHEMA: Schema = {
  /** m³ of water the body displaces fully under; None: its collider's box. */
  volume: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
  /** Sample cells along its x and z (and two layers in y). */
  samples: t.int({ default: 3, min: 1, max: 8 }),
  /** 1/s: how fast the water takes up the body's motion relative to it. */
  drag: t.number({ default: 0.8, min: 0 }),
  angular_drag: t.number({ default: 1, min: 0 }),
  /** Read-only: 0..1 of the volume under the surface after the last step. */
  submerged: t.number({ default: 0, min: 0, max: 1 }),
};

/** What the water is at a point: its surface height there, current and density. */
export interface WaterHere {
  readonly surface: number;
  readonly flow: Vec3;
  readonly density: number;
}

export interface FloatResult {
  readonly submerged: number;
  /** Where the submerged volume's center is (undefined when dry). */
  readonly center: Vec3 | undefined;
}

const DEG = Math.PI / 180;

/** Push one body for this step. `water` answers for a world point (undefined: dry). */
export function float(
  physics: Physics3dService, entity: EntityId, fields: Fields, water: (p: Vec3) => WaterHere | undefined, dt: number,
): FloatResult {
  const body = physics.body(entity);
  if (body === undefined || body.kind !== 'dynamic') {
    fail('PP3371', `Buoyancy on entity ${entity} needs a dynamic Rigidbody`, { fix: 'Give the entity a rigidbody (and a collider) so the water can push it.' });
  }
  const bounds = physics.bounds(entity);
  if (bounds === undefined) fail('PP3371', `Buoyancy on entity ${entity} needs a Collider to know its shape`, { fix: 'Add a collider (a box around the hull works best).' });
  const n = fields['samples'] as number;
  const h = bounds.halfExtents;
  const volume = (fields['volume'] as number | null) ?? 8 * h.x * h.y * h.z;
  const cells = n * n * 2;
  const cellVolume = volume / cells;
  const cellHeight = h.y;
  const massShare = body.mass / cells;
  const drag = fields['drag'] as number;
  const g = Math.abs(physics.gravity);
  const w = body.angularVelocity.__mul__(DEG);
  let under = 0;
  let cx = 0; let cy = 0; let cz = 0;
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < 2; iy++) {
      for (let iz = 0; iz < n; iz++) {
        const local = new Vec3(
          bounds.center.x + (((ix + 0.5) / n) * 2 - 1) * h.x,
          bounds.center.y + (iy - 0.5) * h.y,
          bounds.center.z + (((iz + 0.5) / n) * 2 - 1) * h.z,
        );
        const r = body.rotation.rotate(local);
        const p = body.position.__add__(r);
        const here = water(p);
        if (here === undefined) continue;
        const f = Math.min(1, Math.max(0, (here.surface - (p.y - cellHeight / 2)) / cellHeight));
        if (f <= 0) continue;
        under += f;
        cx += p.x * f; cy += p.y * f; cz += p.z * f;
        const lift = here.density * g * cellVolume * f;
        const pointVelocity = body.velocity.__add__(w.cross(r));
        const relative = pointVelocity.__sub__(here.flow);
        const k = drag * massShare * f;
        // As an impulse over the step: velocity is state, so a snapshot between steps holds it (a pending force would not).
        physics.applyImpulse(entity, new Vec3(-relative.x * k * dt, (lift - relative.y * k) * dt, -relative.z * k * dt), p);
      }
    }
  }
  const submerged = under / cells;
  if (submerged > 0) {
    const decay = Math.exp(-(fields['angular_drag'] as number) * submerged * dt);
    physics.setAngularVelocity(entity, body.angularVelocity.__mul__(decay));
  }
  fields['submerged'] = submerged;
  return { submerged, center: under > 0 ? new Vec3(cx / under, cy / under, cz / under) : undefined };
}
