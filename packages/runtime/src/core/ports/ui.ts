/**
 * The UI port: what the ui plugin hands a panel surface each frame, and what it takes
 * back. The engine decides which panels are open, in what order, what each one's state
 * is (one per seat for a PlayerPanel), which function actions are disabled, and where on
 * the screen each seat's viewport, each floating text and each label is. A surface only
 * has to draw that and report clicks: the DOM adapter in the browser
 * (`platform/browser/ui/`), a recorder in headless tests (`platform/headless/ui.ts`).
 *
 * Positions and viewports are fractions of the surface (x, y from the top-left), so the
 * surface maps them onto whatever pixels it has. Panel markup is named by the `@ui`
 * `html=` path (`ui/hud.html`, or `builtin:settings.html`); the surface reads it from the
 * project's files.
 */

import type { Rgba } from './render.js';

export type UiLayer = 'hud' | 'menu' | 'overlay';

/**
 * How a panel's CSS pixels map onto the screen (`@ui(scale=...)`):
 *   viewport  1:1 with the game view; a view smaller than 1280 × 720 (844 × 390 on a touch
 *             screen) lays the panel out at that minimum and shrinks it to fit (the default)
 *   design    laid out on a 1920 × 1080 design canvas and shrunk to fit,
 *             min(w / 1920, h / 1080, 1); on a touch screen on a 1688 × 780 canvas at 0.5
 *             at most (a narrower screen shrinks further, a portrait phone keeps the layout's area)
 *   none      always 1:1
 */
export type UiPanelScale = 'viewport' | 'design' | 'none';

/** A rectangle in fractions of the surface: x, y from the top-left, width, height. */
export type UiRect = readonly [x: number, y: number, width: number, height: number];

/** One drawn copy of a panel: the whole panel, or one seat's copy of a PlayerPanel. */
export interface UiPanelInstance {
  /** The seat that clicks on this copy come from (0 for a shared panel). */
  readonly seat: number;
  /** Where it is laid out: the full surface, or the seat's viewport. */
  readonly viewport: UiRect;
  /** What `state()` returned, as plain data (items keep their runtime values: refs, enums). */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface UiPanelFrame {
  readonly id: string;
  /** The `@ui(html=...)` path. */
  readonly html: string;
  readonly layer: UiLayer;
  readonly modal: boolean;
  /** Absent: 'viewport'. */
  readonly scale?: UiPanelScale;
  readonly instances: readonly UiPanelInstance[];
  /** Function actions with `@action(when=...)`: false while disabled. Others are absent. */
  readonly enabled: Readonly<Record<string, boolean>>;
}

/**
 * How a floating text looks and moves (`FloatStyle`): damage numbers, score pops. Sizes and
 * distances are CSS pixels. Over `seconds` it rises `rise`, starting at `pop` × its size and
 * settling to 1× within the first fifth, then easing to `endScale` × as it fades out.
 */
export interface UiFloatStyle {
  readonly size: number;
  /** A CSS font-family the page already loads; null: the UI font. */
  readonly font: string | null;
  readonly bold: boolean;
  /** Fill colour when the call gives none; null: white. */
  readonly color: Rgba | null;
  readonly outline: Rgba | null;
  readonly outlineWidth: number;
  readonly pop: number;
  readonly endScale: number;
  readonly rise: number;
  readonly seconds: number;
}

/** HUD feedback, each to be shown once it arrives. */
export type UiEffect =
  | { readonly kind: 'toast'; readonly text: string; readonly seconds: number; readonly viewport: UiRect }
  | {
    readonly kind: 'announce'; readonly title: string; readonly subtitle: string | null;
    readonly seconds: number; readonly viewport: UiRect;
  }
  | {
    readonly kind: 'float_text'; readonly text: string; readonly at: readonly [x: number, y: number]; readonly color: Rgba | null;
    /** Absent: the default look (white, 16 px, a short rise over a second). */
    readonly style?: UiFloatStyle;
  };

/** A world-space label this frame, already projected (absent while off screen). */
export interface UiLabelFrame {
  /** Stable while the label lives, so a surface can keep its element. */
  readonly key: number;
  readonly text: string;
  readonly at: readonly [x: number, y: number];
  /** `ui.label(kind=)`: an extra CSS class on the label (the game's feedback.html styles it). */
  readonly kind?: string;
}

/** How state values read as text and as conditions: the game language's rules (Python's `str()` and truthiness). */
export interface UiValueRules {
  text(value: unknown): string;
  truthy(value: unknown): boolean;
}

/**
 * How the platform draws the cursor it owns (the game's `Cursor`): the virtual cursor over
 * a modal in a mouse-look game, and with `showInMenus` a drawn cursor in place of the OS one
 * whenever the cursor is free.
 *
 *   ring / dot / crosshair   built-in shapes in `color`
 *   image                    `image`, a project path (png, svg…), scaled into `size`
 *   system                   no drawn cursor: the OS cursor (a mouse-look game's menu unlocks)
 */
export interface UiCursor {
  readonly visual: 'ring' | 'dot' | 'crosshair' | 'image' | 'system';
  /** Pixels (CSS) of the cursor's box. */
  readonly size: number;
  /** Shape color; null = white. */
  readonly color: Rgba | null;
  /** Project path of the image (visual "image"). */
  readonly image: string | null;
  /** The click point as fractions of the box from its top-left. */
  readonly hotspot: readonly [x: number, y: number];
  /** Draw it in place of the OS cursor whenever the cursor is free, not only over a locked pointer. */
  readonly showInMenus: boolean;
}

export interface UiFrame {
  /** Seconds of wall time since the game started (timing toasts). */
  readonly time: number;
  /** Open panels, oldest first. */
  readonly panels: readonly UiPanelFrame[];
  readonly effects: readonly UiEffect[];
  readonly labels: readonly UiLabelFrame[];
  /** The player's language and its strings (`data-text` keys). */
  readonly language: string;
  readonly strings: Readonly<Record<string, string>>;
  readonly values: UiValueRules;
  /**
   * A control is being rebound (SettingsPanel): the next key or gamepad button is the new
   * binding, so the surface must not act on it (no shortcut, no focus move, no activation).
   */
  readonly capturing: boolean;
  /** The cursor's look: the top open panel's `cursor=`, else the game's; absent/null = the engine ring. */
  readonly cursor?: UiCursor | null;
}

/** A click (or tap, or `data-key` shortcut) on a panel action. */
export interface UiClick {
  readonly panel: string;
  readonly action: string;
  /** The payload: the clicked `data-each` item's fields, then the element's `data-*` attributes (strings). */
  readonly data: Readonly<Record<string, unknown>>;
  readonly seat: number;
}

export interface UiSurface {
  /** Draw this frame's panels and feedback. */
  present(frame: UiFrame): void;
  /** Clicks since the last call, in order. */
  takeClicks(): UiClick[];
}
