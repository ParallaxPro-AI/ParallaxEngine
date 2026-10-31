/**
 * A centred dialog over a dimmed backdrop: a header with
 * the title and a close X, then the body. Esc, the X and a click on the backdrop close it.
 */

import { t } from './i18n.js';
import { h, icon } from './dom.js';

export interface Modal {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  setTitle(text: string): void;
  close(): void;
}

export function showModal(options: { title: string; body?: readonly HTMLElement[]; width?: string; className?: string; closeLabel?: string; onClose?: () => void }): Modal {
  const title = h('div.modal-title', { text: options.title });
  const body = h('div.modal-body', {}, ...(options.body ?? []));
  const close = (): void => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    options.onClose?.();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const closeButton = h('button.modal-close', { type: 'button', 'aria-label': options.closeLabel ?? t('settings.close'), title: options.closeLabel ?? t('settings.close'), onclick: () => close() }, icon('x', 16));
  const el = h(`div.modal${options.className === undefined ? '' : `.${options.className}`}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
    h('div.modal-header', {}, title, closeButton), body);
  if (options.width !== undefined) el.style.width = options.width;
  const backdrop = h('div.modal-backdrop', {}, el);
  backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) close(); });
  // Esc closes the dialog before the editor's shortcuts see it.
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  try {
    document.exitPointerLock?.();
  } catch {
    // Not locked.
  }
  (el.querySelector('select, input, button:not(.modal-close)') as HTMLElement | null)?.focus();
  return { el, body, setTitle: (text) => { title.textContent = text; el.setAttribute('aria-label', text); }, close };
}
