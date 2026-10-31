import { describe, expect, it } from 'vitest';
import { Quat } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { FakeVoiceNetwork } from '../../../platform/headless/voice.js';
import type { FakeVoice } from '../../../platform/headless/voice.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { KernelPlugin } from '../../kernel/index.js';
import { ACTIONS_SERVICE } from '../../services/index.js';
import type { ActionsService } from '../../services/index.js';
import { LoopbackChannels, matchPlugin } from '../chat/testing.js';
import { voice } from './index.js';
import type { VoiceOptions } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const SEATS = [{ index: 0, name: 'Host', local: true }, { index: 1, name: 'Ana', local: false }, { index: 2, name: 'Bo', local: false }];
const DEFAULTS: VoiceOptions = { mode: 'voice_activity', talk: null, threshold: 0.1, hangover: 0.3, near: 2, far: 30, positional: true };

/** Each machine places the three players' avatars and its own camera at its player's avatar, facing +z. */
function machine(seat: number, channels: ReturnType<LoopbackChannels['server']>, device: FakeVoice, options: Partial<VoiceOptions> = {}, held = false) {
  const project = loadProject(files({
    'prefabs/avatar.prefab.json': { components: {} },
    'prefabs/cam.prefab.json': { components: { camera: {} } },
    'scenes/main/scene.json': { entities: [
      { prefab: 'avatar', id: 'a0', at: [0, 0, 0] }, { prefab: 'avatar', id: 'a1', at: [10, 0, 0] }, { prefab: 'avatar', id: 'a2', at: [0, 0, 40] },
      { prefab: 'cam', id: 'cam' },
    ] },
  }));
  expect(project.diagnostics).toEqual([]);
  const ids = new Map<number, EntityId>();
  const cameraDef: KernelPlugin = { id: 'cam', components: [{ id: 'camera', schema: {} }] };
  const actions: KernelPlugin = { id: 'actions', install: (k) => k.provide(ACTIONS_SERVICE, { held: () => held } as unknown as ActionsService) };
  const plugin = voice({ ...DEFAULTS, ...options });
  plugin.connect(device);
  const kernel = new Kernel({
    project, context: {}, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [cameraDef, actions, matchPlugin(channels, SEATS.map((s) => ({ ...s, local: s.index === seat })), (s) => ids.get(s) ?? null), plugin],
  });
  kernel.start('main');
  for (const r of kernel.world.live()) if (r.placedId?.startsWith('a')) ids.set(Number(r.placedId.slice(1)), r.id);
  const cam = [...kernel.world.live()].find((r) => r.placedId === 'cam')!;
  const avatar = kernel.world.get(ids.get(seat)!)!;
  (cam.components.get('camera') as Record<string, unknown>)['__view__'] = { seat, active: true, position: avatar.transform.position, rotation: Quat.IDENTITY };
  return { kernel, engine: plugin.engine, step: () => kernel.step(1 / 60) };
}

function match(options: Partial<VoiceOptions> = {}) {
  const hub = new LoopbackChannels();
  const net = new FakeVoiceNetwork();
  const devices = [net.device('p0'), net.device('p1'), net.device('p2')];
  const host = machine(0, hub.server([1, 2]), devices[0]!, options);
  const ana = machine(1, hub.client(1), devices[1]!, options);
  const bo = machine(2, hub.client(2), devices[2]!, options);
  const all = [host, ana, bo];
  return { hub, devices, host, ana, bo, frames: (n: number) => { for (let i = 0; i < n; i++) for (const m of all) m.step(); } };
}

describe('proximity voice over the loopback net', () => {
  it('signals through the server until every pair has an open link (the lower id offers)', () => {
    const m = match();
    m.frames(4);
    for (const d of m.devices) expect(d.peers().map((p) => p.state)).toEqual(['open', 'open']);
    // Clients never address each other directly: everything went client → server → client.
    expect(m.hub.sent.every(([from, to]) => from === 'server' || to === 'server')).toBe(true);
    const offers = m.hub.sent.filter(([, , , p]) => String((p as { payload: string }).payload).includes('offer'));
    expect(offers.length).toBeGreaterThan(0);
  });

  it('voice activity transmits while loud (with hangover), and listeners hear it by distance and side', () => {
    const m = match();
    for (const d of m.devices) d.openMic();
    m.frames(4);
    m.devices[1]!.speak(0.5);
    m.frames(2);
    expect(m.ana.engine.transmitting).toBe(true);
    expect(m.host.engine.talking('p1')).toBe(true);
    expect(m.ana.engine.talking('p1')).toBe(true);
    // Ana stands 10 m to the host's right (+x): near/distance = 0.2, panned right.
    const atHost = m.host.engine.playback('p1')!;
    expect(atHost.gain).toBeCloseTo(0.2, 9);
    expect(atHost.pan).toBeCloseTo(1, 9);
    // Bo is 40 m away from Ana: beyond far, silent.
    expect(m.bo.engine.playback('p1')!.gain).toBe(0);
    // She stops: the hangover keeps the link open 0.3 s, then transmission ends.
    m.devices[1]!.speak(0);
    m.frames(10);
    expect(m.ana.engine.transmitting).toBe(true);
    m.frames(20);
    expect(m.ana.engine.transmitting).toBe(false);
    expect(m.host.engine.talking('p1')).toBe(false);
  });

  it('muting a player silences them here only; self-mute stops sending', () => {
    const m = match({ mode: 'open' });
    for (const d of m.devices) d.openMic();
    m.devices[1]!.speak(0.5);
    m.frames(4);
    m.host.engine.mute('p1', true);
    m.frames(1);
    expect(m.host.engine.playback('p1')!.gain).toBe(0);
    expect(m.host.engine.talking('p1')).toBe(false);
    expect(m.bo.engine.talking('p1')).toBe(true);
    m.ana.engine.selfMuted = true;
    m.frames(1);
    expect(m.devices[1]!.transmitting).toBe(false);
    expect(m.bo.engine.talking('p1')).toBe(false);
  });

  it('push to talk sends only while the action is held; no mic, no voice', () => {
    const hub = new LoopbackChannels();
    const net = new FakeVoiceNetwork();
    const up = machine(0, hub.server([1]), net.device('p0'), { mode: 'push_to_talk', talk: 'Controls.talk' }, false);
    const down = machine(1, hub.client(1), net.device('p1'), { mode: 'push_to_talk', talk: 'Controls.talk' }, true);
    expect(down.engine.mic()).toBe('off');
    down.step();
    expect(down.engine.transmitting).toBe(false);
    down.engine.start();
    down.step();
    up.step();
    expect(down.engine.transmitting).toBe(true);
    expect(up.engine.transmitting).toBe(false);
    const denied = net.device('p9', { denyMic: true });
    denied.openMic();
    expect(denied.mic).toBe('denied');
  });
});
