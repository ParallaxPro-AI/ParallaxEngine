/**
 * The game-facing lobby (`ctx.net.lobby`, sdk/parallax/net.pyi): a game hosting or browsing
 * rooms before its match, over the session's `LobbyPlatform`.
 *
 * The relay owns the room (members, ready, team); this side reads what it last pushed. Each
 * frame's `input` hook notices a change and emits `LobbyChanged`; when the room's match
 * starts it emits `MatchStarting(code, seat)` and moves this process into the match:
 *
 *   host     keeps running: its server starts taking the members' links (`NetServer.listen`)
 *   joiner   leaves this game for the host's match at the end of the frame
 *            (`LobbyPlatform.joinMatch`; the browser reloads into the join link)
 *
 * The member list is kept as it was at the start, so the match can read seats and teams.
 */

import { fail, HOST_PEER } from '../../../core/index.js';
import type { LobbyConnection, RoomConfig, RoomInfo, RoomMember, RoomState } from '../../../core/index.js';
import type { EventDef, Kernel } from '../../kernel/index.js';
import type { LobbyPlatform } from './bridge.js';
import type { NetServer } from './server.js';

export const LOBBY_EVENTS = {
  changed: { id: 'lobby_changed' },
  starting: { id: 'match_starting' },
} as const satisfies Record<string, EventDef>;

export class NetLobby {
  readonly #platform: LobbyPlatform;
  readonly #kernel: Kernel;
  readonly #server: () => NetServer | undefined;
  readonly #maxPlayers: number;
  #connection: LobbyConnection | undefined;
  #seen = -1;
  #started: RoomState | null = null;
  #joining = false;
  #name = 'Player';

  constructor(platform: LobbyPlatform, kernel: Kernel, server: () => NetServer | undefined, maxPlayers: number) {
    this.#platform = platform;
    this.#kernel = kernel;
    this.#server = server;
    this.#maxPlayers = maxPlayers;
    kernel.addHook('input', () => this.#poll());
    kernel.addHook('render', () => this.#afterFrame(), { last: true });
  }

  #open(): LobbyConnection {
    if (this.#connection === undefined || this.#connection.state === 'closed') {
      this.#connection = this.#platform.connect();
      this.#seen = -1;
    }
    return this.#connection;
  }

  get connected(): boolean { return this.#connection !== undefined && this.#connection.state !== 'closed'; }
  get rooms(): readonly RoomInfo[] { return this.#connection?.rooms ?? []; }
  get room(): RoomState | null { return this.#started ?? this.#connection?.room ?? null; }
  get members(): readonly RoomMember[] { return this.room?.members ?? []; }
  get isHost(): boolean { return this.room !== null && this.#connection?.peer === HOST_PEER; }
  get seat(): number | null {
    const peer = this.#connection?.peer;
    return this.members.find((m) => m.peer === peer)?.seat ?? null;
  }
  get refusal(): { readonly code: string; readonly message: string } | null { return this.#connection?.refusal ?? null; }
  get started(): boolean { return this.#started !== null; }

  /** Ask for a fresh listing; the answer arrives with a `LobbyChanged`. */
  refresh(): void { this.#open().list(); }

  host(config: RoomConfig, name: string): void {
    if (config.maxPlayers > this.#maxPlayers) {
      fail('PP3365', `lobby.host(max_players=${config.maxPlayers}) is more than net(max_players=${this.#maxPlayers})`, {
        fix: `Use max_players=${this.#maxPlayers} or fewer, or raise net(max_players=).`,
      });
    }
    this.#notInRoom('host');
    this.#name = name;
    this.#open().host(config, name);
  }

  join(code: string, name: string): void {
    this.#notInRoom('join');
    this.#name = name;
    this.#open().join(code, name);
  }

  #notInRoom(what: string): void {
    if (this.room !== null) fail('PP3366', `lobby.${what}() while already in room ${this.room.info.code}`, { fix: 'Call ctx.net.lobby.leave() first.' });
  }

  #inRoom(what: string): LobbyConnection {
    const c = this.#connection;
    if (c === undefined || c.room === null) fail('PP3366', `lobby.${what}() needs a room`, { fix: 'Host or join a room first (ctx.net.lobby.host / join).' });
    if (this.#started !== null) fail('PP3366', `lobby.${what}() after the match started`);
    return c;
  }

  update(patch: { readonly ready?: boolean; readonly team?: string | null }): void { this.#inRoom('set_ready/set_team').update(patch); }

  start(): void {
    const c = this.#inRoom('start');
    if (c.peer !== HOST_PEER) fail('PP3367', 'Only the room\'s host starts the match', { fix: 'Check ctx.net.lobby.is_host; members wait for MatchStarting.' });
    c.start();
  }

  leave(): void {
    if (this.#started !== null) fail('PP3366', 'lobby.leave() after the match started', { fix: 'Leave the match itself (load another scene, or close the game).' });
    this.#connection?.leave();
  }

  #poll(): void {
    const c = this.#connection;
    if (c === undefined || this.#started !== null) return;
    if (c.version === this.#seen) return;
    this.#seen = c.version;
    this.#kernel.emit(LOBBY_EVENTS.changed, {});
    const room = c.room;
    if (room === null || !room.info.started) return;
    this.#started = room;
    const seat = room.members.find((m) => m.peer === c.peer)?.seat ?? 0;
    this.#kernel.emit(LOBBY_EVENTS.starting, { code: room.info.code, seat });
    if (c.peer === HOST_PEER) {
      const server = this.#server();
      if (server === undefined) fail('PP3364', 'A lobby host has no server to start the match on');
      server.listen(this.#platform.listener(c));
    } else {
      this.#joining = true;
    }
  }

  #afterFrame(): void {
    if (!this.#joining) return;
    this.#joining = false;
    this.#platform.joinMatch(this.#connection!, this.#name);
  }
}
