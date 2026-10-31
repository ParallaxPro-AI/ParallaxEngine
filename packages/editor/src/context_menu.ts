/**
 * A context menu at the pointer (or under a button):
 * items with shortcut hints, disabled and danger items, separators and headings. A click
 * outside, Esc, a scroll or the window losing focus closes it; arrow keys and Enter work.
 * Also a small name prompt over the modal dialog.
 */

import { h } from './dom.js';
import type { MenuAction, MenuEntry, MenuItem } from './hierarchy_model.js';
import { showModal } from './modal.js';
import { t } from './i18n.js';

let open: { close(): void } | undefined;

/** Close the open menu, if any. */
export function closeMenu(): void {
  open?.close();
}

/** Show a menu with its top-left at (x, y) page pixels (kept on screen); `pick` hears the chosen action. */
export function showMenu(entries: readonly MenuEntry[], x: number, y: number, pick: (action: MenuAction) => void): void {
  closeMenu();
  const items: { el: HTMLButtonElement; item: MenuItem }[] = [];
  const menu = h('div.ctx-menu', { role: 'menu' });
  for (const entry of entries) {
    if (entry === 'separator') {
      if (menu.lastElementChild !== null && !menu.lastElementChild.classList.contains('ctx-separator')) menu.append(h('div.ctx-separator', { role: 'separator' }));
      continue;
    }
    if ('heading' in entry) {
      menu.append(h('div.ctx-heading', { text: entry.heading }));
      continue;
    }
    const el = h(`button.ctx-item${entry.danger === true ? '.danger' : ''}`, {
      type: 'button', role: 'menuitem', disabled: entry.disabled === true, title: entry.title,
      onclick: () => {
        close();
        pick(entry.action);
      },
    }, h('span.ctx-label', { text: entry.label }), entry.shortcut === undefined ? null : h('span.ctx-shortcut', { text: entry.shortcut }));
    el.dataset['action'] = entry.action;
    items.push({ el, item: entry });
    menu.append(el);
  }
  if (menu.lastElementChild?.classList.contains('ctx-separator') === true) menu.lastElementChild.remove();
  document.body.append(menu);
  const { innerWidth: w, innerHeight: hgt } = window;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, w - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, y + box.height > hgt - 4 ? y - box.height : y)}px`;

  const enabled = (): HTMLButtonElement[] => items.map((i) => i.el).filter((el) => !el.disabled);
  const onKey = (event: KeyboardEvent): void => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
    else if (event.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onDown = (event: Event): void => {
    if (!menu.contains(event.target as Node)) close();
  };
  const close = (): void => {
    if (!menu.isConnected) return;
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', close, true);
    if (open?.close === close) open = undefined;
  };
  // Esc closes the menu before the editor's shortcuts see it.
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
  open = { close };
}

/** Show a menu under (or above) an element, e.g. the "+" button. */
export function showMenuAt(anchor: Element, entries: readonly MenuEntry[], pick: (action: MenuAction) => void): void {
  const box = anchor.getBoundingClientRect();
  showMenu(entries, box.left, box.bottom + 2, pick);
}

/** Ask for a name; resolves to the trimmed text, or null when cancelled. */
export function promptName(title: string, value: string, options: { readonly placeholder?: string; readonly hint?: string; readonly confirm?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve(result);
    };
    const input = h('input.prompt-input', { type: 'text', value, placeholder: options.placeholder ?? '', spellcheck: 'false', 'aria-label': title });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim()); }
    });
    const ok = h('button.modal-button.primary', { type: 'button', text: options.confirm ?? t('common.ok'), onclick: () => finish(input.value.trim()) });
    const cancel = h('button.modal-button', { type: 'button', text: t('settings.cancel'), onclick: () => finish(null) });
    const modal = showModal({
      title, width: '360px', className: 'prompt-modal', onClose: () => { if (!done) { done = true; resolve(null); } },
      body: [
        input,
        ...(options.hint === undefined ? [] : [h('div.prompt-hint', { text: options.hint })]),
        h('div.modal-actions', {}, cancel, ok),
      ],
    });
    input.focus();
    input.select();
  });
}
