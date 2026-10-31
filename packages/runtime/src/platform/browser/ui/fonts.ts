/**
 * The UI's own typefaces, shipped with the engine so every panel looks the same on every
 * device, offline, in a WebView and in a headless browser (a font from a CDN sometimes
 * doesn't arrive; one the device lacks falls back to its system face):
 *
 *   Inter    the UI face (`--parallax-font`, the default panel font): variable, weights
 *            100–900 in one file; `font-variant-numeric: tabular-nums` keeps counters steady
 *   Cinzel   a display face for titles and banners (`--parallax-font-display`): roman
 *            inscriptional capitals, weights 400–900
 *
 * Both are latin subsets under the SIL Open Font License 1.1 (`fonts/*-OFL.txt`). The files
 * sit in `fonts/` and are inlined as data URLs (`fonts/font_data.ts`, generated from them),
 * so the runtime's source stays plain TypeScript that Node (the CLI, through tsx), esbuild
 * and vite all load, and no font is fetched. They are declared under their real
 * family names, so CSS that already asks for `'Inter'` gets it. `font-display: block`: a
 * panel waits the moment the font takes rather than drawing in a fallback and reflowing.
 *
 * `@font-face` rules inside a shadow root don't apply, so the faces are declared on the
 * page's document (`installFonts`) and in each scripted panel's frame document.
 */

import { CINZEL_WOFF2 as cinzel, INTER_WOFF2 as inter } from './fonts/font_data.js';

export interface UiFontFace {
  readonly family: string;
  /** CSS font-weight range the file covers. */
  readonly weight: string;
  /** The font's URL: a data URL (fonts/font_data.ts); undefined or empty: none. */
  readonly file: string | undefined;
}

export const UI_FONTS: readonly UiFontFace[] = [
  { family: 'Inter', weight: '100 900', file: inter },
  { family: 'Cinzel', weight: '400 900', file: cinzel },
];

/** The UI font stack and the display stack (the defaults of `--parallax-font` and `--parallax-font-display`). */
export const UI_FONT_STACK = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const UI_DISPLAY_FONT_STACK = 'Cinzel, Georgia, "Times New Roman", serif';

/** The font's URL as the page loads it (data URLs are absolute already). */
function fontUrl(file: string): string {
  return file;
}

/** `@font-face` rules for the UI fonts; `url` maps each file to the URL the page loads it from. */
export function fontFaceCss(url: (file: string) => string = fontUrl, fonts: readonly UiFontFace[] = UI_FONTS): string {
  return fonts.filter((f) => typeof f.file === 'string' && f.file !== '').map((f) => `@font-face { font-family: "${f.family}"; `
    + `font-style: normal; font-weight: ${f.weight}; font-display: block; src: url("${url(f.file!).replaceAll('"', '%22')}") format("woff2"); }`)
    .join('\n');
}

const STYLE_ID = 'parallax-ui-fonts';

/** Declare the UI fonts on a document, once. */
export function installFonts(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const css = fontFaceCss();
  if (css === '') return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  (doc.head ?? doc.documentElement).append(style);
}
