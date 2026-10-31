/**
 * Sprite frame animations: the frame to show follows from game time (`ctx.time.now`), so
 * renderers keep no clocks and playback is deterministic and headless-testable. Skeletal
 * animation (the Animator) is `animation_player.ts`.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import type { EntityRecord } from '../../kernel/index.js';
import { bind, bool, storedRef } from './args.js';
import { SPRITE } from './schemas.js';

// ── Sprites ──────────────────────────────────────────────────────────────────

interface SpriteAnimation {
  readonly frames: readonly unknown[];
  readonly fps: number;
  readonly loop: boolean;
}

function animationsOf(fields: Fields): Readonly<Record<string, SpriteAnimation>> {
  return fields['animations'] as Record<string, SpriteAnimation>;
}

/** The frame image of an animation at `time`: looping wraps, otherwise holds the last frame. */
export function spriteFrame(animation: SpriteAnimation, time: number): unknown {
  const count = animation.frames.length;
  if (count === 0) return null;
  const index = animation.fps <= 0 ? 0 : Math.floor(time * animation.fps + 1e-9);
  return animation.frames[animation.loop ? index % count : Math.min(index, count - 1)];
}

function checkAnimationName(fields: Fields, name: unknown, where: string): asserts name is string {
  const animations = animationsOf(fields);
  if (typeof name === 'string' && name in animations) return;
  const known = Object.keys(animations);
  const guess = typeof name === 'string' ? closestMatch(name, known) : undefined;
  fail('PP3731', `${where}: this sprite has no animation ${JSON.stringify(name)}`, {
    fix: guess !== undefined ? `Did you mean "${guess}"?`
      : known.length > 0 ? `Its animations: ${known.join(', ')}.` : 'Declare "animations" on the sprite in its prefab.',
  });
}

/**
 * Sprite animation state lives in the sprite's own saved fields (render2d contract):
 * `animation` (the playing name, None: show `image`) and `animation_started` (the game
 * time `play()` started it). Frames follow from `ctx.time.now`, so there is no clock here.
 */
export class Sprites {
  readonly #kernelOf: () => Kernel;

  constructor(kernel: () => Kernel) {
    this.#kernelOf = kernel;
  }

  /** An authored starting `animation` must name one of the sprite's animations. */
  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      const fields = record.components.get(SPRITE);
      if (fields === undefined || fields['animation'] === null) continue;
      checkAnimationName(fields, fields['animation'], `sprite of "${record.placedId ?? record.prefab ?? record.id}"`);
    }
  }

  methods(): object {
    const sprites = this;
    return {
      /** The image to draw now: the playing animation's frame, else `image`. */
      get __image__(): string | null {
        const fields = this as unknown as Fields;
        const name = fields['animation'] as string | null;
        const frame = name === null
          ? fields['image']
          : spriteFrame(animationsOf(fields)[name]!, sprites.#kernelOf().time.now - (fields['animation_started'] as number));
        return frame === null || frame === undefined ? null : storedRef(frame, 'sprite image');
      },
      play(this: Fields, ...args: unknown[]): void {
        const a = bind('play', args, ['animation'], ['restart'], ['animation']);
        const name = a['animation'];
        checkAnimationName(this, name, 'play()');
        if (this['animation'] === name && !bool(a['restart'] ?? false, 'play restart')) return;
        this['animation'] = name;
        this['animation_started'] = sprites.#kernelOf().time.now;
      },
    };
  }
}
