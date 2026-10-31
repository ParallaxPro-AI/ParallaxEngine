/**
 * The viewport's notice when the browser can draw neither WebGPU nor WebGL2 (the renderer's
 * PP9807 at start). The runtime's error overlay already lists the diagnostic; this says it
 * in plain words over it, since no rebuild will fix it (the editor's other failure text says
 * "fix the problems and save").
 */

import { t } from './i18n.js';
import './toast.css';
import type { Diagnostic } from '@parallax/runtime/core';
import { h } from './dom.js';

/** The renderer could not start on this browser (not a WebGPU-only preference that failed). */
export function unsupportedBrowser(diagnostics: readonly Diagnostic[] | undefined): Diagnostic | undefined {
  return diagnostics?.find((d) => d.code === 'PP9807' && /neither WebGPU/.test(d.message));
}

/** Show the notice in `viewport` when `diagnostics` say the browser can't draw; answers whether it did. */
export function showUnsupportedBrowser(viewport: HTMLElement, diagnostics: readonly Diagnostic[] | undefined): boolean {
  const found = unsupportedBrowser(diagnostics);
  if (found === undefined) return false;
  viewport.querySelector('.pp-unsupported-browser')?.remove();
  viewport.append(h('div.pp-unsupported-browser', { role: 'alert' }, h('div.box', {},
    h('h2', { text: t('boot.unsupportedTitle') }),
    h('p', { text: t('boot.unsupportedText') }),
    h('p', { text: t('boot.unsupportedHint') }),
    h('p', {}, h('code', { text: `${found.code}: ${found.message}` })),
  )));
  return true;
}
