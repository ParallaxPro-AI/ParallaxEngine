/**
 * The placed-entity part of a slot save (sdk/parallax/save.pyi: "an id-keyed diff of
 * placed entities"): what changed on the scene's placed entities since the scene was
 * authored, keyed by stable id.
 *
 * Keys. A placed entity's key is its placed id; a prefab child of a keyed entity is
 * `<parent key>/<child name>`. Entities spawned at runtime have no key and are not saved
 * (a scene load recreates what systems and behaviors spawn).
 *
 * The baseline is every keyed entity as the scene authored it, taken when the scene's
 * entities exist and before any start runs. An entry holds only differences:
 *
 *   "<component id>": {changed fields}   base values (modifiers are not saved; behaviors re-derive them)
 *   "<component id>": null               the component was removed
 *   "<behavior id>":  {changed state()}  params are authored, never saved
 *   "transform": {"position", "rotation" (quaternion x, y, z, w), "scale"}
 *   "tags": [...], "visible": bool
 *   {"destroyed": true}                  the entity is gone
 *
 * Entity references in saved fields are keys; a reference to an unkeyed (spawned) entity
 * is saved as None, since that entity won't exist after a load.
 *
 * Open worlds (streaming). A streamed placement's baseline is taken when it first enters
 * the world. While it is streamed out, its entry is the diff of its held state (or
 * `{"destroyed": true}` once game code destroyed it); its prefab children are not held, so
 * they have no entry until it is back. Entries for streamed placements that aren't in the
 * world when a save loads wait until they stream in (`SaveEngine`).
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { decodeFields, encodeFields } from '../../kernel/index.js';
import type { EntityCodec, EntityRecord, Fields, Kernel, Schema } from '../../kernel/index.js';
import { STREAMING_SERVICE } from '../../services/index.js';
import type { HeldEntity, StreamedWorld } from '../../services/index.js';
import { isObject } from './stored.js';

const ENTRY_KEYS = new Set(['transform', 'tags', 'visible', 'destroyed']);

/** Keyed entity → its authored (or saved) state, every part encoded. */
export type EntityStates = Record<string, JsonObject>;

/** An entity's save key, or undefined when it has none. */
export function keyOf(kernel: Kernel, record: EntityRecord): string | undefined {
  if (record.placedId !== undefined) return record.placedId;
  if (record.childName === undefined || record.parent === null) return undefined;
  const parent = kernel.world.get(record.parent);
  const parentKey = parent === undefined ? undefined : keyOf(kernel, parent);
  return parentKey === undefined ? undefined : `${parentKey}/${record.childName}`;
}

/** Live keyed entities by key; PP3956 when two share one. */
export function keyedEntities(kernel: Kernel, records: Iterable<EntityRecord> = kernel.world.live()): Map<string, EntityRecord> {
  const keyed = new Map<string, EntityRecord>();
  for (const record of records) {
    if (!record.alive) continue;
    const key = keyOf(kernel, record);
    if (key === undefined) continue;
    if (keyed.has(key)) {
      fail('PP3956', `Two entities in scene "${kernel.scene?.id ?? '?'}" have the save key "${key}"`, {
        fix: 'Give every placed entity its own "id" (a gridded placement can\'t carry one), and every prefab child its own name.',
      });
    }
    keyed.set(key, record);
  }
  return keyed;
}

/** Entity references as save keys. */
export function keyCodec(kernel: Kernel): EntityCodec {
  return {
    encode: (handle) => {
      if (handle === null || handle === undefined) return null;
      if (handle === 'local_player') return handle;
      const id = kernel.handles.unwrap(handle);
      const record = id === undefined ? undefined : kernel.world.get(id);
      return record === undefined ? null : keyOf(kernel, record) ?? null;
    },
    decode: (value, where) => {
      if (value === null || value === 'local_player') return value;
      if (typeof value !== 'string') return fail('PP3957', `${where} must be a saved entity key, got ${JSON.stringify(value)}`);
      const record = keyedEntities(kernel).get(value);
      if (record === undefined) {
        return fail('PP3957', `${where} names "${value}", and no placed entity has that id`, {
          fix: 'The scene changed since the save: add a migration that rewrites or drops this reference.',
        });
      }
      return kernel.handles.wrap(record.id);
    },
  };
}

function behaviorId(record: EntityRecord, componentIds: ReadonlySet<string>, where: string): void {
  const seen = new Set<string>();
  for (const slot of record.behaviors) {
    const id = slot.def.id;
    if (seen.has(id) || componentIds.has(id) || ENTRY_KEYS.has(id)) {
      fail('PP3955', `${where} has two parts named "${id}" (components and behaviors share one namespace in a save)`, {
        fix: 'Rename the behavior or the component, or use the behavior once per prefab.',
      });
    }
    seen.add(id);
  }
}

/** Every saved part of an entity, encoded. */
export function encodeEntity(kernel: Kernel, record: EntityRecord, codec: EntityCodec, where: string): JsonObject {
  const out: Record<string, Json> = {};
  const components = new Set(record.components.keys());
  behaviorId(record, components, where);
  for (const id of components) {
    const schema = kernel.registry.component(id, where).schema;
    const base: Fields = {};
    for (const name of Object.keys(schema)) base[name] = kernel.base(record.id, id, name);
    out[id] = encodeFields(schema, base, `${where} ${id}`, codec);
  }
  for (const slot of record.behaviors) {
    out[slot.def.id] = encodeFields(slot.def.state, slot.instance as Fields, `${where} behavior "${slot.def.id}"`, codec);
  }
  const { position, rotation, scale } = record.transform;
  out['transform'] = {
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
  };
  out['tags'] = [...record.tags].sort();
  out['visible'] = record.visible;
  return out;
}

/** A streamed-out placement's held state, encoded like `encodeEntity`. */
export function encodeHeld(kernel: Kernel, held: HeldEntity, codec: EntityCodec, where: string): JsonObject {
  const out: Record<string, Json> = {};
  for (const [id, fields] of Object.entries(held.components)) {
    out[id] = encodeFields(kernel.registry.component(id, where).schema, fields, `${where} ${id}`, codec);
  }
  for (const b of held.behaviors) {
    out[b.use] = encodeFields(kernel.registry.behavior(b.use, where).state, b.state, `${where} behavior "${b.use}"`, codec);
  }
  out['transform'] = {
    position: [held.position.x, held.position.y, held.position.z],
    rotation: [held.rotation.x, held.rotation.y, held.rotation.z, held.rotation.w],
    scale: [held.scale.x, held.scale.y, held.scale.z],
  };
  out['tags'] = [...held.tags].sort();
  out['visible'] = held.visible;
  return out;
}

/** The current scene's open world, when it has one. */
export function streamedWorld(kernel: Kernel): StreamedWorld | null {
  return kernel.tryService(STREAMING_SERVICE)?.current() ?? null;
}

/** The placed id a save key belongs to (`crate` for `crate/lid`). */
export function rootKey(key: string): string {
  const slash = key.indexOf('/');
  return slash < 0 ? key : key.slice(0, slash);
}

/** Whether a key is (part of) a placement the open world streams. */
export function isStreamedKey(world: StreamedWorld | null, key: string): boolean {
  return world !== null && world.isLoaded(rootKey(key)) !== undefined;
}

/** The authored state of a scene's keyed entities. */
export function baseline(kernel: Kernel, batch: readonly EntityRecord[]): EntityStates {
  const codec = keyCodec(kernel);
  const states: EntityStates = {};
  for (const [key, record] of keyedEntities(kernel, batch)) states[key] = encodeEntity(kernel, record, codec, `entity "${key}"`);
  return states;
}

function same(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The differences between two encoded states of an entity (empty when it is unchanged). */
function entryOf(before: JsonObject, now: JsonObject): Record<string, Json> {
  const entry: Record<string, Json> = {};
  for (const [part, value] of Object.entries(now)) {
    const was = before[part];
    if (same(was, value)) continue;
    if (ENTRY_KEYS.has(part) || !isObject(was) || !isObject(value)) {
      entry[part] = value;
      continue;
    }
    const fields: Record<string, Json> = {};
    for (const [name, v] of Object.entries(value)) if (!same(was[name], v)) fields[name] = v;
    entry[part] = fields;
  }
  for (const part of Object.keys(before)) if (!(part in now)) entry[part] = null;
  return entry;
}

/**
 * What changed since `authored`, as `SaveData.entities`. `pending` holds loaded entries of
 * streamed placements that haven't streamed in since the load; they are kept as they are.
 */
export function diffEntities(kernel: Kernel, authored: EntityStates, pending: EntityStates = {}): Record<string, JsonObject> {
  const codec = keyCodec(kernel);
  const live = keyedEntities(kernel);
  const world = streamedWorld(kernel);
  const diff: Record<string, JsonObject> = {};
  for (const [key, before] of Object.entries(authored)) {
    const record = live.get(key);
    if (record !== undefined) {
      const entry = entryOf(before, encodeEntity(kernel, record, codec, `entity "${key}"`));
      if (Object.keys(entry).length > 0) diff[key] = entry;
      continue;
    }
    if (!isStreamedKey(world, key)) {
      diff[key] = { destroyed: true };
      continue;
    }
    // Streamed out: gone for good, held (the placement itself), or back as authored (children; an unloaded layer).
    const root = rootKey(key);
    if (world!.destroyed().has(root)) {
      diff[key] = { destroyed: true };
      continue;
    }
    const held = key === root ? world!.held().get(root) : undefined;
    if (held === undefined) continue;
    const entry = entryOf(before, encodeHeld(kernel, held, codec, `entity "${key}"`));
    if (Object.keys(entry).length > 0) diff[key] = entry;
  }
  for (const [key, entry] of Object.entries(pending)) if (!live.has(key) && !(key in diff)) diff[key] = entry;
  return diff;
}

function numbers(value: Json | undefined, length: number, where: string): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return fail('PP3957', `${where} must be a list of ${length} numbers, got ${JSON.stringify(value)}`);
  }
  return value as number[];
}

function subSchema(schema: Schema, data: JsonObject, where: string): Schema {
  return Object.fromEntries(Object.keys(data).map((name) => {
    const spec = schema[name];
    if (spec === undefined) fail('PP3957', `${where} has no field "${name}" (in a save)`, { fix: 'Add a migration that renames or drops it.' });
    return [name, spec];
  }));
}

/** Apply `SaveData.entities` to a freshly loaded scene (before anything starts). */
export function applyEntities(kernel: Kernel, batch: readonly EntityRecord[], saved: Record<string, Json>): void {
  const keyed = keyedEntities(kernel, batch);
  const codec = keyCodec(kernel);
  const destroy: EntityId[] = [];
  for (const [key, entry] of Object.entries(saved)) {
    const where = `saved entity "${key}"`;
    const record = keyed.get(key);
    if (record === undefined) {
      fail('PP3957', `The save changes entity "${key}", which scene "${kernel.scene?.id ?? '?'}" doesn't place`, {
        fix: 'The scene changed since the save: add a migration that drops or re-keys this entry in save.entities.',
      });
    }
    if (!isObject(entry)) fail('PP3957', `${where} must be a dict`);
    if (entry['destroyed'] === true) {
      destroy.push(record.id);
      continue;
    }
    for (const [part, value] of Object.entries(entry)) {
      const at = `${where} ${part}`;
      if (part === 'transform') {
        if (!isObject(value)) fail('PP3957', `${at} must be a dict`);
        const [px, py, pz] = numbers(value['position'], 3, `${at}.position`) as [number, number, number];
        const [rx, ry, rz, rw] = numbers(value['rotation'], 4, `${at}.rotation`) as [number, number, number, number];
        const [sx, sy, sz] = numbers(value['scale'], 3, `${at}.scale`) as [number, number, number];
        record.transform.position = new Vec3(px, py, pz);
        record.transform.rotation = new Quat(rx, ry, rz, rw);
        record.transform.scale = new Vec3(sx, sy, sz);
      } else if (part === 'tags') {
        if (!Array.isArray(value) || !value.every((t) => typeof t === 'string')) fail('PP3957', `${at} must be a list of tag ids`);
        record.tags.clear();
        for (const tag of value as string[]) record.tags.add(tag);
      } else if (part === 'visible') {
        if (typeof value !== 'boolean') fail('PP3957', `${at} must be true or false`);
        record.visible = value;
      } else if (part === 'destroyed') {
        fail('PP3957', `${at} must be true (or absent)`);
      } else if (kernel.registry.components.has(part)) {
        if (value === null) {
          if (record.components.has(part)) kernel.removeComponent(record.id, part);
          continue;
        }
        if (!isObject(value)) fail('PP3957', `${at} must be a dict of fields`);
        const schema = kernel.registry.component(part, where).schema;
        const fields = decodeFields(subSchema(schema, value, at), value, at, codec);
        const target = record.components.get(part);
        if (target === undefined) kernel.addComponent(record.id, part, fields);
        else Object.assign(target, fields);
      } else {
        const slot = record.behaviors.find((s) => s.def.id === part);
        if (slot === undefined) {
          fail('PP3957', `${where} has "${part}", which is neither a component nor a behavior of it`, {
            fix: 'Add a migration that renames or drops it in save.entities.',
          });
        }
        if (!isObject(value)) fail('PP3957', `${at} must be a dict of state() fields`);
        Object.assign(slot.instance, decodeFields(subSchema(slot.def.state, value, at), value, at, codec));
      }
    }
  }
  for (const id of destroy) kernel.world.destroy(id);
}
