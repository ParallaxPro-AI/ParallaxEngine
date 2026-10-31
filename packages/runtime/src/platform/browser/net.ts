/**
 * The net port in the page: a client link over a WebSocket. Binary messages travel as
 * binary frames, the JSON debug form as text frames. A WebSocket has no unreliable channel,
 * so `unreliable` sends are delivered reliably (`unreliable === false` tells the net plugin
 * not to send input redundantly). Messages that arrive between frames are buffered until the
 * kernel drains them; messages sent while the socket is still connecting are queued and
 * flushed when it opens.
 *
 * Works with any WHATWG `WebSocket` (browsers, and Node 22's global client — which is how
 * the dedicated server's tests drive it).
 */

import { fail } from '../../core/index.js';
import type { NetLink, NetLinkState, NetMessage } from '../../core/index.js';

/** The part of the WHATWG WebSocket this adapter uses. */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown; reason?: string }) => void): void;
}

const OPEN = 1;

let links = 0;

export class WebSocketLink implements NetLink {
  readonly id: string;
  readonly unreliable = false;
  readonly #socket: WebSocketLike;
  #state: NetLinkState = 'connecting';
  #reason: string | null = null;
  readonly #inbox: NetMessage[] = [];
  readonly #outbox: NetMessage[] = [];

  /** `url` is `ws://` or `wss://`; `create` builds the socket (default: the global WebSocket). */
  constructor(url: string, create?: (url: string) => WebSocketLike) {
    if (!/^wss?:\/\//.test(url)) fail('PP9352', `A game server address is ws:// or wss://, got "${url}"`);
    const make = create ?? ((u: string): WebSocketLike => {
      const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
      if (Ctor === undefined) fail('PP9352', 'This platform has no WebSocket client');
      return new Ctor(u);
    });
    this.id = `ws-${links++}`;
    this.#socket = make(url);
    this.#socket.binaryType = 'arraybuffer';
    this.#socket.addEventListener('open', () => {
      if (this.#state !== 'connecting') return;
      this.#state = 'open';
      for (const message of this.#outbox.splice(0)) this.#socket.send(message);
    });
    this.#socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') this.#inbox.push(data);
      else if (data instanceof ArrayBuffer) this.#inbox.push(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) this.#inbox.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else this.#fail('the server sent a frame of an unknown kind');
    });
    this.#socket.addEventListener('error', () => { this.#fail('connection error'); });
    this.#socket.addEventListener('close', (event) => {
      if (this.#state === 'closed') return;
      this.#state = 'closed';
      this.#reason = event.reason !== undefined && event.reason !== '' ? event.reason : 'connection closed';
    });
  }

  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }

  send(message: NetMessage): void {
    if (this.#state === 'closed') return;
    if (this.#state === 'connecting' || this.#socket.readyState !== OPEN) {
      this.#outbox.push(message);
      return;
    }
    this.#socket.send(message);
  }

  receive(): NetMessage[] {
    return this.#inbox.splice(0);
  }

  close(reason = 'closed'): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
    this.#socket.close(1000, reason.slice(0, 120));
  }

  #fail(reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
    this.#socket.close(1002, reason.slice(0, 120));
  }
}
