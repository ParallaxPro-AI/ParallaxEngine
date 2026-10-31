/**
 * The `animation_clips` service: what game-time animation (the visuals plugin's animators)
 * needs to know about clips, provided by the models plugin, which loads the models and the
 * authored `.clip.json` files (headless too, over `MemoryBinaryFiles` and the project's
 * text files). Looked up at use (`kernel.service(ANIMATION_CLIPS_SERVICE)`).
 *
 * A clip reference is a clip's stored form, as `ClipRef.name` holds it:
 *
 *   "run"                          a clip of the playing entity's own model
 *   "assets/models/anims.glb#run"  a clip of another model, retargeted onto this one
 *   "clips/wave"                   an authored clip (assets/clips/wave.clip.json), retargeted
 *
 * Answers are `undefined` while the clip's model is still loading, and `null` when this
 * run has no file for it (data-only playtests run without the binary asset files: model
 * clips have no frames there; authored clips are text and always present).
 */

import type { EntityId } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** A timeline marker on a clip: game code hears it as `AnimationEvent` when playback crosses it. */
export interface ClipMarker {
  /** Clip seconds. */
  readonly time: number;
  readonly name: string;
}

export interface ClipInfo {
  /** Seconds (0: a single pose). */
  readonly duration: number;
  /** An authored clip's own `loop`; null for model clips (the player decides). */
  readonly loop: boolean | null;
  /** Markers the clip file carries (authored clips); the animator's `events` add to these. */
  readonly markers: readonly ClipMarker[];
}

/** Where the root bone is at a clip time, in the model's space (meters, degrees about +y). */
export interface RootSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export interface AnimationClipSource {
  /** A clip as `entity` plays it. Unknown clip names are PP3805 with the clips that exist. */
  clip(entity: EntityId, ref: string): ClipInfo | null | undefined;
  /**
   * The root bone's position and heading at `time` (clip seconds, clamped to the clip),
   * for root motion. `rootBone` null: the model's default root (a bone named Hips/pelvis,
   * else its skeleton's first joint). Null when the model has no skeleton or no file.
   */
  root(entity: EntityId, ref: string, time: number, rootBone: string | null): RootSample | null | undefined;
}

export const ANIMATION_CLIPS_SERVICE: ServiceKey<AnimationClipSource> = serviceKey<AnimationClipSource>(
  'animation_clips', 'Animators play clips of 3D models: the game needs render3d (it loads the models and their clips).',
);
