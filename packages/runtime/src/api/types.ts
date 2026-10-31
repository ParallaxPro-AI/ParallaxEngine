/**
 * Types: what a compiled annotation means (contract C1/C3).
 *
 *   speed: float = param(14)        →  X.__annotations__ = { speed: () => rt.float }
 *   offer: list[ContentRef[Item]]   →  () => rt.list(rt.generic(ContentRef, Item))
 *
 * `rt.*` markers and the value classes (Vec2, Tag, PrefabRef, Enum, Localized, records…)
 * are annotation values. `resolveType` turns one into an `ApiType`: the kernel
 * `FieldType` it stores as (the JSON shape `declarations.json` also uses), plus how the
 * api layer presents a stored value to game code — a content id becomes a `ContentRef`,
 * an enum value its member, a record object an instance of its class.
 *
 * Kernel `FieldType` names for references (`{ kind: 'ref', to }`) are the declarations
 * extractor's (`transpiler/parallax_transpiler/extract/types.py`): prefab, scene, placed, text,
 * world_layer, clip, dialogue, asset, asset/<sfx|music|images|models|vfx>, content/<kind>.
 *
 * Containers game code sees as Python's: a dict field is a pyrt `PyDict` (stored as a JSON
 * object keyed by each key's stored form, so `dict[ContentRef[Item], int]` keys are ids),
 * `set[T]` / `frozenset[T]` a `PySet` / `PyFrozenSet` (stored as a list), `tuple[A, B]` a
 * frozen array (kernel `tuple`), `tuple[T, ...]` a frozen array stored as a list, `Any` JSON
 * whose objects are `PyDict`s. `Localized` is stored as `string`; `A | B` as kernel `union`.
 */

import { Cell, Cell3, Color, fail, Vec2, Vec3 } from '../core/index.js';
import type { FieldSpec, FieldType, Keep, Schema } from '../function/kernel/index.js';
import { bindArgs } from './kwargs.js';
import { PyDict, PyFrozenSet, PySet, SetBase } from './pyrt/collections.js';
import { Ellipsis, eq, NotImplemented } from './pyrt/values.js';
import { hashString } from './py.js';

export { Color, Quat, Vec2, Vec3 } from '../core/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- classes from compiled code are untyped */
export type AnyClass = abstract new (...args: any[]) => object;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Markers ────────────────────────────────────────────────────────────────────

export type TypeMarker =
  | { readonly __marker__: 'float' | 'int' | 'str' | 'bool' | 'none' | 'any' | 'callable' }
  | { readonly __marker__: 'list' | 'set' | 'frozenset' | 'optional' | 'classvar' | 'final' | 'type'; readonly of: unknown }
  | { readonly __marker__: 'dict'; readonly key: unknown; readonly value: unknown }
  | { readonly __marker__: 'tuple' | 'union'; readonly items: readonly unknown[] }
  | { readonly __marker__: 'literal'; readonly values: readonly unknown[] }
  | { readonly __marker__: 'generic'; readonly base: unknown; readonly args: readonly unknown[] };

const FLOAT: TypeMarker = Object.freeze({ __marker__: 'float' });
const INT: TypeMarker = Object.freeze({ __marker__: 'int' });
const STR: TypeMarker = Object.freeze({ __marker__: 'str' });
const BOOL: TypeMarker = Object.freeze({ __marker__: 'bool' });
const NONE: TypeMarker = Object.freeze({ __marker__: 'none' });
const ANY: TypeMarker = Object.freeze({ __marker__: 'any' });
const CALLABLE: TypeMarker = Object.freeze({ __marker__: 'callable' });

/** A bare `list` / `set` (no subscript) means `list[Any]`, as in Python. */
function itemOf(args: readonly unknown[]): unknown {
  return args.length === 0 ? ANY : args[0];
}

/**
 * The type expressions of C1, as runtime values. Everything the transpiler's `type_expr`
 * emits (`packages/transpiler/parallax_transpiler/emit.py`) is here; markers are built eagerly
 * (module-level type aliases) and resolved lazily, so an unsupported one fails only where
 * it is used as a field type.
 */
export const rt = {
  float: FLOAT,
  int: INT,
  str: STR,
  bool: BOOL,
  /** `None` written alone (unions drop it: `X | None` is `optional(X)`). */
  none: NONE,
  /** `typing.Any`. */
  any: ANY,
  list: (...of: unknown[]): TypeMarker => ({ __marker__: 'list', of: itemOf(of) }),
  set: (...of: unknown[]): TypeMarker => ({ __marker__: 'set', of: itemOf(of) }),
  frozenset: (...of: unknown[]): TypeMarker => ({ __marker__: 'frozenset', of: itemOf(of) }),
  dict: (...kv: unknown[]): TypeMarker => ({ __marker__: 'dict', key: kv.length === 0 ? STR : kv[0], value: kv.length === 0 ? ANY : kv[1] }),
  optional: (of: unknown): TypeMarker => ({ __marker__: 'optional', of }),
  /** `tuple[A, B]`; `tuple[A, ...]` passes `Ellipsis` as the second item; bare `tuple` is `tuple[Any, ...]`. */
  tuple: (...items: unknown[]): TypeMarker => ({ __marker__: 'tuple', items: items.length === 0 ? [ANY, Ellipsis] : items }),
  /** `A | B` with two or more non-None members. */
  union: (...items: unknown[]): TypeMarker => ({ __marker__: 'union', items }),
  literal: (...values: unknown[]): TypeMarker => ({ __marker__: 'literal', values }),
  /** `typing.Callable[...]` (its arguments are not kept). */
  callable: (): TypeMarker => CALLABLE,
  classvar: (of: unknown): TypeMarker => ({ __marker__: 'classvar', of }),
  final: (of: unknown): TypeMarker => ({ __marker__: 'final', of }),
  /** `type[X]`. */
  type: (...of: unknown[]): TypeMarker => ({ __marker__: 'type', of: itemOf(of) }),
  generic: (base: unknown, ...args: unknown[]): TypeMarker => ({ __marker__: 'generic', base, args }),
} as const;

function isMarker(value: unknown): value is TypeMarker {
  return typeof value === 'object' && value !== null && '__marker__' in value;
}

// ── Value classes usable as annotations ────────────────────────────────────────

/** Statics a class may carry to be a field type. */
interface TypedClass {
  readonly __field_type__?: FieldType;
  /** Reference classes: the `to` of their `ref` FieldType; constructed from the id. */
  readonly __ref_to__?: string;
  /** Live handles (`Handle`): resources and state() only, never saved. */
  readonly __live__?: true;
}

/**
 * A tag handle. Tags are interned: one object per id (`Tag.of`), so `tag("home")`, a
 * `Tag` field read back from data and the tags an entity carries are the same object and
 * `is` holds between them, as it does for any declared handle.
 */
export class Tag {
  static readonly __field_type__: FieldType = { kind: 'tag' };
  static readonly #interned = new Map<string, Tag>();
  readonly id: string;

  /** Use `Tag.of(id)`: a second object for one id would break `is`. */
  constructor(id: string) {
    this.id = id;
  }

  /** The tag with this id. */
  static of(id: string): Tag {
    let found = Tag.#interned.get(id);
    if (found === undefined) {
      found = new Tag(id);
      Tag.#interned.set(id, found);
    }
    return found;
  }

  get __tag_id__(): string { return this.id; }
  __eq__(o: unknown): boolean { return o instanceof Tag && o.id === this.id; }
  __hash__(): number { return hashString(`tag:${this.id}`); }
  toJSON(): string { return this.id; }
  toString(): string { return `Tag(${this.id})`; }
}

/** Base of every id-carrying reference handle. */
abstract class IdRef {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  __eq__(o: unknown): boolean { return o instanceof IdRef && o.constructor === this.constructor && o.id === this.id; }
  __hash__(): number { return hashString(`${this.constructor.name}:${this.id}`); }
  toJSON(): string { return this.id; }
  toString(): string { return `${this.constructor.name}(${this.id})`; }
}

export class PrefabRef extends IdRef { static readonly __ref_to__ = 'prefab'; }
export class SceneRef extends IdRef { static readonly __ref_to__ = 'scene'; }
export class EntityRef extends IdRef { static readonly __ref_to__ = 'placed'; }
export class WorldLayerRef extends IdRef { static readonly __ref_to__ = 'world_layer'; }
/** A dialogue file (story/<id>.yarn); the story plugin runs it. */
export class DialogueRef extends IdRef { static readonly __ref_to__ = 'dialogue'; }

export class AssetRef {
  static readonly __ref_to__: string = 'asset';
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  get id(): string { return this.path; }
  __eq__(o: unknown): boolean { return o instanceof AssetRef && o.path === this.path; }
  __hash__(): number { return hashString(`asset:${this.path}`); }
  toJSON(): string { return this.path; }
}
export class SoundRef extends AssetRef { static override readonly __ref_to__ = 'asset/sfx'; }
export class MusicRef extends AssetRef { static override readonly __ref_to__ = 'asset/music'; }
export class ImageRef extends AssetRef { static override readonly __ref_to__ = 'asset/images'; }
export class ModelRef extends AssetRef { static override readonly __ref_to__ = 'asset/models'; }
export class EffectRef extends AssetRef { static override readonly __ref_to__ = 'asset/vfx'; }

/**
 * The built-in 3D effects (`effect/<name>`, core BUILTIN_EFFECTS), as effect handles:
 * `ctx.vfx.play(Effect.explosion, at=hit)`, `Particles(effect=Effect.fire)` — as
 * `Synth.<name>` is the built-in sound `synth/<name>`.
 */
export class Effect {
  static readonly explosion = new EffectRef('effect/explosion');
  static readonly fire = new EffectRef('effect/fire');
  static readonly smoke = new EffectRef('effect/smoke');
  static readonly sparks = new EffectRef('effect/sparks');
  static readonly embers = new EffectRef('effect/embers');
  static readonly magic = new EffectRef('effect/magic');
  static readonly muzzle_flash = new EffectRef('effect/muzzle_flash');
  static readonly impact = new EffectRef('effect/impact');
  static readonly dust = new EffectRef('effect/dust');
  static readonly sparkle = new EffectRef('effect/sparkle');
}

export class ClipRef {
  static readonly __ref_to__ = 'clip';
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get id(): string { return this.name; }
  __eq__(o: unknown): boolean { return o instanceof ClipRef && o.name === this.name; }
  __hash__(): number { return hashString(`clip:${this.name}`); }
  toJSON(): string { return this.name; }
}

/** A key in locale/<lang>.json (`project.Text.score_label`). */
export class TextRef {
  static readonly __ref_to__: string = 'text';
  readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  get id(): string { return this.key; }
  __eq__(o: unknown): boolean { return o instanceof TextRef && o.constructor === this.constructor && o.key === this.key; }
  __hash__(): number { return hashString(`text:${this.key}`); }
  toJSON(): string { return this.key; }
}

/**
 * Player-facing text written inline in content/config (SDK `Localized`). `key` is its
 * JSON path (`stage.dawn.name`), `text` the source-language string.
 */
export class Localized extends TextRef {
  readonly text: string;

  constructor(key: string, text: string) {
    super(key);
    this.text = text;
  }

  override toJSON(): string { return this.text; }
  override toString(): string { return this.text; }
}

/** Python `Enum`: members are singletons with `name` and `value`, stored by value. */
export class Enum {
  readonly name: string;
  readonly value: string | number;

  /** Members are made by `enum_class`, never by calling the class. */
  protected constructor(name: string, value: string | number) {
    this.name = name;
    this.value = value;
  }

  __eq__(o: unknown): boolean { return o === this; }
  __hash__(): number { return hashString(`${this.constructor.name}.${this.name}`); }
  toJSON(): string | number { return this.value; }
  toString(): string { return `${this.constructor.name}.${this.name}`; }
}

const ENUM_MEMBERS = Symbol('parallax.enum.members');
type EnumClass = AnyClass & { [ENUM_MEMBERS]?: Map<string | number, Enum> };

/**
 * Finish an `Enum` subclass: its str/int class attributes become members (what
 * Python's EnumMeta does). The transpiler emits `X = enum_class(X)` after the class body.
 */
export function enum_class<T extends typeof Enum>(cls: T): T {
  if (!(cls.prototype instanceof Enum)) fail('PP4109', `${cls.name} does not subclass Enum`);
  const members = new Map<string | number, Enum>();
  const byName: Record<string, Enum> = {};
  for (const name of Object.getOwnPropertyNames(cls)) {
    if (name === 'prototype' || name === 'length' || name === 'name' || name.startsWith('__')) continue;
    const value = (cls as unknown as Record<string, unknown>)[name];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (members.has(value)) fail('PP4109', `${cls.name}.${name} repeats the value ${JSON.stringify(value)}`);
    const member = Object.create(cls.prototype as object) as Enum;
    Object.defineProperties(member, {
      name: { value: name, enumerable: true },
      value: { value, enumerable: true },
    });
    Object.freeze(member);
    members.set(value, member);
    byName[name] = member;
    Object.defineProperty(cls, name, { value: member, enumerable: true, writable: false });
  }
  Object.defineProperty(cls, ENUM_MEMBERS, { value: members });
  Object.defineProperty(cls, '__members__', { value: Object.freeze(byName) });
  return cls;
}

function enumMembers(cls: EnumClass): Map<string | number, Enum> {
  const members = cls[ENUM_MEMBERS];
  if (members === undefined) {
    fail('PP4109', `Enum ${cls.name} was never finished`, { fix: `Apply enum_class(${cls.name}) after its class body.` });
  }
  return members;
}

// ── Field declarations: field() / param() / state() ───────────────────────────

export type Role = 'field' | 'param' | 'state';
const KEEPS: readonly Keep[] = ['scene', 'run', 'session', 'profile'];
const REPLICATE = [true, false, 'all', 'owner', 'team'] as const;

export class FieldDecl {
  readonly role: Role;
  readonly hasDefault: boolean;
  readonly default: unknown;
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly choices: readonly unknown[] | undefined;
  readonly keep: Keep | undefined;
  readonly replicate: (typeof REPLICATE)[number];
  readonly modifiable: boolean;
  readonly unit: string | undefined;
  readonly doc: string | undefined;

  constructor(role: Role, args: Record<string, unknown>) {
    this.role = role;
    this.hasDefault = 'default' in args;
    this.default = args['default'];
    this.min = optionalNumber(args['min'], 'min');
    this.max = optionalNumber(args['max'], 'max');
    this.choices = args['choices'] === undefined || args['choices'] === null ? undefined : [...(args['choices'] as Iterable<unknown>)];
    const keep = args['keep'] ?? undefined;
    if (keep !== undefined && keep !== null && !KEEPS.includes(keep as Keep)) {
      fail('PP4110', `keep=${JSON.stringify(keep)} is not a lifetime`, { fix: `Use one of ${KEEPS.map((k) => `"${k}"`).join(', ')}.` });
    }
    this.keep = (keep ?? undefined) as Keep | undefined;
    const replicate = args['replicate'] ?? false;
    if (!REPLICATE.includes(replicate as never)) {
      fail('PP4110', `replicate=${JSON.stringify(replicate)} is not valid`, { fix: 'Use True, False, "all", "owner" or "team".' });
    }
    this.replicate = replicate as (typeof REPLICATE)[number];
    this.modifiable = args['modifiable'] === true;
    this.unit = args['unit'] as string | undefined;
    this.doc = args['doc'] as string | undefined;
  }
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') fail('PP4110', `${name}= must be a number, got ${JSON.stringify(value)}`);
  return value;
}

export function field(...args: unknown[]): FieldDecl {
  return new FieldDecl('field', bindArgs('field', args, {
    positional: ['default'],
    keyword: ['min', 'max', 'unit', 'choices', 'doc', 'keep', 'replicate', 'modifiable'],
  }).args);
}

export function param(...args: unknown[]): FieldDecl {
  return new FieldDecl('param', bindArgs('param', args, {
    positional: ['default'], keyword: ['min', 'max', 'unit', 'choices', 'doc'],
  }).args);
}

export function state(...args: unknown[]): FieldDecl {
  return new FieldDecl('state', bindArgs('state', args, { positional: ['default'], keyword: ['replicate', 'doc'] }).args);
}

// ── Records ────────────────────────────────────────────────────────────────────

/** Set on `@record` classes (and engine records such as `Timer`). */
export const RECORD = Symbol('parallax.record');

/**
 * `@record` equality, as `@dataclass` (eq=True, frozen=False) gives it: `__eq__` compares
 * the fields in declaration order when both sides are the same class (else
 * NotImplemented), and the class is unhashable (`__hash__ = None`) — unless the class
 * body defines `__eq__` / `__hash__` itself, which are kept.
 */
export function recordEquality(cls: AnyClass, own: object = cls.prototype as object): void {
  const proto = cls.prototype as object;
  if (!Object.prototype.hasOwnProperty.call(own, '__eq__')) {
    Object.defineProperty(proto, '__eq__', {
      value(this: Record<string, unknown>, other: unknown): unknown {
        if (other === null || typeof other !== 'object' || (other as object).constructor !== this.constructor) return NotImplemented;
        const that = other as Record<string, unknown>;
        for (const f of schemaOf(this.constructor as AnyClass, `record ${cls.name}`).fields) {
          const a = this[f.name];
          const b = that[f.name];
          if (a !== b && !eq(a, b)) return false;
        }
        return true;
      },
      writable: true, enumerable: false, configurable: true,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(own, '__hash__')) {
    Object.defineProperty(proto, '__hash__', { value: null, writable: true, enumerable: false, configurable: true });
  }
}

export function isRecordClass(value: unknown): value is AnyClass {
  return typeof value === 'function' && (value as unknown as Record<symbol, unknown>)[RECORD] === true;
}

/** Set on content classes by `@content`: their kind id. */
export interface ContentClass {
  readonly __content_kind__: string;
  readonly name: string;
}

export function isContentClass(value: unknown): value is ContentClass {
  return typeof value === 'function' && typeof (value as unknown as ContentClass).__content_kind__ === 'string';
}

// ── Resolved types ─────────────────────────────────────────────────────────────

export type ApiType =
  | { readonly kind: 'value'; readonly field: FieldType }
  | { readonly kind: 'ref'; readonly field: FieldType; readonly cls: RefClass }
  | { readonly kind: 'content'; readonly field: FieldType; readonly target: ContentClass }
  | { readonly kind: 'enum'; readonly field: FieldType; readonly cls: EnumClass }
  | { readonly kind: 'record'; readonly field: FieldType; readonly cls: AnyClass; readonly info: SchemaInfo }
  | { readonly kind: 'localized'; readonly field: FieldType }
  /** `Any`: JSON; its objects are presented as `PyDict`s. */
  | { readonly kind: 'json'; readonly field: FieldType }
  | { readonly kind: 'list' | 'optional' | 'set' | 'frozenset'; readonly field: FieldType; readonly of: ApiType }
  | { readonly kind: 'dict'; readonly field: FieldType; readonly key: ApiType; readonly of: ApiType }
  /** `rest`: `tuple[T, ...]` (any length, every item `items[0]`). */
  | { readonly kind: 'tuple'; readonly field: FieldType; readonly items: readonly ApiType[]; readonly rest: boolean }
  | { readonly kind: 'union'; readonly field: FieldType; readonly alternatives: readonly ApiType[] }
  /**
   * A live handle (`Handle`): held in resources and `state()`, never saved — outside the
   * kernel schema (`field` is only nominal). After a restore the handle it holds is inactive.
   */
  | { readonly kind: 'live'; readonly field: FieldType; readonly cls: AnyClass };

const CORE_VALUES = new Map<unknown, FieldType>([
  [Vec2, { kind: 'vec2' }],
  [Vec3, { kind: 'vec3' }],
  [Color, { kind: 'color' }],
  [Cell, { kind: 'cell' }],
  [Cell3, { kind: 'cell3' }],
]);

function describe(annotation: unknown): string {
  if (typeof annotation === 'function') return annotation.name;
  if (isMarker(annotation)) return `rt.${annotation.__marker__}`;
  if (annotation === Ellipsis) return '...';
  return JSON.stringify(annotation) ?? String(annotation);
}

const FIELD_TYPES = 'Field types: bool, int, float, str, Any, Vec2, Vec3, Color, Cell, Cell3, Entity, Tag, a *Ref, ContentRef[X], '
  + 'a @record class, a str-valued Enum, Localized, and list/set/frozenset/dict/tuple/unions/X | None of those.';

function notAFieldType(annotation: unknown, where: string, fix = FIELD_TYPES): never {
  return fail('PP4109', `${where}: ${describe(annotation)} is not a field type`, { fix });
}

/** Key types a dict field can store (JSON object keys are strings). */
function checkKey(key: ApiType, annotation: unknown, where: string): ApiType {
  const ok = key.kind === 'ref' || key.kind === 'content' || key.kind === 'enum'
    || (key.kind === 'value' && (key.field.kind === 'string' || key.field.kind === 'int' || key.field.kind === 'enum'));
  if (!ok) {
    fail('PP4109', `${where}: ${describe(annotation)} can't key a dict field (saved dict keys are strings)`, {
      fix: 'Key it by str, int, a str-valued Enum, a Literal, a Tag, a *Ref or ContentRef[X]; or keep a list of @record entries.',
    });
  }
  return key;
}

/** An annotation value → its api type. `where` names it in errors. */
export function resolveType(annotation: unknown, where: string): ApiType {
  if (isMarker(annotation)) {
    switch (annotation.__marker__) {
      case 'float': return { kind: 'value', field: { kind: 'number' } };
      case 'int': return { kind: 'value', field: { kind: 'int' } };
      case 'str': return { kind: 'value', field: { kind: 'string' } };
      case 'bool': return { kind: 'value', field: { kind: 'bool' } };
      case 'any': return { kind: 'json', field: { kind: 'json' } };
      case 'none': return notAFieldType(annotation, where, 'A field that is always None holds nothing: write X | None.');
      case 'callable':
        return fail('PP4109', `${where}: a function can't be stored in a field`, {
          fix: 'Store what picks the function (an Enum or a str id) and look the function up in a dict when you call it.',
        });
      case 'type':
        return fail('PP4109', `${where}: a class can't be stored in a field`, {
          fix: 'Store an Enum or a str id and map it to the class in code.',
        });
      case 'classvar':
        return fail('PP4109', `${where}: ClassVar[...] is a class attribute, not a field type`, { fix: 'Annotate the class attribute itself with ClassVar[X].' });
      case 'final': return resolveType(annotation.of, where);
      case 'list':
      case 'optional': {
        const of = resolveType(annotation.of, where);
        return { kind: annotation.__marker__, field: { kind: annotation.__marker__, of: of.field }, of };
      }
      case 'set':
      case 'frozenset': {
        const of = resolveType(annotation.of, where);
        return { kind: annotation.__marker__, field: { kind: 'list', of: of.field }, of };
      }
      case 'dict': {
        const key = checkKey(resolveType(annotation.key, `${where} (key)`), annotation.key, where);
        const of = resolveType(annotation.value, where);
        return { kind: 'dict', field: { kind: 'dict', of: of.field }, key, of };
      }
      case 'tuple': {
        const raw = annotation.items;
        if (raw.length === 2 && raw[1] === Ellipsis) {
          const of = resolveType(raw[0], where);
          return { kind: 'tuple', field: { kind: 'list', of: of.field }, items: [of], rest: true };
        }
        if (raw.includes(Ellipsis)) {
          fail('PP4109', `${where}: ... is only valid as tuple[X, ...]`, { fix: 'Write tuple[X, ...] for any length, or list every item type.' });
        }
        const items = raw.map((item) => resolveType(item, where));
        return { kind: 'tuple', field: { kind: 'tuple', of: items.map((i) => i.field) }, items, rest: false };
      }
      case 'union': {
        const alternatives = annotation.items.map((item) => resolveType(item, where));
        return { kind: 'union', field: { kind: 'union', of: alternatives.map((a) => a.field) }, alternatives };
      }
      case 'literal': {
        if (!annotation.values.every((v) => typeof v === 'string')) {
          fail('PP4109', `${where}: only str Literal[...] values are field types`, { fix: 'Use a str-valued Enum or plain int.' });
        }
        return { kind: 'value', field: { kind: 'enum', values: annotation.values as string[] } };
      }
      case 'generic': {
        if ((annotation.base as { __generic__?: string } | null)?.__generic__ === 'content_ref' && annotation.args.length === 1) {
          const target = annotation.args[0];
          if (!isContentClass(target)) {
            fail('PP4109', `${where}: ContentRef[${describe(target)}] needs a @content class`);
          }
          return { kind: 'content', field: { kind: 'ref', to: `content/${target.__content_kind__}` }, target };
        }
        return notAFieldType(annotation.base, where);
      }
    }
  }
  if (typeof annotation !== 'function') return notAFieldType(annotation, where);

  const core = CORE_VALUES.get(annotation);
  if (core !== undefined) return { kind: 'value', field: core };
  if (annotation === Localized) return { kind: 'localized', field: { kind: 'string' } };
  if (annotation === Tag) return { kind: 'ref', field: { kind: 'tag' }, cls: Tag };
  if (annotation.prototype instanceof Enum) {
    const members = enumMembers(annotation as EnumClass);
    const values = [...members.keys()];
    if (!values.every((v) => typeof v === 'string')) {
      fail('PP4109', `${where}: Enum ${annotation.name} must have str values to be a field type`);
    }
    return { kind: 'enum', field: { kind: 'enum', values: values as string[] }, cls: annotation as EnumClass };
  }
  if (isRecordClass(annotation)) {
    const info = schemaOf(annotation, `record ${annotation.name}`);
    const live = info.fields.find((f) => f.live);
    if (live !== undefined) {
      fail('PP4109', `record ${annotation.name}.${live.name}: a Handle is held only in resources and behavior state() (it is never saved)`, {
        fix: 'Move the handle to a @resource field or a behavior state(None).',
      });
    }
    return { kind: 'record', field: { kind: 'record', fields: info.schema }, cls: annotation, info };
  }
  const typed = annotation as unknown as TypedClass;
  if (typed.__ref_to__ !== undefined) {
    return { kind: 'ref', field: { kind: 'ref', to: typed.__ref_to__ }, cls: annotation as unknown as RefClass };
  }
  if (typed.__field_type__ !== undefined) return { kind: 'value', field: typed.__field_type__ };
  if (typed.__live__ === true) return { kind: 'live', field: { kind: 'json' }, cls: annotation as AnyClass };
  return notAFieldType(annotation, where);
}

/** The kernel FieldType for an annotation value (`declarations.json` uses the same shape). */
export function toFieldType(annotation: unknown, where = 'annotation'): FieldType {
  return resolveType(annotation, where).field;
}

/** A reference class: constructed from its stored id. */
export type RefClass = new (id: string) => object;

/** A stored id as its handle; tags are interned (`Tag.of`). */
export function presentRef(cls: RefClass, id: string): object {
  return cls === Tag ? Tag.of(id) : new cls(id);
}

const REF_CLASSES: readonly (TypedClass & RefClass)[] = [
  PrefabRef, SceneRef, EntityRef, WorldLayerRef, DialogueRef, AssetRef, SoundRef, MusicRef, ImageRef, ModelRef, EffectRef,
  ClipRef, TextRef,
];

/**
 * How game code sees a value stored under a kernel ref target (engine components declare
 * their fields as kernel FieldTypes): the matching *Ref class, or undefined (content refs
 * need the running game; see `CoerceEnv`).
 */
export function refClass(to: string): RefClass | undefined {
  return REF_CLASSES.find((c) => c.__ref_to__ === to);
}

// ── Schemas of declared classes ────────────────────────────────────────────────

export interface FieldInfo {
  readonly name: string;
  readonly type: ApiType;
  readonly role: Role;
  readonly decl: FieldDecl | undefined;
  readonly spec: FieldSpec;
  /** The default as game code wrote it (api form), for constructors. */
  readonly apiDefault: { readonly value: unknown } | undefined;
  /** A live handle (or `X | None` of one): not in the kernel schema, never saved. */
  readonly live: boolean;
}

export interface SchemaInfo {
  readonly fields: readonly FieldInfo[];
  readonly schema: Schema;
  /** Fields whose stored form differs from what game code sees. */
  readonly coerced: readonly FieldInfo[];
}

type Annotated = { __annotations__?: Record<string, () => unknown> };
const SCHEMAS = new WeakMap<object, SchemaInfo>();

/** Classes from the root down to `cls`, so a subclass's fields follow its parent's. */
function lineage(cls: AnyClass): AnyClass[] {
  const chain: AnyClass[] = [];
  for (let c: unknown = cls; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    chain.unshift(c as AnyClass);
  }
  return chain;
}

/**
 * The class attribute game code assigned to `name` on `cls` or a base. Only enumerable
 * statics count (compiled `class_attr` and TypeScript `static x = …` both are): a class's
 * built-in `name`, `length` and `prototype` are not defaults.
 */
function declaredAttribute(cls: AnyClass, name: string): { readonly value: unknown } | undefined {
  for (let c: unknown = cls; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const d = Object.getOwnPropertyDescriptor(c, name);
    if (d !== undefined && d.enumerable === true) return { value: 'value' in d ? d.value : d.get?.call(cls) };
  }
  return undefined;
}

/** `cls.__annotations__` thunks of the class and its bases, resolved; with their defaults. */
export function schemaOf(cls: AnyClass, label: string): SchemaInfo {
  const cached = SCHEMAS.get(cls);
  if (cached !== undefined) return cached;

  const annotations = new Map<string, () => unknown>();
  for (const c of lineage(cls)) {
    if (!Object.prototype.hasOwnProperty.call(c, '__annotations__')) continue;
    for (const [name, thunk] of Object.entries((c as Annotated).__annotations__ ?? {})) {
      if (typeof thunk !== 'function') fail('PP9300', `${label}.__annotations__.${name} is not a thunk`);
      annotations.set(name, thunk);
    }
  }

  const fields: FieldInfo[] = [];
  for (const [name, thunk] of annotations) {
    const where = `${label}.${name}`;
    const annotation = thunk();
    // `x: ClassVar[T] = ...` is a class attribute, as in a dataclass.
    if (isMarker(annotation) && annotation.__marker__ === 'classvar') continue;
    let type = resolveType(annotation, where);
    const declared = declaredAttribute(cls, name);
    const raw = declared?.value;
    const decl = raw instanceof FieldDecl ? raw : undefined;
    const hasDefault = decl !== undefined ? decl.hasDefault : declared !== undefined;
    const apiDefault = decl !== undefined ? decl.default : raw;

    const live = isLive(type);
    if (live) checkLive(type, decl, declared !== undefined, where);
    if (decl?.choices !== undefined) type = withChoices(type, decl.choices, where);
    if (decl?.modifiable === true && !(type.kind === 'value' && (type.field.kind === 'number' || type.field.kind === 'int'))) {
      fail('PP4106', `${where} is modifiable but not a number`, { fix: 'Only int and float fields take modifiers.' });
    }

    const spec: FieldSpec = {
      type: type.field,
      ...(hasDefault && !live && { default: toKernelForm(type, apiDefault, where) }),
      ...(decl?.min !== undefined && { min: decl.min }),
      ...(decl?.max !== undefined && { max: decl.max }),
      ...(decl?.keep !== undefined && { keep: decl.keep }),
      ...(decl?.modifiable === true && { modifiable: true }),
    };
    fields.push({
      name, type, role: decl?.role ?? 'field', decl, spec,
      apiDefault: hasDefault ? { value: apiDefault } : undefined,
      live,
    });
  }
  const info: SchemaInfo = {
    fields,
    schema: Object.fromEntries(fields.filter((f) => !f.live).map((f) => [f.name, f.spec])),
    coerced: fields.filter((f) => needsCoercion(f.type)),
  };
  SCHEMAS.set(cls, info);
  return info;
}

/** A subset of a class's fields as a kernel schema (behavior params, state); live fields stay out. */
export function schemaFor(fields: readonly FieldInfo[]): Schema {
  return Object.fromEntries(fields.filter((f) => !f.live).map((f) => [f.name, f.spec]));
}

function isLive(type: ApiType): boolean {
  switch (type.kind) {
    case 'live': return true;
    case 'optional': return isLive(type.of);
    case 'union': return type.alternatives.some(isLive);
    case 'list': case 'set': case 'frozenset': case 'tuple': case 'dict': {
      const inner = type.kind === 'tuple' ? type.items : type.kind === 'dict' ? [type.key, type.of] : [type.of];
      return inner.some(isLive);
    }
    default: return false;
  }
}

/**
 * The SDK's rule for `Handle` fields: resources and `state()` only, never saved — so the
 * field is exactly `Handle` or `Handle | None`, and its default is None.
 */
function checkLive(type: ApiType, decl: FieldDecl | undefined, hasDefault: boolean, where: string): void {
  const shape = type.kind === 'live' || (type.kind === 'optional' && type.of.kind === 'live');
  if (!shape) {
    fail('PP4109', `${where}: a Handle can only be held as Handle or Handle | None`, {
      fix: 'Keep one handle per field (Handle | None); a collection of running handles can\'t be described in saved data.',
    });
  }
  if (decl?.role === 'param') {
    fail('PP4109', `${where}: a Handle can't be a param() (params come from prefab data)`, { fix: 'Hold it in state(None).' });
  }
  const value = decl !== undefined ? decl.default : undefined;
  if (!hasDefault || (decl !== undefined && !decl.hasDefault) || (value !== null && value !== undefined)) {
    fail('PP4109', `${where}: a Handle field starts as None`, { fix: 'Declare it as `x: Handle | None = field(None)` (or state(None)).' });
  }
}

/** `choices=`: str, Literal and str-valued Enum fields narrow to the choices; numbers keep their type (check validates data). */
function withChoices(type: ApiType, choices: readonly unknown[], where: string): ApiType {
  const bad = (): never => fail('PP4110', `${where}: choices= must list values of the field's type, got ${choices.map((c) => describe(c)).join(', ')}`, {
    fix: 'List values the field can hold, e.g. choices=("a", "b") on a str field or choices=(Mode.A, Mode.B) on an Enum field.',
  });
  if (choices.length === 0) bad();
  if (type.kind === 'enum') {
    const values = choices.map((c) => (c instanceof type.cls ? (c as Enum).value : bad()));
    return { ...type, field: { kind: 'enum', values: values as string[] } };
  }
  if (type.kind === 'value') {
    const kind = type.field.kind;
    if (kind === 'string' || kind === 'enum') {
      if (!choices.every((c) => typeof c === 'string' && (kind === 'string' || (type.field as { values: readonly string[] }).values.includes(c)))) bad();
      return { kind: 'value', field: { kind: 'enum', values: choices as string[] } };
    }
    if (kind === 'int' && choices.every((c) => Number.isInteger(c))) return type;
    if (kind === 'number' && choices.every((c) => typeof c === 'number')) return type;
    if (kind === 'int' || kind === 'number') bad();
  }
  return fail('PP4110', `${where}: choices= applies to str, int, float, Literal and str-valued Enum fields`, {
    fix: 'Remove choices=, or narrow the field type.',
  });
}

// ── Stored form ↔ game form ────────────────────────────────────────────────────

function needsCoercion(type: ApiType): boolean {
  switch (type.kind) {
    case 'value': return false;
    case 'list': case 'optional': return needsCoercion(type.of);
    // Refs, enums, records, PyDict/PySet, frozen tuples, unions and Any all convert.
    default: return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** The type of item `i` of a list or tuple. */
function itemType(type: ApiType, i: number): ApiType | undefined {
  if (type.kind === 'list') return type.of;
  if (type.kind === 'tuple') return type.rest ? type.items[0] : type.items[i];
  return undefined;
}

function toJsonForm(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'toJSON' in value ? (value as { toJSON(): unknown }).toJSON() : value;
}

/** A dict key's stored form: the JSON object key (`3` → "3", a ref → its id, an Enum → its value). */
function storedKey(key: ApiType, k: unknown, where: string): string {
  const form = toKernelForm(key, k, where);
  if (typeof form === 'string') return form;
  if (typeof form === 'number' && Number.isInteger(form)) return String(form);
  return fail('PP4102', `${where}: the key ${String(k)} can't be stored`, { fix: 'Use keys of the dict\'s declared key type.' });
}

/** A game-form value → the kernel's stored form (ids, enum values, plain objects and lists). */
export function toKernelForm(type: ApiType, value: unknown, where: string): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (type.kind) {
    case 'value': return value;
    case 'json': return value instanceof PyDict || value instanceof SetBase ? toJsonForm(value) : value;
    case 'ref': case 'content': case 'localized': return toJsonForm(value);
    case 'enum': return value instanceof Enum ? value.value : value;
    case 'record': {
      if (typeof value !== 'object') return fail('PP4102', `${where} must be a ${type.cls.name}`);
      const object = value as Record<string, unknown>;
      return Object.fromEntries(type.info.fields.map((f) => [f.name, toKernelForm(f.type, object[f.name], `${where}.${f.name}`)]));
    }
    case 'list': case 'tuple': {
      if (!Array.isArray(value)) return value;
      const items = value.map((v, i) => { const t = itemType(type, i); return t === undefined ? v : toKernelForm(t, v, `${where}[${i}]`); });
      // A kernel `tuple` holds a frozen array; `tuple[T, ...]` is stored as a list.
      return type.kind === 'tuple' && !type.rest ? Object.freeze(items) : items;
    }
    case 'set': case 'frozenset': {
      const items = value instanceof SetBase ? [...value] : Array.isArray(value) ? value : undefined;
      if (items === undefined) return fail('PP4102', `${where} must be a ${type.kind}`);
      return items.map((v, i) => toKernelForm(type.of, v, `${where}[${i}]`));
    }
    case 'optional': return toKernelForm(type.of, value, where);
    case 'live': return fail('PP4109', `${where}: a Handle is never saved`);
    case 'dict': {
      const entries: [unknown, unknown][] = value instanceof PyDict
        ? [...value.entries()].map((e) => [e.key, e.value])
        : isPlainObject(value) ? Object.entries(value) : [];
      if (!(value instanceof PyDict) && !isPlainObject(value)) return fail('PP4102', `${where} must be a dict`);
      return Object.fromEntries(entries.map(([k, v]) => {
        const key = storedKey(type.key, k, `${where} key`);
        return [key, toKernelForm(type.of, v, `${where}.${key}`)];
      }));
    }
    case 'union': {
      const alt = type.alternatives.find((a) => isGameForm(a, value)) ?? type.alternatives.find((a) => isStoredForm(a.field, value));
      if (alt === undefined) return fail('PP4102', `${where} is none of its types`, { fix: 'Assign a value of one of the declared types.' });
      return toKernelForm(alt, value, where);
    }
  }
}

/** Whether `value` is already how game code sees `type` (and so not a stored form of it). */
function isGameForm(type: ApiType, value: unknown): boolean {
  switch (type.kind) {
    case 'ref': return value instanceof type.cls;
    case 'content': return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === type.target.__content_kind__
      && typeof (value as { id?: unknown }).id === 'string';
    case 'enum': return value instanceof type.cls;
    case 'record': return value instanceof type.cls;
    case 'localized': return value instanceof Localized;
    case 'dict': return value instanceof PyDict;
    case 'set': return value instanceof PySet;
    case 'frozenset': return value instanceof PyFrozenSet;
    case 'optional': return value === null || isGameForm(type.of, value);
    case 'union': return type.alternatives.some((a) => isGameForm(a, value));
    default: return false;
  }
}

/** Whether the kernel stores `value` under `field` (how it picks a union's alternative). */
function isStoredForm(field: FieldType, value: unknown): boolean {
  switch (field.kind) {
    case 'number': return typeof value === 'number';
    case 'int': return typeof value === 'number' && Number.isInteger(value);
    case 'bool': return typeof value === 'boolean';
    case 'string': case 'ref': case 'tag': return typeof value === 'string';
    case 'enum': return typeof value === 'string' && field.values.includes(value);
    case 'vec2': return value instanceof Vec2;
    case 'vec3': return value instanceof Vec3;
    case 'color': return value instanceof Color;
    case 'cell': return value instanceof Cell;
    case 'cell3': return value instanceof Cell3;
    case 'entity': return typeof value === 'object' && value !== null && '__entity_id__' in value;
    case 'json': return true;
    case 'optional': return value === null || isStoredForm(field.of, value);
    case 'list': return Array.isArray(value);
    case 'tuple': return Array.isArray(value) && value.length === field.of.length;
    case 'dict': case 'record': return isPlainObject(value);
    case 'union': return field.of.some((f) => isStoredForm(f, value));
  }
}

/** Lookups coercion needs from the running game. */
export interface CoerceEnv {
  content(target: ContentClass, id: string): unknown;
}

function presentKey(key: ApiType, k: string, env: CoerceEnv, path: string): unknown {
  if (key.kind === 'value' && key.field.kind === 'int') {
    if (!/^-?\d+$/.test(k)) fail('PP4102', `${path}: the key ${JSON.stringify(k)} is not an int`, { fix: 'Write int keys as "3".' });
    return Number(k);
  }
  return coerce(key, k, env, `${path}.${k}`);
}

/** JSON as game code sees it: objects are dicts. */
function presentJson(value: unknown): unknown {
  if (isPlainObject(value)) return PyDict.from(Object.entries(value).map(([k, v]) => [k, presentJson(v)]));
  if (Array.isArray(value) && !Object.isFrozen(value)) value.forEach((v, i) => { value[i] = presentJson(v); });
  return value;
}

/**
 * A stored value → what game code sees. Lists and records are converted in place (a list
 * stays the same list); dicts, sets and frozen tuples are new objects, which the caller
 * stores back. Converting a value already in game form returns it. `path` keys `Localized` text.
 */
export function coerce(type: ApiType, value: unknown, env: CoerceEnv, path: string): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (type.kind) {
    case 'value': return value;
    case 'json': return presentJson(value);
    case 'ref': return typeof value === 'string' ? presentRef(type.cls, value) : value;
    case 'content': return typeof value === 'string' ? env.content(type.target, value) : value;
    case 'localized': return typeof value === 'string' ? new Localized(path, value) : value;
    case 'enum': {
      if (value instanceof Enum) return value;
      const member = enumMembers(type.cls).get(value as string);
      if (member === undefined) fail('PP4102', `${path}: ${JSON.stringify(value)} is not a ${type.cls.name}`);
      return member;
    }
    case 'record': {
      if (typeof value !== 'object') return value;
      if (Object.getPrototypeOf(value) !== type.cls.prototype) Object.setPrototypeOf(value, type.cls.prototype as object);
      coerceFields(type.info, value as Record<string, unknown>, env, path);
      return value;
    }
    case 'list':
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          const key = isPlainObject(item) && typeof item['id'] === 'string' ? item['id'] : String(i);
          const converted = coerce(type.of, item, env, `${path}.${key}`);
          if (converted !== item) value[i] = converted;
        });
      }
      return value;
    case 'tuple': {
      if (!Array.isArray(value)) return value;
      const items = value.map((item, i) => coerce(itemType(type, i)!, item, env, `${path}.${i}`));
      if (Object.isFrozen(value)) return items.every((item, i) => item === value[i]) ? value : Object.freeze(items);
      items.forEach((item, i) => { value[i] = item; });
      return Object.freeze(value);
    }
    case 'set': case 'frozenset': {
      if (value instanceof SetBase) return value;
      if (!Array.isArray(value)) return value;
      const items = value.map((item, i) => coerce(type.of, item, env, `${path}.${i}`));
      return type.kind === 'set' ? new PySet(items) : new PyFrozenSet(items);
    }
    case 'optional': return coerce(type.of, value, env, path);
    case 'dict': {
      if (!isPlainObject(value)) return value;
      return PyDict.from(Object.entries(value).map(([k, v]) => [presentKey(type.key, k, env, path), coerce(type.of, v, env, `${path}.${k}`)]));
    }
    case 'union': {
      if (type.alternatives.some((a) => isGameForm(a, value))) return value;
      // A literal/enum alternative that lists the value is exact; a ref or str takes any string.
      const alt = type.alternatives.find((a) => a.field.kind === 'enum' && isStoredForm(a.field, value))
        ?? type.alternatives.find((a) => isStoredForm(a.field, value));
      return alt === undefined ? value : coerce(alt, value, env, path);
    }
    case 'live':
      if (value === undefined || value === null) return null;
      if (!(value instanceof type.cls)) fail('PP3007', `${path} holds a ${type.cls.name} or None, got ${String(value)}`);
      return value;
  }
}

/** Coerce a fields object's converted fields in place. */
export function coerceFields(info: SchemaInfo, fields: Record<string, unknown>, env: CoerceEnv, path: string): void {
  for (const f of info.coerced) {
    const value = fields[f.name];
    const converted = coerce(f.type, value, env, `${path}.${f.name}`);
    if (converted !== value) fields[f.name] = converted;
  }
}

/** A deep copy of a game-form default (records keep their class; tuples and frozensets are shared). */
export function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return (Object.isFrozen(value) ? value : value.map(cloneValue)) as T;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof PyDict) {
    const copy = value.copy();
    for (const entry of copy.entries()) entry.value = cloneValue(entry.value);
    return copy as T;
  }
  if (value instanceof PySet) return value.copy() as T;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === Object.prototype || isRecordClass((proto as { constructor?: unknown } | null)?.constructor)) {
    const copy = Object.create(proto) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) copy[k] = cloneValue(v);
    return copy as T;
  }
  return value;
}
