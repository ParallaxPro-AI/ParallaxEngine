/**
 * Delta snapshots of moving entities' poses, over a channel that may lose or reorder them.
 *
 * The server remembers the poses it put in each snapshot it sent a client; the client
 * acknowledges the newest snapshot it reconstructed (in its input). The next snapshot is a
 * delta against that acknowledged one — an entity whose quantized pose is unchanged is left
 * out; a moved one sends its millimetre delta — so a lost snapshot never breaks the chain:
 * every snapshot names its baseline, and the server only names baselines the client has.
 *
 * Both sides hold the same integers (`quantize.ts`), so reconstruction is exact.
 */

import type { PoseWire } from './protocol.js';
import { samePose } from './quantize.js';
import type { QuantPose } from './quantize.js';

/** Snapshots a server remembers per client while waiting for an acknowledgement. */
export const SENT_HISTORY = 64;
/** Reconstructed snapshots a client keeps as possible baselines. */
export const RECEIVED_HISTORY = 64;

const UNIT_SCALE: readonly [number, number, number] = [1, 1, 1];

function unitScale(s: readonly number[]): boolean {
  return s[0] === 1 && s[1] === 1 && s[2] === 1;
}

/** The server's side, one per client view. */
export class SnapshotSender {
  readonly #sent = new Map<number, ReadonlyMap<number, QuantPose>>();
  #baseline: { readonly tick: number; readonly poses: ReadonlyMap<number, QuantPose> } | undefined;

  /** The tick the next snapshot is relative to, or -1. */
  get base(): number { return this.#baseline?.tick ?? -1; }

  /** Poses for snapshot `tick`: what differs from the acknowledged baseline. */
  build(tick: number, current: ReadonlyMap<number, QuantPose>): PoseWire[] {
    const base = this.#baseline?.poses;
    const out: PoseWire[] = [];
    for (const [id, pose] of current) {
      const before = base?.get(id);
      if (before === undefined) {
        out.push({ id, p: pose.p, r: pose.r, ...(!unitScale(pose.s) && { s: pose.s }) });
        continue;
      }
      if (samePose(before, pose)) continue;
      const moved = pose.p[0] !== before.p[0] || pose.p[1] !== before.p[1] || pose.p[2] !== before.p[2];
      const scaled = pose.s[0] !== before.s[0] || pose.s[1] !== before.s[1] || pose.s[2] !== before.s[2];
      out.push({
        id,
        ...(moved && { d: [pose.p[0] - before.p[0], pose.p[1] - before.p[1], pose.p[2] - before.p[2]] as const }),
        ...(pose.r !== before.r && { r: pose.r }),
        ...(scaled && { s: pose.s }),
      });
    }
    this.#sent.set(tick, current);
    if (this.#sent.size > SENT_HISTORY) {
      // The oldest unacknowledged snapshot can no longer become a baseline.
      const oldest = this.#sent.keys().next().value as number;
      this.#sent.delete(oldest);
    }
    return out;
  }

  /** The client reconstructed `tick`: it becomes the baseline (if it is newer and still known). */
  ack(tick: number): void {
    if (tick < 0 || (this.#baseline !== undefined && tick <= this.#baseline.tick)) return;
    const poses = this.#sent.get(tick);
    if (poses === undefined) return;
    this.#baseline = { tick, poses };
    for (const t of [...this.#sent.keys()]) if (t <= tick) this.#sent.delete(t);
  }

  reset(): void {
    this.#sent.clear();
    this.#baseline = undefined;
  }
}

/** The client's side: reconstructed snapshots by tick. */
export class SnapshotReceiver {
  readonly #received = new Map<number, Map<number, QuantPose>>();
  #newest = -1;
  /** Snapshots that named a baseline this client no longer had (dropped, counted for tests). */
  unusable = 0;

  get newest(): number { return this.#newest; }

  /**
   * Reconstruct snapshot `tick` from its baseline. Returns the full pose map, or undefined
   * when it is older than one already reconstructed or its baseline is unknown.
   */
  receive(tick: number, base: number, poses: readonly PoseWire[]): ReadonlyMap<number, QuantPose> | undefined {
    if (tick <= this.#newest) return undefined;
    let from: ReadonlyMap<number, QuantPose> | undefined;
    if (base >= 0) {
      from = this.#received.get(base);
      if (from === undefined) { this.unusable++; return undefined; }
    }
    const out = new Map<number, QuantPose>(from);
    for (const wire of poses) {
      const before = out.get(wire.id);
      let p: readonly [number, number, number];
      if (wire.p !== undefined) p = wire.p;
      else if (wire.d !== undefined && before !== undefined) p = [before.p[0] + wire.d[0], before.p[1] + wire.d[1], before.p[2] + wire.d[2]];
      else if (before !== undefined) p = before.p;
      else { this.unusable++; return undefined; }
      const r = wire.r ?? before?.r;
      if (r === undefined) { this.unusable++; return undefined; }
      out.set(wire.id, { p, r, s: wire.s ?? before?.s ?? UNIT_SCALE });
    }
    this.#received.set(tick, out);
    this.#newest = tick;
    for (const t of [...this.#received.keys()]) if (t <= tick - RECEIVED_HISTORY) this.#received.delete(t);
    return out;
  }

  /** An entity is gone: no baseline mentions it any more. */
  forget(id: number): void {
    for (const map of this.#received.values()) map.delete(id);
  }

  reset(): void {
    this.#received.clear();
    this.#newest = -1;
  }
}
