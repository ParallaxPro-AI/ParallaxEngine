/**
 * What the top bar's logo does. By default it links to the site (`site.home`, else
 * `https://<site.host>/`) in a new tab, so a local editor is never navigated away from. A host
 * page gives it its own destination (`EditorHost.setLogoAction`), e.g. its project list:
 *
 *   host.setLogoAction({ href: '/projects', title: 'Back to Projects' });   // a link, same tab
 *   host.setLogoAction({ onClick: ({ editor }) => openMenu() });            // anything else
 *
 * A host's `href` is a real link: Ctrl / Cmd / Shift / middle click open it in a new tab or
 * window as any link does (this tab and its unsaved edits stay). A plain click asks before
 * leaving unsaved edits, then goes there in this tab. `onClick` replaces the plain click.
 */

import type { Editor } from './editor.js';

export interface LogoAction {
  /** Where the logo leads (absolute, or relative to the page). */
  readonly href?: string;
  /** The tooltip and accessible name (default: the site's name). */
  readonly title?: string;
  /** Runs on a plain left click instead of following `href`. */
  readonly onClick?: (context: { readonly editor: Editor }) => void;
}

/** The part of a click the logo decides on. */
export interface LogoClick {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * What a click on the logo does: `'native'` (let the browser open the link: a modified or
 * middle click, or the default new-tab link), `'run'` (the host's onClick), `'navigate'` (go
 * to the host's href in this tab, after asking about unsaved edits) or `'none'`.
 */
export function logoClickPlan(click: LogoClick, action: LogoAction | null): 'native' | 'run' | 'navigate' | 'none' {
  const modified = click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey;
  if (action === null) return 'native';
  if (modified) return action.href !== undefined ? 'native' : 'none';
  if (action.onClick !== undefined) return 'run';
  return action.href !== undefined ? 'navigate' : 'none';
}
