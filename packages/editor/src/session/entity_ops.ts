/**
 * Hierarchy edits as document patches: show / hide in the game, add a primitive,
 * create a child, duplicate, delete, move (reorder and reparent), copy / paste, and scenes.
 * The session commits the patches (one undo step each) and keeps its selection with `remap`.
 *
 * The documents decide what a hierarchy edit means:
 *
 *   root      a placement in the scene file's "entities" (the order is the file's)
 *   child     an entry in a prefab's "children": it is part of the prefab, so adding,
 *             moving or removing one changes every instance of that prefab
 *   inline    a child without a prefab of its own can't have children (PP1003) and can't
 *             be placed in the scene on its own (a placement needs a prefab)
 *
 * A derived scene (`"extends": "<base>"`) shows its base's placements too. Those are
 * the base's: editing one edits the base file. Deleting one from the derived scene adds
 * its id to the derived file's "exclude" (the base keeps it); duplicating one copies it
 * into the derived file; moving one is refused (open the base scene to reorder it).
 *
 * Moving an entity to another parent keeps where it is in the world: its transform is
 * rewritten relative to the new parent. Primitives (Cube, Point Light, ...) are placements
 * of small prefabs (`prefabs/cube.prefab.json`, ...) made the first time one is added.
 */

import { fail, Vec3 } from '@parallax/runtime/core';
import type { EntityId } from '@parallax/runtime/core';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { Json, JsonObject, PrefabDoc, Project, SceneDoc } from '@parallax/runtime/resource';
import { asObject, pointerOf } from './documents.js';
import type { FilePatch, JsonOp, ProjectDocuments } from './documents.js';
import type { EntitySource } from './sources.js';
import { tidy } from './write_back.js';
import type { LocalTransform } from './write_back.js';

/** Prefab and scene ids (file names). */
export const ID = /^[a-z][a-z0-9_]*$/;

/** Placed ids and child names (code names a placed entity `Placed.<id>`). */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A typed name as an id: "My Crate 2" → "my_crate_2" ('' stays ''). */
export function toId(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return id === '' || /^[a-z]/.test(id) ? id : `e_${id}`;
}

/** `base` when it is free, else `base_2`, `base_3`, ... */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  const stem = base.replace(/_\d+$/, '');
  for (let n = 2; ; n++) if (!taken(`${stem}_${n}`)) return `${stem}_${n}`;
}

function checkId(id: string, what: string): void {
  if (!ID.test(id)) {
    const fix = toId(id);
    fail('PP1004', `${what} "${id}" must be snake_case`, { fix: fix === '' ? 'Use lowercase letters, digits and "_".' : `Use "${fix}".` });
  }
}

// ── Primitives ───────────────────────────────────────────────────────────────

export type PrimitiveKind = 'empty' | 'cube' | 'sphere' | 'plane' | 'directional_light' | 'point_light' | 'spot_light' | 'camera';

export const PRIMITIVE_KINDS: readonly PrimitiveKind[] = ['empty', 'cube', 'sphere', 'plane', 'directional_light', 'point_light', 'spot_light', 'camera'];

export interface Primitive {
  /** The prefab id it is a placement of (a free one is chosen if this one is taken by another prefab). */
  readonly prefab: string;
  readonly doc: JsonObject;
  /** Extra placement fields (a light's aim). */
  readonly placement: JsonObject;
}

/** What a primitive is in this game's dimension (2D: Cube is a rect, Sphere a circle, no Plane). */
export function primitive(kind: PrimitiveKind, dimension: '2d' | '3d'): Primitive {
  const flat = dimension === '2d';
  const shape = (prefab: string, fields: JsonObject): Primitive => ({ prefab, doc: { components: { shape: fields } }, placement: {} });
  const light = (prefab: string, fields: JsonObject, aim?: Json): Primitive => ({
    prefab, doc: { components: { light: fields } }, placement: aim === undefined || flat ? {} : { rotation: aim },
  });
  switch (kind) {
    case 'empty': return { prefab: 'empty', doc: {}, placement: {} };
    case 'cube': return flat ? shape('square', { kind: 'rect' }) : shape('cube', { kind: 'box' });
    case 'sphere': return flat ? shape('circle', { kind: 'circle' }) : shape('sphere', { kind: 'sphere' });
    case 'plane':
      if (flat) fail('PP9645', 'A 2D game has no plane', { fix: 'Add a Cube (a rect in 2D) and scale it.' });
      return shape('plane', { kind: 'plane', size: [10, 1, 10] });
    // Aimed down and across the scene, as a sun would be.
    case 'directional_light': return light('directional_light', { kind: 'directional' }, [50, -30, 0]);
    case 'point_light': return light('point_light', { kind: 'point' });
    case 'spot_light': return light('spot_light', { kind: 'spot' }, [90, 0, 0]);
    case 'camera': return { prefab: 'camera', doc: { components: { camera: flat ? { mode: 'orthographic', size: 5 } : { rig: 'fixed' } } }, placement: {} };
  }
}

/**
 * The prefab a primitive places: an existing prefab with that id and the same content is
 * reused; otherwise the first free id (`cube`, `cube_2`, ...) is created.
 */
export function ensurePrefab(docs: ProjectDocuments, project: Project, base: string, doc: JsonObject): { readonly id: string; readonly patches: FilePatch[] } {
  const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);
  const taken = (id: string): boolean => project.prefabs.has(id) || docs.has(`prefabs/${id}.prefab.json`);
  let id = base;
  for (let n = 2; ; n++) {
    const existing = project.prefabs.get(id);
    if (existing !== undefined && docs.has(existing.path) && same(docs.json(existing.path), doc)) return { id, patches: [] };
    if (!taken(id)) return { id, patches: [{ path: `prefabs/${id}.prefab.json`, ops: [{ op: 'add', pointer: '', value: doc }] }] };
    id = `${base}_${n}`;
  }
}

// ── Working copies of the lists entries live in ──────────────────────────────

type ListKey = 'entities' | 'children';

interface Slot {
  readonly path: string;
  readonly key: ListKey;
  readonly index: number;
}

/** Where an entry sits: a scene's "entities" or a prefab's "children" (undefined: a region entity's own file). */
export function slotOf(source: EntitySource): Slot | undefined {
  const m = /^\/(entities|children)\/(\d+)$/.exec(source.pointer);
  return m === null ? undefined : { path: source.path, key: m[1] as ListKey, index: Number(m[2]) };
}

interface Item {
  value: Json;
  /** Its index before the edit (undefined: new here). */
  readonly from?: number;
  /** A created or moved entry, by its order in the plan. */
  readonly mark?: number;
}

interface List {
  readonly key: ListKey;
  readonly items: Item[];
  readonly existed: boolean;
  changed: boolean;
}

/** Lists being edited, turned into patches (each changed list replaced whole) and key remaps at the end. */
class Working {
  readonly #docs: ProjectDocuments;
  readonly #lists = new Map<string, List>();
  readonly #removedFiles = new Set<string>();
  #marks = 0;

  constructor(docs: ProjectDocuments) {
    this.#docs = docs;
  }

  list(path: string, key: ListKey): List {
    let list = this.#lists.get(path);
    if (list === undefined) {
      const value = this.#docs.get(path, pointerOf(key));
      const items = Array.isArray(value) ? (value as readonly Json[]).map((v, from) => ({ value: v, from })) : [];
      list = { key, items, existed: Array.isArray(value), changed: false };
      this.#lists.set(path, list);
    }
    if (list.key !== key) fail('PP9622', `${path} holds both "entities" and "children"`);
    return list;
  }

  indexOf(slot: Slot): number {
    return this.list(slot.path, slot.key).items.findIndex((item) => item.from === slot.index);
  }

  /** Take an entry out of its list (undefined when already taken). */
  take(slot: Slot): Item | undefined {
    const list = this.list(slot.path, slot.key);
    const at = this.indexOf(slot);
    if (at < 0) return undefined;
    list.changed = true;
    return list.items.splice(at, 1)[0];
  }

  /** Insert an item at `index` (negative or undefined: the end). */
  insert(path: string, key: ListKey, item: Item, index?: number): void {
    const list = this.list(path, key);
    list.items.splice(index === undefined || index < 0 ? list.items.length : index, 0, item);
    list.changed = true;
  }

  /** A marked item: a new entry, or a moved one (which keeps `from` when it stays in its own list). */
  marked(value: Json, from?: Item): Item & { readonly mark: number } {
    return { ...(from?.from !== undefined && { from: from.from }), value, mark: this.#marks++ };
  }

  removeFile(path: string): void {
    this.#removedFiles.add(path);
  }

  patches(): FilePatch[] {
    const out: FilePatch[] = [];
    for (const [path, list] of this.#lists) {
      if (!list.changed) continue;
      const value = list.items.map((item) => item.value);
      const op: JsonOp = list.existed ? { op: 'replace', pointer: pointerOf(list.key), value } : { op: 'add', pointer: pointerOf(list.key), value };
      out.push({ path, ops: [op] });
    }
    for (const path of this.#removedFiles) out.push({ path, ops: [{ op: 'remove', pointer: '' }] });
    return out;
  }

  /** Where a marked entry ended up. */
  position(mark: number): { readonly path: string; readonly key: ListKey; readonly index: number } | undefined {
    for (const [path, list] of this.#lists) {
      const index = list.items.findIndex((item) => item.mark === mark);
      if (index >= 0) return { path, key: list.key, index };
    }
    return undefined;
  }

  /** A source key after the edit (undefined: the entity is gone, or moved and known by its mark). */
  remap(key: string): string | undefined {
    const out: string[] = [];
    for (const segment of key.split('>')) {
      const m = /^(.*)#\/(entities|children)\/(\d+)(@\d+)?$/.exec(segment);
      if (m !== null) {
        const [, path, listKey, index, cell] = m as unknown as [string, string, ListKey, string, string | undefined];
        const list = this.#lists.get(path);
        if (list !== undefined && list.changed && list.key === listKey) {
          const at = list.items.findIndex((item) => item.from === Number(index) && item.mark === undefined);
          if (at < 0) return undefined;
          out.push(`${path}#/${listKey}/${at}${cell ?? ''}`);
          continue;
        }
      } else if (this.#removedFiles.has(segment.replace(/#.*$/, ''))) {
        return undefined;
      }
      out.push(segment);
    }
    return out.join('>');
  }
}

// ── Context and plans ────────────────────────────────────────────────────────

/** What the plans read from a session's edit world. */
export interface OpsContext {
  readonly documents: ProjectDocuments;
  readonly project: Project;
  readonly scene: SceneDoc;
  readonly dimension: '2d' | '3d';
  /** The entity's document source, or fail (PP9629). */
  source(id: EntityId, what: string): EntitySource;
  parentOf(id: EntityId): EntityId | null;
  /** The entity's transform relative to `parent`'s world transform (null: the world). */
  relativeTo(id: EntityId, parent: EntityId | null): LocalTransform;
}

export interface OpsPlan {
  readonly label: string;
  readonly patches: readonly FilePatch[];
  /** An existing entity's source key after the edit (undefined: gone, or moved — see `created`). */
  remap(key: string): string | undefined;
  /** Source keys of the entities the edit created or moved, in the order given. */
  readonly created: readonly string[];
}

/** A copied entry: a placement or a prefab child, as its file holds it. */
export interface EntryCopy {
  readonly kind: 'placement' | 'child';
  readonly entry: JsonObject;
}

interface Destination {
  readonly path: string;
  readonly key: ListKey;
  /** The prefab whose "children" these are (child destinations). */
  readonly owner?: string;
  /** The parent entity's source key (child destinations). */
  readonly parentKey?: string;
}

function entryOf(ctx: OpsContext, source: EntitySource): JsonObject {
  const entry = asObject(ctx.documents.get(source.path, source.pointer));
  if (entry === undefined) fail('PP9622', `${source.path} at ${source.pointer} is not an object`, { fix: 'Re-read the documents; they changed.' });
  return entry;
}

function prefabDoc(project: Project, id: string): PrefabDoc {
  const prefab = project.prefabs.get(id);
  if (prefab === undefined) fail('PP2041', `Unknown prefab "${id}"`);
  return prefab;
}

/** Where children of `parent` are written: its prefab's file (`near`: a sibling's file when it is one of the parent's). */
function destinationOf(ctx: OpsContext, parent: EntityId | null, near?: EntitySource): Destination {
  if (parent === null) return { path: ctx.scene.path, key: 'entities' };
  const source = ctx.source(parent, 'Adding a child');
  const owner = source.prefab;
  if (owner === undefined) {
    fail('PP1003', `"${source.kind === 'child' ? source.name ?? 'This child' : 'This entity'}" is an inline child of its prefab, so it can't have children`, {
      path: source.path, pointer: source.pointer,
      fix: 'Add the child to its parent instead, or give this child a prefab of its own ({"prefab": "<name>"}).',
    });
  }
  const path = near?.kind === 'child' ? near.path : prefabDoc(ctx.project, owner).path;
  return { path, key: 'children', owner, parentKey: source.key };
}

/** The prefab the file at `path` defines. */
function prefabAt(project: Project, path: string): string | undefined {
  for (const prefab of project.prefabs.values()) if (prefab.path === path) return prefab.id;
  return undefined;
}

/** Names already used by the children of the prefab whose file is `path`. */
function childNames(project: Project, path: string): Set<string> {
  const id = prefabAt(project, path);
  const names = new Set<string>();
  if (id === undefined) return names;
  for (const child of resolvePrefab(project, id).children) if (child.name !== undefined) names.add(child.name);
  return names;
}

/** The base scene file an inherited placement comes from (undefined: the open scene's own). */
export function inheritedFrom(scene: SceneDoc, source: EntitySource): string | undefined {
  if (scene.extends === undefined || source.kind !== 'placement' || source.path.startsWith(`scenes/${scene.id}/`)) return undefined;
  return /^scenes\/([^/]+)\//.exec(source.path)?.[1];
}

function placedIds(scene: SceneDoc): Set<string> {
  return new Set(scene.entities.map((p) => p.id).filter((id): id is string => id !== undefined));
}

/** Whether a prefab contains `target` (as itself, a base, or any descendant's prefab). */
function contains(project: Project, prefab: string, target: string, seen = new Set<string>()): boolean {
  if (prefab === target) return true;
  if (seen.has(prefab) || !project.prefabs.has(prefab)) return false;
  seen.add(prefab);
  const doc = project.prefabs.get(prefab)!;
  if (doc.extends !== undefined && contains(project, doc.extends, target, seen)) return true;
  return resolvePrefab(project, prefab).children.some((c) => c.prefab !== undefined && contains(project, c.prefab, target, seen));
}

function checkNesting(ctx: OpsContext, entry: JsonObject, dest: Destination): void {
  const prefab = entry['prefab'];
  if (dest.owner === undefined || typeof prefab !== 'string') return;
  if (contains(ctx.project, prefab, dest.owner)) {
    fail('PP9642', `"${prefab}" can't go inside "${dest.owner}": it contains "${dest.owner}" itself, which would nest forever`, {
      fix: 'Choose a parent of another prefab.',
    });
  }
}

const ORDER = ['prefab', 'id', 'name', 'at', 'rotation', 'scale', 'z'];

function ordered(entry: Record<string, Json>): JsonObject {
  const out: Record<string, Json> = {};
  for (const key of ORDER) if (entry[key] !== undefined) out[key] = entry[key]!;
  for (const [key, value] of Object.entries(entry)) if (!(key in out) && value !== undefined) out[key] = value;
  return out;
}

/** The scale an entry without "scale" gets: its prefab's, else 1. */
function defaultScale(project: Project, prefab: Json | undefined): Vec3 {
  const scale = typeof prefab === 'string' && project.prefabs.has(prefab) ? resolvePrefab(project, prefab).scale : undefined;
  if (scale === undefined) return Vec3.ONE;
  if (typeof scale === 'number') return new Vec3(scale, scale, scale);
  return new Vec3(scale[0]!, scale[1]!, scale[2] ?? 1);
}

/** An entry's transform fields for a local transform, defaults left out. */
export function transformFields(project: Project, prefab: Json | undefined, local: LocalTransform, dimension: '2d' | '3d'): Record<string, Json> {
  const out: Record<string, Json> = {};
  const p = local.position;
  const identity = Math.abs(Math.abs(local.rotation.w) - 1) < 1e-9;
  if (dimension === '2d') {
    out['at'] = [tidy(p.x), tidy(p.y)];
    const z = typeof prefab === 'string' && project.prefabs.has(prefab) ? resolvePrefab(project, prefab).z ?? 0 : 0;
    if (tidy(p.z) !== tidy(z)) out['z'] = tidy(p.z);
    if (!identity) out['rotation'] = tidy(local.rotation.angle());
  } else {
    out['at'] = [tidy(p.x), tidy(p.y), tidy(p.z)];
    if (!identity) {
      const e = local.rotation.to_euler();
      out['rotation'] = [tidy(e.x), tidy(e.y), tidy(e.z)];
    }
  }
  const d = defaultScale(project, prefab);
  const s = local.scale;
  const [x, y, z] = [tidy(s.x), tidy(s.y), tidy(s.z)];
  if (x !== tidy(d.x) || y !== tidy(d.y) || (dimension === '3d' && z !== tidy(d.z))) {
    out['scale'] = dimension === '2d' ? (x === y ? x : [x, y]) : (x === y && y === z ? x : [x, y, z]);
  }
  return out;
}

/**
 * An entry as the other kind (or the same kind elsewhere): a placement's "id" becomes a
 * child's "name" and back, made unique in `taken`; `transform` replaces at / rotation / scale / z.
 */
function convert(entry: JsonObject, from: 'placement' | 'child', to: 'placement' | 'child', taken: Set<string>, transform?: Record<string, Json>): JsonObject {
  const out: Record<string, Json> = { ...entry };
  const label = from === 'placement' ? entry['id'] : entry['name'];
  delete out['id'];
  delete out['name'];
  if (from === 'placement') {
    delete out['layer'];
    delete out['always_loaded'];
  }
  if (to === 'placement' && typeof out['prefab'] !== 'string') {
    fail('PP9641', `"${typeof label === 'string' ? label : 'This child'}" is an inline child (no prefab of its own), so it can't be placed in the scene by itself`, {
      fix: 'Move it within its prefab, or give it a prefab ({"prefab": "<name>"}) first.',
    });
  }
  if (transform !== undefined) {
    for (const key of ['at', 'rotation', 'scale', 'z']) delete out[key];
    Object.assign(out, transform);
  }
  if (typeof label === 'string' && NAME.test(label)) {
    const unique = uniqueId(label, (id) => taken.has(id));
    taken.add(unique);
    out[to === 'placement' ? 'id' : 'name'] = unique;
  }
  return ordered(out);
}

function takenIn(ctx: OpsContext, dest: Destination): Set<string> {
  return dest.key === 'entities' ? placedIds(ctx.scene) : childNames(ctx.project, dest.path);
}

function keyAt(w: Working, dest: Destination, mark: number, grid: boolean): string {
  const at = w.position(mark)!;
  const segment = `${at.path}#/${at.key}/${at.index}${grid ? '@0' : ''}`;
  return dest.parentKey === undefined ? segment : `${w.remap(dest.parentKey) ?? dest.parentKey}>${segment}`;
}

/** The ids given, without repeats or entities whose ancestor is also given. */
function topmost(ctx: OpsContext, ids: readonly EntityId[]): EntityId[] {
  const set = new Set(ids);
  const under = (id: EntityId): boolean => {
    for (let at = ctx.parentOf(id); at !== null; at = ctx.parentOf(at)) if (set.has(at)) return true;
    return false;
  };
  return [...set].filter((id) => !under(id));
}

function plan(label: string, w: Working, created: readonly string[], extra: readonly FilePatch[] = []): OpsPlan {
  return { label, patches: [...w.patches(), ...extra], remap: (key) => w.remap(key), created };
}

/** Add placed ids to the open (derived) scene's "exclude". */
function excludePatch(ctx: OpsContext, ids: readonly string[]): FilePatch[] {
  if (ids.length === 0) return [];
  const current = ctx.documents.get(ctx.scene.path, pointerOf('exclude'));
  const list = Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : [];
  const value = [...list, ...ids.filter((id) => !list.includes(id))];
  return [{ path: ctx.scene.path, ops: [{ op: 'add', pointer: pointerOf('exclude'), value }] }];
}

// ── The edits ────────────────────────────────────────────────────────────────

/** Show or hide entities in the game (the entry's "visible"; shown is the default, so it is removed). */
export function visiblePatches(ctx: OpsContext, ids: readonly EntityId[], visible: boolean): FilePatch[] {
  const byPath = new Map<string, JsonOp[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    const source = ctx.source(id, 'Showing or hiding it');
    if (seen.has(`${source.path}#${source.pointer}`)) continue;
    seen.add(`${source.path}#${source.pointer}`);
    const entry = entryOf(ctx, source);
    const pointer = source.pointer + pointerOf('visible');
    const ops = byPath.get(source.path) ?? [];
    if (visible && entry['visible'] !== undefined) ops.push({ op: 'remove', pointer });
    if (!visible && entry['visible'] !== false) ops.push({ op: 'add', pointer, value: false });
    byPath.set(source.path, ops);
  }
  return [...byPath].map(([path, ops]) => ({ path, ops }));
}

/** Add a placement of a primitive at `at`, creating its prefab the first time. */
export function primitivePlan(ctx: OpsContext, kind: PrimitiveKind, at: readonly number[], label: string): OpsPlan {
  const shape = primitive(kind, ctx.dimension);
  const prefab = ensurePrefab(ctx.documents, ctx.project, shape.prefab, shape.doc);
  const w = new Working(ctx.documents);
  const dest = destinationOf(ctx, null);
  const item = w.marked(ordered({ prefab: prefab.id, at: [...at], ...shape.placement }));
  w.insert(dest.path, dest.key, item);
  return { label, patches: [...prefab.patches, ...w.patches()], remap: (key) => w.remap(key), created: [keyAt(w, dest, item.mark, false)] };
}

/** Add entries under `parent` (null: the scene's root), at the end: paste, and Create Child. */
export function insertPlan(ctx: OpsContext, copies: readonly EntryCopy[], parent: EntityId | null, label: string): OpsPlan {
  const dest = destinationOf(ctx, parent);
  const taken = takenIn(ctx, dest);
  const w = new Working(ctx.documents);
  const created: string[] = [];
  for (const copy of copies) {
    checkNesting(ctx, copy.entry, dest);
    const value = convert(copy.entry, copy.kind, dest.key === 'entities' ? 'placement' : 'child', taken);
    const item = w.marked(value);
    w.insert(dest.path, dest.key, item);
    created.push(keyAt(w, dest, item.mark, value['grid'] !== undefined));
  }
  return plan(label, w, created);
}

/** A new empty child of `parent` (in its prefab: every instance gets it). */
export function createChildPlan(ctx: OpsContext, parent: EntityId): OpsPlan {
  const dest = destinationOf(ctx, parent);
  const name = uniqueId('child', (n) => takenIn(ctx, dest).has(n));
  return insertPlan(ctx, [{ kind: 'child', entry: { name } }], parent, 'Create Child');
}

/** The entries of entities, for the clipboard. */
export function copyEntries(ctx: OpsContext, ids: readonly EntityId[]): EntryCopy[] {
  return topmost(ctx, ids).map((id) => {
    const source = ctx.source(id, 'Copying it');
    return { kind: source.kind, entry: entryOf(ctx, source) };
  });
}

/** A copy of each entry right after it (a placement's id and a child's name made unique). */
export function duplicatePlan(ctx: OpsContext, ids: readonly EntityId[]): OpsPlan {
  const w = new Working(ctx.documents);
  const created: string[] = [];
  const seen = new Set<string>();
  const sceneTaken = placedIds(ctx.scene);
  const names = new Map<string, Set<string>>();
  for (const id of topmost(ctx, ids)) {
    const source = ctx.source(id, 'Duplicating it');
    if (seen.has(`${source.path}#${source.pointer}`)) continue;
    seen.add(`${source.path}#${source.pointer}`);
    const entry = entryOf(ctx, source);
    const slot = slotOf(source);
    const parent = ctx.parentOf(id);
    const dest: Destination = slot === undefined || inheritedFrom(ctx.scene, source) !== undefined
      ? destinationOf(ctx, null)
      : { path: slot.path, key: slot.key, ...(source.kind === 'child' && parent !== null && { parentKey: ctx.source(parent, 'Duplicating it').key }) };
    if (dest.key === 'children' && !names.has(dest.path)) names.set(dest.path, childNames(ctx.project, dest.path));
    const taken = dest.key === 'entities' ? sceneTaken : names.get(dest.path)!;
    const value = convert(entry, source.kind, source.kind, taken);
    const after = slot === undefined || slot.path !== dest.path ? -1 : w.indexOf(slot) + 1;
    const item = w.marked(value);
    w.insert(dest.path, dest.key, item, after);
    created.push(keyAt(w, dest, item.mark, value['grid'] !== undefined));
  }
  return plan(ids.length === 1 ? 'Duplicate' : `Duplicate ${ids.length}`, w, created);
}

/** Remove entities: placements from the scene, children from their prefab (every instance loses them). */
export function deletePlan(ctx: OpsContext, ids: readonly EntityId[]): OpsPlan {
  const w = new Working(ctx.documents);
  const top = topmost(ctx, ids);
  const exclude: string[] = [];
  for (const id of top) {
    const source = ctx.source(id, 'Deleting it');
    const base = inheritedFrom(ctx.scene, source);
    if (base !== undefined) {
      if (source.kind !== 'placement' || source.placedId === undefined) {
        fail('PP9646', `This entity is inherited from scene "${base}" and has no "id", so "${ctx.scene.id}" can't exclude it`, {
          path: source.path, pointer: source.pointer,
          fix: `Give the placement an "id" in ${source.path} (then delete it here), or open "${base}" to delete it there.`,
        });
      }
      exclude.push(source.placedId);
      continue;
    }
    const slot = slotOf(source);
    if (slot !== undefined) w.take(slot);
    else w.removeFile(source.path);
  }
  const patches = excludePatch(ctx, exclude);
  return plan(top.length === 1 ? 'Delete' : `Delete ${top.length}`, w, [], patches);
}

/**
 * Move entities under `parent` (null: the scene's root), before `before` (null: at the end).
 * Within the same list it is a reorder; to another parent the entry moves to that parent's
 * prefab (or the scene) with its transform rewritten so it stays where it is in the world.
 */
export function movePlan(ctx: OpsContext, ids: readonly EntityId[], parent: EntityId | null, before: EntityId | null = null): OpsPlan {
  const moving = topmost(ctx, ids);
  if (moving.length === 0) return plan('Move', new Working(ctx.documents), []);
  if (parent !== null) {
    for (let at: EntityId | null = parent; at !== null; at = ctx.parentOf(at)) {
      if (moving.includes(at)) fail('PP9642', 'An entity can\'t move inside itself or one of its own children', { fix: 'Drop it on another entity.' });
    }
  }
  const sources = moving.map((id) => ctx.source(id, 'Moving it'));
  for (const source of sources) {
    const base = inheritedFrom(ctx.scene, source);
    if (base !== undefined) {
      fail('PP9646', `This entity is inherited from scene "${base}", so it can't move in "${ctx.scene.id}"`, {
        path: source.path, pointer: source.pointer, fix: `Open "${base}" to move it there (every scene extending it changes).`,
      });
    }
  }
  const beforeSource = before === null || moving.includes(before) ? undefined : ctx.source(before, 'Moving it');
  const sibling = beforeSource ?? sources.find((s, i) => s.kind === 'child' && ctx.parentOf(moving[i]!) === parent);
  const dest = destinationOf(ctx, parent, parent !== null && sibling?.kind === 'child' ? sibling : undefined);
  const taken = takenIn(ctx, dest);
  const w = new Working(ctx.documents);
  const items: { item: Item & { readonly mark: number }; grid: boolean }[] = [];
  for (const [i, source] of sources.entries()) {
    const id = moving[i]!;
    const slot = slotOf(source);
    if (slot === undefined) {
      fail('PP9643', 'A streamed region\'s entity is its own file, so it has no place in the scene\'s list', {
        path: source.path, fix: 'Move it in the world instead (its region decides when it loads).',
      });
    }
    const entry = entryOf(ctx, source);
    checkNesting(ctx, entry, dest);
    const item = w.take(slot)!;
    const grid = entry['grid'] !== undefined;
    if (slot.path === dest.path && slot.key === dest.key) {
      items.push({ item: w.marked(item.value, item), grid });
      continue;
    }
    const sameParent = ctx.parentOf(id) === parent;
    if (!sameParent && grid) {
      fail('PP9626', 'A "grid" entry can\'t change parent', { path: source.path, pointer: source.pointer, fix: 'Replace the grid with separate entries first.' });
    }
    const transform = sameParent ? undefined : transformFields(ctx.project, entry['prefab'], ctx.relativeTo(id, parent), ctx.dimension);
    const value = convert(entry, source.kind, dest.key === 'entities' ? 'placement' : 'child', taken, transform);
    items.push({ item: w.marked(value), grid });
  }
  const beforeSlot = beforeSource === undefined ? undefined : slotOf(beforeSource);
  let index = beforeSlot !== undefined && beforeSlot.path === dest.path && beforeSlot.key === dest.key ? w.indexOf(beforeSlot) : -1;
  const created: string[] = [];
  for (const { item, grid } of items) {
    w.insert(dest.path, dest.key, item, index);
    if (index >= 0) index++;
    created.push(keyAt(w, dest, item.mark, grid));
  }
  return plan(moving.length === 1 ? 'Move' : `Move ${moving.length}`, w, created);
}

// ── Scenes ───────────────────────────────────────────────────────────────────

/** Every file of a scene (scene.json, world.json, regions). */
export function sceneFiles(docs: ProjectDocuments, id: string): string[] {
  return docs.list().filter((path) => path.startsWith(`scenes/${id}/`));
}

function requireScene(project: Project, id: string): void {
  if (!project.scenes.has(id)) fail('PP2045', `Unknown scene "${id}"`, { fix: `Scenes: ${[...project.scenes.keys()].join(', ')}.` });
}

function requireFreeScene(docs: ProjectDocuments, project: Project, id: string): void {
  checkId(id, 'A scene id');
  if (project.scenes.has(id) || sceneFiles(docs, id).length > 0) fail('PP2010', `There is already a scene "${id}"`, { fix: 'Choose another name.' });
}

export function createScenePatch(docs: ProjectDocuments, project: Project, id: string, doc: JsonObject = { entities: [] }): FilePatch {
  requireFreeScene(docs, project, id);
  return { path: `scenes/${id}/scene.json`, ops: [{ op: 'add', pointer: '', value: doc }] };
}

/** Move every file of scene `from` to `to` (only JSON files: the documents hold JSON). */
/** Scenes whose scene.json says `"extends": "<id>"`. */
function derivedScenes(project: Project, id: string): SceneDoc[] {
  return [...project.scenes.values()].filter((scene) => scene.extends === id);
}

export function renameScenePatches(docs: ProjectDocuments, project: Project, from: string, to: string): FilePatch[] {
  requireScene(project, from);
  requireFreeScene(docs, project, to);
  // Scenes extending it follow the rename.
  const patches: FilePatch[] = derivedScenes(project, from)
    .map((scene) => ({ path: scene.path, ops: [{ op: 'replace', pointer: pointerOf('extends'), value: to }] }));
  for (const path of sceneFiles(docs, from)) {
    if (!path.endsWith('.json')) fail('PP9644', `Scene "${from}" has a file the editor can't move: ${path}`, { fix: 'Rename the scene\'s folder on disk.' });
    patches.push({ path, ops: [{ op: 'remove', pointer: '' }] });
    patches.push({ path: `scenes/${to}/${path.slice(`scenes/${from}/`.length)}`, ops: [{ op: 'add', pointer: '', value: docs.json(path) }] });
  }
  return patches;
}

export function deleteScenePatches(docs: ProjectDocuments, project: Project, id: string): FilePatch[] {
  requireScene(project, id);
  const derived = derivedScenes(project, id).map((scene) => scene.id);
  if (derived.length > 0) {
    fail('PP9647', `Scene "${id}" is the base of ${derived.map((d) => `"${d}"`).join(', ')}, so it can't be deleted`, {
      fix: `Remove "extends": "${id}" from ${derived.length === 1 ? 'that scene' : 'those scenes'} first.`,
    });
  }
  return sceneFiles(docs, id).map((path) => ({ path, ops: [{ op: 'remove', pointer: '' }] }));
}
