/**
 * The one `"extends"` merge rule, shared by prefab variants and derived scenes:
 *
 *   objects        deep-merge, key by key (the derived file's value wins)
 *   null           deletes the inherited key
 *   plain lists    replace the inherited list whole
 *   named lists    merge by key, each matched item by these same rules; unmatched items are
 *                  appended: scene "entities" by "id", prefab "children" by "name". (Prefab
 *                  "behaviors" is a map keyed by behavior id, so it is an object here.)
 *
 * Parsing drops a `null` before typed readers see it; `writtenKeys` keeps what the file
 * actually wrote, so "written but now absent" means "deleted".
 */

import { isObject } from './reader.js';
import type { InstanceFields, Json, JsonObject } from './model.js';

const WRITTEN = new WeakMap<object, ReadonlySet<string>>();

/** Record the keys a source object wrote (nulls included) for the parsed value made from it. */
export function noteWritten<T extends object>(parsed: T, source: JsonObject): T {
  WRITTEN.set(parsed, new Set(Object.keys(source)));
  return parsed;
}

/** The keys recorded by `noteWritten`, if any (a parsed list made from an object keyed by id). */
export function notedKeys(parsed: object): ReadonlySet<string> | undefined {
  return WRITTEN.get(parsed);
}

/** The keys a parsed object's file wrote; for one not built by the loader, its defined keys. */
export function writtenKeys(parsed: object): ReadonlySet<string> {
  return WRITTEN.get(parsed)
    ?? new Set(Object.entries(parsed)
      .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
      .map(([key]) => key));
}

/** `obj` without its top-level `null` values (they only delete inherited keys). */
export function withoutNulls(obj: JsonObject): JsonObject {
  return Object.values(obj).includes(null) ? Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null)) : obj;
}

function stripNulls(value: Json): Json {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== null) out[key] = stripNulls(entry);
  return out;
}

/** Raw JSON values: objects deep-merge, `null` deletes (undefined), anything else replaces. */
export function mergeJson(base: Json | undefined, over: Json | undefined): Json | undefined {
  if (over === undefined) return base;
  if (over === null) return undefined;
  if (!isObject(over)) return over;
  if (!isObject(base)) return stripNulls(over);
  const out: Record<string, Json> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const merged = mergeJson(base[key], value);
    if (merged === undefined) delete out[key];
    else out[key] = merged;
  }
  return out;
}

/** A variant's own object map with its `null` deletion markers left out (what it sets, for checking). */
export function withoutDeletions(map: Readonly<Record<string, JsonObject>>): Record<string, JsonObject> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, stripNulls(value) as JsonObject]));
}

/** An object map (components, params, init, behaviors): per key deep-merge; a written-but-absent key is deleted. */
export function mergeMap(
  base: Readonly<Record<string, JsonObject>>, over: Readonly<Record<string, JsonObject>>,
): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = { ...base };
  for (const key of writtenKeys(over)) {
    const value = over[key];
    if (value === undefined) delete out[key];
    else out[key] = (mergeJson(base[key], value) ?? {}) as JsonObject;
  }
  return out;
}

/** A named list: items with the same key merge in place (base order); the rest are appended. */
export function mergeNamed<T>(
  base: readonly T[], over: readonly T[], keyOf: (item: T) => string | undefined, merge: (base: T, over: T) => T,
): T[] {
  const matched = (item: T): T | undefined => {
    const key = keyOf(item);
    return key === undefined ? undefined : over.find((o) => keyOf(o) === key);
  };
  return [
    ...base.map((b) => {
      const o = matched(b);
      return o === undefined ? b : merge(b, o);
    }),
    ...over.filter((o) => {
      const key = keyOf(o);
      return key === undefined || !base.some((b) => keyOf(b) === key);
    }),
  ];
}

/** A typed field: the derived value when written (`null`: deleted), else the inherited one. */
export function pick<T>(written: ReadonlySet<string>, key: string, base: T | undefined, over: T | undefined): T | undefined {
  return written.has(key) ? over : base;
}

/** File key → InstanceFields field, for instance keys whose value is a plain value or list. */
const INSTANCE_VALUES = [
  ['at', 'at'], ['rotation', 'rotation'], ['scale', 'scale'], ['z', 'z'], ['grid', 'grid'], ['visible', 'visible'],
  ['tags', 'tags'],
] as const;

/**
 * One instance merged over an inherited one with the same id or name (scene placements,
 * prefab children). `extra` lists the caller's own plain keys: [file key, field].
 */
export function mergeInstance<T extends InstanceFields>(
  base: T, over: T, extra: readonly (readonly [string, keyof T & string])[] = [],
): T {
  const written = writtenKeys(over);
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, field] of [...INSTANCE_VALUES, ...extra] as readonly (readonly [string, string])[]) {
    if (!written.has(key)) continue;
    const value = (over as unknown as Record<string, unknown>)[field];
    if (value === undefined) delete out[field];
    else out[field] = value;
  }
  out['tags'] ??= [];
  out['components'] = mergeMap(base.components, over.components);
  out['params'] = mergeMap(base.params, over.params);
  out['origin'] = over.origin;
  return out as unknown as T;
}
