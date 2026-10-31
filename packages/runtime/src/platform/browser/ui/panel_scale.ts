/**
 * A panel's CSS-pixel → screen-pixel scale (`@ui(scale=...)`, core's `UiPanelScale`). A
 * panel at scale s is laid out on an area of (w / s) × (h / s) CSS pixels and drawn shrunk
 * by s into its w × h on screen, so its `vh` / `vw` (container units, viewport.ts) still
 * span the game view while its pixel sizes shrink.
 *
 *   viewport  1 while the view is at least 1280 × 720 (844 × 390 on a touch screen), else
 *             min(w / 1280, h / 720): small views (an editor strip, a portrait phone) show
 *             the panel's whole layout instead of overflowing its pixel minimums
 *   design    a 1920 × 1080 design canvas: min(w / 1920, h / 1080, 1). On a touch screen
 *             a 1688 × 780 canvas (an 844 × 390 landscape phone at 0.5): at most 0.5,
 *             smaller when the screen is shorter or narrower than that — but a narrow
 *             (portrait) screen never lays out on more area than the canvas itself
 *   none      always 1
 *
 * Never above 1: a big window keeps the authored pixel sizes instead of zooming in.
 */

import type { UiPanelScale } from '../../../core/index.js';

const VIEWPORT_MIN = { fine: [1280, 720], coarse: [844, 390] } as const;
const DESIGN = [1920, 1080] as const;
const TOUCH_DESIGN = [1688, 780] as const;
const TOUCH_MAX = 0.5;

/** The scale for a panel `width` × `height` screen pixels; `coarse`: a touch screen. */
export function panelScale(mode: UiPanelScale, width: number, height: number, coarse: boolean): number {
  if (mode === 'none' || !(width > 0) || !(height > 0)) return 1;
  if (mode === 'viewport') {
    const [w, h] = coarse ? VIEWPORT_MIN.coarse : VIEWPORT_MIN.fine;
    return Math.min(width / w, height / h, 1);
  }
  if (!coarse) return Math.min(width / DESIGN[0], height / DESIGN[1], 1);
  const fitW = width / TOUCH_DESIGN[0];
  const fitH = height / TOUCH_DESIGN[1];
  if (fitH <= fitW) return Math.min(fitH, TOUCH_MAX);
  // Narrow: fitting the canvas's width would lay out a tall area many times the canvas's
  // (and back it with that much memory); keep the canvas's area instead.
  const areaFloor = Math.sqrt((width * height) / (TOUCH_DESIGN[0] * TOUCH_DESIGN[1]));
  return Math.min(Math.max(fitW, areaFloor), TOUCH_MAX);
}
