import { diagnostic, fail } from '../../core/index.js';
import type { Diagnostic, Draw2d, Frame2d, RenderSurface2d } from '../../core/index.js';

export interface RecordingSurfaceOptions {
  /** Pretend screen size in pixels (default 1280 × 720). */
  readonly width?: number;
  readonly height?: number;
  /** How many recent frames to keep (default 1). */
  readonly keep?: number;
  /** Images that fail to load, as a broken or missing file would in a browser. */
  readonly failing?: readonly string[];
}

/**
 * A render surface that draws nothing and remembers everything: the frames it was given
 * and the images it was asked to load. Playtests and engine tests assert on it; it never
 * touches a browser.
 */
export class RecordingSurface2d implements RenderSurface2d {
  readonly width: number;
  readonly height: number;
  readonly #keep: number;
  readonly #failing: ReadonlySet<string>;
  readonly #loaded: string[] = [];
  #frames: Frame2d[] = [];
  #drawn = 0;
  #problems: Diagnostic[] = [];

  constructor(options: RecordingSurfaceOptions = {}) {
    this.width = options.width ?? 1280;
    this.height = options.height ?? 720;
    this.#keep = options.keep ?? 1;
    if (!(Number.isInteger(this.#keep) && this.#keep >= 1)) fail('PP9602', `keep must be a whole number of frames ≥ 1, got ${this.#keep}`);
    this.#failing = new Set(options.failing ?? []);
  }

  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  load(image: string): void {
    if (this.#loaded.includes(image)) return;
    this.#loaded.push(image);
    if (this.#failing.has(image)) {
      this.#problems.push(diagnostic('PP3610', `The image ${image} could not be loaded`, {
        path: image, fix: 'Check that the file is a PNG, JPEG or WebP image the browser can decode.',
      }));
    }
  }

  draw(frame: Frame2d): void {
    this.#drawn++;
    this.#frames.push(frame);
    if (this.#frames.length > this.#keep) this.#frames = this.#frames.slice(-this.#keep);
  }

  takeProblems(): readonly Diagnostic[] {
    const problems = this.#problems;
    this.#problems = [];
    return problems;
  }

  /** Images asked for, in first-request order. */
  get loaded(): readonly string[] {
    return this.#loaded;
  }

  /** The kept frames, oldest first. */
  get frames(): readonly Frame2d[] {
    return this.#frames;
  }

  get last(): Frame2d | undefined {
    return this.#frames[this.#frames.length - 1];
  }

  /** Frames drawn since this surface was made. */
  get drawn(): number {
    return this.#drawn;
  }

  /** How many commands of each kind the last frame had. */
  counts(frame: Frame2d | undefined = this.last): Partial<Record<Draw2d['kind'], number>> {
    const counts: Partial<Record<Draw2d['kind'], number>> = {};
    for (const command of frame?.commands ?? []) counts[command.kind] = (counts[command.kind] ?? 0) + 1;
    return counts;
  }
}
