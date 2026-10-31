/**
 * The platform this editor names when no host says otherwise: ParallaxPro, the hosted
 * Parallax site. Every such default lives here, so a self-hoster sees them in one place and
 * replaces them (`bootEditor({ site })`, or `setSite` before boot):
 *
 *   name   the top bar logo's label                        'ParallaxPro'
 *   host   the site messages name (the Publish note)       'parallaxpro.ai'
 *   logo   the top bar's logo image (undefined: the built-in ParallaxPro logo, styles.css
 *          `.toolbar-logo`; null: no logo)
 *   home   where the logo leads, in the same tab (undefined: `https://<host>/` in a new tab;
 *          null: the logo is not a link). A host can also set it after boot
 *          (`EditorHost.setLogoAction`, logo.ts)
 *
 * Elsewhere, by design: the error docs links (runtime `DOCS_BASE`) and the hosted asset store games reference (runtime
 * `REMOTE_ASSET_BASE`), which are part of the game format rather than the page.
 */

export interface EditorSite {
  readonly name: string;
  readonly host: string;
  /** An image URL; undefined: the built-in logo; null: none. */
  readonly logo?: string | null;
  /** The logo's link, same tab; undefined: the site in a new tab; null: none. */
  readonly home?: string | null;
}

export const DEFAULT_SITE: EditorSite = { name: 'ParallaxPro', host: 'parallaxpro.ai' };

let site: EditorSite = DEFAULT_SITE;

/** Replace some of the defaults (the rest stay); call before the editor boots. */
export function setSite(next: Partial<EditorSite>): void {
  site = { ...site, ...next };
}

export function currentSite(): EditorSite {
  return site;
}
