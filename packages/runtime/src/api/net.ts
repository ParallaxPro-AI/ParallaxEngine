/**
 * `parallax.net` (sdk/parallax/net.pyi): `@rpc`, `PlayerJoined` / `PlayerLeft`, `ctx.net`,
 * and the `net(...)` plugin factory `parallax.plugins` re-exports. The networking itself
 * is the net plugin (`function/plugins/net/`); this module is its Python-facing names and
 * the glue to the runtime: Player handles, typed RPC arguments, which declared fields
 * replicate, and the input and presentation bridges.
 *
 * Hosts: `prepareNet(game, session)` before the runtime is built (who this process is; a
 * host with one local player when no session is given), then `attachNet(runtime)` once it
 * has started.
 */

import { Color, fail, Vec2, Vec3 } from '../core/index.js';
import type { EntityId, UiFloatStyle } from '../core/index.js';
import { LOBBY_EVENTS, net as netPlugin, NET_EVENTS, NetPlugin, seatInput } from '../function/plugins/net/index.js';
import type { NetLobby } from '../function/plugins/net/index.js';
import type { RoomInfo, RoomMember } from '../core/index.js';
import type {
  ActionFrame, ActionValue, NetApiHost, NetFeedback, NetInput, NetSession, Replicate, ReplicationTable, RpcDef, SeatView,
} from '../function/plugins/net/index.js';
import type { AudioEngine } from '../function/plugins/audio/index.js';
import type { ActionDecl, InputEngine } from '../function/plugins/input/index.js';
import type { PanelAction, UiEngine, UiRequest } from '../function/plugins/ui/index.js';
import { HudEngine } from '../function/plugins/hud/index.js';
import type { FieldType } from '../function/kernel/index.js';
import type { Json } from '../resource/index.js';
import { Player } from './context.js';
import type { Context } from './context.js';
import { declarations } from './declarations.js';
import { Entity } from './entity.js';
import { eventHandle } from './events.js';
import type { Game } from './game.js';
import { bindArgs, kw } from './kwargs.js';
import { truthy } from './py.js';
import type { GameRuntime } from './runtime.js';
import { coerce, Localized, PrefabRef, resolveType, schemaOf, TextRef } from './types.js';
import type { ApiType, CoerceEnv, ContentClass } from './types.js';

export type { NetSession } from '../function/plugins/net/index.js';

// ── Events ─────────────────────────────────────────────────────────────────────

/** A player joined; their entity (when the scene has PlayerStarts) already exists. */
export const PlayerJoined = eventHandle(NET_EVENTS.joined, 'PlayerJoined');
/** A player left; their entity is still alive during the handlers, and destroyed at the end of the frame. */
export const PlayerLeft = eventHandle(NET_EVENTS.left, 'PlayerLeft');
/** A player whose connection dropped came back within the rejoin window (same seat, same entity). */
export const PlayerRejoined = eventHandle(NET_EVENTS.rejoined, 'PlayerRejoined');
/** The lobby changed: the room listing, this room's members (ready, team), or the room itself. */
export const LobbyChanged = eventHandle(LOBBY_EVENTS.changed, 'LobbyChanged');
/** The host started the room's match: `code`, and this member's `seat` (0 is the host). */
export const MatchStarting = eventHandle(LOBBY_EVENTS.starting, 'MatchStarting');

// ── Players ────────────────────────────────────────────────────────────────────

/** A seat in a networked game: `entity` is the entity the net plugin spawned for it. */
class NetPlayer extends Player {
  readonly #entity: () => Entity | null;

  constructor(seat: SeatView, entity: () => Entity | null) {
    super(seat.id, seat.name, seat.index, seat.local);
    this.#entity = entity;
  }

  override get entity(): Entity | null { return this.#entity(); }
}

// ── RPCs ───────────────────────────────────────────────────────────────────────

const RPC = Symbol.for('parallax.rpc');

interface RpcMark {
  readonly id: string;
  readonly rateLimit: number | null;
  readonly fn: (...args: unknown[]) => unknown;
  /** Resolved on first use (annotations are thunks: later classes may be named). */
  resolved?: { readonly player: string; readonly params: readonly { readonly name: string; readonly type: ApiType }[] };
}

let rpcs = new Map<string, RpcMark>();

/** Forget the game's RPCs (a fresh module realm; `resetDeclarations` calls this). */
export function resetRpcs(): void {
  rpcs = new Map();
}

function markOf(value: unknown): RpcMark | undefined {
  return typeof value === 'function' ? (value as unknown as Record<symbol, RpcMark | undefined>)[RPC] : undefined;
}

export function isRpc(value: unknown): boolean {
  return markOf(value) !== undefined;
}

/** `@rpc("buy_item", rate_limit=5)`: a client → server call; the server injects `player`. */
export function rpc(...args: unknown[]): <F>(fn: F) => F {
  const a = bindArgs('rpc', args, { positional: ['id'], keyword: ['rate_limit'], required: ['id'] }).args;
  const id = a['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id)) fail('PP4360', `@rpc id ${JSON.stringify(id)} must be snake_case`);
  const rate = a['rate_limit'] ?? null;
  if (rate !== null && (typeof rate !== 'number' || !(rate > 0))) {
    fail('PP4360', `@rpc("${id}") rate_limit= must be calls per second (a positive number) or None, got ${String(rate)}`);
  }
  return <F>(fn: F): F => {
    if (typeof fn !== 'function') fail('PP4360', `@rpc("${id}") decorates a function`);
    if (rpcs.has(id)) fail('PP4361', `Two RPCs are named "${id}"`, { fix: 'Give each @rpc its own id.' });
    const mark: RpcMark = { id, rateLimit: rate, fn: fn as unknown as (...args: unknown[]) => unknown };
    Object.defineProperty(fn, RPC, { value: mark });
    rpcs.set(id, mark);
    return fn;
  };
}

function resolved(mark: RpcMark): NonNullable<RpcMark['resolved']> {
  if (mark.resolved !== undefined) return mark.resolved;
  const annotations = (mark.fn as { __annotations__?: Record<string, () => unknown> }).__annotations__ ?? {};
  let player: string | undefined;
  const params: { name: string; type: ApiType }[] = [];
  for (const [name, thunk] of Object.entries(annotations)) {
    if (name === 'return' || name === 'ctx') continue;
    const annotation = thunk();
    if (annotation === Player || (typeof annotation === 'function' && annotation.prototype instanceof Player)) {
      player = name;
      continue;
    }
    params.push({ name, type: resolveType(annotation, `@rpc("${mark.id}") parameter "${name}"`) });
  }
  if (player === undefined) {
    fail('PP4362', `@rpc("${mark.id}") has no parameter annotated Player`, {
      fix: `Declare it as def ${mark.id}(ctx, player: Player, ...): the server passes the calling player.`,
    });
  }
  mark.resolved = { player, params };
  return mark.resolved;
}

function envOf(ctx: unknown): CoerceEnv {
  return { content: (target: ContentClass, id: string) => (ctx as Context).content(target).get(id) };
}

function rpcDef(mark: RpcMark): RpcDef {
  const { player, params } = resolved(mark);
  return {
    id: mark.id,
    rateLimit: mark.rateLimit,
    params: params.map((p) => ({
      name: p.name,
      type: p.type.field,
      present: (decoded: unknown, ctx: unknown) => coerce(p.type, decoded, envOf(ctx), `@rpc("${mark.id}").${p.name}`),
    })),
    call: (ctx, who, values) => {
      const named: Record<string, unknown> = { [player]: who };
      params.forEach((p, i) => { named[p.name] = values[i]; });
      return mark.fn(ctx, kw(named));
    },
  };
}

/** The plugin of the running game, for the facades below. */
function pluginOf(ctx: unknown): NetPlugin {
  const ns = (ctx as { net?: NetApi }).net;
  if (!(ns instanceof NetApi)) fail('PP3352', 'This game has no net plugin', { fix: 'Add net(...) to Game(plugins=[...]).' });
  return ns.plugin;
}

/** Encode-ready arguments: each parameter's stored type and the game value. */
function typedArgs(mark: RpcMark, values: Readonly<Record<string, unknown>>): Record<string, { type: FieldType; value: unknown }> {
  const { params } = resolved(mark);
  const out: Record<string, { type: FieldType; value: unknown }> = {};
  for (const [name, value] of Object.entries(values)) {
    const p = params.find((x) => x.name === name);
    if (p === undefined) {
      fail('PP3355', `RPC "${mark.id}" has no parameter "${name}"`, { fix: `Its parameters: ${params.map((x) => x.name).join(', ') || '(none)'}.` });
    }
    out[name] = { type: p.type.field, value };
  }
  for (const p of params) if (!(p.name in out)) fail('PP3355', `RPC "${mark.id}" needs "${p.name}"`);
  return out;
}

/** A function panel action whose `run` also receives the clicking seat (the ui engine's `Click.seat`). */
export type RpcPanelAction = Omit<Extract<PanelAction, { kind: 'call' }>, 'run'> & {
  run(ctx: unknown, args: readonly unknown[], panel: unknown, seat: number): unknown;
};

/**
 * An `@rpc` used as a panel action (`actions = {"buy": buy_item}`): its typed parameters
 * are filled from the clicked element; the call goes to the server as the clicking seat.
 * For the ui layer's `panelAction` (seat-aware `run`).
 */
export function rpcPanelAction(value: unknown): RpcPanelAction {
  const mark = markOf(value);
  if (mark === undefined) fail('PP4360', `${String(value)} is not an @rpc function`);
  const { params } = resolved(mark);
  return {
    kind: 'call',
    params: params.map((p) => ({ name: p.name, type: p.type.field })),
    run: (ctx: unknown, args: readonly unknown[], _panel: unknown, seat: number) => {
      const named = Object.fromEntries(params.map((p, i) => [p.name, args[i]]));
      pluginOf(ctx).call(mark.id, typedArgs(mark, named), seat);
      return null;
    },
  };
}

// ── Replication table ──────────────────────────────────────────────────────────

function rule(value: true | false | 'all' | 'owner' | 'team' | undefined): Replicate | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? 'all' : value;
}

function replicationTable(): ReplicationTable {
  const declared = declarations();
  const components = new Map<string, Map<string, Replicate>>();
  for (const cls of declared.components) {
    const id = (cls as unknown as { __component_id__: string }).__component_id__;
    const fields = new Map<string, Replicate>();
    for (const f of schemaOf(cls, `component ${cls.name}`).fields) {
      const r = rule(f.decl?.replicate);
      if (r !== undefined) fields.set(f.name, r);
    }
    components.set(id, fields);
  }
  const resources = new Map<string, string[]>();
  for (const cls of declared.resources) {
    const id = (cls as unknown as { __resource_id__: string }).__resource_id__;
    const names: string[] = [];
    for (const f of schemaOf(cls, `resource ${cls.name}`).fields) {
      const r = rule(f.decl?.replicate);
      if (r === undefined) continue;
      if (r !== 'all') {
        fail('PP4363', `resource ${cls.name}.${f.name} has replicate="${r}"; a resource has no owner or team`, {
          fix: 'Use replicate=True (every client), or keep per-player values on the player\'s entity.',
        });
      }
      if (f.live) fail('PP4363', `resource ${cls.name}.${f.name} is a Handle, which can't replicate`);
      names.push(f.name);
    }
    if (names.length > 0) resources.set(id, names);
  }
  for (const cls of declared.behaviors) {
    for (const f of schemaOf(cls, `behavior ${cls.name}`).fields) {
      if (f.role === 'state' && rule(f.decl?.replicate) !== undefined) {
        fail('PP4364', `behavior ${cls.name}.${f.name} is state(replicate=...); behaviors run only on the server, so their state isn't replicated`, {
          fix: 'Keep a value clients need in a component field with replicate=.',
        });
      }
    }
  }
  return { components, resources };
}

// ── ctx.net ────────────────────────────────────────────────────────────────────

function playerIndex(value: unknown, where: string): number {
  if (!(value instanceof Player)) fail('PP3352', `${where} takes a Player, got ${String(value)}`);
  return value.index;
}

export class NetApi {
  readonly plugin: NetPlugin;
  /** Rooms before the match. */
  readonly lobby: LobbyApi;

  constructor(plugin: NetPlugin) {
    this.plugin = plugin;
    this.lobby = new LobbyApi(plugin);
  }

  get is_server(): boolean { return this.plugin.isServer; }

  get local_player(): Player | null {
    const index = this.plugin.localIndex();
    if (index === undefined) return null;
    return (this.plugin.players() as Player[]).find((p) => p.index === index) ?? null;
  }

  /** `ctx.net.call(buy_item, item=...)`: on a client, sent to the server; on a host, run for the local player. */
  call(...args: unknown[]): null {
    const b = bindArgs('net.call', args, { positional: ['rpc'], required: ['rpc'], restKeywords: true });
    const mark = markOf(b.args['rpc']);
    if (mark === undefined) {
      fail('PP3353', `net.call() takes an @rpc function, got ${String(b.args['rpc'])}`, { fix: 'Decorate the function with @rpc("id").' });
    }
    this.plugin.call(mark.id, typedArgs(mark, b.restKeywords));
    return null;
  }

  /** A fresh entity for `player` from the player prefab, at `at` (an entity) or their PlayerStart. */
  respawn(...args: unknown[]): unknown {
    const a = bindArgs('net.respawn', args, { positional: ['player'], keyword: ['at'], required: ['player'] }).args;
    const at = a['at'] ?? null;
    if (at !== null && !(at instanceof Entity)) fail('PP3352', `net.respawn() at= takes an entity, got ${String(at)}`);
    const id = this.plugin.respawn(playerIndex(a['player'], 'net.respawn()'), at === null ? undefined : at.__entity_id__);
    return this.plugin.entityHandle(id);
  }

  team_of(player: unknown): string | null {
    return this.plugin.teamOf(playerIndex(player, 'net.team_of()'));
  }

  /**
   * `ctx.net.raycast(player, origin, direction, max_distance=1000, *, layers=(), ignore=())`:
   * a lag-compensated hit test — moving entities where `player` saw them, the static world
   * as it is. Server only; the same `RayHit` as `ctx.physics.raycast`.
   */
  raycast(...args: unknown[]): { entity: unknown; point: Vec3; normal: Vec3; distance: number } | null {
    const a = bindArgs('net.raycast', args, {
      positional: ['player', 'origin', 'direction', 'max_distance'], keyword: ['layers', 'ignore'], required: ['player', 'origin', 'direction'],
    }).args;
    const where = 'net.raycast()';
    const origin = vec3Of(a['origin'], `${where} origin`);
    const direction = vec3Of(a['direction'], `${where} direction`);
    const max = a['max_distance'] ?? 1000;
    if (typeof max !== 'number' || !(max > 0)) fail('PP3352', `${where} max_distance must be a positive number, got ${String(max)}`);
    const hit = this.plugin.rewindRaycast(playerIndex(a['player'], where), origin, direction, max, {
      layers: listOf(a['layers'], `${where} layers`).map((l) => layerNameOf(l, where)),
      ignore: listOf(a['ignore'], `${where} ignore`).map((e) => entityIdOf(e, where)),
    });
    if (hit === undefined) return null;
    return { entity: hit.entity === undefined ? null : this.plugin.entityHandle(hit.entity), point: hit.point, normal: hit.normal, distance: hit.distance };
  }

  /** `ctx.net.seen_position(entity, player)`: where `player`'s screen showed `entity` (lag compensation for custom tests). */
  seen_position(...args: unknown[]): Vec3 {
    const a = bindArgs('net.seen_position', args, { positional: ['entity', 'player'], required: ['entity', 'player'] }).args;
    return this.plugin.seenPose(entityIdOf(a['entity'], 'net.seen_position()'), playerIndex(a['player'], 'net.seen_position()')).position;
  }
}

// ── ctx.net.lobby ──────────────────────────────────────────────────────────────

/** A room as `ctx.net.lobby.rooms()` lists it. */
export class RoomListing {
  readonly code: string;
  readonly name: string;
  readonly players: number;
  readonly max_players: number;
  readonly private: boolean;
  readonly mode: string;
  readonly map: string;
  readonly started: boolean;

  constructor(info: RoomInfo) {
    this.code = info.code;
    this.name = info.name;
    this.players = info.players;
    this.max_players = info.maxPlayers;
    this.private = info.private;
    this.mode = info.mode;
    this.map = info.map;
    this.started = info.started;
  }

  /** Room for one more. */
  get open(): boolean { return !this.started && this.players < this.max_players; }
}

/** A member of the room: `seat` 0 is the host. */
export class LobbyPlayer {
  readonly seat: number;
  readonly name: string;
  readonly ready: boolean;
  readonly team: string | null;
  readonly is_host: boolean;
  readonly is_you: boolean;

  constructor(member: RoomMember, you: number | null) {
    this.seat = member.seat;
    this.name = member.name;
    this.ready = member.ready;
    this.team = member.team;
    this.is_host = member.seat === 0;
    this.is_you = member.seat === you;
  }
}

function text(value: unknown, where: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') fail('PP3369', `${where} takes a str, got ${String(value)}`);
  return value;
}

/** `ctx.net.lobby`: rooms before the match (sdk/parallax/net.pyi `LobbyApi`). */
export class LobbyApi {
  readonly #plugin: NetPlugin;

  constructor(plugin: NetPlugin) {
    this.#plugin = plugin;
  }

  get #lobby(): NetLobby { return this.#plugin.lobby; }

  #playerName(value: unknown, where: string): string {
    const local = this.#plugin.localIndex();
    const seat = local === undefined ? undefined : this.#plugin.seats().find((s) => s.index === local);
    return text(value, where, seat?.name ?? 'Player');
  }

  /** The newest public listing (opens the lobby and asks for one on first use). */
  rooms(): RoomListing[] {
    const lobby = this.#lobby;
    if (!lobby.connected) lobby.refresh();
    return lobby.rooms.map((r) => new RoomListing(r));
  }

  /** Ask for a fresh listing; `LobbyChanged` follows when it arrives. */
  refresh(): null {
    this.#lobby.refresh();
    return null;
  }

  /** `host(*, name, max_players=None, private=False, mode="", map="", player_name=None)`. */
  host(...args: unknown[]): null {
    const a = bindArgs('lobby.host', args, { keyword: ['name', 'max_players', 'private', 'mode', 'map', 'player_name'], required: ['name'] }).args;
    const max = a['max_players'] ?? this.#plugin.options.maxPlayers;
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) fail('PP3369', `lobby.host(max_players=) takes an int of 1 or more, got ${String(max)}`);
    const name = text(a['name'], 'lobby.host(name=)', '');
    if (name === '' || name.length > 48) fail('PP3369', 'lobby.host(name=) is 1–48 characters');
    this.#lobby.host({
      name,
      maxPlayers: max,
      private: truthy(a['private'] ?? false),
      mode: text(a['mode'], 'lobby.host(mode=)', ''),
      map: text(a['map'], 'lobby.host(map=)', ''),
    }, this.#playerName(a['player_name'], 'lobby.host(player_name=)'));
    return null;
  }

  /** `join(code, *, player_name=None)`: a refusal (no such room, full, started) shows in `error`. */
  join(...args: unknown[]): null {
    const a = bindArgs('lobby.join', args, { positional: ['code'], keyword: ['player_name'], required: ['code'] }).args;
    const code = text(a['code'], 'lobby.join(code)', '');
    if (code === '') fail('PP3369', 'lobby.join() takes the room code', { fix: 'Pass a code from rooms() or the one the host shared.' });
    this.#lobby.join(code.trim(), this.#playerName(a['player_name'], 'lobby.join(player_name=)'));
    return null;
  }

  /** The room this game is in (as listed), or None. */
  get room(): RoomListing | null {
    const room = this.#plugin.hasLobby ? this.#lobby.room : null;
    return room === null ? null : new RoomListing(room.info);
  }

  /** This run has a lobby service (the browser's `?net=lobby`, a playtest). */
  get available(): boolean { return this.#plugin.hasLobby; }
  get code(): string | null { return this.room?.code ?? null; }
  get in_room(): boolean { return this.room !== null; }
  get is_host(): boolean { return this.#plugin.hasLobby && this.#lobby.isHost; }
  /** This member's seat in the room (0: the host), or None. */
  get seat(): number | null { return this.#plugin.hasLobby ? this.#lobby.seat : null; }
  /** The match started: `players` keeps the members as they were. */
  get started(): boolean { return this.#plugin.hasLobby && this.#lobby.started; }

  /** The room's members by seat (empty outside a room). */
  get players(): LobbyPlayer[] {
    if (!this.#plugin.hasLobby) return [];
    const you = this.#lobby.seat;
    return this.#lobby.members.map((m) => new LobbyPlayer(m, you));
  }

  /** Every member is ready (the host may still start without it). */
  get all_ready(): boolean {
    const players = this.players;
    return players.length > 0 && players.every((p) => p.ready);
  }

  /** The last refused request's message (no such room, full, started), or None. */
  get error(): string | null { return this.#plugin.hasLobby ? this.#lobby.refusal?.message ?? null : null; }

  set_ready(ready: unknown = true): null {
    this.#lobby.update({ ready: truthy(ready) });
    return null;
  }

  set_team(team: unknown): null {
    if (team !== null && (typeof team !== 'string' || team === '')) fail('PP3369', `lobby.set_team() takes a team name or None, got ${String(team)}`);
    this.#lobby.update({ team: team as string | null });
    return null;
  }

  /** Host only: every member moves into the networked match (`MatchStarting`). */
  start(): null {
    this.#lobby.start();
    return null;
  }

  leave(): null {
    this.#lobby.leave();
    return null;
  }
}

function vec3Of(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (value instanceof Vec2) return new Vec3(value.x, value.y, 0);
  return fail('PP3352', `${where} must be a Vec3, got ${String(value)}`);
}

function listOf(value: unknown, where: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return fail('PP3352', `${where} must be a list`);
}

function layerNameOf(value: unknown, where: string): string {
  const name = (value as { name?: unknown } | null)?.name;
  if (typeof value === 'string') return value;
  if (typeof name === 'string' && name !== '') return name;
  return fail('PP3352', `${where}: layers= takes layers from the game's Layers class, got ${String(value)}`);
}

function entityIdOf(value: unknown, where: string): EntityId {
  if (value instanceof Entity) return value.__entity_id__;
  return fail('PP3352', `${where} takes an entity, got ${String(value)}`);
}

// ── The plugin factory ─────────────────────────────────────────────────────────

/**
 * `parallax.plugins.net(*, max_players, player_prefab, tick_rate=30, mode="dedicated",
 * visible=None, predict=(), interpolation=None, rejoin=20, rewind=0.4)`.
 */
export function net(...args: unknown[]): NetPlugin {
  const a = bindArgs('net', args, {
    keyword: ['max_players', 'player_prefab', 'tick_rate', 'mode', 'visible', 'predict', 'interpolation', 'rejoin', 'rewind'],
    required: ['max_players', 'player_prefab'],
  }).args;
  const maxPlayers = a['max_players'];
  if (typeof maxPlayers !== 'number') fail('PP3350', `net(max_players=) takes an int, got ${String(maxPlayers)}`);
  const prefab = a['player_prefab'];
  if (!(prefab instanceof PrefabRef)) fail('PP3350', `net(player_prefab=) takes a prefab (Prefabs.<name>), got ${String(prefab)}`);
  const tickRate = a['tick_rate'] ?? 30;
  if (typeof tickRate !== 'number') fail('PP3350', `net(tick_rate=) takes an int, got ${String(tickRate)}`);
  const mode = a['mode'] ?? 'dedicated';
  if (mode !== 'dedicated' && mode !== 'host') fail('PP3350', `net(mode=) is "dedicated" or "host", got ${JSON.stringify(mode)}`);
  const visible = a['visible'] ?? null;
  if (visible !== null && typeof visible !== 'function') fail('PP3350', 'net(visible=) takes a function `def visible(ctx, player, entity) -> bool`');
  const predict = (listOrNone(a['predict'], 'net(predict=)')).map((cls) => {
    const id = typeof cls === 'function' ? (cls as { __behavior_id__?: unknown }).__behavior_id__ : undefined;
    if (typeof id !== 'string') fail('PP3350', `net(predict=) takes @behavior classes, got ${String(cls)}`, { fix: 'List the behaviors that steer a player\'s own entity, e.g. predict=[Walker].' });
    return id;
  });
  const seconds = (name: string): number | undefined => {
    const v = a[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number') fail('PP3350', `net(${name}=) takes seconds (a number), got ${String(v)}`);
    return v;
  };
  const interpolation = seconds('interpolation');
  const rejoin = seconds('rejoin');
  const rewind = seconds('rewind');

  let plugin: NetPlugin;
  const host: NetApiHost = {
    replication: replicationTable,
    rpc: (id) => {
      const mark = rpcs.get(id);
      return mark === undefined ? undefined : rpcDef(mark);
    },
    player: (seat) => new NetPlayer(seat, () => {
      const id = plugin.entityOf(seat.index);
      return id === undefined ? null : plugin.entityHandle(id) as Entity;
    }),
  };
  plugin = netPlugin({
    maxPlayers,
    playerPrefab: prefab.id,
    tickRate,
    mode,
    ...(visible !== null && {
      visible: (ctx: unknown, player: unknown, entity: unknown) => truthy((visible as (...x: unknown[]) => unknown)(ctx, player, entity)),
    }),
    ...(predict.length > 0 && { predict }),
    ...(interpolation !== undefined && { interpolation }),
    ...(rejoin !== undefined && { rejoinSeconds: rejoin }),
    ...(rewind !== undefined && { rewindWindow: rewind }),
    host,
    namespace: (p) => new NetApi(p),
  });
  return plugin;
}

function listOrNone(value: unknown, where: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return fail('PP3350', `${where} takes a list`);
}

// ── Hosts: session and runtime bridges ─────────────────────────────────────────

/** The game's net plugin, if it has one. */
export function netPluginOf(game: Game): NetPlugin | undefined {
  return game.plugins.find((p): p is NetPlugin => p instanceof NetPlugin);
}

/** Single-device play: this machine hosts, with one player. */
export const LOCAL_SESSION: NetSession = { role: 'host', seats: 1 };

/** Before the runtime is built: who this process is in the match. */
export function prepareNet(game: Game, session: NetSession = LOCAL_SESSION): NetPlugin {
  const plugin = netPluginOf(game);
  if (plugin === undefined) {
    fail('PP3352', 'This game has no net plugin to start a networked session with', { fix: 'Add net(...) to Game(plugins=[...]).' });
  }
  plugin.configure(session, game.mode);
  return plugin;
}

function inputBridge(engine: InputEngine, wrap: (id: EntityId) => unknown, unwrap: (handle: unknown) => EntityId | undefined): NetInput {
  const byName = (): Map<string, ActionDecl> => {
    const map = new Map<string, ActionDecl>();
    for (const set of engine.sets) for (const [name, decl] of set.actions) map.set(`${set.id}.${name}`, decl);
    return map;
  };
  return {
    seats(count, local, shared) {
      engine.setSeats(Array.from({ length: count }, (_, index) => {
        const { keyboard, mouse, touch, gamepad } = shared
          ? seatInput(index, local.includes(index) ? [index] : [])
          : seatInput(index, local);
        return { index, keyboard, mouse, touch, gamepad };
      }));
    },
    capture(seat, owner) {
      const reader = { seat, owner: owner === null ? null : wrap(owner) };
      const frame: Record<string, ActionValue> = {};
      for (const [name, decl] of byName()) {
        switch (decl.kind) {
          case 'button': frame[name] = { k: 'button', held: engine.held(decl, reader), down: engine.pressed(decl, reader) }; break;
          case 'axis1': frame[name] = { k: 'axis1', value: engine.value(decl, reader) }; break;
          case 'axis2': { const v = engine.axis(decl, reader); frame[name] = { k: 'axis2', x: v.x, y: v.y }; break; }
          case 'group': frame[name] = { k: 'group', slot: engine.pressedIndex(decl, reader) }; break;
        }
      }
      return frame;
    },
    apply(seat, frame: ActionFrame) {
      const decls = byName();
      const unknown: string[] = [];
      for (const [name, value] of Object.entries(frame)) {
        const decl = decls.get(name);
        if (decl === undefined || decl.kind !== value.k) { unknown.push(name); continue; }
        switch (value.k) {
          case 'button':
            if (value.held) engine.injectHold(decl as never, null, seat); else engine.injectRelease(decl, seat);
            if (value.down) engine.inject(decl as never, seat);
            break;
          case 'axis1': engine.injectValue(decl as never, value.value, null, seat); break;
          case 'axis2': engine.injectVector(decl as never, new Vec2(value.x, value.y), null, seat); break;
          case 'group': if (value.slot !== null) engine.injectIndex(decl as never, value.slot, seat); break;
        }
      }
      return unknown;
    },
    pointer() {
      const p = engine.pointerSample();
      const over = p.over === null ? null : unwrap(p.over) ?? null;
      return { x: p.x, y: p.y, world: p.world === null ? null : [p.world.x, p.world.y, p.world.z], over, held: p.held, pressed: p.pressed };
    },
    applyPointer(seat, p) {
      const world = p.world === null ? null : new Vec3(p.world[0], p.world[1], p.world[2]);
      engine.injectPointer(seat, { x: p.x, y: p.y, world, over: p.over, held: p.held, pressed: p.pressed });
    },
    releasePointer(seat) {
      engine.forgetPointer(seat);
    },
  };
}

function textJson(text: unknown): Json {
  if (typeof text === 'string') return { s: text };
  if (text instanceof Localized) return { key: text.key, text: text.text };
  if (text instanceof TextRef) return { key: text.key };
  return fail('PP3359', `A forwarded message's text must be a str or a Text key, got ${String(text)}`);
}

function textOf(json: Json): unknown {
  const o = json as { s?: string; key?: string; text?: string } | null;
  if (typeof o?.s === 'string') return o.s;
  if (typeof o?.key === 'string') return typeof o.text === 'string' ? new Localized(o.key, o.text) : new TextRef(o.key);
  return fail('PP9355', 'The server forwarded text in an unknown form');
}

function pointJson(at: Vec2 | Vec3): number[] {
  return at instanceof Vec3 ? [at.x, at.y, at.z] : [at.x, at.y];
}

/** The engines whose one-shots a server forwards and a client replays. */
interface FeedbackEngines {
  readonly ui: UiEngine;
  readonly audio: AudioEngine;
  /** The game's renderer (render2d or render3d): `forwardTo` / `replay` of vfx.play and vfx.beam. */
  readonly render: { forwardTo(listener: ((effect: Json) => void) | null): void; replay(effect: Json): void } | undefined;
  /** The HUD (pings, hit markers, screen flashes, damage arcs, shakes), when the game has one. */
  readonly hud: HudEngine | undefined;
  /** A handle here → its entity id (HUD replays reference entities by id). */
  readonly unwrap: (handle: unknown) => EntityId | undefined;
}

function colorJson(c: Color | null): number[] | null {
  return c === null ? null : [c.r, c.g, c.b, c.a];
}

function colorOf(json: Json | undefined): Color | null {
  const c = json as number[] | null;
  return c === null || c === undefined ? null : new Color(c[0]!, c[1]!, c[2]!, c[3]!);
}

/**
 * DESIGN §6.5 "feedback needs no network code": what server code asks for — panel feedback
 * (toast, announce, float_text, flash), sounds, effects and HUD feedback (pings, hit
 * markers, screen flashes, damage arcs) — is heard here and sent to the clients it concerns (`to=player`: that player only); each client plays it locally.
 * `server` installs the listeners (a client only replays); `drain` takes the UI requests
 * off the queue (a dedicated server draws nothing, so nobody else will).
 */
function feedbackBridge(engines: FeedbackEngines, server: boolean, drain: boolean): NetFeedback {
  const { ui, audio, render, hud } = engines;
  const seen = new WeakSet<UiRequest>();
  const recipient = (to: unknown): string | null => (to instanceof Player ? to.id : null);
  let heard: { item: Json; to: string | null }[] = [];
  if (server) {
    audio.forwardTo((shot) => heard.push({
      item: {
        kind: 'sound', sound: shot.sound, at: shot.at === null ? null : [shot.at.x, shot.at.y, shot.at.z], volume: shot.volume, pitch: shot.pitch,
      },
      to: shot.to,
    }));
    render?.forwardTo((effect) => heard.push({ item: { kind: 'effect', effect }, to: null }));
    // HUD feedback names its seat; each client shows only its own seat's.
    hud?.forwardTo((item) => heard.push({ item: { kind: 'hud', item }, to: null }));
  } else {
    // A client that also simulates physics (prediction) would sound every impact twice: its
    // own, and the server's forwarded one. The server's is the one everyone hears.
    audio.impactSounds = false;
  }
  return {
    take() {
      const requests = drain ? ui.takeRequests() : ui.requests.filter((r) => !seen.has(r));
      const out: { item: Json; to: string | null }[] = [];
      for (const r of requests) {
        seen.add(r);
        switch (r.kind) {
          case 'toast': out.push({ item: { kind: 'toast', text: textJson(r.text), seconds: r.seconds }, to: recipient(r.to) }); break;
          case 'announce':
            out.push({
              item: { kind: 'announce', title: textJson(r.title), subtitle: r.subtitle === null ? null : textJson(r.subtitle), seconds: r.seconds },
              to: recipient(r.to),
            });
            break;
          case 'float_text':
            out.push({
              item: { kind: 'float_text', text: r.text, at: pointJson(r.at), color: colorJson(r.color), ...(r.style !== null && { style: r.style as unknown as Json }) },
              to: recipient(r.to),
            });
            break;
          case 'flash':
            // The entity by its server id: each client flashes its copy (if it has one).
            out.push({ item: { kind: 'flash', entity: r.entity, color: colorJson(r.color), seconds: r.seconds }, to: null });
            break;
        }
      }
      out.push(...heard);
      heard = [];
      return out;
    },
    play(item, entity) {
      const o = item as Record<string, Json>;
      switch (o['kind']) {
        case 'toast': ui.toast(textOf(o['text']!), o['seconds'] as number, null); return;
        case 'announce': ui.announce(textOf(o['title']!), o['subtitle'] === null ? null : textOf(o['subtitle']!), o['seconds'] as number, null); return;
        case 'float_text': {
          const at = o['at'] as number[];
          ui.floatText(
            o['text'] as string, at.length === 3 ? new Vec3(at[0]!, at[1]!, at[2]!) : new Vec2(at[0]!, at[1]!), colorOf(o['color']), null,
            (o['style'] ?? null) as unknown as UiFloatStyle | null,
          );
          return;
        }
        case 'flash': {
          const handle = entity(o['entity'] as number);
          if (handle !== null) ui.flash(handle, colorOf(o['color']), o['seconds'] as number);
          return;
        }
        case 'sound': {
          const at = o['at'] as number[] | null;
          audio.play({
            sound: o['sound'] as string, at: at === null ? null : new Vec3(at[0]!, at[1]!, at[2]!),
            volume: o['volume'] as number, pitch: o['pitch'] as number, to: null,
          });
          return;
        }
        case 'effect':
          if (render === undefined) fail('PP9355', 'The server forwarded an effect, and this client has no renderer');
          render.replay(o['effect']!);
          return;
        case 'hud':
          if (hud === undefined) fail('PP9355', 'The server forwarded HUD feedback, and this client has no hud()');
          hud.replay(o['item']!, (id) => {
            const handle = entity(id);
            return handle === null ? null : engines.unwrap(handle) ?? null;
          });
          return;
        default: fail('PP9355', `The server forwarded an unknown feedback kind ${JSON.stringify(o['kind'])}`);
      }
    },
  };
}

function hudEngineOf(runtime: GameRuntime): HudEngine | undefined {
  for (const p of runtime.game.plugins as readonly unknown[]) {
    const engine = (p as { engine?: unknown }).engine;
    if ((p as { id?: unknown }).id === 'hud' && engine instanceof HudEngine) return engine;
  }
  return undefined;
}

/** After the runtime started: wire input and presentation to the net plugin, and local players join. */
export function attachNet(runtime: GameRuntime): NetPlugin | undefined {
  const plugin = netPluginOf(runtime.game);
  if (plugin === undefined) return undefined;
  plugin.attach({
    input: inputBridge(runtime.inputEngine, (id) => runtime.wrap(id), (handle) => runtime.unwrap(handle)),
    // A dedicated server draws nothing, so it drains what nobody else will.
    feedback: feedbackBridge({
      ui: runtime.uiEngine, audio: runtime.audio, render: runtime.render2d ?? runtime.render3d,
      hud: hudEngineOf(runtime), unwrap: (handle) => runtime.unwrap(handle),
    }, plugin.isServer, plugin.role === 'server'),
  });
  return plugin;
}

