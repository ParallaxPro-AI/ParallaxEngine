/**
 * Undo and redo as document patches. Every edit is the patches applied and their inverse
 * (`ProjectDocuments.apply` computes it), so undoing replays the inverse and redoing the
 * original — the documents are the only state, and the live game is rebuilt from them.
 *
 * Edits with the same `merge` key in a row become one step (a drag's many commits, typing
 * into one field), so one undo takes the whole gesture back.
 */

import type { FilePatch, ProjectDocuments } from './documents.js';

export interface Edit {
  readonly label: string;
  readonly patches: readonly FilePatch[];
  readonly inverse: readonly FilePatch[];
  readonly merge?: string;
}

export class EditHistory {
  readonly #documents: ProjectDocuments;
  readonly #done: Edit[] = [];
  readonly #undone: Edit[] = [];
  readonly #limit: number;

  constructor(documents: ProjectDocuments, options: { readonly limit?: number } = {}) {
    this.#documents = documents;
    this.#limit = options.limit ?? 500;
  }

  /** Apply patches as one undoable step; returns it. */
  commit(label: string, patches: readonly FilePatch[], options: { readonly merge?: string } = {}): Edit {
    const inverse = this.#documents.apply(patches);
    const last = this.#done.at(-1);
    let edit: Edit;
    if (options.merge !== undefined && last?.merge === options.merge && this.#undone.length === 0) {
      edit = { label: last.label, patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse], merge: options.merge };
      this.#done[this.#done.length - 1] = edit;
    } else {
      edit = { label, patches, inverse, ...(options.merge !== undefined && { merge: options.merge }) };
      this.#done.push(edit);
      if (this.#done.length > this.#limit) this.#done.shift();
    }
    this.#undone.length = 0;
    return edit;
  }

  /** End the current merge run: the next edit is its own step even with the same key. */
  seal(): void {
    const last = this.#done.at(-1);
    if (last?.merge !== undefined) {
      const { merge: _, ...sealed } = last;
      this.#done[this.#done.length - 1] = sealed;
    }
  }

  get canUndo(): boolean {
    return this.#done.length > 0;
  }

  get canRedo(): boolean {
    return this.#undone.length > 0;
  }

  /** Labels, oldest first, and how many of them are applied. */
  get entries(): { readonly labels: readonly string[]; readonly applied: number } {
    return { labels: [...this.#done, ...[...this.#undone].reverse()].map((e) => e.label), applied: this.#done.length };
  }

  undo(): Edit | undefined {
    const edit = this.#done.pop();
    if (edit === undefined) return undefined;
    this.#documents.apply(edit.inverse);
    this.#undone.push(edit);
    return edit;
  }

  /** Take the last edit back and forget it (no redo): an edit the game refused to load. */
  rollback(): Edit | undefined {
    const edit = this.#done.pop();
    if (edit === undefined) return undefined;
    this.#documents.apply(edit.inverse);
    return edit;
  }

  redo(): Edit | undefined {
    const edit = this.#undone.pop();
    if (edit === undefined) return undefined;
    this.#documents.apply(edit.patches);
    this.#done.push(edit);
    return edit;
  }

  clear(): void {
    this.#done.length = 0;
    this.#undone.length = 0;
  }
}
