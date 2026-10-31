/**
 * What rides the session besides entities, over the loopback network in both wire forms:
 * plugin channel messages (services/channels.ts: chat, voice signalling) and the world
 * state clients mirror — the weather's and the environment's course and the water's
 * splashes (world_sync.ts).
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { LoopbackNetwork } from '../../../platform/headless/net.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { KernelPlugin } from '../../kernel/index.js';
import { CHANNELS_SERVICE, ENVIRONMENT_SERVICE, WATER_WORLD_SERVICE, WEATHER_SERVICE } from '../../services/index.js';
import { environment } from '../environment/index.js';
import { water } from '../water/index.js';
import type { WaterPlugin } from '../water/index.js';
import { weather } from '../weather/index.js';
import type { WeatherPlugin } from '../weather/index.js';
import { checkClientMessage, MAX_CHANNEL_BYTES, net } from './index.js';
import type { NetSession, RuntimeBridges, WireFormat } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PROJECT = loadProject(files({
  'prefabs/ship.prefab.json': { components: {} },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'prefabs/sea.prefab.json': { components: { water_body: { kind: 'ocean', waves: 'calm' } } },
  'scenes/bay/scene.json': {
    environment: { sky: 'clear_day', time_of_day: 10, weather: 'clear' },
    entities: [{ prefab: 'start', at: [0, 0, 0] }, { prefab: 'start', at: [4, 0, 0] }, { prefab: 'sea', at: [0, 0, 0] }],
  },
  'scenes/empty/scene.json': { entities: [] },
}));

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : `not a ParallaxError: ${String(error)}`;
  }
  return undefined;
}

const bridges = (): RuntimeBridges => ({
  input: {
    seats: () => {}, capture: () => ({}), apply: () => [],
    pointer: () => ({ x: 0, y: 0, world: null, over: null, held: false, pressed: false }),
    applyPointer: () => {}, releasePointer: () => {},
  },
  feedback: { take: () => [], play: () => {} },
});

function machine(session: NetSession, scene: string) {
  const plugin = net({
    maxPlayers: 2, playerPrefab: 'ship', tickRate: 30, mode: 'dedicated', namespace: () => ({}),
    host: {
      replication: () => ({ components: new Map([['player_start', new Map()]]), resources: new Map() }),
      rpc: () => undefined,
      player: (seat) => ({ ...seat }),
    },
  });
  plugin.configure(session, '3d');
  const sky: WeatherPlugin = weather();
  const sea: WaterPlugin = water();
  const env = environment();
  const plugins: KernelPlugin[] = [plugin, env, sky, sea];
  const game = plugin.define({
    components: [{ id: 'player_start', schema: { seat: { type: { kind: 'int' }, default: -1 } } }],
    resources: [], events: [], behaviors: [], systems: [],
  });
  const kernel = new Kernel({ project: PROJECT, game, plugins, context: {}, fixedStep: DT });
  kernel.start(scene);
  plugin.attach(bridges());
  return { kernel, plugin, weather: sky.control(), water: sea.control(), environment: env.control() };
}

function match(format: WireFormat, clients = 2) {
  const network = new LoopbackNetwork();
  const server = machine({ role: 'server', listener: network.listen() }, 'bay');
  const cs = Array.from({ length: clients }, (_, i) => machine({ role: 'client', link: network.connect(), name: `c${i}`, wire: format }, 'empty'));
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      server.kernel.step(DT);
      for (const c of cs) c.kernel.step(DT);
    }
  };
  return { server, clients: cs, step };
}

describe.each(['binary', 'json'] as const)('net sync over loopback (%s)', (format) => {
  it('channels: a client reaches the server, the server one seat or all, each topic pulled on its own', () => {
    const m = match(format);
    m.step(4);
    const [a, b] = m.clients;
    const server = m.server.kernel.service(CHANNELS_SERVICE);
    const chA = a!.kernel.service(CHANNELS_SERVICE);
    const chB = b!.kernel.service(CHANNELS_SERVICE);
    expect([server.role, chA.role]).toEqual(['server', 'client']);
    const seatA = a!.plugin.client!.seat!.index;
    const seatB = b!.plugin.client!.seat!.index;

    chA.send('chat', { text: 'ahoy', n: [1, 2.5, null, true] });
    chA.send('voice', { to: 'p1', payload: { sdp: 'x' } });
    m.step(2);
    expect(server.receive('chat')).toEqual([{ from: seatA, payload: { text: 'ahoy', n: [1, 2.5, null, true] } }]);
    expect(server.receive('chat')).toEqual([]);
    expect(server.receive('voice').map((x) => x.from)).toEqual([seatA]);

    server.send('chat', { line: 'all hands' });
    server.send('voice', { from: 'p0' }, seatB);
    m.step(2);
    expect(chA.receive('chat')).toEqual([{ from: 'server', payload: { line: 'all hands' } }]);
    expect(chB.receive('chat')).toEqual([{ from: 'server', payload: { line: 'all hands' } }]);
    expect(chA.receive('voice')).toEqual([]);
    expect(chB.receive('voice')).toEqual([{ from: 'server', payload: { from: 'p0' } }]);
  });

  it('channels refuse what does not fit (PP3362) and a client naming a seat (PP3363)', () => {
    const m = match(format, 1);
    m.step(4);
    const client = m.clients[0]!.kernel.service(CHANNELS_SERVICE);
    const server = m.server.kernel.service(CHANNELS_SERVICE);
    expect(code(() => client.send('chat', 'x'.repeat(MAX_CHANNEL_BYTES)))).toBe('PP3362');
    expect(code(() => client.send('', 1))).toBe('PP3362');
    expect(code(() => client.send('chat', 1, 0))).toBe('PP3363');
    expect(code(() => server.send('chat', 1, 7))).toBe('PP3362');
    // A client's oversized message is malformed on the server's side too.
    expect(code(() => checkClientMessage({ t: 'channel', topic: 'chat', payload: 'x'.repeat(MAX_CHANNEL_BYTES) }))).toBe('PP9354');
  });

  it("the weather's and the environment's course and the water's splashes reach clients", () => {
    const m = match(format, 1);
    m.step(4);
    const [c] = m.clients;
    m.server.weather.set({ preset: 'storm', seconds: 2, fields: {} });
    m.server.environment.timeOfDay = 21;
    m.server.environment.clouds({ coverage: 0.8, seconds: 0 });
    m.server.water.splash(new Vec3(3, 0, 3), 0.7);
    m.step(4);
    const conditions = (k: Kernel) => k.service(WEATHER_SERVICE).conditions();
    expect(conditions(c!.kernel).preset).toBe('storm');
    m.step(150);
    expect(conditions(c!.kernel).rain).toBeCloseTo(conditions(m.server.kernel).rain, 5);
    expect(conditions(c!.kernel).rain).toBeGreaterThan(0.5);
    const look = (k: Kernel) => k.service(ENVIRONMENT_SERVICE).resolve();
    expect(c!.environment.timeOfDay).toBeCloseTo(m.server.environment.timeOfDay, 3);
    expect(look(c!.kernel).clouds?.coverage).toBeCloseTo(look(m.server.kernel).clouds!.coverage, 5);
    const splashes = (k: Kernel) => k.service(WATER_WORLD_SERVICE).disturbances().filter((d) => d.kind === 'splash');
    m.server.water.splash(new Vec3(-3, 0, 1), 0.4);
    m.step(4);
    expect(splashes(c!.kernel).map((d) => [d.x, d.z, d.strength])).toEqual([[-3, 1, 0.4]]);
    expect(splashes(c!.kernel)).toEqual(splashes(m.server.kernel).slice(-1));
  });
});
