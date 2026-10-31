/**
 * The `Signaling` port over a WebSocket, speaking the reference relay's protocol
 * (`packages/server/src/signaling.ts`). A product with its own lobby service implements the
 * port against that instead.
 *
 * Relay protocol (JSON text frames):
 *   → { t: "host", room? }            ← { t: "hosting", room }
 *   → { t: "join", room }             ← { t: "joined", room, peer }
 *   → { t: "signal", to, payload }    ← { t: "signal", from, payload }
 *                                     ← { t: "left", peer }    (the host left: peer "host")
 *                                     ← { t: "error", code, message }
 *
 * `WebSocketLobby` speaks the relay's lobby part (rooms, ready, team, start; core's
 * `lobby_rooms.ts`) and is the room's `Signaling` once the match starts.
 */

import { fail, LobbyView } from '../../core/index.js';
import type { LobbyConnection, NetLinkState, RoomConfig, RoomInfo, RoomState, SignalMessage, Signaling } from '../../core/index.js';
import type { WebSocketLike } from './net.js';

const OPEN = 1;

export class WebSocketSignaling implements Signaling {
  readonly #socket: WebSocketLike;
  #state: NetLinkState = 'connecting';
  #reason: string | null = null;
  readonly #inbox: SignalMessage[] = [];
  readonly #outbox: string[] = [];
  /** The room code, once the relay confirmed it. */
  room: string | null = null;
  /** This peer's id in the room (a joiner), or "host". */
  peer: string | null = null;

  /** Host a room (the relay picks a code when `room` is absent). */
  static host(url: string, room?: string, create?: (url: string) => WebSocketLike): WebSocketSignaling {
    return new WebSocketSignaling(url, JSON.stringify({ t: 'host', ...(room !== undefined && { room }) }), create);
  }

  /** Join the room a host shared. */
  static join(url: string, room: string, create?: (url: string) => WebSocketLike): WebSocketSignaling {
    return new WebSocketSignaling(url, JSON.stringify({ t: 'join', room }), create);
  }

  private constructor(url: string, first: string, create?: (url: string) => WebSocketLike) {
    this.#socket = openSocket(url, create);
    this.#socket.addEventListener('open', () => this.#socket.send(first));
    this.#socket.addEventListener('message', (event) => this.#message(event.data));
    this.#socket.addEventListener('error', () => this.#end('signalling connection error'));
    this.#socket.addEventListener('close', (event) => this.#end(event.reason !== undefined && event.reason !== '' ? event.reason : 'signalling closed'));
  }

  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }

  #message(data: unknown): void {
    if (typeof data !== 'string') { this.close('the relay sent binary data'); return; }
    let m: Record<string, unknown>;
    try { m = JSON.parse(data) as Record<string, unknown>; } catch { this.close('the relay sent bad JSON'); return; }
    switch (m['t']) {
      case 'hosting':
      case 'joined':
        this.room = String(m['room']);
        this.peer = m['t'] === 'hosting' ? 'host' : String(m['peer']);
        this.#state = 'open';
        for (const text of this.#outbox.splice(0)) this.#socket.send(text);
        return;
      case 'signal':
        if (typeof m['from'] === 'string' && typeof m['payload'] === 'string') this.#inbox.push({ from: m['from'], payload: m['payload'] });
        return;
      case 'left':
        if (typeof m['peer'] === 'string') this.#inbox.push({ from: m['peer'], payload: null });
        return;
      case 'error':
        this.close(`${String(m['code'])} ${String(m['message'])}`);
        return;
      default:
        return;
    }
  }

  send(to: string, payload: string): void {
    if (this.#state === 'closed') return;
    const text = JSON.stringify({ t: 'signal', to, payload });
    if (this.#state === 'connecting' || this.#socket.readyState !== OPEN) this.#outbox.push(text);
    else this.#socket.send(text);
  }

  receive(): SignalMessage[] {
    return this.#inbox.splice(0);
  }

  close(reason = 'closed'): void {
    if (this.#state === 'closed') return;
    this.#end(reason);
    this.#socket.close(1000, reason.slice(0, 120));
  }

  #end(reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
  }
}

function openSocket(url: string, create?: (url: string) => WebSocketLike): WebSocketLike {
  if (!/^wss?:\/\//.test(url)) fail('PP9352', `A signalling address is ws:// or wss://, got "${url}"`);
  const make = create ?? ((u: string): WebSocketLike => {
    const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
    if (Ctor === undefined) fail('PP9352', 'This platform has no WebSocket client');
    return new Ctor(u);
  });
  return make(url);
}

/** A lobby connection to the reference relay: list, host, join, ready, team, start, leave. */
export class WebSocketLobby implements LobbyConnection {
  readonly url: string;
  readonly #socket: WebSocketLike;
  readonly #view = new LobbyView();
  #state: NetLinkState = 'connecting';
  #reason: string | null = null;
  readonly #outbox: string[] = [];

  constructor(url: string, create?: (url: string) => WebSocketLike) {
    this.url = url;
    this.#socket = openSocket(url, create);
    this.#socket.addEventListener('open', () => this.#socket.send(JSON.stringify({ t: 'lobby' })));
    this.#socket.addEventListener('message', (event) => this.#message(event.data));
    this.#socket.addEventListener('error', () => this.#end('signalling connection error'));
    this.#socket.addEventListener('close', (event) => this.#end(event.reason !== undefined && event.reason !== '' ? event.reason : 'signalling closed'));
  }

  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }
  get rooms(): readonly RoomInfo[] { return this.#view.rooms; }
  get room(): RoomState | null { return this.#view.room; }
  get peer(): string | null { return this.#view.peer; }
  get refusal(): { readonly code: string; readonly message: string } | null { return this.#view.refusal; }
  get version(): number { return this.#view.version; }

  #message(data: unknown): void {
    if (typeof data !== 'string') { this.close('the relay sent binary data'); return; }
    let m: Record<string, unknown>;
    try { m = JSON.parse(data) as Record<string, unknown>; } catch { this.close('the relay sent bad JSON'); return; }
    if (m['t'] === 'lobby') {
      this.#state = 'open';
      for (const text of this.#outbox.splice(0)) this.#socket.send(text);
      return;
    }
    if (m['t'] === 'error') { this.close(`${String(m['code'])} ${String(m['message'])}`); return; }
    this.#view.apply(m);
  }

  #request(message: object): void {
    if (this.#state === 'closed') return;
    const text = JSON.stringify(message);
    if (this.#state === 'connecting' || this.#socket.readyState !== OPEN) this.#outbox.push(text);
    else this.#socket.send(text);
  }

  list(): void { this.#request({ t: 'list' }); }
  host(config: RoomConfig, name: string): void {
    this.#request({ t: 'host', name, config: { name: config.name, max_players: config.maxPlayers, private: config.private, mode: config.mode, map: config.map } });
  }
  join(code: string, name: string): void { this.#request({ t: 'join', room: code, name }); }
  update(patch: { readonly ready?: boolean; readonly team?: string | null }): void { this.#request({ t: 'update', ...patch }); }
  start(): void { this.#request({ t: 'start' }); }
  leave(): void { this.#request({ t: 'leave' }); }
  send(to: string, payload: string): void { this.#request({ t: 'signal', to, payload }); }
  receive(): SignalMessage[] { return this.#view.inbox.splice(0); }

  close(reason = 'closed'): void {
    if (this.#state === 'closed') return;
    this.#end(reason);
    this.#socket.close(1000, reason.slice(0, 120));
  }

  #end(reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
  }
}
