/**
 * The WebRTC adapter's link logic with a fake RTCPeerConnection: signalling through the
 * in-memory hub, negotiated reliable + unreliable channels, framing and chunking,
 * back-pressure, goodbyes, and a whole net match hosted by a "browser".
 */

import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../core/index.js';
import type { NetLink, NetMessage } from '../../core/index.js';
import { Kernel, t } from '../../function/kernel/index.js';
import type { GameDefinition } from '../../function/kernel/index.js';
import { net } from '../../function/plugins/net/index.js';
import type { NetPlugin, NetSession, RuntimeBridges } from '../../function/plugins/net/index.js';
import { loadProject } from '../../resource/index.js';
import { MemorySignalingHub } from '../headless/net_signaling.js';
import { CHUNK, frame, Reassembler, WebRtcLink, WebRtcListener } from './net_webrtc.js';
import type { RtcDataChannelLike, RtcDescription, RtcPeerConnectionLike } from './net_webrtc.js';

/** Deliveries between fake peers, run by `settle()`. */
class FakeNet {
  readonly queue: (() => void)[] = [];
  readonly peers = new Map<string, FakePeer>();
  readonly random = new SeededRandom(9);
  /** Chance an unreliable message is lost. */
  loss = 0;
  /** Data-channel messages sent, per channel id. */
  readonly sent = [0, 0];
  maxSize = 0;
  next = 0;
}

class FakeChannel implements RtcDataChannelLike {
  readyState = 'connecting';
  bufferedAmount = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  peer: FakeChannel | undefined;
  readonly id: number;
  readonly lossy: boolean;
  readonly #net: FakeNet;

  constructor(net: FakeNet, id: number, lossy: boolean) {
    this.#net = net;
    this.id = id;
    this.lossy = lossy;
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    if (data.length > CHUNK) throw new Error(`message of ${data.length} bytes is over the data-channel limit`);
    this.#net.sent[this.id]!++;
    this.#net.maxSize = Math.max(this.#net.maxSize, data.length);
    if (this.lossy && this.#net.random.next() < this.#net.loss) return;
    const copy = data.slice().buffer;
    const to = this.peer;
    this.#net.queue.push(() => { if (to?.readyState === 'open') to.onmessage?.({ data: copy }); });
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    const peer = this.peer;
    if (peer !== undefined) this.#net.queue.push(() => peer.close());
  }
}

class FakePeer implements RtcPeerConnectionLike {
  connectionState = 'new';
  onicecandidate: ((event: { readonly candidate: { toJSON(): object } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly id: string;
  readonly channels = new Map<number, FakeChannel>();
  remote: FakePeer | undefined;
  local = false;
  candidates = 0;
  readonly #net: FakeNet;

  constructor(net: FakeNet) {
    this.#net = net;
    this.id = `fake-${net.next++}`;
    net.peers.set(this.id, this);
  }

  createDataChannel(_label: string, init: { ordered: boolean; negotiated: true; id: number }): RtcDataChannelLike {
    const ch = new FakeChannel(this.#net, init.id, !init.ordered);
    this.channels.set(init.id, ch);
    return ch;
  }

  async createOffer(): Promise<RtcDescription> { return { type: 'offer', sdp: this.id }; }
  async createAnswer(): Promise<RtcDescription> { return { type: 'answer', sdp: this.id }; }

  async setLocalDescription(): Promise<void> {
    this.local = true;
    this.#net.queue.push(() => this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `candidate:${this.id}` }) } }));
    this.#maybeConnect();
  }

  async setRemoteDescription(d: RtcDescription): Promise<void> {
    const peer = this.#net.peers.get(d.sdp ?? '');
    if (peer === undefined) throw new Error('unknown description');
    this.remote = peer;
    this.#maybeConnect();
  }

  async addIceCandidate(): Promise<void> { this.candidates++; }

  #maybeConnect(): void {
    const other = this.remote;
    if (other === undefined || !this.local || !other.local || other.remote !== this) return;
    this.#net.queue.push(() => {
      for (const [id, ch] of this.channels) {
        const theirs = other.channels.get(id)!;
        ch.peer = theirs;
        theirs.peer = ch;
        ch.open();
        theirs.open();
      }
      this.connectionState = other.connectionState = 'connected';
    });
  }

  close(): void {
    this.connectionState = 'closed';
    for (const ch of this.channels.values()) ch.close();
  }
}

async function settle(net: FakeNet, pump: () => void = () => {}): Promise<void> {
  for (let i = 0; i < 50; i++) {
    for (let k = 0; k < 5; k++) await Promise.resolve();
    pump();
    const work = net.queue.splice(0);
    for (const w of work) w();
    if (work.length === 0 && i > 3) { pump(); return; }
  }
}

function setup(): { net: FakeNet; hub: MemorySignalingHub; listener: WebRtcListener; join(): WebRtcLink; accepted: NetLink[] } {
  const fake = new FakeNet();
  const hub = new MemorySignalingHub();
  const listener = new WebRtcListener(hub.host(), () => new FakePeer(fake));
  const accepted: NetLink[] = [];
  return { net: fake, hub, listener, accepted, join: () => new WebRtcLink(hub.join(), () => new FakePeer(fake)) };
}

const text = (m: NetMessage[]): string[] => m.map((x) => (typeof x === 'string' ? x : `bytes:${x.length}`));

describe('WebRTC peer hosting (fake RTCPeerConnection)', () => {
  it('peers signal, open both channels, and talk in both directions', async () => {
    const s = setup();
    const a = s.join();
    const b = s.join();
    a.send('hello from a');
    await settle(s.net, () => { s.accepted.push(...s.listener.accept()); a.receive(); b.receive(); });
    expect(s.accepted).toHaveLength(2);
    expect(a.state).toBe('open');
    expect(a.unreliable).toBe(true);
    const [ha, hb] = s.accepted;
    // queued while connecting, delivered on open
    expect(text(ha!.receive())).toEqual(['hello from a']);
    ha!.send(new Uint8Array([1, 2, 3]), 'unreliable');
    hb!.send('to b');
    b.send(new Uint8Array(5), 'unreliable');
    await settle(s.net);
    expect(a.receive()).toEqual([new Uint8Array([1, 2, 3])]);
    expect(text(b.receive())).toEqual(['to b']);
    expect(text(hb!.receive())).toEqual(['bytes:5']);
    expect(s.net.sent[1]).toBe(2);
  });

  it('large messages are chunked on the reliable channel; an oversized unreliable one goes reliably', async () => {
    const s = setup();
    const a = s.join();
    await settle(s.net, () => { s.accepted.push(...s.listener.accept()); a.receive(); });
    const host = s.accepted[0]!;
    s.net.loss = 1; // the unreliable channel loses everything
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    host.send(big);
    host.send(new Uint8Array(40_000).fill(7), 'unreliable');
    host.send(new Uint8Array(10), 'unreliable'); // small: really unreliable, lost
    host.send('x'.repeat(50_000));
    await settle(s.net);
    const got = a.receive();
    expect(got).toHaveLength(3);
    expect(got[0]).toEqual(big);
    expect((got[1] as Uint8Array).length).toBe(40_000);
    expect(got[2]).toBe('x'.repeat(50_000));
    expect(s.net.maxSize).toBeLessThanOrEqual(CHUNK);
  });

  it('framing: chunks reassemble; bad frames are refused', () => {
    const parts = frame(new Uint8Array(3 * CHUNK).fill(1));
    expect(parts.length).toBe(4);
    const r = new Reassembler();
    const out = parts.map((p) => r.push(p));
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect((out[3] as Uint8Array).length).toBe(3 * CHUNK);
    expect(() => new Reassembler().push(new Uint8Array([9, 1]))).toThrow(/unknown frame kind/);
    const mixed = new Reassembler();
    mixed.push(frame('y'.repeat(CHUNK * 2))[0]!);
    expect(() => mixed.push(frame(new Uint8Array(1))[0]!)).toThrow(/inside a chunked/);
  });

  it('a bad frame from a peer closes its link; a goodbye reaches the other side; the host leaving ends every peer', async () => {
    const s = setup();
    const a = s.join();
    const b = s.join();
    await settle(s.net, () => { s.accepted.push(...s.listener.accept()); a.receive(); b.receive(); });
    a.close('quit');
    await settle(s.net, () => { s.listener.accept(); });
    const ha = s.accepted.find((l) => l.state === 'closed');
    expect(ha?.closeReason).toBe('quit');
    s.listener.close();
    await settle(s.net);
    expect(b.state).toBe('closed');
  });

  it('back-pressure: unreliable sends are skipped while the channel is backed up', async () => {
    const s = setup();
    const a = s.join();
    await settle(s.net, () => { s.accepted.push(...s.listener.accept()); a.receive(); });
    // The joiner's peer connection was created first; back its unreliable channel up.
    const joiner = [...s.net.peers.values()][0]!;
    joiner.channels.get(1)!.bufferedAmount = 1 << 20;
    const before = s.net.sent[1]!;
    a.send(new Uint8Array(4), 'unreliable'); // skipped
    s.accepted[0]!.send(new Uint8Array(4), 'unreliable'); // the host's channel is clear
    expect(s.net.sent[1]).toBe(before + 1);
  });
});

describe('a net match hosted in a browser over WebRTC', () => {
  it('a joining player syncs with the host and mirrors its state', async () => {
    const PROJECT = loadProject({
      list: () => ['prefabs/ship.prefab.json', 'prefabs/start.prefab.json', 'scenes/bay/scene.json', 'scenes/lobby/scene.json'],
      read: (p) => JSON.stringify({
        'prefabs/ship.prefab.json': { components: { hull: { hp: 100 } }, replicate_transform: true },
        'prefabs/start.prefab.json': { components: { player_start: {} } },
        'scenes/bay/scene.json': { entities: [{ prefab: 'start', at: [3, 0, 0] }] },
        'scenes/lobby/scene.json': { entities: [] },
      }[p]),
    });
    const GAME: GameDefinition = {
      components: [{ id: 'hull', schema: { hp: t.number({ default: 0 }) } }, { id: 'player_start', schema: { seat: t.int({ default: -1 }) } }],
      resources: [], events: [], behaviors: [], systems: [],
    };
    const bridges = (): RuntimeBridges => ({
      input: { seats: () => {}, capture: () => ({}), apply: () => [], pointer: () => ({ x: 0, y: 0, world: null, over: null, held: false, pressed: false }), applyPointer: () => {}, releasePointer: () => {} },
      feedback: { take: () => [], play: () => {} },
    });
    const machine = (session: NetSession, scene: string): { kernel: Kernel; plugin: NetPlugin } => {
      const plugin = net({
        maxPlayers: 4, playerPrefab: 'ship', tickRate: 30, mode: 'host', namespace: () => ({}),
        host: { replication: () => ({ components: new Map([['hull', new Map([['hp', 'all']] as const)], ['player_start', new Map()]]), resources: new Map() }), rpc: () => undefined, player: (seat) => seat },
      });
      plugin.configure(session, '3d');
      const kernel = new Kernel({ project: PROJECT, game: plugin.define(GAME), plugins: [plugin] });
      kernel.start(scene);
      plugin.attach(bridges());
      return { kernel, plugin };
    };
    const s = setup();
    const host = machine({ role: 'host', seats: 1, listener: s.listener }, 'bay');
    const guest = machine({ role: 'client', link: s.join(), name: 'guest' }, 'lobby');
    for (let i = 0; i < 20; i++) {
      host.kernel.step(1 / 60);
      guest.kernel.step(1 / 60);
      await settle(s.net);
    }
    expect(guest.plugin.client!.synced).toBe(true);
    expect(guest.kernel.scene?.id).toBe('bay');
    expect(guest.plugin.players()).toHaveLength(2);
    const ship = guest.plugin.entityOf(1)!;
    expect(guest.kernel.world.require(ship).components.get('hull')!['hp']).toBe(100);
    expect(s.net.sent[1]).toBeGreaterThan(0); // snapshots and input went unreliable
  });
});
