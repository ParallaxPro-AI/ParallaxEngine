/**
 * The world: every live entity, its components, tags, behaviors, transform and place in
 * the hierarchy. Iteration is always in spawn order, so everything built on it is
 * deterministic.
 *
 * Destroy semantics (SDK module docs): `destroy` makes an entity — and its children —
 * dead immediately (gone from queries, `alive` false); the kernel tears dead entities
 * down at the end of the phase.
 */

import { EntityIdAllocator, fail } from '../../core/index.js';
import type { EntityId } from '../../core/index.js';
import type { BehaviorDef, LogicInstance } from './definitions.js';
import type { Fields } from './schema.js';
import { TransformNode } from './transform.js';

export interface BehaviorSlot {
  readonly def: BehaviorDef;
  readonly instance: LogicInstance;
  started: boolean;
}

export interface EntityRecord {
  readonly id: EntityId;
  readonly prefab: string | undefined;
  /** The stable id it was placed with in a scene (`Placed.<id>`). */
  readonly placedId: string | undefined;
  /** Its name in the parent prefab's "children", for `entity.child(name)`. */
  readonly childName: string | undefined;
  /** Given at spawn (`spawn(name=)`), for `entity.name` and debugging. */
  readonly name: string | undefined;
  /**
   * The player it was spawned for (a seat/player number the api layer assigns; local and
   * networked players), inherited by its prefab children. Undefined: nobody's.
   */
  readonly owner: number | undefined;
  readonly components: Map<string, Fields>;
  readonly tags: Set<string>;
  readonly behaviors: BehaviorSlot[];
  readonly transform: TransformNode;
  readonly children: EntityId[];
  parent: EntityId | null;
  alive: boolean;
  visible: boolean;
}

export interface NewEntity {
  readonly prefab?: string;
  readonly placedId?: string;
  readonly childName?: string;
  readonly name?: string;
  readonly owner?: number;
}

/**
 * A record's components: a Map that tells the world holding the record when a component id
 * comes or goes, so `World.query` reads a per-component index instead of every entity.
 */
export class ComponentMap extends Map<string, Fields> {
  /** The world indexing this record (set by `World.create` / `replace`), or null. */
  owner: World | null = null;
  record: EntityRecord | null = null;

  override set(key: string, value: Fields): this {
    const added = this.owner !== null && !super.has(key);
    super.set(key, value);
    if (added) this.owner!.indexComponent(this.record!, key, true);
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had && this.owner !== null) this.owner.indexComponent(this.record!, key, false);
    return had;
  }

  override clear(): void {
    const keys = this.owner === null ? [] : [...super.keys()];
    super.clear();
    for (const key of keys) this.owner!.indexComponent(this.record!, key, false);
  }
}

/** A fresh record for `id`: no components, behaviors or parent; identity transform. */
export function newRecord(id: EntityId, init: NewEntity = {}): EntityRecord {
  const components = new ComponentMap();
  const record: EntityRecord = {
    id,
    prefab: init.prefab,
    placedId: init.placedId,
    childName: init.childName,
    name: init.name,
    owner: init.owner,
    components,
    tags: new Set(),
    behaviors: [],
    transform: new TransformNode(),
    children: [],
    parent: null,
    alive: true,
    visible: true,
  };
  components.record = record;
  return record;
}

/** Records holding one component id, in insertion order; `sorted` while that is spawn order. */
interface ComponentIndex {
  readonly records: Set<EntityRecord>;
  sorted: boolean;
  last: number;
}

/** The id allocator's state, as snapshots hold it. */
export type IdState = ReturnType<EntityIdAllocator['save']>;

export interface QueryFilter {
  readonly tagged?: readonly string[];
  readonly without?: readonly string[];
}

export class World {
  #ids = new EntityIdAllocator();
  /** Live and doomed entities, in spawn order. */
  readonly #entities = new Map<EntityId, EntityRecord>();
  #doomed: EntityRecord[] = [];
  /** Spawn sequence per record (ids are reused, so they don't give spawn order). */
  readonly #order = new WeakMap<EntityRecord, number>();
  #sequence = 0;
  /** Component id → records that hold it (live and doomed), for `query`. */
  readonly #byComponent = new Map<string, ComponentIndex>();
  /** False once a record whose components aren't a ComponentMap joins (snapshot of hand-built records): queries scan. */
  #indexable = true;

  create(init: NewEntity = {}): EntityRecord {
    const record = newRecord(this.#ids.allocate(), init);
    this.#entities.set(record.id, record);
    this.#track(record);
    return record;
  }

  #track(record: EntityRecord): void {
    this.#order.set(record, this.#sequence++);
    const components = record.components;
    if (components instanceof ComponentMap) {
      components.owner = this;
      components.record = record;
    } else this.#indexable = false;
    for (const key of components.keys()) this.indexComponent(record, key, true);
  }

  #untrack(record: EntityRecord): void {
    for (const key of record.components.keys()) this.indexComponent(record, key, false);
    const components = record.components;
    if (components instanceof ComponentMap && components.owner === this) components.owner = null;
  }

  /** Keep the component index in step (ComponentMap calls this). */
  indexComponent(record: EntityRecord, key: string, added: boolean): void {
    let index = this.#byComponent.get(key);
    if (!added) {
      index?.records.delete(record);
      return;
    }
    if (index === undefined) this.#byComponent.set(key, (index = { records: new Set(), sorted: true, last: -1 }));
    const seq = this.#order.get(record) ?? Infinity;
    if (index.records.has(record)) return;
    if (seq < index.last) index.sorted = false;
    else index.last = seq;
    index.records.add(record);
  }

  #indexed(key: string): Set<EntityRecord> | undefined {
    const index = this.#byComponent.get(key);
    if (index === undefined) return undefined;
    if (!index.sorted) {
      const order = this.#order;
      const sorted = [...index.records].sort((a, b) => order.get(a)! - order.get(b)!);
      index.records.clear();
      for (const r of sorted) index.records.add(r);
      index.sorted = true;
      index.last = sorted.length === 0 ? -1 : order.get(sorted[sorted.length - 1]!)!;
    }
    return index.records;
  }

  /** True when no destroyed entity is waiting to be torn down. */
  get settled(): boolean {
    return this.#doomed.length === 0;
  }

  idState(): IdState {
    return this.#ids.save();
  }

  /**
   * Replace every entity (snapshot restore): `records` are live, in spawn order, and are
   * exactly the ids `ids` holds live, so stored ids and stale ids both stay what they were.
   */
  replace(ids: IdState, records: readonly EntityRecord[]): void {
    const allocator = EntityIdAllocator.restore(ids);
    for (const record of records) {
      if (!allocator.isAlive(record.id)) fail('PP9002', `Saved entity ${record.id} is not live in the saved id state`);
    }
    if (allocator.count !== records.length) {
      fail('PP9002', `The saved id state has ${allocator.count} live entities, but ${records.length} were saved`);
    }
    this.#ids = allocator;
    for (const record of this.#entities.values()) this.#untrack(record);
    this.#entities.clear();
    this.#byComponent.clear();
    this.#indexable = true;
    this.#doomed = [];
    for (const record of records) {
      this.#entities.set(record.id, record);
      this.#track(record);
    }
  }

  /** The live entity, or undefined. */
  get(id: EntityId): EntityRecord | undefined {
    const record = this.#entities.get(id);
    return record?.alive === true ? record : undefined;
  }

  /**
   * The entity even if it was destroyed this phase and is waiting for teardown (so `end()`
   * hooks and `destroyed` handlers can still read it); undefined once torn down.
   */
  peek(id: EntityId): EntityRecord | undefined {
    return this.#entities.get(id);
  }

  /** The live entity; a destroyed one is PP3002. */
  require(id: EntityId): EntityRecord {
    const record = this.get(id);
    if (record === undefined) {
      fail('PP3002', 'This entity was destroyed', { fix: 'Check `entity.alive` before using a stored entity.' });
    }
    return record;
  }

  isAlive(id: EntityId): boolean {
    return this.get(id) !== undefined;
  }

  /** Live entities in spawn order. */
  *live(): IterableIterator<EntityRecord> {
    for (const record of this.#entities.values()) if (record.alive) yield record;
  }

  get count(): number {
    let n = 0;
    for (const _ of this.live()) n++;
    return n;
  }

  attach(child: EntityRecord, parent: EntityRecord): void {
    this.detach(child);
    child.parent = parent.id;
    parent.children.push(child.id);
    child.transform.parent = parent.transform;
  }

  detach(child: EntityRecord): void {
    if (child.parent === null) return;
    const parent = this.#entities.get(child.parent);
    if (parent !== undefined) parent.children.splice(parent.children.indexOf(child.id), 1);
    child.parent = null;
    child.transform.parent = null;
  }

  /**
   * Rows of `[entity, ...components]` for live entities that have every component in
   * `componentIds` and match the tag filter, in spawn order.
   */
  query(componentIds: readonly string[], filter: QueryFilter = {}): Array<[EntityId, ...Fields[]]> {
    const rows: Array<[EntityId, ...Fields[]]> = [];
    // Read the smallest per-component index (in spawn order) rather than every entity.
    let source: Iterable<EntityRecord> | undefined;
    if (componentIds.length > 0 && this.#indexable) {
      let smallest: Set<EntityRecord> | undefined;
      for (const id of componentIds) {
        const set = this.#indexed(id);
        if (set === undefined || set.size === 0) return rows;
        if (smallest === undefined || set.size < smallest.size) smallest = set;
      }
      source = [...smallest!];
    }
    for (const record of source ?? this.live()) {
      if (!record.alive) continue;
      if (filter.tagged?.some((tag) => !record.tags.has(tag)) === true) continue;
      if (filter.without?.some((x) => record.tags.has(x) || record.components.has(x)) === true) continue;
      const components: Fields[] = [];
      for (const id of componentIds) {
        const fields = record.components.get(id);
        if (fields === undefined) break;
        components.push(fields);
      }
      if (components.length === componentIds.length) rows.push([record.id, ...components]);
    }
    return rows;
  }

  /** Kill an entity and its descendants now; returns them in destroy order (parent first). */
  destroy(id: EntityId): EntityRecord[] {
    const record = this.get(id);
    if (record === undefined) return [];
    const killed: EntityRecord[] = [];
    const visit = (r: EntityRecord): void => {
      r.alive = false;
      killed.push(r);
      for (const childId of r.children) {
        const child = this.get(childId);
        if (child !== undefined) visit(child);
      }
    };
    visit(record);
    this.#doomed.push(...killed);
    return killed;
  }

  /** Entities killed since the last call, for the kernel's end-of-phase teardown. */
  takeDoomed(): EntityRecord[] {
    const doomed = this.#doomed;
    this.#doomed = [];
    return doomed;
  }

  /** Forget torn-down entities and free their ids. */
  remove(records: readonly EntityRecord[]): void {
    for (const record of records) {
      if (record.parent !== null) {
        const parent = this.#entities.get(record.parent);
        if (parent !== undefined) {
          const at = parent.children.indexOf(record.id);
          if (at >= 0) parent.children.splice(at, 1);
        }
      }
      this.#entities.delete(record.id);
      this.#untrack(record);
      this.#ids.release(record.id);
    }
  }
}
