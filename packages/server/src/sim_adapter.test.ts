/**
 * The orchestration seam: a match sim driven like a fleet would drive it — admitted links
 * with verified identities (match tickets), a fixed-step loop, status for the watchdog,
 * drain, rejoin by identity, crash capture and stop — over the in-memory network.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Game, kw, PrefabRef, resetDeclarations, SceneRef } from '@parallax/runtime/api';
import type { NetLink, ProjectFiles } from '@parallax/runtime/core';
import { decodeServer, encodeClient, net, PROTOCOL } from '@parallax/runtime/plugins/net';
import type { ServerMessage } from '@parallax/runtime/plugins/net';
import { LoopbackNetwork } from '@parallax/runtime/platform';
import { Admission, createMatchSim } from './sim_adapter.js';
import type { SimAdapter } from './sim_adapter.js';
import { signTicket, ticketGate, verifyTicket } from './tickets.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const FILES = files({
  'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 5 } } },
  'prefabs/ship.prefab.json': { components: {}, replicate_transform: true },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'scenes/arena/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'start', at: [2, 1] }] },
});

function entry(): Record<string, unknown> {
  const plugin = net({
    maxPlayers: 3, playerPrefab: 'ship', tickRate: 30, mode: 'dedicated', rejoinSeconds: 5, namespace: () => ({}),
    host: { replication: () => ({ components: new Map(), resources: new Map() }), rpc: () => undefined, player: (seat) => ({ ...seat }) },
  });
  return { game: new Game(kw({ id: 'arena', title: 'Arena', sdk: '1.0', mode: '2d', start_scene: new SceneRef('arena'), plugins: [plugin] })) };
}

/** A raw client: hello, then reads what the server says. */
function client(link: NetLink, name: string): { messages(): ServerMessage[] } {
  link.send(encodeClient({ t: 'hello', protocol: PROTOCOL, name }, 'binary'));
  const seen: ServerMessage[] = [];
  return { messages: () => { seen.push(...link.receive().map((m) => decodeServer(m))); return seen; } };
}

const SECRET = 'test-secret';
const NOW = 1_800_000_000;
const ticket = (user: string, name: string, seat: number | null, jti: string, exp = NOW + 60): string =>
  signTicket(SECRET, { match: 'm1', user, name, seat, exp, jti });

/** A link carrying its request path, as the WebSocket listener's connections do. */
class PathLink implements NetLink {
  readonly #inner: NetLink;
  readonly path: string;
  constructor(inner: NetLink, path: string) { this.#inner = inner; this.path = path; }
  get id(): string { return this.#inner.id; }
  get state(): NetLink['state'] { return this.#inner.state; }
  get closeReason(): string | null { return this.#inner.closeReason; }
  get unreliable(): boolean { return this.#inner.unreliable; }
  send(...a: Parameters<NetLink['send']>): void { this.#inner.send(...a); }
  receive(): ReturnType<NetLink['receive']> { return this.#inner.receive(); }
  close(reason?: string): void { this.#inner.close(reason); }
}

beforeEach(() => resetDeclarations());

describe('SimAdapter', () => {
  let sim: SimAdapter;

  it('runs a match an orchestrator drives: admit with tickets, step, status, drain, rejoin, stop', async () => {
    sim = await createMatchSim({ entry: entry(), files: FILES, seed: 3 });
    expect(sim.info).toEqual({ gameId: 'arena', protocol: PROTOCOL, tickRate: 30, maxPlayers: 3 });
    const network = new LoopbackNetwork();
    const pending: NetLink[] = [];
    const listener = { accept: () => pending.splice(0) };
    const admission = new Admission(listener, ticketGate({ secret: SECRET, match: 'm1', now: () => NOW }), sim);
    // The loopback pairs a client end with a server end; feed server ends through the gate.
    const door = network.listen();
    const join = (path: string, name: string): { link: NetLink & { sever(): void }; c: ReturnType<typeof client> } => {
      const mine = network.connect();
      for (const end of door.accept()) pending.push(new PathLink(end, path));
      return { link: mine, c: client(mine, name) };
    };
    const run = (frames: number): void => { for (let i = 0; i < frames; i++) { admission.pump(); sim.step(1 / 60); } };

    const ann = join(`/match/m1?ticket=${ticket('u-ann', 'Ann', 2, 'j1')}`, 'claims-to-be-bob');
    const bad = join('/match/m1?ticket=v1.forged.sig', 'mallory');
    const none = join('/match/m1', 'nobody');
    run(5);
    expect(admission.rejected.map((r) => r.reason)).toEqual(['bad signature', 'no ticket']);
    expect(bad.link.state).toBe('closed');
    expect(none.link.state).toBe('closed');
    const welcome = ann.c.messages().find((m) => m.t === 'welcome');
    // the ticket's name and seat, not what the client claimed
    expect(welcome).toMatchObject({ t: 'welcome', seat: { index: 2, name: 'Ann' } });
    expect(sim.status()).toMatchObject({ players: 1, away: 0, maxPlayers: 3, scene: 'arena', accepting: true, crashed: null });

    // a spent ticket can't be reused
    const replay = join(`/match/m1?ticket=${ticket('u-ann', 'Ann', 2, 'j1')}`, 'x');
    run(2);
    expect(admission.rejected.at(-1)!.reason).toBe('ticket already used');
    expect(replay.link.state).toBe('closed');

    // Ann's connection drops; draining keeps new players out but lets Ann back in by identity
    ann.link.sever();
    run(3);
    expect(sim.status()).toMatchObject({ players: 0, away: 1 });
    sim.drain();
    const late = join(`/match/m1?ticket=${ticket('u-cy', 'Cy', null, 'j2')}`, 'Cy');
    const back = join(`/match/m1?ticket=${ticket('u-ann', 'Ann', 2, 'j3')}`, 'Ann');
    run(5);
    expect(late.link.state).toBe('closed');
    expect(back.c.messages().find((m) => m.t === 'welcome')).toMatchObject({ seat: { index: 2 } });
    expect(sim.status()).toMatchObject({ players: 1, away: 0, accepting: false });

    sim.stop();
    run(1);
    expect(back.c.messages().at(-1)).toMatchObject({ t: 'bye', code: 'PP3359' });
    expect(sim.status().accepting).toBe(false);
  });

  it('a frame that throws marks the sim crashed and it stops stepping', async () => {
    sim = await createMatchSim({ entry: entry(), files: FILES });
    const frame = sim.status().frame;
    (sim.runtime as unknown as { step(dt: number): void }).step = () => { throw new Error('boom'); };
    sim.step(1 / 60);
    sim.step(1 / 60);
    expect(sim.status()).toMatchObject({ crashed: 'boom', frame });
  });
});

describe('match tickets', () => {
  it('verify signature, shape, expiry and match', () => {
    const good = ticket('u1', 'Ann', null, 'a');
    expect(verifyTicket(SECRET, good, 'm1', NOW)).toMatchObject({ user: 'u1', name: 'Ann', seat: null });
    expect(verifyTicket('other-secret', good, 'm1', NOW)).toEqual({ reject: 'bad signature' });
    expect(verifyTicket(SECRET, good, 'm2', NOW)).toEqual({ reject: 'ticket is for another match' });
    expect(verifyTicket(SECRET, ticket('u1', 'Ann', null, 'a', NOW - 1), 'm1', NOW)).toEqual({ reject: 'ticket expired' });
    const [v, payload, sig] = good.split('.');
    const tampered = `${v}.${payload!.slice(0, -2)}AA.${sig}`;
    expect(verifyTicket(SECRET, tampered, 'm1', NOW)).toEqual({ reject: 'bad signature' });
    expect(verifyTicket(SECRET, 'v2.a.b', 'm1', NOW)).toEqual({ reject: 'not a v1 ticket' });
  });
});
