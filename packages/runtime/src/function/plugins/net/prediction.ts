/**
 * Client-side prediction of the player's own entities, and reconciling with the server.
 *
 * The owner's client runs the game's predicted behaviors on its own entity (`net(predict=)`)
 * with its own input as it is read, so the entity answers at once. Every input frame the
 * client sends gets a sequence number; after the frame the predicted pose is recorded
 * against it. The server reports, in each snapshot, the newest input frame its state
 * includes (`ack`). The difference between the server's pose and the pose recorded for that
 * frame is the prediction error. Every later input's effect is already in the client's pose,
 * so correcting by exactly that error is the replay of the unacknowledged inputs — without
 * re-simulating them.
 *
 * The correction is applied smoothly (exponentially, time constant `smoothing`), or at once
 * when it is larger than `snapDistance` (a teleport, a respawn). Errors inside the dead band
 * (quantization noise) are ignored. Recorded poses include the correction not yet applied,
 * so a correction is never counted twice.
 */

import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { slerp } from './interpolation.js';

export interface PredictionOptions {
  /** Seconds: the time constant of the smooth correction. */
  readonly smoothing: number;
  /** An error longer than this is corrected at once. */
  readonly snapDistance: number;
}

/** Position errors below this (metres) are quantization noise. */
const DEAD_BAND = 0.003;
/** Rotation errors below this (radians) are quantization noise. */
const DEAD_ANGLE = 0.01;
/** Input frames remembered per entity (two seconds at 60 frames). */
const HISTORY = 120;

interface Recorded {
  readonly seq: number;
  position: Vec3;
  rotation: Quat;
}

interface Pending {
  position: Vec3;
  rotation: Quat;
}

export interface Correction {
  readonly position: Vec3;
  readonly rotation: Quat;
}

function angleOf(q: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

export class Prediction {
  readonly #options: PredictionOptions;
  readonly #history = new Map<EntityId, Recorded[]>();
  readonly #pending = new Map<EntityId, Pending>();
  /** Largest error seen by the last reconcile per entity (tests and diagnostics). */
  readonly lastError = new Map<EntityId, number>();
  snaps = 0;

  constructor(options: PredictionOptions) {
    this.#options = options;
  }

  /** After the frame that sent input `seq`: the entity's predicted pose. */
  record(entity: EntityId, seq: number, position: Vec3, rotation: Quat): void {
    let list = this.#history.get(entity);
    if (list === undefined) this.#history.set(entity, (list = []));
    const pending = this.#pending.get(entity);
    const p = pending === undefined ? position : position.__add__(pending.position);
    const q = pending === undefined ? rotation : pending.rotation.__mul__(rotation);
    if (list.length > 0 && list[list.length - 1]!.seq === seq) list[list.length - 1] = { seq, position: p, rotation: q };
    else list.push({ seq, position: p, rotation: q });
    if (list.length > HISTORY) list.shift();
  }

  /**
   * The server's pose for the entity includes input frames up to `ack`. Returns a
   * correction to apply at once (a snap), or undefined (none, or a smooth one pending).
   */
  reconcile(entity: EntityId, ack: number, position: Vec3, rotation: Quat): Correction | undefined {
    const list = this.#history.get(entity);
    if (list === undefined || ack < 0) return undefined;
    let i = list.length - 1;
    while (i >= 0 && list[i]!.seq > ack) i--;
    if (i < 0) return undefined;
    const at = list[i]!;
    list.splice(0, i + 1);
    let error = position.__sub__(at.position);
    let turn = rotation.__mul__(at.rotation.inverse());
    const distance = error.length();
    this.lastError.set(entity, distance);
    if (distance < DEAD_BAND) error = Vec3.ZERO;
    if (angleOf(turn) < DEAD_ANGLE) turn = Quat.IDENTITY;
    if (error === Vec3.ZERO && turn === Quat.IDENTITY) return undefined;
    for (const later of list) {
      later.position = later.position.__add__(error);
      later.rotation = turn.__mul__(later.rotation);
    }
    const pending = this.#pending.get(entity) ?? { position: Vec3.ZERO, rotation: Quat.IDENTITY };
    pending.position = pending.position.__add__(error);
    pending.rotation = turn.__mul__(pending.rotation);
    if (pending.position.length() > this.#options.snapDistance) {
      this.#pending.delete(entity);
      this.snaps++;
      return { position: pending.position, rotation: pending.rotation };
    }
    this.#pending.set(entity, pending);
    return undefined;
  }

  /** The part of the pending correction to apply this frame. */
  step(entity: EntityId, dt: number): Correction | undefined {
    const pending = this.#pending.get(entity);
    if (pending === undefined) return undefined;
    const f = 1 - Math.exp(-dt / this.#options.smoothing);
    const position = pending.position.__mul__(f);
    const rotation = slerp(Quat.IDENTITY, pending.rotation, f);
    pending.position = pending.position.__sub__(position);
    pending.rotation = slerp(Quat.IDENTITY, pending.rotation, 1 - f);
    if (pending.position.length() < DEAD_BAND / 4 && angleOf(pending.rotation) < DEAD_ANGLE / 4) {
      this.#pending.delete(entity);
      return { position: position.__add__(pending.position), rotation: pending.rotation.__mul__(rotation) };
    }
    return { position, rotation };
  }

  /** Correction still to apply (tests). */
  pending(entity: EntityId): Vec3 {
    return this.#pending.get(entity)?.position ?? Vec3.ZERO;
  }

  forget(entity: EntityId): void {
    this.#history.delete(entity);
    this.#pending.delete(entity);
    this.lastError.delete(entity);
  }

  reset(): void {
    this.#history.clear();
    this.#pending.clear();
    this.lastError.clear();
  }

  get entities(): readonly EntityId[] {
    return [...this.#history.keys()];
  }
}
