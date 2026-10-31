/**
 * The display port: the game's area on screen, whether anyone can see it, and the
 * refresh that drives frames. Boot runs the frame loop on it; renderers size their
 * surfaces from it. Browser: a stage element, `requestAnimationFrame` and the page's
 * visibility. Headless: frames fire only when a test asks.
 */

/** The game's area in CSS pixels, and device pixels per CSS pixel. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

export type DisplayChange = 'resize' | 'visibility';

export interface Display {
  size(): ViewportSize;
  /** False while the page is hidden (another tab, minimized): the game pauses. */
  visible(): boolean;
  /** Called after the size or visibility changed. Returns an unsubscribe. */
  onChange(listener: (change: DisplayChange) => void): () => void;
  /** Call `frame` once per display refresh until the returned stop function is called. */
  frames(frame: () => void): () => void;
}
