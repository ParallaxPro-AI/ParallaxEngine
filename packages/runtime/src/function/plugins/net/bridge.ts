/**
 * What the net plugin needs from outside the kernel, as interfaces: the api layer supplies
 * the Python-facing parts (player handles, RPC definitions, which fields replicate, the
 * visibility function), and the host supplies the session (role, transport) and the
 * runtime's input and presentation engines. The plugin imports none of them.
 */

import type { EntityId, LobbyConnection, NetLink, NetListener } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { FieldType } from '../../kernel/index.js';
import type { ActionFrame, WireFormat } from './protocol.js';

/** `field(replicate=...)`: True/"all", "owner", "team". */
export type Replicate = 'all' | 'owner' | 'team';

export type RunsOn = 'server' | 'client' | 'everywhere';

/**
 * Which game data replicates. Game components list their replicated fields (a component
 * with none is listed with an empty map and stays on the server); engine components are
 * not listed and replicate whole to every client that receives the entity. Resource
 * fields replicate to everyone.
 */
export interface ReplicationTable {
  readonly components: ReadonlyMap<string, ReadonlyMap<string, Replicate>>;
  readonly resources: ReadonlyMap<string, readonly string[]>;
}

export interface RpcParam {
  readonly name: string;
  /** The stored type: wire values decode against it. */
  readonly type: FieldType;
  /** Decoded value → what the function receives (a ContentRef, an Enum member…). */
  readonly present: (decoded: unknown, ctx: unknown) => unknown;
}

/** An `@rpc` function, as the server runs it. */
export interface RpcDef {
  readonly id: string;
  /** Calls per second per player; null: unlimited. */
  readonly rateLimit: number | null;
  /** The typed parameters a caller fills (the injected `player` is not among them). */
  readonly params: readonly RpcParam[];
  /** Run it: `fn(ctx, ...)` with `player` at its declared position and the rest in order. */
  call(ctx: unknown, player: unknown, args: readonly unknown[]): unknown;
}

/** The plugin's view of one seat, for the api's Player handles. */
export interface SeatView {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly local: boolean;
}

/** Supplied by the api layer when the game builds the plugin (`parallax.plugins.net`). */
export interface NetApiHost {
  /** Read at install, once every declaration is registered. */
  replication(): ReplicationTable;
  rpc(id: string): RpcDef | undefined;
  /** The game-facing `Player` for a seat (the same object for the same seat). */
  player(seat: SeatView): unknown;
}

/** A pointer as the input engine reads and takes it (`over`: an entity id on the reading side, a handle on the applying side). */
export interface NetPointer<Over> {
  readonly x: number;
  readonly y: number;
  readonly world: readonly [number, number, number] | null;
  readonly over: Over | null;
  readonly held: boolean;
  readonly pressed: boolean;
}

/** The runtime's input engine, as the plugin uses it. */
export interface NetInput {
  /**
   * `count` seats; those in `local` read this machine's devices, the rest only what `apply`
   * feeds them. Several local seats split the devices (split screen), unless `shared`: then
   * each reads all of them (a client's own seat and seat 0, which systems read).
   */
  seats(count: number, local: readonly number[], shared: boolean): void;
  /** This client's actions this frame (read through `seat`, as `owner`'s behaviors would). */
  capture(seat: number, owner: EntityId | null): ActionFrame;
  /** Feed a remote seat what its client sent. Returns the action names this game doesn't have. */
  apply(seat: number, frame: ActionFrame): string[];
  /** This machine's pointer, as a client sends it (`over`: the local entity under it). */
  pointer(): NetPointer<EntityId>;
  /** Feed a remote seat its client's pointer (`over`: the entity's handle here). */
  applyPointer(seat: number, pointer: NetPointer<unknown>): void;
  /** A remote seat left: it no longer reads a forwarded pointer. */
  releasePointer(seat: number): void;
}

/**
 * The runtime's one-shot feedback (DESIGN §6.5): panel feedback (toast, announce,
 * float_text, flash), sounds (`ctx.audio.play`) and effects (`ctx.vfx.play` / `beam`), as
 * the plugin forwards them. Entity references travel as SERVER entity ids.
 */
export interface NetFeedback {
  /** Requests made since the last call, encoded, with their recipient (a player id; null: everyone). */
  take(): { readonly item: Json; readonly to: string | null }[];
  /** Present one forwarded by the server; `entity` maps a server id to the handle here (null: not here). */
  play(item: Json, entity: (serverId: number) => unknown): void;
}

export interface RuntimeBridges {
  readonly input: NetInput;
  readonly feedback: NetFeedback;
}

/**
 * The lobby service a host process can use (`ctx.net.lobby`): browser — the reference relay
 * over a WebSocket, matches over WebRTC; headless — the in-memory hub and network.
 */
export interface LobbyPlatform {
  /** Open a lobby connection. */
  connect(): LobbyConnection;
  /** The host's door for its room's match, over the room's connection. */
  listener(connection: LobbyConnection): NetListener;
  /**
   * A joiner moves into the host's match: its process becomes the match's client (the
   * browser reloads into the join link). Called at the end of the frame `MatchStarting` was heard in.
   */
  joinMatch(connection: LobbyConnection, name: string): void;
}

/**
 * Who this process is in the match.
 *   host    authoritative, with `seats` players on this machine (a playtest's players, or a
 *           player hosting) and optionally remote clients through `listener`
 *   server  authoritative and headless: every player is remote (the dedicated server)
 *   client  a player's machine: renders the server's state and sends input and RPCs.
 *           `rejoin`: the token from an earlier connection (`NetClient.rejoinToken`), to take
 *           that seat back after a reload; `wire`: "json" speaks the readable debug form.
 */
export type NetSession =
  | {
    readonly role: 'host'; readonly seats: number; readonly names?: readonly string[]; readonly listener?: NetListener;
    /** Where `ctx.net.lobby` finds rooms (a game browsing, hosting or joining before its match). */
    readonly lobby?: LobbyPlatform;
  }
  | { readonly role: 'server'; readonly listener: NetListener }
  | { readonly role: 'client'; readonly link: NetLink; readonly name: string; readonly rejoin?: string; readonly wire?: WireFormat };
