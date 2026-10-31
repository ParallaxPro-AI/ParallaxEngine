/**
 * Geometry questions a humanoid asks the 3D world (through the physics3d service): does a
 * capsule fit here, how much air is below, and is there a ledge ahead to vault or climb.
 * Pure functions over the service; nothing here moves anything.
 *
 * Ledges. From the feet `p`, facing a unit horizontal `dir`:
 *
 *   1. a sphere swept forward at knee height (just above `step_height`) finds a wall within
 *      `reach` of the capsule — a surface steeper than walkable;
 *   2. a ray down from above the ledge, just past the wall's face, finds its top: the ledge
 *      height above the feet must be above `step_height` and at most `climb_height`;
 *   3. thin and low (≤ vault_height, and the top has dropped away again `vault_depth` past
 *      the face): a vault, landing on the floor beyond; otherwise a climb onto the top;
 *   4. the standing capsule must fit where it lands.
 */

import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Physics3dService } from '../../services/index.js';
import type { Traversal } from './schemas.js';

/** Clearance kept between a probe and what it tests against. */
const SKIN = 0.02;

/** Whether a standing capsule (feet at `feet`) overlaps nothing solid but `self` (and what physics ignores). */
export function capsuleFits(service: Physics3dService, self: EntityId, feet: Vec3, radius: number, height: number): boolean {
  const center = feet.__add__(new Vec3(0, height / 2 + SKIN, 0));
  const hit = service.shapecast({ kind: 'capsule', radius, height: Math.max(height - SKIN, 2 * radius) }, center, Quat.IDENTITY, Vec3.UP, 1e-3,
    { ignore: [self] });
  return hit === undefined;
}

/** Room to grow from `from` meters tall to `to` (feet staying put): a sphere swept up from the top of the shorter capsule. */
export function headroom(service: Physics3dService, self: EntityId, feet: Vec3, radius: number, from: number, to: number): boolean {
  if (to <= from) return true;
  const r = radius * 0.95;
  const start = feet.__add__(new Vec3(0, from - radius, 0));
  return service.shapecast({ kind: 'sphere', radius: r }, start, Quat.IDENTITY, Vec3.UP, to - from, { ignore: [self] }) === undefined;
}

/** Meters of air below the feet, up to `max` (Infinity when nothing is within it). */
export function airBelow(service: Physics3dService, self: EntityId, feet: Vec3, max: number): number {
  const hit = service.raycast(feet.__add__(new Vec3(0, 0.05, 0)), Vec3.DOWN, max + 0.05, { ignore: [self] });
  return hit === undefined ? Infinity : Math.max(0, hit.distance - 0.05);
}

export interface Ledge {
  readonly kind: 'vault' | 'climb';
  /** The ledge top above the feet. */
  readonly height: number;
  /** World y of the top. */
  readonly top: number;
  /** Where the feet land. */
  readonly landing: Vec3;
  /** Horizontal distance from the feet to the wall's face. */
  readonly face: number;
}

export interface LedgeBody {
  readonly radius: number;
  readonly height: number;
  readonly stepHeight: number;
}

/** `vault` false: only climbs (out of water, where there is no floor to vault to). */
export function findLedge(service: Physics3dService, self: EntityId, feet: Vec3, dir: Vec3, body: LedgeBody, traversal: Traversal,
  vault = true): Ledge | undefined {
  const r = body.radius;
  const probe = r * 0.5;
  // 1. A wall ahead, at knee height.
  const knee = feet.__add__(new Vec3(0, body.stepHeight + probe + SKIN, 0));
  const wall = service.shapecast({ kind: 'sphere', radius: probe }, knee, Quat.IDENTITY, dir, r - probe + traversal.reach, { ignore: [self] });
  if (wall === undefined || Math.abs(wall.normal.y) > 0.7) return undefined;
  const face = wall.distance + probe;
  // 2. Its top, just past the face.
  const above = traversal.climb_height + 0.3;
  const edge = feet.__add__(dir.__mul__(face + 0.05));
  const topHit = service.raycast(edge.__add__(new Vec3(0, above, 0)), Vec3.DOWN, above - body.stepHeight, { ignore: [self] });
  if (topHit === undefined || topHit.normal.y < 0.7) return undefined;
  const top = topHit.point.y;
  const height = top - feet.y;
  if (height <= body.stepHeight || height > traversal.climb_height) return undefined;
  // Nothing in the way of reaching up to it: the space over the feet up to the top.
  if (!headroom(service, self, feet, r, body.height, Math.max(body.height, height + body.height * 0.5))) return undefined;
  // 3. Thin and low: vault over to the floor beyond.
  if (vault && height <= traversal.vault_height) {
    const beyond = feet.__add__(dir.__mul__(face + traversal.vault_depth + r + SKIN));
    const far = service.raycast(beyond.__add__(new Vec3(0, height + 0.2, 0)), Vec3.DOWN, height + 0.2 + body.stepHeight + 1, { ignore: [self] });
    if (far !== undefined && far.normal.y >= 0.7 && far.point.y < top - body.stepHeight) {
      const landing = new Vec3(beyond.x, far.point.y, beyond.z);
      if (capsuleFits(service, self, landing, r, body.height)) return { kind: 'vault', height, top, landing, face };
    }
  }
  // 4. Climb onto the top: deep enough to stand on, with room.
  const onTop = feet.__add__(dir.__mul__(face + r + SKIN));
  const stand = service.raycast(onTop.__add__(new Vec3(0, height + 0.2, 0)), Vec3.DOWN, 0.2 + body.stepHeight, { ignore: [self] });
  if (stand === undefined || stand.normal.y < 0.7) return undefined;
  const landing = new Vec3(onTop.x, stand.point.y, onTop.z);
  if (!capsuleFits(service, self, landing, r, body.height)) return undefined;
  return { kind: 'climb', height, top, landing, face };
}

/** A traversal's path: a quadratic Bézier from the feet to the landing through `control`. */
export function traversalControl(feet: Vec3, ledge: Ledge, dir: Vec3): Vec3 {
  const clear = ledge.top + 0.12;
  if (ledge.kind === 'climb') {
    // Up first (hands on the edge), then over: the control sits above the feet at the top's height.
    return new Vec3(feet.x, clear + (clear - feet.y) * 0.25, feet.z);
  }
  // A vault arcs over the face: control chosen so the path's midpoint just clears the top.
  const over = feet.__add__(dir.__mul__(ledge.face + 0.1));
  return new Vec3(over.x, 2 * clear - (feet.y + ledge.landing.y) / 2, over.z);
}

export function bezier(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const u = 1 - t;
  return a.__mul__(u * u).__add__(c.__mul__(2 * u * t)).__add__(b.__mul__(t * t));
}

export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
