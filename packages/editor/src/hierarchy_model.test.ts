import { describe, expect, it } from 'vitest';
import {
  addMenu, clickSelection, dropPosition, dropTarget, entityKind, entityMenu, flattenTree, otherSceneMenu, rangeBetween, sceneEntries, sceneMenu,
  scenePreviewRows, tr,
} from './hierarchy_model.js';
import type { EntityMenuInfo, MenuEntry } from './hierarchy_model.js';
import { shortcutFor } from './shortcuts.js';

const components = (entries: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> => new Map(Object.entries(entries));
const actionsOf = (entries: readonly MenuEntry[]): string[] => entries.flatMap((e) => (typeof e === 'object' && 'action' in e ? [e.action] : []));

describe('row kinds', () => {
  it('shows the most telling component, a group of children as a prefab, else empty', () => {
    expect(entityKind(components({ camera: {}, shape: {} }), 0)).toBe('camera');
    expect(entityKind(components({ light: { kind: 'directional' } }), 0)).toBe('sun');
    expect(entityKind(components({ light: { kind: 'point' } }), 0)).toBe('light');
    expect(entityKind(components({ model: {}, shape: {} }), 0)).toBe('model');
    expect(entityKind(components({ shape: { kind: 'box' } }), 2)).toBe('shape');
    expect(entityKind(components({ outline: {} }), 3)).toBe('prefab');
    expect(entityKind(components({}), 0)).toBe('empty');
  });
});

describe('selection clicks', () => {
  const order = [1, 2, 3, 4, 5];
  it('plain replaces, Ctrl / Cmd toggles one, Shift takes the range from the anchor', () => {
    expect(clickSelection([1, 2], 4, {}, order, 1)).toEqual([4]);
    expect(clickSelection([1, 2], 4, { toggle: true }, order, 1)).toEqual([1, 2, 4]);
    expect(clickSelection([1, 2, 4], 2, { toggle: true }, order, 1)).toEqual([1, 4]);
    expect(clickSelection([2], 5, { shift: true }, order, 2)).toEqual([2, 3, 4, 5]);
    expect(clickSelection([4], 2, { shift: true }, order, 4)).toEqual([2, 3, 4]);
    expect(clickSelection([5], 2, { shift: true, toggle: true }, order, 3)).toEqual([5, 2, 3]);
  });

  it('a range without an anchor in view is just the row', () => {
    expect(rangeBetween([1, 2, 3], undefined, 2)).toEqual([2]);
    expect(rangeBetween([1, 2, 3], 9, 2)).toEqual([2]);
  });
});

describe('drag and drop', () => {
  it('top and bottom quarters drop between rows, the middle inside (when the row can hold children)', () => {
    expect(dropPosition(2, 24, true)).toBe('above');
    expect(dropPosition(12, 24, true)).toBe('inside');
    expect(dropPosition(22, 24, true)).toBe('below');
    expect(dropPosition(10, 24, false)).toBe('above');
    expect(dropPosition(14, 24, false)).toBe('below');
  });

  it('turns a drop into a parent and the sibling it goes before', () => {
    const siblings = [10, 11, 12];
    expect(dropTarget('above', 11, 7, siblings)).toEqual({ parent: 7, before: 11 });
    expect(dropTarget('below', 11, 7, siblings)).toEqual({ parent: 7, before: 12 });
    expect(dropTarget('below', 12, null, siblings)).toEqual({ parent: null, before: null });
    expect(dropTarget('inside', 11, 7, siblings)).toEqual({ parent: 11, before: null });
  });
});

describe('rows', () => {
  interface Node { readonly name: string; readonly children: readonly Node[]; readonly visible?: boolean }
  const n = (name: string, children: Node[] = [], visible = true): Node => ({ name, children, visible });
  const roots = [n('camera'), n('tower', [n('top'), n('door', [n('knob')])], false), n('crate')];
  const tree = (query = '', closed: readonly string[] = []) => ({
    children: (node: Node) => node.children,
    open: (node: Node) => query !== '' || !closed.includes(node.name),
    matches: (node: Node) => query === '' || node.name.includes(query),
    visible: (node: Node) => node.visible !== false,
  });

  it('flattens depth first under open parents, dimming what an invisible parent holds', () => {
    const rows = flattenTree(roots, tree(), 1);
    expect(rows.map((r) => `${r.depth}:${r.node.name}${r.dimmed ? '~' : ''}`)).toEqual(['1:camera', '1:tower~', '2:top~', '2:door~', '3:knob~', '1:crate']);
    expect(flattenTree(roots, tree('', ['tower'])).map((r) => r.node.name)).toEqual(['camera', 'tower', 'crate']);
  });

  it('a search keeps matches and the parents that lead to them', () => {
    expect(flattenTree(roots, tree('kno')).map((r) => r.node.name)).toEqual(['tower', 'door', 'knob']);
  });
});

describe('menus', () => {
  const info = (over: Partial<EntityMenuInfo> = {}): EntityMenuInfo => ({
    count: 1, editing: true, documented: true, canHaveChildren: true, prefabChild: false, clipboard: false,
    visibleInGame: true, editorHidden: false, mod: 'Ctrl+', ...over,
  });

  it('one entity: the full menu; paste needs a clipboard, children need a prefab', () => {
    const menu = entityMenu(info());
    expect(actionsOf(menu)).toEqual(['rename', 'duplicate', 'copy', 'paste', 'paste-child', 'create-child', 'focus', 'hide-editor', 'hide-game', 'delete']);
    const paste = menu.find((e) => typeof e === 'object' && 'action' in e && e.action === 'paste') as { disabled?: boolean };
    expect(paste.disabled).toBe(true);
    const inline = entityMenu(info({ canHaveChildren: false, prefabChild: true, clipboard: true }));
    const child = inline.find((e) => typeof e === 'object' && 'action' in e && e.action === 'create-child') as { disabled?: boolean };
    expect(child.disabled).toBe(true);
    const del = inline.at(-1) as { label: string; danger?: boolean };
    expect(del.label).toBe('Delete from Prefab');
    expect(del.danger).toBe(true);
  });

  it('a selection gets counted actions; while playing only Focus', () => {
    expect(actionsOf(entityMenu(info({ count: 3, editorHidden: true, visibleInGame: false })))).toEqual(['duplicate', 'copy', 'focus', 'show-editor', 'show-game', 'delete']);
    expect(actionsOf(entityMenu(info({ editing: false })))).toEqual(['focus']);
  });

  it('the add menu follows the dimension; the scene menu locks the start scene', () => {
    expect(actionsOf(addMenu('3d', { editing: true }))).toEqual([
      'add:empty', 'add:cube', 'add:sphere', 'add:plane', 'add:directional_light', 'add:point_light', 'add:spot_light', 'add:camera', 'add-prefab', 'new-scene',
    ]);
    expect(actionsOf(addMenu('2d', { editing: true, paste: true }))).not.toContain('add:plane');
    expect(actionsOf(addMenu('2d', { editing: true, paste: true }))[0]).toBe('paste');
    const locked = sceneMenu({ editing: true, start: true, clipboard: false, mod: '⌘' });
    expect(locked.filter((e) => typeof e === 'object' && 'disabled' in e && e.disabled === true).map((e) => (e as { action: string }).action))
      .toEqual(['paste', 'rename-scene', 'delete-scene']);
  });

  it('falls back to English for strings without a translation', () => {
    expect(tr('hierarchy.noSuchKey', 'Show all {count} entities', { count: 3 })).toBe('Show all 3 entities');
  });
});

describe('shortcuts', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  it('F2 renames, Ctrl / Cmd + C / V copy and paste, F still frames; none while typing', () => {
    expect(shortcutFor(key('F2'), 'edit')).toBe('rename');
    expect(shortcutFor(key('c', { metaKey: true }), 'edit')).toBe('copy');
    expect(shortcutFor(key('v', { ctrlKey: true }), 'edit')).toBe('paste');
    expect(shortcutFor(key('f'), 'edit')).toBe('frame');
    expect(shortcutFor(key('c', { ctrlKey: true }), 'edit', { typing: true })).toBeNull();
    expect(shortcutFor(key('F2'), 'playing')).toBeNull();
  });
});

describe('every scene in the hierarchy', () => {
  const none = new Set<string>();
  it('expands the open scene and starts the others collapsed', () => {
    expect(sceneEntries(['level_1', 'level_2', 'menu'], 'level_2', { collapsed: none, expanded: none, searching: false })).toEqual([
      { id: 'level_1', active: false, open: false },
      { id: 'level_2', active: true, open: true },
      { id: 'menu', active: false, open: false },
    ]);
  });

  it('remembers a collapsed open scene and expanded closed ones; a search expands everything', () => {
    const state = { collapsed: new Set(['level_2']), expanded: new Set(['menu']), searching: false };
    expect(sceneEntries(['level_1', 'level_2', 'menu'], 'level_2', state).map((e) => e.open)).toEqual([false, false, true]);
    expect(sceneEntries(['level_1', 'level_2', 'menu'], 'level_2', { ...state, searching: true }).every((e) => e.open)).toBe(true);
  });

  it('lists the open scene even when the project no longer has it', () => {
    expect(sceneEntries(['a'], 'gone', { collapsed: none, expanded: none, searching: false }).map((e) => e.id)).toEqual(['gone', 'a']);
  });

  it('reads a closed scene\'s placements as rows (placed id, else prefab), filtered by the search', () => {
    const origin = (i: number) => ({ path: 'scenes/menu/scene.json', pointer: `/entities/${i}` });
    const entities = [{ prefab: 'crate', origin: origin(0) }, { id: 'hero', prefab: 'player', origin: origin(1) }];
    expect(scenePreviewRows(entities, '')).toEqual([
      { label: 'crate', origin: origin(0) },
      { label: 'hero', prefab: 'player', origin: origin(1) },
    ]);
    expect(scenePreviewRows(entities, 'play').map((r) => r.label)).toEqual(['hero']);
    expect(scenePreviewRows(entities, 'zzz')).toEqual([]);
  });

  it('offers Open Scene on a closed scene, disabled while playing', () => {
    const editing = otherSceneMenu({ editing: true })[0] as { action: string; disabled: boolean };
    expect(editing.action).toBe('open-scene');
    expect(editing.disabled).toBe(false);
    const playing = otherSceneMenu({ editing: false })[0] as { disabled: boolean; title?: string };
    expect(playing.disabled).toBe(true);
    expect(playing.title).toBeTruthy();
  });
});
