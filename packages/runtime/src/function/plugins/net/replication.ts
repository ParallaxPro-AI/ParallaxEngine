/**
 * The server's side of state sync: for each client, a view of what it has been sent, and
 * each tick the difference between that and the world as this client may see it.
 *
 * Rules (sdk/parallax/net.pyi):
 *   - which entities: every replicable entity, filtered by `net(visible=fn)` per player.
 *     The function is asked about roots; prefab children follow their root. A placed
 *     entity out of view stays on the client, hidden; a spawned one is destroyed there and
 *     spawned again (a fresh `Spawned`) when it comes back into view.
 *   - which fields: game component fields by `replicate=` ("all" everyone; "owner" the
 *     owning player; "team" the owner and players on the same side — the entity's own
 *     `Side`, else its owner's); engine components whole; resource fields marked
 *     `replicate=True` to everyone. Values travel encoded, modifiers already applied.
 *   - transforms: on first sight (and on coming back into view) in the reliable state;
 *     afterwards entities with a Rigidbody, a Character, or `"replicate_transform": true` in
 *     their prefab travel in every tick's snapshot (`poses`, a delta per client).
 *   - `entity.visible` and tags always.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { resolvePrefab } from '../../../resource/index.js';
import { encode } from '../../kernel/index.js';
import type { EntityCodec, EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import type { Replicate, ReplicationTable } from './bridge.js';
import type { Origins } from './origins.js';
import type { EntityJson, EntityOrigin, SeatJson, TransformWire } from './protocol.js';
import { quantizePose } from './quantize.js';
import type { QuantPose } from './quantize.js';
import { SnapshotSender } from './snapshots.js';

const RIGIDBODY = 'rigidbody';
const CHARACTER = 'character';
const SIDE = 'side';

/** An entity's side (its `Side` tag id), or null. */
export function sideOf(kernel: Kernel, id: EntityId | undefined): string | null {
  if (id === undefined) return null;
  const side = kernel.world.get(id)?.components.get(SIDE)?.['side'];
  if (side === undefined || side === null) return null;
  const stored = encode({ kind: 'tag' }, side, 'side.side');
  return typeof stored === 'string' ? stored : null;
}

interface Known {
  /** Component id → field → the JSON text last sent. */
  readonly components: Map<string, Map<string, string>>;
  visible: boolean;
  hidden: boolean;
  tags: string;
}

/** What one client has been sent. A fresh view (and every scene change) starts with a full sync. */
export class View {
  readonly known = new Map<EntityId, Known>();
  readonly resources = new Map<string, Map<string, string>>();
  /** Pose snapshots and their acknowledged baseline. */
  readonly snapshots = new SnapshotSender();
  players = '';
  full = true;

  reset(): void {
    this.known.clear();
    this.snapshots.reset();
    this.resources.clear();
    this.players = '';
    this.full = true;
  }
}

/** Who is looking: a seat, its team, and whether an entity is in its view. */
export interface Viewer {
  readonly seat: number;
  readonly team: string | null;
  /** Interest for a root entity (`net(visible=)`); absent: everything. */
  readonly sees?: (root: EntityId) => boolean;
}

export interface StateBody {
  readonly entities: EntityJson[];
  readonly destroyed: number[];
  readonly resources: Record<string, JsonObject>;
  readonly players: readonly SeatJson[] | undefined;
}

export class Replicator {
  readonly #kernel: Kernel;
  readonly #table: ReplicationTable;
  readonly #origins: Origins;
  readonly #transformByPrefab = new Map<string, boolean>();
  /** Server ids as entity references on the wire. */
  readonly #codec: EntityCodec;

  constructor(kernel: Kernel, table: ReplicationTable, origins: Origins) {
    this.#kernel = kernel;
    this.#table = table;
    this.#origins = origins;
    this.#codec = {
      encode: (handle) => {
        const id = kernel.handles.unwrap(handle);
        return id === undefined ? null : id;
      },
      decode: () => fail('PP9355', 'The server never decodes its own state'),
    };
  }

  /**
   * The next state for one client. `ownerTeam(seat)` is a seat's team; `players` the seat
   * list as JSON (sent when it changed).
   */
  build(view: View, viewer: Viewer, ownerTeam: (seat: number) => string | null, players: readonly SeatJson[]): StateBody {
    const world = this.#kernel.world;
    const entities: EntityJson[] = [];
    const destroyed: number[] = [];
    const seen = new Set<EntityId>();
    const rootSees = new Map<EntityId, boolean>();
    const sees = (record: EntityRecord): boolean => {
      if (viewer.sees === undefined) return true;
      let root = record;
      while (root.parent !== null) {
        const up = world.get(root.parent);
        if (up === undefined) break;
        root = up;
      }
      let result = rootSees.get(root.id);
      if (result === undefined) rootSees.set(root.id, (result = viewer.sees(root.id)));
      return result;
    };

    for (const record of world.live()) {
      const origin = this.#origins.of(record.id);
      if (origin === undefined) continue;
      const placed = this.#origins.placed(record.id);
      const known = view.known.get(record.id);
      if (!sees(record)) {
        if (placed) {
          seen.add(record.id);
          if (known === undefined) {
            view.known.set(record.id, { components: new Map(), visible: record.visible, hidden: true, tags: '' });
            entities.push({ id: record.id, origin: this.#wireOrigin(record, origin), hidden: true });
          } else if (!known.hidden) {
            known.hidden = true;
            entities.push({ id: record.id, hidden: true });
          }
        }
        continue;
      }
      seen.add(record.id);
      const entry = this.#entry(record, origin, known, viewer, ownerTeam);
      if (known === undefined) view.known.set(record.id, entry.known);
      if (entry.json !== undefined) entities.push(entry.json);
    }
    for (const id of [...view.known.keys()]) {
      if (seen.has(id)) continue;
      view.known.delete(id);
      destroyed.push(id);
    }

    const resources: Record<string, JsonObject> = {};
    for (const [id, names] of this.#table.resources) {
      const fields = this.#kernel.resource(id);
      const schema = this.#kernel.registry.resource(id, 'net replication').schema;
      let sent = view.resources.get(id);
      if (sent === undefined) view.resources.set(id, (sent = new Map()));
      const changed: Record<string, Json> = {};
      for (const name of names) {
        const json = encode(schema[name]!.type, fields[name], `resource ${id}.${name}`, this.#codec);
        const text = JSON.stringify(json);
        if (sent.get(name) === text) continue;
        sent.set(name, text);
        changed[name] = json;
      }
      if (Object.keys(changed).length > 0) resources[id] = changed;
    }

    const playersText = JSON.stringify(players);
    const playersChanged = playersText !== view.players;
    view.players = playersText;
    view.full = false;
    return { entities, destroyed, resources, players: playersChanged ? players : undefined };
  }

  #wireOrigin(record: EntityRecord, origin: NonNullable<ReturnType<Origins['of']>>): EntityOrigin {
    if (origin.kind === 'scene') return { scene: origin.index };
    if (origin.kind === 'child') return { parent: origin.parent, child: origin.index };
    if (record.prefab === undefined) {
      fail('PP9355', `Entity ${record.id} was spawned without a prefab, so a client can't create it`);
    }
    return { prefab: record.prefab, parent: record.parent, owner: record.owner ?? null };
  }

  /** The quantized local poses of the moving entities this client has and sees (the next snapshot). */
  poses(view: View): Map<number, QuantPose> {
    const world = this.#kernel.world;
    const out = new Map<number, QuantPose>();
    for (const [id, known] of view.known) {
      if (known.hidden) continue;
      const record = world.get(id);
      if (record === undefined || !this.replicatesTransform(record)) continue;
      const t = record.transform;
      out.set(id, quantizePose(t.position, t.rotation, t.scale));
    }
    return out;
  }

  /** Moving entities: their transform travels in every snapshot. */
  replicatesTransform(record: EntityRecord): boolean {
    if (record.components.has(RIGIDBODY) || record.components.has(CHARACTER)) return true;
    const prefab = record.prefab;
    if (prefab === undefined) return false;
    let flag = this.#transformByPrefab.get(prefab);
    if (flag === undefined) {
      flag = resolvePrefab(this.#kernel.project, prefab).replicateTransform === true;
      this.#transformByPrefab.set(prefab, flag);
    }
    return flag;
  }

  #allowed(rule: Replicate, record: EntityRecord, viewer: Viewer, ownerTeam: (seat: number) => string | null): boolean {
    if (rule === 'all') return true;
    if (record.owner === viewer.seat) return true;
    if (rule === 'owner') return false;
    const team = sideOf(this.#kernel, record.id) ?? (record.owner === undefined ? null : ownerTeam(record.owner));
    return team !== null && team === viewer.team;
  }

  #entry(
    record: EntityRecord, origin: NonNullable<ReturnType<Origins['of']>>, known: Known | undefined, viewer: Viewer,
    ownerTeam: (seat: number) => string | null,
  ): { readonly json: EntityJson | undefined; readonly known: Known } {
    const fresh = known === undefined;
    const k: Known = known ?? { components: new Map(), visible: true, hidden: false, tags: '' };
    const json: { -readonly [K in keyof EntityJson]: EntityJson[K] } = { id: record.id };
    let changed = fresh;
    // Coming back into view: the client's copy may be stale everywhere.
    const reveal = k.hidden;
    if (fresh) json.origin = this.#wireOrigin(record, origin);

    const set: Record<string, JsonObject> = {};
    for (const [cid, fields] of record.components) {
      const fieldsOut = this.#componentFields(record, cid, fields, k, viewer, ownerTeam);
      if (fieldsOut !== undefined) set[cid] = fieldsOut;
    }
    const removed = [...k.components.keys()].filter((cid) => !record.components.has(cid));
    for (const cid of removed) k.components.delete(cid);
    if (Object.keys(set).length > 0) { json.set = set; changed = true; }
    if (removed.length > 0) { json.removed = removed; changed = true; }

    if (fresh || reveal) {
      const t = record.transform;
      const q = quantizePose(t.position, t.rotation, t.scale);
      const unit = q.s[0] === 1 && q.s[1] === 1 && q.s[2] === 1;
      const transform: TransformWire = { p: q.p, r: q.r, ...(!unit && { s: q.s }) };
      json.transform = transform;
      changed = true;
    }
    if (fresh || record.visible !== k.visible) { k.visible = record.visible; json.visible = record.visible; changed = true; }
    if (reveal) { k.hidden = false; json.hidden = false; changed = true; }
    const tags = [...record.tags].sort();
    const tagsText = tags.join(' ');
    if (fresh || tagsText !== k.tags) { k.tags = tagsText; json.tags = tags; changed = true; }
    return { json: changed ? json : undefined, known: k };
  }

  /** The fields of one component this viewer gets that changed since it last got them (all of them when new). */
  #componentFields(
    record: EntityRecord, cid: string, fields: Fields, k: Known, viewer: Viewer, ownerTeam: (seat: number) => string | null,
  ): JsonObject | undefined {
    const rules = this.#table.components.get(cid);
    const schema = this.#kernel.registry.component(cid, 'net replication').schema;
    let sent = k.components.get(cid);
    const isNew = sent === undefined;
    if (sent === undefined) k.components.set(cid, (sent = new Map()));
    const out: Record<string, Json> = {};
    const names = rules === undefined ? Object.keys(schema) : [...rules.keys()];
    for (const name of names) {
      if (rules !== undefined && !this.#allowed(rules.get(name)!, record, viewer, ownerTeam)) continue;
      const json = encode(schema[name]!.type, fields[name], `${cid}.${name}`, this.#codec);
      const text = JSON.stringify(json);
      if (sent.get(name) === text) continue;
      sent.set(name, text);
      out[name] = json;
    }
    // A component new to the client is announced even when none of its fields replicate,
    // so `entity.has(C)` agrees on both sides.
    return Object.keys(out).length > 0 || isNew ? out : undefined;
  }
}
