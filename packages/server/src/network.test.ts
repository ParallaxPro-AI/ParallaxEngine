/**
 * The net plugin over a real socket: an authoritative kernel behind the WebSocket listener,
 * and a client kernel connecting with the engine's WebSocket link (Node's global
 * WebSocket client), on localhost.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '@parallax/runtime/core';
import { Kernel, t } from '@parallax/runtime/kernel';
import type { GameDefinition } from '@parallax/runtime/kernel';
import { net } from '@parallax/runtime/plugins/net';
import type { NetPlugin, NetSession, RpcDef, RuntimeBridges } from '@parallax/runtime/plugins/net';
import { WebSocketLink } from '@parallax/runtime/platform';
import { loadProject } from '@parallax/runtime/resource';
import { WebSocketListener } from './websocket.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PROJECT = loadProject(files({
  'prefabs/ship.prefab.json': { components: { hull: { hp: 100 } }, replicate_transform: true },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'scenes/arena/scene.json': { entities: [{ prefab: 'start', at: [5, 0, 0] }] },
  'scenes/lobby/scene.json': { entities: [] },
}));

const GAME: GameDefinition = {
  components: [
    { id: 'hull', schema: { hp: t.number({ default: 0 }) } },
    { id: 'player_start', schema: { seat: t.int({ default: -1 }) } },
  ],
  resources: [{ id: 'score', schema: { value: t.int({ default: 0 }) } }],
  events: [], behaviors: [], systems: [],
};

const bridges = (): RuntimeBridges => ({
  input: {
    seats: () => {}, capture: () => ({}), apply: () => [],
    pointer: () => ({ x: 0, y: 0, world: null, over: null, held: false, pressed: false }), applyPointer: () => {}, releasePointer: () => {},
  },
  feedback: { take: () => [], play: () => {} },
});

function machine(session: NetSession, scene: string): { kernel: Kernel; plugin: NetPlugin } {
  const ctx: { kernel?: Kernel } = {};
  const add: RpcDef = {
    id: 'add', rateLimit: null, params: [{ name: 'n', type: { kind: 'int' }, present: (v) => v }],
    call: (_c, _p, [n]) => { const score = ctx.kernel!.resource('score'); score['value'] = (score['value'] as number) + (n as number); },
  };
  const plugin = net({
    maxPlayers: 4, playerPrefab: 'ship', tickRate: 30, mode: 'dedicated', namespace: () => ({}),
    host: {
      replication: () => ({ components: new Map([['hull', new Map([['hp', 'all']] as const)], ['player_start', new Map()]]), resources: new Map([['score', ['value']]]) }),
      rpc: (id) => (id === 'add' ? add : undefined),
      player: (seat) => seat,
    },
  });
  plugin.configure(session, '3d');
  const kernel = new Kernel({ project: PROJECT, game: plugin.define(GAME), plugins: [plugin], context: ctx });
  ctx.kernel = kernel;
  kernel.start(scene);
  plugin.attach(bridges());
  return { kernel, plugin };
}

const listeners: WebSocketListener[] = [];
afterEach(() => { for (const l of listeners.splice(0)) l.close(); });

describe('net over WebSockets on localhost', () => {
  it('a client joins, mirrors state, and its RPCs run on the server', async () => {
    const listener = await WebSocketListener.listen();
    listeners.push(listener);
    const server = machine({ role: 'server', listener }, 'arena');
    const client = machine({ role: 'client', link: new WebSocketLink(`ws://127.0.0.1:${listener.port}`), name: 'remote' }, 'lobby');
    const frames = async (until: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !until(); i++) {
        server.kernel.step(1 / 60);
        client.kernel.step(1 / 60);
        await new Promise((r) => setTimeout(r, 2));
      }
      expect(until()).toBe(true);
    };
    await frames(() => client.plugin.client!.synced && client.plugin.entityOf(0) !== undefined);
    expect(client.kernel.scene?.id).toBe('arena');
    const ship = client.kernel.world.require(client.plugin.entityOf(0)!);
    expect(ship.transform.position.x).toBeCloseTo(5);
    expect(ship.components.get('hull')!['hp']).toBe(100);

    server.kernel.world.require(server.plugin.entityOf(0)!).components.get('hull')!['hp'] = 42;
    client.plugin.call('add', { n: { type: { kind: 'int' }, value: 7 } });
    await frames(() => ship.components.get('hull')!['hp'] === 42 && client.kernel.resource('score')['value'] === 7);
    expect(server.kernel.resource('score')['value']).toBe(7);

    server.plugin.server!.close();
    await frames(() => client.plugin.client!.ended !== undefined);
    expect(client.plugin.client!.ended!.code).toBe('PP3359');
  });
});
