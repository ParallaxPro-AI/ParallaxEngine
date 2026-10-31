/**
 * The editor session end to end on the headless platform: edit mode draws without running
 * the game, picking finds what was drawn, gizmo drags write placements back, field edits
 * land as instance overrides or prefab edits, undo/redo replay patches, play/stop round
 * trips the edit world, pause/step/time scale, and hot reload keeps the editor's state.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import type { EntityId } from '@parallax/runtime/core';
import { openHeadlessEditor } from './headless.js';
import type { HeadlessEditor } from './headless.js';
import { DATA_2D, DATA_3D, declare2d, declare3d, files, LOG } from './test_fixtures.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code ?? String(e); }
  return undefined;
}

let codeVersion = 1;

async function editor3d(data: Record<string, unknown> = DATA_3D): Promise<HeadlessEditor> {
  codeVersion = 1;
  const ed = await openHeadlessEditor({ entry: () => declare3d(codeVersion), files: files(data), mode: '3d', size: { width: 800, height: 600 } });
  ed.frame();
  return ed;
}

const placed = (ed: HeadlessEditor, id: string): EntityId => [...ed.session.runtime.kernel.world.live()].find((r) => r.placedId === id)!.id;
const sceneJson = (ed: HeadlessEditor): { entities: Record<string, unknown>[] } =>
  ed.session.documents.json('scenes/main/scene.json') as unknown as { entities: Record<string, unknown>[] };

beforeEach(() => { LOG.length = 0; });

describe('edit mode', () => {
  it('draws the scene through the editor camera without running any game logic', async () => {
    const ed = await editor3d();
    ed.frames(10);
    expect(LOG).toEqual([]);
    const frame = ed.surface3d.last!;
    expect(frame.views[0]!.camera).toBe(ed.session.cameraEntity);
    // Every crate (2 placed + 2 in the grid), the tower and its child are drawn.
    expect(frame.meshes.reduce((n, b) => n + b.count, 0)).toBe(6);
    const crate = ed.session.runtime.kernel.world.get(placed(ed, 'a'))!;
    expect((crate.behaviors[0]!.instance as { ticks: number }).ticks).toBe(0);
  });

  it('the editor camera clears to the game camera\'s background, not the engine default', async () => {
    const ed = await editor3d({ ...DATA_3D, 'prefabs/camera.prefab.json': { components: { camera: { rig: 'fixed', fov: 60, background: '#262421' } } } });
    const view = ed.surface3d.last!.views[0]!;
    expect(view.camera).toBe(ed.session.cameraEntity);
    expect(view.clear?.slice(0, 3).map((c) => Math.round(c * 255))).toEqual([0x26, 0x24, 0x21]);
  });

  it('maps every entity to the document it came from', async () => {
    const ed = await editor3d();
    const { sources } = ed.session.sources;
    const kinds = [...sources.values()].map((s) => `${s.kind}:${s.pointer}${s.cell === undefined ? '' : `@${s.cell}`}`);
    expect(kinds).toEqual([
      'placement:/entities/0', 'placement:/entities/1', 'placement:/entities/2', 'placement:/entities/3', 'child:/children/0',
      'placement:/entities/4@0', 'placement:/entities/4@1',
    ]);
    expect(sources.has(ed.session.cameraEntity!)).toBe(false);
    expect(ed.session.sources.problems).toEqual([]);
  });
});

describe('scenes', () => {
  it('openScene edits another scene, viewed from its own camera', async () => {
    const ed = await editor3d({ ...DATA_3D, 'scenes/other/scene.json': { entities: [
      { prefab: 'camera', at: [2, 3, -6] }, { prefab: 'crate', id: 'lonely', at: [2, 0, 0] },
    ] } });
    ed.session.select([placed(ed, 'a')]);
    ed.session.openScene('other');
    ed.frame();
    expect(ed.session.scene).toBe('other');
    expect(ed.session.selection).toEqual([]);
    expect(ed.surface3d.last!.views[0]!.camera).toBe(ed.session.cameraEntity);
    expect(ed.surface3d.last!.views[0]!.position).toEqual([2, 3, -6]);
    expect([...ed.session.sources.sources.values()].map((s) => s.path)).toEqual(['scenes/other/scene.json', 'scenes/other/scene.json']);
    expect(code(() => ed.session.openScene('missing'))).toBe('PP2045');
    expect(ed.session.scene).toBe('other');
  });
});

describe('picking', () => {
  it('finds the entity drawn under a screen point, and the root placement of a child', async () => {
    const ed = await editor3d();
    const view = ed.session.view()!;
    const at = view.project(new Vec3(0, 0, 0))!;
    expect(ed.session.pickAt(at.x, at.y)).toBe(placed(ed, 'a'));
    const top = view.project(new Vec3(-3, 2, 0))!;
    const tower = placed(ed, 'tower');
    expect(ed.session.pickAt(top.x, top.y)).toBe(tower);
    const child = ed.session.runtime.kernel.world.get(tower)!.children[0]!;
    expect(ed.session.pickAt(top.x, top.y, { deep: true })).toBe(child);
    // Empty sky above the scene.
    expect(ed.session.pickAt(400, 5)).toBeNull();
  });

  it('marquee-selects by drawn boxes', async () => {
    const ed = await editor3d();
    const view = ed.session.view()!;
    const a = view.project(new Vec3(0, 0, 0))!;
    const b = view.project(new Vec3(3, 0, 0))!;
    const picked = ed.session.pickIn({ x: Math.min(a.x, b.x) - 2, y: a.y - 2, width: Math.abs(b.x - a.x) + 4, height: 4 });
    expect(new Set(picked)).toEqual(new Set([placed(ed, 'a'), ed.session.sources.byKey.get('scenes/main/scene.json#/entities/2')!]));
  });

  it('outlines the selection (3D) and restores an entity\'s own outline after', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    ed.session.select([a]);
    ed.frame();
    expect(ed.surface3d.last!.outlines.map((o) => o.entity)).toEqual([a]);
    ed.session.select([]);
    ed.frame();
    expect(ed.surface3d.last!.outlines).toEqual([]);
    expect(ed.session.runtime.kernel.world.get(a)!.components.has('outline')).toBe(false);
  });
});

describe('gizmo drags write back', () => {
  it('moves a placement along x with snapping: live while dragging, the document on release, one undo step', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    ed.session.select([a]);
    const view = ed.session.view()!;
    const from = view.project(new Vec3(0, 0, 0))!;
    const to = view.project(new Vec3(2.3, 0, 0))!;
    ed.session.beginDrag('translate', 'x', 'world', from.x, from.y);
    ed.session.dragTo((from.x + to.x) / 2, (from.y + to.y) / 2, { translate: 0.5 });
    ed.session.dragTo(to.x, to.y, { translate: 0.5 });
    expect(ed.session.runtime.kernel.world.get(a)!.transform.position.x).toBeCloseTo(2.5, 6);
    // Nothing written yet.
    expect(sceneJson(ed).entities[1]!['at']).toEqual([0, 0, 0]);
    const edit = ed.session.endDrag()!;
    expect(edit.label).toBe('Move');
    expect(sceneJson(ed).entities[1]!['at']).toEqual([2.5, 0, 0]);
    expect(ed.session.documents.dirty()).toEqual(['scenes/main/scene.json']);
    ed.session.undo();
    expect(sceneJson(ed).entities[1]!['at']).toEqual([0, 0, 0]);
    expect(ed.session.runtime.kernel.world.get(ed.session.selection[0]!)!.transform.position.x).toBe(0);
    ed.session.redo();
    expect(ed.session.runtime.kernel.world.get(ed.session.selection[0]!)!.transform.position.x).toBe(2.5);
  });

  it('rotates about y and writes euler degrees; cancel puts it back', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    ed.session.select([a]);
    const view = ed.session.view()!;
    // Points on the ground ring around the crate, a quarter turn apart.
    const p0 = view.project(new Vec3(1, 0, 0))!;
    const p1 = view.project(new Vec3(0, 0, -1))!;
    ed.session.beginDrag('rotate', 'y', 'world', p0.x, p0.y);
    ed.session.dragTo(p1.x, p1.y, { rotate: 15 });
    const yaw = ed.session.runtime.kernel.world.get(a)!.transform.rotation.to_euler().y;
    expect(Math.abs(yaw)).toBeCloseTo(90, 4);
    ed.session.cancelDrag();
    expect(ed.session.runtime.kernel.world.get(a)!.transform.rotation.is_close(Quat.IDENTITY)).toBe(true);
    ed.session.beginDrag('rotate', 'y', 'world', p0.x, p0.y);
    ed.session.dragTo(p1.x, p1.y, { rotate: 15 });
    ed.session.endDrag();
    const rotation = sceneJson(ed).entities[1]!['rotation'] as number[];
    expect(Math.abs(rotation[1]!)).toBeCloseTo(90, 4);
  });

  it('refuses a grid cell (PP9626) and an entity outside the documents (PP9629)', async () => {
    const ed = await editor3d();
    const cell = ed.session.sources.byKey.get('scenes/main/scene.json#/entities/4@1')!;
    const pose = ed.session.poseOf(cell);
    expect(code(() => ed.session.setPoses(new Map([[cell, { ...pose, position: new Vec3(9, 9, 9) }]])))).toBe('PP9626');
    const spawned = ed.session.runtime.kernel.spawn('crate').id;
    expect(code(() => ed.session.setPoses(new Map([[spawned, pose]])))).toBe('PP9629');
  });

  it('a model entity turns the same way as a shape under the same ring drag, from above and edge-on', async () => {
    const model = { format: 'parallax.model', version: 1, materials: { m: { color: [1, 1, 1] } },
      parts: [{ name: 'post', position: [0, 1, 0], shape: 'box', size: [0.4, 2, 0.4], material: 'm' }] };
    const turns: number[] = [];
    for (const components of [{ shape: { kind: 'box' } }, { model: { model: 'models/post' } }]) {
      const ed = await editor3d({ ...DATA_3D, 'assets/models/post.model.json': model, 'prefabs/thing.prefab.json': { components },
        'scenes/main/scene.json': { entities: [
          { prefab: 'camera', at: [0, 5, -10], rotation: [26.56505, 0, 0] },
          { prefab: 'thing', id: 't', at: [0, 0, 0], rotation: [0, 40, 0] },
        ] } });
      const t = placed(ed, 't');
      ed.session.select([t]);
      // From above, then with the y ring seen nearly and exactly edge-on (the eye in its plane).
      for (const eye of [new Vec3(2, 5, -10), new Vec3(2, 0.1, -10), new Vec3(2, 0, -10)]) {
        ed.session.setCamera({ position: eye, rotation: Quat.look_rotation(eye.__mul__(-1)) });
        ed.frame();
        const view = ed.session.view()!;
        const length = view.pixelSize(Vec3.ZERO) * 100;
        // The ring's side facing the camera, grabbed 3 px above its line (within the hit
        // tolerance) and dragged 30 px right: that side moves right.
        const front = new Vec3(eye.x, 0, eye.z).normalized().__mul__(length);
        const p = view.project(front)!;
        ed.session.beginDrag('rotate', 'y', 'world', p.x, p.y - 3);
        const pose = ed.session.dragTo(p.x + 30, p.y - 3);
        ed.session.cancelDrag();
        const turned = pose.rotation.__mul__(Quat.from_euler(new Vec3(0, 40, 0)).inverse());
        expect(view.project(turned.rotate(front))!.x).toBeGreaterThan(p.x);
        turns.push(pose.rotation.to_euler().y - 40);
      }
    }
    // Shape and model: the same turns.
    expect(turns.slice(3)).toEqual(turns.slice(0, 3).map((t) => expect.closeTo(t, 6)));
    for (const turn of turns) expect(Math.abs(turn)).toBeGreaterThan(1);
  });

  it('moving a prefab child edits the prefab, so every instance follows', async () => {
    const data = { ...DATA_3D, 'scenes/main/scene.json': { entities: [
      { prefab: 'camera', at: [0, 5, -10], rotation: [26.56505, 0, 0] },
      { prefab: 'tower', id: 't1', at: [-3, 0, 0] },
      { prefab: 'tower', id: 't2', at: [3, 0, 0] },
    ] } };
    const ed = await editor3d(data);
    const t1 = placed(ed, 't1');
    const child = ed.session.runtime.kernel.world.get(t1)!.children[0]!;
    const pose = ed.session.poseOf(child);
    ed.session.setPoses(new Map([[child, { ...pose, position: pose.position.__add__(new Vec3(0, 1, 0)) }]]));
    const prefab = ed.session.documents.json('prefabs/tower.prefab.json') as { children: { at: number[] }[] };
    expect(prefab.children[0]!.at).toEqual([0, 3, 0]);
    const t2 = placed(ed, 't2');
    const other = ed.session.runtime.kernel.world.get(ed.session.runtime.kernel.world.get(t2)!.children[0]!)!;
    expect(other.transform.position.y).toBe(3);
  });
});

describe('field and param write-back', () => {
  it('instance override on the placement; prefab edit on the prefab; revert drops the override', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    ed.session.setField(a, 'shape', 'color', [0, 1, 0, 1]);
    expect(sceneJson(ed).entities[1]!['components']).toEqual({ shape: { color: [0, 1, 0, 1] } });
    const crate = ed.session.runtime.kernel.world.get(ed.session.sources.byKey.get('scenes/main/scene.json#/entities/1')!)!;
    expect((crate.components.get('shape')!['color'] as { g: number }).g).toBe(1);

    const other = ed.session.sources.byKey.get('scenes/main/scene.json#/entities/2')!;
    ed.session.setField(other, 'shape', 'kind', 'sphere', 'prefab');
    const prefab = ed.session.documents.json('prefabs/crate.prefab.json') as { components: { shape: Record<string, unknown> } };
    expect(prefab.components.shape['kind']).toBe('sphere');
    const kinds = [...ed.session.runtime.kernel.world.live()].filter((r) => r.prefab === 'crate').map((r) => r.components.get('shape')!['kind']);
    expect(kinds).toEqual(['sphere', 'sphere', 'sphere', 'sphere']);

    ed.session.revertField(ed.session.sources.byKey.get('scenes/main/scene.json#/entities/1')!, 'shape', 'color');
    expect(sceneJson(ed).entities[1]!['components']).toEqual({ shape: {} });
  });

  it('checks values against the schema before writing (PP4104, decode errors)', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    expect(code(() => ed.session.setField(a, 'shape', 'colour', [1, 1, 1, 1]))).toBe('PP4104');
    expect(code(() => ed.session.setField(a, 'shape', 'kind', 'banana'))).toMatch(/^PP4/);
    expect(ed.session.documents.dirty()).toEqual([]);
  });

  it('behavior params: instance override and prefab edit', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    ed.session.setParam(a, 'spinner', 'speed', 4);
    expect(sceneJson(ed).entities[1]!['params']).toEqual({ spinner: { speed: 4 } });
    ed.session.setParam(ed.session.selection[0] ?? placed(ed, 'a'), 'spinner', 'speed', 2, 'prefab');
    const prefab = ed.session.documents.json('prefabs/crate.prefab.json') as { behaviors: Record<string, Record<string, unknown>> };
    expect(prefab.behaviors['spinner']).toEqual({ speed: 2 });
    const live = ed.session.runtime.kernel.world.get(placed(ed, 'a'))!;
    expect((live.behaviors[0]!.instance as { speed: number }).speed).toBe(4);
  });

  it('adds and removes placements, keeping the selection on what remains', async () => {
    const ed = await editor3d();
    const added = ed.session.addEntity({ prefab: 'crate', at: [0, 0, 6] });
    expect(ed.session.sourceOf(added)!.pointer).toBe('/entities/5');
    expect(sceneJson(ed).entities).toHaveLength(6);
    ed.session.select([placed(ed, 'tower')]);
    ed.session.removeEntities([placed(ed, 'a'), added]);
    expect(sceneJson(ed).entities).toHaveLength(4);
    expect(ed.session.selection).toEqual([placed(ed, 'tower')]);
    ed.session.undo();
    expect(sceneJson(ed).entities).toHaveLength(6);
  });
});

describe('files changed outside', () => {
  it('rebuilds the edit world from them, keeps the selection, clears undo', async () => {
    const ed = await editor3d();
    ed.session.select([placed(ed, 'tower')]);
    ed.session.addEntity({ prefab: 'crate', at: [0, 0, 6] });
    expect(ed.session.history.canUndo).toBe(true);
    const scene = sceneJson(ed);
    const outside = { ...scene, entities: [...scene.entities.slice(0, 4), { prefab: 'crate', id: 'b', at: [9, 0, 0] }] };
    const errors = ed.session.replaceFiles(new Map([['scenes/main/scene.json', JSON.stringify(outside)]]));
    expect(errors).toEqual([]);
    expect(sceneJson(ed).entities.map((e) => e['id'] ?? null)).toEqual(['camera', 'a', null, 'tower', 'b']);
    expect(ed.session.runtime.kernel.world.get(placed(ed, 'b'))!.transform.position.x).toBe(9);
    expect(ed.session.selection).toEqual([placed(ed, 'tower')]);
    expect(ed.session.history.canUndo).toBe(false);
    expect(ed.session.documents.dirty()).toEqual([]);
  });

  it('a broken file is reported; the next good change brings the world back', async () => {
    const ed = await editor3d();
    const good = ed.session.documents.read('prefabs/crate.prefab.json');
    expect(code(() => ed.session.replaceFiles(new Map([['prefabs/crate.prefab.json', '{ "components": { "shape": { "kind": 42 } } }']])))).toBe('PP4102');
    expect(ed.session.replaceFiles(new Map([['prefabs/crate.prefab.json', good]]))).toEqual([]);
    expect(ed.session.runtime.kernel.world.get(placed(ed, 'a'))).toBeDefined();
  });
});

describe('play and stop in place', () => {
  it('play starts the edited scene fresh with logic on; stop restores the edit world exactly', async () => {
    const ed = await editor3d();
    const a = placed(ed, 'a');
    ed.session.select([a]);
    const pose = ed.session.poseOf(a);
    ed.session.setPoses(new Map([[a, { ...pose, position: new Vec3(1, 0, 0) }]]));
    const editIds = [...ed.session.runtime.kernel.world.live()].map((r) => r.id);
    ed.session.play();
    expect(ed.session.mode).toBe('playing');
    expect(LOG).toEqual(['director', 'start v1', 'start v1', 'start v1', 'start v1']);
    ed.frames(30);
    const playing = ed.session.runtime.kernel.world.get(placed(ed, 'a'))!;
    expect(playing.transform.position.x).toBe(1);
    expect((playing.behaviors[0]!.instance as { ticks: number }).ticks).toBe(30);
    // The game's own camera draws while playing.
    expect(ed.surface3d.last!.views[0]!.camera).toBe(placed(ed, 'camera'));
    expect(code(() => ed.session.setField(placed(ed, 'a'), 'shape', 'kind', 'sphere'))).toBe('PP9631');

    expect(ed.session.stop()).toEqual([]);
    expect(ed.session.mode).toBe('edit');
    expect([...ed.session.runtime.kernel.world.live()].map((r) => r.id)).toEqual(editIds);
    expect(ed.session.selection).toEqual([a]);
    ed.frame();
    expect(ed.surface3d.last!.views[0]!.camera).toBe(ed.session.cameraEntity);
    expect(ed.surface3d.last!.outlines.map((o) => o.entity)).toEqual([a]);
    expect((ed.session.runtime.kernel.world.get(a)!.behaviors[0]!.instance as { ticks: number }).ticks).toBe(0);
  });

  it('play can start another scene (the start scene); stop comes back to the edited one', async () => {
    const ed = await editor3d({ ...DATA_3D, 'scenes/other/scene.json': { entities: [
      { prefab: 'camera', at: [2, 3, -6] }, { prefab: 'crate', id: 'lonely', at: [2, 0, 0] },
    ] } });
    ed.session.openScene('other');
    expect(ed.session.startScene).toBe('main');
    ed.session.play({ scene: ed.session.startScene });
    expect(ed.session.runtime.kernel.scene!.id).toBe('main');
    expect(ed.session.playScene).toBe('main');
    expect(ed.session.scene).toBe('other');
    ed.frames(5);
    expect(ed.session.stop()).toEqual([]);
    expect(ed.session.runtime.kernel.scene!.id).toBe('other');
    expect(ed.session.playScene).toBe('other');
    expect([...ed.session.sources.sources.values()].map((s) => s.path)).toEqual(['scenes/other/scene.json', 'scenes/other/scene.json']);
    expect(code(() => ed.session.play({ scene: 'missing' }))).toBe('PP2045');
    expect(ed.session.mode).toBe('edit');
  });

  it('dragging is true between beginDrag and endDrag', async () => {
    const ed = await editor3d();
    ed.session.select([placed(ed, 'a')]);
    expect(ed.session.dragging).toBe(false);
    ed.session.beginDrag('translate', 'x', 'world', 400, 300);
    expect(ed.session.dragging).toBe(true);
    ed.session.cancelDrag();
    expect(ed.session.dragging).toBe(false);
  });

  it('pause holds the game still; step runs single frames; time scale slows it', async () => {
    const ed = await editor3d();
    ed.session.play();
    ed.frames(2);
    const ticks = (): number => (ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.behaviors[0]!.instance as { ticks: number }).ticks;
    expect(ticks()).toBe(2);
    ed.session.pause();
    ed.frames(10);
    expect(ticks()).toBe(2);
    const now = ed.session.runtime.kernel.time.now;
    ed.session.step(3);
    expect(ticks()).toBe(5);
    expect(ed.session.runtime.kernel.time.now).toBeCloseTo(now + 3 / 60, 9);
    ed.session.resume();
    ed.session.setTimeScale(0.5);
    const before = ed.session.runtime.kernel.time.now;
    ed.frames(4);
    expect(ed.session.runtime.kernel.time.now - before).toBeCloseTo(2 / 60, 9);
    expect(code(() => ed.session.setTimeScale(-1))).toBe('PP9637');
  });
});

describe('hot reload', () => {
  it('edit mode: new code, same documents, selection and camera pose', async () => {
    const ed = await editor3d();
    ed.session.select([placed(ed, 'tower')]);
    ed.session.setCamera({ position: new Vec3(1, 8, -12) });
    const old = ed.session.runtime;
    codeVersion = 2;
    const result = await ed.session.reload();
    expect(result).toEqual({ restored: true, diagnostics: [] });
    expect(ed.session.runtime).not.toBe(old);
    expect(ed.session.runtime.kernel.logic).toBe(false);
    expect(ed.session.selection).toEqual([placed(ed, 'tower')]);
    ed.frame();
    expect(ed.surface3d.last!.views[0]!.position).toEqual([1, 8, -12]);
    expect(() => old.step(1 / 60)).toThrow(/PP9007/);
    // The new code runs when played.
    ed.session.play();
    ed.frame();
    expect((ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.behaviors[0]!.instance as { ticks: number }).ticks).toBe(100);
  });

  it('playing: the running game moves into the new code with its state', async () => {
    const ed = await editor3d();
    ed.session.play();
    ed.frames(5);
    codeVersion = 2;
    const result = await ed.session.reload();
    expect(result.restored).toBe(true);
    expect(ed.session.mode).toBe('playing');
    const ticks = (): number => (ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.behaviors[0]!.instance as { ticks: number }).ticks;
    expect(ticks()).toBe(5);
    ed.frame();
    expect(ticks()).toBe(105);
    // start() ran only for the first play: the restored behaviors had started.
    expect(LOG.filter((l) => l.startsWith('start v2'))).toEqual([]);
    expect(ed.session.stop()).toEqual([]);
    expect(ed.session.mode).toBe('edit');
  });
});

describe('2D', () => {
  it('picks the topmost draw, drags in the plane and writes [x, y] plus a 2D angle', async () => {
    const ed = await openHeadlessEditor({ entry: declare2d, files: files(DATA_2D), mode: '2d', size: { width: 800, height: 600 } });
    ed.frame();
    const view = ed.session.view()!;
    const at = view.project(new Vec3(2, 1, 0))!;
    const coin = placed(ed, 'coin');
    expect(ed.session.pickAt(at.x, at.y)).toBe(coin);
    const edge = view.project(new Vec3(2.8, 1, 0))!;
    expect(ed.session.pickAt(edge.x, edge.y)).toBe(placed(ed, 'block'));
    ed.session.select([coin]);
    const to = view.project(new Vec3(4, 3, 0))!;
    ed.session.beginDrag('translate', 'xy', 'world', at.x, at.y);
    ed.session.dragTo(to.x, to.y);
    ed.session.endDrag();
    const scene = ed.session.documents.json('scenes/main/scene.json') as { entities: Record<string, unknown>[] };
    expect(scene.entities[2]!['at']).toEqual([4, 3]);
    expect(scene.entities[2]!['z']).toBeUndefined();
    const block = placed(ed, 'block');
    ed.session.select([block]);
    const pose = ed.session.poseOf(block);
    ed.session.setPoses(new Map([[block, { ...pose, rotation: Quat.from_angle(45) }]]));
    expect(scene.entities[1]!['rotation']).toBeUndefined();
    expect((ed.session.documents.json('scenes/main/scene.json') as { entities: Record<string, unknown>[] }).entities[1]!['rotation']).toBe(45);
  });
});
