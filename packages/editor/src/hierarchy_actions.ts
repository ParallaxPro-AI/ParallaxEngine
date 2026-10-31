/**
 * The hierarchy's entity and scene actions over an Editor: what its menus, drag and drop and
 * shortcuts call. Each one is an undoable session edit; a refused one goes to the console.
 */

import { Vec3 } from '@parallax/runtime/core';
import type { EntityId } from '@parallax/runtime/core';
import type { EntryCopy, PrimitiveKind } from './session/index.js';
import type { Editor } from './editor.js';

/** Where a new entity goes: eight meters ahead of the editor camera (3D, above the ground), or the view's center (2D). */
export function spawnPoint(editor: Editor): number[] {
  const pose = editor.session.cameraPose;
  const round = (n: number): number => Math.round(n * 100) / 100;
  if (editor.session.dimension === '2d') return [round(pose.position.x), round(pose.position.y)];
  const p = pose.position.__add__(pose.rotation.rotate(Vec3.FORWARD).__mul__(8));
  return [round(p.x), round(Math.max(0, p.y)), round(p.z)];
}

export function addPrimitive(editor: Editor, kind: PrimitiveKind): void {
  if (!editor.editing) return;
  const id = editor.run(`Add ${kind.replace(/_/g, ' ')}`, () => editor.session.addPrimitive(kind, spawnPoint(editor)), 'world', 'selection');
  if (id !== undefined) editor.select([id]);
}

export function createChild(editor: Editor, parent: EntityId): void {
  if (!editor.editing) return;
  editor.run('Create Child', () => editor.session.createChild(parent), 'world', 'selection');
  editor.requestRename();
}

export function duplicate(editor: Editor, ids: readonly EntityId[] = editor.session.selection): void {
  if (!editor.editing || ids.length === 0) return;
  editor.run('Duplicate', () => editor.session.duplicateEntities(ids), 'world', 'selection');
}

export function remove(editor: Editor, ids: readonly EntityId[] = editor.session.selection): void {
  if (!editor.editing || ids.length === 0) return;
  editor.run('Delete', () => {
    editor.session.deleteEntities(ids);
    editor.session.select([]);
  }, 'world', 'selection');
}

/** The editor's clipboard: entries as their files hold them, so they paste into any scene. */
let clipboard: readonly EntryCopy[] = [];

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}

export function copy(editor: Editor, ids: readonly EntityId[] = editor.session.selection): void {
  if (!editor.editing || ids.length === 0) return;
  const copies = editor.run('Copy', () => editor.session.copyEntities(ids));
  if (copies !== undefined) clipboard = copies;
}

/** Paste the clipboard at the scene's root, or under `parent` (into its prefab). */
export function paste(editor: Editor, parent: EntityId | null = null): void {
  if (!editor.editing || clipboard.length === 0) return;
  editor.run('Paste', () => editor.session.pasteEntities(clipboard, parent), 'world', 'selection');
}

/**
 * Reorder or reparent (`parent` null: the scene's root; `before` null: last). Moving under
 * a parent writes into its prefab, which every instance of it shares: said in the console.
 */
export function move(editor: Editor, ids: readonly EntityId[], parent: EntityId | null, before: EntityId | null): void {
  if (!editor.editing || ids.length === 0) return;
  const session = editor.session;
  const prefab = parent === null ? undefined : session.sourceOf(parent)?.prefab;
  const moved = editor.run('Move', () => session.moveEntities(ids, parent, before), 'world', 'selection');
  if (moved !== undefined && prefab !== undefined) {
    const instances = [...session.runtime.kernel.world.live()].filter((r) => r.prefab === prefab).length;
    if (instances > 1) editor.write('info', `Moved into prefab "${prefab}": its ${instances} instances all have it now (undo takes it back)`);
  }
}

/** Hide or show entities in the edit view only (the eye): all of them follow the first. */
export function toggleEditorHidden(editor: Editor, ids: readonly EntityId[]): void {
  if (!editor.editing || ids.length === 0) return;
  const hide = !editor.session.isEditorHidden(ids[0]!);
  editor.session.setEditorHidden(ids, hide);
  editor.emit('world');
}

/** Show or hide entities in the game (written to the documents). */
export function setVisibleInGame(editor: Editor, ids: readonly EntityId[], visible: boolean): void {
  if (!editor.editing || ids.length === 0) return;
  editor.run(visible ? 'Show' : 'Hide', () => editor.session.setVisible(ids, visible), 'world');
}

export function frame(editor: Editor, ids: readonly EntityId[]): void {
  if (ids.length === 0) return;
  editor.select(ids);
  editor.run('Focus', () => editor.session.frameSelection());
}

// ── Scenes ───────────────────────────────────────────────────────────────────

export function createScene(editor: Editor, id: string): void {
  if (!editor.editing) return;
  editor.rememberCamera();
  editor.run('New scene', () => editor.session.createScene(id), 'world', 'selection', 'documents');
}

export function renameScene(editor: Editor, from: string, to: string): void {
  if (!editor.editing || from === to) return;
  editor.run('Rename scene', () => editor.session.renameScene(from, to), 'world', 'selection', 'documents');
}

export function deleteScene(editor: Editor, id: string): void {
  if (!editor.editing) return;
  editor.run('Delete scene', () => editor.session.deleteScene(id), 'world', 'selection', 'documents');
}
