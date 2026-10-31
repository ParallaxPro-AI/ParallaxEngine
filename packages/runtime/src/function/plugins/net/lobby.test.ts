import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { NetLink, ProjectFiles } from '../../../core/index.js';
import { MemorySignalingHub } from '../../../platform/headless/net_signaling.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition, LogicInstance } from '../../kernel/index.js';
import { LOBBY_EVENTS, net, NET_EVENTS } from './index.js';
import type { NetApiHost, NetPlugin, NetSession, RuntimeBridges } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PROJECT = loadProject(files({
  'prefabs/ship.prefab.json': { components: {}, replicate_transform: true },
  'scenes/arena/scene.json': { entities: [] },
}));

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof ParallaxError ? error.diagnostic.code : String(error); }
  return undefined;
}

const HOST: NetApiHost = {
  replication: () => ({ components: new Map(), resources: new Map() }),
  rpc: () => undefined,
  player: (seat) => ({ ...seat }),
};

const BRIDGES: RuntimeBridges = {
  input: { seats: () => {}, capture: () => ({}), apply: () => [], pointer: () => ({ x: 0, y: 0, world: null, over: null, held: false, pressed: false }), applyPointer: () => {}, releasePointer: () => {} },
  feedback: { take: () => [], play: () => {} },
};

interface Machine { readonly plugin: NetPlugin; readonly log: string[]; step(): void }

function machine(session: NetSession, maxPlayers = 4): Machine {
  const log: string[] = [];
  const watcher = {
    id: 'watcher', scenes: [], runsOn: 'server' as const,
    handlers: [
      { event: LOBBY_EVENTS.changed, method: 'changed' },
      { event: LOBBY_EVENTS.starting, method: 'starting' },
      { event: NET_EVENTS.joined, method: 'joined' },
    ],
    create: () => ({
      changed: () => { log.push('changed'); },
      starting: (_ctx: unknown, e: Fields) => { log.push(`starting ${String(e['code'])} seat ${String(e['seat'])}`); },
      joined: (_ctx: unknown, e: Fields) => { log.push(`joined ${(e['player'] as { name: string }).name}`); },
    }) as LogicInstance,
  };
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [watcher] };
  const plugin = net({ maxPlayers, playerPrefab: 'ship', tickRate: 60, mode: 'host', host: HOST, namespace: (p) => ({ plugin: p }) });
  plugin.configure(session, '3d');
  const kernel = new Kernel({ project: PROJECT, game: plugin.define(game), plugins: [plugin], context: {} });
  kernel.start('arena');
  plugin.attach(BRIDGES);
  return { plugin, log, step: () => kernel.step(DT) };
}

describe('ctx.net.lobby over the in-memory hub', () => {
  it('lists, hosts, joins, readies, picks teams and starts every member into the match', () => {
    const hub = new MemorySignalingHub();
    const clients: Machine[] = [];
    const platform = hub.platform((link: NetLink, name: string) => {
      clients.push(machine({ role: 'client', link, name }));
    });
    const ann = machine({ role: 'host', seats: 1, names: ['Ann'], lobby: platform });
    const bob = machine({ role: 'host', seats: 1, names: ['Bob'], lobby: platform });
    const all = (n = 1): void => { for (let i = 0; i < n; i++) for (const m of [ann, bob, ...clients]) m.step(); };

    ann.plugin.lobby.host({ name: 'Den', maxPlayers: 3, private: false, mode: 'ffa', map: 'arena' }, 'Ann');
    hub.connect().host({ name: 'Secret', maxPlayers: 2, private: true, mode: '', map: '' }, 'Eve');
    all();
    expect(ann.log).toContain('changed');
    expect(ann.plugin.lobby.isHost).toBe(true);
    expect(ann.plugin.lobby.seat).toBe(0);

    bob.plugin.lobby.refresh();
    const listed = bob.plugin.lobby.rooms;
    expect(listed.map((r) => r.name)).toEqual(['Den']); // the private room is not listed
    expect(listed[0]).toMatchObject({ players: 1, maxPlayers: 3, mode: 'ffa', map: 'arena', started: false });

    bob.plugin.lobby.join('NOPE', 'Bob');
    expect(bob.plugin.lobby.refusal?.code).toBe('room');
    bob.plugin.lobby.join(listed[0]!.code, 'Bob');
    expect(bob.plugin.lobby.refusal).toBeNull();
    bob.plugin.lobby.update({ ready: true, team: 'red' });
    all();
    expect(ann.plugin.lobby.members.map((m) => [m.seat, m.name, m.ready, m.team])).toEqual([[0, 'Ann', false, null], [1, 'Bob', true, 'red']]);
    expect(bob.plugin.lobby.seat).toBe(1);

    expect(code(() => bob.plugin.lobby.start())).toBe('PP3367');
    expect(code(() => bob.plugin.lobby.join('X', 'Bob'))).toBe('PP3366');
    expect(code(() => ann.plugin.lobby.host({ name: 'Two', maxPlayers: 2, private: false, mode: '', map: '' }, 'Ann'))).toBe('PP3366');

    ann.plugin.lobby.start();
    all(1);
    expect(ann.log).toContain(`starting ${listed[0]!.code} seat 0`);
    expect(bob.log).toContain(`starting ${listed[0]!.code} seat 1`);
    expect(clients).toHaveLength(1); // Bob moved into the match at the end of that frame
    all(6);
    expect(ann.log).toContain('joined Bob');
    expect(ann.plugin.players()).toHaveLength(2);
    // The roster is kept as it was at the start.
    expect(ann.plugin.lobby.started).toBe(true);
    expect(ann.plugin.lobby.members.map((m) => m.team)).toEqual([null, 'red']);
    expect(code(() => ann.plugin.lobby.leave())).toBe('PP3366');
    // Late lobby joiners are refused.
    const late = hub.connect();
    late.join(listed[0]!.code, 'Cat');
    expect(late.refusal?.code).toBe('started');
  });

  it('checks room sizes and needs a lobby service', () => {
    const hub = new MemorySignalingHub();
    const solo = machine({ role: 'host', seats: 1, lobby: hub.platform() }, 2);
    expect(code(() => solo.plugin.lobby.host({ name: 'Big', maxPlayers: 8, private: false, mode: '', map: '' }, 'A'))).toBe('PP3365');
    const none = machine({ role: 'host', seats: 1 });
    expect(code(() => none.plugin.lobby)).toBe('PP3368');
  });

  it('a room fills, and closes when its host leaves', () => {
    const hub = new MemorySignalingHub();
    const a = hub.connect();
    a.host({ name: 'Pair', maxPlayers: 2, private: false, mode: '', map: '' }, 'A');
    const room = a.room!.info.code;
    const b = hub.connect();
    b.join(room, 'B');
    const c = hub.connect();
    c.join(room, 'C');
    expect(c.refusal?.code).toBe('full');
    b.leave();
    expect(a.room!.members.map((m) => m.name)).toEqual(['A']);
    c.join(room, 'C');
    expect(c.room?.members.map((m) => m.name)).toEqual(['A', 'C']);
    a.leave();
    expect(c.room).toBeNull();
    c.list();
    expect(c.rooms).toEqual([]);
  });
});
