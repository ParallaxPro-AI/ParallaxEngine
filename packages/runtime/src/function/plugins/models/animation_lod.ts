/**
 * Animation level of detail: far animated models are re-posed every few frames, not every
 * frame. Sampling clips, blending layers, solving IK (foot IK casts rays) and building node
 * matrices is the per-character cost of a crowd; a soldier 60 m away moving its limbs at
 * 30 Hz instead of 60 can't be told apart, and its placement (the entity's transform) still
 * moves every frame — only the model-space pose is held.
 *
 *   nearer than 40 m    posed every frame
 *   40 m to 80 m        every 2nd frame
 *   80 m and farther    every 4th frame
 *
 * Distances are to the nearest eye the renderer last drew from (`ModelPoseSource.animationLod`),
 * multiplied by the quality's `lodScale` (low holds from 20 m). Entities are staggered by id
 * (`(frame + id) % stride`), so a crowd's re-posing spreads evenly over frames instead of
 * spiking every 4th. Clips are sampled at the current time when they are posed, so a held
 * animation never drifts — it only updates less often.
 *
 * Never held: without eyes (headless runs, servers, tests: every pose is exact), poses game
 * code asks for between frames (`fresh`), and ragdolled models (physics bones would stutter).
 */

import type { EntityId } from '../../../core/index.js';
import type { ModelAsset } from '../../../resource/index.js';

/** Meters (before `lodScale`) from which a pose is held for 2 and then 4 frames. */
export const ANIMATION_LOD_DISTANCES: readonly [half: number, quarter: number] = [40, 80];

/** Frames between poses at `distance` meters from the nearest eye. */
export function animationStride(distance: number, lodScale = 1): number {
  const [half, quarter] = ANIMATION_LOD_DISTANCES;
  if (distance >= quarter * lodScale) return 4;
  if (distance >= half * lodScale) return 2;
  return 1;
}

/** Whether the entity is re-posed on `frame` at `stride` (staggered by id). */
export function posesOnFrame(frame: number, entity: EntityId, stride: number): boolean {
  return stride <= 1 || (frame + entity) % stride === 0;
}

interface Held {
  readonly worlds: Float32Array;
  readonly at: number;
}

/** Holds each entity's last poses (per model: its own and level-of-detail models) for the LOD policy. */
export class PoseHold {
  #eyes: readonly (readonly [number, number, number])[] = [];
  #scale = 1;
  #frame = 0;
  readonly #held = new Map<EntityId, Map<ModelAsset, Held>>();

  /** Where the frame is seen from (cleared: none, every pose exact). */
  setEyes(eyes: readonly (readonly [number, number, number])[], lodScale: number): void {
    this.#eyes = eyes;
    this.#scale = lodScale > 0 ? lodScale : 1;
  }

  get frameNumber(): number {
    return this.#frame;
  }

  /** A new frame: held poses age; long-unused ones (entities gone or near again) are dropped now and then. */
  frame(): void {
    this.#frame++;
    if (this.#frame % 120 === 0) {
      for (const [id, byModel] of this.#held) {
        for (const [model, held] of byModel) if (this.#frame - held.at > 8) byModel.delete(model);
        if (byModel.size === 0) this.#held.delete(id);
      }
    }
  }

  /** Frames between this entity's poses, for an entity whose model → world translation is `x, y, z`. */
  stride(x: number, y: number, z: number): number {
    if (this.#eyes.length === 0) return 1;
    let nearest = Infinity;
    for (const e of this.#eyes) nearest = Math.min(nearest, (x - e[0]) ** 2 + (y - e[1]) ** 2 + (z - e[2]) ** 2);
    return animationStride(Math.sqrt(nearest), this.#scale);
  }

  /** The held pose to reuse this frame, or undefined when the entity is due a fresh one. */
  reuse(entity: EntityId, model: ModelAsset, stride: number): Float32Array | undefined {
    if (posesOnFrame(this.#frame, entity, stride)) return undefined;
    const held = this.#held.get(entity)?.get(model);
    if (held === undefined || this.#frame - held.at >= stride) return undefined;
    return held.worlds;
  }

  /** Remember a pose made this frame. */
  keep(entity: EntityId, model: ModelAsset, worlds: Float32Array): void {
    let byModel = this.#held.get(entity);
    if (byModel === undefined) this.#held.set(entity, (byModel = new Map()));
    byModel.set(model, { worlds, at: this.#frame });
  }

  /** Forget an entity's poses (ragdolled, or posed exactly on request). */
  drop(entity: EntityId): void {
    this.#held.delete(entity);
  }
}
