/**
 * A player's machine: it loads the scene the server is in, mirrors the state the server
 * sends (entities mapped server id ↔ local id through their origins), follows the server's
 * game clock, and sends this player's input and RPCs. Game behaviors and server systems
 * don't run here (the kernel's definition is filtered when the plugin is configured as a
 * client) — except the game's predicted behaviors on this player's own entities.
 *
 * Per frame:
 *   input   drain the link: reliable state (structure, fields, feedback) applies in order;
 *           snapshots are reconstructed against their baseline, stamp the server clock, and
 *           feed the pose buffers. Predicted entities are reconciled with the newest
 *           snapshot and take this frame's share of any correction. This player's input
 *           frame goes out (every frame while predicting; otherwise when it changes and at
 *           the tick rate, which also carries acknowledgements and the view time).
 *   ui      every other moving entity is placed at its interpolated pose for the render
 *           time (the estimated server clock minus the interpolation delay).
 *   render  the predicted entities' poses are recorded against the input frame just sent.
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId, NetChannel, NetLink, Quat } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { decode, encode } from '../../kernel/index.js';
import type { EntityCodec, EntityRecord, FieldType, Kernel } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import type { ChannelMessage } from '../../services/index.js';
import type { RuntimeBridges } from './bridge.js';
import { ChannelInbox, checkOutgoing } from './channels.js';
import { PoseBuffers, ServerClock } from './interpolation.js';
import type { Pose } from './interpolation.js';
import type { Origins } from './origins.js';
import { Prediction } from './prediction.js';
import type { Correction, PredictionOptions } from './prediction.js';
import { PROTOCOL } from './protocol.js';
import type {
  ActionFrame, ActionValue, ClientMessage, EntityJson, InputFrame, PointerJson, SeatJson, ServerMessage, TransformWire, WireFormat,
} from './protocol.js';
import { positionOf, unpackRotation } from './quantize.js';
import type { QuantPose } from './quantize.js';
import { SnapshotReceiver } from './snapshots.js';
import { decodeServer, encodeClient, wireSize } from './wire.js';
import { applyWorld, worldOf } from './world_sync.js';

type StateMessage = Extract<ServerMessage, { t: 'state' }>;
type SnapMessage = Extract<ServerMessage, { t: 'snap' }>;

/** Input frames resent on an unreliable link until acknowledged. */
const REDUNDANCY = 4;

export interface ClientEnd {
  readonly code: string;
  readonly message: string;
}

export interface ClientOptions {
  readonly format: WireFormat;
  /** A token from an earlier connection: take that seat back. */
  readonly rejoin?: string;
  /** Fixed interpolation delay in seconds; undefined: adaptive. */
  readonly interpolation?: number;
  readonly prediction: PredictionOptions;
  /** Seconds a moving entity is extrapolated past its newest snapshot before it holds. */
  readonly maxExtrapolation: number;
}

function idleValue(v: ActionValue): boolean {
  switch (v.k) {
    case 'button': return !v.held && !v.down;
    case 'axis1': return v.value === 0;
    case 'axis2': return v.x === 0 && v.y === 0;
    case 'group': return v.slot === null;
  }
}

function poseOf(q: QuantPose): Pose {
  return { position: positionOf(q.p), rotation: unpackRotation(q.r), scale: new Vec3(q.s[0], q.s[1], q.s[2]) };
}

function transformPose(t: TransformWire): Pose {
  const s = t.s ?? [1, 1, 1];
  return { position: positionOf(t.p), rotation: unpackRotation(t.r), scale: new Vec3(s[0], s[1], s[2]) };
}

export interface ClientStats {
  /** Bytes received, by message type. */
  readonly bytes: Record<string, number>;
  /** Snapshots reconstructed. */
  snapshots: number;
}

export class NetClient {
  readonly #kernel: Kernel;
  readonly #origins: Origins;
  readonly #options: ClientOptions;
  #link: NetLink;
  readonly #name: string;
  #bridges: RuntimeBridges | undefined;
  #seat: SeatJson | undefined;
  #players: readonly SeatJson[] = [];
  #tickRate = 30;
  #token: string | undefined;
  #expected: { readonly epoch: number; readonly scene: string } | undefined;
  #epoch = -1;
  #synced = false;
  readonly #waiting: StateMessage[] = [];
  #snaps: SnapMessage[] = [];
  readonly #toLocal = new Map<number, EntityId>();
  readonly #toServer = new Map<EntityId, number>();
  /** `entity.visible` as the server's game code set it, and interest-hidden entities. */
  readonly #serverVisible = new Map<EntityId, boolean>();
  readonly #hidden = new Set<EntityId>();
  // Snapshots, clock and interpolation.
  readonly #receiver = new SnapshotReceiver();
  #clock: ServerClock;
  readonly #buffers: PoseBuffers;
  #latest: { readonly tick: number; readonly ack: number; readonly poses: ReadonlyMap<number, QuantPose> } | undefined;
  #reconciled = -1;
  #view = 0;
  // Input and prediction.
  #seq = -1;
  #unacked: InputFrame[] = [];
  #lastInput = '';
  /** The pointer last sent (a frame leaves it out while it hasn't changed). */
  #lastPointer = '';
  #lastSent = -Infinity;
  readonly prediction: Prediction;
  readonly #predicted = new Set<EntityId>();
  /** True while this client spawns an entity the server sent (its behaviors start inside the spawn). */
  #binding = false;
  /** Calls the server dropped (rate limit, bad arguments). */
  readonly rejections: { readonly rpc: string; readonly code: string; readonly message: string }[] = [];
  readonly #inbox = new ChannelInbox();
  /** Why the server ended the connection, once it has. */
  ended: ClientEnd | undefined;
  readonly stats: ClientStats = { bytes: {}, snapshots: 0 };
  readonly #decodeCodec: EntityCodec;
  readonly #encodeCodec: EntityCodec;

  constructor(kernel: Kernel, origins: Origins, link: NetLink, name: string, options: ClientOptions) {
    this.#kernel = kernel;
    this.#origins = origins;
    this.#link = link;
    this.#name = name;
    this.#options = options;
    this.#token = options.rejoin;
    this.#clock = new ServerClock({ interval: 1 / this.#tickRate, ...(options.interpolation !== undefined && { delay: options.interpolation }) });
    this.#buffers = new PoseBuffers(options.maxExtrapolation);
    this.prediction = new Prediction(options.prediction);
    this.#decodeCodec = {
      encode: () => fail('PP9355', 'The client never encodes state'),
      decode: (value) => {
        const local = typeof value === 'number' ? this.#toLocal.get(value) : undefined;
        return local !== undefined && kernel.world.isAlive(local) ? kernel.handles.wrap(local) : null;
      },
    };
    this.#encodeCodec = {
      encode: (handle, where) => {
        const local = kernel.handles.unwrap(handle);
        const server = local === undefined ? undefined : this.#toServer.get(local);
        if (server === undefined) fail('PP3355', `${where}: this entity exists only on this client, so the server can't be told about it`);
        return server;
      },
      decode: () => fail('PP9355', 'RPC arguments are encoded on the client'),
    };
    kernel.observeScenes({
      loading: (scene) => {
        // The boot's own start-scene load happens before the server is heard from.
        if (this.#seat === undefined) return;
        const expected = this.#expected;
        if (expected === undefined || expected.scene !== scene.id) {
          fail('PP3358', `This client loaded scene "${scene.id}" on its own; in a networked game scenes follow the server`, {
            fix: 'Load scenes from server code (a system, or an @rpc a panel button calls), not from a client-side panel command.',
          });
        }
        this.#epoch = expected.epoch;
        this.#expected = undefined;
        this.#synced = false;
        this.#toLocal.clear();
        this.#toServer.clear();
        this.#serverVisible.clear();
        this.#hidden.clear();
        this.#resetMotion();
      },
    });
    kernel.observeEntities({
      removed: (records) => {
        for (const r of records) {
          this.#predicted.delete(r.id);
          this.prediction.forget(r.id);
        }
      },
    });
  }

  get seat(): SeatJson | undefined { return this.#seat; }
  get players(): readonly SeatJson[] { return this.#players; }
  /** True once the first full state of the current scene has been applied. */
  get synced(): boolean { return this.#synced; }
  /** Present it (`NetSession.rejoin`, or `reconnect`) to take this seat back after the link drops. */
  get rejoinToken(): string | undefined { return this.#token; }
  /** The server clock estimate and interpolation delay in use. */
  get clock(): ServerClock { return this.#clock; }
  /** The server time this client is showing (its last render time). */
  get viewTime(): number { return this.#view; }
  /** Snapshots that couldn't be reconstructed (their baseline was gone). */
  get unusableSnapshots(): number { return this.#receiver.unusable; }

  /** The local entity for a server id, while it exists here. */
  local(serverId: number | null): EntityId | undefined {
    if (serverId === null) return undefined;
    const id = this.#toLocal.get(serverId);
    return id !== undefined && this.#kernel.world.isAlive(id) ? id : undefined;
  }

  serverId(local: EntityId): number | undefined {
    return this.#toServer.get(local);
  }

  /** The newest pose the server sent for an entity (no interpolation), for diagnostics. */
  latestPosition(serverId: number): Vec3 | undefined {
    const q = this.#latest?.poses.get(serverId);
    return q === undefined ? undefined : positionOf(q.p);
  }

  /** Entities this client predicts (a predicted behavior ran on them here). */
  get predicted(): ReadonlySet<EntityId> { return this.#predicted; }

  /** Whether a predicted behavior may run on `entity` here (this player's own), marking it predicted. */
  predicts(entity: EntityId): boolean {
    const seat = this.#seat;
    if (seat === undefined) return false;
    const record = this.#kernel.world.get(entity);
    // Server entities only (mapped, or being spawned from the server's state right now).
    if (record === undefined || record.owner !== seat.index || !(this.#binding || this.#toServer.has(entity))) return false;
    this.#predicted.add(entity);
    return true;
  }

  attach(bridges: RuntimeBridges): void {
    this.#bridges = bridges;
    bridges.input.seats(1, [0], true);
    this.#hello();
    this.#kernel.addHook('input', (dt) => this.#input(dt));
    this.#kernel.addHook('ui', () => this.#present());
    this.#kernel.addHook('render', () => this.#record());
  }

  /** A new link after this one dropped: take the seat back (the server resends everything). */
  reconnect(link: NetLink): void {
    if (this.#token === undefined) fail('PP3360', 'This client never joined, so it has no seat to take back');
    this.#link = link;
    this.ended = undefined;
    this.#waiting.length = 0;
    this.#snaps = [];
    this.#seq = -1;
    this.#unacked = [];
    this.#lastInput = '';
    this.#lastPointer = '';
    this.#resetMotion();
    this.#hello();
  }

  /** Leave the match on purpose (the seat is freed at once, no rejoin window). */
  leave(): void {
    this.#send({ t: 'leave' });
    this.#link.close('left');
  }

  /** Ask the server to run an RPC; `args` are game values, encoded here by `types`. */
  call(rpc: string, args: Readonly<Record<string, { readonly type: FieldType; readonly value: unknown }>>): void {
    const encoded: Record<string, Json> = {};
    for (const [name, { type, value }] of Object.entries(args)) {
      encoded[name] = encode(type, value, `RPC "${rpc}" argument "${name}"`, this.#encodeCodec);
    }
    this.#send({ t: 'rpc', rpc, args: encoded, view: this.#viewStamp() });
  }

  /** The view time to stamp input and RPCs with; -1 until this client has a server clock. */
  #viewStamp(): number {
    return this.#clock.ready ? this.#view : -1;
  }

  // ── Channels (services/channels.ts) ─────────────────────────────────────────

  /** A plugin message to the server (a client talks to nothing else). */
  channelSend(topic: string, payload: Json, to?: number | 'all'): void {
    if (to !== undefined) {
      fail('PP3363', `A client's channel message goes to the server only, but it named ${String(to)}`, {
        fix: 'Leave out the seat; the server forwards what other players should get.',
      });
    }
    checkOutgoing(topic, payload);
    this.#send({ t: 'channel', topic, payload });
  }

  channelReceive(topic: string): readonly ChannelMessage[] {
    return this.#inbox.take(topic);
  }

  #hello(): void {
    this.#send({ t: 'hello', protocol: PROTOCOL, name: this.#name, ...(this.#token !== undefined && { rejoin: this.#token }) });
  }

  #send(message: ClientMessage, channel: NetChannel = 'reliable'): void {
    this.#link.send(encodeClient(message, this.#options.format), channel);
  }

  #resetMotion(): void {
    this.#receiver.reset();
    this.#buffers.reset();
    this.#clock.reset();
    this.prediction.reset();
    this.#predicted.clear();
    this.#latest = undefined;
    this.#reconciled = -1;
  }

  #input(realDt: number): void {
    for (const raw of this.#link.receive()) {
      const message = decodeServer(raw);
      this.stats.bytes[message.t] = (this.stats.bytes[message.t] ?? 0) + wireSize(raw);
      this.#handle(message);
    }
    if (this.#link.state === 'closed' && this.ended === undefined) {
      this.ended = { code: 'PP3359', message: this.#link.closeReason ?? 'connection closed' };
    }
    // Scene changes happen at the end of a frame, so the state for a new scene waits a frame.
    while (this.#waiting.length > 0 && this.#waiting[0]!.epoch <= this.#epoch) {
      const state = this.#waiting.shift()!;
      if (state.epoch === this.#epoch) this.#apply(state);
    }
    this.#takeSnapshots();
    this.#reconcile(realDt);
    if (this.#seat !== undefined && this.#synced && this.#link.state === 'open') this.#sendInput();
  }

  #handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        if (message.protocol !== PROTOCOL) fail('PP9356', `The server speaks protocol ${message.protocol}; this client speaks ${PROTOCOL}`);
        this.#seat = message.seat;
        this.#token = message.token;
        if (message.tick_rate !== this.#tickRate) {
          this.#tickRate = message.tick_rate;
          const delay = this.#options.interpolation;
          this.#clock = new ServerClock({ interval: 1 / this.#tickRate, ...(delay !== undefined && { delay }) });
        }
        {
          // Game code reading input as this player's entity reads seat `index`; systems read seat 0.
          const index = message.seat.index;
          this.#bridges!.input.seats(index + 1, index === 0 ? [0] : [0, index], true);
        }
        return;
      case 'scene':
        this.#expected = { epoch: message.epoch, scene: message.scene };
        this.#kernel.requestScene(message.scene, { seed: message.seed });
        return;
      case 'state':
        this.#waiting.push(message);
        return;
      case 'snap':
        this.#snaps.push(message);
        return;
      case 'channel':
        this.#inbox.put(message.topic, { from: 'server', payload: message.payload });
        return;
      case 'rejected':
        this.rejections.push({ rpc: message.rpc, code: message.code, message: message.message });
        return;
      case 'bye':
        this.ended = { code: message.code, message: message.message };
    }
  }

  // ── Snapshots, clock, prediction ─────────────────────────────────────────────

  #takeSnapshots(): void {
    if (this.#snaps.length === 0) return;
    const snaps = this.#snaps.filter((s) => s.epoch === this.#epoch).sort((a, b) => a.tick - b.tick);
    // Ones for a scene this client hasn't loaded yet wait; older scenes' are dropped.
    this.#snaps = this.#snaps.filter((s) => s.epoch > this.#epoch);
    const local = this.#kernel.time.realNow;
    for (const snap of snaps) {
      const poses = this.#receiver.receive(snap.tick, snap.base, snap.poses);
      if (poses === undefined) continue;
      this.stats.snapshots++;
      this.#clock.observe(snap.rt, local);
      for (const [id, q] of poses) this.#buffers.push(id, snap.rt, poseOf(q));
      this.#latest = { tick: snap.tick, ack: snap.ack, poses };
      // The client's game clock follows the server's (cooldowns and timers compare against it).
      this.#kernel.time.now = snap.now;
      this.#kernel.time.sceneStart = snap.sceneStart;
    }
  }

  #reconcile(realDt: number): void {
    const latest = this.#latest;
    const fresh = latest !== undefined && latest.tick > this.#reconciled;
    if (fresh) this.#reconciled = latest.tick;
    for (const entity of this.#predicted) {
      if (!this.#kernel.world.isAlive(entity)) continue;
      if (fresh) {
        const serverId = this.#toServer.get(entity);
        const q = serverId === undefined ? undefined : latest.poses.get(serverId);
        if (q !== undefined) {
          const snap = this.prediction.reconcile(entity, latest.ack, positionOf(q.p), unpackRotation(q.r));
          if (snap !== undefined) this.#nudge(entity, snap);
        }
      }
      const share = this.prediction.step(entity, realDt);
      if (share !== undefined) this.#nudge(entity, share);
    }
  }

  /** Move a predicted entity by a correction (through its physics body when it has one). */
  #nudge(entity: EntityId, c: Correction): void {
    const t = this.#kernel.world.require(entity).transform;
    this.#place(entity, t.position.__add__(c.position), c.rotation.__mul__(t.rotation), undefined, true);
  }

  #place(entity: EntityId, position: Vec3, rotation: Quat, scale: Vec3 | undefined, keepVelocity: boolean): void {
    const record = this.#kernel.world.require(entity);
    const physics = record.parent === null ? this.#kernel.tryService(PHYSICS3D_SERVICE) : undefined;
    if (physics !== undefined && physics.body(entity) !== undefined) physics.teleport(entity, position, rotation, keepVelocity);
    else {
      record.transform.position = position;
      record.transform.rotation = rotation;
    }
    if (scale !== undefined) record.transform.scale = scale;
  }

  /** ui hook: every moving entity this client doesn't predict, at the render time. */
  #present(): void {
    if (!this.#clock.ready) return;
    const t = this.#clock.renderTime(this.#kernel.time.realNow);
    this.#view = t;
    for (const [serverId, local] of this.#toLocal) {
      if (this.#predicted.has(local) || !this.#buffers.has(serverId)) continue;
      const pose = this.#buffers.sample(serverId, t);
      if (pose === undefined || !this.#kernel.world.isAlive(local)) continue;
      this.#place(local, pose.position, pose.rotation, pose.scale, false);
    }
  }

  /** render hook: the predicted poses after the frame, against the input frame it sent. */
  #record(): void {
    if (this.#seq < 0) return;
    for (const entity of this.#predicted) {
      const record = this.#kernel.world.get(entity);
      if (record === undefined) continue;
      this.prediction.record(entity, this.#seq, record.transform.position, record.transform.rotation);
    }
  }

  #sendInput(): void {
    const mine = this.#players.find((p) => p.index === this.#seat!.index);
    const all = this.#bridges!.input.capture(this.#seat!.index, this.local(mine?.entity ?? null) ?? null);
    const actions: Record<string, ActionValue> = {};
    for (const [name, value] of Object.entries(all)) if (!idleValue(value)) actions[name] = value;
    const p = this.#bridges!.input.pointer();
    // An entity only this client has (a local effect, a client-side spawn) is nothing to the server.
    const pointer: PointerJson = {
      x: p.x, y: p.y, world: p.world, over: p.over === null ? null : this.#toServer.get(p.over) ?? null, held: p.held, down: p.pressed,
    };
    const text = JSON.stringify([actions, pointer]);
    const now = this.#kernel.time.realNow;
    const predicting = this.#predicted.size > 0;
    if (!predicting && text === this.#lastInput && now - this.#lastSent + 1e-9 < 1 / this.#tickRate) return;
    this.#lastInput = text;
    this.#lastSent = now;
    const pointerText = JSON.stringify(pointer);
    const frame: InputFrame = { seq: ++this.#seq, actions: actions as ActionFrame, ...(pointerText !== this.#lastPointer && { pointer }) };
    this.#lastPointer = pointerText;
    const acked = this.#latest?.ack ?? -1;
    this.#unacked = this.#unacked.filter((f) => f.seq > acked);
    this.#unacked.push(frame);
    if (this.#unacked.length > REDUNDANCY) this.#unacked.splice(0, this.#unacked.length - REDUNDANCY);
    const frames = this.#link.unreliable ? this.#unacked : [frame];
    this.#send({ t: 'input', ack: this.#receiver.newest, view: this.#viewStamp(), frames }, 'unreliable');
  }

  // ── Applying state ───────────────────────────────────────────────────────────

  #apply(state: StateMessage): void {
    const kernel = this.#kernel;
    if (state.players !== undefined) {
      this.#players = state.players;
      const me = state.players.find((p) => p.index === this.#seat?.index);
      if (me !== undefined) this.#seat = me;
    }
    for (const entry of state.entities) if (entry.origin !== undefined) this.#bind(entry);
    for (const entry of state.entities) this.#update(entry);
    for (const [id, fields] of Object.entries(state.resources ?? {})) {
      const target = kernel.resource(id);
      const schema = kernel.registry.resource(id, 'net state').schema;
      for (const [name, json] of Object.entries(fields)) {
        const spec = schema[name];
        if (spec === undefined) fail('PP9355', `The server sent resource field ${id}.${name}, which this client doesn't have`);
        target[name] = decode(spec.type, json, `resource ${id}.${name}`, this.#decodeCodec);
      }
    }
    for (const serverId of state.destroyed) {
      const local = this.#toLocal.get(serverId);
      this.#toLocal.delete(serverId);
      this.#receiver.forget(serverId);
      this.#buffers.forget(serverId);
      if (local === undefined) continue;
      this.#toServer.delete(local);
      if (kernel.world.isAlive(local)) kernel.destroy(local);
    }
    if (!this.#synced) {
      // The first state of a scene names every placed entity the server still has.
      for (const record of [...kernel.world.live()]) {
        if (this.#origins.placed(record.id) && !this.#toServer.has(record.id) && kernel.world.isAlive(record.id)) {
          kernel.destroy(record.id);
        }
      }
      this.#synced = true;
    }
    if (state.world !== undefined) applyWorld(this.#kernel, worldOf(state.world));
    if (state.feedback !== undefined) {
      const entity = (serverId: number): unknown => {
        const local = this.local(serverId);
        return local === undefined ? null : this.#kernel.handles.wrap(local);
      };
      for (const item of state.feedback) this.#bridges!.feedback.play(item, entity);
    }
  }

  #map(serverId: number, local: EntityId): void {
    this.#toLocal.set(serverId, local);
    this.#toServer.set(local, serverId);
  }

  #bind(entry: EntityJson): void {
    const origin = entry.origin!;
    let local: EntityId | undefined;
    if ('scene' in origin) {
      local = this.#origins.sceneRoot(origin.scene);
    } else if ('child' in origin) {
      const parent = this.local(origin.parent);
      local = parent === undefined ? undefined : this.#origins.child(parent, origin.child);
    } else {
      const parent = origin.parent === null ? undefined : this.local(origin.parent);
      if (origin.parent !== null && parent === undefined) {
        fail('PP9355', `The server spawned entity ${entry.id} under ${origin.parent}, which this client doesn't have`);
      }
      const t = entry.transform === undefined ? undefined : transformPose(entry.transform);
      const over = t === undefined ? {} : {
        at: [t.position.x, t.position.y, t.position.z],
        rotation: ((e: Vec3) => [e.x, e.y, e.z])(t.rotation.to_euler()),
        scale: [t.scale.x, t.scale.y, t.scale.z],
      };
      this.#binding = true;
      try {
        local = this.#kernel.spawn(origin.prefab, over, {
          ...(origin.owner !== null && { owner: origin.owner }),
          ...(parent !== undefined && { parent }),
        }).id;
      } finally {
        this.#binding = false;
      }
    }
    if (local === undefined || !this.#kernel.world.isAlive(local)) {
      fail('PP9355', `This client has no entity matching the server's ${entry.id} (${JSON.stringify(origin)})`, {
        fix: 'Client and server must run the same build of the game and load the same scene.',
      });
    }
    this.#map(entry.id, local);
  }

  #update(entry: EntityJson): void {
    const kernel = this.#kernel;
    const local = this.#toLocal.get(entry.id);
    if (local === undefined) fail('PP9355', `The server updated entity ${entry.id} before this client was told about it`);
    const record: EntityRecord | undefined = kernel.world.get(local);
    if (record === undefined) return; // destroyed here this frame (a parent went first)
    for (const [cid, fields] of Object.entries(entry.set ?? {})) {
      const schema = kernel.registry.component(cid, 'net state').schema;
      const values: Record<string, unknown> = {};
      for (const [name, json] of Object.entries(fields as JsonObject)) {
        const spec = schema[name];
        if (spec === undefined) fail('PP9355', `The server sent ${cid}.${name}, which this client doesn't have`);
        values[name] = decode(spec.type, json, `${cid}.${name}`, this.#decodeCodec);
      }
      const target = record.components.get(cid);
      if (target === undefined) kernel.addComponent(local, cid, values);
      else Object.assign(target, values);
    }
    for (const cid of entry.removed ?? []) if (record.components.has(cid)) kernel.removeComponent(local, cid);
    if (entry.transform !== undefined) {
      const pose = transformPose(entry.transform);
      this.#place(local, pose.position, pose.rotation, pose.scale, false);
    }
    if (entry.visible !== undefined) this.#serverVisible.set(local, entry.visible);
    if (entry.hidden === true) this.#hidden.add(local);
    if (entry.hidden === false) this.#hidden.delete(local);
    record.visible = (this.#serverVisible.get(local) ?? true) && !this.#hidden.has(local);
    if (entry.tags !== undefined) {
      record.tags.clear();
      for (const tag of entry.tags) record.tags.add(tag);
    }
  }
}

