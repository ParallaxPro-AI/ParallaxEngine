/**
 * An asset's detail popover: the big preview — the
 * waveform and a player for audio, the image, a model's portrait — its name, "Category: X ·
 * Used in N project files", and its actions. The X, Esc or a click outside closes it; it
 * sits on the modal layer, above the viewport and every panel.
 */

import { h, icon } from './dom.js';
import type { IconName } from './dom.js';
import { t } from './i18n.js';

export interface AssetDetailAction {
  readonly label: string;
  readonly primary?: boolean;
  run(): void;
}

export interface AssetDetail {
  readonly name: string;
  readonly category: string;
  readonly usedIn: number;
  /** The reference, shown small under the name (a path or URL). */
  readonly ref: string;
  readonly glyph: IconName;
  /** The preview image, when there is one (or will be: a promise). */
  readonly preview?: Promise<string | null> | string | null;
  /** Audio: the file to play. */
  readonly audio?: string;
  /** Image previews scale up crisply (pixel art) rather than blur. */
  readonly pixelated?: boolean;
  readonly actions: readonly AssetDetailAction[];
}

let open: (() => void) | undefined;

export function closeAssetDetail(): void {
  open?.();
}

export function showAssetDetail(detail: AssetDetail): void {
  closeAssetDetail();
  const close = (): void => {
    if (!overlay.isConnected) return;
    overlay.querySelector('audio')?.pause();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (open === close) open = undefined;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const placeholder = h('div.asset-preview-icon', {}, icon(detail.glyph, 56));
  const content = h('div.asset-preview-content', {}, placeholder);
  const show = (url: string | null): void => {
    if (url === null || !overlay.isConnected) return;
    const img = h(detail.audio !== undefined ? 'img.asset-preview-waveform' : 'img.asset-preview-image', { src: url, alt: '' });
    if (detail.pixelated === true) img.classList.add('pixelated');
    placeholder.replaceWith(img);
  };
  if (detail.audio !== undefined) {
    const player = h('audio.asset-preview-audio', { controls: true, preload: 'metadata', src: detail.audio });
    content.append(player);
  }

  const meta = h('div.asset-preview-meta', {},
    h('span', { text: `${t('assets.metaCategory')}: ${detail.category}` }),
    detail.usedIn > 0 ? h('span', { text: t('assets.metaUsedIn', { count: detail.usedIn }) }) : null);
  const info = h('div.asset-preview-info', {},
    h('div.asset-preview-name', { text: detail.name }),
    h('div.asset-preview-ref', { text: detail.ref, title: detail.ref }),
    meta);
  const actions = detail.actions.length === 0 ? null : h('div.asset-preview-actions', {},
    ...detail.actions.map((action) => h(action.primary === true ? 'button.asset-preview-action.primary' : 'button.asset-preview-action', {
      type: 'button', text: action.label, onclick: () => { close(); action.run(); },
    })));
  const dialog = h('div.asset-preview-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': detail.name },
    h('button.modal-close.asset-preview-close', { type: 'button', 'aria-label': t('settings.close'), title: t('settings.close'), onclick: () => close() }, icon('x', 16)),
    content, info, actions);
  const overlay = h('div.asset-preview-overlay', {}, dialog);
  overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  open = close;

  const preview = detail.preview;
  if (typeof preview === 'string') show(preview);
  else if (preview instanceof Promise) void preview.then(show);
}
