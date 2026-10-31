/**
 * Editor keyboard shortcuts. While the game plays it owns
 * the keyboard: only Ctrl / Cmd+P (stop) reaches the editor. In a text field only Escape and
 * Ctrl / Cmd + S, Z, Y (and P) are shortcuts; everything else is typing.
 *
 *   Ctrl/Cmd+P         play / stop          Ctrl/Cmd+S        save
 *   Ctrl/Cmd+Z         undo                 Ctrl/Cmd+Shift+Z  redo (also Ctrl+Y)
 *   Ctrl/Cmd+D         duplicate            Ctrl/Cmd+A        select every placement
 *   1 / 2 / 3          move / rotate / scale gizmo (W / E / R too, except in fly mode)
 *   4                  orbit / fly camera   5                 world / local (X too)
 *   F                  frame the selection  Delete, Backspace remove the selection
 *   F2                 rename the selection Ctrl/Cmd+C / V    copy / paste entities
 *   Escape             cancel a drag, else clear the selection
 *
 * Fly mode's W A S D Q E are the viewport's (see viewport.ts), never gizmo keys.
 */

import type { EntityId } from '@parallax/runtime/core';
import type { Editor } from './editor.js';
import { copy, duplicate, paste } from './hierarchy_actions.js';
import type { Viewport } from './viewport.js';

export type ShortcutAction =
  | 'play' | 'stop' | 'save' | 'undo' | 'redo' | 'duplicate' | 'select-all'
  | 'translate' | 'rotate' | 'scale' | 'camera-mode' | 'space' | 'frame' | 'delete' | 'escape'
  | 'rename' | 'copy' | 'paste';

export interface ShortcutContext {
  /** The key went to a text field. */
  readonly typing?: boolean;
  /** The camera is flying (fly mode, or a look drag): W / E / R are movement, not gizmo keys. */
  readonly flying?: boolean;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/** What a key press means, or null. Pure: tested without a page. */
export function shortcutFor(event: KeyLike, mode: 'edit' | 'playing' | 'paused', context: ShortcutContext = {}): ShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey;
  // Case-insensitive: with Caps Lock or Shift held, key is 'S' / 'Z'.
  const key = event.key.toLowerCase();
  if (mod && key === 'p') return mode === 'edit' ? 'play' : 'stop';
  if (mode !== 'edit') return null;
  if (mod && key === 's') return 'save';
  if (mod && key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (mod && key === 'y') return 'redo';
  if (key === 'escape') return 'escape';
  if (context.typing === true) return null;
  if (mod && key === 'd') return 'duplicate';
  if (mod && key === 'a') return 'select-all';
  if (mod && key === 'c') return 'copy';
  if (mod && key === 'v') return 'paste';
  if (mod || event.altKey) return null;
  switch (key) {
    case '1': return 'translate';
    case '2': return 'rotate';
    case '3': return 'scale';
    case '4': return 'camera-mode';
    case '5': return 'space';
    case 'w': return context.flying === true ? null : 'translate';
    case 'e': return context.flying === true ? null : 'rotate';
    case 'r': return context.flying === true ? null : 'scale';
    case 'x': return 'space';
    case 'f': return 'frame';
    case 'f2': return 'rename';
    case 'delete': case 'backspace': return 'delete';
    default: return null;
  }
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Copy the selection next to itself (a fresh id or name) and select the copies. */
export function duplicateSelected(editor: Editor): void {
  duplicate(editor);
}

/** Select every placement of the open scene. */
export function selectAll(editor: Editor): void {
  if (!editor.editing) return;
  const ids: EntityId[] = [];
  for (const [id, source] of editor.session.sources.sources) if (source.kind === 'placement') ids.push(id);
  editor.select(ids);
}

export function installShortcuts(editor: Editor, viewport: Viewport): () => void {
  const onKey = (event: KeyboardEvent): void => {
    const action = shortcutFor(event, editor.session.mode, { typing: typing(event.target), flying: viewport.flying });
    if (action === null) return;
    // Text selected on the page (the console) copies as text.
    if (action === 'copy' && String(globalThis.getSelection?.() ?? '') !== '') return;
    event.preventDefault();
    switch (action) {
      case 'play': editor.play(); break;
      case 'stop': editor.stop(); break;
      case 'save': void editor.save(); break;
      case 'undo': editor.undo(); break;
      case 'redo': editor.redo(); break;
      case 'duplicate': duplicateSelected(editor); break;
      case 'select-all': selectAll(editor); break;
      case 'translate': case 'rotate': case 'scale':
        editor.gizmo.mode = action;
        editor.emit('gizmo');
        break;
      case 'camera-mode': viewport.toggleCameraMode(); break;
      case 'space':
        editor.gizmo.space = editor.gizmo.space === 'world' ? 'local' : 'world';
        editor.emit('gizmo');
        break;
      case 'frame': viewport.frameSelection(); break;
      case 'delete': editor.removeSelected(); break;
      case 'rename': editor.requestRename(); break;
      case 'copy': copy(editor); break;
      case 'paste': paste(editor); break;
      case 'escape':
        if (!viewport.cancelGesture(editor)) editor.select([]);
        break;
    }
  };
  // Capture: the game's stage listens too, and must not see editor shortcuts first.
  globalThis.addEventListener('keydown', onKey, { capture: true });
  return () => globalThis.removeEventListener('keydown', onKey, { capture: true });
}
