/**
 * Lag compensation: a hit test as the shooter saw the world.
 *
 * A client draws other entities in the past (its interpolation delay, plus the time its
 * input takes to arrive). It tells the server, with every input and RPC, the server time it
 * was showing (`view`). The server keeps the world poses of every entity whose transform
 * replicates for the last `window` seconds; a compensated raycast rewinds those entities to
 * the shooter's view time and tests the ray against their collider bounds there. The
 * static world (anything whose transform doesn't replicate, and the terrain) blocks the
 * ray where it is now, through the physics service.
 *
 * The rewind is capped (`window`), so a client can't claim an arbitrarily old view; a ray
 * starting inside a hitbox counts only when it points into it (no hits behind the muzzle).
 */

import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { slerp } from './interpolation.js';

interface Frame {
  readonly t: number;
  readonly poses: ReadonlyMap<EntityId, { readonly position: Vec3; readonly rotation: Quat }>;
}

export interface RewoundPose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/** World poses of moving entities over the last `window` seconds. */
export class PoseHistory {
  readonly #frames: Frame[] = [];
  readonly window: number;

  constructor(window: number) {
    this.window = window;
  }

  get oldest(): number | undefined { return this.#frames[0]?.t; }
  get newest(): number | undefined { return this.#frames[this.#frames.length - 1]?.t; }

  record(t: number, poses: ReadonlyMap<EntityId, RewoundPose>): void {
    const last = this.#frames[this.#frames.length - 1];
    if (last !== undefined && last.t >= t) this.#frames.pop();
    this.#frames.push({ t, poses });
    // Keep one frame older than the window, so the window's start can be interpolated.
    while (this.#frames.length > 2 && this.#frames[1]!.t < t - this.window) this.#frames.shift();
  }

  /** Entities in the newest frame. */
  ids(): EntityId[] {
    const last = this.#frames[this.#frames.length - 1];
    return last === undefined ? [] : [...last.poses.keys()];
  }

  /** `id`'s pose at time `t` (clamped to the history), or undefined when it wasn't recorded then. */
  at(id: EntityId, t: number): RewoundPose | undefined {
    const frames = this.#frames;
    if (frames.length === 0) return undefined;
    let i = frames.length - 1;
    while (i > 0 && frames[i]!.t > t) i--;
    const a = frames[i]!;
    const b = frames[i + 1];
    const pa = a.poses.get(id);
    if (b === undefined || t <= a.t) return pa ?? (b === undefined ? undefined : b.poses.get(id));
    const pb = b.poses.get(id);
    if (pa === undefined || pb === undefined) return pa ?? pb;
    const k = (t - a.t) / (b.t - a.t);
    return { position: pa.position.lerp(pb.position, k), rotation: slerp(pa.rotation, pb.rotation, k) };
  }

  clear(): void {
    this.#frames.length = 0;
  }
}

export interface BoxHit {
  readonly distance: number;
  readonly normal: Vec3;
}

/**
 * A ray against a box: `center` and `half` extents in the box's local frame, which sits at
 * `position` with `rotation`. `direction` is unit length.
 */
export function rayBox(
  origin: Vec3, direction: Vec3, maxDistance: number, position: Vec3, rotation: Quat, center: Vec3, half: Vec3,
): BoxHit | undefined {
  const inv = rotation.inverse();
  const o = inv.rotate(origin.__sub__(position)).__sub__(center);
  const d = inv.rotate(direction);
  const lo = [-half.x, -half.y, -half.z];
  const hi = [half.x, half.y, half.z];
  const oa = [o.x, o.y, o.z];
  const da = [d.x, d.y, d.z];
  let enter = -Infinity;
  let exit = Infinity;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(da[i]!) < 1e-12) {
      if (oa[i]! < lo[i]! || oa[i]! > hi[i]!) return undefined;
      continue;
    }
    let t1 = (lo[i]! - oa[i]!) / da[i]!;
    let t2 = (hi[i]! - oa[i]!) / da[i]!;
    let s = -1;
    if (t1 > t2) { [t1, t2] = [t2, t1]; s = 1; }
    if (t1 > enter) { enter = t1; axis = i; sign = s; }
    exit = Math.min(exit, t2);
    if (enter > exit) return undefined;
  }
  if (exit < 0 || enter > maxDistance) return undefined;
  if (enter < 0) {
    // Inside the box: a hit only when aiming into it (towards its middle).
    if (o.__neg__().dot(d) <= 0) return undefined;
    return { distance: 0, normal: direction.__neg__() };
  }
  const local = new Vec3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  return { distance: enter, normal: rotation.rotate(local) };
}

/** What a compensated raycast needs to know about the world now. */
export interface HitWorld {
  /** The entity's collider bounds in its body frame (undefined: nothing to hit). */
  bounds(id: EntityId): { readonly center: Vec3; readonly halfExtents: Vec3 } | undefined;
  /** Whether the entity may be hit under this query (layers, ignore, still alive). */
  eligible(id: EntityId): boolean;
  /** Distance to the nearest static hit along the ray, ignoring `moving`; Infinity for none. */
  staticDistance(origin: Vec3, direction: Vec3, maxDistance: number, moving: readonly EntityId[]): { distance: number; entity: EntityId | undefined; point: Vec3; normal: Vec3 } | undefined;
}

export interface CompensatedHit {
  readonly entity: EntityId | undefined;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

/** The nearest hit along the ray with moving entities where they were at `t`. */
export function compensatedRaycast(
  history: PoseHistory, world: HitWorld, t: number, origin: Vec3, direction: Vec3, maxDistance: number,
): CompensatedHit | undefined {
  const dir = direction.normalized();
  const moving = history.ids();
  const blocked = world.staticDistance(origin, dir, maxDistance, moving);
  let best: CompensatedHit | undefined = blocked === undefined
    ? undefined
    : { entity: blocked.entity, point: blocked.point, normal: blocked.normal, distance: blocked.distance };
  for (const id of moving) {
    if (!world.eligible(id)) continue;
    const bounds = world.bounds(id);
    if (bounds === undefined) continue;
    const pose = history.at(id, t);
    if (pose === undefined) continue;
    const limit = best?.distance ?? maxDistance;
    const hit = rayBox(origin, dir, limit, pose.position, pose.rotation, bounds.center, bounds.halfExtents);
    if (hit === undefined || hit.distance > limit) continue;
    best = { entity: id, point: origin.__add__(dir.__mul__(hit.distance)), normal: hit.normal, distance: hit.distance };
  }
  return best;
}
