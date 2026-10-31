import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, NetLink, ProjectFiles } from '../../../core/index.js';
import { LoopbackNetwork } from '../../../platform/headless/net.js';
import { loadProject } from '../../../resource/index.js';
import type { Json, Project } from '../../../resource/index.js';
import { Kernel, KERNEL_EVENTS, t } from '../../kernel/index.js';
import type { Fields, GameDefinition, LogicInstance, SystemDef } from '../../kernel/index.js';
import { PLAYERS_SERVICE } from '../../services/index.js';
import { checkClientMessage, net, NET_EVENTS } from './index.js';
import type { ActionFrame, NetApiHost, NetPlugin, NetPointer, NetSession, RpcDef, RuntimeBridges, SeatView } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : `not a ParallaxError: ${String(error)}`;
  }
  return undefined;
}

const PROJECT: Project = loadProject(files({
  'prefabs/ship.prefab.json': {
    components: { hull: { hp: 100, gold: 5, secret: 7 }, side: { side: 'crew' } },
    replicate_transform: true,
    children: [{ name: 'flag', components: { hull: { hp: 1 } } }],
  },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'prefabs/crate.prefab.json': { components: { hull: { hp: 10 } }, children: [{ components: { hull: { hp: 2 } } }] },
  'prefabs/rock.prefab.json': { components: {} },
  'scenes/arena/scene.json': {
    entities: [
      { prefab: 'start', at: [10, 0, 0], components: { player_start: { seat: 0 } } },
      { prefab: 'start', at: [-10, 0, 0], components: { player_start: { seat: 1 } } },
      { prefab: 'crate', id: 'crate', at: [0, 0, 5] },
      { prefab: 'rock', at: [3, 0, 3] },
    ],
  },
  'scenes/cove/scene.json': { entities: [{ prefab: 'start', at: [0, 0, 0] }] },
  'scenes/empty/scene.json': { entities: [] },
}));

const SIDE_ID = 'side';

/** What the game declares, as the api would hand it to the kernel. */
function definition(log: string[]): GameDefinition {
  const watcher: SystemDef & { runsOn: 'server' } = {
    id: 'watcher',
    scenes: [],
    runsOn: 'server',
    handlers: [
      { event: NET_EVENTS.joined, method: 'joined' },
      { event: NET_EVENTS.left, method: 'left' },
      { event: KERNEL_EVENTS.sceneLoaded, method: 'loaded' },
    ],
    create: () => ({
      joined: (ctx: unknown, e: Fields) => { log.push(`joined ${(e['player'] as SeatView).index}`); },
      left: (ctx: unknown, e: Fields) => {
        const seat = (e['player'] as SeatView).index;
        const plugin = (ctx as { plugin: NetPlugin }).plugin;
        log.push(`left ${seat} entity-alive=${String(plugin.entityOf(seat) !== undefined)}`);
      },
      loaded: (ctx: unknown) => {
        const plugin = (ctx as { plugin: NetPlugin }).plugin;
        log.push(`loaded with ${plugin.players().length} players, entity0=${String(plugin.entityOf(0) !== undefined)}`);
      },
    }) as LogicInstance,
  };
  const painter: SystemDef & { runsOn: 'client' } = { id: 'painter', scenes: [], runsOn: 'client', handlers: [], create: () => ({}) };
  return {
    components: [
      { id: 'hull', schema: { hp: t.number({ default: 0 }), gold: t.int({ default: 0 }), secret: t.int({ default: 0 }), mates: t.int({ default: 0 }) } },
      { id: 'player_start', schema: { seat: t.int({ default: -1 }) } },
      { id: SIDE_ID, schema: { side: { type: { kind: 'tag' }, default: null } } },
      { id: 'link', schema: { target: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null } } },
    ],
    resources: [{ id: 'score', schema: { value: t.int({ default: 0 }), hidden: t.int({ default: 0 }) } }],
    events: [],
    behaviors: [],
    systems: [watcher, painter],
  };
}

interface Ctx {
  plugin: NetPlugin;
  kernel: Kernel;
}

function host(opts: { visible?: boolean } = {}): NetApiHost & { calls: [number, unknown[]][] } {
  const calls: [number, unknown[]][] = [];
  const add: RpcDef = {
    id: 'add',
    rateLimit: 2,
    params: [{ name: 'n', type: { kind: 'int' }, present: (v) => v }],
    call: (ctx, player, args) => {
      calls.push([(player as SeatView).index, [...args]]);
      (ctx as Ctx).kernel.resource('score')['value'] = ((ctx as Ctx).kernel.resource('score')['value'] as number) + (args[0] as number);
    },
  };
  const poke: RpcDef = {
    id: 'poke',
    rateLimit: null,
    params: [{ name: 'target', type: { kind: 'entity' }, present: (v) => v }],
    call: (_ctx, player, args) => { calls.push([(player as SeatView).index, [...args]]); },
  };
  void opts;
  return {
    calls,
    replication: () => ({
      components: new Map([
        ['hull', new Map([['hp', 'all'], ['gold', 'owner'], ['mates', 'team']] as const)],
        ['player_start', new Map()],
        ['link', new Map([['target', 'all']] as const)],
      ]),
      resources: new Map([['score', ['value']]]),
    }),
    rpc: (id) => (id === 'add' ? add : id === 'poke' ? poke : undefined),
    player: (seat) => ({ ...seat }),
  };
}

interface Bridges extends RuntimeBridges {
  readonly applied: [number, ActionFrame][];
  readonly played: Json[];
  /** What `entity` mapped each played item's `entity` (server id) to. */
  readonly mapped: unknown[];
  pointerOut: NetPointer<EntityId>;
  readonly pointers: [number, NetPointer<unknown>][];
  readonly released: number[];
  seatsSet: [number, readonly number[]] | undefined;
  frame: ActionFrame;
  outbox: { item: Json; to: string | null }[];
}

function bridges(): Bridges {
  const b: Bridges = {
    applied: [],
    played: [],
    mapped: [],
    pointerOut: { x: 0, y: 0, world: null, over: null, held: false, pressed: false },
    pointers: [],
    released: [],
    seatsSet: undefined,
    frame: {},
    outbox: [],
    input: {
      seats: (count, local) => { b.seatsSet = [count, local]; },
      capture: () => b.frame,
      apply: (seat, frame) => {
        b.applied.push([seat, frame]);
        return Object.keys(frame).filter((k) => !k.startsWith('Controls.'));
      },
      pointer: () => b.pointerOut,
      applyPointer: (seat, pointer) => { b.pointers.push([seat, pointer]); },
      releasePointer: (seat) => { b.released.push(seat); },
    },
    feedback: {
      take: () => b.outbox.splice(0),
      play: (item, entity) => {
        b.played.push(item);
        const id = (item as { entity?: number }).entity;
        if (id !== undefined) b.mapped.push(entity(id));
      },
    },
  };
  return b;
}

interface Machine {
  readonly kernel: Kernel;
  readonly plugin: NetPlugin;
  readonly bridges: Bridges;
  readonly log: string[];
  readonly host: ReturnType<typeof host>;
  step(n?: number): void;
}

interface MachineOptions {
  visible?: (ctx: unknown, player: unknown, entity: unknown) => boolean;
  scene?: string;
  tickRate?: number;
  rejoin?: number;
}

function machine(session: NetSession, options: MachineOptions = {}): Machine {
  const log: string[] = [];
  const h = host();
  const ctx = {} as Ctx;
  const plugin = net({
    maxPlayers: 2, playerPrefab: 'ship', tickRate: options.tickRate ?? 60, mode: 'dedicated', host: h,
    namespace: (p) => ({ plugin: p }),
    ...(options.visible !== undefined && { visible: options.visible }),
    ...(options.rejoin !== undefined && { rejoinSeconds: options.rejoin }),
  });
  plugin.configure(session, '3d');
  // What the kernel will do once it applies plugin definition filters.
  const game = plugin.define(definition(log));
  const kernel = new Kernel({ project: PROJECT, game, plugins: [plugin], context: ctx });
  ctx.plugin = plugin;
  ctx.kernel = kernel;
  kernel.start(options.scene ?? 'arena');
  const b = bridges();
  plugin.attach(b);
  return { kernel, plugin, bridges: b, log, host: h, step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); } };
}

/** A server and clients on one loopback network; `step` runs one frame everywhere (server first). */
function match(clients: number, options: Parameters<typeof machine>[1] = {}): { server: Machine; clients: Machine[]; links: NetLink[]; step(n?: number): void } {
  const network = new LoopbackNetwork();
  const server = machine({ role: 'server', listener: network.listen() }, options);
  const links: NetLink[] = [];
  const cs = Array.from({ length: clients }, (_, i) => {
    const link = network.connect();
    links.push(link);
    return machine({ role: 'client', link, name: `c${i}` }, { scene: 'empty' });
  });
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      server.step();
      for (const c of cs) c.step();
    }
  };
  return { server, clients: cs, links, step };
}

function fieldsOf(m: Machine, id: EntityId, component: string): Fields {
  return m.kernel.world.require(id).components.get(component)!;
}

function shipOf(m: Machine, seat: number): EntityId {
  const id = m.plugin.entityOf(seat);
  if (id === undefined) throw new Error(`seat ${seat} has no entity`);
  return id;
}

describe('net plugin: a dedicated server and clients over loopback', () => {
  it('a client joins, loads the server scene and mirrors its entities', () => {
    const m = match(1);
    m.step(3);
    const [c] = m.clients;
    expect(m.server.log).toContain('joined 0');
    expect(c!.plugin.client!.synced).toBe(true);
    expect(c!.kernel.scene?.id).toBe('arena');

    const serverShip = shipOf(m.server, 0);
    const clientShip = shipOf(c!, 0);
    expect(m.server.kernel.world.require(serverShip).owner).toBe(0);
    expect(c!.kernel.world.require(clientShip).owner).toBe(0);
    expect(c!.kernel.world.require(clientShip).transform.position.x).toBeCloseTo(10);
    // all + owner fields arrive; unlisted fields stay on the server
    expect(fieldsOf(c!, clientShip, 'hull')).toMatchObject({ hp: 100, gold: 5 });
    fieldsOf(m.server, serverShip, 'hull')['secret'] = 70;
    m.step(2);
    expect(fieldsOf(c!, clientShip, 'hull')['secret']).toBe(7); // the prefab's value: never sent
    // the prefab child is mapped, not duplicated
    expect(c!.kernel.world.require(clientShip).children).toHaveLength(1);
    // the placed crate (and its unnamed child) are the client's own scene copies
    const crate = [...c!.kernel.world.live()].find((r) => r.placedId === 'crate')!;
    expect(c!.plugin.client!.serverId(crate.id)).toBe([...m.server.kernel.world.live()].find((r) => r.placedId === 'crate')!.id);
    expect(c!.plugin.players()).toEqual([{ index: 0, id: 'p0', name: 'c0', local: true }]);
    expect(c!.plugin.localIndex()).toBe(0);
    expect(c!.plugin.isServer).toBe(false);
  });

  it('owner fields reach only the owner; team fields reach the same side', () => {
    const m = match(2);
    m.step(3);
    const [a, b] = m.clients;
    const s0 = shipOf(m.server, 0);
    fieldsOf(m.server, s0, 'hull')['gold'] = 50;
    fieldsOf(m.server, s0, 'hull')['mates'] = 9;
    fieldsOf(m.server, s0, 'hull')['hp'] = 80;
    m.step(2);
    expect(fieldsOf(a!, shipOf(a!, 0), 'hull')).toMatchObject({ hp: 80, gold: 50, mates: 9 });
    // b is on the same side (both ships are "crew"): team yes, owner no
    expect(fieldsOf(b!, shipOf(b!, 0), 'hull')).toMatchObject({ hp: 80, gold: 5, mates: 9 });
    expect(b!.plugin.teamOf(1)).toBe('crew');
    // another side: team fields stop
    fieldsOf(m.server, shipOf(m.server, 1), SIDE_ID)['side'] = 'sea';
    fieldsOf(m.server, s0, 'hull')['mates'] = 10;
    m.step(2);
    expect(fieldsOf(b!, shipOf(b!, 0), 'hull')['mates']).toBe(9);
    expect(fieldsOf(a!, shipOf(a!, 0), 'hull')['mates']).toBe(10);
  });

  it('resources replicate only their marked fields; game time follows the server', () => {
    const m = match(1);
    m.step(3);
    m.server.kernel.resource('score')['value'] = 12;
    m.server.kernel.resource('score')['hidden'] = 99;
    m.step(2);
    const c = m.clients[0]!;
    expect(c.kernel.resource('score')).toMatchObject({ value: 12, hidden: 0 });
    expect(c.kernel.time.now).toBeCloseTo(m.server.kernel.time.now, 1);
  });

  it('spawns, entity references, transforms, tags, removals and destroys follow the server', () => {
    const m = match(1);
    m.step(3);
    const c = m.clients[0]!;
    const k = m.server.kernel;
    const crate = [...k.world.live()].find((r) => r.placedId === 'crate')!.id;
    const spawned = k.spawn('crate', { at: [1, 2, 3] }, {});
    k.addComponent(spawned.id, 'link', { target: shipOf(m.server, 0) });
    k.world.require(spawned.id).tags.add('loot');
    k.world.require(shipOf(m.server, 0)).transform.position = new Vec3(4, 5, 6);
    k.destroy(crate);
    // Moving entities are shown a little in the past (the interpolation delay).
    m.step(6);
    const local = c.plugin.client!.local(spawned.id)!;
    expect(local).toBeDefined();
    const rec = c.kernel.world.require(local);
    expect(rec.transform.position.z).toBeCloseTo(3);
    expect(rec.children).toHaveLength(1);
    expect([...rec.tags]).toEqual(['loot']);
    expect(fieldsOf(c, local, 'link')['target']).toBe(shipOf(c, 0));
    expect(c.kernel.world.require(shipOf(c, 0)).transform.position.x).toBeCloseTo(4);
    expect([...c.kernel.world.live()].some((r) => r.placedId === 'crate')).toBe(false);

    k.removeComponent(spawned.id, 'link');
    m.step(2);
    expect(c.kernel.world.require(local).components.has('link')).toBe(false);
    k.destroy(spawned.id);
    m.step(2);
    expect(c.kernel.world.isAlive(local)).toBe(false);
  });

  it('net(visible=) keeps entities from players who must not see them', () => {
    let hide = false;
    const m = match(2, {
      visible: (_ctx, player, entity) => {
        if (!hide || (player as SeatView).index !== 1) return true;
        const kernel = (_ctx as Ctx).kernel;
        const record = kernel.world.require(entity as EntityId);
        return record.owner !== 0 && record.placedId !== 'crate';
      },
    });
    m.step(3);
    const b = m.clients[1]!;
    const before = shipOf(b, 0);
    hide = true;
    m.step(2);
    // a spawned entity out of view is gone from the client; a placed one is kept, hidden
    expect(b.kernel.world.isAlive(before)).toBe(false);
    expect(b.plugin.entityOf(0)).toBeUndefined();
    const crate = [...b.kernel.world.live()].find((r) => r.placedId === 'crate')!;
    expect(crate.visible).toBe(false);
    expect(m.clients[0]!.plugin.entityOf(0)).toBeDefined();
    hide = false;
    m.step(2);
    expect(b.plugin.entityOf(0)).toBeDefined();
    expect(crate.visible).toBe(true);
  });

  it('RPCs run on the server for the calling player, typed, rate-limited and validated', () => {
    const m = match(2);
    m.step(3);
    const [a, b] = m.clients;
    a!.plugin.call('add', { n: { type: { kind: 'int' }, value: 2 } });
    b!.plugin.call('add', { n: { type: { kind: 'int' }, value: 3 } });
    m.step(2);
    expect(m.server.host.calls).toEqual([[0, [2]], [1, [3]]]);
    expect(m.server.kernel.resource('score')['value']).toBe(5);
    // rate_limit=2: a burst of three in one frame drops the third
    for (let i = 0; i < 3; i++) a!.plugin.call('add', { n: { type: { kind: 'int' }, value: 1 } });
    m.step(2);
    expect(m.server.kernel.resource('score')['value']).toBe(6);
    expect(a!.plugin.client!.rejections.map((r) => r.code)).toEqual(['PP3354', 'PP3354']);
    // tokens come back with time
    m.step(60);
    a!.plugin.call('add', { n: { type: { kind: 'int' }, value: 1 } });
    m.step(2);
    expect(m.server.kernel.resource('score')['value']).toBe(7);
    // entity arguments travel as the server's ids
    b!.plugin.call('poke', { target: { type: { kind: 'entity' }, value: shipOf(b!, 0) } });
    m.step(2);
    expect(m.server.host.calls.at(-1)).toEqual([1, [shipOf(m.server, 0)]]);
    // unknown RPCs and wrong arguments are rejected, not run
    a!.plugin.client!.call('nope', {});
    a!.plugin.client!.call('add', { n: { type: { kind: 'string' }, value: 'x' } });
    m.step(2);
    expect(a!.plugin.client!.rejections.slice(-2).map((r) => r.code)).toEqual(['PP3353', 'PP3355']);
    expect(m.server.plugin.server!.rejections.map((r) => r.code)).toContain('PP3355');
  });

  it("a client's input feeds its seat on the server; what it lets go of is released", () => {
    const m = match(2, { tickRate: 20 });
    m.step(3);
    const b = m.clients[1]!;
    b.bridges.frame = { 'Controls.fire': { k: 'button', held: true, down: true }, 'Controls.aim': { k: 'axis1', value: 0 } };
    m.step(2);
    // idle actions aren't sent
    expect(m.server.bridges.applied).toEqual([[1, { 'Controls.fire': { k: 'button', held: true, down: true } }]]);
    // unchanged input is resent only at the tick rate (it carries acknowledgements)
    m.step(2);
    expect(m.server.bridges.applied).toHaveLength(1);
    b.bridges.frame = { 'Controls.aim': { k: 'axis1', value: 0.5 } };
    m.step(2);
    expect(m.server.bridges.applied.at(-1)).toEqual([1, {
      'Controls.fire': { k: 'button', held: false, down: false }, 'Controls.aim': { k: 'axis1', value: 0.5 },
    }]);
    expect(m.server.bridges.seatsSet).toEqual([2, []]);
    // seat 1 reads this machine's devices, and so does seat 0 (what client systems read)
    expect(b.bridges.seatsSet).toEqual([2, [0, 1]]);
  });

  it("a client's pointer reaches its seat with the entity under it as the server's own (presses stick between frames)", () => {
    const m = match(1);
    m.step(3);
    const c = m.clients[0]!;
    const crate = [...c.kernel.world.live()].find((r) => r.placedId === 'crate')!;
    const serverCrate = [...m.server.kernel.world.live()].find((r) => r.placedId === 'crate')!;
    c.bridges.pointerOut = { x: 120, y: 80, world: [4, 0, -2], over: crate.id, held: true, pressed: true };
    c.step();
    c.bridges.pointerOut = { x: 121, y: 80, world: [4.1, 0, -2], over: crate.id, held: true, pressed: false };
    c.step();
    m.server.step(3);
    // one input frame per server frame, in order
    expect(m.server.bridges.pointers.slice(-2)).toEqual([
      [0, { x: 120, y: 80, world: [4, 0, -2], over: m.server.kernel.handles.wrap(serverCrate.id), held: true, pressed: true }],
      [0, { x: 121, y: 80, world: [Math.fround(4.1), 0, -2], over: m.server.kernel.handles.wrap(serverCrate.id), held: true, pressed: false }],
    ]);
    // An entity only the client has travels as null.
    c.bridges.pointerOut = { x: 5, y: 5, world: null, over: 9999 as EntityId, held: false, pressed: false };
    m.step(2);
    expect(m.server.bridges.pointers.at(-1)![1]).toMatchObject({ over: null, world: null, pressed: false });
    m.links[0]!.close('bye');
    m.step(2);
    expect(m.server.bridges.released).toEqual([0]);
  });

  it('a malformed pointer is a malformed message', () => {
    const input = (pointer: unknown): unknown => ({ t: 'input', ack: -1, view: 0, frames: [{ seq: 0, actions: {}, pointer }] });
    expect(() => checkClientMessage(input({ x: 'a' }))).toThrow(/malformed/);
    expect(checkClientMessage(input({ x: 1, y: 2, world: [1, 2, 3], over: 4, held: true, down: false })))
      .toMatchObject({ frames: [{ pointer: { over: 4 } }] });
  });

  it('forwarded feedback naming an entity maps it to the client\'s copy', () => {
    const m = match(1);
    m.step(3);
    const c = m.clients[0]!;
    const serverShip = shipOf(m.server, 0);
    m.server.bridges.outbox.push({ item: { kind: 'flash', entity: serverShip, color: null, seconds: 0.1 }, to: null });
    m.step(2);
    expect(c.bridges.mapped).toEqual([c.kernel.handles.wrap(shipOf(c, 0))]);
  });

  it('a client sending actions the game lacks is dropped', () => {
    const m = match(1);
    m.step(3);
    m.clients[0]!.bridges.frame = { 'Hacks.speed': { k: 'axis1', value: 9 } };
    m.step(3);
    expect(m.clients[0]!.plugin.client!.ended?.code).toBe('PP9356');
    expect(m.server.plugin.players()).toHaveLength(0);
  });

  it('feedback is forwarded to everyone, or to the one player it names', () => {
    const m = match(2);
    m.step(3);
    m.server.bridges.outbox.push({ item: { kind: 'toast', text: { s: 'all' }, seconds: 2 }, to: null });
    m.server.bridges.outbox.push({ item: { kind: 'toast', text: { s: 'b only' }, seconds: 2 }, to: 'p1' });
    m.step(2);
    expect(m.clients[0]!.bridges.played).toEqual([{ kind: 'toast', text: { s: 'all' }, seconds: 2 }]);
    expect(m.clients[1]!.bridges.played).toHaveLength(2);
  });

  it('leaving: PlayerLeft sees the entity alive; it is destroyed at the end of the frame, on every client', () => {
    const m = match(2, { rejoin: 0 });
    m.step(3);
    const gone = shipOf(m.clients[1]!, 0);
    m.links[0]!.close('quit');
    m.step(2);
    expect(m.server.log).toContain('left 0 entity-alive=true');
    expect(m.server.plugin.entityOf(0)).toBeUndefined();
    expect(m.server.plugin.players()).toHaveLength(1);
    expect(m.clients[1]!.kernel.world.isAlive(gone)).toBe(false);
  });

  it('a full match turns the next client away', () => {
    const m = match(3);
    m.step(3);
    expect(m.clients[2]!.plugin.client!.ended).toEqual({ code: 'PP3357', message: 'The match is full (2 players)' });
  });

  it('a server scene change moves every client, with players spawned before game handlers run', () => {
    const m = match(1);
    m.step(3);
    m.server.kernel.requestScene('cove', { seed: 7 });
    m.step(3);
    const c = m.clients[0]!;
    expect(c.kernel.scene?.id).toBe('cove');
    expect(m.server.log).toContain('loaded with 1 players, entity0=true');
    expect(c.plugin.entityOf(0)).toBeDefined();
    expect([...c.kernel.world.live()].some((r) => r.placedId === 'crate')).toBe(false);
  });

  it('a client may not change scene on its own', () => {
    const m = match(1);
    m.step(3);
    m.clients[0]!.kernel.requestScene('cove');
    expect(code(() => m.clients[0]!.step())).toBe('PP3358');
  });

  it('a client filters the definition: no server systems, inert behaviors; a dedicated server drops client systems', () => {
    const plugin = (role: NetSession): NetPlugin => {
      const p = net({ maxPlayers: 1, playerPrefab: 'ship', tickRate: 30, mode: 'dedicated', host: host(), namespace: () => ({}) });
      p.configure(role, '3d');
      return p;
    };
    const network = new LoopbackNetwork();
    const game: GameDefinition = {
      ...definition([]),
      behaviors: [{ id: 'b', params: {}, state: {}, requires: [], handlers: [{ event: NET_EVENTS.joined, method: 'x' }], create: () => ({ update() {} }) }],
    };
    const client = plugin({ role: 'client', link: network.listen() && network.connect(), name: 'x' }).define(game);
    expect(client.systems.map((s) => s.id)).toEqual(['painter']);
    expect(client.behaviors[0]!.handlers).toEqual([]);
    expect(client.behaviors[0]!.create()).toEqual({});
    expect(plugin({ role: 'server', listener: new LoopbackNetwork().listen() }).define(game).systems.map((s) => s.id)).toEqual(['watcher']);
    expect(plugin({ role: 'host', seats: 1 }).define(game)).toBe(game);
  });
});

describe('net plugin: a host with players on this machine', () => {
  it('local players join at their PlayerStarts, in order, and the players service lists them', () => {
    const h = machine({ role: 'host', seats: 2, names: ['Ann', 'Bo'] });
    h.step();
    // Players are assigned when the match starts: they join as the first scene loads, before SceneLoaded.
    expect(h.log).toEqual(['joined 0', 'joined 1', 'loaded with 2 players, entity0=true']);
    const service = h.kernel.service(PLAYERS_SERVICE);
    expect(service.seats()).toEqual([
      { index: 0, id: 'p0', name: 'Ann', local: true, input: { keyboard: true, mouse: true, touch: true, gamepad: 0 } },
      { index: 1, id: 'p1', name: 'Bo', local: true, input: { keyboard: false, mouse: false, touch: false, gamepad: 1 } },
    ]);
    expect(service.entity(1)).toBe(shipOf(h, 1));
    expect(h.plugin.players()).toEqual([
      { index: 0, id: 'p0', name: 'Ann', local: true }, { index: 1, id: 'p1', name: 'Bo', local: true },
    ]);
    expect(h.kernel.world.require(shipOf(h, 1)).transform.position.x).toBeCloseTo(-10);
    expect(h.bridges.seatsSet).toEqual([2, [0, 1]]);
    expect(h.plugin.localIndex()).toBe(0);
    expect(h.plugin.teamOf(0)).toBe('crew');
  });

  it('respawn replaces the entity; a local RPC is checked like a remote one', () => {
    const h = machine({ role: 'host', seats: 1 });
    h.step();
    const first = shipOf(h, 0);
    const second = h.plugin.respawn(0, undefined);
    h.step();
    expect(h.kernel.world.isAlive(first)).toBe(false);
    expect(h.plugin.entityOf(0)).toBe(second);
    h.plugin.call('add', { n: { type: { kind: 'int' }, value: 4 } });
    expect(h.kernel.resource('score')['value']).toBe(4);
    expect(code(() => h.plugin.call('add', { n: { type: { kind: 'int' }, value: 1.5 } }))).toBe('PP4108');
  });

  it('a scene without PlayerStarts gives players no entity; one with too few is an error', () => {
    const h = machine({ role: 'host', seats: 1 }, { scene: 'empty' });
    h.step();
    expect(h.plugin.entityOf(0)).toBeUndefined();
    expect(code(() => h.plugin.respawn(0, undefined))).toBe('PP3351');
    // cove has one any-seat start, shared round-robin
    h.kernel.requestScene('cove');
    h.step(2);
    expect(h.plugin.entityOf(0)).toBeDefined();
  });

  it('configuration errors are coded', () => {
    const mk = (over: Partial<Parameters<typeof net>[0]>): unknown => net({
      maxPlayers: 2, playerPrefab: 'ship', tickRate: 30, mode: 'host', host: host(), namespace: () => ({}), ...over,
    });
    expect(code(() => mk({ maxPlayers: 0 }))).toBe('PP3350');
    expect(code(() => mk({ tickRate: 500 }))).toBe('PP3350');
    expect(code(() => machine({ role: 'host', seats: 3 }))).toBe('PP3350');
    // unconfigured: the kernel can't be built with it
    const u = net({ maxPlayers: 2, playerPrefab: 'ship', tickRate: 30, mode: 'host', host: host(), namespace: () => ({}) });
    expect(code(() => new Kernel({ project: PROJECT, game: definition([]), plugins: [u] }))).toBe('PP3356');
    const p = net({ maxPlayers: 2, playerPrefab: 'ship', tickRate: 30, mode: 'host', host: host(), namespace: () => ({}) });
    p.configure({ role: 'host', seats: 1 }, '3d');
    new Kernel({ project: PROJECT, game: definition([]), plugins: [p] });
    expect(code(() => p.configure({ role: 'host', seats: 1 }, '3d'))).toBe('PP3356');
    // a client on a kernel that never applied `define` can't run
    const q = net({ maxPlayers: 2, playerPrefab: 'ship', tickRate: 30, mode: 'host', host: host(), namespace: () => ({}) });
    const network = new LoopbackNetwork();
    network.listen();
    q.configure({ role: 'client', link: network.connect(), name: 'x' }, '3d');
    // (a kernel that never calls `define`: the plugin reached only through install)
    new Kernel({ project: PROJECT, game: definition([]), plugins: [{ id: 'net', events: q.events, install: (k) => q.install(k) }] });
    expect(code(() => q.attach(bridges()))).toBe('PP9353');
  });

  it('snapshots keep seats and origins; clients resync after a restore', () => {
    const m = match(1);
    m.step(3);
    const snap = m.server.kernel.snapshot();
    const ship = shipOf(m.server, 0);
    m.server.plugin.respawn(0, undefined);
    m.step(2);
    m.server.kernel.restore(snap);
    expect(m.server.plugin.entityOf(0)).toBe(ship);
    m.step(3);
    expect(m.clients[0]!.plugin.client!.synced).toBe(true);
    expect(m.clients[0]!.plugin.entityOf(0)).toBeDefined();
  });
});
