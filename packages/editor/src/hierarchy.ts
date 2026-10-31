/**
 * The scene hierarchy: the world's entities as a tree (placements and their prefab
 * children; while playing, everything alive, refreshed twice a second), under the open
 * scene's row.
 *
 *   click          select; Ctrl / Cmd toggles one; Shift selects the range from the last click
 *   empty space    click deselects; right-click opens the add menu
 *   double-click   rename in place (F2 too); while playing it frames the entity (F frames always)
 *   right-click    Rename, Duplicate, Copy / Paste, Create Child, Focus, Hide / Show, Delete
 *                  (for the selection when the row is in it); on the scene row, scene actions
 *   drag           reorder (drop above / below a row) or reparent (drop on its middle)
 *   eye            hide in the editor only: not drawn, not picked, never saved
 *   "+"            Empty Entity, Cube, Sphere, Plane, lights, Camera, Prefab…, New Scene…
 *
 * Every scene of the project has a row. The open scene's row is expanded (its live entities);
 * the others start collapsed: expanding one lists its placements from the scene file, and
 * clicking it (or one of its placements) opens that scene (edit mode only).
 *
 * Rows show the entity's kind (camera, light, model, shape, prefab group, empty); entities
 * hidden in the game, and their children, are greyed. Huge scenes build ROW_CAP rows until
 * "Show all" is pressed. The edits themselves are the session's (hierarchy_actions.ts).
 */

import type { EntityId } from '@parallax/runtime/core';
import type { EntityRecord } from '@parallax/runtime/kernel';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { Origin, Project, SceneDoc } from '@parallax/runtime/resource';
import { inheritedFrom, toId } from './session/index.js';
import type { PrimitiveKind } from './session/index.js';
import type { Editor } from './editor.js';
import { clear, h, icon, panelFrame } from './dom.js';
import { onLanguageChange, t } from './i18n.js';
import { closeMenu, promptName, showMenu, showMenuAt } from './context_menu.js';
import * as actions from './hierarchy_actions.js';
import {
  addMenu, clickSelection, dropPosition, dropTarget, entityKind, entityMenu, flattenTree, inheritedNote, KIND_ICON, otherSceneMenu, ROW_CAP, sceneEntries,
  primitiveLabel, sceneMenu, scenePreviewRows, tr,
} from './hierarchy_model.js';
import type { DropPosition, EntityKind, MenuAction, ScenePreviewRow, TreeRow } from './hierarchy_model.js';

/** What the hierarchy calls an entity. */
export function entityLabel(record: Pick<EntityRecord, 'id' | 'placedId' | 'name' | 'childName' | 'prefab'>): string {
  return record.placedId ?? record.name ?? record.childName
    ?? (record.prefab === undefined ? undefined : primitiveLabel(record.prefab) ?? record.prefab)
    ?? t('hierarchy.entityN', { id: record.id });
}

/** A closed scene's placement's kind (its row icon), from its prefab's components; empty when the prefab can't be resolved. */
function previewKind(project: Project, prefab: string): EntityKind {
  try {
    const doc = resolvePrefab(project, prefab);
    const components = doc.components;
    return entityKind({ has: (id) => components[id] !== undefined, get: (id) => components[id] }, doc.children.length);
  } catch {
    return 'empty';
  }
}

const DRAG_TYPE = 'application/x-parallax-entities';
const DROP_CLASSES = ['drop-above', 'drop-below', 'drop-inside'];

function modLabel(): string {
  return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl+';
}

export class HierarchyPanel {
  readonly el: HTMLElement;
  readonly #editor: Editor;
  readonly #body: HTMLElement;
  readonly #filter: HTMLInputElement;
  readonly #onAdd: (() => void) | undefined;
  readonly #collapsed = new Set<string>();
  /** Scenes other than the open one that were expanded (they start collapsed). */
  readonly #expandedScenes = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Rows in display order at the last render (Shift-click ranges). */
  #order: EntityId[] = [];
  #rows = new Map<EntityId, HTMLElement>();
  /** The last row clicked without Shift: where a Shift range starts. */
  #anchor: EntityId | undefined;
  /** An in-place rename is open: renders wait for it. */
  #renaming = false;
  #renderPending = false;
  /** Build every row, past ROW_CAP (reset when the scene changes). */
  #showAll = false;
  #shownScene = '';
  #dragging: EntityId[] = [];

  constructor(editor: Editor, onAdd?: () => void) {
    this.#editor = editor;
    this.#onAdd = onAdd;
    this.#filter = h('input.panel-filter', { type: 'search', placeholder: t('hierarchy.searchEntities'), 'aria-label': t('hierarchy.searchEntities'), oninput: () => this.render() });
    const add = h('button.panel-action', {
      type: 'button', title: t('hierarchy.addEntity'), 'aria-label': t('hierarchy.addEntity'), 'aria-haspopup': 'menu',
      onclick: () => showMenuAt(add, addMenu(editor.session.dimension, { editing: editor.editing }), (action) => this.#act(action, [])),
    }, icon('plus', 14));
    const frame = panelFrame(t('hierarchy.title'), add);
    onLanguageChange(() => {
      frame.header.querySelector('.panel-title')!.textContent = t('hierarchy.title');
      this.#filter.placeholder = t('hierarchy.searchEntities');
      add.title = t('hierarchy.addEntity');
      this.render();
    });
    frame.root.classList.add('hierarchy-panel');
    frame.header.after(h('div.panel-toolbar', {}, this.#filter));
    this.#body = frame.body;
    this.#body.classList.add('hierarchy-body');
    this.el = frame.root;
    this.#listenOnEmptySpace();
    editor.on((changes) => {
      if (changes.has('mode')) this.#watch();
      if (changes.has('world') || changes.has('selection') || changes.has('mode') || changes.has('documents')) this.render();
      if (changes.has('rename')) {
        const [first] = editor.session.selection;
        if (first !== undefined) this.startRename(first);
      }
    });
    this.render();
  }

  /** While the game runs, entities come and go on their own. */
  #watch(): void {
    clearInterval(this.#timer);
    this.#timer = this.#editor.editing ? undefined : setInterval(() => this.render(), 500);
  }

  #roots(): EntityRecord[] {
    const session = this.#editor.session;
    const world = session.runtime.kernel.world;
    const camera = session.cameraEntity;
    return [...world.live()].filter((r) => r.parent === null && r.id !== camera && r.id !== this.#editor.playCamera && (!this.#editor.editing || session.sourceOf(r.id) !== undefined));
  }

  #children(record: EntityRecord): EntityRecord[] {
    const world = this.#editor.session.runtime.kernel.world;
    return record.children.map((c) => world.get(c)).filter((r): r is EntityRecord => r !== undefined && r.alive);
  }

  #keyOf(record: EntityRecord): string {
    return this.#editor.session.sourceOf(record.id)?.key ?? `entity:${record.id}`;
  }

  /** Whether entities come from the documents, so the hierarchy can edit them. */
  #documented(ids: readonly EntityId[]): boolean {
    const session = this.#editor.session;
    return this.#editor.editing && ids.every((id) => session.sourceOf(id) !== undefined);
  }

  render(): void {
    if (this.#renaming) {
      this.#renderPending = true;
      return;
    }
    const editor = this.#editor;
    const session = editor.session;
    if (session.scene !== this.#shownScene) {
      this.#shownScene = session.scene;
      this.#showAll = false;
    }
    const selected = new Set(session.selection);
    const query = this.#filter.value.trim().toLowerCase();
    const scroll = this.#body.scrollTop;
    clear(this.#body);
    this.#rows.clear();
    const list = h('ul.tree', { role: 'tree', 'aria-multiselectable': 'true' });

    const project = session.documents.project();
    const entries = sceneEntries(session.scenes, session.scene, { collapsed: this.#collapsed, expanded: this.#expandedScenes, searching: query !== '' });
    this.#order = [];
    for (const entry of entries) {
      if (entry.active) {
        this.#activeScene(list, entry.open, `scene:${entry.id}`, query, selected);
        continue;
      }
      const doc = project.scenes.get(entry.id);
      const previews = doc === undefined || !entry.open ? [] : scenePreviewRows(doc.entities, query);
      // While searching, a closed scene shows only when something in it (or its name) matches.
      if (query !== '' && previews.length === 0 && !entry.id.toLowerCase().includes(query)) continue;
      list.append(this.#otherSceneRow(entry.id, entry.open, doc));
      if (!entry.open) continue;
      const limit = Math.min(previews.length, ROW_CAP);
      for (let i = 0; i < limit; i++) list.append(this.#previewRow(entry.id, previews[i]!, project));
      if (limit < previews.length) {
        list.append(h('li.tree-more', { role: 'treeitem', text: tr('hierarchy.moreInScene', '{count} more', { count: previews.length - limit }), onclick: () => this.#openOther(entry.id) }));
      }
      if (previews.length === 0 && query === '') list.append(h('li.tree-empty', { text: tr('hierarchy.scenePlacesNothing', 'Places nothing yet.') }));
    }
    this.#body.append(list);
    this.#body.scrollTop = scroll;
    // While playing the tree refreshes on a timer: leave the scroll where the user put it.
    if (editor.editing) this.#body.querySelector('.tree-row.selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  /** The open scene's row and, expanded, its live entities. */
  #activeScene(list: HTMLElement, sceneOpen: boolean, sceneKey: string, query: string, selected: ReadonlySet<EntityId>): void {
    const editor = this.#editor;
    const session = editor.session;
    list.append(this.#sceneRow(sceneOpen, sceneKey));
    const roots = this.#roots();
    const rows = sceneOpen ? flattenTree(roots, {
      children: (r) => this.#children(r),
      open: (r) => query !== '' || !this.#collapsed.has(this.#keyOf(r)),
      matches: (r) => query === '' || entityLabel(r).toLowerCase().includes(query) || (r.prefab ?? '').toLowerCase().includes(query),
      visible: (r) => r.visible || session.isEditorHidden(r.id),
    }, 1) : [];
    this.#order = rows.map((r) => r.node.id);
    const limit = this.#showAll ? rows.length : Math.min(rows.length, ROW_CAP);
    for (let i = 0; i < limit; i++) list.append(this.#row(rows[i]!, selected));
    if (limit < rows.length) {
      list.append(h('li.tree-more', {
        role: 'treeitem', text: tr('hierarchy.showAll', 'Show all {count} entities', { count: rows.length }),
        onclick: () => { this.#showAll = true; this.render(); },
      }));
    }
    if (sceneOpen && roots.length === 0) {
      list.append(h('li.tree-empty', { text: editor.editing ? tr('hierarchy.emptyScene', 'This scene places nothing yet. Add an entity with "+".') : tr('hierarchy.nothingAlive', 'Nothing alive.') }));
    }
  }

  /** A scene that isn't open: collapsed until expanded; a click opens it (edit mode). */
  #otherSceneRow(id: string, open: boolean, doc: SceneDoc | undefined): HTMLElement {
    const editor = this.#editor;
    const toggle = h(`span.tree-toggle${open ? '.open' : ''}`, {
      onclick: (event: Event) => {
        event.stopPropagation();
        if (this.#expandedScenes.has(id)) this.#expandedScenes.delete(id); else this.#expandedScenes.add(id);
        this.render();
      },
    }, icon('chevron', 12));
    const title = editor.editing
      ? tr('hierarchy.openSceneHint', 'Scene {name}: click to open it', { name: id })
      : tr('hierarchy.openSceneWhilePlaying', 'Stop the game to open another scene');
    const row = h('li.tree-row.tree-scene.inactive-scene', {
      role: 'treeitem', 'aria-expanded': open ? 'true' : 'false', 'data-scene': id,
      title: doc?.extends === undefined ? title : `${title} (${tr('hierarchy.extendsScene', 'extends {scene}', { scene: doc.extends })})`,
      onclick: (event: Event) => {
        event.stopPropagation();
        this.#openOther(id);
      },
      oncontextmenu: (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const e = event as MouseEvent;
        showMenu(otherSceneMenu({ editing: editor.editing }), e.clientX, e.clientY, (action) => { if (action === 'open-scene') this.#openOther(id); });
      },
    }, toggle, icon('globe', 13), h('span.tree-label', { text: id }),
    doc?.extends !== undefined ? h('span.tree-prefab.tree-inherited', { text: tr('hierarchy.extendsScene', 'extends {scene}', { scene: doc.extends }) }) : null);
    row.style.paddingLeft = '6px';
    return row;
  }

  /** A closed scene's placement, read from its file: a click opens the scene and selects it. */
  #previewRow(scene: string, preview: ScenePreviewRow, project: Project): HTMLElement {
    const kind = previewKind(project, preview.prefab ?? preview.label);
    const li = h(`li.tree-row.tree-preview.kind-${kind}`, {
      role: 'treeitem', title: preview.prefab === undefined ? preview.label : `${preview.label} (${preview.prefab})`,
      onclick: (event: Event) => {
        event.stopPropagation();
        this.#openOther(scene, preview.origin);
      },
    }, h('span.tree-toggle'), icon(KIND_ICON[kind], 13), h('span.tree-label', { text: preview.label }),
    preview.prefab !== undefined ? h('span.tree-prefab', { text: preview.prefab }) : null);
    li.style.paddingLeft = `${6 + 14}px`;
    return li;
  }

  /** Open another scene (edit mode; while playing, only expand it), then select the entity placed at `origin`. */
  #openOther(scene: string, origin?: Origin): void {
    const editor = this.#editor;
    if (!editor.editing) {
      this.#expandedScenes.add(scene);
      this.render();
      return;
    }
    editor.openScene(scene);
    if (editor.session.scene !== scene || origin === undefined) return;
    const session = editor.session;
    for (const record of session.runtime.kernel.world.live()) {
      const source = session.sourceOf(record.id);
      if (source?.kind === 'placement' && source.path === origin.path && source.pointer === origin.pointer) {
        editor.select([record.id]);
        return;
      }
    }
  }

  #sceneRow(open: boolean, key: string): HTMLElement {
    const editor = this.#editor;
    const session = editor.session;
    const toggle = h(`span.tree-toggle${open ? '.open' : ''}`, {
      onclick: (event: Event) => {
        event.stopPropagation();
        if (this.#collapsed.has(key)) this.#collapsed.delete(key); else this.#collapsed.add(key);
        this.render();
      },
    }, icon('chevron', 12));
    const extendsScene = session.documents.project().scenes.get(session.scene)?.extends;
    const row = h(`li.tree-row.tree-scene.active-scene${editor.sceneSelected ? '.selected' : ''}`, {
      role: 'treeitem', 'aria-expanded': open ? 'true' : 'false', 'data-scene': session.scene,
      title: `${tr('hierarchy.sceneTitle', 'Scene {name}', { name: session.scene })}${extendsScene === undefined ? '' : ` (${tr('hierarchy.extendsScene', 'extends {scene}', { scene: extendsScene })})`}`,
      onclick: (event: Event) => { event.stopPropagation(); editor.selectScene(); },
      ondblclick: () => this.#renameScene(row),
      oncontextmenu: (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const e = event as MouseEvent;
        showMenu(sceneMenu({ editing: editor.editing, start: session.scene === session.startScene, clipboard: actions.hasClipboard(), mod: modLabel() }), e.clientX, e.clientY, (action) => this.#act(action, []));
      },
    }, toggle, icon('globe', 13), h('span.tree-label', { text: session.scene }),
    extendsScene !== undefined ? h('span.tree-prefab.tree-inherited', { text: tr('hierarchy.extendsScene', 'extends {scene}', { scene: extendsScene }) }) : null);
    row.style.paddingLeft = '6px';
    this.#dropZone(row, null);
    return row;
  }

  #row(row: TreeRow<EntityRecord>, selected: ReadonlySet<EntityId>): HTMLElement {
    const editor = this.#editor;
    const session = editor.session;
    const record = row.node;
    const id = record.id;
    const key = this.#keyOf(record);
    const editable = this.#documented([id]);
    const toggle = h(`span.tree-toggle${row.open ? '.open' : ''}`, {
      onclick: (event: Event) => {
        event.stopPropagation();
        if (this.#collapsed.has(key)) this.#collapsed.delete(key); else this.#collapsed.add(key);
        this.render();
      },
    }, row.hasChildren ? icon('chevron', 12) : '');
    const kind = entityKind(record.components, record.children.length);
    const hidden = session.isEditorHidden(id);
    const label = entityLabel(record);
    // A derived scene's inherited placement: shown and edited here, written to the base file.
    const source = session.sourceOf(id);
    const scene = session.documents.project().scenes.get(session.scene);
    const base = scene === undefined || source === undefined ? undefined : inheritedFrom(scene, source);
    const eye = editable ? h(`button.tree-eye${hidden ? '.off' : ''}`, {
      type: 'button',
      title: hidden ? tr('hierarchy.showInEditor', 'Show in Editor') : tr('hierarchy.hideInEditor', 'Hide in Editor'),
      'aria-label': hidden ? tr('hierarchy.showInEditor', 'Show in Editor') : tr('hierarchy.hideInEditor', 'Hide in Editor'),
      onclick: (event: Event) => {
        event.stopPropagation();
        actions.toggleEditorHidden(editor, session.selection.includes(id) ? session.selection : [id]);
      },
      ondblclick: (event: Event) => event.stopPropagation(),
    }, icon(hidden ? 'eye-off' : 'eye', 13)) : null;
    const li = h(`li.tree-row.kind-${kind}`, {
      role: 'treeitem', 'data-entity': id, 'aria-selected': selected.has(id) ? 'true' : 'false', draggable: editable ? 'true' : undefined,
      title: `${record.prefab === undefined || record.prefab === label ? label : `${label} (${record.prefab})`}${base === undefined ? '' : `\n${inheritedNote(base)}`}`,
      onclick: (event: Event) => this.#click(id, event as MouseEvent),
      ondblclick: () => {
        if (editable) this.startRename(id);
        else actions.frame(editor, [id]);
      },
      oncontextmenu: (event: Event) => this.#contextMenu(id, event as MouseEvent),
    }, toggle, icon(KIND_ICON[kind], 13), h('span.tree-label', { text: label }),
    record.prefab !== undefined && record.prefab !== label ? h('span.tree-prefab', { text: record.prefab }) : null,
    base !== undefined ? h('span.tree-prefab.tree-inherited', { text: tr('hierarchy.fromScene', 'from {scene}', { scene: base }) }) : null, eye);
    li.style.paddingLeft = `${6 + row.depth * 14}px`;
    if (selected.has(id)) li.classList.add('selected');
    if (row.dimmed) li.classList.add('hidden-entity');
    if (hidden) li.classList.add('editor-hidden');
    if (editable) this.#dragSource(li, id);
    this.#dropZone(li, record);
    this.#rows.set(id, li);
    return li;
  }

  #click(id: EntityId, event: MouseEvent): void {
    const toggle = event.ctrlKey || event.metaKey;
    const next = clickSelection(this.#editor.session.selection, id, { shift: event.shiftKey, toggle }, this.#order, this.#anchor);
    if (!event.shiftKey) this.#anchor = id;
    this.#editor.select(next);
  }

  // ── Empty space ─────────────────────────────────────────────────────────────

  #listenOnEmptySpace(): void {
    const onEmpty = (event: Event): boolean => !(event.target as Element).closest?.('.tree-row, .tree-more');
    this.#body.addEventListener('click', (event) => {
      if (onEmpty(event)) this.#editor.select([]);
    });
    this.#body.addEventListener('contextmenu', (event) => {
      if (!onEmpty(event)) return;
      event.preventDefault();
      const editor = this.#editor;
      showMenu(addMenu(editor.session.dimension, { editing: editor.editing, paste: true, clipboard: actions.hasClipboard(), mod: modLabel() }),
        event.clientX, event.clientY, (action) => this.#act(action, []));
    });
    // Dropped below the last row: the end of the scene's root.
    this.#body.addEventListener('dragover', (event) => {
      if (this.#dragging.length === 0 || !onEmpty(event)) return;
      event.preventDefault();
      this.#body.classList.add('drop-root');
    });
    this.#body.addEventListener('dragleave', () => this.#body.classList.remove('drop-root'));
    this.#body.addEventListener('drop', (event) => {
      if (this.#dragging.length === 0 || !onEmpty(event)) return;
      event.preventDefault();
      const ids = this.#dragging;
      this.#endDrag();
      actions.move(this.#editor, ids, null, null);
    });
  }

  // ── Context menus ───────────────────────────────────────────────────────────

  #contextMenu(id: EntityId, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const editor = this.#editor;
    const session = editor.session;
    const inSelection = session.selection.includes(id);
    if (!inSelection) {
      editor.select([id]);
      this.#anchor = id;
    }
    const ids = inSelection ? session.selection : [id];
    const source = ids.length === 1 ? session.sourceOf(ids[0]!) : undefined;
    const first = session.sourceOf(ids[0]!);
    const visibleInGame = first === undefined ? true : session.documents.get(first.path, `${first.pointer}/visible`) !== false;
    showMenu(entityMenu({
      count: ids.length,
      editing: editor.editing,
      documented: this.#documented(ids),
      canHaveChildren: source?.prefab !== undefined,
      prefabChild: source?.kind === 'child',
      clipboard: actions.hasClipboard(),
      visibleInGame,
      editorHidden: session.isEditorHidden(ids[0]!),
      mod: modLabel(),
    }), event.clientX, event.clientY, (action) => this.#act(action, ids));
  }

  #act(action: MenuAction, ids: readonly EntityId[]): void {
    const editor = this.#editor;
    const [first] = ids;
    if (action.startsWith('add:')) {
      actions.addPrimitive(editor, action.slice('add:'.length) as PrimitiveKind);
      return;
    }
    switch (action) {
      case 'rename': if (first !== undefined) this.startRename(first); break;
      case 'duplicate': actions.duplicate(editor, ids); break;
      case 'copy': actions.copy(editor, ids); break;
      case 'paste': actions.paste(editor, null); break;
      case 'paste-child': if (first !== undefined) actions.paste(editor, first); break;
      case 'create-child': if (first !== undefined) actions.createChild(editor, first); break;
      case 'focus': actions.frame(editor, ids); break;
      case 'hide-game': actions.setVisibleInGame(editor, ids, false); break;
      case 'show-game': actions.setVisibleInGame(editor, ids, true); break;
      case 'hide-editor': editor.session.setEditorHidden(ids, true); editor.emit('world'); break;
      case 'show-editor': editor.session.setEditorHidden(ids, false); editor.emit('world'); break;
      case 'delete': actions.remove(editor, ids); break;
      case 'add-prefab': this.#onAdd?.(); break;
      case 'new-scene': void this.#newScene(); break;
      case 'rename-scene': {
        const row = this.#body.querySelector<HTMLElement>('.tree-scene.active-scene');
        if (row !== null) this.#renameScene(row);
        break;
      }
      case 'delete-scene': this.#deleteScene(); break;
      default: break;
    }
  }

  // ── Renaming ────────────────────────────────────────────────────────────────

  /** Rename an entity in place: Enter or leaving the field keeps it, Esc cancels. */
  startRename(id: EntityId): void {
    const editor = this.#editor;
    const session = editor.session;
    const source = session.sourceOf(id);
    let li = this.#rows.get(id);
    if (li === undefined && source !== undefined && !this.#showAll) {
      // Past the row cap: show every row, then rename.
      this.#showAll = true;
      this.render();
      li = this.#rows.get(id);
    }
    if (!editor.editing || source === undefined || li === undefined) return;
    const record = session.runtime.kernel.world.get(id);
    const current = source.kind === 'placement' ? source.placedId ?? '' : source.name ?? '';
    this.#inlineEdit(li, current, record === undefined ? '' : entityLabel(record), (value) => {
      if (value !== current) editor.renameEntity(id, value);
    });
  }

  #renameScene(row: HTMLElement): void {
    const editor = this.#editor;
    const session = editor.session;
    if (!editor.editing) return;
    if (session.scene === session.startScene) {
      editor.write('warning', tr('hierarchy.startSceneLocked', 'The game starts here (set in code)'));
      return;
    }
    const from = session.scene;
    this.#inlineEdit(row, from, from, (value) => {
      const to = toId(value);
      if (to !== '' && to !== from) actions.renameScene(editor, from, to);
    });
  }

  #inlineEdit(row: HTMLElement, value: string, placeholder: string, commit: (value: string) => void): void {
    const label = row.querySelector('.tree-label');
    if (label === null || this.#renaming) return;
    closeMenu();
    const input = h('input.tree-rename', { type: 'text', value, placeholder, spellcheck: 'false', 'aria-label': t('hierarchy.rename') });
    this.#renaming = true;
    row.draggable = false;
    label.replaceWith(input);
    let done = false;
    const finish = (keep: boolean): void => {
      if (done) return;
      done = true;
      this.#renaming = false;
      this.#renderPending = false;
      const text = input.value.trim();
      if (keep) commit(text);
      this.render();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    for (const type of ['click', 'dblclick', 'pointerdown']) input.addEventListener(type, (event) => event.stopPropagation());
    input.focus();
    input.select();
  }

  // ── Scenes ──────────────────────────────────────────────────────────────────

  async #newScene(): Promise<void> {
    const editor = this.#editor;
    if (!editor.editing) return;
    const scenes = new Set(editor.session.scenes);
    let n = scenes.size + 1;
    while (scenes.has(`scene_${n}`)) n++;
    const name = await promptName(t('hierarchy.newScene'), `scene_${n}`, {
      hint: tr('hierarchy.sceneIdHint', 'Lowercase letters, digits and _ (code names it Scenes.<name>).'),
      confirm: tr('hierarchy.create', 'Create'),
    });
    if (name === null) return;
    const id = toId(name);
    if (id !== '') actions.createScene(editor, id);
  }

  #deleteScene(): void {
    const editor = this.#editor;
    const scene = editor.session.scene;
    const ok = globalThis.confirm?.(tr('hierarchy.deleteSceneConfirm', 'Delete scene "{name}" and its files? Undo brings it back until you leave the editor.', { name: scene })) ?? false;
    if (ok) actions.deleteScene(editor, scene);
  }

  // ── Drag and drop ───────────────────────────────────────────────────────────

  #dragSource(li: HTMLElement, id: EntityId): void {
    li.addEventListener('dragstart', (event) => {
      const session = this.#editor.session;
      if (!this.#editor.editing || this.#renaming) {
        event.preventDefault();
        return;
      }
      const ids = session.selection.includes(id) ? session.selection : [id];
      if (!session.selection.includes(id)) this.#editor.select([id]);
      this.#dragging = ids;
      event.dataTransfer?.setData(DRAG_TYPE, ids.join(','));
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
      closeMenu();
    });
    li.addEventListener('dragend', () => this.#endDrag());
  }

  /** A row (or the scene row, `record` null) as a drop target. */
  #dropZone(li: HTMLElement, record: EntityRecord | null): void {
    const position = (event: DragEvent): DropPosition | null => {
      if (this.#dragging.length === 0) return null;
      if (record === null) return 'inside';
      if (this.#within(record.id)) return null;
      const box = li.getBoundingClientRect();
      const canNest = this.#editor.session.sourceOf(record.id)?.prefab !== undefined;
      return dropPosition(event.clientY - box.top, box.height, canNest);
    };
    li.addEventListener('dragover', (event) => {
      const at = position(event);
      if (at === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
      li.classList.remove(...DROP_CLASSES);
      li.classList.add(`drop-${at}`);
    });
    li.addEventListener('dragleave', () => li.classList.remove(...DROP_CLASSES));
    li.addEventListener('drop', (event) => {
      const at = position(event);
      li.classList.remove(...DROP_CLASSES);
      if (at === null) return;
      event.preventDefault();
      event.stopPropagation();
      const ids = this.#dragging;
      this.#endDrag();
      if (record === null) {
        actions.move(this.#editor, ids, null, null);
        return;
      }
      const world = this.#editor.session.runtime.kernel.world;
      const parent = record.parent;
      const siblings = parent === null ? this.#roots().map((r) => r.id) : world.get(parent)?.children ?? [];
      const target = dropTarget(at, record.id, parent, siblings.filter((s) => !ids.includes(s)));
      actions.move(this.#editor, ids, target.parent, target.before);
    });
  }

  /** Whether `id` is a dragged entity or inside one (no drop there). */
  #within(id: EntityId): boolean {
    const world = this.#editor.session.runtime.kernel.world;
    for (let at: EntityId | null | undefined = id; at !== null && at !== undefined; at = world.get(at)?.parent) {
      if (this.#dragging.includes(at)) return true;
    }
    return false;
  }

  #endDrag(): void {
    this.#dragging = [];
    this.#body.classList.remove('drop-root');
    for (const li of this.#body.querySelectorAll('.drop-above, .drop-below, .drop-inside')) li.classList.remove(...DROP_CLASSES);
  }
}
