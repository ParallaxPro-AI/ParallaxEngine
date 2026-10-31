/**
 * The authority: runs the game and owns the seats. Local seats (a host's players, a
 * playtest's) read this machine's input; remote seats are clients on links, which send
 * input and RPCs and receive state at the tick rate.
 *
 * Per frame (kernel hook points):
 *   input   accept links and handshakes (a hello carrying a rejoin token takes its seat
 *           back); read client messages: input frames queue by sequence number and one is
 *           applied per frame (a backlog is folded), RPCs run now with the caller's view
 *           time, closed links go away (and leave when the rejoin window ends)
 *   render  players who left lose their entity and seat; moving entities' poses are kept
 *           for lag compensation; at the tick rate every remote client gets its reliable
 *           state (structure, fields, the tick's feedback) and its unreliable snapshot
 *           (poses as a delta, clocks, the newest input its state includes)
 *
 * Joining spawns the seat's player entity at its `PlayerStart` (when the scene has
 * PlayerStarts) and then emits `PlayerJoined`. A scene load spawns every seat's entity
 * again before any game handler hears `SceneLoaded`. `PlayerLeft` is delivered while the
 * leaver's entity is still alive; it is destroyed at the end of that frame.
 *
 * Local players join with the first scene that loads with logic on: an editor's edit world
 * (logic off) has no player entities, and its Play seats them as the played scene loads, as
 * a match's start does. A restored snapshot decides which local players are seated: those
 * it doesn't hold wait to join again (an editor's Stop, then the next Play).
 *
 * Input timing: input applied in frame F's input hook is read by game code in frame F+1
 * (the input engine samples before this hook). So the newest input frame a state includes
 * is the one applied the frame before it was built.
 */

import { fail } from '../../../core/index.js';
import type { EntityId, NetChannel, NetLink, NetListener, NetMessage, Quat, Vec3 } from '../../../core/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import { decode } from '../../kernel/index.js';
import type { EntityCodec, Kernel, Overrides } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import type { ChannelMessage } from '../../services/index.js';
import type { NetApiHost, RpcDef, RuntimeBridges, SeatView } from './bridge.js';
import { compensatedRaycast, PoseHistory } from './lag_compensation.js';
import type { CompensatedHit, RewoundPose } from './lag_compensation.js';
import type { Origins } from './origins.js';
import { ChannelInbox, checkOutgoing } from './channels.js';
import { PROTOCOL } from './protocol.js';
import type { ActionFrame, ActionValue, ClientMessage, InputFrame, PointerJson, SeatJson, ServerMessage, WireFormat } from './protocol.js';
import { Replicator, sideOf, View } from './replication.js';
import { decodeClient, encodeServer, formatOf, wireSize } from './wire.js';
import { WorldSender, worldJson } from './world_sync.js';

const PLAYER_START = 'player_start';
const COLLIDER = 'collider';
/** Input frames waiting beyond this are folded into one (the client runs faster than the server). */
const INPUT_BACKLOG = 3;

/** A dropped RPC call (rate limit, bad arguments from a client, unknown id). */
export interface Rejection {
  readonly seat: number;
  readonly rpc: string;
  readonly code: 'PP3353' | 'PP3354' | 'PP3355';
  readonly message: string;
}

interface QueuedFrame extends InputFrame {
  /** The view time of the message that carried it. */
  readonly view: number;
}

export interface Seat extends SeatView {
  name: string;
  link: NetLink | null;
  format: WireFormat;
  /** Presented by the client to take the seat back after its link dropped. */
  readonly token: string;
  /** The verified player behind the link (`NetLink.identity`), if the host checked one. */
  readonly identity: string | null;
  entity: EntityId | undefined;
  /** Input frames received, in sequence order, not applied yet. */
  readonly queue: QueuedFrame[];
  /** Highest input sequence received. */
  received: number;
  /** The input sequence applied in this frame's input hook, and the one game code reads now. */
  applied: number;
  visible: number;
  /** The full action state last applied (the wire lists only non-idle actions). */
  actions: Map<string, ActionValue>;
  /** The server time the client was showing with the input game code reads now (lag compensation). */
  viewTime: number | null;
  /** What this client has been sent (null: a local seat). */
  readonly replica: View | null;
  /** Rate-limit buckets by RPC id: tokens left and when they were counted. */
  readonly buckets: Map<string, { tokens: number; at: number }>;
  /** Feedback waiting for the next tick's state. */
  feedback: Json[];
  /** While the link is down: the real time the rejoin window ends. */
  away: number | null;
  leaving: boolean;
}

export interface ServerOptions {
  readonly maxPlayers: number;
  readonly mode: '2d' | '3d';
  /** Names of the players on this machine (a host's); they join with the first scene. */
  readonly locals: readonly string[];
  readonly playerPrefab: string;
  readonly tickRate: number;
  readonly visible: ((ctx: unknown, player: unknown, entity: unknown) => boolean) | undefined;
  /** Seconds a dropped player's seat (and entity) waits for them to rejoin; 0: they leave at once. */
  readonly rejoinSeconds: number;
  /** Seconds of history lag compensation may rewind. */
  readonly rewindWindow: number;
  /** Random rejoin tokens (default: the platform's crypto). */
  readonly token?: () => string;
}

export interface NetEventDefs {
  readonly joined: object;
  readonly left: object;
  readonly rejoined: object;
}

function rotationArray(q: Quat, mode: '2d' | '3d'): number | number[] {
  const e = q.to_euler();
  return mode === '2d' ? e.z : [e.x, e.y, e.z];
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The idle state of an action of the same kind (what an action left out of a frame is). */
function idle(value: ActionValue): ActionValue {
  switch (value.k) {
    case 'button': return { k: 'button', held: false, down: false };
    case 'axis1': return { k: 'axis1', value: 0 };
    case 'axis2': return { k: 'axis2', x: 0, y: 0 };
    case 'group': return { k: 'group', slot: null };
  }
}

export interface RaycastFilter {
  readonly layers: readonly string[];
  readonly ignore: readonly EntityId[];
}

export class NetServer {
  readonly #kernel: Kernel;
  readonly #options: ServerOptions;
  readonly #host: NetApiHost;
  readonly #player: (seat: SeatView) => unknown;
  readonly #origins: Origins;
  #listener: NetListener | undefined;
  readonly #seats: (Seat | undefined)[];
  readonly #handshakes: NetLink[] = [];
  readonly #events: NetEventDefs;
  readonly #history: PoseHistory;
  #replicator: Replicator | undefined;
  #world: WorldSender | undefined;
  #bridges: RuntimeBridges | undefined;
  /** Local players not yet joined (they join as the first scene with logic on loads). */
  #waiting: { readonly index: number; readonly name: string }[];
  #sceneBatchNext = false;
  #epoch = 0;
  #scene: { id: string; seed: number } | undefined;
  #sinceTick = 0;
  #tick = 0;
  /** Calls dropped since the server started (also sent to remote callers). */
  readonly rejections: Rejection[] = [];
  /** Bytes sent per channel (bandwidth checks). */
  readonly sent = { reliable: 0, unreliable: 0 };
  readonly #inbox = new ChannelInbox();

  constructor(
    kernel: Kernel, options: ServerOptions, host: NetApiHost, player: (seat: SeatView) => unknown, origins: Origins,
    listener: NetListener | undefined, events: NetEventDefs,
  ) {
    this.#kernel = kernel;
    this.#options = options;
    this.#host = host;
    this.#player = player;
    this.#origins = origins;
    this.#listener = listener;
    this.#seats = new Array<Seat | undefined>(options.maxPlayers).fill(undefined);
    this.#events = events;
    this.#history = new PoseHistory(options.rewindWindow);
    if (options.locals.length > options.maxPlayers) {
      fail('PP3350', `${options.locals.length} players can't join a game for at most ${options.maxPlayers}`, {
        fix: `Start with players=${options.maxPlayers} or fewer, or raise net(max_players=).`,
      });
    }
    this.#waiting = options.locals.map((name, index) => ({ index, name }));
    kernel.observeScenes({ loading: (scene, request) => this.#sceneLoading(scene, request.seed) });
    // Registered after the origins tracker, so the scene's entities are filed first.
    kernel.observeEntities({ added: () => this.#sceneSpawned() });
  }

  // ── Seats ────────────────────────────────────────────────────────────────────

  get seats(): readonly Seat[] {
    return this.#seats.filter((s): s is Seat => s !== undefined && !s.leaving);
  }

  /**
   * Every seat in play: a leaver until the end of its last frame, and a host's local
   * players from the start (assigned before the first scene, they join as it loads).
   */
  allSeats(): readonly SeatView[] {
    const waiting = this.#waiting.map(({ index, name }): SeatView => ({ index, id: `p${index}`, name, local: true }));
    return [...waiting, ...this.#seats.filter((s): s is Seat => s !== undefined)];
  }

  seat(index: number): Seat | undefined {
    const s = this.#seats[index];
    return s === undefined || s.leaving ? undefined : s;
  }

  /** The entity a seat controls, while alive. */
  entityOf(index: number): EntityId | undefined {
    const id = this.#seats[index]?.entity;
    return id !== undefined && this.#kernel.world.isAlive(id) ? id : undefined;
  }

  /** `ctx.net.team_of`: the side of the seat's entity, or null. */
  teamOf(index: number): string | null {
    return sideOf(this.#kernel, this.entityOf(index));
  }

  /** Whether a seat in play belongs to this verified identity (a held seat it may take back). */
  holds(identity: string): boolean {
    return this.seats.some((s) => s.identity === identity);
  }

  /** Whether a remote seat's link is down (waiting for a rejoin). */
  away(index: number): boolean {
    return this.seat(index)?.away != null;
  }

  /** Called once the runtime exists (after the first scene loaded): input, presentation and the frame hooks. */
  attach(bridges: RuntimeBridges): void {
    this.#bridges = bridges;
    this.#replicator = new Replicator(this.#kernel, this.#host.replication(), this.#origins);
    this.#world = new WorldSender(this.#kernel);
    // Every seat exists for input; local ones read this machine's devices.
    bridges.input.seats(this.#options.maxPlayers, this.allSeats().filter((s) => s.local).map((s) => s.index), false);
    this.#kernel.addHook('input', () => this.#input());
    this.#kernel.addHook('render', (dt) => this.#render(dt));
  }

  #newSeat(index: number, name: string, link: NetLink | null, format: WireFormat): Seat {
    return {
      index, id: `p${index}`, name, local: link === null, link, format, token: link === null ? '' : (this.#options.token ?? randomToken)(),
      identity: link?.identity?.id ?? null,
      entity: undefined, queue: [], received: -1, applied: -1, visible: -1, actions: new Map(), viewTime: null,
      replica: link === null ? null : new View(), buckets: new Map(), feedback: [], away: null, leaving: false,
    };
  }

  /**
   * A scene's entities were just spawned (before its systems and behaviors start, and
   * before `SceneLoaded`): every seat in play gets its entity, and on the first scene the
   * local players join — so their `PlayerJoined` is heard before `SceneLoaded`, and the
   * scene's first frame already has them.
   */
  #sceneSpawned(): void {
    if (!this.#sceneBatchNext) return;
    this.#sceneBatchNext = false;
    // An edit world (logic off) gets no players; they join when a scene plays.
    if (!this.#kernel.logic) return;
    for (const seat of this.seats) this.#spawnPlayer(seat, undefined);
    this.#waiting.splice(0).forEach(({ index, name }) => this.#join(this.#newSeat(index, name, null, 'binary')));
  }

  #join(seat: Seat): void {
    this.#seats[seat.index] = seat;
    this.#spawnPlayer(seat, undefined);
    this.#kernel.emit(this.#events.joined as never, { player: this.#player(seat) });
  }

  /** The seat's entity, from the player prefab, at `at` or its PlayerStart. Undefined when the scene has no PlayerStart. */
  #spawnPlayer(seat: Seat, at: EntityId | undefined): EntityId | undefined {
    const start = at ?? this.#startFor(seat.index);
    if (start === undefined) {
      seat.entity = undefined;
      return undefined;
    }
    const t = this.#kernel.world.require(start).transform;
    const position = t.worldPosition();
    const over: Overrides = {
      at: this.#options.mode === '2d' ? [position.x, position.y] : [position.x, position.y, position.z],
      rotation: rotationArray(t.worldRotation(), this.#options.mode),
    };
    const record = this.#kernel.spawn(this.#options.playerPrefab, over, { owner: seat.index });
    seat.entity = record.id;
    return record.id;
  }

  /** The PlayerStart for a seat: one for exactly that seat, else the seat-any starts in turn. */
  #startFor(index: number): EntityId | undefined {
    const any: EntityId[] = [];
    let found = false;
    for (const record of this.#kernel.world.live()) {
      const start = record.components.get(PLAYER_START);
      if (start === undefined) continue;
      found = true;
      if (start['seat'] === index) return record.id;
      if (start['seat'] === -1) any.push(record.id);
    }
    if (!found) return undefined;
    if (any.length === 0) {
      fail('PP3351', `Scene "${this.#kernel.scene?.id ?? '?'}" has PlayerStarts, but none for seat ${index} and none for any seat`, {
        fix: `Place a player_start with "seat": ${index} (or "seat": -1 for any seat).`,
      });
    }
    return any[index % any.length];
  }

  /** `ctx.net.respawn(player, at=)`: a fresh entity from the player prefab (the old one is destroyed). */
  respawn(index: number, at: EntityId | undefined): EntityId {
    const seat = this.seat(index);
    if (seat === undefined) fail('PP3352', `respawn(): player ${index} is not in the game`);
    const old = this.entityOf(index);
    if (old !== undefined) this.#kernel.destroy(old);
    const id = this.#spawnPlayer(seat, at);
    if (id === undefined) {
      fail('PP3351', `respawn(): scene "${this.#kernel.scene?.id ?? '?'}" has no PlayerStart`, {
        fix: 'Place player_start entities in the scene, or pass at= an entity to spawn at.',
      });
    }
    return id;
  }

  #sceneLoading(scene: SceneDoc, seed: number | undefined): void {
    this.#epoch++;
    this.#sceneBatchNext = true;
    this.#scene = { id: scene.id, seed: seed ?? 0 };
    this.#history.clear();
    for (const seat of this.seats) {
      seat.entity = undefined;
      seat.feedback = [];
      if (seat.replica === null) continue;
      seat.replica.reset();
      this.#send(seat, { t: 'scene', epoch: this.#epoch, scene: scene.id, seed: this.#scene.seed });
    }
  }

  // ── RPCs ─────────────────────────────────────────────────────────────────────

  /**
   * Run an RPC for a seat. `args` are encoded (wire) values; entity references are server
   * ids. Local callers' argument mistakes throw (they are code errors); a remote caller's
   * are rejected and reported to it. Rate limits drop the call either way. `view` is the
   * server time the caller was showing (lag compensation inside the call rewinds to it).
   */
  call(index: number, rpcId: string, args: JsonObject, view: number | null = null): void {
    const seat = this.seat(index);
    if (seat === undefined) fail('PP3352', `An RPC was called for player ${index}, who is not in the game`);
    const def = this.#host.rpc(rpcId);
    if (def === undefined) {
      this.#reject(seat, rpcId, 'PP3353', `There is no RPC "${rpcId}"`);
      return;
    }
    if (!this.#takeToken(seat, def)) {
      this.#reject(seat, rpcId, 'PP3354', `"${rpcId}" was called more than ${def.rateLimit} times a second`);
      return;
    }
    let values: unknown[];
    try {
      values = this.#arguments(def, args);
    } catch (error) {
      if (seat.local) throw error;
      this.#reject(seat, rpcId, 'PP3355', error instanceof Error ? error.message : String(error));
      return;
    }
    const before = seat.viewTime;
    if (view !== null && view >= 0) seat.viewTime = view;
    try {
      def.call(this.#kernel.context, this.#player(seat), values);
    } finally {
      seat.viewTime = before;
    }
  }

  #arguments(def: RpcDef, args: JsonObject): unknown[] {
    const names = new Set(def.params.map((p) => p.name));
    for (const name of Object.keys(args)) {
      if (!names.has(name)) fail('PP3355', `RPC "${def.id}" has no parameter "${name}"`);
    }
    const codec: EntityCodec = {
      encode: () => fail('PP9355', 'RPC arguments are only decoded on the server'),
      decode: (value, where) => {
        const handles = this.#kernel.handles;
        if (typeof value !== 'number' || !this.#kernel.world.isAlive(value as EntityId)) {
          fail('PP3355', `${where} names an entity that no longer exists`);
        }
        return handles.wrap(value as EntityId);
      },
    };
    return def.params.map((param) => {
      if (!(param.name in args)) fail('PP3355', `RPC "${def.id}" needs "${param.name}"`);
      const where = `RPC "${def.id}" argument "${param.name}"`;
      return param.present(decode(param.type, args[param.name]!, where, codec), this.#kernel.context);
    });
  }

  #takeToken(seat: Seat, def: RpcDef): boolean {
    const rate = def.rateLimit;
    if (rate === null) return true;
    const now = this.#kernel.time.realNow;
    const capacity = Math.max(1, rate);
    const bucket = seat.buckets.get(def.id) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * rate);
    bucket.at = now;
    seat.buckets.set(def.id, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #reject(seat: Seat, rpc: string, code: Rejection['code'], message: string): void {
    this.rejections.push({ seat: seat.index, rpc, code, message });
    this.#send(seat, { t: 'rejected', rpc, code, message });
  }

  // ── Lag compensation ─────────────────────────────────────────────────────────

  /** The server time a seat's game code is acting on: its client's view, within the rewind window. */
  viewTime(index: number): number {
    const now = this.#kernel.time.realNow;
    const view = this.seat(index)?.viewTime ?? null;
    if (view === null) return now;
    return Math.min(now, Math.max(now - this.#options.rewindWindow, view));
  }

  /** Where `entity` was when `index`'s player saw it (its present pose when it isn't tracked). */
  seenPose(entity: EntityId, index: number): RewoundPose {
    const record = this.#kernel.world.require(entity);
    return this.#history.at(entity, this.viewTime(index))
      ?? { position: record.transform.worldPosition(), rotation: record.transform.worldRotation() };
  }

  /** A raycast against moving entities as `index`'s player saw them, and the static world as it is. */
  rewindRaycast(index: number, origin: Vec3, direction: Vec3, maxDistance: number, filter: RaycastFilter): CompensatedHit | undefined {
    if (this.#options.mode !== '3d') {
      fail('PP3361', 'Lag-compensated raycasts are 3D only for now', { fix: 'Use ctx.physics.raycast in a 2D game.' });
    }
    const physics = this.#kernel.service(PHYSICS3D_SERVICE);
    const kernel = this.#kernel;
    const ignore = new Set(filter.ignore);
    const layers = new Set(filter.layers);
    const t = this.viewTime(index);
    return compensatedRaycast(this.#history, {
      bounds: (id) => physics.bounds(id),
      eligible: (id) => {
        if (ignore.has(id) || !kernel.world.isAlive(id)) return false;
        if (layers.size === 0) return true;
        const layer = kernel.world.get(id)?.components.get(COLLIDER)?.['layer'];
        return typeof layer === 'string' && layers.has(layer);
      },
      staticDistance: (o, d, max, moving) => {
        const hit = physics.raycast(o, d, max, { ...(filter.layers.length > 0 && { layers: filter.layers }), ignore: [...filter.ignore, ...moving] });
        return hit === undefined ? undefined : { distance: hit.distance, entity: hit.entity, point: hit.point, normal: hit.normal };
      },
    }, t, origin, direction, maxDistance);
  }

  #recordHistory(): void {
    const poses = new Map<EntityId, RewoundPose>();
    const replicator = this.#replicator!;
    for (const record of this.#kernel.world.live()) {
      if (!replicator.replicatesTransform(record)) continue;
      poses.set(record.id, { position: record.transform.worldPosition(), rotation: record.transform.worldRotation() });
    }
    this.#history.record(this.#kernel.time.realNow, poses);
  }

  // ── Frame ────────────────────────────────────────────────────────────────────

  #input(): void {
    if (this.#listener !== undefined) this.#handshakes.push(...this.#listener.accept());
    // In connection order, so seats are assigned first come, first served.
    for (const link of [...this.#handshakes]) {
      if (link.state !== 'closed') {
        const messages = link.receive();
        if (messages.length === 0) continue;
        this.#hello(link, messages);
      }
      this.#handshakes.splice(this.#handshakes.indexOf(link), 1);
    }
    const realNow = this.#kernel.time.realNow;
    for (const seat of this.seats) {
      if (seat.link === null) continue;
      if (seat.away === null) {
        for (const raw of seat.link.receive()) {
          let message: ClientMessage;
          try {
            message = decodeClient(raw);
          } catch (error) {
            this.#drop(seat, 'PP9354', error instanceof Error ? error.message : String(error));
            break;
          }
          this.#handle(seat, message);
          if (seat.leaving) break;
        }
        if (seat.link.state === 'closed' && !seat.leaving) this.#lost(seat);
      } else if (realNow >= seat.away) {
        this.#leave(seat);
      }
    }
    for (const seat of this.seats) if (seat.link !== null && seat.away === null) this.#applyInput(seat);
  }

  /** One queued input frame (or a folded backlog) to the seat; it is read next frame. */
  #applyInput(seat: Seat): void {
    seat.visible = seat.applied;
    const queue = seat.queue;
    if (queue.length === 0) return;
    const take = queue.length > INPUT_BACKLOG ? queue.length - 1 : 1;
    const frames = queue.splice(0, take);
    let actions: Record<string, ActionValue> = {};
    let pointer: PointerJson | undefined;
    for (const frame of frames) {
      actions = merge(actions, frame.actions);
      if (frame.pointer !== undefined) pointer = { ...frame.pointer, down: frame.pointer.down || (pointer?.down ?? false) };
    }
    const last = frames[frames.length - 1]!;
    // Folding keeps presses from every frame, but what is held is the newest frame's.
    const newest = last.actions;
    for (const [name, value] of Object.entries(actions)) {
      if (!(name in newest)) actions[name] = value.k === 'button' ? { k: 'button', held: false, down: value.down } : value.k === 'group' ? value : idle(value);
    }
    const full: Record<string, ActionValue> = {};
    for (const [name, before] of seat.actions) if (!(name in actions)) full[name] = idle(before);
    Object.assign(full, actions);
    seat.actions = new Map(Object.entries(actions));
    seat.applied = last.seq;
    if (last.view >= 0) seat.viewTime = last.view;
    if (pointer !== undefined) {
      const p = pointer;
      // The client names the server's own ids; one that died in flight is nothing.
      const over = p.over !== null && this.#kernel.world.isAlive(p.over as EntityId) ? this.#kernel.handles.wrap(p.over as EntityId) : null;
      this.#bridges!.input.applyPointer(seat.index, { x: p.x, y: p.y, world: p.world, over, held: p.held, pressed: p.down });
    }
    if (Object.keys(full).length === 0) return;
    const unknown = this.#bridges!.input.apply(seat.index, full);
    if (unknown.length > 0) this.#drop(seat, 'PP9356', `The client sent input for actions this game doesn't have: ${unknown.slice(0, 5).join(', ')}`);
  }

  #hello(link: NetLink, messages: readonly NetMessage[]): void {
    const format = formatOf(messages[0]!);
    let hello: ClientMessage;
    try {
      hello = decodeClient(messages[0]!);
    } catch {
      this.#bye(link, format, 'PP9354', 'The first message must be hello');
      return;
    }
    if (hello.t !== 'hello') { this.#bye(link, format, 'PP9354', 'The first message must be hello'); return; }
    if (hello.protocol !== PROTOCOL) {
      this.#bye(link, format, 'PP9356', `This server speaks protocol ${PROTOCOL}; the client speaks ${hello.protocol}`);
      return;
    }
    let seat: Seat;
    const identity = link.identity;
    // A held seat comes back by its token, or by the verified identity behind the new link.
    const back = this.seats.find((s) => s.link !== null && (
      (hello.rejoin !== undefined && s.token === hello.rejoin) || (identity !== undefined && s.identity === identity.id)));
    if (back !== undefined) {
      // The same player on a new link: their seat and entity, a fresh view.
      if (back.link !== link && back.link!.state !== 'closed') back.link!.close('replaced by a rejoin');
      back.link = link;
      back.format = format;
      back.away = null;
      back.queue.length = 0;
      back.received = -1;
      back.applied = -1;
      back.visible = -1;
      back.replica!.reset();
      seat = back;
      this.#greet(seat);
      this.#kernel.emit(this.#events.rejoined as never, { player: this.#player(seat) });
    } else {
      if (hello.rejoin !== undefined) {
        this.#bye(link, format, 'PP3360', 'That seat is no longer held (the rejoin window ended, or the token is wrong)');
        return;
      }
      const wanted = identity?.seat ?? null;
      const taken = (i: number): boolean => this.#seats[i] !== undefined || this.#waiting.some((w) => w.index === i);
      if (wanted !== null && (wanted < 0 || wanted >= this.#options.maxPlayers || taken(wanted))) {
        this.#bye(link, format, 'PP3357', `Seat ${wanted} is not free`);
        return;
      }
      const index = wanted ?? this.#seats.findIndex((_, i) => !taken(i));
      if (index === -1) { this.#bye(link, format, 'PP3357', `The match is full (${this.#options.maxPlayers} players)`); return; }
      const name = identity?.name ?? hello.name;
      seat = this.#newSeat(index, name.slice(0, 40) || `Player ${index + 1}`, link, format);
      this.#greet(seat);
      this.#join(seat);
    }
    for (const raw of messages.slice(1)) {
      if (seat.leaving) break;
      let message: ClientMessage;
      try {
        message = decodeClient(raw);
      } catch (error) {
        this.#drop(seat, 'PP9354', error instanceof Error ? error.message : String(error));
        break;
      }
      this.#handle(seat, message);
    }
  }

  #greet(seat: Seat): void {
    this.#send(seat, { t: 'welcome', protocol: PROTOCOL, seat: this.#seatJson(seat), tick_rate: this.#options.tickRate, token: seat.token });
    if (this.#scene !== undefined) this.#send(seat, { t: 'scene', epoch: this.#epoch, scene: this.#scene.id, seed: this.#scene.seed });
  }

  #handle(seat: Seat, message: ClientMessage): void {
    switch (message.t) {
      case 'hello':
        this.#drop(seat, 'PP9354', 'hello sent twice');
        return;
      case 'input':
        seat.replica!.snapshots.ack(message.ack);
        for (const frame of message.frames) {
          if (frame.seq <= seat.received) continue;
          seat.received = frame.seq;
          seat.queue.push({ ...frame, view: message.view });
        }
        return;
      case 'rpc':
        this.call(seat.index, message.rpc, message.args, message.view);
        return;
      case 'channel':
        this.#inbox.put(message.topic, { from: seat.index, payload: message.payload });
        return;
      case 'leave':
        this.#leave(seat);
        seat.link?.close('left');
    }
  }

  /** The link dropped without a goodbye: hold the seat for the rejoin window, with its input let go. */
  #lost(seat: Seat): void {
    if (this.#options.rejoinSeconds <= 0) { this.#leave(seat); return; }
    seat.away = this.#kernel.time.realNow + this.#options.rejoinSeconds;
    seat.queue.length = 0;
    const released: Record<string, ActionValue> = {};
    for (const [name, value] of seat.actions) released[name] = idle(value);
    seat.actions = new Map();
    if (Object.keys(released).length > 0) this.#bridges!.input.apply(seat.index, released);
    this.#bridges!.input.releasePointer(seat.index);
  }

  #leave(seat: Seat): void {
    if (seat.leaving) return;
    seat.leaving = true;
    this.#kernel.emit(this.#events.left as never, { player: this.#player(seat) });
  }

  #drop(seat: Seat, code: string, message: string): void {
    if (seat.link !== null) this.#bye(seat.link, seat.format, code, message);
    this.#leave(seat);
  }

  #bye(link: NetLink, format: WireFormat, code: string, message: string): void {
    link.send(encodeServer({ t: 'bye', code, message }, format));
    link.close(`${code} ${message}`);
  }

  #render(realDt: number): void {
    for (const seat of this.#seats) {
      if (seat === undefined || !seat.leaving) continue;
      const entity = this.entityOf(seat.index);
      if (entity !== undefined) this.#kernel.destroy(entity);
      if (seat.link !== null) this.#bridges!.input.releasePointer(seat.index);
      this.#seats[seat.index] = undefined;
    }
    const feedback = this.#bridges!.feedback.take();
    const remotes = this.seats.filter((s) => s.replica !== null);
    if (remotes.length === 0) return;
    this.#recordHistory();
    for (const seat of remotes) {
      if (seat.away !== null) continue;
      for (const f of feedback) if (f.to === null || f.to === seat.id) seat.feedback.push(f.item);
    }
    this.#sinceTick += realDt;
    if (this.#sinceTick + 1e-9 < 1 / this.#options.tickRate) return;
    this.#sinceTick = 0;
    this.#tick++;
    this.sendStates(remotes);
  }

  /** Send each remote seat its state and snapshot now (the tick does this; tests call it directly). */
  sendStates(remotes: readonly Seat[] = this.seats.filter((s) => s.replica !== null)): void {
    const replicator = this.#replicator!;
    const players = this.seats.map((s) => this.#seatJson(s));
    const visible = this.#options.visible;
    const ctx = this.#kernel.context;
    const time = this.#kernel.time;
    for (const seat of remotes) {
      if (seat.away !== null || seat.link === null) continue;
      const view = seat.replica!;
      const first = view.full;
      const player = this.#player(seat);
      const body = replicator.build(view, {
        seat: seat.index,
        team: this.teamOf(seat.index),
        ...(visible !== undefined && { sees: (root: EntityId) => visible(ctx, player, this.#kernel.handles.wrap(root)) }),
      }, (index) => this.teamOf(index), players);
      const feedback = seat.feedback;
      seat.feedback = [];
      const world = this.#world!.build(view, first);
      if (first || body.entities.length > 0 || body.destroyed.length > 0 || body.players !== undefined
        || Object.keys(body.resources).length > 0 || feedback.length > 0 || world !== undefined) {
        this.#send(seat, {
          t: 'state', epoch: this.#epoch, tick: this.#tick,
          ...(body.players !== undefined && { players: body.players }),
          entities: body.entities, destroyed: body.destroyed,
          ...(Object.keys(body.resources).length > 0 && { resources: body.resources }),
          ...(feedback.length > 0 && { feedback }),
          ...(world !== undefined && { world: worldJson(world) }),
        });
      }
      const base = view.snapshots.base;
      const poses = view.snapshots.build(this.#tick, replicator.poses(view));
      this.#send(seat, {
        t: 'snap', epoch: this.#epoch, tick: this.#tick, rt: time.realNow, now: time.now, sceneStart: time.sceneStart, base, ack: seat.visible, poses,
      }, 'unreliable');
    }
  }

  // ── Channels (services/channels.ts) ─────────────────────────────────────────

  /** A plugin message to one remote seat, or to every remote seat ('all'). Seats without a link (local, away) get nothing. */
  channelSend(topic: string, payload: Json, to: number | 'all' = 'all'): void {
    checkOutgoing(topic, payload);
    if (to !== 'all' && !(Number.isInteger(to) && to >= 0 && to < this.#options.maxPlayers)) {
      fail('PP3362', `A channel message goes to a seat index from 0 to ${this.#options.maxPlayers - 1} or 'all', got ${String(to)}`);
    }
    for (const seat of to === 'all' ? this.seats : [this.seat(to)]) {
      if (seat !== undefined && !seat.leaving) this.#send(seat, { t: 'channel', topic, payload });
    }
  }

  channelReceive(topic: string): readonly ChannelMessage[] {
    return this.#inbox.take(topic);
  }

  #seatJson(seat: Seat): SeatJson {
    return { index: seat.index, id: seat.id, name: seat.name, entity: this.entityOf(seat.index) ?? null };
  }

  #send(seat: Seat, message: ServerMessage, channel: NetChannel = 'reliable'): void {
    if (seat.link === null) return;
    const encoded = encodeServer(message, seat.format);
    this.sent[channel] += wireSize(encoded);
    seat.link.send(encoded, channel);
  }

  /** A host starts taking remote players (a lobby's match started): `listener` is its door. */
  listen(listener: NetListener): void {
    if (this.#listener !== undefined) fail('PP3364', 'This match already takes remote players', { fix: 'Start a lobby\'s match once.' });
    this.#listener = listener;
  }

  close(): void {
    for (const seat of this.seats) if (seat.link !== null) this.#bye(seat.link, seat.format, 'PP3359', 'The server shut down');
    this.#listener?.close();
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  save(): { readonly seats: [number, number | null][] } {
    return { seats: this.seats.map((s) => [s.index, s.entity ?? null]) };
  }

  /**
   * After a restore: seats keep their players, take back their entities, and clients resync
   * from scratch. Local players follow the snapshot: seated when it holds their seat (a hot
   * reload of a playing game), waiting to join again when it doesn't (an editor's Stop).
   */
  load(saved: { readonly seats: readonly (readonly [number, number | null])[] }): void {
    const held = new Set(saved.seats.map(([index]) => index));
    for (const seat of this.seats) {
      if (seat.link !== null || held.has(seat.index)) continue;
      this.#seats[seat.index] = undefined;
      this.#waiting.push({ index: seat.index, name: seat.name });
    }
    for (const [index, entity] of saved.seats) {
      let seat = this.#seats[index];
      const waiting = this.#waiting.findIndex((w) => w.index === index);
      if (seat === undefined && waiting !== -1) {
        seat = this.#newSeat(index, this.#waiting.splice(waiting, 1)[0]!.name, null, 'binary');
        this.#seats[index] = seat;
      }
      if (seat !== undefined) seat.entity = entity === null ? undefined : entity as EntityId;
    }
    this.#waiting.sort((a, b) => a.index - b.index);
    this.#epoch++;
    this.#history.clear();
    for (const seat of this.seats) {
      if (seat.replica === null || this.#scene === undefined) continue;
      seat.replica.reset();
      this.#send(seat, { t: 'scene', epoch: this.#epoch, scene: this.#scene.id, seed: this.#scene.seed });
    }
  }
}

/** Fold a newer input frame into an older one: presses stick; the rest is latest. */
function merge(waiting: Record<string, ActionValue>, next: ActionFrame): Record<string, ActionValue> {
  const out: Record<string, ActionValue> = { ...waiting };
  for (const [name, value] of Object.entries(next)) {
    const before = out[name];
    if (value.k === 'button' && before?.k === 'button') out[name] = { k: 'button', held: value.held, down: value.down || before.down };
    else if (value.k === 'group' && before?.k === 'group') out[name] = { k: 'group', slot: before.slot ?? value.slot };
    else out[name] = value;
  }
  return out;
}

