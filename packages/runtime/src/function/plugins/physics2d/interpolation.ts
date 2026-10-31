/**
 * Render interpolation in 2D (the `render_pose` service, function/services/poses.ts); the same
 * rules as physics3d's.
 *
 * Every physics-driven entity has a track: its local pose when the fixed step began
 * (`from`) and when the step's physics phase ended (`to`) — after every plugin's 'physics'
 * hook, so characters, vehicles and riders moved by other plugins are caught too. A frame
 * draws `lerp(from, to, time.alpha)`, but only while the transform still holds the very
 * values the physics phase left (the same `Vec3` / `Quat` objects): anything the game
 * moved since is drawn where it is, and starts a fresh track at the next step. A teleport
 * snaps its track (`from = to`), so nothing streaks across the screen.
 *
 * The tracks are presentation only: they are not part of snapshots (a restore snaps every
 * track) and nothing in the simulation reads them.
 */

import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import type { Pose, RenderPoseSource } from '../../services/index.js';

interface Track {
  fromPosition: Vec3;
  fromRotation: Quat;
  toPosition: Vec3;
  toRotation: Quat;
  /** Seen at the last `begin` (tracks not seen are dropped at `end`). */
  live: boolean;
  snap: boolean;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

/** Shortest-path spherical interpolation between unit quaternions. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (dot > 0.9995) {
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sin;
    wb = Math.sin(t * theta) / sin;
  }
  const x = a.x * wa + bx * wb;
  const y = a.y * wa + by * wb;
  const z = a.z * wa + bz * wb;
  const w = a.w * wa + bw * wb;
  const length = Math.hypot(x, y, z, w);
  return new Quat(x / length, y / length, z / length, w / length);
}

export class PoseHistory implements RenderPoseSource {
  readonly #kernel: Kernel;
  readonly #enabled: boolean;
  readonly #tracks = new Map<EntityId, Track>();

  constructor(kernel: Kernel, enabled: boolean) {
    this.#kernel = kernel;
    this.#enabled = enabled;
  }

  /** The fixed step is starting: `entities` are the ones physics moves. */
  begin(entities: Iterable<EntityId>): void {
    if (!this.#enabled) return;
    for (const track of this.#tracks.values()) track.live = false;
    for (const id of entities) {
      const t = this.#kernel.world.get(id)?.transform;
      if (t === undefined) continue;
      const track = this.#tracks.get(id);
      if (track === undefined) {
        this.#tracks.set(id, { fromPosition: t.position, fromRotation: t.rotation, toPosition: t.position, toRotation: t.rotation, live: true, snap: false });
      } else {
        track.fromPosition = t.position;
        track.fromRotation = t.rotation;
        track.live = true;
        track.snap = false;
      }
    }
  }

  /** The physics phase of the step is over: record where everything ended up. */
  end(): void {
    if (!this.#enabled) return;
    for (const [id, track] of this.#tracks) {
      const t = this.#kernel.world.get(id)?.transform;
      if (!track.live || t === undefined) {
        this.#tracks.delete(id);
        continue;
      }
      track.toPosition = t.position;
      track.toRotation = t.rotation;
      if (track.snap) {
        track.fromPosition = t.position;
        track.fromRotation = t.rotation;
      }
    }
  }

  /** The entity jumped (teleport, mount): draw it where it lands, without a streak. */
  snap(entity: EntityId): void {
    const track = this.#tracks.get(entity);
    if (track !== undefined) track.snap = true;
  }

  /** How far the entity moved over the last fixed step, per second (zero without a track). */
  velocity(entity: EntityId, dt: number): Vec3 {
    const track = this.#tracks.get(entity);
    if (track === undefined || !(dt > 0)) return Vec3.ZERO;
    return track.toPosition.__sub__(track.fromPosition).__mul__(1 / dt);
  }

  /** After a restore: every track starts again at the next step. */
  clear(): void {
    this.#tracks.clear();
  }

  local(entity: EntityId): Pose | undefined {
    const track = this.#tracks.get(entity);
    if (track === undefined) return undefined;
    const t = this.#kernel.world.peek(entity)?.transform;
    if (t === undefined || t.position !== track.toPosition || t.rotation !== track.toRotation) return undefined;
    const alpha = this.#kernel.time.alpha;
    if (alpha >= 1 || (track.fromPosition === track.toPosition && track.fromRotation === track.toRotation)) {
      return { position: track.toPosition, rotation: track.toRotation };
    }
    return {
      position: lerpVec3(track.fromPosition, track.toPosition, alpha),
      rotation: track.fromRotation === track.toRotation ? track.toRotation : slerp(track.fromRotation, track.toRotation, alpha),
    };
  }

  world(entity: EntityId): Pose {
    const record = this.#kernel.world.peek(entity);
    if (record === undefined) return { position: Vec3.ZERO, rotation: Quat.IDENTITY };
    const own = this.local(entity) ?? { position: record.transform.position, rotation: record.transform.rotation };
    if (record.parent === null) return own;
    const parent = this.world(record.parent);
    const scale = this.#kernel.world.peek(record.parent)?.transform.worldScale() ?? Vec3.ONE;
    const scaled = new Vec3(own.position.x * scale.x, own.position.y * scale.y, own.position.z * scale.z);
    return { position: parent.position.__add__(parent.rotation.rotate(scaled)), rotation: parent.rotation.__mul__(own.rotation) };
  }
}
