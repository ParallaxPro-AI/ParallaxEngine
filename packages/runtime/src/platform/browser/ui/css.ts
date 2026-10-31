/**
 * A panel's CSS, scoped to the panel: each panel draws in its own shadow root, so its
 * rules can't leak into the page or another panel. Game stylesheets are written for a
 * page of their own (`:root { --accent: ... }`), so `:root` becomes `:host`. `url()`s
 * resolve against the stylesheet's own folder in the project; anything off the project
 * (another site, `javascript:`) is dropped. `@import` of a project file is inlined.
 * Viewport units and `@media` size queries measure the game view (viewport.ts).
 */

import { remoteAssetUrl } from '../../../core/index.js';
import { folderOf, projectPath } from './markup.js';
import { containerUnits, viewportCss } from './viewport.js';

export interface CssFiles {
  /** A project file's text, or undefined when there is none. */
  read(path: string): string | undefined;
  /** A project path's URL on the page. */
  url(path: string): string;
}

const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))\s*\)?[^;]*;/gi;
const BLOCKED = 'url("about:invalid")';

/** `url(...)`s resolved from `folder` (`ui/`); off-project ones blocked. `data:` images and fonts stay. */
export function resolveUrls(css: string, folder: string, url: (path: string) => string): string {
  return css.replace(URL_TOKEN, (_whole, d: string | undefined, s: string | undefined, bare: string | undefined) => {
    const ref = (d ?? s ?? bare ?? '').trim();
    if (/^data:(image|font)\//i.test(ref)) return `url("${ref.replaceAll('"', '%22')}")`;
    if (ref.startsWith('#')) return `url("${ref}")`;
    const hosted = remoteAssetUrl(ref);
    if (hosted !== undefined) return `url("${hosted}")`;
    const path = projectPath(folder, ref);
    return path === undefined ? BLOCKED : `url("${url(path)}")`;
  });
}

/** A stylesheet at `path` (or inline in a file in `folder`), scoped to a panel's shadow root. */
export function scopeCss(css: string, folder: string, files: CssFiles, seen: ReadonlySet<string> = new Set()): string {
  // Imports are cut out first (their files resolve their own urls), then put back.
  const imported: string[] = [];
  const rest = css.replace(IMPORT, (_whole, d: string | undefined, s: string | undefined, bare: string | undefined) => {
    const path = projectPath(folder, d ?? s ?? bare ?? '');
    const text = path === undefined || seen.has(path) || seen.size > 8 ? undefined : files.read(path);
    imported.push(text === undefined ? '' : scopeCss(text, folderOf(path!), files, new Set([...seen, path!])));
    return `\u0000${imported.length - 1}\u0000`;
  });
  return viewportCss(resolveUrls(rest, folder, files.url)).replace(/:root\b/g, ':host').replace(/expression\s*\(/gi, 'blocked(')
    .replace(/\u0000(\d+)\u0000/g, (_w, i: string) => imported[Number(i)]!);
}

/** An inline `style` value (markup or a `data-style-*` / `data-attr-style` binding). */
export function inlineStyle(value: string, folder: string, url: (path: string) => string): string {
  return containerUnits(resolveUrls(value, folder, url)).replace(/expression\s*\(/gi, 'blocked(');
}
