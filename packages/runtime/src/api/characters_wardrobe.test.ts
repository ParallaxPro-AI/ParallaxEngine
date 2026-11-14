/**
 * `from parallax.characters import Wardrobe, Garment` the way a game uses them: the SDK
 * declares both, so compiled code that imports them must find handles in the module
 * (a missing export is PP9501 at boot), and `entity.get(Wardrobe)` reads and dresses.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import * as charactersModule from './characters.js';
import { characters, Garment, Wardrobe } from './characters.js';
import { createRuntime, EntityRef, Game, kw, PrefabRef, resetDeclarations, SceneRef } from './index.js';
import type { Entity } from './index.js';
import { dict_of } from './pyrt/collections.js';

const STEP = 1 / 60;

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

describe('parallax.characters wardrobe handles', () => {
  it('are exported next to Character and Seat', () => {
    expect(Object.keys(charactersModule)).toEqual(expect.arrayContaining(['Character', 'Seat', 'Garment', 'Wardrobe']));
  });

  it('read an outfit and swap a slot with wear() / take_off()', () => {
    const projectFiles = files({
      'prefabs/body.prefab.json': { components: { model: { model: 'models/body' }, wardrobe: { outfit: { torso: 'coat' } } } },
      'prefabs/coat.prefab.json': { components: { model: { model: 'models/coat' }, garment: { slot: 'torso', hides: ['skin'] } } },
      'prefabs/hat.prefab.json': { components: { model: { model: 'models/hat' }, garment: { slot: 'head' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'body', id: 'body' }] },
    });
    const project = loadProject(projectFiles);
    expect(project.diagnostics).toEqual([]);
    const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', plugins: [characters()] }));
    const r = createRuntime(game, project, {
      seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
      surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
    });
    r.start();
    r.step(STEP);
    const body = r.ctx.world.placed(new EntityRef('body'));
    const wardrobe = body.get(Wardrobe) as unknown as {
      outfit: Map<string, unknown>; hidden: string[]; wear(prefab: unknown): Entity; take_off(slot: string): boolean;
    };
    const slots = (): string[] => body.children.map((c) => (c.get(Garment) as unknown as { slot: string }).slot).sort();
    expect(slots()).toEqual(['torso']);
    expect([...wardrobe.hidden]).toEqual(['skin']);
    const hat = wardrobe.wear(new PrefabRef('hat'));
    r.step(STEP);
    expect((hat.get(Garment) as unknown as { slot: string }).slot).toBe('head');
    expect(slots()).toEqual(['head', 'torso']);
    expect(wardrobe.take_off('torso')).toBe(true);
    r.step(STEP);
    expect(slots()).toEqual(['head']);
    expect([...wardrobe.hidden]).toEqual([]);
    // `w.outfit = {"torso": Prefabs.coat}`: a game-side dict of prefab refs dresses at once.
    (wardrobe as unknown as { outfit: unknown }).outfit = dict_of(['torso', new PrefabRef('coat')]);
    r.step(STEP);
    expect(slots()).toEqual(['torso']);
    expect([...wardrobe.hidden]).toEqual(['skin']);
    expect(wardrobe.take_off('torso')).toBe(true);
    (wardrobe as unknown as { outfit: unknown }).outfit = dict_of([]);
    r.step(STEP);
    expect(slots()).toEqual([]);
  });
});
