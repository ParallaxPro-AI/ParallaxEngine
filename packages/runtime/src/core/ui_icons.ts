/**
 * The engine's built-in UI icons: 24×24 glyphs drawn from primitives (original geometry,
 * no shipped game's marks), every shape `fill="currentColor"` so an icon takes the color,
 * opacity and disabled state of the text beside it. A panel writes `<icon name="coin">`
 * (`platform/browser/ui/icons.ts` expands it into an inline `<svg>`); `parallax check`
 * reports an unknown name (PP2077).
 *
 * Design rules for a new glyph: 24×24 viewBox, ~2 px strokes on the half-grid, a silhouette
 * that still reads at 14 px, no detail under ~2 px, fills only (`currentColor`, or black
 * for cut-outs such as eye holes).
 */

/** Each icon's SVG content (inside a `viewBox="0 0 24 24"` svg), by name. */
export const UI_ICONS: Readonly<Record<string, string>> = {
  blade: '<path fill="currentColor" d="M18.6 2.2 20 3.6 11.7 14 9.9 12.2zM8.9 13.2l1.9 1.9-1.3 1.3-1.9-1.9zM7.2 15.7l1.1 1.1-2.6 2.6-1.8.7.7-1.8zM13.8 16.4l1.4-1.4 4 4-1.4 1.4z"/>',
  aegis: '<path fill="currentColor" d="M12 2 4 5v6.5c0 4.6 3.2 8.6 8 10.5 4.8-1.9 8-5.9 8-10.5V5zm0 2.2 6 2.2v5.1c0 3.4-2.3 6.5-6 8.1-3.7-1.6-6-4.7-6-8.1V6.4z"/><path fill="currentColor" d="M12 7.5 8.5 9v3c0 2 1.4 3.8 3.5 4.8 2.1-1 3.5-2.8 3.5-4.8V9z" opacity=".55"/>',
  bow: '<path fill="currentColor" d="M6.4 2.6A13 13 0 0 1 6.4 21.4L5 20a11 11 0 0 0 0-16zM5.6 3.4 20 17.8V20h-2.2L3.4 5.6z"/><path fill="currentColor" d="M16.6 20 20 20l0-3.4 1.8 1.8-.1 3.5-3.5.1z"/>',
  staff: '<path fill="currentColor" d="M11 8h2v14h-2z"/><path fill="currentColor" d="M12 1 15.2 4.2 12 7.4 8.8 4.2z"/><path fill="currentColor" d="M6.6 6.2 8 7.6l-1.6 1.6L5 7.8zM17.4 6.2 19 7.8l-1.4 1.4L16 7.6z" opacity=".6"/>',
  hammer: '<path fill="currentColor" d="M4 5h9v5H4z"/><path fill="currentColor" d="M13 4h4l3 3.5L17 11h-4z"/><path fill="currentColor" d="M7.6 10h2.8l-.8 12H8.4z"/>',
  fist: '<path fill="currentColor" d="M5 9h13a3 3 0 0 1 3 3v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path fill="currentColor" d="M7 4h2v5H7zM10.5 3h2v6h-2zM14 4h2v5h-2z" opacity=".7"/>',
  spark: '<path fill="currentColor" d="M12 1.5 14 9l7.5 2-7.5 2-2 7.5-2-7.5L2.5 11 10 9z"/>',
  burst: '<path fill="currentColor" d="M12 2 9.8 9.8 2 12l7.8 2.2L12 22l2.2-7.8L22 12l-7.8-2.2z"/><path fill="currentColor" d="M4.6 4.6 8 8 6.6 9.4 3.2 6zM19.4 4.6 20.8 6l-3.4 3.4L16 8zM4.6 19.4 3.2 18l3.4-3.4L8 16zM19.4 19.4 16 16l1.4-1.4L20.8 18z" opacity=".65"/>',
  bolt: '<path fill="currentColor" d="M13.6 1.5 5 13h5.2l-1.6 9.5L19 10h-5.6z"/>',
  flame: '<path fill="currentColor" d="M12.6 1.6c2.4 3.5 1 5.6-.4 7.4-1.4 1.8-2 3.6-.6 5-1.5-.2-2.6-1.6-2.6-3.4-2.2 1.8-3.4 4-3.4 6.3C5.6 20 8.5 22.5 12 22.5S18.4 20 18.4 16.9c0-4.4-2.7-6.6-4.2-9.1-.9-1.5-1.3-3.5-1.6-6.2z"/>',
  frost: '<path fill="currentColor" d="M11 1h2v22h-2z"/><path fill="currentColor" d="m2.6 6.2 1-1.7 19 11-1 1.7z"/><path fill="currentColor" d="m21.4 6.2 1 1.7-19 11-1-1.7z"/><path fill="currentColor" d="M12 3.6 9.4 1 8 2.4 12 6.4 16 2.4 14.6 1zM12 20.4 9.4 23 8 21.6l4-4 4 4-1.4 1.4z" opacity=".7"/>',
  venom: '<path fill="currentColor" d="M12 2c3 4.5 6 7.6 6 11.2A6 6 0 0 1 6 13.2C6 9.6 9 6.5 12 2z"/><circle cx="10" cy="12.6" r="1.4" fill="currentColor" opacity=".45"/><circle cx="13.6" cy="15.4" r="1" fill="currentColor" opacity=".45"/>',
  mend: '<path fill="currentColor" d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>',
  curse: '<path fill="currentColor" d="M12 2c1.2 3 3.5 4 3.5 7 0 1.4-.7 2.6-1.7 3.4L18 22H6l4.2-9.6C9.2 11.6 8.5 10.4 8.5 9c0-3 2.3-4 3.5-7z"/>',
  coin: '<circle cx="12" cy="12" r="9.2" fill="currentColor"/><path fill="currentColor" d="M12 5.4a6.6 6.6 0 1 0 0 13.2A6.6 6.6 0 0 0 12 5.4zm0 1.8 1.5 3.3 3.4.4-2.6 2.3.8 3.4-3.1-1.8-3.1 1.8.8-3.4L7.1 11l3.4-.4z" opacity=".38"/>',
  gem: '<path fill="currentColor" d="M7.4 3h9.2l4.4 6-9 12-9-12z"/><path fill="currentColor" d="M12 3 8.4 9 12 21l3.6-12z" opacity=".35"/>',
  ingot: '<path fill="currentColor" d="M6 9h12l3 8H3z"/><path fill="currentColor" d="M8.4 4h7.2l1.6 4H6.8z" opacity=".65"/>',
  boot: '<path fill="currentColor" d="M5 3h5v8.4c0 1 .5 1.6 1.6 2.2l6.6 3.4c1.4.7 2.2 1.7 2.2 3V21H5z"/><path fill="currentColor" d="M5 17h15.4v1.6H5z" opacity=".45"/>',
  ring: '<path fill="currentColor" d="M12 7.2a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8zm0 3a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8z"/><path fill="currentColor" d="M12 1 15.4 5 12 8.4 8.6 5z"/>',
  amulet: '<path fill="currentColor" d="M5.6 2.4 7.4 3.6C6 5.6 5.2 7.4 5.2 9.4h-2c0-2.6 1-4.8 2.4-7zM18.4 2.4c1.4 2.2 2.4 4.4 2.4 7h-2c0-2-.8-3.8-2.2-5.8z"/><path fill="currentColor" d="M12 8.6 16.6 12l-1.8 5.6H9.2L7.4 12z"/>',
  tome: '<path fill="currentColor" d="M4 3h7.2v18H4z"/><path fill="currentColor" d="M12.8 3H20v18h-7.2z" opacity=".62"/><path fill="currentColor" d="M11.2 2h1.6v20h-1.6z"/>',
  flask: '<path fill="currentColor" d="M9 2h6v2h-1v5.2l4.6 8.4c.9 1.6-.2 3.4-2 3.4H7.4c-1.8 0-2.9-1.8-2-3.4L10 9.2V4H9z"/><path fill="currentColor" d="M7.8 14h8.4l2 3.6c.6 1.1-.1 2.2-1.3 2.2H7.1c-1.2 0-1.9-1.1-1.3-2.2z" opacity=".4"/>',
  cloak: '<path fill="currentColor" d="M12 2c2.4 0 4 1.2 4 1.2L20 21h-4.6l-1.2-9.4h-4.4L8.6 21H4L8 3.2S9.6 2 12 2z"/>',
  lens: '<path fill="currentColor" d="M12 4c5 0 9.2 3.4 10.6 8-1.4 4.6-5.6 8-10.6 8S2.8 16.6 1.4 12C2.8 7.4 7 4 12 4zm0 2.4c-3.6 0-6.8 2.2-8.1 5.6 1.3 3.4 4.5 5.6 8.1 5.6s6.8-2.2 8.1-5.6c-1.3-3.4-4.5-5.6-8.1-5.6z"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  tower: '<path fill="currentColor" d="M7 2h2.4v2H12V2h2.4v2H17v3.6H7z"/><path fill="currentColor" d="M8.2 8.6h7.6L15 18H9z"/><path fill="currentColor" d="M6 19h12v3H6z"/>',
  keep: '<path fill="currentColor" d="M12 1.6 19.4 6v6.4c0 4.4-3 8.2-7.4 9.8-4.4-1.6-7.4-5.4-7.4-9.8V6z"/><path fill="currentColor" d="M12 6.6 8.4 8.8v3.6c0 2.3 1.5 4.4 3.6 5.4 2.1-1 3.6-3.1 3.6-5.4V8.8z" opacity=".38"/>',
  obelisk: '<path fill="currentColor" d="M12 1 15.6 8 12 15 8.4 8z"/><path fill="currentColor" d="M8 16h8l2 6H6z" opacity=".7"/>',
  ward: '<path fill="currentColor" d="M12 4c5.2 0 9.4 3.6 10.6 8-1.2 4.4-5.4 8-10.6 8S2.6 16.4 1.4 12C2.6 7.6 6.8 4 12 4zm0 2.6c-3.8 0-7 2.2-8.2 5.4 1.2 3.2 4.4 5.4 8.2 5.4s7-2.2 8.2-5.4c-1.2-3.2-4.4-5.4-8.2-5.4z"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/>',
  banner: '<path fill="currentColor" d="M5 2h2v20H5z"/><path fill="currentColor" d="M8 3h12l-3 4.5L20 12H8z"/>',
  skull: '<path fill="currentColor" d="M12 2c5 0 8.4 3.4 8.4 7.8 0 2.8-1.2 4.6-2.6 5.8V19h-2.2v2H8.4v-2H6.2v-3.4C4.8 14.4 3.6 12.6 3.6 9.8 3.6 5.4 7 2 12 2z"/><circle cx="9" cy="10.4" r="2" fill="#000" opacity=".55"/><circle cx="15" cy="10.4" r="2" fill="#000" opacity=".55"/>',
  beast: '<path fill="currentColor" d="M3.4 3 8 6h8l4.6-3-1 6.2c.6 1 1 2.2 1 3.4 0 4.2-3.8 7.4-8.6 7.4S3.4 16.8 3.4 12.6c0-1.2.4-2.4 1-3.4z"/><path fill="#000" d="m8.6 11.6 2.8 1.6-2.8 1.6zM15.4 11.6l-2.8 1.6 2.8 1.6z" opacity=".55"/>',
  crosshair: '<path fill="currentColor" d="M11 1h2v5h-2zM11 18h2v5h-2zM1 11h5v2H1zM18 11h5v2h-5z"/><path fill="currentColor" d="M12 5.4a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2zm0 2.2a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8z"/>',
  pin: '<path fill="currentColor" d="M12 1.6c-3.9 0-7 3-7 6.8 0 5 7 14 7 14s7-9 7-14c0-3.8-3.1-6.8-7-6.8zm0 4.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z"/>',
  search: '<path fill="currentColor" d="M10.4 2a8.4 8.4 0 1 0 5.1 15.1l4.7 4.7 2-2-4.7-4.7A8.4 8.4 0 0 0 10.4 2zm0 2.4a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/>',
  close: '<path fill="currentColor" d="m5.6 4.2 14.2 14.2-1.4 1.4L4.2 5.6z"/><path fill="currentColor" d="M18.4 4.2 19.8 5.6 5.6 19.8 4.2 18.4z"/>',
  check: '<path fill="currentColor" d="M9.6 16.2 4.8 11.4l-1.9 1.9 6.7 6.7L21.1 6.5l-1.9-1.9z"/>',
  lock: '<path fill="currentColor" d="M12 1.6a4.8 4.8 0 0 0-4.8 4.8V9H9.8V6.4a2.2 2.2 0 1 1 4.4 0V9h2.6V6.4A4.8 4.8 0 0 0 12 1.6z"/><path fill="currentColor" d="M4.8 10.4h14.4V22H4.8z"/>',
  plus: '<path fill="currentColor" d="M10.6 4h2.8v16h-2.8z"/><path fill="currentColor" d="M4 10.6h16v2.8H4z"/>',
  chevron: '<path fill="currentColor" d="M6.6 8.6 12 14l5.4-5.4 2 2-7.4 7.4L4.6 10.6z"/>',
  star: '<path fill="currentColor" d="m12 1.8 3.1 6.5 7 .9-5.1 4.9 1.3 7-6.3-3.4-6.3 3.4 1.3-7L1.9 9.2l7-.9z"/>',
  timer: '<path fill="currentColor" d="M9 1h6v2H9z"/><path fill="currentColor" d="M12 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2.6a6.4 6.4 0 1 1 0 12.8 6.4 6.4 0 0 1 0-12.8z"/><path fill="currentColor" d="M11 8h2v5.4l3.4 2-1 1.8L11 14.6z"/>',
  person: '<circle cx="12" cy="6.6" r="4.4" fill="currentColor"/><path fill="currentColor" d="M12 12.6c-4.4 0-8 2.6-8 5.8V22h16v-3.6c0-3.2-3.6-5.8-8-5.8z"/>',
  swords: '<path fill="currentColor" d="M3 2h4l12.4 12.4-2.8 2.8L4.2 4.8zM17.4 18.6l2.8-2.8 1.8 1.8-1 3.8-3.8 1z"/><path fill="currentColor" d="M21 2h-4L4.6 14.4l2.8 2.8L19.8 4.8zM6.6 18.6l-2.8-2.8L2 17.6l1 3.8 3.8 1z" opacity=".62"/>',
};

/** Every built-in icon name, in the set's order (weapons and schools, economy, map, interface). */
export const UI_ICON_NAMES: readonly string[] = Object.keys(UI_ICONS);
