/**
 * The screens port: `@ui` panels shown on in-world screens (monitors, terminals, arcade
 * cabinets) instead of over the view. The screens plugin decides which panel each screen
 * shows, its state (like any panel: `state()` with the screen's entity as its subject),
 * when it is due for a redraw (`fps`), and turns pointer presses on a screen into texel
 * coordinates; a surface renders each panel into a texture named `target` (what render3d's
 * screen quad samples, a `TextureSource` of kind 'target') and says what a texel hits.
 *
 * Adapters: `platform/browser/screens.ts` (the panel's DOM rasterized into a canvas, its
 * live layout used for hit tests) and `platform/headless/screens.ts` (a recorder).
 */

import type { UiValueRules } from './ui.js';

export interface ScreenPanel {
  readonly id: string;
  /** The `@ui(html=...)` path. */
  readonly html: string;
  readonly state: Readonly<Record<string, unknown>>;
  /** Function actions with `when=`: false while disabled. */
  readonly enabled: Readonly<Record<string, boolean>>;
}

export interface ScreenFrame {
  /** The texture it renders into: `screen:<entity>`. */
  readonly target: string;
  /** Texels. */
  readonly width: number;
  readonly height: number;
  readonly panel: ScreenPanel;
  /** Redraw now (false: keep the last image; the panel's state is still current for hits). */
  readonly due: boolean;
}

export interface ScreensFrame {
  /** Wall seconds since the game started. */
  readonly time: number;
  readonly screens: readonly ScreenFrame[];
  readonly language: string;
  readonly strings: Readonly<Record<string, string>>;
  readonly values: UiValueRules;
}

/** What a press on a screen's texel hits: an action and its payload (as a panel click carries). */
export interface ScreenHit {
  readonly action: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ScreenSurface {
  present(frame: ScreensFrame): void;
  /** The action under texel (x, y) of `target` (origin top-left), or null. */
  hit(target: string, x: number, y: number): ScreenHit | null;
}
