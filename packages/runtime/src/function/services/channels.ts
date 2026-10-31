/**
 * The `channels` service: small plugin messages over the match's net session — text chat,
 * and the WebRTC signalling proximity voice needs to open its audio links. Provided
 * by the net plugin (it owns the session and the wire): each message rides the reliable
 * channel as `{t: "channel", topic, payload}`. Consumers: the chat and voice plugins.
 *
 * Shape. The server (a host or a dedicated server) talks to seats; a client talks to the
 * server only. A client's `send` goes to the server; the server's goes to one seat or to
 * every remote seat. Nothing is relayed implicitly: a server that wants client A's message
 * to reach client B sends it on (chat validates and rebroadcasts, voice forwards signals).
 *
 * Messages are pulled per topic (`receive`) at a point the consumer chooses (its `input`
 * hook), so a frame sees what had arrived when it began — deterministic over the in-memory
 * loopback. Payloads are JSON; the provider bounds their size (it rejects, never truncates).
 */

import type { Json } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface ChannelMessage {
  /** The sending seat's index (on the server), or 'server' (on a client). */
  readonly from: number | 'server';
  readonly payload: Json;
}

export interface ChannelsService {
  /** 'server' on a host or dedicated server, 'client' on a player's machine. */
  readonly role: 'server' | 'client';
  /**
   * Queue a message. A client sends to the server (`to` must be absent); the server sends
   * to a seat index, or to every remote seat with 'all' (absent: 'all').
   */
  send(topic: string, payload: Json, to?: number | 'all'): void;
  /** Messages on `topic` since the last call, oldest first. */
  receive(topic: string): readonly ChannelMessage[];
}

export const CHANNELS_SERVICE: ServiceKey<ChannelsService> = serviceKey<ChannelsService>(
  'channels', 'Plugin messages ride the net session: add net() to Game(plugins=[...]).',
);
