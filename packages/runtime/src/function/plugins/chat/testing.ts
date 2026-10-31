/**
 * Test support for plugins that talk over the `channels` service: an in-memory hub with a
 * server end and client ends (what the net plugin provides over a real session), and a
 * players plugin that seats a match. Messages are delivered when the receiving kernel next
 * pulls them, in send order — deterministic, like the headless loopback network.
 */

import type { Json } from '../../../resource/index.js';
import type { KernelPlugin } from '../../kernel/index.js';
import { CHANNELS_SERVICE, PLAYERS_SERVICE } from '../../services/index.js';
import type { ChannelMessage, ChannelsService, PlayerSeat } from '../../services/index.js';

interface Envelope {
  readonly topic: string;
  readonly message: ChannelMessage;
}

export class LoopbackChannels {
  /** Inboxes: the server's, and each client seat's. */
  readonly #server: Envelope[] = [];
  readonly #clients = new Map<number, Envelope[]>();
  /** Every message sent, for assertions: [from, to, topic, payload]. */
  readonly sent: [number | 'server', number | 'server', string, Json][] = [];

  /** The server's end, for a match whose remote seats are `remote`. */
  server(remote: readonly number[]): ChannelsService {
    for (const seat of remote) if (!this.#clients.has(seat)) this.#clients.set(seat, []);
    const hub = this;
    return {
      role: 'server',
      send(topic, payload, to = 'all') {
        const targets = to === 'all' ? [...hub.#clients.keys()] : [to];
        for (const seat of targets) {
          const inbox = hub.#clients.get(seat);
          if (inbox === undefined) continue;
          inbox.push({ topic, message: { from: 'server', payload: structuredClone(payload) } });
          hub.sent.push(['server', seat, topic, payload]);
        }
      },
      receive: (topic) => hub.#take(hub.#server, topic),
    };
  }

  /** A client's end, playing as `seat`. */
  client(seat: number): ChannelsService {
    if (!this.#clients.has(seat)) this.#clients.set(seat, []);
    const hub = this;
    return {
      role: 'client',
      send(topic, payload, to) {
        if (to !== undefined) throw new Error('a client sends to the server only');
        hub.#server.push({ topic, message: { from: seat, payload: structuredClone(payload) } });
        hub.sent.push([seat, 'server', topic, payload]);
      },
      receive: (topic) => hub.#take(hub.#clients.get(seat)!, topic),
    };
  }

  #take(inbox: Envelope[], topic: string): ChannelMessage[] {
    const out: ChannelMessage[] = [];
    for (let i = 0; i < inbox.length;) {
      if (inbox[i]!.topic === topic) out.push(inbox.splice(i, 1)[0]!.message);
      else i++;
    }
    return out;
  }
}

/** A plugin providing the channels end and a fixed seating (`local` seats play on this machine). */
export function matchPlugin(channels: ChannelsService | null, seats: readonly { index: number; name: string; local: boolean }[], entity: (seat: number) => number | null = () => null): KernelPlugin {
  const list: PlayerSeat[] = seats.map((s) => ({
    index: s.index, id: `p${s.index}`, name: s.name, local: s.local,
    input: { keyboard: s.local, mouse: s.local, touch: s.local, gamepad: null },
  }));
  return {
    id: 'test_match',
    install(kernel) {
      if (channels !== null) kernel.provide(CHANNELS_SERVICE, channels);
      kernel.provide(PLAYERS_SERVICE, { seats: () => list, entity: (seat) => entity(seat) as never });
    },
  };
}
