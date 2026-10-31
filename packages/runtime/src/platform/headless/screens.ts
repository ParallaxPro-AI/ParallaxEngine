/**
 * A recording screen surface (core `ScreenSurface`) for playtests: keeps every frame and
 * each screen's last presentation; presses hit rectangles a test lays out per screen
 * (`layout`), standing in for the panel's rendered buttons.
 */

import type { ScreenFrame, ScreenHit, ScreenSurface, ScreensFrame } from '../../core/index.js';

export interface ScreenRegion {
  /** Texels: left, top, width, height. */
  readonly rect: readonly [x: number, y: number, w: number, h: number];
  readonly action: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export class RecordingScreens implements ScreenSurface {
  readonly frames: ScreensFrame[] = [];
  /** Each target's latest presentation, and how many times it was redrawn. */
  readonly last = new Map<string, ScreenFrame>();
  readonly redraws = new Map<string, number>();
  readonly #regions = new Map<string, readonly ScreenRegion[]>();

  present(frame: ScreensFrame): void {
    this.frames.push(frame);
    for (const screen of frame.screens) {
      this.last.set(screen.target, screen);
      if (screen.due) this.redraws.set(screen.target, (this.redraws.get(screen.target) ?? 0) + 1);
    }
  }

  /** Where a screen's buttons are, for `hit`. */
  layout(target: string, regions: readonly ScreenRegion[]): void {
    this.#regions.set(target, regions);
  }

  hit(target: string, x: number, y: number): ScreenHit | null {
    const regions = this.#regions.get(target) ?? [];
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i]!;
      const [rx, ry, rw, rh] = r.rect;
      if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return { action: r.action, data: r.data ?? {} };
    }
    return null;
  }
}
