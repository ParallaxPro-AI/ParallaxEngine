/**
 * The headless panel surface: records each frame the ui plugin presents and lets a test
 * click as a player would (the clicks reach the engine in the next frame's input hook,
 * exactly as the browser's do).
 */

import type { UiClick, UiFrame, UiSurface } from '../../core/index.js';

export class RecordingUiSurface implements UiSurface {
  readonly frames: UiFrame[] = [];
  #clicks: UiClick[] = [];
  readonly #keep: number;

  /** `keep`: how many recent frames to hold (default 120). */
  constructor(options: { readonly keep?: number } = {}) {
    this.#keep = options.keep ?? 120;
  }

  present(frame: UiFrame): void {
    this.frames.push(frame);
    if (this.frames.length > this.#keep) this.frames.splice(0, this.frames.length - this.#keep);
  }

  takeClicks(): UiClick[] {
    const out = this.#clicks;
    this.#clicks = [];
    return out;
  }

  /** The most recent frame, if any was presented. */
  get last(): UiFrame | undefined {
    return this.frames[this.frames.length - 1];
  }

  click(panel: string, action: string, data: Readonly<Record<string, unknown>> = {}, seat = 0): void {
    this.#clicks.push({ panel, action, data, seat });
  }
}
