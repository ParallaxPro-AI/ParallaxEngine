/**
 * The hierarchy's decisions without a page: an entity's kind (its row icon), click / Shift /
 * Ctrl selection, where a drop lands, the visible rows (filtered, collapsed, capped for huge
 * scenes) and what each context menu offers.
 */

import type { PrimitiveKind } from './session/index.js';
import type { Origin } from '@parallax/runtime/resource';
import type { IconName } from './dom.js';
import { t } from './i18n.js';

/** A translated string, or `english` while the key has no translation yet. */
export function tr(key: string, english: string, params: Readonly<Record<string, string | number>> = {}): string {
  const text = t(key, params);
  if (text !== key) return text;
  return english.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] !== undefined ? String(params[name]) : match));
}

// ── Kinds ────────────────────────────────────────────────────────────────────

export type EntityKind = 'camera' | 'sun' | 'light' | 'model' | 'shape' | 'sprite' | 'text' | 'audio' | 'particles' | 'prefab' | 'empty';

export const KIND_ICON: Readonly<Record<EntityKind, IconName>> = {
  camera: 'camera', sun: 'sun', light: 'lightbulb', model: 'package', shape: 'box', sprite: 'image', text: 'type',
  audio: 'music', particles: 'sparkles', prefab: 'layers', empty: 'dashed',
};

interface ComponentsLike {
  has(id: string): boolean;
  get(id: string): Readonly<Record<string, unknown>> | undefined;
}

/** What a row shows an entity as, by its components (the most telling first); an entity of only children is a prefab group. */
export function entityKind(components: ComponentsLike, childCount: number): EntityKind {
  if (components.has('camera')) return 'camera';
  if (components.has('light')) return components.get('light')?.['kind'] === 'directional' ? 'sun' : 'light';
  if (components.has('model')) return 'model';
  if (components.has('shape')) return 'shape';
  if (components.has('sprite')) return 'sprite';
  if (components.has('text')) return 'text';
  if (components.has('particles')) return 'particles';
  if (components.has('audio_source') || components.has('sound')) return 'audio';
  return childCount > 0 ? 'prefab' : 'empty';
}

// ── Selection ────────────────────────────────────────────────────────────────

/** Everything between `anchor` and `target` in display order (both included); just `target` without an anchor in view. */
export function rangeBetween<T>(order: readonly T[], anchor: T | undefined, target: T): T[] {
  const a = anchor === undefined ? -1 : order.indexOf(anchor);
  const b = order.indexOf(target);
  if (a < 0 || b < 0) return [target];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The selection after clicking a row: plain replaces, Ctrl / Cmd toggles one, Shift selects the range from the anchor. */
export function clickSelection<T>(current: readonly T[], target: T, modifiers: { readonly shift?: boolean; readonly toggle?: boolean }, order: readonly T[], anchor: T | undefined): T[] {
  if (modifiers.shift === true) {
    const range = rangeBetween(order, anchor, target);
    return modifiers.toggle === true ? [...new Set([...current, ...range])] : range;
  }
  if (modifiers.toggle === true) return current.includes(target) ? current.filter((c) => c !== target) : [...current, target];
  return [target];
}

// ── Drag and drop ────────────────────────────────────────────────────────────

export type DropPosition = 'above' | 'below' | 'inside';

/** Where a drop at `y` px into a row `height` px tall lands: the top and bottom quarters go between rows, the middle inside. */
export function dropPosition(y: number, height: number, canNest: boolean): DropPosition {
  const f = height <= 0 ? 0.5 : y / height;
  if (!canNest) return f < 0.5 ? 'above' : 'below';
  if (f < 0.25) return 'above';
  if (f > 0.75) return 'below';
  return 'inside';
}

/** A drop as a move: the new parent and the sibling it goes before (null: last). */
export function dropTarget<T>(position: DropPosition, target: T, parent: T | null, siblings: readonly T[]): { readonly parent: T | null; readonly before: T | null } {
  if (position === 'inside') return { parent: target, before: null };
  if (position === 'above') return { parent, before: target };
  const at = siblings.indexOf(target);
  return { parent, before: at < 0 ? null : siblings[at + 1] ?? null };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** Rows built for a scene before "Show all" (a huge procedural scene would stall the tree). */
export const ROW_CAP = 500;

export interface TreeRow<T> {
  readonly node: T;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly open: boolean;
  /** It, or an ancestor, is hidden in the game. */
  readonly dimmed: boolean;
}

export interface TreeSource<T> {
  children(node: T): readonly T[];
  /** Expanded (a search expands everything it matches). */
  open(node: T): boolean;
  /** Matches the search, itself (descendants are checked here). */
  matches(node: T): boolean;
  visible(node: T): boolean;
}

/** The rows to show, depth first: what matches the search (with its ancestors), under expanded parents. */
export function flattenTree<T>(roots: readonly T[], tree: TreeSource<T>, depth = 0): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const memo = new Map<T, boolean>();
  const shows = (node: T): boolean => {
    let hit = memo.get(node);
    if (hit === undefined) {
      hit = tree.matches(node) || tree.children(node).some(shows);
      memo.set(node, hit);
    }
    return hit;
  };
  const visit = (node: T, at: number, dimmed: boolean): void => {
    if (!shows(node)) return;
    const children = tree.children(node);
    const open = children.length > 0 && tree.open(node);
    const dim = dimmed || !tree.visible(node);
    rows.push({ node, depth: at, hasChildren: children.length > 0, open, dimmed: dim });
    if (open) for (const child of children) visit(child, at + 1, dim);
  };
  for (const root of roots) visit(root, depth, false);
  return rows;
}

// ── Scenes ───────────────────────────────────────────────────────────────────

/** A scene row: every scene of the project is listed; the open one shows the live world under it. */
export interface SceneEntry {
  readonly id: string;
  /** The scene open in the editor (its rows are the world's entities). */
  readonly active: boolean;
  readonly open: boolean;
}

/**
 * The project's scenes as rows, in `scenes` order. The open scene is expanded unless it was
 * collapsed (`collapsed`); every other scene starts collapsed until it is expanded
 * (`expanded`). A search expands them all (rows that don't match are filtered out).
 */
export function sceneEntries(scenes: readonly string[], active: string, state: { readonly collapsed: ReadonlySet<string>; readonly expanded: ReadonlySet<string>; readonly searching: boolean }): SceneEntry[] {
  const ids = scenes.includes(active) ? scenes : [active, ...scenes];
  return ids.map((id) => {
    const isActive = id === active;
    const open = state.searching || (isActive ? !state.collapsed.has(id) : state.expanded.has(id));
    return { id, active: isActive, open };
  });
}

/** A placement of a scene that isn't open, read from its document (no live entity behind it). */
export interface ScenePreviewRow {
  readonly label: string;
  /** Its prefab, when the label is something else (a placed id). */
  readonly prefab?: string;
  /** Where it is written: after opening the scene, the entity with this source is selected. */
  readonly origin: Origin;
}

/** A closed scene's placements as rows (label as the hierarchy names entities: placed id, else prefab), filtered by a lower-case query. */
export function scenePreviewRows(entities: readonly { readonly id?: string; readonly prefab: string; readonly origin: Origin }[], query: string): ScenePreviewRow[] {
  const rows: ScenePreviewRow[] = [];
  for (const placement of entities) {
    const label = placement.id ?? placement.prefab;
    if (query !== '' && !label.toLowerCase().includes(query) && !placement.prefab.toLowerCase().includes(query)) continue;
    rows.push({ label, ...(label !== placement.prefab && { prefab: placement.prefab }), origin: placement.origin });
  }
  return rows;
}

/** A closed scene's row menu: open it (only while editing; the running game stays in its scene). */
export function otherSceneMenu(options: { readonly editing: boolean }): MenuEntry[] {
  return [{
    action: 'open-scene', label: tr('hierarchy.openScene', 'Open Scene'), disabled: !options.editing,
    ...(!options.editing && { title: tr('hierarchy.openSceneWhilePlaying', 'Stop the game to open another scene') }),
  }];
}

// ── Inherited entities ───────────────────────────────────────────────────────

/** The tooltip line on a derived scene's inherited row: edits land in the base scene's file. */
export function inheritedNote(base: string): string {
  return tr('hierarchy.inheritedNote', 'From scene "{scene}": edits change {scene} (and every scene extending it); delete excludes it here.', { scene: base });
}

// ── Menus ────────────────────────────────────────────────────────────────────

export type MenuAction =
  | 'rename' | 'duplicate' | 'copy' | 'paste' | 'paste-child' | 'create-child' | 'focus'
  | 'hide-game' | 'show-game' | 'hide-editor' | 'show-editor' | 'delete'
  | `add:${PrimitiveKind}` | 'add-prefab' | 'new-scene' | 'rename-scene' | 'delete-scene' | 'open-scene';

export interface MenuItem {
  readonly action: MenuAction;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** Why it is disabled, or more about it (a tooltip). */
  readonly title?: string;
}

export type MenuEntry = MenuItem | 'separator' | { readonly heading: string };

export interface EntityMenuInfo {
  /** How many entities the menu is for (the selection when the row is in it). */
  readonly count: number;
  readonly editing: boolean;
  /** Every one comes from the documents (not spawned while playing). */
  readonly documented: boolean;
  /** One entity whose prefab can hold children (not an inline child). */
  readonly canHaveChildren: boolean;
  /** One entity that is a prefab's child (deleting it edits the prefab). */
  readonly prefabChild: boolean;
  readonly clipboard: boolean;
  readonly visibleInGame: boolean;
  readonly editorHidden: boolean;
  readonly mod: string;
}

/** An entity row's menu (one entity, or the selection it belongs to). */
export function entityMenu(info: EntityMenuInfo): MenuEntry[] {
  const edit = info.editing && info.documented;
  const n = info.count;
  const focus: MenuItem = { action: 'focus', label: tr('hierarchy.focus', 'Focus'), shortcut: 'F' };
  if (!edit) return [focus];
  const m = info.mod;
  if (n > 1) {
    return [
      { action: 'duplicate', label: tr('hierarchy.duplicateN', 'Duplicate {count}', { count: n }), shortcut: `${m}D` },
      { action: 'copy', label: tr('hierarchy.copyN', 'Copy {count}', { count: n }), shortcut: `${m}C` },
      focus,
      'separator',
      info.editorHidden
        ? { action: 'show-editor', label: tr('hierarchy.showInEditor', 'Show in Editor') }
        : { action: 'hide-editor', label: tr('hierarchy.hideInEditor', 'Hide in Editor') },
      info.visibleInGame
        ? { action: 'hide-game', label: tr('hierarchy.hideInGame', 'Hide in Game') }
        : { action: 'show-game', label: tr('hierarchy.showInGame', 'Show in Game') },
      'separator',
      { action: 'delete', label: tr('hierarchy.deleteN', 'Delete {count}', { count: n }), shortcut: 'Del', danger: true },
    ];
  }
  return [
    { action: 'rename', label: t('hierarchy.rename'), shortcut: 'F2' },
    { action: 'duplicate', label: tr('hierarchy.duplicate', 'Duplicate'), shortcut: `${m}D` },
    { action: 'copy', label: tr('hierarchy.copy', 'Copy'), shortcut: `${m}C` },
    { action: 'paste', label: tr('hierarchy.paste', 'Paste'), shortcut: `${m}V`, disabled: !info.clipboard },
    { action: 'paste-child', label: tr('hierarchy.pasteAsChild', 'Paste as Child'), disabled: !info.clipboard || !info.canHaveChildren },
    'separator',
    { action: 'create-child', label: t('hierarchy.createChild'), disabled: !info.canHaveChildren },
    focus,
    'separator',
    info.editorHidden
      ? { action: 'show-editor', label: tr('hierarchy.showInEditor', 'Show in Editor') }
      : { action: 'hide-editor', label: tr('hierarchy.hideInEditor', 'Hide in Editor') },
    info.visibleInGame
      ? { action: 'hide-game', label: tr('hierarchy.hideInGame', 'Hide in Game') }
      : { action: 'show-game', label: tr('hierarchy.showInGame', 'Show in Game') },
    'separator',
    { action: 'delete', label: info.prefabChild ? tr('hierarchy.deleteFromPrefab', 'Delete from Prefab') : tr('hierarchy.delete', 'Delete'), shortcut: 'Del', danger: true },
  ];
}

/** The "+" menu (also the menu on empty space): primitives, lights, a camera, prefabs, a new scene. */
export function addMenu(dimension: '2d' | '3d', options: { readonly editing: boolean; readonly clipboard?: boolean; readonly paste?: boolean; readonly mod?: string }): MenuEntry[] {
  const off = !options.editing;
  const item = (action: MenuAction, key: string, english: string): MenuItem => ({ action, label: tr(key, english), disabled: off });
  const flat = dimension === '2d';
  return [
    ...(options.paste === true ? [{ action: 'paste', label: tr('hierarchy.paste', 'Paste'), shortcut: `${options.mod ?? 'Ctrl+'}V`, disabled: off || options.clipboard !== true } as MenuItem, 'separator' as const] : []),
    item('add:empty', 'hierarchy.emptyEntity', 'Empty Entity'),
    item('add:cube', flat ? 'hierarchy.square' : 'hierarchy.cube', flat ? 'Square' : 'Cube'),
    item('add:sphere', flat ? 'hierarchy.circle' : 'hierarchy.sphere', flat ? 'Circle' : 'Sphere'),
    ...(flat ? [] : [item('add:plane', 'hierarchy.plane', 'Plane')]),
    'separator',
    item('add:directional_light', 'hierarchy.directionalLight', 'Directional Light'),
    item('add:point_light', 'hierarchy.pointLight', 'Point Light'),
    item('add:spot_light', 'hierarchy.spotLight', 'Spot Light'),
    item('add:camera', 'hierarchy.camera', 'Camera'),
    'separator',
    { action: 'add-prefab', label: tr('hierarchy.prefab', 'Prefab…') },
    'separator',
    item('new-scene', 'hierarchy.newSceneEllipsis', `${t('hierarchy.newScene')}…`),
  ];
}

/** The scene row's menu. The start scene is set in code: it can't be renamed or deleted here. */
export function sceneMenu(options: { readonly editing: boolean; readonly start: boolean; readonly clipboard: boolean; readonly mod: string }): MenuEntry[] {
  const off = !options.editing;
  const why = tr('hierarchy.startSceneLocked', 'The game starts here (set in code)');
  return [
    { action: 'paste', label: tr('hierarchy.paste', 'Paste'), shortcut: `${options.mod}V`, disabled: off || !options.clipboard },
    'separator',
    { action: 'new-scene', label: `${t('hierarchy.newScene')}…`, disabled: off },
    { action: 'rename-scene', label: tr('hierarchy.renameScene', 'Rename Scene'), disabled: off || options.start, ...(options.start && { title: why }) },
    { action: 'delete-scene', label: t('hierarchy.deleteScene'), disabled: off || options.start, danger: true, ...(options.start && { title: why }) },
  ];
}

// ── Default names ────────────────────────────────────────────────────────────

const PRIMITIVE_LABELS: Readonly<Record<string, string>> = {
  empty: 'hierarchy.emptyEntity', cube: 'hierarchy.cube', sphere: 'hierarchy.sphere', plane: 'hierarchy.plane',
  square: 'hierarchy.square', circle: 'hierarchy.circle', directional_light: 'hierarchy.directionalLight',
  point_light: 'hierarchy.pointLight', spot_light: 'hierarchy.spotLight', camera: 'hierarchy.camera',
};

/**
 * What an entity the editor added (a primitive: `cube`, `cube_2`, `point_light`, ...) is called
 * in the editor's language while it has no name of its own ("Cube", "立方体 2"); undefined for
 * any other prefab. Ids stay code names, so the name is localized where it is shown.
 */
export function primitiveLabel(prefab: string): string | undefined {
  const m = /^([a-z_]+?)(?:_(\d+))?$/.exec(prefab);
  const key = m === null ? undefined : PRIMITIVE_LABELS[m[1]!];
  if (key === undefined) return undefined;
  const text = t(key);
  return m![2] === undefined ? text : `${text} ${m![2]}`;
}
