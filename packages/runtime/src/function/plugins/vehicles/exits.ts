/**
 * Where a rider is put down on `exit()`: the first clear exit point. Candidates are the
 * Vehicle's `exits` (chassis-frame points at the rider's feet, in order) or, without any,
 * beside the rider's seat side (left for seats on the left or centre), the other side,
 * behind, and finally the roof. A point is clear when a 0.35 m sphere at knee and at head
 * height touches nothing but the vehicle and the rider, and there is ground (or a deck)
 * within 3 m under it; the roof needs no ground. A vehicle parked against a wall lets its
 * driver out on the open side; one boxed in on every side lets them climb out on top.
 */

import { Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { BodyState, LocalBounds, Physics3dService } from '../../services/index.js';

const CLEARANCE = 0.35;

export function exitCandidates(bounds: LocalBounds, seat: Vec3, exits: readonly Vec3[]): Vec3[] {
  if (exits.length > 0) return [...exits];
  const { center: c, halfExtents: h } = bounds;
  const feet = c.y - h.y;
  const left = new Vec3(c.x - h.x - 0.8, feet, seat.z);
  const right = new Vec3(c.x + h.x + 0.8, feet, seat.z);
  const sides = seat.x > c.x + 0.05 ? [right, left] : [left, right];
  return [...sides, new Vec3(c.x, feet, c.z - h.z - 1), roofOf(bounds)];
}

export function roofOf(bounds: LocalBounds): Vec3 {
  return new Vec3(bounds.center.x, bounds.center.y + bounds.halfExtents.y + 0.05, bounds.center.z);
}

/**
 * The world points a rider may stand up at, in order, that have ground (or a deck) under
 * them; the roof always comes last. A character leaving its vehicle seat tries these with
 * its own capsule (the `seat_exits` service).
 */
export function groundedExits(
  service: Physics3dService, vehicle: EntityId, rider: EntityId, body: BodyState, bounds: LocalBounds, seat: Vec3,
  exits: readonly Vec3[],
): Vec3[] {
  const ignore = [vehicle, rider];
  const roof = roofOf(bounds);
  const out: Vec3[] = [];
  for (const local of exitCandidates(bounds, seat, exits)) {
    if (local.distance_to(roof) < 1e-6) continue;
    const at = body.position.__add__(body.rotation.rotate(local));
    if (service.raycast(at.__add__(new Vec3(0, 0.5, 0)), Vec3.DOWN, 3.5, { ignore }) !== undefined) out.push(at);
  }
  out.push(body.position.__add__(body.rotation.rotate(roof)));
  return out;
}

/** The world point to put the rider at. */
export function chooseExit(
  service: Physics3dService, vehicle: EntityId, rider: EntityId, body: BodyState, bounds: LocalBounds, seat: Vec3,
  exits: readonly Vec3[],
): Vec3 {
  const ignore = [vehicle, rider];
  const roof = roofOf(bounds);
  for (const local of exitCandidates(bounds, seat, exits)) {
    const at = body.position.__add__(body.rotation.rotate(local));
    const isRoof = local.distance_to(roof) < 1e-6;
    const blocked = [0.6, 1.5].some((y) => service.overlapSphere(at.__add__(new Vec3(0, y, 0)), CLEARANCE, { ignore }).length > 0);
    if (blocked) continue;
    if (!isRoof && service.raycast(at.__add__(new Vec3(0, 0.5, 0)), Vec3.DOWN, 3.5, { ignore }) === undefined) continue;
    return at;
  }
  return body.position.__add__(body.rotation.rotate(roof));
}
