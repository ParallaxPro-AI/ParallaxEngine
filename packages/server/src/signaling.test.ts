/**
 * The reference signalling relay over real sockets on localhost, driven by the runtime's
 * browser-side `WebSocketSignaling` (Node's global WebSocket client): rooms, relaying in
 * both directions, isolation between peers, limits, and the host leaving. Also the
 * dedicated `serveGame` answering a client's hello over a WebSocket.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Game, kw, resetDeclarations, SceneRef } from '@parallax/runtime/api';
import { HOST_PEER } from '@parallax/runtime/core';
import type { NetMessage, ProjectFiles } from '@parallax/runtime/core';
import { decodeServer, encodeClient, net, PROTOCOL } from '@parallax/runtime/plugins/net';
import { WebSocketLink, WebSocketLobby, WebSocketSignaling } from '@parallax/runtime/platform';
import { serveGame } from './serve.js';
import type { GameServer } from './serve.js';
import { SignalingRelay } from './signaling.js';

const relays: SignalingRelay[] = [];
const servers: GameServer[] = [];
afterEach(() => {
  for (const r of relays.splice(0)) r.close();
  for (const s of servers.splice(0)) s.stop();
});

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('signalling relay: lobby', () => {
  it('lists public rooms, keeps member state, refuses without closing, starts, and signals after the start', async () => {
    const relay = await SignalingRelay.listen({ maxPeers: 3 });
    relays.push(relay);
    const url = `ws://127.0.0.1:${relay.port}`;
    const ann = new WebSocketLobby(url);
    ann.host({ name: 'Den', maxPlayers: 2, private: false, mode: 'ffa', map: 'arena' }, 'Ann');
    const eve = new WebSocketLobby(url);
    eve.host({ name: 'Hidden', maxPlayers: 4, private: true, mode: '', map: '' }, 'Eve');
    await until(() => ann.room !== null && eve.room !== null);
    const bob = new WebSocketLobby(url);
    bob.list();
    await until(() => bob.rooms.length > 0);
    expect(bob.rooms.map((r) => [r.name, r.players, r.maxPlayers, r.mode, r.map])).toEqual([['Den', 1, 2, 'ffa', 'arena']]);
    bob.join('NOSUCH', 'Bob');
    await until(() => bob.refusal !== null);
    expect(bob.refusal?.code).toBe('room');
    expect(bob.state).toBe('open');
    bob.join(bob.rooms[0]!.code, 'Bob');
    await until(() => bob.room !== null);
    bob.update({ ready: true, team: 'blue' });
    await until(() => ann.room?.members[1]?.ready === true);
    expect(ann.room!.members.map((m) => [m.seat, m.name, m.team])).toEqual([[0, 'Ann', null], [1, 'Bob', 'blue']]);
    const cat = new WebSocketLobby(url);
    cat.join(ann.room!.info.code, 'Cat');
    await until(() => cat.refusal !== null);
    expect(cat.refusal?.code).toBe('full');
    ann.start();
    await until(() => bob.room?.info.started === true);
    // The lobby connection is now the match's signalling.
    bob.send(HOST_PEER, 'offer');
    const got: { from: string; payload: string | null }[] = [];
    await until(() => { got.push(...ann.receive()); return got.length === 1; });
    expect(got[0]).toEqual({ from: bob.peer, payload: 'offer' });
    for (const c of [ann, bob, cat, eve]) c.close();
  });
});

describe('signalling relay', () => {
  it('relays between a host and its peers, and only them', async () => {
    const relay = await SignalingRelay.listen({ maxPeers: 2 });
    relays.push(relay);
    const url = `ws://127.0.0.1:${relay.port}`;
    const host = WebSocketSignaling.host(url);
    await until(() => host.state === 'open');
    expect(host.room).toMatch(/^[A-Z2-9]{6}$/);
    const a = WebSocketSignaling.join(url, host.room!);
    const b = WebSocketSignaling.join(url, host.room!);
    a.send(HOST_PEER, 'offer from a'); // queued until joined
    await until(() => a.state === 'open' && b.state === 'open');
    expect(a.peer).not.toBe(b.peer);
    const atHost: { from: string; payload: string | null }[] = [];
    await until(() => { atHost.push(...host.receive()); return atHost.length === 1; });
    expect(atHost[0]).toEqual({ from: a.peer, payload: 'offer from a' });
    host.send(a.peer!, 'answer for a');
    // a peer can't reach another peer
    b.send(a.peer!, 'sneaky');
    const atA: { from: string; payload: string | null }[] = [];
    await until(() => { atA.push(...a.receive()); return atA.length === 1; });
    expect(atA).toEqual([{ from: HOST_PEER, payload: 'answer for a' }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(a.receive()).toEqual([]);
    // the room is full
    const c = WebSocketSignaling.join(url, host.room!);
    await until(() => c.state === 'closed');
    expect(c.closeReason).toMatch(/full/);
    // a peer leaving is announced; the host leaving closes the room
    b.close('bye');
    await until(() => host.receive().some((m) => m.from === b.peer && m.payload === null));
    host.close('done');
    await until(() => a.state === 'closed');
    expect(a.receive()).toContainEqual({ from: HOST_PEER, payload: null });
    await until(() => relay.rooms === 0);
  });

  it('refuses unknown rooms and oversized payloads', async () => {
    const relay = await SignalingRelay.listen({ maxPayload: 100 });
    relays.push(relay);
    const url = `ws://127.0.0.1:${relay.port}`;
    const lost = WebSocketSignaling.join(url, 'NOPE42');
    await until(() => lost.state === 'closed');
    expect(lost.closeReason).toMatch(/No such room/);
    const host = WebSocketSignaling.host(url, 'my-room');
    await until(() => host.state === 'open');
    expect(host.room).toBe('my-room');
    const peer = WebSocketSignaling.join(url, 'my-room');
    await until(() => peer.state === 'open');
    peer.send(HOST_PEER, 'x'.repeat(101));
    await until(() => peer.state === 'closed');
    expect(peer.closeReason).toMatch(/too long/);
  });
});

describe('serveGame', () => {
  it('answers a hello over a WebSocket in the binary protocol, and says goodbye on stop', async () => {
    resetDeclarations();
    const text = { 'prefabs/ship.prefab.json': { components: {} }, 'scenes/arena/scene.json': { entities: [] } } as Record<string, unknown>;
    const files: ProjectFiles = { list: () => Object.keys(text).sort(), read: (p) => JSON.stringify(text[p]) };
    const plugin = net({
      maxPlayers: 2, playerPrefab: 'ship', tickRate: 30, mode: 'dedicated', namespace: () => ({}),
      host: { replication: () => ({ components: new Map(), resources: new Map() }), rpc: () => undefined, player: (seat) => ({ ...seat }) },
    });
    const game = new Game(kw({ id: 'arena', title: 'Arena', sdk: '1.0', mode: '2d', start_scene: new SceneRef('arena'), plugins: [plugin] }));
    const server = await serveGame({ entry: { game }, files, print: () => {} });
    servers.push(server);
    const link = new WebSocketLink(`ws://127.0.0.1:${server.port}/`);
    link.send(encodeClient({ t: 'hello', protocol: PROTOCOL, name: 'remote' }, 'binary'));
    const got: NetMessage[] = [];
    await until(() => { got.push(...link.receive()); return got.length >= 2; });
    expect(got.every((m) => m instanceof Uint8Array)).toBe(true);
    expect(decodeServer(got[0]!)).toMatchObject({ t: 'welcome', seat: { index: 0, name: 'remote' } });
    expect(decodeServer(got[1]!)).toMatchObject({ t: 'scene', scene: 'arena' });
    await until(() => server.status().players === 1);
    servers.splice(0);
    server.stop();
    await until(() => link.state === 'closed');
    expect(server.status().accepting).toBe(false);
  });
});
