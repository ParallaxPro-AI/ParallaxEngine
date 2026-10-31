/**
 * What each built-in HUD panel receives: plain data, ready for the panel vocabulary (CSS
 * lengths and colours as strings, flags as bools), one model per seat. A restyled panel
 * (a game `@ui` subclass with its own HTML) binds the same keys.
 */

export interface Accessibility {
  /** No shake, softer flashes, no pulsing. */
  readonly reducedMotion: boolean;
  /** Solid backgrounds and outlines on HUD elements. */
  readonly highContrast: boolean;
  /** HUD text size multiplier. */
  readonly textScale: number;
  /** Colour-vision mode: HUD default colours switch to a safe palette. */
  readonly colorblind: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
}

export const DEFAULT_ACCESSIBILITY: Accessibility = { reducedMotion: false, highContrast: false, textScale: 1, colorblind: 'none' };

/** Every model carries these, for the default look's accessibility classes. */
export interface A11yState {
  readonly contrast: boolean;
  readonly calm: boolean;
  /** CSS font-size for the panel root ("100%"). */
  readonly font: string;
}

export interface MapIconModel {
  readonly icon: string;
  readonly glyph: string;
  readonly x: string;
  readonly y: string;
  readonly color: string;
  readonly size: string;
  readonly turn: string;
  readonly label: string;
  readonly edge: boolean;
}

export interface MinimapModel {
  readonly shown: boolean;
  readonly round: boolean;
  readonly base: string | null;
  readonly base_left: string;
  readonly base_top: string;
  readonly base_width: string;
  readonly base_height: string;
  /** The map layer's CSS transform (player-up rotation). */
  readonly turn: string;
  readonly player_turn: string;
  readonly icons: readonly MapIconModel[];
  readonly has_route: boolean;
  /** SVG polyline points in the map layer's 0..100 box. */
  readonly route: string;
  readonly range: number;
  readonly a11y: A11yState;
}

export interface CompassModel {
  readonly shown: boolean;
  readonly heading: number;
  readonly ticks: readonly { readonly label: string; readonly x: string; readonly major: boolean }[];
  readonly marks: readonly { readonly glyph: string; readonly color: string; readonly x: string; readonly distance: string; readonly label: string }[];
  readonly a11y: A11yState;
}

export interface CrosshairModel {
  readonly shown: boolean;
  readonly dot: boolean;
  readonly cross: boolean;
  readonly circle: boolean;
  readonly scope: boolean;
  readonly gap: string;
  readonly color: string;
  /** Hit marker opacity 0..1. */
  readonly hit: number;
  readonly kill: boolean;
  readonly reloading: boolean;
  readonly reload: string;
  readonly a11y: A11yState;
}

export interface PlateModel {
  readonly x: string;
  readonly y: string;
  readonly text: string;
  readonly named: boolean;
  readonly health: boolean;
  readonly fill: string;
  readonly color: string;
  readonly low: boolean;
  /** The HealthBar's own look, as CSS (null: the panel's). */
  readonly bar_width: string | null;
  readonly bar_height: string | null;
  readonly bar_background: string | null;
  readonly bar_border: string | null;
}

export interface NameplatesModel {
  readonly shown: boolean;
  readonly plates: readonly PlateModel[];
  readonly a11y: A11yState;
}

export interface MarkerModel {
  readonly x: string;
  readonly y: string;
  readonly on_screen: boolean;
  /** CSS rotate() pointing from the screen center toward it (for the off-screen arrow). */
  readonly turn: string;
  readonly icon: string;
  readonly glyph: string;
  readonly label: string;
  readonly distance: string;
  readonly color: string;
  readonly ping: boolean;
}

export interface MarkersModel {
  readonly shown: boolean;
  readonly markers: readonly MarkerModel[];
  readonly a11y: A11yState;
}

export interface StatBarModel {
  readonly label: string;
  readonly text: string;
  readonly fill: string;
  readonly color: string;
  readonly low: boolean;
  readonly numbers: boolean;
}

export interface StatsModel {
  readonly shown: boolean;
  readonly bars: readonly StatBarModel[];
  readonly a11y: A11yState;
}

export interface AbilitySlotModel {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Project path of the slot's image (shown instead of `icon`), or null. */
  readonly image: string | null;
  /** `"Set.action"` whose key the slot shows (the api fills `keys`). */
  readonly action: string | null;
  readonly ready: boolean;
  readonly charges: number;
  readonly max_charges: number;
  readonly show_charges: boolean;
  /** Cooldown left as a CSS height (100% = just used). */
  readonly fill: string;
  readonly seconds: string;
}

export interface AbilitiesModel {
  readonly shown: boolean;
  readonly slots: readonly AbilitySlotModel[];
  readonly a11y: A11yState;
}

export interface ComboModel {
  readonly shown: boolean;
  readonly count: number;
  readonly best: number;
  readonly fill: string;
  readonly a11y: A11yState;
}

export interface AwarenessModel {
  readonly shown: boolean;
  readonly meters: readonly {
    readonly x: string; readonly y: string; readonly fill: string; readonly alerted: boolean; readonly on_screen: boolean;
    readonly turn: string;
  }[];
  readonly hits: readonly { readonly turn: string; readonly opacity: number }[];
  /** Sound-direction cues (HurtFeedback.noise_cues): where recent noises came from; `kind` is the noise's tag id or "". */
  readonly sounds: readonly { readonly turn: string; readonly opacity: number; readonly kind: string }[];
  readonly a11y: A11yState;
}

export interface ScreenModel {
  readonly shown: boolean;
  readonly flash: number;
  readonly flash_color: string;
  readonly vignette: number;
  readonly vignette_color: string;
  readonly a11y: A11yState;
}

export interface KeyHintsModel {
  readonly shown: boolean;
  /** `"Set.action"` names in order (the api turns them into labels and glyphs). */
  readonly actions: readonly string[];
  readonly a11y: A11yState;
}
