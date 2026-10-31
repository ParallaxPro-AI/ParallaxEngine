/** `ctx.world.layer(ref)` as compiled game code sees it, through `createRuntime`. */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { STORY_SERVICE } from '../function/services/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { createRuntime, Game, kw, resetDeclarations, SceneRef, WorldLayerRef } from './index.js';
import type { GameRuntime } from './index.js';
import { WorldLayer, worldLayer } from './streaming.js';

/** Stands in for story(): no quest is active. */
const quests: KernelPlugin = {
  id: 'quests', install: (k) => k.provide(STORY_SERVICE, {
    questStatus: () => 'inactive', fact: () => false, markers: () => [], players: () => [],
  }),
};

const PROJECT: Record<string, unknown> = {
  'prefabs/eye.prefab.json': { components: { camera: {} } },
  'prefabs/lamp.prefab.json': { components: {} },
  'scenes/town/scene.json': { entities: [] },
  'scenes/town/world.json': { cell_size: 64, streaming: { radius: 100 }, layers: { base: {}, festival: {}, raid: { active_when: { quest_active: 'raid' } } } },
  'scenes/town/regions/square/region.json': {},
  'scenes/town/regions/square/entities/eye.json': { prefab: 'eye', at: [0, 5, 0], always_loaded: true },
  'scenes/town/regions/square/entities/lantern.json': { prefab: 'lamp', at: [4, 0, 4], layer: 'festival' },
  'scenes/town/regions/square/entities/far_lamp.json': { prefab: 'lamp', at: [900, 0, 900] },
  'scenes/menu/scene.json': { entities: [] },
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

/** Files every entity of a batch the way renderers and physics do (`world.require`). */
const filed: string[] = [];
const filer: KernelPlugin = {
  id: 'filer',
  install: (k) => k.observeEntities({
    added: (batch) => { for (const r of batch) filed.push(k.world.require(r.id).placedId ?? '?'); },
  }),
};

function start(scene: string): GameRuntime {
  const game = new Game(kw({
    id: 'town', title: 'Town', sdk: '1.0', mode: '3d', start_scene: new SceneRef(scene), plugins: [quests, filer],
  }));
  const project = loadProject(files(PROJECT));
  expect(project.diagnostics).toEqual([]);
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: files(PROJECT),
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  runtime.start();
  return runtime;
}

const loaded = (runtime: GameRuntime, id: string): boolean => [...runtime.kernel.world.live()].some((r) => r.placedId === id);

beforeEach(() => resetDeclarations());

describe('core streaming', () => {
  it('unloads out-of-range placements after the game\'s plugins filed them', () => {
    filed.length = 0;
    const runtime = start('town');
    expect(filed).toContain('far_lamp');
    expect(loaded(runtime, 'far_lamp')).toBe(false);
  });
});

describe('ctx.world.layer', () => {
  it('reads and switches a layer', () => {
    const runtime = start('town');
    const festival = runtime.ctx.world.layer(new WorldLayerRef('festival'));
    expect(festival).toBeInstanceOf(WorldLayer);
    expect(festival.state).toBe('active');
    expect(loaded(runtime, 'lantern')).toBe(true);
    festival.deactivate();
    expect([festival.state, loaded(runtime, 'lantern')]).toEqual(['loaded', false]);
    festival.activate();
    expect(loaded(runtime, 'lantern')).toBe(true);
    festival.unload();
    expect(festival.state).toBe('unloaded');
  });

  it('refuses unknown layers, declarative ones, and scenes without a world', () => {
    const runtime = start('town');
    expect(code(() => worldLayer(runtime.kernel, new WorldLayerRef('festivl')))).toBe('PP3630');
    expect(code(() => runtime.ctx.world.layer('festival'))).toBe('PP3630');
    expect(code(() => worldLayer(runtime.kernel, new WorldLayerRef('raid')).activate())).toBe('PP3631');
    const menu = start('menu');
    expect(code(() => worldLayer(menu.kernel, new WorldLayerRef('festival')))).toBe('PP3637');
  });
});
