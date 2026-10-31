/**
 * A reference signalling relay for browser-hosted matches: rooms on a WebSocket server, a
 * host per room, and short messages passed between the host and each joining peer — the
 * offers, answers and ICE candidates the engine's WebRTC adapter exchanges. Products with
 * their own lobby service implement the `Signaling` port against that instead; the browser
 * side of this relay is `WebSocketSignaling` in the runtime.
 *
 * Protocol (JSON text frames):
 *   → { t: "host", room? }            ← { t: "hosting", room }       (a code is drawn when absent)
 *   → { t: "join", room }             ← { t: "joined", room, peer }
 *   → { t: "signal", to, payload }    ← { t: "signal", from, payload }
 *                                     ← { t: "left", peer }          (the host leaving closes the room)
 *                                     ← { t: "error", code, message } and the socket closes
 *
 * Lobby (a socket that opens with `{ t: "lobby" }`, answered `{ t: "lobby" }`; see core's
 * `lobby_rooms.ts`): `list` → `rooms`; `host` takes `config` {name, max_players, private,
 * mode, map} and `name`; `join` takes `name`; `update` {ready?, team?}; `start` (the host);
 * `leave`. Every change is pushed to the room's lobby members as `{ t: "room", state }`; a
 * refused request is `{ t: "refused", code, message }` and the socket stays open.
 *
 * The relay sees no game data: once peers connect, traffic is browser to browser. Limits:
 * a payload of at most `maxPayload` characters, `maxPeers` per room, `rate` messages per
 * second per socket (a token bucket), and peers may only signal the host (and the host its
 * own peers).
 */

import { HOST_PEER, LobbyRooms } from '@parallax/runtime/core';
import type { LobbyMember, LobbyRoom, NetLink } from '@parallax/runtime/core';
import { WebSocketListener } from './websocket.js';

export interface RelayOptions {
  readonly port?: number;
  readonly host?: string;
  /** Most peers per room (the host not counted). Default 16. */
  readonly maxPeers?: number;
  /** Longest payload in characters. Default 16384. */
  readonly maxPayload?: number;
  /** Messages per second per socket. Default 100. */
  readonly rate?: number;
  /** Pump interval in milliseconds. Default 5. */
  readonly interval?: number;
}

interface Member extends LobbyMember {
  readonly link: NetLink;
  tokens: number;
  at: number;
}

export class SignalingRelay {
  readonly #listener: WebSocketListener;
  readonly #members = new Set<Member>();
  readonly #rooms: LobbyRooms<Member>;
  readonly #maxPayload: number;
  readonly #rate: number;
  readonly #timer: ReturnType<typeof setInterval>;
  /** Messages relayed (tests, metrics). */
  relayed = 0;

  private constructor(listener: WebSocketListener, options: RelayOptions) {
    this.#listener = listener;
    this.#rooms = new LobbyRooms<Member>((m, message) => this.#send(m, message), (options.maxPeers ?? 16) + 1);
    this.#maxPayload = options.maxPayload ?? 16384;
    this.#rate = options.rate ?? 100;
    this.#timer = setInterval(() => this.pump(), options.interval ?? 5);
  }

  static async listen(options: RelayOptions = {}): Promise<SignalingRelay> {
    const listener = await WebSocketListener.listen({
      ...(options.port !== undefined && { port: options.port }),
      ...(options.host !== undefined && { host: options.host }),
      maxMessage: (options.maxPayload ?? 16384) * 2 + 1024,
    });
    return new SignalingRelay(listener, options);
  }

  get port(): number { return this.#listener.port; }
  get rooms(): number { return this.#rooms.rooms.size; }

  /** Accept sockets and relay what arrived (the timer calls this). */
  pump(): void {
    const now = performance.now() / 1000;
    for (const link of this.#listener.accept()) {
      this.#members.add({ link, lobby: false, role: 'new', joined: undefined, peerId: '', name: '', ready: false, team: null, tokens: this.#rate, at: now });
    }
    for (const m of [...this.#members]) {
      for (const raw of m.link.receive()) {
        m.tokens = Math.min(this.#rate, m.tokens + (now - m.at) * this.#rate);
        m.at = now;
        if (m.tokens < 1) { this.#error(m, 'rate', 'Too many signalling messages'); break; }
        m.tokens -= 1;
        if (typeof raw !== 'string') { this.#error(m, 'format', 'The relay speaks JSON text'); break; }
        this.#message(m, raw);
        if (m.link.state === 'closed') break;
      }
      if (m.link.state === 'closed') this.#gone(m);
    }
  }

  #message(m: Member, text: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text) as Record<string, unknown>; } catch { this.#error(m, 'format', 'Not JSON'); return; }
    if (typeof msg !== 'object' || msg === null) { this.#error(m, 'format', 'Not an object'); return; }
    const refused = (error: string | undefined): void => {
      if (error === undefined) return;
      const at = error.indexOf(':');
      this.#error(m, error.slice(0, at), error.slice(at + 1));
    };
    switch (msg['t']) {
      case 'lobby':
        if (m.role !== 'new' || m.lobby) { this.#error(m, 'state', 'Say lobby first, once'); return; }
        m.lobby = true;
        this.#send(m, { t: 'lobby' });
        return;
      case 'list':
        if (!m.lobby) { this.#error(m, 'state', 'Listing rooms needs a lobby connection'); return; }
        this.#rooms.list(m);
        return;
      case 'host': refused(this.#rooms.host(m, msg)); return;
      case 'join': refused(this.#rooms.join(m, msg)); return;
      case 'update':
      case 'start':
      case 'leave':
        if (!m.lobby) { this.#error(m, 'state', `${String(msg['t'])} needs a lobby connection`); return; }
        if (msg['t'] === 'update') refused(this.#rooms.update(m, msg));
        else if (msg['t'] === 'start') refused(this.#rooms.start(m));
        else this.#rooms.leave(m, false);
        return;
      case 'signal': {
        const room = m.joined as LobbyRoom<Member> | undefined;
        const to = msg['to'];
        const payload = msg['payload'];
        if (room === undefined) { this.#error(m, 'state', 'Join or host a room first'); return; }
        if (typeof to !== 'string' || typeof payload !== 'string') { this.#error(m, 'format', 'A signal has "to" and "payload" strings'); return; }
        if (payload.length > this.#maxPayload) { this.#error(m, 'size', 'Signal payload too long'); return; }
        // Peers talk only to the host; the host only to its own peers.
        const target = m.role === 'peer' ? (to === HOST_PEER ? room.host : undefined) : room.peers.get(to);
        if (target === undefined) return;
        this.relayed++;
        this.#send(target, { t: 'signal', from: m.peerId, payload });
        return;
      }
      default:
        this.#error(m, 'format', `Unknown message ${JSON.stringify(msg['t'])}`);
    }
  }

  #send(m: Member, message: object): void {
    if (m.link.state === 'closed') return;
    m.link.send(JSON.stringify(message));
  }

  #error(m: Member, code: string, message: string): void {
    this.#send(m, { t: 'error', code, message });
    m.link.close(message);
    this.#gone(m);
  }

  #gone(m: Member): void {
    if (!this.#members.delete(m)) return;
    for (const peer of this.#rooms.leave(m, true)) {
      if (peer.lobby) continue;
      peer.link.close('the host left');
      this.#members.delete(peer);
    }
  }

  close(): void {
    clearInterval(this.#timer);
    this.#listener.close();
  }
}
