/**
 * Animation names for game code (sdk/parallax/__init__.pyi): the `AnimationEvent` and
 * `ClipFinished` events, and `RootMotion`, what `Animator.take_root_motion()` returns.
 * The Animator component handle is with the other visuals components (`api/visuals.ts`);
 * the behavior lives in the visuals plugin (`animation_player.ts`) and render3d
 * (`animation_pose.ts`).
 */

import type { Vec3 } from '../core/index.js';
import { ANIMATION_EVENT, CLIP_FINISHED } from '../function/plugins/visuals/index.js';
import { eventHandle } from './events.js';

export const ClipFinished = eventHandle(CLIP_FINISHED, 'ClipFinished');
export const AnimationEvent = eventHandle(ANIMATION_EVENT, 'AnimationEvent');

/** The root bone's travel since the last `take_root_motion()`: world meters and degrees of turn about +y. */
export class RootMotion {
  readonly offset: Vec3;
  readonly turn: number;

  constructor(offset: Vec3, turn: number) {
    this.offset = offset;
    this.turn = turn;
    Object.freeze(this);
  }

  __repr__(): string {
    return `RootMotion(offset=${this.offset.__repr__()}, turn=${this.turn})`;
  }

  toString(): string {
    return this.__repr__();
  }
}

/** How visuals hands root motion to game code. */
export const presentRootMotion = (offset: Vec3, turn: number): RootMotion => new RootMotion(offset, turn);
