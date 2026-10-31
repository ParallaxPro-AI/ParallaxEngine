/**
 * Hierarchy edits end to end on the headless platform: primitives (and the prefabs made for
 * them), children, duplicate, delete, reorder and reparent (keeping world positions), copy /
 * paste, in-game visibility, editor-only hiding, and scenes — each one undo step.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@parallax/runtime/core';
import { ProjectDocuments } from './documents.js';
import { deleteScenePatches, renameScenePatches, toId, uniqueId } from './entity_ops.js';
import { openHeadlessEditor } from './headless.js';
import type { HeadlessEditor } from './headless.js';
import { DATA_2D, DATA_3D, declare2d, declare3d, files, LOG } from './test_fixtures.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code ?? String(e); }
  return undefined;
}

async function editor3d(data: Record<string, unknown> = DATA_3D): Promise<HeadlessEditor> {
  const ed = await openHeadlessEditor({ entry: () => declare3d(), files: files(data), mode: '3d', size: { width: 800, height: 600 } });
  ed.frame();
  return ed;
}

const placed = (ed: HeadlessEditor, id: string): EntityId => [...ed.session.runtime.kernel.world.live()].find((r) => r.placedId === id)!.id;
const json = <T>(ed: HeadlessEditor, path: string): T => ed.session.documents.json(path) as unknown as T;
type Scene = { entities: Record<string, unknown>[] };
type Prefab = { children?: Record<string, unknown>[] };
const scene = (ed: HeadlessEditor): Scene => json<Scene>(ed, 'scenes/main/scene.json');
const tower = (ed: HeadlessEditor): Prefab => json<Prefab>(ed, 'prefabs/tower.prefab.json');
const record = (ed: HeadlessEditor, id: EntityId) => ed.session.runtime.kernel.world.get(id)!;
const childOf = (ed: HeadlessEditor, id: EntityId, i = 0): EntityId => record(ed, id).children[i]!;

beforeEach(() => { LOG.length = 0; });

describe('names', () => {
  it('turns typed names into ids and finds a free one', () => {
    expect(toId('My Crate 2')).toBe('my_crate_2');
    expect(toId('  ')).toBe('');
    expect(toId('3d')).toBe('e_3d');
    const taken = new Set(['crate', 'crate_2']);
    expect(uniqueId('crate', (n) => taken.has(n))).toBe('crate_3');
    expect(uniqueId('crate_2', (n) => taken.has(n))).toBe('crate_3');
    expect(uniqueId('box', (n) => taken.has(n))).toBe('box');
  });
});

describe('primitives', () => {
  it('a cube places a prefab made the first time, reused after; one undo takes back both', async () => {
    const ed = await editor3d();
    const cube = ed.session.addPrimitive('cube', [0, 0, 5]);
    expect(json(ed, 'prefabs/cube.prefab.json')).toEqual({ components: { shape: { kind: 'box' } } });
    expect(scene(ed).entities.at(-1)).toEqual({ prefab: 'cube', at: [0, 0, 5] });
    expect(record(ed, cube).components.get('shape')!['kind']).toBe('box');
    expect(ed.session.selection).toEqual([cube]);
    ed.session.addPrimitive('cube', [1, 0, 5]);
    expect(ed.session.documents.list().filter((p) => p.startsWith('prefabs/cube'))).toEqual(['prefabs/cube.prefab.json']);
    ed.session.undo();
    ed.session.undo();
    expect(ed.session.documents.has('prefabs/cube.prefab.json')).toBe(false);
    expect(scene(ed).entities).toHaveLength(5);
  });

  it('lights and cameras; a taken prefab id with other content gets a fresh one', async () => {
    const ed = await editor3d({ ...DATA_3D, 'prefabs/sphere.prefab.json': { components: { shape: { kind: 'sphere', color: [1, 0, 0, 1] } } } });
    const sun = ed.session.addPrimitive('directional_light', [0, 10, 0]);
    expect(record(ed, sun).components.get('light')!['kind']).toBe('directional');
    expect(scene(ed).entities.at(-1)!['rotation']).toEqual([50, -30, 0]);
    expect(record(ed, ed.session.addPrimitive('spot_light', [0, 4, 0])).components.get('light')!['kind']).toBe('spot');
    // The fixture's camera prefab is { camera: { rig: 'fixed', fov: 60 } }: not the same, so camera_2.
    const camera = ed.session.addPrimitive('camera', [0, 2, -4]);
    expect(record(ed, camera).prefab).toBe('camera_2');
    expect(record(ed, ed.session.addPrimitive('sphere', [0, 0, 0])).prefab).toBe('sphere_2');
    // An empty has nothing but the selection outline.
    expect([...record(ed, ed.session.addPrimitive('empty', [0, 0, 0])).components.keys()]).toEqual(['outline']);
  });

  it('2D: a cube is a rect, a sphere a circle, and there is no plane', async () => {
    const ed = await openHeadlessEditor({ entry: declare2d, files: files(DATA_2D), mode: '2d', size: { width: 800, height: 600 } });
    ed.frame();
    expect(record(ed, ed.session.addPrimitive('cube', [0, 0])).components.get('shape')!['kind']).toBe('rect');
    expect(record(ed, ed.session.addPrimitive('sphere', [1, 0])).prefab).toBe('circle');
    expect(code(() => ed.session.addPrimitive('plane', [0, 0]))).toBe('PP9645');
  });
});

describe('children, duplicate, delete', () => {
  it('Create Child adds an empty child to the prefab, so every instance gets it', async () => {
    const data = { ...DATA_3D, 'scenes/main/scene.json': { entities: [{ prefab: 'tower', id: 't1' }, { prefab: 'tower', id: 't2', at: [4, 0, 0] }] } };
    const ed = await editor3d(data);
    const child = ed.session.createChild(placed(ed, 't1'))!;
    expect(tower(ed).children!.map((c) => c['name'])).toEqual(['top', 'child']);
    expect(record(ed, child).parent).toBe(placed(ed, 't1'));
    expect(record(ed, placed(ed, 't2')).children).toHaveLength(2);
    expect(ed.session.selection).toEqual([child]);
    // An inline child has no prefab to hold children of its own.
    expect(code(() => ed.session.createChild(childOf(ed, placed(ed, 't1'))))).toBe('PP1003');
    ed.session.undo();
    expect(tower(ed).children).toHaveLength(1);
  });

  it('duplicates next to the original with a fresh id or name', async () => {
    const ed = await editor3d();
    const [copy] = ed.session.duplicateEntities([placed(ed, 'a')]);
    expect(scene(ed).entities.slice(1, 3).map((e) => e['id'])).toEqual(['a', 'a_2']);
    expect(record(ed, copy!).placedId).toBe('a_2');
    const [top] = ed.session.duplicateEntities([childOf(ed, placed(ed, 'tower'))]);
    expect(tower(ed).children!.map((c) => c['name'])).toEqual(['top', 'top_2']);
    expect(ed.session.selection).toEqual([top]);
  });

  it('deletes placements and prefab children in one step, keeping the selection on what remains', async () => {
    const ed = await editor3d();
    ed.session.select([placed(ed, 'tower')]);
    ed.session.deleteEntities([placed(ed, 'a'), childOf(ed, placed(ed, 'tower'))]);
    expect(scene(ed).entities.map((e) => e['id'] ?? e['prefab'])).toEqual(['camera', 'crate', 'tower', 'crate']);
    expect(tower(ed).children).toEqual([]);
    expect(ed.session.selection).toEqual([placed(ed, 'tower')]);
    ed.session.undo();
    expect(scene(ed).entities).toHaveLength(5);
    expect(tower(ed).children).toHaveLength(1);
  });
});

describe('moving in the hierarchy', () => {
  it('reorders placements in the scene file', async () => {
    const ed = await editor3d();
    ed.session.moveEntities([placed(ed, 'tower')], null, placed(ed, 'a'));
    expect(scene(ed).entities.map((e) => e['id'] ?? e['prefab'])).toEqual(['camera', 'tower', 'a', 'crate', 'crate']);
    expect(ed.session.selection).toEqual([placed(ed, 'tower')]);
    ed.session.moveEntities([placed(ed, 'camera')], null, null);
    expect(scene(ed).entities.at(-1)!['id']).toBe('camera');
  });

  it('reparents into a prefab and back out, staying where it is in the world', async () => {
    const ed = await editor3d();
    const [a] = ed.session.moveEntities([placed(ed, 'a')], placed(ed, 'tower'));
    expect(tower(ed).children!.at(-1)).toEqual({ prefab: 'crate', name: 'a', at: [3, 0, 0] });
    expect(scene(ed).entities.map((e) => e['id'] ?? e['prefab'])).toEqual(['camera', 'crate', 'tower', 'crate']);
    expect(record(ed, a!).parent).toBe(placed(ed, 'tower'));
    expect(ed.session.poseOf(a!).position.x).toBeCloseTo(0);
    ed.session.moveEntities([a!], null);
    expect(scene(ed).entities.at(-1)).toEqual({ prefab: 'crate', id: 'a', at: [0, 0, 0] });
    expect(tower(ed).children).toHaveLength(1);
    ed.session.undo();
    ed.session.undo();
    expect(scene(ed).entities[1]!['id']).toBe('a');
  });

  it('refuses moves the documents can\'t hold', async () => {
    const ed = await editor3d();
    const t = placed(ed, 'tower');
    const top = childOf(ed, t);
    expect(code(() => ed.session.moveEntities([t], top))).toBe('PP9642');
    expect(code(() => ed.session.moveEntities([placed(ed, 'a')], ed.session.sources.byKey.get('scenes/main/scene.json#/entities/2')!))).toBe('PP9642');
    expect(code(() => ed.session.moveEntities([placed(ed, 'a')], top))).toBe('PP1003');
    expect(code(() => ed.session.moveEntities([top], null))).toBe('PP9641');
    expect(code(() => ed.session.moveEntities([ed.session.sources.byKey.get('scenes/main/scene.json#/entities/4@0')!], t))).toBe('PP9626');
    expect(ed.session.documents.dirty()).toEqual([]);
  });
});

describe('copy and paste', () => {
  it('pastes at the root with a fresh id, or as a child of another entity', async () => {
    const ed = await editor3d();
    const copies = ed.session.copyEntities([placed(ed, 'a')]);
    expect(copies).toEqual([{ kind: 'placement', entry: { prefab: 'crate', id: 'a', at: [0, 0, 0] } }]);
    const [pasted] = ed.session.pasteEntities(copies);
    expect(record(ed, pasted!).placedId).toBe('a_2');
    ed.session.pasteEntities(copies, placed(ed, 'tower'));
    expect(tower(ed).children!.at(-1)).toEqual({ prefab: 'crate', name: 'a', at: [0, 0, 0] });
  });
});

describe('visibility', () => {
  it('in the game: the entry\'s "visible"', async () => {
    const ed = await editor3d();
    ed.session.setVisible([placed(ed, 'a')], false);
    expect(scene(ed).entities[1]!['visible']).toBe(false);
    expect(record(ed, placed(ed, 'a')).visible).toBe(false);
    ed.session.setVisible([placed(ed, 'a')], true);
    expect(scene(ed).entities[1]!['visible']).toBeUndefined();
  });

  it('in the editor only: not drawn or picked, never in the documents, kept across rebuilds', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    const at = ed.session.view()!.project(record(ed, a).transform.worldPosition())!;
    expect(ed.session.pickAt(at.x, at.y)).toBe(a);
    ed.session.setEditorHidden([a], true);
    expect(ed.session.isEditorHidden(a)).toBe(true);
    ed.frame();
    expect(ed.session.pickAt(at.x, at.y)).not.toBe(a);
    ed.session.setField(placed(ed, 'tower'), 'shape', 'kind', 'sphere');
    expect(record(ed, placed(ed, 'a')).visible).toBe(false);
    expect(ed.session.documents.dirty()).toEqual(['scenes/main/scene.json']);
    expect(scene(ed).entities[1]!['visible']).toBeUndefined();
    ed.session.setEditorHidden([placed(ed, 'a')], false);
    expect(record(ed, placed(ed, 'a')).visible).toBe(true);
  });
});

describe('scenes', () => {
  it('creates, renames and deletes scenes; undo and redo follow the open scene', async () => {
    const ed = await editor3d();
    ed.session.createScene('level_2');
    expect(ed.session.scene).toBe('level_2');
    expect(ed.session.scenes).toEqual(['level_2', 'main']);
    ed.session.undo();
    expect(ed.session.scene).toBe('main');
    expect(ed.session.scenes).toEqual(['main']);
    ed.session.redo();
    expect(ed.session.scene).toBe('level_2');
    ed.session.addPrimitive('cube', [0, 0, 0]);
    ed.session.renameScene('level_2', 'arena');
    expect(ed.session.scene).toBe('arena');
    expect(ed.session.documents.list().filter((p) => p.startsWith('scenes/'))).toEqual(['scenes/arena/scene.json', 'scenes/main/scene.json']);
    expect(ed.session.sources.sources.size).toBe(1);
    ed.session.deleteScene('arena');
    expect(ed.session.scene).toBe('main');
    expect(ed.session.scenes).toEqual(['main']);
    ed.session.undo();
    expect(ed.session.scene).toBe('arena');
  });

  it('refuses bad ids, taken ids and the start scene', async () => {
    const ed = await editor3d();
    expect(code(() => ed.session.createScene('Level 2'))).toBe('PP1004');
    expect(code(() => ed.session.createScene('main'))).toBe('PP2010');
    expect(code(() => ed.session.renameScene('main', 'other'))).toBe('PP9644');
    expect(code(() => ed.session.deleteScene('main'))).toBe('PP9644');
    expect(code(() => ed.session.deleteScene('missing'))).toBe('PP2045');
  });
});

describe('a derived scene ("extends")', () => {
  const TITLE = {
    extends: 'main', ui: [], exclude: ['tower'],
    entities: [{ prefab: 'crate', id: 'logo', at: [0, 3, 0] }],
  };
  async function title(): Promise<HeadlessEditor> {
    const main = { ...(DATA_3D['scenes/main/scene.json'] as object), environment: { time_of_day: 15 } };
    const ed = await editor3d({ ...DATA_3D, 'scenes/main/scene.json': main, 'scenes/title/scene.json': TITLE });
    ed.session.openScene('title');
    ed.frame();
    return ed;
  }
  const titleDoc = (ed: HeadlessEditor) => json<Scene & { exclude?: string[] }>(ed, 'scenes/title/scene.json');

  it('shows the resolved scene; an inherited entity is edited in the base file', async () => {
    const ed = await title();
    const ids = [...ed.session.runtime.kernel.world.live()].filter((r) => r.parent === null).map((r) => r.placedId ?? r.prefab);
    expect(ids).toEqual(expect.arrayContaining(['camera', 'a', 'logo']));
    expect(ids).not.toContain('tower');
    ed.session.setField(placed(ed, 'a'), 'shape', 'color', [0, 1, 0, 1]);
    expect(scene(ed).entities[1]!['components']).toEqual({ shape: { color: [0, 1, 0, 1] } });
    expect(titleDoc(ed)).toEqual(TITLE);
    // The environment it inherits is the base's too.
    expect(ed.session.environmentPath).toBe('scenes/main/scene.json');
    ed.session.setEnvironment(['time_of_day'], 9);
    expect(json<{ environment: unknown }>(ed, 'scenes/main/scene.json').environment).toEqual({ time_of_day: 9 });
    expect(titleDoc(ed)).toEqual(TITLE);
  });

  it('deleting an inherited entity excludes it (the base keeps it); duplicating copies it into the derived file', async () => {
    const ed = await title();
    ed.session.deleteEntities([placed(ed, 'a')]);
    expect(titleDoc(ed).exclude).toEqual(['tower', 'a']);
    expect(scene(ed).entities).toHaveLength(5);
    ed.session.undo();
    ed.session.duplicateEntities([placed(ed, 'camera')]);
    expect(titleDoc(ed).entities.map((e) => e['prefab'])).toEqual(['crate', 'camera']);
    expect(scene(ed).entities).toHaveLength(5);
    // Never flattened: the derived file keeps only its own keys.
    expect(Object.keys(titleDoc(ed)).sort()).toEqual(['entities', 'exclude', 'extends', 'ui']);
  });

  it('refuses to move an inherited entity or delete one without an id', async () => {
    const ed = await title();
    expect(code(() => ed.session.moveEntities([placed(ed, 'a')], null, null))).toBe('PP9646');
    const unnamed = [...ed.session.runtime.kernel.world.live()].find((r) => r.parent === null && r.placedId === undefined && r.prefab === 'crate')!.id;
    expect(code(() => ed.session.deleteEntities([unnamed]))).toBe('PP9646');
  });

  it('renaming a base renames "extends" in the scenes extending it; deleting a base is refused', () => {
    const docs = new ProjectDocuments(files({ ...DATA_3D, 'scenes/title/scene.json': TITLE, 'scenes/credits/scene.json': { extends: 'title' } }));
    docs.apply(renameScenePatches(docs, docs.project(), 'title', 'menu'));
    expect(docs.json('scenes/credits/scene.json')).toEqual({ extends: 'menu' });
    expect(docs.project().diagnostics).toEqual([]);
    expect(code(() => deleteScenePatches(docs, docs.project(), 'menu'))).toBe('PP9647');
  });
});
