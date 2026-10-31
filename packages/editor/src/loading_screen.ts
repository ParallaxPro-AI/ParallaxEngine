/**
 * The editor's loading indicator: a purple spinner, the
 * step label ("Loading scripts", "Preparing scene", ...) and a thin purple bar, centred over
 * `root` until it is ready, then faded out. The editor puts it over the viewport only (the
 * shell around it is usable at once); `compact` is that smaller variant. Styles: the
 * Loading section at the end of styles.css.
 *
 *   const loading = showEditorLoading(viewport, { compact: true });
 *   loading.progress(0.4, 'Starting engine');
 *   loading.done();
 *
 * The bar never goes back (a late, smaller fraction is ignored); `done` fills it, fades
 * the curtain and removes it, and is safe to call twice. Calls after `done` do nothing.
 */

import { t } from './i18n.js';
import { h } from './dom.js';

/** Matches `.editor-loading`'s opacity transition. */
const FADE_MS = 250;

export interface EditorLoading {
  /** `fraction` 0..1 of the way through startup; `text` replaces the label when given. */
  progress(fraction: number, text?: string): void;
  /** Startup finished: fill the bar, fade the curtain out and remove it. */
  done(): void;
}

/** The bar's width for a reported fraction, never below what was already shown. */
export function loadingFraction(shown: number, fraction: number): number {
  const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return Math.max(shown, clamped);
}

export interface EditorLoadingOptions {
  /** The first label (default "Loading…"). */
  readonly label?: string;
  /** The smaller look, for a part of the page (the viewport) rather than all of it. */
  readonly compact?: boolean;
  /** Stay invisible this long, so a quick step (a hot reload) doesn't flash. */
  readonly delayMs?: number;
}

export function showEditorLoading(root: HTMLElement, options: EditorLoadingOptions = {}): EditorLoading {
  const label = h('div.editor-loading-text', { text: options.label ?? t('toolbar.loading') });
  const fill = h('div.editor-loading-fill');
  const el = h(options.compact === true ? 'div.editor-loading.compact' : 'div.editor-loading', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0, 'aria-label': t('boot.loadingEditor') },
    h('div.editor-loading-spinner'),
    label,
    h('div.editor-loading-bar', {}, fill));
  // The curtain is absolutely placed over `root`: give a static root a containing block.
  if (root.ownerDocument.defaultView?.getComputedStyle(root).position === 'static') root.style.position = 'relative';
  if ((options.delayMs ?? 0) > 0) {
    el.classList.add('editor-loading-pending');
    setTimeout(() => el.classList.remove('editor-loading-pending'), options.delayMs);
  }
  root.append(el);

  let shown = 0;
  let finished = false;
  const paint = (): void => {
    fill.style.width = `${(shown * 100).toFixed(1)}%`;
    el.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
  };

  return {
    progress(fraction, text) {
      if (finished) return;
      shown = loadingFraction(shown, fraction);
      if (text !== undefined && text !== '') label.textContent = text;
      el.setAttribute('aria-valuetext', `${label.textContent ?? ''} ${Math.round(shown * 100)}%`);
      paint();
    },
    done() {
      if (finished) return;
      finished = true;
      shown = 1;
      paint();
      el.classList.add('editor-loading-done');
      setTimeout(() => el.remove(), FADE_MS + 50);
    },
  };
}
