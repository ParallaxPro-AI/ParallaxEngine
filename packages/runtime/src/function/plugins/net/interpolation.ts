/**
 * Showing other players' entities smoothly from snapshots that arrive late, unevenly or
 * not at all: the client draws the world as it was a little in the past (the interpolation
 * delay), between two snapshots it already has.
 *
 *   ServerClock   estimates the server's wall clock from snapshot stamps. Arrival offsets
 *                 are smoothed, their spread is the jitter, and the clock the client renders
 *                 by slews toward the estimate (at most 5% fast or slow), so time never
 *                 jumps — except after a stall of more than SNAP_AFTER seconds.
 *   PoseBuffers   a short history of poses per entity; `sample(t)` interpolates position
 *                 (lerp), rotation (slerp) and scale, extrapolates a little past the newest
 *                 sample when the next one is late, and holds after that.
 */

import { Quat, Vec3 } from '../../../core/index.js';

/** A clock error larger than this resets the estimate instead of slewing. */
const SNAP_AFTER = 0.25;
/** The render clock runs at most this much fast or slow while catching up. */
const SLEW = 0.05;
/** Smoothing of the offset and jitter estimates per snapshot. */
const SMOOTHING = 0.05;
/** Seconds of history kept per entity. */
const HISTORY = 1;

export interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export interface ClockOptions {
  /** Seconds between snapshots (1 / tick rate). */
  readonly interval: number;
  /** Fixed interpolation delay in seconds; undefined: two intervals plus twice the jitter. */
  readonly delay?: number;
}

export class ServerClock {
  readonly #interval: number;
  readonly #fixedDelay: number | undefined;
  /** Smoothed (server time − local time) at arrival. */
  #offset: number | undefined;
  #jitter = 0;
  /** What render time currently adds to local time (slews toward offset − delay). */
  #render = 0;
  #lastLocal = 0;

  constructor(options: ClockOptions) {
    this.#interval = options.interval;
    this.#fixedDelay = options.delay;
  }

  get ready(): boolean { return this.#offset !== undefined; }
  get jitter(): number { return this.#jitter; }

  /** The interpolation delay now in use. */
  get delay(): number {
    return this.#fixedDelay ?? Math.min(0.5, 2 * this.#interval + 2 * this.#jitter);
  }

  /** A snapshot stamped `serverTime` arrived at local time `local`. */
  observe(serverTime: number, local: number): void {
    const sample = serverTime - local;
    if (this.#offset === undefined || Math.abs(sample - this.#offset) > SNAP_AFTER) {
      this.#offset = sample;
      this.#jitter = 0;
      this.#render = sample - this.delay;
      this.#lastLocal = local;
      return;
    }
    const error = sample - this.#offset;
    this.#offset += error * SMOOTHING;
    this.#jitter += (Math.abs(error) - this.#jitter) * SMOOTHING;
  }

  /** The estimated server time now (no delay): what the server's clock reads at `local`. */
  serverNow(local: number): number {
    return local + (this.#offset ?? 0);
  }

  /** The server time to show at local time `local` (call once per frame, in order). */
  renderTime(local: number): number {
    if (this.#offset === undefined) return 0;
    const target = this.#offset - this.delay;
    const dt = Math.max(0, local - this.#lastLocal);
    this.#lastLocal = local;
    const gap = target - this.#render;
    if (Math.abs(gap) > SNAP_AFTER) this.#render = target;
    else this.#render += Math.max(-SLEW * dt, Math.min(SLEW * dt, gap));
    return local + this.#render;
  }

  reset(): void {
    this.#offset = undefined;
    this.#jitter = 0;
    this.#render = 0;
  }
}

/** Spherical interpolation between unit quaternions (shortest arc). */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let wa: number, wb: number;
  if (dot > 0.9995) {
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const sin = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sin;
    wb = Math.sin(t * theta) / sin;
  }
  const x = wa * a.x + wb * bx, y = wa * a.y + wb * by, z = wa * a.z + wb * bz, w = wa * a.w + wb * bw;
  const n = Math.hypot(x, y, z, w) || 1;
  return new Quat(x / n, y / n, z / n, w / n);
}

interface Sample extends Pose {
  readonly t: number;
}

export class PoseBuffers {
  readonly #samples = new Map<number, Sample[]>();
  /** Most seconds to extrapolate past the newest sample. */
  readonly maxExtrapolation: number;

  constructor(maxExtrapolation: number) {
    this.maxExtrapolation = maxExtrapolation;
  }

  push(id: number, t: number, pose: Pose): void {
    let list = this.#samples.get(id);
    if (list === undefined) this.#samples.set(id, (list = []));
    // Snapshots arrive in tick order (older ones are dropped before this), but be exact anyway.
    let at = list.length;
    while (at > 0 && list[at - 1]!.t >= t) at--;
    if (at < list.length && list[at]!.t === t) list[at] = { t, ...pose };
    else list.splice(at, 0, { t, ...pose });
    while (list.length > 2 && list[1]!.t < t - HISTORY) list.shift();
  }

  has(id: number): boolean {
    return this.#samples.has(id);
  }

  /** The pose at server time `t`, or undefined when there is no sample. */
  sample(id: number, t: number): Pose | undefined {
    const list = this.#samples.get(id);
    if (list === undefined || list.length === 0) return undefined;
    const first = list[0]!;
    if (list.length === 1 || t <= first.t) return first;
    const last = list[list.length - 1]!;
    if (t >= last.t) {
      const prev = list[list.length - 2]!;
      const ahead = Math.min(t - last.t, this.maxExtrapolation);
      const span = last.t - prev.t;
      if (ahead <= 0 || span <= 0) return last;
      // Position only: rotations and scale hold (a guessed turn reads worse than a pause).
      const k = ahead / span;
      return { position: last.position.__add__(last.position.__sub__(prev.position).__mul__(k)), rotation: last.rotation, scale: last.scale };
    }
    let i = list.length - 2;
    while (i > 0 && list[i]!.t > t) i--;
    const a = list[i]!;
    const b = list[i + 1]!;
    const k = (t - a.t) / (b.t - a.t);
    return { position: a.position.lerp(b.position, k), rotation: slerp(a.rotation, b.rotation, k), scale: a.scale.lerp(b.scale, k) };
  }

  forget(id: number): void {
    this.#samples.delete(id);
  }

  reset(): void {
    this.#samples.clear();
  }
}
