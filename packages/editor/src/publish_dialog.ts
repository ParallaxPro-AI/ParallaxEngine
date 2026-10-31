/**
 * The editor's default Publish: a short "coming soon" note naming the site (`site.ts`).
 * A host page that has its own publish flow replaces it (`EditorHost.setPublishAction`).
 */

import { h } from './dom.js';
import { t } from './i18n.js';
import { currentSite } from './site.js';

export function comingSoonPublish(): Promise<void> {
  return new Promise((resolve) => {
    const close = (): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve();
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' || event.key === 'Enter') close(); };
    const dialog = h('div.publish-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('toolbar.publish') },
      h('div.publish-body', {},
        h('h2', { text: t('publish.comingSoonTitle') }),
        h('p', { text: t('publish.comingSoonText', { site: currentSite().host }) })),
      h('div.publish-actions', {}, h('button.publish-action', { type: 'button', text: t('publish.close'), onclick: close })));
    const overlay = h('div.publish-overlay', { onclick: (event: Event) => { if (event.target === overlay) close(); } }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
  });
}
