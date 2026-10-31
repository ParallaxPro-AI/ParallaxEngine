/**
 * An in-memory signalling relay and lobby (the `Signaling` / `LobbyConnection` ports,
 * headless), for tests and playtests in one process. It answers the same protocol as the
 * reference relay (`packages/server/src/signaling.ts`) through core's `LobbyRooms`.
 *
 *   host() / join()   one host and its peers (tests of the WebRTC adapter)
 *   connect()         a lobby connection: list rooms, host or join one, ready, team, start
 *   network(code)     the room's match transport: an in-memory network whose listener the
 *                     host serves and whose links its members connect with
 *
 * Messages are readable at the receiver's next `receive()`; lobby state changes at once.
 */

import { fail, HOST_PEER, LobbyRooms, LobbyView } from '../../core/index.js';
import type {
  LobbyConnection, LobbyMember, LobbyRoom, NetLink, NetLinkState, NetListener, RelayMessage, RoomConfig, RoomInfo, RoomState, SignalMessage,
} from '../../core/index.js';
import { LoopbackNetwork } from './net.js';
import type { LoopbackOptions } from './net.js';

class Endpoint implements LobbyConnection, LobbyMember {
  lobby: boolean;
  role: 'new' | 'host' | 'peer' = 'new';
  joined: LobbyRoom<Endpoint> | undefined = undefined;
  peerId = '';
  name = '';
  ready = false;
  team: string | null = null;
  readonly view = new LobbyView();
  readonly #hub: MemorySignalingHub;
  #state: NetLinkState = 'open';
  #reason: string | null = null;

  constructor(hub: MemorySignalingHub, lobby: boolean) {
    this.#hub = hub;
    this.lobby = lobby;
  }

  get id(): string { return this.peerId; }
  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }
  get rooms(): readonly RoomInfo[] { return this.view.rooms; }
  get version(): number { return this.view.version; }
  get refusal(): { readonly code: string; readonly message: string } | null { return this.view.refusal; }
  get room(): RoomState | null { return this.view.room; }
  get peer(): string | null { return this.view.peer; }

  send(to: string, payload: string): void {
    if (this.#state !== 'open') return;
    this.#hub.relay(this, to, payload);
  }

  receive(): SignalMessage[] {
    return this.view.inbox.splice(0);
  }

  list(): void { this.#request(() => { this.#hub.rooms.list(this); return undefined; }); }
  host(config: RoomConfig, name: string): void {
    this.#request(() => this.#hub.rooms.host(this, {
      config: { name: config.name, max_players: config.maxPlayers, private: config.private, mode: config.mode, map: config.map }, name,
    }));
  }
  join(code: string, name: string): void { this.#request(() => this.#hub.rooms.join(this, { room: code, name })); }
  update(patch: { readonly ready?: boolean; readonly team?: string | null }): void { this.#request(() => this.#hub.rooms.update(this, patch)); }
  start(): void { this.#request(() => this.#hub.rooms.start(this)); }
  leave(): void { this.#request(() => { this.#hub.rooms.leave(this, false); return undefined; }); }

  #request(run: () => string | undefined): void {
    if (this.#state !== 'open') return;
    const error = run();
    if (error !== undefined) fail('PP9358', `The signalling hub refused: ${error}`);
  }

  close(reason = 'closed'): void {
    if (this.#state === 'closed') return;
    this.ended(reason);
    this.#hub.gone(this);
  }

  ended(reason: string): void {
    this.#state = 'closed';
    this.#reason = reason;
  }
}

export class MemorySignalingHub {
  readonly rooms: LobbyRooms<Endpoint>;
  readonly #networks = new Map<string, LoopbackNetwork>();
  readonly #networkOptions: LoopbackOptions;
  #legacy: Endpoint | undefined;
  /** Payloads relayed so far (tests). */
  relayed = 0;

  constructor(options: { readonly maxMembers?: number; readonly network?: LoopbackOptions } = {}) {
    this.rooms = new LobbyRooms<Endpoint>((m, message) => this.#deliver(m, message), options.maxMembers ?? 17);
    this.#networkOptions = options.network ?? {};
  }

  /** A lobby connection (open at once). */
  connect(): LobbyConnection {
    return new Endpoint(this, true);
  }

  /** The room's match transport (made on first use, gone with the room). */
  network(code: string): LoopbackNetwork {
    if (!this.rooms.rooms.has(code)) fail('PP9358', `No room "${code}" on this signalling hub`);
    let network = this.#networks.get(code);
    if (network === undefined) {
      network = new LoopbackNetwork(this.#networkOptions);
      this.#networks.set(code, network);
    }
    return network;
  }

  /** Every room's match transport, for tests that advance their network clocks. */
  get networks(): readonly LoopbackNetwork[] { return [...this.#networks.values()]; }

  /**
   * The net plugin's lobby platform over this hub: the host serves the room's in-memory
   * network; a joiner's move into the match is `joinMatch(link, name, code)` with a link on
   * it (a test builds the joiner's client runtime there). Without `joinMatch` a joiner fails.
   */
  platform(joinMatch?: (link: NetLink, name: string, code: string) => void): {
    connect(): LobbyConnection;
    listener(connection: LobbyConnection): NetListener;
    joinMatch(connection: LobbyConnection, name: string): void;
  } {
    const codeOf = (c: LobbyConnection): string => {
      if (c.room === null) fail('PP9359', 'The lobby connection is in no room');
      return c.room.info.code;
    };
    return {
      connect: () => this.connect(),
      listener: (c) => this.network(codeOf(c)).listen(),
      joinMatch: (c, name) => {
        if (joinMatch === undefined) fail('PP9359', 'This in-memory lobby has no way to move a joiner into the match', { fix: 'Pass joinMatch to MemorySignalingHub.platform().' });
        const code = codeOf(c);
        joinMatch(this.network(code).connect(), name, code);
      },
    };
  }

  host(): LobbyConnection {
    if (this.#legacy !== undefined && this.#legacy.state === 'open') fail('PP9358', 'This signalling hub already has a host');
    const host = new Endpoint(this, false);
    this.rooms.host(host, { room: 'memory-room' });
    this.#legacy = host;
    return host;
  }

  join(): LobbyConnection {
    if (this.#legacy === undefined || this.#legacy.state !== 'open') fail('PP9358', 'Nobody is hosting on this signalling hub');
    const peer = new Endpoint(this, false);
    const error = this.rooms.join(peer, { room: 'memory-room' });
    if (error !== undefined) fail('PP9358', `The signalling hub refused: ${error}`);
    return peer;
  }

  #deliver(m: Endpoint, message: RelayMessage): void {
    if (m.state !== 'open') return;
    m.view.apply(message);
  }

  /** @internal */ relay(from: Endpoint, to: string, payload: string): void {
    const room = from.joined as LobbyRoom<Endpoint> | undefined;
    if (room === undefined) return;
    // A peer only ever talks to the host; the host to its own peers.
    const target = from.role === 'peer' ? (to === HOST_PEER ? room.host : undefined) : room.peers.get(to);
    if (target === undefined || target.state !== 'open') return;
    this.relayed++;
    target.view.inbox.push({ from: from.peerId, payload });
  }

  /** @internal */ gone(m: Endpoint): void {
    const room = m.joined as LobbyRoom<Endpoint> | undefined;
    for (const peer of this.rooms.leave(m, true)) if (!peer.lobby) peer.ended('the host left');
    if (room !== undefined && room.host === m) this.#networks.delete(room.code);
  }
}
