/**
 * Blackboards: the memory a brain (or a squad) reads and writes. Keys are names
 * (`target`, `patrol.index`); values are plain data — None, bool, number, str, Vec2, Vec3,
 * an entity, or a list of those — so a blackboard snapshots as JSON and a tree's checks
 * compare values exactly. A key may expire (`ttl`, seconds of AI clock); an entity whose
 * entity was destroyed reads as absent, so `target` empties itself when the target dies.
 */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';

/** An entity held in a blackboard (by id; the api presents the Entity handle). */
export class EntityRef {
  readonly id: EntityId;

  constructor(id: EntityId) {
    this.id = id;
  }
}

export type Value = null | boolean | number | string | Vec2 | Vec3 | EntityRef | readonly Value[];

const KEY = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function checkKey(key: unknown, where: string): string {
  if (typeof key === 'string' && KEY.test(key)) return key;
  return fail('PP3250', `${where}: blackboard key must be a name like "target" or "patrol.index", got ${JSON.stringify(key) ?? String(key)}`);
}

/** Python truthiness of a blackboard value (absent is falsy). */
export function truthy(value: Value | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (a instanceof Vec3 && b instanceof Vec3) return a.x === b.x && a.y === b.y && a.z === b.z;
  if (a instanceof Vec2 && b instanceof Vec2) return a.x === b.x && a.y === b.y;
  if (a instanceof EntityRef && b instanceof EntityRef) return a.id === b.id;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  return false;
}

export function describeValue(value: Value | undefined): string {
  if (value === undefined) return '(absent)';
  if (value === null) return 'None';
  if (value instanceof Vec3) return `Vec3(${value.x}, ${value.y}, ${value.z})`;
  if (value instanceof Vec2) return `Vec2(${value.x}, ${value.y})`;
  if (value instanceof EntityRef) return `entity ${value.id}`;
  if (Array.isArray(value)) return `[${value.map(describeValue).join(', ')}]`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * A value as stored: game values are checked (Vec3, numbers, lists…), entities arrive as
 * ids from the caller's `entity` lookup (the api's handles). Anything else is PP3251.
 */
export function toValue(raw: unknown, where: string, entity: (raw: unknown) => EntityId | undefined): Value {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean' || typeof raw === 'string') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) fail('PP3251', `${where}: blackboard numbers must be finite, got ${raw}`);
    return raw;
  }
  if (raw instanceof Vec3 || raw instanceof Vec2 || raw instanceof EntityRef) return raw;
  if (Array.isArray(raw)) return raw.map((v, i) => toValue(v, `${where}[${i}]`, entity));
  const id = entity(raw);
  if (id !== undefined) return new EntityRef(id);
  const json = typeof raw === 'object' && typeof (raw as { toJSON?: unknown }).toJSON === 'function' ? (raw as { toJSON(): unknown }).toJSON() : undefined;
  if (Array.isArray(json)) return json.map((v, i) => toValue(v, `${where}[${i}]`, entity));
  if (typeof json === 'string') return json;
  return fail('PP3251', `${where}: a blackboard holds None, bool, numbers, str, Vec2, Vec3, entities and lists of them, not ${raw?.constructor?.name ?? typeof raw}`, {
    fix: 'Keep richer state in a component; store its key or entity here.',
  });
}

export function encodeValue(value: Value): Json {
  if (value instanceof Vec3) return { vec3: [value.x, value.y, value.z] };
  if (value instanceof Vec2) return { vec2: [value.x, value.y] };
  if (value instanceof EntityRef) return { entity: value.id };
  if (Array.isArray(value)) return { list: value.map(encodeValue) };
  return value as Json;
}

export function decodeValue(json: Json): Value {
  if (json === null || typeof json !== 'object') return json as Value;
  const o = json as JsonObject;
  if (Array.isArray(o['vec3'])) {
    const [x, y, z] = o['vec3'] as number[];
    return new Vec3(x!, y!, z!);
  }
  if (Array.isArray(o['vec2'])) {
    const [x, y] = o['vec2'] as number[];
    return new Vec2(x!, y!);
  }
  if (typeof o['entity'] === 'number') return new EntityRef(o['entity'] as EntityId);
  return (o['list'] as Json[]).map(decodeValue);
}

interface Slot {
  value: Value;
  /** AI-clock time it expires; null: never. */
  expires: number | null;
}

export class Blackboard {
  readonly #slots = new Map<string, Slot>();
  readonly #alive: (id: EntityId) => boolean;

  constructor(alive: (id: EntityId) => boolean) {
    this.#alive = alive;
  }

  #live(key: string, now: number): Slot | undefined {
    const slot = this.#slots.get(key);
    if (slot === undefined) return undefined;
    if ((slot.expires !== null && now >= slot.expires) || (slot.value instanceof EntityRef && !this.#alive(slot.value.id))) {
      this.#slots.delete(key);
      return undefined;
    }
    return slot;
  }

  get(key: string, now: number): Value | undefined {
    return this.#live(key, now)?.value;
  }

  has(key: string, now: number): boolean {
    return this.#live(key, now) !== undefined;
  }

  set(key: string, value: Value, now: number, ttl: number | null = null): void {
    if (ttl !== null && !(Number.isFinite(ttl) && ttl > 0)) fail('PP3251', `blackboard ttl must be a number of seconds greater than 0, got ${ttl}`);
    this.#slots.set(key, { value, expires: ttl === null ? null : now + ttl });
  }

  delete(key: string): void {
    this.#slots.delete(key);
  }

  clear(): void {
    this.#slots.clear();
  }

  /** Live keys, in insertion order. */
  keys(now: number): string[] {
    return [...this.#slots.keys()].filter((k) => this.#live(k, now) !== undefined);
  }

  encode(): Json {
    return [...this.#slots].map(([key, s]) => ({ key, value: encodeValue(s.value), expires: s.expires }));
  }

  restore(json: Json): void {
    this.#slots.clear();
    for (const entry of json as readonly JsonObject[]) {
      this.#slots.set(entry['key'] as string, { value: decodeValue(entry['value'] as Json), expires: entry['expires'] as number | null });
    }
  }

  /** Plain JSON view for debugging and the ai service (expired keys left out). */
  view(now: number): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const key of this.keys(now)) out[key] = encodeValue(this.#slots.get(key)!.value);
    return out;
  }
}
