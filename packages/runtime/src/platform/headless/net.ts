/**
 * An in-memory network (the net port, headless): one listener and any number of client
 * links in one process, for playtests and engine tests. Deterministic: nothing depends on
 * wall time or global randomness.
 *
 * Conditions can be injected to test netcode the way a real network treats it:
 *
 *   latency  seconds one way
 *   jitter   up to this many extra seconds per message (seeded, uniform)
 *   loss     the chance an unreliable message is dropped (reliable ones never are)
 *
 * Time is the network's own clock, moved by `advance(seconds)` (a test advances it with
 * the frames it runs). A message is readable once the clock reaches its arrival time.
 * Reliable messages keep their send order (a late one holds back those after it, as on a
 * stream); unreliable ones arrive in arrival-time order, so jitter can reorder them. With
 * no latency a message is readable at the peer's next `receive()`.
 */

import { fail, SeededRandom } from '../../core/index.js';
import type { NetChannel, NetLink, NetLinkState, NetListener, NetMessage } from '../../core/index.js';

interface Queued {
  readonly message: NetMessage;
  /** Network time at which it becomes readable. */
  readonly at: number;
  /** Send order, to keep equal arrival times stable. */
  readonly n: number;
}

const encoder = new TextEncoder();

function sizeOf(message: NetMessage): number {
  return typeof message === 'string' ? encoder.encode(message).length : message.length;
}

class LoopbackLink implements NetLink {
  readonly id: string;
  peer: LoopbackLink | undefined;
  #state: NetLinkState = 'open';
  #reason: string | null = null;
  readonly #inbox: Queued[] = [];
  #lastReliable = -Infinity;
  readonly #network: LoopbackNetwork;

  constructor(id: string, network: LoopbackNetwork) {
    this.id = id;
    this.#network = network;
  }

  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }
  get unreliable(): boolean { return this.#network.unreliable; }

  send(message: NetMessage, channel: NetChannel = 'reliable'): void {
    if (this.#state !== 'open' || this.peer === undefined) return;
    const net = this.#network;
    const unreliable = channel === 'unreliable' && net.unreliable;
    net.record(channel, sizeOf(message));
    if (unreliable && net.drop()) return;
    let at = net.now + net.latency + net.delay();
    if (!unreliable) {
      at = Math.max(at, this.peer.#lastReliable);
      this.peer.#lastReliable = at;
    }
    this.peer.#deliver({ message, at, n: net.nextOrder() });
  }

  #deliver(q: Queued): void {
    let i = this.#inbox.length;
    while (i > 0 && (this.#inbox[i - 1]!.at > q.at)) i--;
    this.#inbox.splice(i, 0, q);
  }

  receive(): NetMessage[] {
    const now = this.#network.now;
    let ready = 0;
    while (ready < this.#inbox.length && this.#inbox[ready]!.at <= now + 1e-12) ready++;
    return this.#inbox.splice(0, ready).map((q) => q.message);
  }

  close(reason = 'closed'): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
    if (this.peer !== undefined) this.peer.#closedByPeer(reason);
  }

  /** The transport fails under both ends (a cable pulled): neither says goodbye. */
  sever(reason = 'connection lost'): void {
    this.#closedByPeer(reason);
    if (this.peer !== undefined) this.peer.#closedByPeer(reason);
  }

  #closedByPeer(reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
  }
}

class LoopbackListener implements NetListener {
  readonly #pending: LoopbackLink[] = [];
  #open = true;

  get open(): boolean { return this.#open; }

  offer(link: LoopbackLink): void { this.#pending.push(link); }

  accept(): NetLink[] {
    return this.#pending.splice(0);
  }

  close(): void {
    this.#open = false;
    for (const link of this.#pending.splice(0)) link.close('server closed');
  }
}

export interface LoopbackOptions {
  /** Seconds one way (default 0). */
  readonly latency?: number;
  /** Up to this many extra seconds per message (default 0). */
  readonly jitter?: number;
  /** Chance an unreliable message is lost, 0..1 (default 0). */
  readonly loss?: number;
  /** Whether links have an unreliable channel (default true; false behaves like a WebSocket). */
  readonly unreliable?: boolean;
  /** Seed of the jitter and loss draws. */
  readonly seed?: number;
}

export interface LoopbackTraffic {
  readonly messages: Record<NetChannel, number>;
  readonly bytes: Record<NetChannel, number>;
}

export class LoopbackNetwork {
  /** The network clock in seconds (moved by `advance`). */
  now = 0;
  readonly latency: number;
  readonly jitter: number;
  readonly loss: number;
  readonly unreliable: boolean;
  /** What was sent so far, both directions, per channel. */
  readonly traffic: LoopbackTraffic = { messages: { reliable: 0, unreliable: 0 }, bytes: { reliable: 0, unreliable: 0 } };
  #listener: LoopbackListener | undefined;
  #next = 0;
  #order = 0;
  readonly #random: SeededRandom;

  constructor(options: LoopbackOptions = {}) {
    const latency = options.latency ?? 0;
    const jitter = options.jitter ?? 0;
    const loss = options.loss ?? 0;
    if (!(latency >= 0) || !(jitter >= 0)) fail('PP9350', `Loopback latency and jitter are seconds ≥ 0, got ${latency} and ${jitter}`);
    if (!(loss >= 0 && loss <= 1)) fail('PP9350', `Loopback loss is a chance from 0 to 1, got ${loss}`);
    this.latency = latency;
    this.jitter = jitter;
    this.loss = loss;
    this.unreliable = options.unreliable ?? true;
    this.#random = new SeededRandom(options.seed ?? 1);
  }

  /** Bytes sent so far, both channels (bandwidth checks). */
  get sent(): number {
    return this.traffic.bytes.reliable + this.traffic.bytes.unreliable;
  }

  /** The server's listener (one per network). */
  listen(): NetListener {
    if (this.#listener?.open === true) fail('PP9350', 'This loopback network already has a listening server');
    this.#listener = new LoopbackListener();
    return this.#listener;
  }

  /** A client link to the listening server; the server sees it at its next `accept()`. */
  connect(): NetLink & { sever(reason?: string): void } {
    const listener = this.#listener;
    if (listener === undefined || !listener.open) {
      fail('PP9351', 'Nothing is listening on this loopback network', { fix: 'Call network.listen() (start the server) first.' });
    }
    const n = this.#next++;
    const client = new LoopbackLink(`client-${n}`, this);
    const server = new LoopbackLink(`link-${n}`, this);
    client.peer = server;
    server.peer = client;
    listener.offer(server);
    return client;
  }

  /** Move the network clock forward. */
  advance(seconds: number): void {
    this.now += seconds;
  }

  /** @internal */ record(channel: NetChannel, bytes: number): void {
    this.traffic.messages[channel]++;
    this.traffic.bytes[channel] += bytes;
  }

  /** @internal */ drop(): boolean {
    return this.loss > 0 && this.#random.next() < this.loss;
  }

  /** @internal */ delay(): number {
    return this.jitter > 0 ? this.#random.next() * this.jitter : 0;
  }

  /** @internal */ nextOrder(): number {
    return this.#order++;
  }
}
