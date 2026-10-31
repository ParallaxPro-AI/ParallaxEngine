/**
 * The editor's language: `t(key, params)` looks a string up in the chosen language, falling
 * back to English, then to the key. The choice persists in localStorage (best effort) and
 * starts from the browser's language.
 */

import { LANGUAGES, MESSAGES } from './locales.js';

export { LANGUAGES };

const STORE = 'parallax-editor:language';
const listeners = new Set<() => void>();

function initial(): string {
  try {
    const saved = globalThis.localStorage?.getItem(STORE);
    if (saved !== null && saved !== undefined && MESSAGES[saved] !== undefined) return saved;
  } catch {
    // No storage: the browser's language.
  }
  const wanted = (globalThis.navigator?.language ?? 'en').toLowerCase();
  return LANGUAGES.find((l) => l.code.toLowerCase() === wanted)?.code
    ?? LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === wanted.split('-')[0])?.code
    ?? 'en';
}

let current = initial();

export function language(): string {
  return current;
}

export function setLanguage(code: string): void {
  if (MESSAGES[code] === undefined || code === current) return;
  current = code;
  try {
    globalThis.localStorage?.setItem(STORE, code);
  } catch {
    // Not kept past this page.
  }
  if (globalThis.document !== undefined) {
    document.documentElement.lang = code;
    retranslate(document);
  }
  for (const listener of listeners) listener();
}

type Bound = 'text' | 'title' | 'placeholder' | 'aria-label';

const BOUND_ATTRS: Readonly<Record<Bound, string>> = {
  text: 'data-i18n', title: 'data-i18n-title', placeholder: 'data-i18n-placeholder', 'aria-label': 'data-i18n-aria-label',
};

/**
 * Attributes for `h()` that show `key` now and follow every later language change, for text
 * built once and never re-rendered: `h('button', { ...lt('perf.copyStats'), ...lt('perf.copyStatsTitle', 'title') })`.
 */
export function lt(key: string, attr: Bound = 'text'): Record<string, string> {
  return { [attr]: t(key), [BOUND_ATTRS[attr]]: key };
}

/** Re-apply every `lt()` binding under `root` in the current language. */
export function retranslate(root: ParentNode): void {
  const selector = Object.values(BOUND_ATTRS).map((a) => `[${a}]`).join(',');
  for (const el of root.querySelectorAll(selector)) {
    for (const [attr, data] of Object.entries(BOUND_ATTRS) as [Bound, string][]) {
      const key = el.getAttribute(data);
      if (key === null) continue;
      if (attr === 'text') el.textContent = t(key);
      else el.setAttribute(attr, t(key));
    }
  }
}

/** Hear language changes; returns a function that stops listening. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The string for `key` in the current language; `{name}` placeholders take `params`. */
export function t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const text = MESSAGES[current]?.[key] ?? MESSAGES['en']?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] !== undefined ? String(params[name]) : match));
}
