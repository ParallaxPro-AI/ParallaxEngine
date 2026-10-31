/**
 * The runtime's wiring of the wave-4 services, through `createRuntime`: seats and
 * `ctx.players` from local_players (the `players` service), `Player.entity`, the input
 * engine's seats, the device store (`RuntimeOptions.store`, the core persistence plugin),
 * and the names the `parallax`, `parallax.plugins` and `parallax.values` modules export.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Cell3 as CoreCell3 } from '../core/index.js';
import type { KeyValueStore, ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { memoryStore, PROFILE_KEY } from '../function/plugins/save/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { ContentList, ContentRef } from './content.js';
import * as parallax from './index.js';
import { Actions, axis2, createRuntime, Game, keys, kw, PrefabRef, resetDeclarations, SceneRef, Settings } from './index.js';
import type { GameRuntime } from './index.js';
import * as plugins from './plugins.js';
import { local_players } from './local_players.js';
import { migration, registeredMigrations } from './save.js';
import { fact, story } from './story.js';
import { rt } from './types.js';
import * as values from './values.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const DATA = {
  'prefabs/chef.prefab.json': { components: {} },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'scenes/kitchen/scene.json': { entities: [
    { prefab: 'start', at: [6, 0, 0], components: { player_start: { seat: 1 } } },
    { prefab: 'start', at: [-6, 0, 0], components: { player_start: { seat: 0 } } },
  ] },
};

function start(gamePlugins: unknown[], store?: KeyValueStore): GameRuntime {
  const game = new Game(kw({
    id: 'kitchen', title: 'Kitchen', sdk: '1.0', mode: '3d', start_scene: new SceneRef('kitchen'), plugins: gamePlugins,
  }));
  const project = loadProject(files(DATA));
  expect(project.diagnostics).toEqual([]);
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: files(DATA),
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}), ...(store !== undefined && { store }),
  });
  runtime.start();
  return runtime;
}

function twoSeats(): unknown {
  class Controls extends Actions {
    static move = axis2(kw({ keyboard: keys.WASD }));
  }
  Controls.__init_subclass__();
  class P2Controls extends Controls {
    static override move = axis2(kw({ keyboard: keys.ARROWS }));
  }
  P2Controls.__init_subclass__();
  return local_players(kw({ seats: 2, player_prefab: new PrefabRef('chef'), controls: [Controls, P2Controls], split_screen: 'none' }));
}

beforeEach(() => resetDeclarations());

describe('players', () => {
  it('without a players plugin: one local player who controls no entity', () => {
    const runtime = start([]);
    const players = runtime.ctx.players;
    expect(players.map((p) => [p.id, p.index, p.local])).toEqual([['local', 0, true]]);
    expect(players[0]!.entity).toBeNull();
    expect(runtime.inputEngine.seats.length).toBe(1);
  });

  it('local_players: ctx.players, Player.entity and the input engine\'s seats come from the players service', () => {
    const runtime = start([twoSeats()]);
    const players = runtime.ctx.players;
    expect(players.map((p) => [p.index, p.local])).toEqual([[0, true], [1, true]]);
    // The same Player objects while the seats stay.
    expect(runtime.ctx.players[1]).toBe(players[1]);
    const entities = players.map((p) => p.entity);
    expect(entities.map((e) => e?.transform.position.x)).toEqual([-6, 6]);
    expect(runtime.inputEngine.seats.map((s) => [s.index, s.controls?.id])).toEqual([[0, 'Controls'], [1, 'P2Controls']]);
    // get(player=) accepts the seats.
    expect(() => runtime.ctx.get(Settings, kw({ player: players[1] }))).not.toThrow();
    runtime.kernel.destroy(runtime.unwrap(entities[1]!)!);
    runtime.step(1 / 60);
    expect(players[1]!.entity).toBeNull();
  });
});

describe('the device store', () => {
  it('keeps profile fields (Settings) in RuntimeOptions.store, read back by the next run', () => {
    const store = memoryStore();
    const first = start([], store);
    (first.ctx.get(Settings) as { music_volume: number }).music_volume = 0.25;
    first.step(1 / 60);
    expect(store.get(PROFILE_KEY)).toContain('0.25');
    const second = start([], store);
    expect((second.ctx.get(Settings) as { music_volume: number }).music_volume).toBe(0.25);
  });
});

describe('module exports', () => {
  it('exports the wave-4 names where the SDK lists them', () => {
    expect([plugins.save, plugins.local_players, plugins.voxels, plugins.story].every((f) => typeof f === 'function')).toBe(true);
    expect(values.Cell3).toBe(CoreCell3);
    expect(typeof parallax.migration).toBe('function');
    expect(typeof parallax.SaveData).toBe('function');
  });

  it('ContentRef[T] in an expression is the generic marker an annotation would be', () => {
    class Place {}
    expect((ContentRef as unknown as { __getitem__(t: unknown): unknown }).__getitem__(Place)).toEqual(rt.generic(ContentRef, Place));
    expect(ContentList).toBeDefined();
  });

  it('resetDeclarations forgets save migrations and story facts', () => {
    migration(kw({ from_version: 1, to_version: 2 }))(function step() { /* registered */ });
    fact('met', false);
    expect(registeredMigrations().length).toBe(1);
    resetDeclarations();
    expect(registeredMigrations()).toEqual([]);
    // A fresh realm may declare the fact again with another default.
    expect(() => fact('met', 3)).not.toThrow();
    expect(typeof story).toBe('function');
  });
});
