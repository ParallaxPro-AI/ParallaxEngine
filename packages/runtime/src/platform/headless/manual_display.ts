import type { Display, DisplayChange, ViewportSize } from '../../core/index.js';

/** A display that refreshes only when told to: tests drive frames, resizes and hiding. */
export class ManualDisplay implements Display {
  #size: ViewportSize;
  #visible = true;
  readonly #listeners = new Set<(change: DisplayChange) => void>();
  readonly #frames = new Set<() => void>();

  constructor(size: ViewportSize = { width: 1280, height: 720, pixelRatio: 1 }) {
    this.#size = size;
  }

  size(): ViewportSize {
    return this.#size;
  }

  visible(): boolean {
    return this.#visible;
  }

  onChange(listener: (change: DisplayChange) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  frames(frame: () => void): () => void {
    const entry = (): void => frame();
    this.#frames.add(entry);
    return () => { this.#frames.delete(entry); };
  }

  /** Whether anything is waiting for frames. */
  get refreshing(): boolean {
    return this.#frames.size > 0;
  }

  /** One display refresh. */
  refresh(): void {
    for (const frame of [...this.#frames]) frame();
  }

  resize(size: ViewportSize): void {
    this.#size = size;
    this.#emit('resize');
  }

  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#emit('visibility');
  }

  #emit(change: DisplayChange): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}
