/**
 * Networked play through `createRuntime` on a loopback network (a dedicated server and one
 * client, each a full runtime): the client's pointer reaches its seat on the server
 * (`ctx.input.pointer` read for that player), and one-shot feedback called on the server —
 * sounds, effects, flashes, toasts — plays on the client (DESIGN §6.5).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Vec2, Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import type { UiRequest } from '../function/plugins/ui/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { LoopbackNetwork } from '../platform/headless/net.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { attachNet, createRuntime, Game, kw, prepareNet, PrefabRef, resetDeclarations, SceneRef } from './index.js';
import { net } from './net.js';
import { foliage, hud, terrain, wind } from './plugins.js';
import { HudEngine } from '../function/plugins/hud/index.js';
import { FOLIAGE_SERVICE, TERRAIN_SERVICE, WIND_SERVICE } from '../function/services/index.js';
import type { GameRuntime, NetSession } from './index.js';
import { assetRef } from './project.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const DATA = files({
  'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 5 } } },
  'prefabs/ship.prefab.json': { components: {}, replicate_transform: true },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'scenes/arena/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'start', at: [2, 1] }] },
  'scenes/field/scene.json': {
    entities: [{ prefab: 'camera' }, { prefab: 'start', at: [2, 1, 0] }],
    terrain: { size: [64, 64], layers: ['grass'] },
    foliage: { layers: [{ id: 'trees', kind: 'tree', density: 0.02, on: 'grass', seed: 4, spacing: 3 }] },
    wind: { speed: 2 },
  },
});

interface Side {
  readonly runtime: GameRuntime;
  readonly devices: HeadlessInput;
  readonly audio: HeadlessAudio;
}

function side(session: NetSession, mode: '2d' | '3d' = '2d', world = false): Side {
  const game = new Game(kw({
    id: 'arena', title: 'Arena', sdk: '1.0', mode, start_scene: new SceneRef(world ? 'field' : 'arena'),
    plugins: [net(kw({ max_players: 2, player_prefab: new PrefabRef('ship') })), ...(world ? [terrain(), foliage(), wind(), hud()] : [])],
  }));
  prepareNet(game, session);
  const project = loadProject(DATA);
  expect(project.diagnostics).toEqual([]);
  const devices = new HeadlessInput();
  const audio = new HeadlessAudio();
  const runtime = createRuntime(game, project, {
    seed: 1, devices, audio, assets: null, files: DATA,
    ...(mode === '2d'
      ? { surface: new RecordingSurface2d({ width: 800, height: 600 }) }
      : { surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}) }),
  });
  runtime.start();
  attachNet(runtime);
  return { runtime, devices, audio };
}

function match(mode: '2d' | '3d' = '2d', world = false): { server: Side; client: Side; step(n?: number): void } {
  const network = new LoopbackNetwork();
  const server = side({ role: 'server', listener: network.listen() }, mode, world);
  const client = side({ role: 'client', link: network.connect(), name: 'c0' }, mode, world);
  return {
    server, client,
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        server.runtime.step(1 / 60);
        client.runtime.step(1 / 60);
      }
    },
  };
}

beforeEach(() => resetDeclarations());

describe('networked runtimes', () => {
  it("the client's pointer is its player's ctx.input.pointer on the server", () => {
    const m = match();
    m.step(4);
    m.client.devices.pointerMove(600, 150);
    m.client.devices.pointerDown();
    // Sent on the client's frame, received on the server's next, read from the one after.
    m.step(2);
    m.server.runtime.step(1 / 60);
    const seat = { seat: 0, owner: null };
    const server = m.server.runtime.inputEngine;
    const xyz = (v: Vec3): number[] => [v.x, v.y, v.z];
    // The world point travels as float32.
    const sent = xyz(m.client.runtime.inputEngine.pointerWorld());
    xyz(server.pointerWorld(seat)).forEach((v, i) => expect(v).toBeCloseTo(sent[i]!, 5));
    const other = server.pointerScreen({ seat: 1, owner: null }); // no client in seat 1: this machine's (idle) pointer
    expect([other.x, other.y]).toEqual([0, 0]);
    const screen = server.pointerScreen(seat);
    expect([screen.x, screen.y]).toEqual([600, 150]);
    expect(server.pointerButton(seat)).toEqual({ held: true, pressed: true, released: false });
    // Over needs a physics plugin, which this game lacks: it travels as None.
    expect(server.pointerOver(seat)).toBe(null);
  });

  it('sounds, effects, flashes and toasts called on the server play on the client', () => {
    const m = match();
    m.step(4);
    const ctx = m.server.runtime.ctx as unknown as {
      audio: { play(...a: unknown[]): void };
      vfx: { beam(...a: unknown[]): void };
      ui: { flash(...a: unknown[]): void; toast(...a: unknown[]): void };
      players: { entity: unknown }[];
    };
    ctx.audio.play(assetRef('sound', 'sfx/hit'), kw({ at: new Vec3(1, 2, 0), volume: 0.5 }));
    ctx.vfx.beam(new Vec2(0, 0), new Vec2(3, 4), kw({ seconds: 2 }));
    ctx.ui.flash(ctx.players[0]!.entity);
    ctx.ui.toast('hello');
    m.step(2);
    expect(m.client.audio.plays.map((p) => [p.sound, p.volume, p.position])).toEqual([['sfx/hit', 0.5, [1, 2, 0]]]);
    const lines = m.client.runtime.render2d!.lastFrame!.commands.filter((c) => c.kind === 'line');
    expect(lines.map((l) => l.points.join())).toContain('0,0,3,4');
    const requests = m.client.runtime.uiEngine.requests as readonly UiRequest[];
    const clientShip = [...m.client.runtime.kernel.world.live()].find((r) => r.owner === 0)!.id;
    expect(requests.filter((r) => r.kind === 'flash').map((r) => (r as { entity: unknown }).entity)).toEqual([clientShip]);
    expect(requests.filter((r) => r.kind === 'toast').map((r) => (r as { text: unknown }).text)).toEqual(['hello']);
  });

  it('in 3D, a beam called on the server is drawn by the client\'s renderer', () => {
    const m = match('3d');
    m.step(4);
    (m.server.runtime.ctx as unknown as { vfx: { beam(...a: unknown[]): void } }).vfx.beam(new Vec3(0, 1, 0), new Vec3(5, 1, -2), kw({ seconds: 2 }));
    m.step(2);
    // A beam is a ribbon through its two points (x, y, z, width, r, g, b, a each).
    const ribbons = m.client.runtime.render3d!.lastFrame!.ribbons ?? [];
    expect(ribbons.map((r) => [0, 1, 2, 8, 9, 10].map((i) => r.points[i]).join())).toContain('0,1,0,5,1,-2');
  });

  it("impact sounds play once: the server's (forwarded); a client's own physics impacts stay silent", () => {
    const m = match('3d');
    m.step(2);
    expect(m.server.runtime.audio.impactSounds).toBe(true);
    expect(m.client.runtime.audio.impactSounds).toBe(false);
    expect(m.client.runtime.audio.impact({ entity: null, other: null, speed: 10, material: 'metal' })).toBe(false);
  });

  it('terrain edits, felled foliage, wind changes and HUD feedback on the server reach the client', () => {
    const m = match('3d', true);
    m.step(4);
    const sk = m.server.runtime.kernel;
    const ck = m.client.runtime.kernel;
    sk.service(TERRAIN_SERVICE).deform({ kind: 'crater', x: 4, z: 4, radius: 3, depth: 2, rim: 0.2, layer: null });
    sk.service(TERRAIN_SERVICE).deform({ kind: 'hole', x: -10, z: -10, radius: 2 });
    const tree = sk.service(FOLIAGE_SERVICE).layers()[0]!;
    expect(tree.count).toBeGreaterThan(2);
    sk.service(FOLIAGE_SERVICE).remove('trees', 1);
    sk.service(WIND_SERVICE).set({ dirX: 0, dirZ: 1, speed: 9, seconds: 2 });
    const ctx = m.server.runtime.ctx as unknown as { hud: { ping(...a: unknown[]): void; screen_flash(...a: unknown[]): void } };
    ctx.hud.ping(new Vec3(1, 0, 1));
    m.step(2);
    const sf = sk.service(TERRAIN_SERVICE).current()!;
    const cf = ck.service(TERRAIN_SERVICE).current()!;
    expect(ck.service(TERRAIN_SERVICE).edits()).toEqual(sk.service(TERRAIN_SERVICE).edits());
    expect(cf.heightAt(4, 4)).toBe(sf.heightAt(4, 4));
    expect(cf.heightAt(4, 4)).toBeLessThan(-1);
    expect(cf.holeAt(-10, -10)).toBe(true);
    expect([...ck.service(FOLIAGE_SERVICE).layers()[0]!.alive].slice(0, 3)).toEqual([1, 0, 1]);
    // The wind ramp travels; the client's clock follows the server's, so the wind agrees.
    m.step(150);
    expect(ck.service(WIND_SERVICE).settings().speed).toBeCloseTo(9, 9);
    expect(ck.service(WIND_SERVICE).settings().dirZ).toBeCloseTo(1, 9);
    const clientHud = (m.client.runtime.game.plugins as readonly { id?: string; engine?: unknown }[]).find((p) => p.id === 'hud')!.engine as HudEngine;
    // The ping above has expired by now (3 s); a fresh one and a screen flash show on the client.
    ctx.hud.ping(new Vec3(2, 0, 2));
    ctx.hud.screen_flash();
    m.step(2);
    expect(clientHud.has('markers')).toBe(true);
    expect(clientHud.screen(0).flash).toBeGreaterThan(0);
    // Nothing is sent twice: later states carry no world part.
    m.step(4);
    expect(ck.service(TERRAIN_SERVICE).edits()).toHaveLength(2);
  });
});
