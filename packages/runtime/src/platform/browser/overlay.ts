/**
 * The error overlay: coded diagnostics drawn over the game — code, message, where, the
 * fix and the docs link — the same blocks `parallax check` prints. Text only (never
 * markup from a message), so a diagnostic can't inject anything into the page.
 */

import type { Diagnostic } from '../../core/index.js';

const STYLE: Partial<Record<string, string>> = {
  position: 'absolute', inset: '0', overflow: 'auto', zIndex: '1000', padding: '24px',
  background: 'rgba(16, 16, 20, 0.94)', color: '#f2f2f2', font: '14px/1.5 ui-monospace, Menlo, Consolas, monospace',
  // Errors are for copying into a bug report or an agent: selectable even inside a page that isn't.
  userSelect: 'text', webkitUserSelect: 'text', cursor: 'text', pointerEvents: 'auto',
};

export class ErrorOverlay {
  readonly #host: HTMLElement;
  #root: HTMLElement | undefined;
  #shown: Diagnostic[] = [];

  constructor(host: HTMLElement) {
    this.#host = host;
  }

  /** What is on screen now. */
  get diagnostics(): readonly Diagnostic[] {
    return this.#shown;
  }

  /** Show `diagnostics` under `title`, replacing what was shown. */
  show(title: string, diagnostics: readonly Diagnostic[]): void {
    this.clear();
    const doc = this.#host.ownerDocument;
    const root = doc.createElement('div');
    root.setAttribute('role', 'alert');
    root.className = 'parallax-error-overlay';
    Object.assign(root.style, STYLE);

    const heading = doc.createElement('div');
    heading.textContent = title;
    Object.assign(heading.style, { fontSize: '18px', fontWeight: 'bold', marginBottom: '16px', color: '#ff6b6b' });
    root.append(heading);

    for (const d of diagnostics) {
      const block = doc.createElement('div');
      Object.assign(block.style, { marginBottom: '16px', paddingLeft: '12px', borderLeft: `3px solid ${d.severity === 'error' ? '#ff6b6b' : '#ffcc66'}` });
      const line = (text: string, color?: string): void => {
        const el = doc.createElement('div');
        el.textContent = text;
        if (color !== undefined) el.style.color = color;
        block.append(el);
      };
      line(`${d.code}  ${d.message}`, d.severity === 'error' ? '#ff9b9b' : '#ffd98a');
      if (d.path !== undefined) {
        const at = d.line !== undefined ? `${d.path}:${d.line}` : d.path;
        line(`at ${d.pointer !== undefined ? `${at}  (${d.pointer})` : at}`, '#a0a0b0');
      }
      if (d.fix !== undefined) line(`Fix: ${d.fix}`, '#9be29b');
      const docs = doc.createElement('a');
      docs.href = d.docs;
      docs.textContent = d.docs;
      docs.target = '_blank';
      docs.rel = 'noreferrer';
      docs.style.color = '#8ab4ff';
      block.append(docs);
      root.append(block);
    }
    this.#host.append(root);
    this.#root = root;
    this.#shown = [...diagnostics];
  }

  /**
   * Add the Python traceback of the error on screen (outermost call first), under its
   * diagnostics. Lines are text, as everything else here.
   */
  showTraceback(lines: readonly string[]): void {
    const root = this.#root;
    if (root === undefined || lines.length === 0) return;
    const doc = this.#host.ownerDocument;
    const block = doc.createElement('div');
    block.className = 'parallax-traceback';
    Object.assign(block.style, { marginBottom: '16px', paddingLeft: '12px', borderLeft: '3px solid #8ab4ff', whiteSpace: 'pre' });
    for (const text of ['Traceback (most recent call last):', ...lines.map((l) => `  ${l}`)]) {
      const el = doc.createElement('div');
      el.textContent = text;
      block.append(el);
    }
    // Under the heading, above the diagnostics' blocks: where it happened, then what.
    const heading = root.firstChild;
    if (heading !== null && heading.nextSibling !== null) root.insertBefore(block, heading.nextSibling);
    else root.append(block);
  }

  clear(): void {
    this.#root?.remove();
    this.#root = undefined;
    this.#shown = [];
  }
}
