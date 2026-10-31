/**
 * Field schemas: the runtime form of `field()` / `param()` / `state()` declarations. A
 * schema turns authored JSON into runtime values (arrays into vectors, "#hex" into
 * colors), supplies defaults, and copies values so no two instances share mutable state.
 * `encode` is decode's inverse (runtime value → JSON), which is what snapshots and saves
 * are made of. The transpiler emits these from the game's Python declarations.
 */

import { Cell, Cell3, Color, COLOR_FORMS, fail, ParallaxError, parseColor, Vec2, Vec3 } from '../../core/index.js';
import type { Json, JsonObject } from '../../resource/index.js';

export type FieldType =
  | { readonly kind: 'number' | 'int' | 'bool' | 'string' | 'vec2' | 'vec3' | 'color' | 'cell' | 'cell3' | 'tag' | 'entity' | 'json' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  /** An id of a prefab, scene, content entry, asset… kept as its id string. */
  | { readonly kind: 'ref'; readonly to: string }
  | { readonly kind: 'list' | 'dict' | 'optional'; readonly of: FieldType }
  | { readonly kind: 'record'; readonly fields: Schema }
  /** A fixed-length list (`tuple[float, float, Color]`); its runtime value is a frozen array. */
  | { readonly kind: 'tuple'; readonly of: readonly FieldType[] }
  /** Any of these (`Entity | list[Entity] | None`): decoded and encoded by the first that accepts the value. */
  | { readonly kind: 'union'; readonly of: readonly FieldType[] };

export type Keep = 'scene' | 'run' | 'session' | 'profile';

export interface FieldSpec {
  readonly type: FieldType;
  /** Runtime-form default. Absent means the field is required in data. */
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  /** Resources only. */
  readonly keep?: Keep;
  readonly modifiable?: boolean;
}

export type Schema = Readonly<Record<string, FieldSpec>>;
export type Fields = Record<string, unknown>;

/** Shorthand constructors for schemas written in TypeScript (plugins, tests). */
export const t = {
  number: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'number' }, ...spec }),
  int: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'int' }, ...spec }),
  bool: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'bool' }, ...spec }),
  string: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'string' }, ...spec }),
  vec2: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'vec2' }, ...spec }),
  vec3: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'vec3' }, ...spec }),
  color: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'color' }, ...spec }),
  cell: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'cell' }, ...spec }),
  cell3: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'cell3' }, ...spec }),
  json: (spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'json' }, ...spec }),
  enum: (values: readonly string[], spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'enum', values }, ...spec }),
  ref: (to: string, spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'ref', to }, ...spec }),
  list: (of: FieldType, spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'list', of }, ...spec }),
  tuple: (of: readonly FieldType[], spec: Omit<FieldSpec, 'type'> = {}): FieldSpec => ({ type: { kind: 'tuple', of }, ...spec }),
};

/**
 * Game-facing objects stored in fields (the api layer's reference objects, enum members,
 * tags) give their stored form through `toJSON` — the standard protocol — so saves and
 * snapshots accept them; decoding yields that form and the api presents it again. A
 * mutable object with a `COPY` method (record instances) is copied through it, so `copy`
 * never shares one between two entities.
 */
export const COPY = Symbol.for('parallax.copy');

const SCALAR_KINDS: ReadonlySet<FieldType['kind']> = new Set(['number', 'int', 'bool', 'string', 'tag', 'ref', 'enum']);

/**
 * A game-side container (pyrt's dict/set: it has `COPY`) as the plain list or object it
 * stands for, through its `toJSON`. Value types such as Vec3 have no `COPY`: a `json`
 * field can't hold one, since decoding would give back a plain list.
 */
function container(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || typeof (value as { [COPY]?: unknown })[COPY] !== 'function') return value;
  return stored(value);
}

function stored(value: unknown): unknown {
  const fn = typeof value === 'object' && value !== null ? (value as { toJSON?: unknown }).toJSON : undefined;
  return typeof fn === 'function' ? (fn as () => unknown).call(value) : value;
}

/**
 * How snapshots write entity references. Authored data names entities by placed id (a
 * string, resolved by the spawner); a snapshot holds live references, which the kernel
 * maps between game-facing handles and `EntityId` numbers.
 */
export interface EntityCodec {
  encode(handle: unknown, where: string): Json;
  decode(value: Json, where: string): unknown;
}

/** The first alternative's result that doesn't fail with a diagnostic; `none` when every one does. */
function firstAccepting<T>(alternatives: readonly FieldType[], attempt: (alt: FieldType) => T, none: () => never): T {
  for (const alt of alternatives) {
    try {
      return attempt(alt);
    } catch (error) {
      if (!(error instanceof ParallaxError)) throw error;
    }
  }
  return none();
}

function describeUnion(alternatives: readonly FieldType[]): string {
  return `one of: ${alternatives.map((alt) => alt.kind).join(', ')}`;
}

function invalid(where: string, expected: string, value: Json): never {
  fail('PP4102', `${where} must be ${expected}, got ${JSON.stringify(value)}`);
}

/**
 * Authored JSON → runtime value, by declared type. `where` names the value in errors.
 * With `entities` (decoding a snapshot), entity fields go through the codec and nested
 * records are read back exactly (every field present, ranges not re-checked: game code
 * may have assigned a value outside the declared range).
 */
export function decode(type: FieldType, value: Json, where: string, entities?: EntityCodec): unknown {
  switch (type.kind) {
    case 'number':
      return typeof value === 'number' ? value : invalid(where, 'a number', value);
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) ? value : invalid(where, 'an integer', value);
    case 'bool':
      return typeof value === 'boolean' ? value : invalid(where, 'true or false', value);
    case 'string':
    case 'tag':
    case 'ref':
      return typeof value === 'string' ? value : invalid(where, 'a string', value);
    case 'enum':
      return typeof value === 'string' && type.values.includes(value)
        ? value
        : invalid(where, `one of ${type.values.map((v) => `"${v}"`).join(', ')}`, value);
    case 'vec2':
      return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')
        ? new Vec2(value[0] as number, value[1] as number)
        : invalid(where, 'a list of 2 numbers', value);
    case 'vec3':
      if (Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every((n) => typeof n === 'number')) {
        return new Vec3(value[0] as number, value[1] as number, (value[2] as number | undefined) ?? 0);
      }
      return invalid(where, 'a list of 3 numbers', value);
    case 'cell':
      return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n))
        ? new Cell(value[0] as number, value[1] as number)
        : invalid(where, 'a [column, row] pair of integers', value);
    case 'cell3':
      return Cell3.fromJSON(value, where);
    case 'color':
      // A malformed hex string fails as PP4101 (Color.hex), anything else as PP4102.
      return parseColor(value) ?? (typeof value === 'string' ? Color.hex(value) : invalid(where, `a colour: ${COLOR_FORMS}`, value));
    case 'entity':
      if (entities !== undefined) return entities.decode(value, where);
      // Entity references in data are resolved by the instantiating scene, not here.
      return typeof value === 'string' ? value : invalid(where, 'a placed entity id', value);
    case 'json':
      // Copied, so the runtime value never aliases the data it came from.
      return copy(value);
    case 'optional':
      return value === null ? null : decode(type.of, value, where, entities);
    case 'list':
      return Array.isArray(value)
        ? value.map((item, i) => decode(type.of, item, `${where}[${i}]`, entities))
        : invalid(where, 'a list', value);
    case 'dict':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(type.of, v, `${where}.${k}`, entities)]))
        : invalid(where, 'an object', value);
    case 'tuple':
      return Array.isArray(value) && value.length === type.of.length
        ? Object.freeze(value.map((item, i) => decode(type.of[i]!, item, `${where}[${i}]`, entities)))
        : invalid(where, `a list of ${type.of.length}`, value);
    case 'union':
      return firstAccepting(type.of, (alt) => decode(alt, value, where, entities), () => invalid(where, describeUnion(type.of), value));
    case 'record':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(where, 'an object', value);
      return entities === undefined
        ? instantiate(type.fields, value as JsonObject, where)
        : decodeFields(type.fields, value as JsonObject, where, entities);
  }
}

function unencodable(where: string, expected: string, value: unknown): never {
  const shown = typeof value === 'object' && value !== null ? (value.constructor?.name ?? 'object') : String(value);
  fail('PP4108', `${where} must hold ${expected} to be saved, but holds ${shown}`, {
    fix: 'Keep each field to its declared type (state that is not one of the field types cannot be saved).',
  });
}

function finite(value: unknown, where: string): number {
  if (typeof value !== 'number') return unencodable(where, 'a number', value);
  if (!Number.isFinite(value)) {
    fail('PP4108', `${where} is ${value}, which a save cannot hold`, { fix: 'Use a large finite number or None instead.' });
  }
  return value;
}

function numbers(values: readonly number[], where: string): number[] {
  return values.map((n) => finite(n, where));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function encodeJson(raw: unknown, where: string): Json {
  const value = container(raw);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finite(value, where);
  if (Array.isArray(value)) return value.map((v, i) => encodeJson(v, `${where}[${i}]`));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeJson(v, `${where}.${k}`)]));
  return unencodable(where, 'plain JSON', value);
}

/**
 * Runtime value → JSON, by declared type: the inverse of `decode`. The result is fresh
 * (never aliases the runtime value). Entity references need `entities` (a value that is
 * still an unresolved placed id or marker string is written as that string).
 */
export function encode(type: FieldType, raw: unknown, where: string, entities?: EntityCodec): Json {
  const value = SCALAR_KINDS.has(type.kind) ? stored(raw) : raw;
  switch (type.kind) {
    case 'number':
      return finite(value, where);
    case 'int':
      return Number.isInteger(value) ? (value as number) : unencodable(where, 'an integer', value);
    case 'bool':
      return typeof value === 'boolean' ? value : unencodable(where, 'True or False', value);
    case 'string':
    case 'tag':
    case 'ref':
      return typeof value === 'string' ? value : unencodable(where, 'a string', value);
    case 'enum':
      return typeof value === 'string' && type.values.includes(value)
        ? value
        : unencodable(where, `one of ${type.values.map((v) => `"${v}"`).join(', ')}`, value);
    case 'vec2':
      return value instanceof Vec2 ? numbers([value.x, value.y], where) : unencodable(where, 'a Vec2', value);
    case 'vec3':
      return value instanceof Vec3 ? numbers([value.x, value.y, value.z], where) : unencodable(where, 'a Vec3', value);
    case 'cell':
      return value instanceof Cell ? [value.col, value.row] : unencodable(where, 'a Cell', value);
    case 'cell3':
      return value instanceof Cell3 ? [value.x, value.y, value.z] : unencodable(where, 'a Cell3', value);
    case 'color':
      return value instanceof Color ? numbers([value.r, value.g, value.b, value.a], where) : unencodable(where, 'a Color', value);
    case 'entity':
      if (typeof value === 'string') return value;
      if (entities === undefined) return unencodable(where, 'a placed entity id', value);
      return entities.encode(value, where);
    case 'json':
      return encodeJson(value, where);
    case 'optional':
      return value === null ? null : encode(type.of, value, where, entities);
    case 'list': {
      const list = container(value);
      return Array.isArray(list)
        ? list.map((item, i) => encode(type.of, item, `${where}[${i}]`, entities))
        : unencodable(where, 'a list', value);
    }
    case 'dict': {
      const dict = container(value);
      return isPlainObject(dict)
        ? Object.fromEntries(Object.entries(dict).map(([k, v]) => [k, encode(type.of, v, `${where}.${k}`, entities)]))
        : unencodable(where, 'a dict', value);
    }
    case 'record':
      return typeof value === 'object' && value !== null
        ? encodeFields(type.fields, value as Fields, where, entities)
        : unencodable(where, 'a record', value);
    case 'tuple':
      return Array.isArray(value) && value.length === type.of.length
        ? value.map((item, i) => encode(type.of[i]!, item, `${where}[${i}]`, entities))
        : unencodable(where, `a tuple of ${type.of.length}`, value);
    case 'union':
      return firstAccepting(type.of, (alt) => encode(alt, value, where, entities), () => unencodable(where, describeUnion(type.of), value));
  }
}

/** Every schema field of `fields`, encoded. Properties outside the schema are not saved. */
export function encodeFields(schema: Schema, fields: Fields, where: string, entities?: EntityCodec): JsonObject {
  const out: Record<string, Json> = {};
  for (const [name, spec] of Object.entries(schema)) out[name] = encode(spec.type, fields[name], `${where}.${name}`, entities);
  return out;
}

/** The inverse of `encodeFields`: exactly the schema's fields, each required (snapshot data). */
export function decodeFields(schema: Schema, data: JsonObject, where: string, entities: EntityCodec): Fields {
  for (const key of Object.keys(data)) {
    if (!(key in schema)) fail('PP4104', `${where} has no field "${key}"`);
  }
  const fields: Fields = {};
  for (const [name, spec] of Object.entries(schema)) {
    const value = data[name];
    if (value === undefined) fail('PP4105', `${where}.${name} is missing from the saved data`);
    fields[name] = decode(spec.type, value, `${where}.${name}`, entities);
  }
  return fields;
}

/**
 * A deep copy of a runtime value. Value types (vectors, colors) are immutable and shared;
 * lists, dicts, records and objects with a `COPY` method are copied so instances never
 * alias each other's state.
 */
export function copy<T>(value: T): T {
  // A frozen array is a tuple: immutable, so shared like the other value types.
  if (Array.isArray(value)) return (Object.isFrozen(value) ? value : value.map(copy)) as T;
  const own = typeof value === 'object' && value !== null ? (value as { [COPY]?: unknown })[COPY] : undefined;
  if (typeof own === 'function') return (own as () => T).call(value);
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T;
  }
  return value;
}

function checkRange(spec: FieldSpec, value: unknown, where: string): void {
  if (typeof value !== 'number') return;
  if (spec.min !== undefined && value < spec.min) fail('PP4103', `${where} is ${value}, below its minimum ${spec.min}`);
  if (spec.max !== undefined && value > spec.max) fail('PP4103', `${where} is ${value}, above its maximum ${spec.max}`);
}

/**
 * A complete field set: runtime-form `values` where given (copied), else authored data,
 * else defaults. Required fields are checked after all three are merged.
 */
export function instantiateWith(schema: Schema, data: JsonObject | undefined, values: Fields, where: string): Fields {
  for (const key of Object.keys(values)) {
    if (!(key in schema)) fail('PP4104', `${where} has no field "${key}"`, { fix: `Fields: ${Object.keys(schema).join(', ') || '(none)'}.` });
  }
  const given = Object.keys(values);
  const authored: JsonObject = Object.fromEntries(Object.entries(data ?? {}).filter(([k]) => !given.includes(k)));
  const filled = Object.fromEntries(Object.entries(schema).filter(([name]) => !given.includes(name)));
  return { ...instantiate(filled, authored, where), ...Object.fromEntries(given.map((k) => [k, copy(values[k])])) };
}

/** A complete field set: authored data where given, defaults elsewhere. */
export function instantiate(schema: Schema, data: JsonObject | undefined, where: string): Fields {
  const fields: Fields = {};
  for (const key of Object.keys(data ?? {})) {
    if (!(key in schema)) {
      fail('PP4104', `${where} has no field "${key}"`, { fix: `Fields: ${Object.keys(schema).join(', ') || '(none)'}.` });
    }
  }
  for (const [name, spec] of Object.entries(schema)) {
    const authored = data?.[name];
    const at = `${where}.${name}`;
    let value: unknown;
    if (authored !== undefined) value = decode(spec.type, authored, at);
    else if ('default' in spec) value = copy(spec.default);
    else fail('PP4105', `${at} is required`, { fix: `Set "${name}" in the data.` });
    checkRange(spec, value, at);
    fields[name] = value;
  }
  return fields;
}

/**
 * A complete field set from runtime-form values (game code's `Component(...)`, spawn
 * overrides): given values where present (copied), defaults elsewhere; a required field
 * that isn't given is PP4105.
 */
export function instantiateValues(schema: Schema, values: Fields, where: string): Fields {
  for (const key of Object.keys(values)) {
    if (!(key in schema)) {
      fail('PP4104', `${where} has no field "${key}"`, { fix: `Fields: ${Object.keys(schema).join(', ') || '(none)'}.` });
    }
  }
  const fields: Fields = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (name in values) fields[name] = copy(values[name]);
    else if ('default' in spec) fields[name] = copy(spec.default);
    else fail('PP4105', `${where}.${name} is required`, { fix: `Pass ${name}=... when creating it.` });
  }
  return fields;
}

/** Restore the given fields to their defaults (resource resets). */
export function resetFields(schema: Schema, fields: Fields, which: (spec: FieldSpec) => boolean): void {
  for (const [name, spec] of Object.entries(schema)) {
    if (which(spec) && 'default' in spec) fields[name] = copy(spec.default);
  }
}
