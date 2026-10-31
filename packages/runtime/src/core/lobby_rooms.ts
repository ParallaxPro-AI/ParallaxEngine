/**
 * The lobby's room bookkeeping, shared by the reference relay (`packages/server`) and the
 * in-memory hub (`platform/headless/net_signaling.ts`), so both answer the same protocol the
 * same way. It holds rooms and members and answers requests with relay messages; the caller
 * delivers them (JSON text frames on a socket, or objects in an inbox).
 *
 * Messages a member receives (the wire protocol's lobby part):
 *   { t: "rooms", rooms: RoomInfo[] }             the public listing (after `list`)
 *   { t: "hosting", room } / { t: "joined", room, peer }
 *   { t: "room", state: RoomState }               the room changed (to every lobby member)
 *   { t: "left_room" }                            this member left its room (or the host closed it)
 *   { t: "refused", code, message }               a lobby request was refused; the connection stays
 *   { t: "left", peer }                           a peer left (to the host); the host left (to peers)
 *
 * Legacy members (no `lobby` hello: `WebSocketSignaling.host/join`) get only the original
 * relay messages, and their rooms are private with no config.
 */

import { HOST_PEER } from './ports/net.js';
import type { RoomConfig, RoomInfo, RoomMember, RoomState } from './ports/net.js';

export interface LobbyMember {
  /** Speaks the lobby protocol (sent `lobby` first). */
  lobby: boolean;
  role: 'new' | 'host' | 'peer';
  /** The room it is in (relay bookkeeping). */
  joined: object | undefined;
  /** Its peer id in that room. */
  peerId: string;
  name: string;
  ready: boolean;
  team: string | null;
}

export interface LobbyRoom<M extends LobbyMember> {
  readonly code: string;
  readonly host: M;
  readonly peers: Map<string, M>;
  readonly config: RoomConfig;
  started: boolean;
  next: number;
  /** Seats in join order: the host first. */
  readonly order: M[];
}

export type RelayMessage = Readonly<Record<string, unknown>>;

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-Za-z0-9_-]{4,32}$/;

/** A random room code (crypto randomness when the platform has it). */
export function drawRoomCode(random: () => number = Math.random): string {
  const bytes = new Uint8Array(6);
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues !== undefined) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  return [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

/** Read a `host` message's config; a string is the refusal. */
export function roomConfigOf(raw: unknown, code: string, maxMembers: number): RoomConfig | string {
  if (raw === undefined) return { name: code, maxPlayers: maxMembers, private: true, mode: '', map: '' };
  if (typeof raw !== 'object' || raw === null) return 'A room config is an object';
  const c = raw as Record<string, unknown>;
  const name = c['name'] ?? code;
  const max = c['max_players'] ?? maxMembers;
  const priv = c['private'] ?? false;
  const mode = c['mode'] ?? '';
  const map = c['map'] ?? '';
  if (typeof name !== 'string' || name.length === 0 || name.length > 48) return 'A room name is 1–48 characters';
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > maxMembers) return `max_players is a whole number from 1 to ${maxMembers}`;
  if (typeof priv !== 'boolean') return 'private is true or false';
  if (typeof mode !== 'string' || mode.length > 32 || typeof map !== 'string' || map.length > 32) return 'mode and map are strings of at most 32 characters';
  return { name, maxPlayers: max, private: priv, mode, map };
}

function memberName(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 32) : fallback;
}

export class LobbyRooms<M extends LobbyMember> {
  readonly rooms = new Map<string, LobbyRoom<M>>();
  readonly #send: (member: M, message: RelayMessage) => void;
  /** Most members per room, the host included. */
  readonly maxMembers: number;

  constructor(send: (member: M, message: RelayMessage) => void, maxMembers: number) {
    this.#send = send;
    this.maxMembers = maxMembers;
  }

  info(room: LobbyRoom<M>): RoomInfo {
    return { code: room.code, ...room.config, players: room.order.length, started: room.started };
  }

  state(room: LobbyRoom<M>): RoomState {
    const members: RoomMember[] = room.order.map((m, seat) => ({ peer: m.peerId, seat, name: m.name, ready: m.ready, team: m.team }));
    return { info: this.info(room), members };
  }

  /** Answer with a refusal (a lobby member) or the error the relay closes on (a string). */
  #refuse(m: M, code: string, message: string): string | undefined {
    if (!m.lobby) return `${code}:${message}`;
    this.#send(m, { t: 'refused', code, message });
    return undefined;
  }

  list(m: M): void {
    const rooms = [...this.rooms.values()].filter((r) => !r.config.private).map((r) => this.info(r));
    this.#send(m, { t: 'rooms', rooms });
  }

  /** Returns `code:message` when a legacy member must be closed. */
  host(m: M, msg: RelayMessage): string | undefined {
    if (m.role !== 'new') return this.#refuse(m, 'state', 'Already in a room');
    const wanted = msg['room'];
    if (wanted !== undefined && (typeof wanted !== 'string' || !CODE.test(wanted))) return this.#refuse(m, 'room', 'A room code is 4–32 letters, digits, - or _');
    let code = typeof wanted === 'string' ? wanted : drawRoomCode();
    if (this.rooms.has(code)) {
      if (wanted !== undefined) return this.#refuse(m, 'room', `Room ${code} is taken`);
      while (this.rooms.has(code)) code = drawRoomCode();
    }
    const config = roomConfigOf(msg['config'], code, this.maxMembers);
    if (typeof config === 'string') return this.#refuse(m, 'config', config);
    const room: LobbyRoom<M> = { code, host: m, peers: new Map(), config, started: false, next: 0, order: [m] };
    this.rooms.set(code, room);
    m.role = 'host';
    m.joined = room;
    m.peerId = HOST_PEER;
    m.name = memberName(msg['name'], 'Host');
    m.ready = false;
    m.team = null;
    this.#send(m, { t: 'hosting', room: code });
    this.#changed(room);
    return undefined;
  }

  join(m: M, msg: RelayMessage): string | undefined {
    if (m.role !== 'new') return this.#refuse(m, 'state', 'Already in a room');
    const room = typeof msg['room'] === 'string' ? this.rooms.get(msg['room']) : undefined;
    if (room === undefined) return this.#refuse(m, 'room', 'No such room');
    if (room.order.length >= Math.min(room.config.maxPlayers, this.maxMembers)) return this.#refuse(m, 'full', 'The room is full');
    // A lobby member joins before the match; a legacy peer (a reloaded joiner) also after.
    if (m.lobby && room.started) return this.#refuse(m, 'started', 'The match already started');
    m.role = 'peer';
    m.joined = room;
    m.peerId = `peer-${room.next++}`;
    m.name = memberName(msg['name'], `Player ${room.order.length + 1}`);
    m.ready = false;
    m.team = null;
    room.peers.set(m.peerId, m);
    room.order.push(m);
    this.#send(m, { t: 'joined', room: room.code, peer: m.peerId });
    this.#changed(room);
    return undefined;
  }

  update(m: M, msg: RelayMessage): string | undefined {
    const room = m.joined as LobbyRoom<M> | undefined;
    if (room === undefined) return this.#refuse(m, 'state', 'Join or host a room first');
    const ready = msg['ready'];
    const team = msg['team'];
    if (ready !== undefined && typeof ready !== 'boolean') return this.#refuse(m, 'format', 'ready is true or false');
    if (team !== undefined && team !== null && (typeof team !== 'string' || team.length === 0 || team.length > 32)) {
      return this.#refuse(m, 'format', 'A team is a name of 1–32 characters, or null');
    }
    if (typeof ready === 'boolean') m.ready = ready;
    if (team !== undefined) m.team = team as string | null;
    this.#changed(room);
    return undefined;
  }

  start(m: M): string | undefined {
    const room = m.joined as LobbyRoom<M> | undefined;
    if (room === undefined || m.role !== 'host') return this.#refuse(m, 'state', 'Only the host starts the match');
    if (room.started) return this.#refuse(m, 'state', 'The match already started');
    room.started = true;
    this.#changed(room);
    return undefined;
  }

  /** The member leaves its room (on purpose, or its connection went away). Returns the peers a closing room dropped. */
  leave(m: M, gone: boolean): M[] {
    const room = m.joined as LobbyRoom<M> | undefined;
    if (room === undefined) return [];
    m.joined = undefined;
    m.role = 'new';
    if (!gone && m.lobby) this.#send(m, { t: 'left_room' });
    if (room.host === m) {
      this.rooms.delete(room.code);
      for (const peer of room.peers.values()) {
        peer.joined = undefined;
        peer.role = 'new';
        this.#send(peer, { t: 'left', peer: HOST_PEER });
        if (peer.lobby) this.#send(peer, { t: 'left_room' });
      }
      return [...room.peers.values()];
    }
    room.peers.delete(m.peerId);
    room.order.splice(room.order.indexOf(m), 1);
    this.#send(room.host, { t: 'left', peer: m.peerId });
    this.#changed(room);
    return [];
  }

  #changed(room: LobbyRoom<M>): void {
    const state = this.state(room);
    for (const m of room.order) if (m.lobby) this.#send(m, { t: 'room', state });
  }
}

/**
 * A lobby connection's side of the protocol: what the relay's messages say about the
 * listing, this member's room and the signals for the match. `WebSocketSignaling` and the
 * in-memory hub's endpoints feed it the messages they receive.
 */
export class LobbyView {
  rooms: readonly RoomInfo[] = [];
  room: RoomState | null = null;
  peer: string | null = null;
  refusal: { readonly code: string; readonly message: string } | null = null;
  version = 0;
  readonly inbox: { readonly from: string; readonly payload: string | null }[] = [];

  /** Apply one relay message; false when it is not a lobby or signal message. */
  apply(m: RelayMessage): boolean {
    switch (m['t']) {
      case 'rooms':
        this.rooms = Array.isArray(m['rooms']) ? m['rooms'] as RoomInfo[] : [];
        break;
      case 'hosting':
      case 'joined':
        this.peer = m['t'] === 'hosting' ? HOST_PEER : String(m['peer']);
        this.refusal = null;
        break;
      case 'room':
        this.room = m['state'] as RoomState;
        break;
      case 'left_room':
        this.room = null;
        this.peer = null;
        break;
      case 'refused':
        this.refusal = { code: String(m['code']), message: String(m['message']) };
        break;
      case 'signal':
        if (typeof m['from'] === 'string' && typeof m['payload'] === 'string') this.inbox.push({ from: m['from'], payload: m['payload'] });
        return true;
      case 'left':
        if (typeof m['peer'] === 'string') this.inbox.push({ from: m['peer'], payload: null });
        return true;
      default:
        return false;
    }
    this.version++;
    return true;
  }
}
