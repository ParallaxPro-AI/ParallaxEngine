/**
 * The browser display: the stage element's size (watched with a ResizeObserver), the
 * page's visibility, and `requestAnimationFrame` as the refresh.
 */

import type { Display, DisplayChange, ViewportSize } from '../../core/index.js';

/** What the adapter needs from the page; `globalThis` in a browser. */
export interface DisplayHost {
  readonly document: { readonly visibilityState: string } & EventTarget;
  readonly devicePixelRatio: number;
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  readonly ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
}

export class BrowserDisplay implements Display {
  readonly #stage: Element;
  readonly #host: DisplayHost;
  readonly #listeners = new Set<(change: DisplayChange) => void>();
  readonly #dispose: (() => void)[] = [];

  constructor(stage: Element, host: DisplayHost = globalThis as unknown as DisplayHost) {
    this.#stage = stage;
    this.#host = host;
    const visibility = (): void => this.#emit('visibility');
    host.document.addEventListener('visibilitychange', visibility);
    this.#dispose.push(() => host.document.removeEventListener('visibilitychange', visibility));
    if (host.ResizeObserver !== undefined) {
      const observer = new host.ResizeObserver(() => this.#emit('resize'));
      observer.observe(stage);
      this.#dispose.push(() => observer.disconnect());
    }
  }

  size(): ViewportSize {
    const rect = this.#stage.getBoundingClientRect();
    return { width: rect.width, height: rect.height, pixelRatio: this.#host.devicePixelRatio || 1 };
  }

  visible(): boolean {
    return this.#host.document.visibilityState !== 'hidden';
  }

  onChange(listener: (change: DisplayChange) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  frames(frame: () => void): () => void {
    let handle: number | undefined;
    const tick = (): void => {
      handle = this.#host.requestAnimationFrame(tick);
      frame();
    };
    handle = this.#host.requestAnimationFrame(tick);
    return () => {
      if (handle !== undefined) this.#host.cancelAnimationFrame(handle);
      handle = undefined;
    };
  }

  dispose(): void {
    for (const fn of this.#dispose.splice(0)) fn();
    this.#listeners.clear();
  }

  #emit(change: DisplayChange): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}
