/**
 * The network port: message links between a game server and its clients, and the
 * signalling a browser-hosted match needs to open them. The net plugin speaks its protocol
 * over these and never touches a socket.
 *
 * Messages are whole frames: binary (the protocol's normal form) or text (its JSON debug
 * form). Each is sent on a channel:
 *
 *   reliable    ordered and never lost (state changes, RPCs, handshakes)
 *   unreliable  may be lost or reordered (per-tick transform snapshots, input). A link
 *               without one (`unreliable === false`, e.g. a WebSocket) sends these reliably.
 *
 * Links are pull-based: what arrived is drained with `receive()` at a point the kernel
 * chooses (the frame's `input` hook), so a frame sees exactly the messages that had arrived
 * when it began — the same order on every run when the transport is deterministic (the
 * in-memory loopback).
 *
 * Adapters: `platform/headless/net.ts` (an in-memory network with injectable latency,
 * jitter and loss), `platform/browser/net.ts` (a WebSocket client),
 * `platform/browser/net_webrtc.ts` (a player's browser hosting over RTCDataChannels), and
 * the dedicated server's WebSocket listener (`packages/server`).
 */

export type NetLinkState = 'connecting' | 'open' | 'closed';

/** One message: bytes (binary protocol) or text (the JSON debug protocol). */
export type NetMessage = string | Uint8Array;

export type NetChannel = 'reliable' | 'unreliable';

/** One end of a connection. */
export interface NetLink {
  /** Unique per listener (server side) or per connection (client side). */
  readonly id: string;
  readonly state: NetLinkState;
  /** Why the link closed (a peer's reason, or the transport's error); null while not closed. */
  readonly closeReason: string | null;
  /** True when `unreliable` sends really are unreliable (worth sending redundantly). */
  readonly unreliable: boolean;
  /**
   * Who is on the other end, when the host verified it before the game saw the link (a
   * match ticket checked by the orchestrator). The server then uses this name and seat
   * instead of what the client claims, and the identity also takes a held seat back.
   */
  readonly identity?: NetIdentity;
  /**
   * Queue one message (default channel: reliable). Sending on a closed link is a no-op.
   * Messages sent while `connecting` are delivered once the link opens.
   */
  send(message: NetMessage, channel?: NetChannel): void;
  /** Every message that arrived since the last call, oldest first. */
  receive(): NetMessage[];
  close(reason?: string): void;
}

/** A player the host vouches for. */
export interface NetIdentity {
  /** Stable for the player (an account id): a returning link with the same id rejoins. */
  readonly id: string;
  readonly name: string;
  /** The seat the match assigned them, or null for the first free one. */
  readonly seat: number | null;
}

/** The server's door: links that connected since the last `accept()`. */
export interface NetListener {
  accept(): NetLink[];
  close(): void;
}

/**
 * Signalling for peer-to-peer links (a player's browser hosting the match): a relay that
 * passes short text messages between the host and the peers joining its room. A host
 * implements it (its own lobby service, or the reference WebSocket relay in
 * `packages/server`); the WebRTC adapter only needs this.
 *
 * The host sees each peer by an id the relay assigns; a peer always talks to `HOST_PEER`.
 */
export interface Signaling {
  readonly state: NetLinkState;
  readonly closeReason: string | null;
  /** Relay `payload` to `to` (a peer id; a joining peer sends to `HOST_PEER`). */
  send(to: string, payload: string): void;
  /** Messages since the last call, oldest first. `payload: null` means that peer left the room. */
  receive(): SignalMessage[];
  close(reason?: string): void;
}

export interface SignalMessage {
  readonly from: string;
  readonly payload: string | null;
}

/** The address a joining peer uses for the host. */
export const HOST_PEER = 'host';

// ── Lobbies ───────────────────────────────────────────────────────────────────

/** What a host chooses for its room. `mode` and `map` are the game's own words. */
export interface RoomConfig {
  readonly name: string;
  /** Most members, the host included. */
  readonly maxPlayers: number;
  /** A private room is not listed: players join it by its code. */
  readonly private: boolean;
  readonly mode: string;
  readonly map: string;
}

/** A room as the listing shows it. */
export interface RoomInfo extends RoomConfig {
  readonly code: string;
  /** Members now, the host included. */
  readonly players: number;
  /** The host started the match (late joiners still connect to it). */
  readonly started: boolean;
}

/** A member of the room this connection is in. Seat 0 is the host. */
export interface RoomMember {
  /** The relay's id for the member: `HOST_PEER` for the host. */
  readonly peer: string;
  readonly seat: number;
  readonly name: string;
  readonly ready: boolean;
  readonly team: string | null;
}

export interface RoomState {
  readonly info: RoomInfo;
  readonly members: readonly RoomMember[];
}

/**
 * A lobby connection: list the rooms, then host or join one. Inside a room the relay keeps
 * its state (members, ready, team) and pushes it to every member; when the host starts the
 * match the same connection is the room's `Signaling` for the match's peer links.
 *
 * Pull-based like the rest of the port: `rooms` and `room` are the newest the relay sent,
 * `version` grows every time either changes, and refusals (no such room, the room is full
 * or started) arrive as `refusal` without closing the connection.
 */
export interface LobbyConnection extends Signaling {
  /** The newest public room listing (empty before the first `list()` answer). */
  readonly rooms: readonly RoomInfo[];
  /** The room this connection is in, or null. */
  readonly room: RoomState | null;
  /** This connection's peer id in its room (`HOST_PEER` when hosting), or null. */
  readonly peer: string | null;
  /** The last request the relay refused (`{ code, message }`), cleared by the next accepted one. */
  readonly refusal: { readonly code: string; readonly message: string } | null;
  /** Grows whenever `rooms`, `room` or `refusal` changes. */
  readonly version: number;
  /** Ask for a fresh public listing. */
  list(): void;
  host(config: RoomConfig, name: string): void;
  join(code: string, name: string): void;
  /** Change this member's ready flag and/or team. */
  update(patch: { readonly ready?: boolean; readonly team?: string | null }): void;
  /** The host starts the match: every member's `room.info.started` becomes true. */
  start(): void;
  /** Leave the room (the connection stays, back to listing). A host leaving closes the room. */
  leave(): void;
}
