/**
 * plugins/net — server-authoritative online multiplayer (sdk/parallax/net.pyi).
 * The same game runs on the server; clients mirror the state it sends and send
 * input and RPCs. Transport is core's net port (`NetLink` / `NetListener`).
 *
 * A process is configured before its kernel is built (`configure(session, mode)`): a host
 * (the authority, with players on this machine and optionally remote ones), a dedicated
 * server (the authority, every player remote) or a client. A match starts with its players
 * assigned: a host's local players join as the first scene loads (their `PlayerJoined` is
 * heard before `SceneLoaded`). After the runtime has started, the host calls
 * `attach(bridges)` to wire input and presentation.
 *
 * `define` filters the game's definition for the role: a dedicated server drops
 * `runs_on="client"` systems; a client drops `runs_on="server"` ones (the default) and
 * makes every behavior inert (behaviors run on the server) — except the predicted ones
 * (`net(predict=[...])`), whose hooks run on this player's own entities only, so their
 * movement answers at once; their event handlers stay on the server. A host keeps everything.
 */

import { fail } from '../../../core/index.js';
import type { EntityId, Vec3 } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { encode } from '../../kernel/index.js';
import type {
  EventDef, FieldType, GameDefinition, Kernel, KernelPlugin, LogicInstance, SystemDef,
} from '../../kernel/index.js';
import { CHANNELS_SERVICE, PLAYERS_SERVICE } from '../../services/index.js';
import type { PlayerSeat, SeatInput } from '../../services/index.js';
import type { NetApiHost, NetSession, RunsOn, RuntimeBridges, SeatView } from './bridge.js';
import { NetClient } from './client.js';
import { LOBBY_EVENTS, NetLobby } from './lobby.js';
import type { CompensatedHit, RewoundPose } from './lag_compensation.js';
import { Origins } from './origins.js';
import { NetServer } from './server.js';
import type { RaycastFilter } from './server.js';

export type {
  LobbyPlatform, NetApiHost, NetFeedback, NetInput, NetPointer, NetSession, Replicate, ReplicationTable, RpcDef, RpcParam, RunsOn, RuntimeBridges,
  SeatView,
} from './bridge.js';
export type { ClientEnd, ClientStats } from './client.js';
export { NetClient } from './client.js';
export { LOBBY_EVENTS, NetLobby } from './lobby.js';
export type { CompensatedHit, RewoundPose } from './lag_compensation.js';
export type {
  ActionFrame, ActionValue, ClientMessage, EntityJson, InputFrame, PointerJson, PoseWire, SeatJson, ServerMessage, WireFormat,
} from './protocol.js';
export { checkClientMessage, MAX_CHANNEL_BYTES, MAX_CHANNEL_TOPIC, PROTOCOL } from './protocol.js';
export { decodeClient, decodeServer, encodeClient, encodeServer, wireSize } from './wire.js';
export { NetServer } from './server.js';
export type { RaycastFilter, Rejection } from './server.js';

export const NET_EVENTS = {
  joined: { id: 'player_joined' },
  left: { id: 'player_left' },
  rejoined: { id: 'player_rejoined' },
} as const satisfies Record<string, EventDef>;

/** Defaults of the tuning options (`net(...)` keywords). */
export const NET_DEFAULTS = {
  rejoinSeconds: 20,
  rewindWindow: 0.4,
  smoothing: 0.1,
  snapDistance: 3,
  maxExtrapolation: 0.1,
} as const;

export interface NetOptions {
  readonly maxPlayers: number;
  readonly playerPrefab: string;
  readonly tickRate: number;
  readonly mode: 'dedicated' | 'host';
  /** `net(visible=fn)`: `fn(ctx, player, entity)`, handles as game code sees them. */
  readonly visible?: (ctx: unknown, player: unknown, entity: unknown) => boolean;
  /** `net(predict=[...])`: ids of behaviors that also run on their owner's client. */
  readonly predict?: readonly string[];
  /** `net(interpolation=)`: a fixed interpolation delay in seconds (default: adaptive). */
  readonly interpolation?: number;
  /** `net(rejoin=)`: seconds a dropped player's seat is held (0: they leave at once). */
  readonly rejoinSeconds?: number;
  /** `net(rewind=)`: most seconds lag compensation rewinds. */
  readonly rewindWindow?: number;
  /** Seconds: the time constant of prediction's smooth correction. */
  readonly smoothing?: number;
  /** A prediction error longer than this snaps at once. */
  readonly snapDistance?: number;
  readonly host: NetApiHost;
  /** Builds `ctx.net` (the api's facade over this plugin). */
  readonly namespace: (plugin: NetPlugin) => object;
}

type Role = NetSession['role'];

export class NetPlugin implements KernelPlugin {
  readonly id = 'net';
  readonly events = [NET_EVENTS.joined, NET_EVENTS.left, LOBBY_EVENTS.changed, LOBBY_EVENTS.starting];
  readonly namespace: { readonly name: string; create(kernel: Kernel): object };
  readonly options: NetOptions;
  #session: NetSession | undefined;
  #mode: '2d' | '3d' = '3d';
  #kernel: Kernel | undefined;
  #origins: Origins | undefined;
  #server: NetServer | undefined;
  #client: NetClient | undefined;
  #lobby: NetLobby | undefined;
  #defined = false;
  #attached = false;
  readonly #handles = new Map<string, unknown>();

  constructor(options: NetOptions) {
    if (!Number.isInteger(options.maxPlayers) || options.maxPlayers < 1) {
      fail('PP3350', `net(max_players=${options.maxPlayers}) must be a whole number of at least 1`);
    }
    if (!Number.isInteger(options.tickRate) || options.tickRate < 1 || options.tickRate > 120) {
      fail('PP3350', `net(tick_rate=${options.tickRate}) must be a whole number from 1 to 120`);
    }
    const seconds = (name: string, value: number | undefined, max: number): void => {
      if (value !== undefined && !(value >= 0 && value <= max)) fail('PP3350', `net(${name}=${value}) must be from 0 to ${max} seconds`);
    };
    seconds('interpolation', options.interpolation, 1);
    seconds('rejoin', options.rejoinSeconds, 3600);
    seconds('rewind', options.rewindWindow, 1);
    this.options = options;
    this.namespace = { name: 'net', create: () => options.namespace(this) };
  }

  /** Who this process is, and the game's mode. Call before the runtime (and its kernel) is built. */
  configure(session: NetSession, mode: '2d' | '3d'): void {
    if (this.#kernel !== undefined) {
      fail('PP3356', 'net: the session was configured after the game started', { fix: 'Configure the net session before creating the runtime.' });
    }
    if (session.role === 'host' && (!Number.isInteger(session.seats) || session.seats < 1)) {
      fail('PP3350', `A host needs at least one local player, got ${session.seats}`);
    }
    this.#session = session;
    this.#mode = mode;
  }

  #sessionOrFail(): NetSession {
    if (this.#session === undefined) {
      fail('PP3356', 'net: no session was configured before the game was built', {
        fix: 'Hosts call prepareNet(game, session) before creating the runtime (boot does it for every net game).',
      });
    }
    return this.#session;
  }

  get role(): Role { return this.#sessionOrFail().role; }
  get isServer(): boolean { return this.role !== 'client'; }
  get server(): NetServer | undefined { return this.#server; }
  get client(): NetClient | undefined { return this.#client; }

  /** `ctx.net.lobby`: rooms before the match (a host session given a lobby platform). */
  get lobby(): NetLobby {
    if (this.#lobby === undefined) {
      fail('PP3368', 'ctx.net.lobby needs a lobby service, and this run has none', {
        fix: this.#session?.role === 'client'
          ? 'A match\'s client is already in its match; browse rooms before joining.'
          : 'Run where the platform provides one (the browser with ?lobby=ws://…, a playtest), or start the match directly.',
      });
    }
    return this.#lobby;
  }

  get hasLobby(): boolean { return this.#lobby !== undefined; }

  /** Filter the game's definition for this role (called by the kernel before its registry is built). */
  define(game: GameDefinition): GameDefinition {
    this.#defined = true;
    const role = this.#sessionOrFail().role;
    if (role === 'host') return game;
    // SystemDef carries `runsOn` once the api forwards @system(runs_on=); "server" is the SDK default.
    const runsOn = (def: SystemDef): RunsOn => (def as SystemDef & { readonly runsOn?: RunsOn }).runsOn ?? 'server';
    if (role === 'server') return { ...game, systems: game.systems.filter((s) => runsOn(s) !== 'client') };
    const predicted = new Set(this.options.predict ?? []);
    for (const id of predicted) {
      if (!game.behaviors.some((b) => b.id === id)) fail('PP3350', `net(predict=) names behavior "${id}", which the game doesn't have`);
    }
    return {
      ...game,
      systems: game.systems.filter((s) => runsOn(s) !== 'server'),
      behaviors: game.behaviors.map((b) => predicted.has(b.id)
        ? { ...b, handlers: [], create: () => this.#gated(b.create()) }
        : { ...b, handlers: [], create: (): LogicInstance => ({}) }),
    };
  }

  /** A predicted behavior's instance on a client: its hooks run only on this player's own entities. */
  #gated(instance: LogicInstance): LogicInstance {
    const gate = (self: LogicInstance): boolean => {
      const client = this.#client;
      const id = client === undefined ? undefined : this.#kernel?.handles.unwrap(self['entity']);
      return id !== undefined && client!.predicts(id);
    };
    for (const hook of ['start', 'update', 'fixed_update', 'late_update', 'end'] as const) {
      const fn = instance[hook];
      if (typeof fn !== 'function') continue;
      Object.defineProperty(instance, hook, {
        configurable: true,
        writable: true,
        value: function (this: LogicInstance, ...args: unknown[]): unknown {
          return gate(this) ? (fn as (...a: unknown[]) => unknown).apply(this, args) : undefined;
        },
      });
    }
    return instance;
  }

  install(kernel: Kernel): void {
    this.#kernel = kernel;
    this.#origins = new Origins(kernel);
    kernel.provide(PLAYERS_SERVICE, { seats: () => this.seats(), entity: (index) => this.entityOf(index) ?? null });
    const plugin = this;
    // Plugin messages (chat, voice signalling) on the session's reliable channel.
    kernel.provide(CHANNELS_SERVICE, {
      get role() { return plugin.isServer ? 'server' as const : 'client' as const; },
      send: (topic, payload, to) => (this.#server !== undefined ? this.#server.channelSend(topic, payload, to) : this.#client!.channelSend(topic, payload, to)),
      receive: (topic) => (this.#server !== undefined ? this.#server.channelReceive(topic) : this.#client!.channelReceive(topic)),
    });
    const session = this.#sessionOrFail();
    const o = this.options;
    if (session.role === 'client') {
      this.#client = new NetClient(kernel, this.#origins, session.link, session.name, {
        format: session.wire ?? 'binary',
        ...(session.rejoin !== undefined && { rejoin: session.rejoin }),
        ...(o.interpolation !== undefined && { interpolation: o.interpolation }),
        prediction: { smoothing: o.smoothing ?? NET_DEFAULTS.smoothing, snapDistance: o.snapDistance ?? NET_DEFAULTS.snapDistance },
        maxExtrapolation: NET_DEFAULTS.maxExtrapolation,
      });
    } else {
      const visible = this.options.visible;
      this.#server = new NetServer(kernel, {
        maxPlayers: this.options.maxPlayers,
        mode: this.#mode,
        locals: session.role === 'host'
          ? Array.from({ length: session.seats }, (_, i) => session.names?.[i] ?? `Player ${i + 1}`)
          : [],
        playerPrefab: this.options.playerPrefab,
        tickRate: this.options.tickRate,
        visible,
        rejoinSeconds: o.rejoinSeconds ?? NET_DEFAULTS.rejoinSeconds,
        rewindWindow: o.rewindWindow ?? NET_DEFAULTS.rewindWindow,
      }, this.options.host, (seat) => this.#player(seat), this.#origins, session.listener, NET_EVENTS);
      if (session.role === 'host' && session.lobby !== undefined) {
        this.#lobby = new NetLobby(session.lobby, kernel, () => this.#server, this.options.maxPlayers);
      }
    }
  }

  /** The runtime exists and its first scene loaded: wire its input and presentation. */
  attach(bridges: RuntimeBridges): void {
    if (this.#kernel === undefined) fail('PP3356', 'net: attach() before the game was built');
    if (this.#attached) fail('PP3356', 'net: attach() was called twice');
    const session = this.#sessionOrFail();
    if (session.role !== 'host' && !this.#defined) {
      fail('PP9353', `A net ${session.role} needs the kernel to apply plugin definition filters (KernelPlugin.define)`, {
        fix: 'Run on an engine build whose kernel calls plugin.define(game) before building its registry.',
      });
    }
    this.#attached = true;
    if (session.role === 'client') this.#client!.attach(bridges);
    else this.#server!.attach(bridges);
  }

  // ── What ctx.net and ctx.players read ───────────────────────────────────────

  #player(view: SeatView): unknown {
    const key = `${view.index}:${view.id}:${view.name}:${String(view.local)}`;
    let handle = this.#handles.get(key);
    if (handle === undefined) {
      handle = this.options.host.player({ index: view.index, id: view.id, name: view.name, local: view.local });
      this.#handles.set(key, handle);
    }
    return handle;
  }

  /**
   * The players service's seats: everyone in play (a leaver until the end of the frame they
   * left in). Remote seats read no device on this machine; their input comes over the network.
   */
  seats(): PlayerSeat[] {
    const views: readonly SeatView[] = this.#server !== undefined
      ? this.#server.allSeats()
      : this.#client!.players.map((p) => ({ index: p.index, id: p.id, name: p.name, local: p.index === this.#client!.seat?.index }));
    const locals = views.filter((v) => v.local).map((v) => v.index);
    return views.map((v) => ({ index: v.index, id: v.id, name: v.name, local: v.local, input: seatInput(v.index, locals) }));
  }

  /** Game-facing Player handles of every seat in play. */
  players(): unknown[] {
    if (this.#server !== undefined) return this.#server.seats.map((s) => this.#player(s));
    const client = this.#client!;
    const mine = client.seat?.index;
    return client.players.map((p) => this.#player({ index: p.index, id: p.id, name: p.name, local: p.index === mine }));
  }

  /** The entity a seat controls, while it exists here. */
  entityOf(index: number): EntityId | undefined {
    if (this.#server !== undefined) return this.#server.entityOf(index);
    const client = this.#client!;
    return client.local(client.players.find((p) => p.index === index)?.entity ?? null);
  }

  /** An entity id as game code sees it (an `Entity`). */
  entityHandle(id: EntityId): unknown {
    return this.#kernel!.handles.wrap(id);
  }

  /** This machine's player: a client's own seat; a host's first local seat; none on a dedicated server. */
  localIndex(): number | undefined {
    if (this.#client !== undefined) return this.#client.seat?.index;
    return this.#server!.seats.find((s) => s.local)?.index;
  }

  teamOf(index: number): string | null {
    if (this.#server !== undefined) return this.#server.teamOf(index);
    const entity = this.entityOf(index);
    const side = entity === undefined ? undefined : this.#kernel!.world.get(entity)?.components.get('side')?.['side'];
    return typeof side === 'string' ? side : null;
  }

  /** `ctx.net.raycast(player, ...)`: a hit test as `index`'s player saw the world (server only). */
  rewindRaycast(index: number, origin: Vec3, direction: Vec3, maxDistance: number, filter: RaycastFilter): CompensatedHit | undefined {
    return this.#serverOnly('ctx.net.raycast()').rewindRaycast(index, origin, direction, maxDistance, filter);
  }

  /** `ctx.net.seen_position(entity, player)`: where `index`'s player saw `entity` (server only). */
  seenPose(entity: EntityId, index: number): RewoundPose {
    return this.#serverOnly('ctx.net.seen_position()').seenPose(entity, index);
  }

  #serverOnly(what: string): NetServer {
    if (this.#server === undefined) {
      fail('PP3352', `${what} runs on the server`, { fix: 'Call it from server code: a system, a behavior or an @rpc.' });
    }
    return this.#server;
  }

  respawn(index: number, at: EntityId | undefined): EntityId {
    if (this.#server === undefined) {
      fail('PP3352', 'ctx.net.respawn() runs on the server', { fix: 'Call it from server code: a system, a behavior or an @rpc.' });
    }
    return this.#server.respawn(index, at);
  }

  /**
   * Call an RPC as `seat` (a local player on a host) or as this client. `args` are game
   * values with their stored types; they are encoded (and, on a server, decoded again) so
   * a local call is checked exactly like a remote one.
   */
  call(rpc: string, args: Readonly<Record<string, { readonly type: FieldType; readonly value: unknown }>>, seat?: number): void {
    if (this.#client !== undefined) {
      this.#client.call(rpc, args);
      return;
    }
    const index = seat ?? this.localIndex();
    if (index === undefined) {
      fail('PP3352', 'A dedicated server has no local player to call an RPC as', { fix: 'RPCs are called by clients; on the server, call the function itself.' });
    }
    const kernel = this.#kernel!;
    const codec = { encode: (handle: unknown) => kernel.handles.unwrap(handle) ?? null, decode: () => fail('PP9355', 'not used') };
    const encoded: Record<string, Json> = {};
    for (const [name, { type, value }] of Object.entries(args)) {
      encoded[name] = encode(type, value, `RPC "${rpc}" argument "${name}"`, codec);
    }
    this.#server!.call(index, rpc, encoded as JsonObject);
  }

  snapshot(): Json {
    return { origins: this.#origins!.save() as unknown as Json, server: (this.#server?.save() ?? null) as unknown as Json };
  }

  restore(kernel: Kernel, state: Json): void {
    const saved = state as unknown as { origins: ReturnType<Origins['save']>; server: ReturnType<NetServer['save']> | null };
    this.#origins!.load(saved.origins, (id) => kernel.world.isAlive(id));
    if (saved.server !== null) this.#server?.load(saved.server);
  }
}

/**
 * Which devices a seat reads on this machine: none for a remote player; every device when
 * one player plays here; with several, the first keeps keyboard, mouse and touch and each
 * takes the gamepad in its slot.
 */
export function seatInput(index: number, locals: readonly number[]): SeatInput {
  const order = locals.indexOf(index);
  if (order === -1) return { keyboard: false, mouse: false, touch: false, gamepad: null };
  if (locals.length === 1) return { keyboard: true, mouse: true, touch: true, gamepad: 'any' };
  return { keyboard: order === 0, mouse: order === 0, touch: order === 0, gamepad: order };
}

export function net(options: NetOptions): NetPlugin {
  return new NetPlugin(options);
}
