/**
 * Frame pacing on the surface: the frame cap and dynamic resolution, both measured from
 * the times frames are asked for (one per display refresh, `requestAnimationFrame`).
 *
 * Frame cap (`Quality3d.frameCap`): render every Nth refresh so delivered frames stay
 * evenly spaced. "Skip if less than 1/cap seconds passed" would beat against vsync
 * (present, present, skip…) and judder; a stride doesn't. The stride is the largest whole
 * number of refreshes that keeps the rate at or above the cap: 120 Hz with a 60 cap draws
 * every 2nd refresh, 90 Hz draws every one (not 45 fps), 240 Hz every 4th. The display's
 * interval is the shortest recent gap between asks (a slow frame never shortens it).
 *
 * Dynamic resolution (`Quality3d.minRenderScale`, `maxRenderPixels`): the scene is drawn
 * at a scale of the canvas (per axis) and upscaled with sharpening. The scale never
 * exceeds what keeps the render under the quality's pixel budget (a 4K phone draws far
 * fewer than 8 million pixels); below that, a governor lowers it a step when frames run
 * long (the smoothed frame time over budget for half a second) and raises it a step after
 * two seconds on budget, so a busy scene trades sharpness for frame rate and recovers.
 */

/** Display refreshes between drawn frames for a cap (frames per second; 0: none). */
export function frameCapStride(capHz: number, displayIntervalMs: number): number {
  if (!(capHz > 0) || !(displayIntervalMs > 0)) return 1;
  // 1% tolerance: refresh timestamps jitter around exact divisors (16.6 / 16.7 ms).
  return Math.max(1, Math.floor((1000 / capHz / displayIntervalMs) * 1.01 + 1e-3));
}

/** Tracks refresh timing and decides which refreshes draw under a cap. */
export class FrameCap {
  #last: number | null = null;
  #gaps: number[] = [];
  #count = 0;

  /** The display's refresh interval (ms) as measured; 1000 / 60 until measured. */
  get interval(): number {
    return this.#gaps.length === 0 ? 1000 / 60 : Math.min(...this.#gaps);
  }

  /** Call once per refresh with its time (ms): whether this refresh draws a frame under `cap`. */
  wants(now: number, cap: number): boolean {
    if (this.#last !== null) {
      const gap = now - this.#last;
      if (gap > 0 && gap < 250) {
        this.#gaps.push(gap);
        if (this.#gaps.length > 60) this.#gaps.shift();
      }
    }
    this.#last = now;
    const stride = frameCapStride(cap, this.interval);
    return this.#count++ % stride === 0;
  }
}

/** The largest per-axis scale keeping `width` × `height` under `maxPixels`. */
export function pixelBudgetScale(width: number, height: number, maxPixels: number): number {
  return Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
}

export interface GovernorOptions {
  /** Scale change per step. */
  readonly step: number;
  /** Frames over budget (smoothed) before stepping down, and on budget before stepping up. */
  readonly downAfter: number;
  readonly upAfter: number;
}

const DEFAULTS: GovernorOptions = { step: 0.1, downAfter: 30, upAfter: 120 };

/** Dynamic resolution: the render scale from frame times. */
export class ResolutionGovernor {
  #scale = 1;
  #ema: number | null = null;
  #over = 0;
  #under = 0;
  readonly #options: GovernorOptions;

  constructor(options: Partial<GovernorOptions> = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get scale(): number {
    return this.#scale;
  }

  /**
   * One frame took `ms`; `budget` is the frame time aimed for (ms). The result stays within
   * [min, max] (max: the pixel budget's scale; min: the quality's floor).
   */
  update(ms: number, budget: number, min: number, max: number): number {
    if (min >= max) {
      this.#scale = max;
      return max;
    }
    this.#ema = this.#ema === null ? ms : this.#ema * 0.9 + ms * 0.1;
    if (this.#ema > budget * 1.2) {
      this.#over++;
      this.#under = 0;
    } else if (this.#ema < budget * 1.05) {
      this.#under++;
      this.#over = 0;
    } else {
      this.#over = 0;
      this.#under = 0;
    }
    if (this.#over >= this.#options.downAfter) {
      this.#scale -= this.#options.step;
      this.#over = 0;
      this.#ema = budget;
    } else if (this.#under >= this.#options.upAfter) {
      this.#scale += this.#options.step / 2;
      this.#under = 0;
    }
    this.#scale = Math.min(max, Math.max(min, this.#scale));
    return this.#scale;
  }
}
