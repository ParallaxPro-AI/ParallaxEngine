/**
 * Short notices over the editor, stacked newest-at-the-bottom: "Project saved" (success),
 * information, warnings and errors. `showToast(text, level)` from anywhere; the stack is
 * made on first use (fixed to the page, under the top bar). Each toast fades out after a
 * time that grows with its level, or on click; a repeat of a showing toast restarts its
 * timer instead of stacking a copy. At most `MAX_TOASTS` show at once (the oldest goes).
 */

import './toast.css';
import { h } from './dom.js';
import type { Editor } from './editor.js';
import { t } from './i18n.js';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export const MAX_TOASTS = 4;

/** How long a toast of each level stays, ms. */
export const TOAST_MS: Readonly<Record<ToastLevel, number>> = { info: 2500, success: 2000, warning: 5000, error: 8000 };

export interface ToastHandle {
  readonly el: HTMLElement;
  close(): void;
}

let stack: HTMLElement | undefined;
let root: HTMLElement | undefined;

/** Put the stack inside `el` (default `document.body`); call before the first toast to move it. */
export function setToastRoot(el: HTMLElement): void {
  root = el;
  if (stack !== undefined) el.append(stack);
}

function stackEl(): HTMLElement {
  if (stack === undefined || !stack.isConnected) {
    stack ??= h('div.pp-toast-stack', { role: 'status', 'aria-live': 'polite' });
    (root ?? document.body).append(stack);
  }
  return stack;
}

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function arm(el: HTMLElement, level: ToastLevel, ms: number | undefined): void {
  const old = timers.get(el);
  if (old !== undefined) clearTimeout(old);
  timers.set(el, setTimeout(() => dismiss(el), ms ?? TOAST_MS[level]));
}

function dismiss(el: HTMLElement): void {
  const timer = timers.get(el);
  if (timer !== undefined) clearTimeout(timer);
  if (!el.isConnected || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  // The fade (toast.css) then removal; removed at once where there is no animation.
  setTimeout(() => el.remove(), 180);
}

/** Show a toast; `durationMs` overrides the level's time (0 or less: stays until clicked). */
export function showToast(text: string, level: ToastLevel = 'info', options: { readonly durationMs?: number } = {}): ToastHandle {
  const parent = stackEl();
  const same = [...parent.children].find((c) => !c.classList.contains('leaving') && c.getAttribute('data-level') === level && c.textContent === text) as HTMLElement | undefined;
  const el = same ?? h(`div.pp-toast.${level}`, { 'data-level': level, role: level === 'error' ? 'alert' : 'status', title: t('toast.dismiss') }, text);
  if (same === undefined) {
    el.addEventListener('click', () => dismiss(el));
    parent.append(el);
    const showing = [...parent.children].filter((c) => !c.classList.contains('leaving')) as HTMLElement[];
    for (const extra of showing.slice(0, Math.max(0, showing.length - MAX_TOASTS))) dismiss(extra);
  }
  const ms = options.durationMs;
  if (ms === undefined || ms > 0) arm(el, level, ms);
  return { el, close: () => dismiss(el) };
}

/** "Project saved" (success) after every save that wrote files, Ctrl+S, Save or autosave. Answers a function that stops it. */
export function toastSaves(editor: Editor, text: () => string = () => t('toolbar.projectSaved')): () => void {
  return editor.on((changes) => {
    if (changes.has('saved')) showToast(text(), 'success');
  });
}
