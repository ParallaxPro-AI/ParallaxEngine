/**
 * Where the editor's server lives. `parallax edit` serves it at the origin's root; a host
 * page serving it under a path of its own (e.g. `/parallax/<id>/edit/`) passes that `base`
 * to `bootEditor`. Every request the editor makes goes through `serverUrl`. (The platform
 * names the editor shows by default are in site.ts.)
 */

let base = '/';

export function setServerBase(next: string): void {
  base = next.endsWith('/') ? next : `${next}/`;
}

/** A server path (`/__parallax__/save`, `build/v3/`) under the current base. */
export function serverUrl(path: string): string {
  return `${base}${path.replace(/^\//, '')}`;
}
