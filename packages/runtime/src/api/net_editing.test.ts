/**
 * A net game in an editor: booted with logic off (the edit world), Play loads the scene with
 * logic on, Stop restores the edit world. The local player of the default session (a host
 * with one seat, what editor Play runs) joins when the scene plays — a dedicated-server game
 * included — and not in the edit world; Stop puts them back to waiting for the next Play,
 * and a restore of a playing snapshot keeps their seat (a hot reload).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { attachNet, createRuntime, Game, kw, LOCAL_SESSION, on, prepareNet, PrefabRef, resetDeclarations, SceneRef, System, system } from './index.js';
import type { Context, GameRuntime } from './index.js';
import { net, PlayerJoined } from './net.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const DATA = files({
  'prefabs/camera.prefab.json': { components: { camera: {} } },
  'prefabs/hero.prefab.json': { components: {} },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'scenes/arena/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'start', at: [4, 0, 2] }] },
});

const joined: string[] = [];

function boot(): GameRuntime {
  class Lobby extends System {
    seat(_ctx: Context, event: { player: { name: string } }) { joined.push(event.player.name); }
  }
  on(PlayerJoined)(Lobby.prototype.seat);
  system('lobby')(Lobby);
  const game = new Game(kw({
    id: 'arena', title: 'Arena', sdk: '1.0', mode: '3d', start_scene: new SceneRef('arena'), systems: [Lobby],
    plugins: [net(kw({ max_players: 2, player_prefab: new PrefabRef('hero'), mode: 'dedicated' }))],
  }));
  prepareNet(game, LOCAL_SESSION);
  const runtime = createRuntime(game, loadProject(DATA), {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: DATA,
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  runtime.kernel.setLogic(false); // what startGame({ editing: true }) does
  runtime.start();
  attachNet(runtime);
  return runtime;
}

const heroes = (r: GameRuntime): number => [...r.kernel.world.live()].filter((e) => e.prefab === 'hero').length;

function play(r: GameRuntime): void {
  r.kernel.settle();
  r.kernel.setLogic(true);
  r.kernel.loadScene('arena', { seed: 1 });
  r.step(1 / 60);
}

beforeEach(() => { resetDeclarations(); joined.length = 0; });

describe('a net game in the editor', () => {
  it('seats the local player when Play loads the scene, not in the edit world', () => {
    const r = boot();
    r.step(1 / 60);
    expect(heroes(r)).toBe(0);
    // The seat is assigned (a host's local player exists from the start) but has no entity yet.
    expect(r.ctx.players.map((p) => p.entity)).toEqual([null]);
    expect(joined).toEqual([]);
    const edit = (r.kernel.settle(), r.kernel.snapshot());

    play(r);
    expect(joined).toEqual(['Player 1']);
    expect(heroes(r)).toBe(1);
    expect(r.ctx.players).toHaveLength(1);
    expect(r.ctx.players[0]!.entity?.transform.position.x).toBe(4);

    // Stop: the edit world again, and the next Play seats the player again.
    r.kernel.setLogic(false);
    r.kernel.restore(edit);
    expect(heroes(r)).toBe(0);
    expect(r.ctx.players.map((p) => p.entity)).toEqual([null]);
    play(r);
    expect(joined).toEqual(['Player 1', 'Player 1']);
    expect(heroes(r)).toBe(1);
  });

  it('keeps the seat when a playing snapshot is restored into a fresh runtime (hot reload)', () => {
    const r = boot();
    play(r);
    r.kernel.settle();
    const playing = r.kernel.snapshot();
    resetDeclarations();
    const next = boot();
    next.kernel.restore(playing);
    next.kernel.setLogic(true);
    next.step(1 / 60);
    expect(next.ctx.players).toHaveLength(1);
    expect(next.ctx.players[0]!.entity).not.toBeNull();
    expect(joined).toEqual(['Player 1']);
  });
});
