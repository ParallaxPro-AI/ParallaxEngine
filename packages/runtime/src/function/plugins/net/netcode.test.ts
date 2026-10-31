/**
 * Netcode under bad networks: a dedicated server and clients over a loopback with injected
 * latency, jitter and loss. A "runner" entity walks along x at 5 m/s while its owner holds
 * Move.x; its `walk` behavior is predicted on the owner's client.
 *
 *   prediction     the owner's entity answers in the frame the key goes down and ends where
 *                  the server has it; a server-side shove is corrected smoothly
 *   interpolation  another client sees the runner move at an even pace
 *   lag comp       a shot aimed where the shooter saw the runner hits at 150 ms RTT, and the
 *                  same shot tested against present positions misses
 *   rejoin         a dropped player takes their seat and entity back
 *   json           the debug wire works end to end (and costs more bytes)
 */

import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { LoopbackNetwork } from '../../../platform/headless/net.js';
import type { LoopbackOptions } from '../../../platform/headless/net.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { Fields, GameDefinition, KernelPlugin, LogicInstance, SystemDef } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import type { Physics3dService } from '../../services/index.js';
import { net, NET_EVENTS } from './index.js';
import type { ActionFrame, NetPlugin, NetSession, RpcDef, RuntimeBridges, SeatView, WireFormat } from './index.js';
import { rayBox } from './lag_compensation.js';
import { PROTOCOL } from './protocol.js';
import { encodeClient } from './wire.js';

const DT = 1 / 60;
const SPEED = 5;
const HALF = new Vec3(0.5, 1, 0.5);
const report = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env['PP_NET_REPORT'] === '1';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PROJECT = loadProject(files({
  'prefabs/runner.prefab.json': { components: { mover: { speed: SPEED } }, replicate_transform: true, behaviors: { walk: {} } },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'scenes/field/scene.json': {
    entities: [0, 1, 2].map((seat) => ({ prefab: 'start', at: [0, 0, seat * 10], components: { player_start: { seat } } })),
  },
  'scenes/empty/scene.json': { entities: [] },
}));

/** One machine's view of input: what the device reads (a client) or what the network fed each seat (the server). */
class InputSim {
  device = 0;
  readonly pending = new Map<number, number>();
  readonly visible = new Map<number, number>();
  readonly local: boolean;

  constructor(local: boolean) { this.local = local; }

  /** Before the net plugin's input hook: last frame's injections become readable (the input engine's timing). */
  frame(): void {
    for (const [seat, v] of this.pending) this.visible.set(seat, v);
  }

  axis(seat: number): number {
    return this.local ? this.device : this.visible.get(seat) ?? 0;
  }
}

interface Ctx {
  kernel: Kernel;
  input: InputSim;
  plugin: NetPlugin;
}

function definition(log: string[]): GameDefinition {
  const walk = {
    id: 'walk', params: {}, state: {}, requires: ['mover'], handlers: [],
    create: (): LogicInstance => ({
      start(this: LogicInstance & { entity: EntityId }, ctx: unknown) {
        log.push(`start ${(ctx as Ctx).kernel.world.require(this.entity).owner ?? '-'}`);
      },
      update(this: LogicInstance & { entity: EntityId }, ctx: unknown, dt: number) {
        const c = ctx as Ctx;
        const record = c.kernel.world.require(this.entity);
        const x = c.input.axis(record.owner ?? 0);
        const speed = record.components.get('mover')!['speed'] as number;
        if (x !== 0) record.transform.position = record.transform.position.__add__(new Vec3(x * speed * dt, 0, 0));
      },
    }),
  };
  const watcher: SystemDef = {
    id: 'watcher', scenes: [], runsOn: 'server',
    handlers: [
      { event: NET_EVENTS.joined, method: 'joined' }, { event: NET_EVENTS.left, method: 'left' }, { event: NET_EVENTS.rejoined, method: 'rejoined' },
    ],
    create: () => ({
      joined: (_c: unknown, e: Fields) => { log.push(`joined ${(e['player'] as SeatView).index}`); },
      left: (_c: unknown, e: Fields) => { log.push(`left ${(e['player'] as SeatView).index}`); },
      rejoined: (_c: unknown, e: Fields) => { log.push(`rejoined ${(e['player'] as SeatView).index}`); },
    }) as LogicInstance,
  };
  return {
    components: [
      { id: 'mover', schema: { speed: t.number({ default: 1 }) } },
      { id: 'player_start', schema: { seat: t.int({ default: -1 }) } },
    ],
    resources: [], events: [], behaviors: [walk], systems: [watcher],
  };
}

/** Hitboxes for lag compensation: every runner is a 1 × 2 × 1 box; there is no static world. */
function fakePhysics(): KernelPlugin {
  return {
    id: 'fake_physics',
    install(kernel) {
      kernel.provide(PHYSICS3D_SERVICE, {
        gravity: -9.81,
        raycast: () => undefined,
        bounds: (id: EntityId) => (kernel.world.get(id)?.components.has('mover') === true ? { center: Vec3.ZERO, halfExtents: HALF } : undefined),
        body: () => undefined,
      } as unknown as Physics3dService);
    },
  };
}

interface Shot { readonly hit: number | undefined; readonly presentHit: boolean; readonly seenX: number; readonly presentX: number }

interface Machine {
  readonly kernel: Kernel;
  readonly plugin: NetPlugin;
  readonly input: InputSim;
  readonly log: string[];
  readonly shots: Shot[];
}

function machine(session: NetSession, options: { predict?: readonly string[] } = {}): Machine {
  const log: string[] = [];
  const shots: Shot[] = [];
  const input = new InputSim(session.role === 'client');
  const ctx = { input } as Ctx;
  const fire: RpcDef = {
    id: 'fire', rateLimit: null,
    params: [{ name: 'dx', type: { kind: 'number' }, present: (v) => v }, { name: 'dz', type: { kind: 'number' }, present: (v) => v }],
    call: (_c, player, [dx, dz]) => {
      const seat = (player as SeatView).index;
      const plugin = ctx.plugin;
      const dir = new Vec3(dx as number, 0, dz as number);
      const shooter = plugin.entityOf(seat)!;
      const origin = ctx.kernel.world.require(shooter).transform.position;
      const hit = plugin.rewindRaycast(seat, origin, dir, 100, { layers: [], ignore: [shooter] });
      const target = plugin.entityOf(1)!;
      const now = ctx.kernel.world.require(target).transform.position;
      const present = rayBox(origin, dir.normalized(), 100, now, Quat.IDENTITY, Vec3.ZERO, HALF);
      shots.push({ hit: hit?.entity, presentHit: present !== undefined, seenX: plugin.seenPose(target, seat).position.x, presentX: now.x });
    },
  };
  const plugin = net({
    maxPlayers: 3, playerPrefab: 'runner', tickRate: 30, mode: 'dedicated', namespace: () => ({}),
    ...(options.predict !== undefined && { predict: options.predict }),
    host: { replication: () => ({ components: new Map([['mover', new Map([['speed', 'all']] as const)], ['player_start', new Map()]]), resources: new Map() }), rpc: (id) => (id === 'fire' ? fire : undefined), player: (seat) => ({ ...seat }) },
  });
  plugin.configure(session, '3d');
  const sim: KernelPlugin = { id: 'input_sim', install: (k) => { k.addHook('input', () => input.frame()); } };
  const kernel = new Kernel({ project: PROJECT, game: plugin.define(definition(log)), plugins: [sim, fakePhysics(), plugin], context: ctx });
  ctx.kernel = kernel;
  ctx.plugin = plugin;
  kernel.start(session.role === 'client' ? 'empty' : 'field');
  const bridges: RuntimeBridges = {
    input: {
      seats: () => {},
      capture: (): ActionFrame => ({ 'Move.x': { k: 'axis1', value: input.device } }),
      apply: (seat, frame) => {
        const v = frame['Move.x'];
        if (v?.k === 'axis1') input.pending.set(seat, v.value);
        return [];
      },
      pointer: () => ({ x: 0, y: 0, world: null, over: null, held: false, pressed: false }),
      applyPointer: () => {}, releasePointer: () => {},
    },
    feedback: { take: () => [], play: () => {} },
  };
  plugin.attach(bridges);
  return { kernel, plugin, input, log, shots };
}

interface Match {
  readonly network: LoopbackNetwork;
  readonly server: Machine;
  readonly clients: Machine[];
  step(n?: number, each?: () => void): void;
}

function match(conditions: LoopbackOptions, clients: number, options: { predict?: readonly string[]; wire?: WireFormat } = {}): Match {
  const network = new LoopbackNetwork(conditions);
  const server = machine({ role: 'server', listener: network.listen() }, options);
  const cs = Array.from({ length: clients }, (_, i) => machine({
    role: 'client', link: network.connect(), name: `c${i}`, ...(options.wire !== undefined && { wire: options.wire }),
  }, options));
  return {
    network, server, clients: cs,
    step(n = 1, each) {
      for (let i = 0; i < n; i++) {
        network.advance(DT);
        server.kernel.step(DT);
        for (const c of cs) c.kernel.step(DT);
        each?.();
      }
    },
  };
}

const BAD: LoopbackOptions = { latency: 0.05, jitter: 0.02, loss: 0.05, seed: 5 };

function own(m: Machine, seat: number): Vec3 {
  return m.kernel.world.require(m.plugin.entityOf(seat)!).transform.position;
}

/** Frames from pressing until the owner's entity moves on its own screen, and how it ends. */
function pressAndRelease(predict: readonly string[]): { response: number; finalGap: number; worstError: number } {
  const m = match(BAD, 1, { predict });
  m.step(60);
  const c = m.clients[0]!;
  const start = own(c, 0).x;
  c.input.device = 1;
  let response = -1;
  let worstError = 0;
  for (let f = 0; f < 60; f++) {
    m.step();
    if (response < 0 && own(c, 0).x > start + 1e-6) response = f + 1;
    const id = c.plugin.entityOf(0)!;
    worstError = Math.max(worstError, c.plugin.client!.prediction.lastError.get(id) ?? 0);
  }
  c.input.device = 0;
  m.step(90);
  return { response, finalGap: Math.abs(own(c, 0).x - own(m.server, 0).x), worstError };
}

describe('prediction and reconciliation (100 ms RTT, 20 ms jitter, 5% loss)', () => {
  it("the owner's entity answers at once and ends where the server has it", () => {
    const predicted = pressAndRelease(['walk']);
    const plain = pressAndRelease([]);
    if (report) console.log('prediction', { predicted, plain });
    expect(predicted.response).toBe(1);
    expect(plain.response).toBeGreaterThan(8);
    expect(predicted.finalGap).toBeLessThan(0.005);
    expect(plain.finalGap).toBeLessThan(0.005);
    // the server agrees with the prediction up to timing noise
    expect(predicted.worstError).toBeLessThan(0.2);
  });

  it('a shove the client could not predict is corrected smoothly, then converges', () => {
    const m = match(BAD, 1, { predict: ['walk'] });
    m.step(60);
    const c = m.clients[0]!;
    c.input.device = 1;
    m.step(20);
    const serverRunner = m.server.kernel.world.require(m.server.plugin.entityOf(0)!);
    serverRunner.transform.position = serverRunner.transform.position.__add__(new Vec3(0, 0, 1.5));
    let worstJump = 0;
    let lastZ = own(c, 0).z;
    m.step(60, () => {
      const z = own(c, 0).z;
      worstJump = Math.max(worstJump, Math.abs(z - lastZ));
      lastZ = z;
    });
    c.input.device = 0;
    m.step(60);
    if (report) console.log('shove', { worstJump, gap: own(c, 0).distance_to(own(m.server, 0)) });
    expect(own(c, 0).z).toBeCloseTo(1.5, 2);
    expect(own(c, 0).distance_to(own(m.server, 0))).toBeLessThan(0.005);
    // 1.5 m over ~10 frames, not in one
    expect(worstJump).toBeLessThan(0.3);
    expect(c.plugin.client!.prediction.snaps).toBe(0);
  });

  it('predicted behaviors run only on their own player\'s entity', () => {
    const m = match({}, 2, { predict: ['walk'] });
    m.step(30);
    const [a, b] = m.clients;
    a!.input.device = 1;
    m.step(1);
    // a's copy of b's runner is not predicted: a's input doesn't move it
    const bOnA = a!.plugin.entityOf(1)!;
    expect(a!.plugin.client!.predicted.has(bOnA)).toBe(false);
    expect(a!.plugin.client!.predicted.has(a!.plugin.entityOf(0)!)).toBe(true);
    expect(b!.plugin.client!.predicted.has(b!.plugin.entityOf(1)!)).toBe(true);
    expect(a!.kernel.world.require(bOnA).transform.position.x).toBeCloseTo(0, 5);
    // start hooks too: each client started only its own runner; the server started both
    expect(a!.log).toEqual(['start 0']);
    expect(b!.log).toEqual(['start 1']);
    expect(m.server.log.filter((l) => l.startsWith('start')).sort()).toEqual(['start 0', 'start 1']);
  });
});

describe('interpolation (100 ms RTT, 20 ms jitter, 5% loss, 30 Hz ticks, 60 Hz frames)', () => {
  it("another client sees the runner at an even pace; the raw snapshots don't", () => {
    const m = match(BAD, 2);
    m.step(60);
    const [a, b] = m.clients;
    a!.input.device = 1;
    m.step(60);
    const runner = b!.plugin.entityOf(0)!;
    const serverId = b!.plugin.client!.serverId(runner)!;
    const expected = SPEED * DT;
    let lastShown = b!.kernel.world.require(runner).transform.position.x;
    let lastRaw = b!.plugin.client!.latestPosition(serverId)!.x;
    let shownDev = 0;
    let rawDev = 0;
    let lag = 0;
    m.step(120, () => {
      const shown = b!.kernel.world.require(runner).transform.position.x;
      const raw = b!.plugin.client!.latestPosition(serverId)!.x;
      shownDev = Math.max(shownDev, Math.abs(shown - lastShown - expected));
      rawDev = Math.max(rawDev, Math.abs(raw - lastRaw - expected));
      lag = Math.max(lag, own(m.server, 0).x - shown);
      lastShown = shown;
      lastRaw = raw;
    });
    if (report) console.log('interpolation', { expectedStep: expected, shownDev, rawDev, lagMetres: lag, delay: b!.plugin.client!.clock.delay, jitter: b!.plugin.client!.clock.jitter });
    // within 20% of the true per-frame step, every frame; raw snapshots stall and jump
    expect(shownDev).toBeLessThan(expected * 0.2);
    expect(rawDev).toBeGreaterThan(expected * 0.9);
    // it trails the server by the network delay plus the interpolation delay, no more
    expect(lag).toBeLessThan(SPEED * 0.3);
  });
});

describe('lag compensation (150 ms RTT)', () => {
  it('a shot aimed where the shooter saw a moving target hits; tested against the present, it would miss', () => {
    const m = match({ latency: 0.075 }, 2);
    m.step(60);
    const [a, b] = m.clients;
    b!.input.device = 1; // the target (seat 1, at z=10) runs along x
    m.step(60);
    for (let i = 0; i < 10; i++) {
      const seen = a!.kernel.world.require(a!.plugin.entityOf(1)!).transform.position;
      const from = own(a!, 0);
      a!.plugin.call('fire', { dx: { type: { kind: 'number' }, value: seen.x - from.x }, dz: { type: { kind: 'number' }, value: seen.z - from.z } });
      m.step(6);
    }
    m.step(20);
    const shots = m.server.shots;
    const target = m.server.plugin.entityOf(1)!;
    if (report) console.log('lag compensation', { shots: shots.length, hits: shots.filter((s) => s.hit === target).length, presentHits: shots.filter((s) => s.presentHit).length, seenBehind: shots.map((s) => +(s.presentX - s.seenX).toFixed(3)) });
    expect(shots).toHaveLength(10);
    expect(shots.every((s) => s.hit === target)).toBe(true);
    expect(shots.some((s) => s.presentHit)).toBe(false);
    // the shooter saw the target about (RTT/2 + interpolation delay) × 5 m/s behind
    for (const s of shots) expect(s.presentX - s.seenX).toBeGreaterThan(0.5);
  });

  it('the rewind is capped: a client claiming an old view gets the window, not more', () => {
    const network = new LoopbackNetwork();
    const server = machine({ role: 'server', listener: network.listen() });
    const link = network.connect();
    link.send(encodeClient({ t: 'hello', protocol: PROTOCOL, name: 'cheat' }, 'binary'));
    for (let i = 0; i < 120; i++) server.kernel.step(DT);
    link.send(encodeClient({ t: 'input', ack: -1, view: 0, frames: [{ seq: 0, actions: {} }] }, 'binary'), 'unreliable');
    server.kernel.step(DT);
    server.kernel.step(DT);
    const now = server.kernel.time.realNow;
    expect(server.plugin.server!.viewTime(0)).toBeCloseTo(now - 0.4, 9);
  });
});

describe('rejoin', () => {
  it('a dropped player keeps their seat and entity for the window, and takes them back on a new link', () => {
    const network = new LoopbackNetwork();
    const server = machine({ role: 'server', listener: network.listen() });
    const link = network.connect();
    const client = machine({ role: 'client', link, name: 'c0' });
    const step = (n: number): void => { for (let i = 0; i < n; i++) { network.advance(DT); server.kernel.step(DT); client.kernel.step(DT); } };
    step(30);
    const entity = server.plugin.entityOf(0);
    const token = client.plugin.client!.rejoinToken!;
    link.sever();
    step(30);
    const events = (): string[] => server.log.filter((l) => !l.startsWith('start'));
    expect(events()).toEqual(['joined 0']);
    expect(server.plugin.server!.away(0)).toBe(true);
    expect(server.plugin.entityOf(0)).toBe(entity);
    client.plugin.client!.reconnect(network.connect());
    step(30);
    expect(events()).toEqual(['joined 0', 'rejoined 0']);
    expect(client.plugin.client!.synced).toBe(true);
    expect(client.plugin.client!.serverId(client.plugin.entityOf(0)!)).toBe(entity);
    expect(client.plugin.client!.rejoinToken).toBe(token);
    // a wrong token is turned away
    const intruder = machine({ role: 'client', link: network.connect(), name: 'x', rejoin: 'nope' });
    for (let i = 0; i < 5; i++) { server.kernel.step(DT); intruder.kernel.step(DT); }
    expect(intruder.plugin.client!.ended?.code).toBe('PP3360');
  });

  it('the seat is freed when the window ends; leaving on purpose frees it at once', () => {
    const m = match({}, 2);
    m.step(30);
    m.clients[1]!.plugin.client!.leave();
    m.step(2);
    expect(m.server.log).toContain('left 1');
    // seat 0's link drops: held for the default 20 s, then freed
    m.server.plugin.server!.seats.find((s) => s.index === 0)!.link!.close('cable');
    m.step(60 * 19);
    expect(m.server.log).not.toContain('left 0');
    m.step(60 * 2);
    expect(m.server.log).toContain('left 0');
  });
});

describe('the JSON debug wire', () => {
  it('plays the same, at a few times the bytes', () => {
    const run = (wire: WireFormat): { bytes: number; x: number; traffic: unknown } => {
      const m = match({}, 2, { wire, predict: ['walk'] });
      m.step(30);
      m.clients[0]!.input.device = 1;
      m.clients[1]!.input.device = -1;
      const before = m.network.sent;
      m.step(120);
      m.clients[0]!.input.device = 0;
      m.clients[1]!.input.device = 0;
      m.step(30);
      return { bytes: m.network.sent - before, x: own(m.clients[1]!, 0).x, traffic: JSON.parse(JSON.stringify(m.network.traffic)) };
    };
    const binary = run('binary');
    const json = run('json');
    if (report) console.log('bytes for 2 s of 2 walking players', { binary: binary.bytes, json: json.bytes, perSecondBinary: binary.bytes / 2, binaryTraffic: binary.traffic });
    expect(json.x).toBeCloseTo(binary.x, 2);
    expect(binary.x).toBeCloseTo(10, 0);
    expect(binary.bytes).toBeLessThan(json.bytes * 0.5);
  });
});
