/**
 * The inspector's structure edits end to end on the headless platform: adding and removing
 * components (instance and prefab, refused where the document can't express it, rolled back
 * when the game can't load the result), reset/paste of a component's values, multi-entity
 * field edits as one undo step, renaming, the scene's environment block, and live tweaks of
 * the running game that Stop throws away.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Behavior, behavior, kw, param, resetDeclarations, rt } from '@parallax/runtime/api';
import type { EntityId } from '@parallax/runtime/core';
import { t } from '@parallax/runtime/kernel';
import { defaultFields, placeholderJson, requiredFields } from './component_ops.js';
import { openHeadlessEditor } from './headless.js';
import type { HeadlessEditor } from './headless.js';
import { DATA_3D, declare3d, files, LOG } from './test_fixtures.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code ?? String(e); }
  return undefined;
}

/** declare3d's game plus a "glow" behavior that requires a shape, on a "lamp" prefab. */
function declareLamp(): Readonly<Record<string, unknown>> {
  const exports = declare3d();
  class Glow extends Behavior {
    static __annotations__ = { power: () => rt.float };
    static power = param(1);
    declare power: number;
  }
  const ShapeKind = Object.assign(function Shape() {}, { __component_id__: 'shape' });
  behavior('glow', kw({ requires: [ShapeKind] }))(Glow);
  return exports;
}

const DATA: Record<string, unknown> = {
  ...DATA_3D,
  'prefabs/lamp.prefab.json': { components: { shape: { kind: 'sphere' } }, behaviors: { glow: {} } },
  'scenes/main/scene.json': {
    entities: [...(DATA_3D['scenes/main/scene.json'] as { entities: unknown[] }).entities, { prefab: 'lamp', id: 'lamp', at: [0, 3, 0] }],
  },
};

async function open(): Promise<HeadlessEditor> {
  const ed = await openHeadlessEditor({ entry: () => declareLamp(), files: files(DATA), mode: '3d', size: { width: 800, height: 600 } });
  ed.frame();
  return ed;
}

const placed = (ed: HeadlessEditor, id: string): EntityId => [...ed.session.runtime.kernel.world.live()].find((r) => r.placedId === id)!.id;
const json = (ed: HeadlessEditor, path: string): Record<string, unknown> => ed.session.documents.json(path) as Record<string, unknown>;
const entities = (ed: HeadlessEditor): Record<string, unknown>[] => (json(ed, 'scenes/main/scene.json') as { entities: Record<string, unknown>[] }).entities;

beforeEach(() => { LOG.length = 0; resetDeclarations(); });

describe('placeholders and defaults', () => {
  it('gives required fields a neutral start and leaves references to the caller', () => {
    expect(placeholderJson({ kind: 'enum', values: ['b', 'c'] })).toBe('b');
    expect(placeholderJson({ kind: 'vec3' })).toEqual([0, 0, 0]);
    expect(placeholderJson({ kind: 'ref', to: 'asset/models' })).toBeUndefined();
    expect(requiredFields({ a: t.number(), b: t.number({ default: 2 }), c: t.ref('prefab') })).toEqual({ values: { a: 0 }, missing: ['c'] });
    expect(defaultFields({ a: t.number({ default: 2 }), b: t.string() }, 'x')).toEqual({ a: 2 });
  });
});

describe('add and remove components', () => {
  it('adds a component to one placement and undoes it', async () => {
    const ed = await open();
    const a = placed(ed, 'a');
    ed.session.addComponent([a], 'light', 'instance', { intensity: 3 });
    expect(entities(ed)[1]!['components']).toEqual({ light: { intensity: 3 } });
    const light = ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.components.get('light')!;
    expect(light['intensity']).toBe(3);
    // The other crate is untouched.
    expect(entities(ed)[2]!['components']).toBeUndefined();
    ed.session.undo();
    expect(entities(ed)[1]!['components']).toBeUndefined();
    expect(ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.components.has('light')).toBe(false);
  });

  it('adds to the prefab so every instance gets it, and to a whole selection in one step', async () => {
    const ed = await open();
    ed.session.addComponent([placed(ed, 'a')], 'light', 'prefab');
    expect((json(ed, 'prefabs/crate.prefab.json')['components'] as Record<string, unknown>)['light']).toEqual({});
    const crates = [...ed.session.runtime.kernel.world.live()].filter((r) => r.prefab === 'crate');
    expect(crates.every((r) => r.components.has('light'))).toBe(true);
    ed.session.undo();
    ed.session.addComponent([placed(ed, 'a'), placed(ed, 'tower')], 'light');
    expect(ed.session.history.entries.labels.at(-1)).toBe('Add light');
    expect(entities(ed)[3]!['components']).toEqual({ light: {} });
  });

  it('refuses a component with a required reference nobody gave', async () => {
    const ed = await open();
    expect(code(() => ed.session.addComponent([placed(ed, 'a')], 'model'))).toBe('PP9638');
    expect(ed.session.history.canUndo).toBe(false);
  });

  it('removes what the placement declares; a prefab\'s component only from the prefab', async () => {
    const ed = await open();
    const a = placed(ed, 'a');
    expect(code(() => ed.session.removeComponent([a], 'shape'))).toBe('PP9638');
    ed.session.addComponent([a], 'light');
    ed.session.removeComponent([placed(ed, 'a')], 'light');
    expect(entities(ed)[1]!['components']).toEqual({});
    ed.session.removeComponent([placed(ed, 'a')], 'shape', 'prefab');
    expect((json(ed, 'prefabs/crate.prefab.json')['components'] as Record<string, unknown>)['shape']).toBeUndefined();
    expect([...ed.session.runtime.kernel.world.live()].filter((r) => r.prefab === 'crate').some((r) => r.components.has('shape'))).toBe(false);
  });

  it('takes back a removal the game can\'t load (a behavior requires the component)', async () => {
    const ed = await open();
    const labels = ed.session.history.entries.labels.length;
    expect(code(() => ed.session.removeComponent([placed(ed, 'lamp')], 'shape', 'prefab'))).toBe('PP3103');
    expect((json(ed, 'prefabs/lamp.prefab.json')['components'] as Record<string, unknown>)['shape']).toEqual({ kind: 'sphere' });
    expect(ed.session.history.entries.labels.length).toBe(labels);
    expect(ed.session.history.canRedo).toBe(false);
    expect(ed.session.runtime.kernel.world.get(placed(ed, 'lamp'))!.components.has('shape')).toBe(true);
  });
});

describe('component values and multi-entity edits', () => {
  it('pastes several fields as one step and resets to the defaults', async () => {
    const ed = await open();
    ed.session.setComponentValues([placed(ed, 'a')], 'shape', { kind: 'sphere', roughness: 0.2 }, 'instance', 'Paste shape');
    expect(entities(ed)[1]!['components']).toEqual({ shape: { kind: 'sphere', roughness: 0.2 } });
    ed.session.undo();
    expect(entities(ed)[1]!['components']).toBeUndefined();
    ed.session.setComponentValues([placed(ed, 'a')], 'shape', defaultFields(ed.session.runtime.kernel.registry.components.get('shape')!.schema, 'shape'), 'instance', 'Reset shape');
    const shape = ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.components.get('shape')!;
    expect(shape['kind']).toBe('box');
    expect((shape['color'] as { r: number }).r).toBe(1);
  });

  it('sets one field on every selected entity as one undo step', async () => {
    const ed = await open();
    ed.session.setFields([placed(ed, 'a'), placed(ed, 'tower')], 'shape', 'roughness', 0.3);
    expect(entities(ed)[1]!['components']).toEqual({ shape: { roughness: 0.3 } });
    expect(entities(ed)[3]!['components']).toEqual({ shape: { roughness: 0.3 } });
    ed.session.undo();
    expect(entities(ed)[1]!['components']).toBeUndefined();
    expect(entities(ed)[3]!['components']).toBeUndefined();
    ed.session.setParams([placed(ed, 'a')], 'spinner', 'speed', 4);
    expect(entities(ed)[1]!['params']).toEqual({ spinner: { speed: 4 } });
  });
});

describe('rename', () => {
  it('renames a placement\'s id and a child\'s name, keeping the selection', async () => {
    const ed = await open();
    ed.session.select([placed(ed, 'a')]);
    ed.session.rename(placed(ed, 'a'), 'first_crate');
    expect(entities(ed)[1]!['id']).toBe('first_crate');
    expect(ed.session.runtime.kernel.world.get(ed.session.selection[0]!)!.placedId).toBe('first_crate');
    expect(code(() => ed.session.rename(placed(ed, 'first_crate'), 'tower'))).toBe('PP9640');
    expect(code(() => ed.session.rename(placed(ed, 'first_crate'), '1 crate'))).toBe('PP9640');
    const top = ed.session.runtime.kernel.world.get(placed(ed, 'tower'))!.children[0]!;
    ed.session.rename(top, 'cap');
    expect((json(ed, 'prefabs/tower.prefab.json')['children'] as Record<string, unknown>[])[0]!['name']).toBe('cap');
    ed.session.rename(placed(ed, 'first_crate'), '');
    expect('id' in entities(ed)[1]!).toBe(false);
  });
});

describe('scene environment', () => {
  it('sets and removes keys of the scene\'s environment block, undoably', async () => {
    const ed = await open();
    expect(ed.session.environment()).toEqual({});
    ed.session.setEnvironment(['time_of_day'], 18);
    ed.session.setEnvironment(['fog', 'density'], 0.02);
    expect(ed.session.environment()).toEqual({ time_of_day: 18, fog: { density: 0.02 } });
    ed.session.setEnvironment(['fog', 'density'], undefined);
    expect(ed.session.environment()).toEqual({ time_of_day: 18 });
    ed.session.undo();
    ed.session.undo();
    expect(ed.session.environment()).toEqual({ time_of_day: 18 });
  });
});

describe('live tweaks while playing', () => {
  it('changes the running game, refuses document edits, and Stop throws the tweaks away', async () => {
    const ed = await open();
    expect(code(() => ed.session.setLiveField([placed(ed, 'a')], 'shape', 'roughness', 0.1))).toBe('PP9639');
    ed.session.play();
    ed.frames(2);
    const a = placed(ed, 'a');
    expect(code(() => ed.session.setField(a, 'shape', 'roughness', 0.1))).toBe('PP9631');
    ed.session.setLiveField([a], 'shape', 'roughness', 0.1);
    ed.session.setLiveParam([a], 'spinner', 'speed', 9);
    const live = ed.session.runtime.kernel.world.get(a)!;
    expect(live.components.get('shape')!['roughness']).toBe(0.1);
    expect((live.behaviors[0]!.instance as unknown as { speed: number }).speed).toBe(9);
    ed.session.stop();
    expect(ed.session.documents.dirty()).toEqual([]);
    expect(ed.session.runtime.kernel.world.get(placed(ed, 'a'))!.components.get('shape')!['roughness']).toBe(0.8);
  });
});
