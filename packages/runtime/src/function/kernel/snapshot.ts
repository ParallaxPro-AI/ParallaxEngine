/**
 * Snapshots: one running game as plain JSON (`kernel.snapshot()` / `kernel.restore()`),
 * for test branching, checkpoints and rollback.
 *
 * Captured: the scene, the clock (including the fixed-step accumulator), every resource
 * field of every lifetime, every live entity with its exact id (and the id allocator, so
 * stored entity handles stay valid and stale ones stay stale), prefab, placed id, child
 * name, spawn name, owner, tags, transform, hierarchy, visibility, components (base values plus
 * modifier lists), each behavior's params and `state()`, and each plugin's own state.
 *
 * Not captured, by design (SDK docs): running timers and tasks — after a restore none
 * are running and handles to them are inactive; system instances (systems have no
 * fields); behavior attributes that are neither `param()` nor `state()`.
 *
 * Restore recreates behavior instances (`def.create()`) and assigns params and state;
 * `start` does not run again, and nothing ends: restoring is not a scene load.
 *
 * Slot saves and the profile store are narrower: `kernel.saveResources`
 * writes the resource fields of chosen lifetimes ("run" for slots, "profile" for the
 * profile store) in the JSON shape migrations see (`SaveData.resources`).
 */

import { fail, Quat, Vec3 } from '../../core/index.js';
import type { EntityId } from '../../core/index.js';
import type { Json, JsonObject } from '../../resource/index.js';
import type { BehaviorDef } from './definitions.js';
import { baseValue, clearModifiers, modifierStates, restoreModifiers } from './modifiers.js';
import type { ModifierState, Now } from './modifiers.js';
import type { Registry } from './registry.js';
import { decode, decodeFields, encode, encodeFields } from './schema.js';
import type { EntityCodec, Fields, FieldType, Schema } from './schema.js';
import { bindComponent } from './spawner.js';
import { newRecord } from './world.js';
import type { EntityRecord, IdState } from './world.js';

/** Bumped when the snapshot shape changes; a snapshot of another format is refused. */
export const SNAPSHOT_FORMAT = 2;

/** A component's or resource's fields: base values, plus modifier lists by field. */
export interface FieldsSnapshot {
  readonly fields: JsonObject;
  readonly modifiers?: Readonly<Record<string, readonly ModifierState[]>>;
}

export interface BehaviorSnapshot {
  readonly use: string;
  readonly params: JsonObject;
  readonly state: JsonObject;
}

export interface TransformSnapshot {
  readonly position: readonly number[];
  /** Quaternion x, y, z, w. */
  readonly rotation: readonly number[];
  readonly scale: readonly number[];
}

export interface EntitySnapshot {
  readonly id: number;
  readonly prefab?: string;
  readonly placedId?: string;
  readonly childName?: string;
  readonly name?: string;
  readonly owner?: number;
  readonly parent: number | null;
  readonly children: readonly number[];
  readonly visible: boolean;
  readonly tags: readonly string[];
  readonly transform: TransformSnapshot;
  readonly components: Readonly<Record<string, FieldsSnapshot>>;
  /** In the entity's behavior order. */
  readonly behaviors: readonly BehaviorSnapshot[];
}

export interface TimeSnapshot {
  readonly now: number;
  /** `now` when the current scene loaded. */
  readonly sceneStart: number;
  readonly dt: number;
  readonly realNow: number;
  readonly frame: number;
  readonly scale: number;
  readonly frozen: boolean;
  /** Game time not yet consumed by fixed steps. */
  readonly accumulator: number;
}

export interface Snapshot {
  readonly format: number;
  readonly scene: string;
  readonly time: TimeSnapshot;
  readonly resources: Readonly<Record<string, FieldsSnapshot>>;
  readonly ids: IdState;
  /** Live entities, in spawn order. */
  readonly entities: readonly EntitySnapshot[];
  /** Plugin id → what its `snapshot` returned. */
  readonly plugins: Readonly<Record<string, Json>>;
}

/** A modifier in a save: `seconds` is its remaining lifetime (saves load on a new clock). */
export interface SavedModifier {
  readonly key?: string;
  readonly add: number;
  readonly multiply: number;
  readonly seconds?: number;
}

/** Resource fields of some lifetimes (`kernel.saveResources`). */
export interface ResourceSave {
  /** Resource id → field → JSON value (base values): `SaveData.resources`. */
  readonly resources: Readonly<Record<string, JsonObject>>;
  /** Resource id → field → modifiers, for saved fields that have taken any. */
  readonly modifiers: Readonly<Record<string, Readonly<Record<string, readonly SavedModifier[]>>>>;
}

const VEC3: FieldType = { kind: 'vec3' };
const NUMBER: FieldType = { kind: 'number' };

/** The fields with modified ones read as their base values (what assigning would set). */
function baseView(schema: Schema, fields: Fields, names: Iterable<string> = Object.keys(schema)): Fields {
  const view: Fields = {};
  for (const name of names) view[name] = baseValue(fields, name);
  return view;
}

export function snapshotFields(schema: Schema, fields: Fields, where: string, entities: EntityCodec): FieldsSnapshot {
  const modifiers = modifierStates(fields);
  return {
    fields: encodeFields(schema, baseView(schema, fields), where, entities),
    ...(Object.keys(modifiers).length > 0 && { modifiers }),
  };
}

/** Restore saved fields into an existing fields object (resources keep their identity). */
export function restoreFieldsInto(
  target: Fields, schema: Schema, decoded: Fields, saved: FieldsSnapshot, now: Now, where: string,
): void {
  clearModifiers(target);
  Object.assign(target, decoded);
  restoreModifiers(target, schema, saved.modifiers ?? {}, now, where);
}

function encodeBehavior(def: BehaviorDef, instance: Fields, where: string, entities: EntityCodec): BehaviorSnapshot {
  return {
    use: def.id,
    params: encodeFields(def.params, instance, `${where} params`, entities),
    state: encodeFields(def.state, instance, `${where} state`, entities),
  };
}

export function snapshotEntity(record: EntityRecord, registry: Registry, entities: EntityCodec): EntitySnapshot {
  const where = `entity ${record.id}${record.prefab === undefined ? '' : ` ("${record.prefab}")`}`;
  const { position, rotation, scale } = record.transform;
  const components: Record<string, FieldsSnapshot> = {};
  for (const [id, fields] of record.components) {
    components[id] = snapshotFields(registry.components.get(id)!.schema, fields, `${where} ${id}`, entities);
  }
  return {
    id: record.id,
    ...(record.prefab !== undefined && { prefab: record.prefab }),
    ...(record.placedId !== undefined && { placedId: record.placedId }),
    ...(record.childName !== undefined && { childName: record.childName }),
    ...(record.name !== undefined && { name: record.name }),
    ...(record.owner !== undefined && { owner: record.owner }),
    parent: record.parent,
    children: [...record.children],
    visible: record.visible,
    tags: [...record.tags],
    transform: {
      position: encode(VEC3, position, `${where} position`) as number[],
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w].map((n) => encode(NUMBER, n, `${where} rotation`) as number),
      scale: encode(VEC3, scale, `${where} scale`) as number[],
    },
    components,
    behaviors: record.behaviors.map((slot) => encodeBehavior(slot.def, slot.instance as Fields, `${where} behavior "${slot.def.id}"`, entities)),
  };
}

/**
 * Records for saved entities, fully built (components bound, behaviors created with
 * params and state, hierarchy linked) but not yet in the world.
 */
export function restoreEntities(
  saved: readonly EntitySnapshot[], registry: Registry, entities: EntityCodec, wrap: (id: EntityId) => unknown, now: Now,
): EntityRecord[] {
  const byId = new Map<number, EntityRecord>();
  const records = saved.map((snap) => {
    const id = snap.id as EntityId;
    const where = `saved entity ${id}`;
    const record = newRecord(id, {
      ...(snap.prefab !== undefined && { prefab: snap.prefab }),
      ...(snap.placedId !== undefined && { placedId: snap.placedId }),
      ...(snap.childName !== undefined && { childName: snap.childName }),
      ...(snap.name !== undefined && { name: snap.name }),
      ...(snap.owner !== undefined && { owner: snap.owner }),
    });
    record.visible = snap.visible;
    for (const tag of snap.tags) record.tags.add(tag);
    const [x, y, z, w] = snap.transform.rotation as [number, number, number, number];
    record.transform.position = decode(VEC3, snap.transform.position, `${where} position`) as Vec3;
    record.transform.rotation = new Quat(x, y, z, w);
    record.transform.scale = decode(VEC3, snap.transform.scale, `${where} scale`) as Vec3;
    for (const [componentId, data] of Object.entries(snap.components)) {
      const def = registry.component(componentId, where);
      const fields = decodeFields(def.schema, data.fields, `${where} ${componentId}`, entities);
      restoreModifiers(fields, def.schema, data.modifiers ?? {}, now, `${where} ${componentId}`);
      record.components.set(componentId, bindComponent(def, fields, id));
    }
    for (const behavior of snap.behaviors) {
      const def = registry.behavior(behavior.use, where);
      const at = `${where} behavior "${def.id}"`;
      const params = decodeFields(def.params, behavior.params, `${at} params`, entities);
      const state = decodeFields(def.state, behavior.state, `${at} state`, entities);
      const instance = def.create();
      Object.assign(instance, params, state, { entity: wrap(id) });
      // Live entities between frames have always started; restoring must not start them again.
      record.behaviors.push({ def, instance, started: true });
    }
    byId.set(id, record);
    return record;
  });
  for (const [i, snap] of saved.entries()) {
    const record = records[i]!;
    if (snap.parent !== null) {
      const parent = byId.get(snap.parent);
      if (parent === undefined) fail('PP9002', `Saved entity ${snap.id} has parent ${snap.parent}, which was not saved`);
      record.parent = parent.id;
      record.transform.parent = parent.transform;
    }
  }
  // Children second: a parent may come later in spawn order than its child (re-parenting).
  for (const [i, snap] of saved.entries()) {
    const record = records[i]!;
    for (const child of snap.children) {
      if (byId.get(child)?.parent !== record.id) fail('PP9002', `Saved entity ${snap.id} lists child ${child}, which is not its child`);
      record.children.push(child as EntityId);
    }
  }
  return records;
}
