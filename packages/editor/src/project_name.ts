/**
 * Renaming the project from the top bar. The editor keeps no name of its own (a `parallax edit`
 * project is its folder), so the name is renamable only when a host says where it is stored
 * (`EditorHost.setRenameAction`). Then a click on the name asks for the new one in a small
 * Rename Project dialog; the host's action stores it, and the
 * editor shows it everywhere (top bar, page title, Publish's context) once that succeeded.
 */

import { h } from './dom.js';
import { t } from './i18n.js';
import { showModal } from './modal.js';
import type { Editor } from './editor.js';

/** Longest project name the prompt takes. */
export const MAX_PROJECT_NAME = 120;

/** What a host's rename gets: the new name (trimmed, non-empty, changed) and the editor. */
export interface RenameContext {
  readonly editor: Editor;
  /** The name before this rename. */
  readonly previous: string;
}

/** Store the new name; a rejection keeps the old one and is reported. */
export type RenameAction = (name: string, context: RenameContext) => void | Promise<void>;

/** The name to rename to: trimmed and capped; null for an empty or unchanged one. */
export function cleanProjectName(input: string | null | undefined, current: string): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ').slice(0, MAX_PROJECT_NAME).trim();
  return name === '' || name === current ? null : name;
}

/** The parts of the editor a rename touches (an `Editor` has them; tests pass a fake). */
export interface RenameTarget {
  readonly title: string;
  setTitle(title: string): void;
  fail(what: string, error: unknown): void;
}

/**
 * Run a rename: the host's action, then the editor's title. True when the project was renamed;
 * false when the name was empty or unchanged, or the action failed (reported as `Rename failed`).
 */
export async function renameProject(target: RenameTarget, input: string | null, action: RenameAction, editor: Editor): Promise<boolean> {
  const previous = target.title;
  const name = cleanProjectName(input, previous);
  if (name === null) return false;
  try {
    await action(name, { editor, previous });
  } catch (error) {
    target.fail(t('toolbar.renameFailed'), error);
    return false;
  }
  target.setTitle(name);
  return true;
}

/** Ask for the project's new name: the entered text, or null when cancelled. */
export function promptProjectName(current: string): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value: string | null): void => {
      if (answered) return;
      answered = true;
      resolve(value);
      modal.close();
    };
    const input = h('input.settings-input.rename-input', {
      type: 'text', value: current, placeholder: t('toolbar.projectNamePlaceholder'), maxlength: String(MAX_PROJECT_NAME),
      'aria-label': t('toolbar.renameProject'),
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value);
      }
      event.stopPropagation(); // typing a name is not an editor shortcut
    });
    const actions = h('div.modal-actions', {},
      h('button.modal-button', { type: 'button', text: t('settings.cancel'), onclick: () => finish(null) }),
      h('button.modal-button.primary', { type: 'button', text: t('hierarchy.rename'), onclick: () => finish(input.value) }));
    const modal = showModal({
      title: t('toolbar.renameProject'), className: 'rename-modal', width: '360px', closeLabel: t('settings.close'),
      body: [input, actions], onClose: () => finish(null),
    });
    input.focus();
    input.select();
  });
}
