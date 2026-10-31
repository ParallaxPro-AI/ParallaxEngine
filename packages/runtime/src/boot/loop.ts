/**
 * The frame loop: one `step(realDt)` per display refresh, with real time from the clock.
 * The kernel turns real time into fixed steps itself. A long stall (a breakpoint, a slow
 * frame) is clamped to `maxFrameTime`, so the game slows down instead of jumping; a hidden
 * page pauses the loop, and showing it again resumes without counting the hidden time —
 * unless `whileHidden` is given (a browser hosting a match must keep serving its peers):
 * then it keeps stepping on that scheduler (a timer; browsers throttle it in background tabs).
 */

import type { Clock, Display } from '../core/index.js';

export interface Steppable {
  step(realDt: number): void;
}

export interface LoopOptions {
  readonly target: Steppable;
  readonly clock: Clock;
  readonly display: Display;
  /** Longest real time one frame may advance, in seconds. Default 0.25. */
  readonly maxFrameTime?: number;
  /** A step threw: the loop has stopped. */
  readonly onError: (error: unknown) => void;
  /** Keep stepping while the page is hidden, on this scheduler (returns a stop function). */
  readonly whileHidden?: (tick: () => void) => () => void;
}

export class GameLoop {
  readonly #options: LoopOptions;
  readonly #maxFrameTime: number;
  #running = false;
  #last = 0;
  #stopFrames: (() => void) | undefined;
  #unwatch: (() => void) | undefined;
  #stopHidden: (() => void) | undefined;

  constructor(options: LoopOptions) {
    this.#options = options;
    this.#maxFrameTime = options.maxFrameTime ?? 0.25;
  }

  /** Started and not stopped (it may still be paused while the page is hidden). */
  get running(): boolean {
    return this.#running;
  }

  /** Running, but waiting for the page to be visible again. */
  get paused(): boolean {
    return this.#running && this.#stopFrames === undefined;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unwatch = this.#options.display.onChange((change) => {
      if (change === 'visibility') this.#sync();
    });
    this.#sync();
  }

  stop(): void {
    this.#running = false;
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#stopFrames?.();
    this.#stopFrames = undefined;
    this.#stopHidden?.();
    this.#stopHidden = undefined;
  }

  /** Refresh while running and visible; while hidden, on `whileHidden` if given. */
  #sync(): void {
    const visible = this.#options.display.visible();
    const want = this.#running && visible;
    if (want && this.#stopFrames === undefined) {
      this.#stopHidden?.();
      this.#stopHidden = undefined;
      this.#last = this.#options.clock.now();
      this.#stopFrames = this.#options.display.frames(() => this.#frame());
    } else if (!want && this.#stopFrames !== undefined) {
      this.#stopFrames();
      this.#stopFrames = undefined;
    }
    if (this.#running && !visible && this.#options.whileHidden !== undefined && this.#stopHidden === undefined) {
      this.#stopHidden = this.#options.whileHidden(() => this.#frame());
    }
    if (!this.#running) {
      this.#stopHidden?.();
      this.#stopHidden = undefined;
    }
  }

  #frame(): void {
    const now = this.#options.clock.now();
    const dt = Math.min(now - this.#last, this.#maxFrameTime);
    this.#last = now;
    if (dt <= 0) return;
    try {
      this.#options.target.step(dt);
    } catch (error) {
      this.stop();
      this.#options.onError(error);
    }
  }
}
