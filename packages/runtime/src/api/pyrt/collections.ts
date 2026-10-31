/**
 * dict, set, frozenset and range with Python semantics, plus subscripting, slicing,
 * `len`, `in` and unpacking over every Python value.
 *
 * Keys follow Python equality: `1`, `1.0` and `True` are one key; tuples, `Vec2`, `Cell`,
 * frozen dataclasses — anything with `__hash__`/`__eq__` — are keys by value; other
 * objects by identity; lists, dicts and sets are unhashable. dicts keep insertion order.
 * Sets iterate in insertion order (CPython's set order is hash order, and randomized for
 * str, so programs can't depend on it; ours is deterministic).
 */

import { copy as copyValue, COPY } from '../../function/kernel/index.js';
import { splitArgs } from '../kwargs.js';
import { AttributeError, IndexError, KeyError, RuntimeError, typeError, ValueError } from './errors.js';
import { eq, guardedRepr, hash, isList, isTuple, iterate, NotImplemented, repr, repr_float, truthy, typeName } from './values.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;

const NONE_KEY = Symbol('None');
const ABSENT = Symbol('absent');

/** Insertion-ordered hash table keyed by Python equality. */
class Table {
  readonly #role: string;
  readonly entries = new Map<unknown, { key: unknown; value: unknown }>();
  readonly #buckets = new Map<number, unknown[]>();
  version = 0;

  constructor(role: 'dict key' | 'set element') {
    this.#role = role;
  }

  #unhashable(key: unknown): never {
    throw typeError(`cannot use '${typeName(key)}' as a ${this.#role} (unhashable type: '${typeName(key)}')`);
  }

  /** The Map key standing for `key`; ABSENT when looking up a missing hashed key. */
  slot(key: unknown, create: boolean): unknown {
    switch (typeof key) {
      case 'string': return key;
      case 'number': return key === 0 ? 0 : key;
      case 'boolean': return key ? 1 : 0;
      case 'undefined': return NONE_KEY;
      case 'function': return key;
      default: break;
    }
    if (key === null) return NONE_KEY;
    const o = key as Any;
    if (o instanceof PyDict || o instanceof PySet) this.#unhashable(key);
    if (Array.isArray(o) ? (isTuple(o) || '__hash__' in o) : '__hash__' in o) {
      if (isList(o) && Object.getPrototypeOf(o) === Array.prototype) this.#unhashable(key);
      if (!Array.isArray(o) && typeof o.__hash__ !== 'function') this.#unhashable(key);
      const h = hash(o);
      const bucket = this.#buckets.get(h);
      if (bucket !== undefined) {
        for (const candidate of bucket) if (candidate === o || eq(candidate, o)) return candidate;
      }
      if (!create) return ABSENT;
      if (bucket === undefined) this.#buckets.set(h, [o]);
      else bucket.push(o);
      return o;
    }
    if (isList(o)) this.#unhashable(key);
    return o;
  }

  get(key: unknown): { key: unknown; value: unknown } | undefined {
    const slot = this.slot(key, false);
    return slot === ABSENT ? undefined : this.entries.get(slot);
  }

  set(key: unknown, value: unknown): void {
    const slot = this.slot(key, true);
    const entry = this.entries.get(slot);
    if (entry !== undefined) entry.value = value;
    else {
      this.entries.set(slot, { key, value });
      this.version++;
    }
  }

  delete(key: unknown): { key: unknown; value: unknown } | undefined {
    const slot = this.slot(key, false);
    if (slot === ABSENT) return undefined;
    const entry = this.entries.get(slot);
    if (entry === undefined) return undefined;
    this.entries.delete(slot);
    this.version++;
    if (typeof slot === 'object' && slot !== null && (Array.isArray(slot) || '__hash__' in slot)) {
      const h = hash(slot);
      const bucket = this.#buckets.get(h);
      const i = bucket === undefined ? -1 : bucket.indexOf(slot);
      if (bucket !== undefined && i >= 0) {
        bucket.splice(i, 1);
        if (bucket.length === 0) this.#buckets.delete(h);
      }
    }
    return entry;
  }

  clear(): void {
    this.entries.clear();
    this.#buckets.clear();
    this.version++;
  }

  *iterate(kind: string, pick: (e: { key: unknown; value: unknown }) => unknown): Generator<unknown> {
    const version = this.version;
    for (const entry of this.entries.values()) {
      yield pick(entry);
      if (this.version !== version) throw new RuntimeError(`${kind} changed size during iteration`);
    }
  }
}

// ── dict ──────────────────────────────────────────────────────────────────────

export class PyDict {
  readonly #table = new Table('dict key');

  get [Symbol.toStringTag](): string { return 'dict'; }

  /** dict entries for runtime code: [key, value] pairs in order. */
  static from(pairs: Iterable<readonly [unknown, unknown]>): PyDict {
    const d = new PyDict();
    for (const [k, v] of pairs) d.__setitem__(k, v);
    return d;
  }

  static fromkeys(keys: unknown, value: unknown = null): PyDict {
    const d = new PyDict();
    for (const k of iterate(keys)) d.__setitem__(k, value);
    return d;
  }

  __len__(): number { return this.#table.entries.size; }
  __contains__(key: unknown): boolean { return this.#table.get(key) !== undefined; }

  __getitem__(key: unknown): unknown {
    const entry = this.#table.get(key);
    if (entry !== undefined) return entry.value;
    const missing = (this as Any).__missing__;
    if (typeof missing === 'function') return missing.call(this, key);
    throw new KeyError(key);
  }

  __setitem__(key: unknown, value: unknown): void { this.#table.set(key, value); }

  __delitem__(key: unknown): void {
    if (this.#table.delete(key) === undefined) throw new KeyError(key);
  }

  [Symbol.iterator](): Iterator<unknown> { return this.#table.iterate('dictionary', (e) => e.key); }
  __iter__(): Iterator<unknown> { return this[Symbol.iterator](); }

  get(key: unknown, fallback: unknown = null): unknown {
    const entry = this.#table.get(key);
    return entry !== undefined ? entry.value : fallback;
  }

  pop(key: unknown, ...fallback: unknown[]): unknown {
    const entry = this.#table.delete(key);
    if (entry !== undefined) return entry.value;
    if (fallback.length > 0) return fallback[0];
    throw new KeyError(key);
  }

  popitem(): readonly unknown[] {
    const last = [...this.#table.entries.values()].pop();
    if (last === undefined) throw new KeyError('popitem(): dictionary is empty');
    this.#table.delete(last.key);
    return Object.freeze([last.key, last.value]);
  }

  setdefault(key: unknown, fallback: unknown = null): unknown {
    const entry = this.#table.get(key);
    if (entry !== undefined) return entry.value;
    this.#table.set(key, fallback);
    return fallback;
  }

  update(...args: unknown[]): void {
    const { positional, keywords } = splitArgs(args);
    if (positional.length > 1) throw typeError(`update expected at most 1 argument, got ${positional.length}`);
    if (positional.length === 1) updateFrom(this, positional[0]);
    for (const [k, v] of Object.entries(keywords)) this.__setitem__(k, v);
  }

  keys(): DictView { return new DictView(this, 'keys'); }
  values(): DictView { return new DictView(this, 'values'); }
  items(): DictView { return new DictView(this, 'items'); }

  copy(): PyDict {
    const d = new (this.constructor as new () => PyDict)();
    for (const e of this.#table.entries.values()) d.__setitem__(e.key, e.value);
    return d;
  }

  clear(): void { this.#table.clear(); }

  /** Entries in order (runtime use). */
  entries(): IterableIterator<{ key: unknown; value: unknown }> { return this.#table.entries.values(); }

  /**
   * The engine's stored form (kernel `encode`, `JSON.stringify`): a JSON object keyed as
   * `json.dumps` keys it (`3` → "3", `True` → "true"; a ref or Enum by its own `toJSON`).
   * Values stay as they are; the encoder walks them.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.#table.entries.values()) out[jsonKey(e.key)] = e.value;
    return out;
  }

  /** The kernel's deep copy (`copy` of a field value): no two entities share a dict. */
  [COPY](): PyDict {
    const d = this.copy();
    for (const e of d.#table.entries.values()) e.value = copyValue(e.value);
    return d;
  }

  __eq__(other: unknown): unknown {
    if (!(other instanceof PyDict)) return NotImplemented;
    if (other.__len__() !== this.__len__()) return false;
    for (const e of this.#table.entries.values()) {
      const o = other.#table.get(e.key);
      if (o === undefined || !(o.value === e.value || eq(o.value, e.value))) return false;
    }
    return true;
  }

  __or__(other: unknown): unknown {
    if (!(other instanceof PyDict)) return NotImplemented;
    const d = this.copy();
    updateFrom(d, other);
    return d;
  }

  __ior__(other: unknown): unknown {
    updateFrom(this, other);
    return this;
  }

  __repr__(): string {
    return guardedRepr(this, '{...}', () =>
      `{${[...this.#table.entries.values()].map((e) => `${repr(e.key)}: ${repr(e.value)}`).join(', ')}}`);
  }
}

function jsonKey(key: unknown): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'number') return Number.isInteger(key) ? String(key) : repr_float(key);
  if (typeof key === 'boolean') return key ? 'true' : 'false';
  if (key === null || key === undefined) return 'null';
  const toJSON = (key as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const form = (toJSON as () => unknown).call(key);
    if (typeof form === 'string' || typeof form === 'number') return jsonKey(form);
  }
  throw typeError(`keys must be str, int, float, bool or None, not ${typeName(key)}`);
}

function updateFrom(d: PyDict, source: unknown): void {
  if (source instanceof PyDict) {
    for (const e of [...source.entries()]) d.__setitem__(e.key, e.value);
    return;
  }
  const o = source as Any;
  if (o !== null && typeof o === 'object' && typeof o.keys === 'function' && !Array.isArray(o)) {
    for (const k of [...iterate(o.keys())]) d.__setitem__(k, getitem(o, k));
    return;
  }
  let i = 0;
  for (const pair of iterate(source)) {
    const items = [...iterate(pair)];
    if (items.length !== 2) {
      throw new ValueError(`dictionary update sequence element #${i} has length ${items.length}; 2 is required`);
    }
    d.__setitem__(items[0], items[1]);
    i++;
  }
}

export class DictView {
  readonly #dict: PyDict;
  readonly #kind: 'keys' | 'values' | 'items';

  constructor(dict: PyDict, kind: 'keys' | 'values' | 'items') {
    this.#dict = dict;
    this.#kind = kind;
  }

  [Symbol.iterator](): Iterator<unknown> {
    const kind = this.#kind;
    const it = this.#dict[Symbol.iterator]() as Generator<unknown>;
    if (kind === 'keys') return it;
    const dict = this.#dict;
    return (function* () {
      for (const key of it) {
        const value = dict.__getitem__(key);
        yield kind === 'values' ? value : Object.freeze([key, value]);
      }
    })();
  }

  __iter__(): Iterator<unknown> { return this[Symbol.iterator](); }
  __len__(): number { return this.#dict.__len__(); }

  __contains__(x: unknown): boolean {
    if (this.#kind === 'keys') return this.#dict.__contains__(x);
    for (const v of this) if (v === x || eq(v, x)) return true;
    return false;
  }

  __repr__(): string {
    return `dict_${this.#kind}([${[...this].map((v) => repr(v)).join(', ')}])`;
  }

  get [Symbol.toStringTag](): string { return `dict_${this.#kind}`; }

  // Keys and items views are set-like (collections.abc.Set); values views are not. As in
  // CPython, one function serves both operand orders, the result is always a set, and the
  // other operand may be any iterable.

  /** Whether `x` takes part in set-like comparisons with a view: a set, frozenset, or keys/items view. */
  static #setLike(x: unknown): boolean {
    return x instanceof SetBase || (x instanceof DictView && x.#kind !== 'values');
  }

  #binary(other: unknown, op: (a: PySet, b: unknown) => unknown, swapped: boolean): unknown {
    if (this.#kind === 'values') return NotImplemented;
    return swapped ? op(new PySet(iterate(other)), this) : op(new PySet(this), other);
  }

  __sub__(o: unknown): unknown { return this.#binary(o, (a, b) => a.difference(b), false); }
  __rsub__(o: unknown): unknown { return this.#binary(o, (a, b) => a.difference(b), true); }
  __and__(o: unknown): unknown { return this.#binary(o, (a, b) => a.intersection(b), false); }
  __rand__(o: unknown): unknown { return this.#binary(o, (a, b) => a.intersection(b), true); }
  __or__(o: unknown): unknown { return this.#binary(o, (a, b) => a.union(b), false); }
  __ror__(o: unknown): unknown { return this.#binary(o, (a, b) => a.union(b), true); }
  __xor__(o: unknown): unknown { return this.#binary(o, (a, b) => a.symmetric_difference(b), false); }
  __rxor__(o: unknown): unknown { return this.#binary(o, (a, b) => a.symmetric_difference(b), true); }

  isdisjoint(other: unknown): boolean {
    if (this.#kind === 'values') throw new AttributeError("'dict_values' object has no attribute 'isdisjoint'");
    for (const x of iterate(other)) if (this.__contains__(x)) return false;
    return true;
  }

  /** Every element of `a` is in `b` (CPython's all_contained_in). */
  static #within(a: { [Symbol.iterator](): Iterator<unknown> }, b: { __contains__(x: unknown): boolean }): boolean {
    for (const x of a as Iterable<unknown>) if (!b.__contains__(x)) return false;
    return true;
  }

  #compare(other: unknown, test: (mine: number, theirs: number) => boolean, subset: boolean | null): unknown {
    if (this.#kind === 'values' || !DictView.#setLike(other)) return NotImplemented;
    const o = other as SetBase | DictView;
    if (!test(this.__len__(), o.__len__())) return false;
    return subset === false ? DictView.#within(o, this) : DictView.#within(this, o);
  }

  __eq__(o: unknown): unknown { return this.#compare(o, (m, t) => m === t, true); }
  __le__(o: unknown): unknown { return this.#compare(o, (m, t) => m <= t, true); }
  __lt__(o: unknown): unknown { return this.#compare(o, (m, t) => m < t, true); }
  __ge__(o: unknown): unknown { return this.#compare(o, (m, t) => m >= t, false); }
  __gt__(o: unknown): unknown { return this.#compare(o, (m, t) => m > t, false); }
}

// ── set / frozenset ───────────────────────────────────────────────────────────

export class SetBase {
  readonly #table = new Table('set element');

  constructor(items?: Iterable<unknown>) {
    if (items !== undefined) for (const item of items) this.#table.set(item, item);
  }

  protected table(): Table { return this.#table; }

  #make(items: Iterable<unknown>): SetBase {
    return new (this.constructor as new (items: Iterable<unknown>) => SetBase)(items);
  }

  __len__(): number { return this.#table.entries.size; }
  __contains__(x: unknown): boolean { return this.#table.get(x) !== undefined; }
  [Symbol.iterator](): Iterator<unknown> { return this.#table.iterate('Set', (e) => e.key); }
  __iter__(): Iterator<unknown> { return this[Symbol.iterator](); }

  copy(): SetBase { return this.#make(this); }

  /** The engine's stored form: a list of the items, in iteration order. */
  toJSON(): unknown[] { return [...this]; }

  /** The kernel's copy: elements are hashable (immutable), so a shallow copy. */
  [COPY](): SetBase { return this.copy(); }

  union(...others: unknown[]): SetBase {
    const out = this.#make(this);
    for (const o of others) for (const x of iterate(o)) out.#table.set(x, x);
    return out;
  }

  intersection(...others: unknown[]): SetBase {
    let items = [...this];
    for (const o of others) {
      const other = toSet(o);
      items = items.filter((x) => other.__contains__(x));
    }
    return this.#make(items);
  }

  difference(...others: unknown[]): SetBase {
    let items = [...this];
    for (const o of others) {
      const other = toSet(o);
      items = items.filter((x) => !other.__contains__(x));
    }
    return this.#make(items);
  }

  symmetric_difference(other: unknown): SetBase {
    const o = toSet(other);
    return this.#make([...[...this].filter((x) => !o.__contains__(x)), ...[...o].filter((x) => !this.__contains__(x))]);
  }

  issubset(other: unknown): boolean {
    const o = toSet(other);
    return [...this].every((x) => o.__contains__(x));
  }

  issuperset(other: unknown): boolean {
    return [...iterate(other)].every((x) => this.__contains__(x));
  }

  isdisjoint(other: unknown): boolean {
    return [...iterate(other)].every((x) => !this.__contains__(x));
  }

  __eq__(other: unknown): unknown {
    if (!(other instanceof SetBase)) return NotImplemented;
    return other.__len__() === this.__len__() && this.issubset(other);
  }

  __le__(other: unknown): unknown { return other instanceof SetBase ? this.issubset(other) : NotImplemented; }
  __lt__(other: unknown): unknown {
    return other instanceof SetBase ? this.__len__() < other.__len__() && this.issubset(other) : NotImplemented;
  }
  __ge__(other: unknown): unknown { return other instanceof SetBase ? this.issuperset(other) : NotImplemented; }
  __gt__(other: unknown): unknown {
    return other instanceof SetBase ? this.__len__() > other.__len__() && this.issuperset(other) : NotImplemented;
  }
  __or__(other: unknown): unknown { return other instanceof SetBase ? this.union(other) : NotImplemented; }
  __and__(other: unknown): unknown { return other instanceof SetBase ? this.intersection(other) : NotImplemented; }
  __sub__(other: unknown): unknown { return other instanceof SetBase ? this.difference(other) : NotImplemented; }
  __xor__(other: unknown): unknown {
    return other instanceof SetBase ? this.symmetric_difference(other) : NotImplemented;
  }

  protected itemsRepr(): string {
    return guardedRepr(this, '{...}', () => `{${[...this].map((x) => repr(x)).join(', ')}}`);
  }
}

function toSet(x: unknown): SetBase {
  return x instanceof SetBase ? x : new PySet(iterate(x));
}

export class PySet extends SetBase {
  get [Symbol.toStringTag](): string { return 'set'; }

  add(x: unknown): void { this.table().set(x, x); }

  remove(x: unknown): void {
    if (this.table().delete(x) === undefined) throw new KeyError(x);
  }

  discard(x: unknown): void { this.table().delete(x); }

  pop(): unknown {
    const first = this.table().entries.values().next();
    if (first.done === true) throw new KeyError('pop from an empty set');
    this.table().delete(first.value.key);
    return first.value.key;
  }

  clear(): void { this.table().clear(); }

  update(...others: unknown[]): void {
    for (const o of others) for (const x of iterate(o)) this.table().set(x, x);
  }

  intersection_update(...others: unknown[]): void { this.#replace(this.intersection(...others)); }
  difference_update(...others: unknown[]): void { this.#replace(this.difference(...others)); }
  symmetric_difference_update(other: unknown): void { this.#replace(this.symmetric_difference(other)); }

  #replace(items: SetBase): void {
    this.table().clear();
    for (const x of items) this.table().set(x, x);
  }

  __ior__(other: unknown): unknown {
    if (!(other instanceof SetBase)) return NotImplemented;
    this.update(other);
    return this;
  }
  __iand__(other: unknown): unknown {
    if (!(other instanceof SetBase)) return NotImplemented;
    this.intersection_update(other);
    return this;
  }
  __isub__(other: unknown): unknown {
    if (!(other instanceof SetBase)) return NotImplemented;
    this.difference_update(other);
    return this;
  }
  __ixor__(other: unknown): unknown {
    if (!(other instanceof SetBase)) return NotImplemented;
    this.symmetric_difference_update(other);
    return this;
  }

  __repr__(): string { return this.__len__() === 0 ? 'set()' : this.itemsRepr(); }
}

export class PyFrozenSet extends SetBase {
  get [Symbol.toStringTag](): string { return 'frozenset'; }

  __hash__(): number {
    let h = 0x1f2e3d;
    for (const x of this) h = (h + Math.imul(hash(x) ^ 0x5bd1e995, 0x01000193)) | 0;
    return h;
  }

  __repr__(): string { return this.__len__() === 0 ? 'frozenset()' : `frozenset(${this.itemsRepr()})`; }
}

// ── range ─────────────────────────────────────────────────────────────────────

export class PyRange {
  readonly start: number;
  readonly stop: number;
  readonly step: number;

  constructor(start: number, stop: number, step: number) {
    this.start = start;
    this.stop = stop;
    this.step = step;
  }

  __len__(): number {
    const { start, stop, step } = this;
    if (step > 0) return stop > start ? Math.floor((stop - start - 1) / step) + 1 : 0;
    return start > stop ? Math.floor((start - stop - 1) / -step) + 1 : 0;
  }

  *[Symbol.iterator](): Generator<number> {
    const { start, stop, step } = this;
    if (step > 0) for (let i = start; i < stop; i += step) yield i;
    else for (let i = start; i > stop; i += step) yield i;
  }

  __iter__(): Iterator<number> { return this[Symbol.iterator](); }

  __getitem__(i: unknown): unknown {
    const n = this.__len__();
    const index = toIndex(i, n, 'range');
    if (index < 0 || index >= n) throw new IndexError('range object index out of range');
    return this.start + index * this.step;
  }

  __contains__(x: unknown): boolean {
    if (typeof x !== 'number' && typeof x !== 'boolean') {
      for (const v of this) if (eq(v, x)) return true;
      return false;
    }
    const v = +x;
    if (!Number.isInteger(v)) return false;
    const { start, stop, step } = this;
    if (step > 0 ? v < start || v >= stop : v > start || v <= stop) return false;
    return (v - start) % step === 0;
  }

  index(x: unknown): number {
    if (!this.__contains__(x)) throw new ValueError(`${repr(x)} is not in range`);
    return (+(x as number) - this.start) / this.step;
  }

  count(x: unknown): number { return this.__contains__(x) ? 1 : 0; }

  __eq__(other: unknown): unknown {
    if (!(other instanceof PyRange)) return NotImplemented;
    const n = this.__len__();
    if (n !== other.__len__()) return false;
    if (n === 0) return true;
    return this.start === other.start && (n === 1 || this.step === other.step);
  }

  __hash__(): number { return hash(Object.freeze([this.__len__(), this.start, this.step])); }

  __repr__(): string {
    return this.step === 1 ? `range(${this.start}, ${this.stop})` : `range(${this.start}, ${this.stop}, ${this.step})`;
  }
}

// ── Literals ──────────────────────────────────────────────────────────────────

/** `(a, b)` */
export function tup(items: unknown[]): readonly unknown[] {
  return Object.freeze(items);
}

/** Marks a `**mapping` entry in `dict_of` / `kw_merge` flat lists. */
export const SPLAT = Symbol('pyrt.splat');

/** `{k1: v1, **m, k2: v2}` from a flat list [k1, v1, SPLAT, m, k2, v2]. */
export function dict_of(flat: unknown[]): PyDict {
  const d = new PyDict();
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === SPLAT) {
      const m = flat[i + 1] as Any;
      if (!(m instanceof PyDict) && !(m !== null && typeof m === 'object' && typeof m.keys === 'function')) {
        throw typeError(`'${typeName(m)}' object is not a mapping`);
      }
      updateFrom(d, m);
    } else d.__setitem__(flat[i], flat[i + 1]);
  }
  return d;
}

export function set_of(items: unknown[]): PySet {
  return new PySet(items);
}

// ── Subscripts ────────────────────────────────────────────────────────────────

const SURROGATE = /[\uD800-\uDFFF]/;

/** A string as an indexable sequence of code points. */
function codePoints(s: string): string | string[] {
  return SURROGATE.test(s) ? Array.from(s) : s;
}

function toIndex(i: unknown, length: number, kind: string): number {
  if (typeof i === 'boolean') return i ? 1 : 0;
  if (typeof i !== 'number' || !Number.isInteger(i)) {
    throw typeError(`${kind} indices must be integers${kind === 'range' ? '' : ' or slices'}, not ${typeName(i)}`);
  }
  return i < 0 ? i + length : i;
}

export function getitem(o: unknown, key: unknown): unknown {
  if (o instanceof PyDict) return o.__getitem__(key);
  if (Array.isArray(o) && Object.getPrototypeOf(o) === Array.prototype) {
    const kind = Object.isFrozen(o) ? 'tuple' : 'list';
    const i = toIndex(key, o.length, kind);
    if (i < 0 || i >= o.length) throw new IndexError(`${kind} index out of range`);
    return o[i];
  }
  if (typeof o === 'string') {
    const cps = codePoints(o);
    const i = toIndex(key, cps.length, 'string');
    if (i < 0 || i >= cps.length) throw new IndexError('string index out of range');
    return cps[i];
  }
  if (o !== null && o !== undefined) {
    const x = o as Any;
    if (typeof x.__getitem__ === 'function') return x.__getitem__(key);
    if (Array.isArray(x)) return getitem(Object.freeze([...(x as unknown[])]), key);
    if (typeof x === 'function' && x.__members__ !== undefined) {
      const member = typeof key === 'string' ? x.__members__[key] : undefined;
      if (member === undefined) throw new KeyError(key);
      return member;
    }
  }
  throw typeError(`'${typeName(o)}' object is not subscriptable`);
}

export function setitem(o: unknown, key: unknown, value: unknown): void {
  if (o instanceof PyDict) {
    o.__setitem__(key, value);
    return;
  }
  if (isList(o)) {
    const i = toIndex(key, o.length, 'list');
    if (i < 0 || i >= o.length) throw new IndexError('list assignment index out of range');
    o[i] = value;
    return;
  }
  if (o !== null && o !== undefined && typeof (o as Any).__setitem__ === 'function') {
    (o as Any).__setitem__(key, value);
    return;
  }
  throw typeError(`'${typeName(o)}' object does not support item assignment`);
}

export function delitem(o: unknown, key: unknown): void {
  if (o instanceof PyDict) {
    o.__delitem__(key);
    return;
  }
  if (isList(o)) {
    const i = toIndex(key, o.length, 'list');
    if (i < 0 || i >= o.length) throw new IndexError('list assignment index out of range');
    o.splice(i, 1);
    return;
  }
  if (o !== null && o !== undefined && typeof (o as Any).__delitem__ === 'function') {
    (o as Any).__delitem__(key);
    return;
  }
  throw typeError(`'${typeName(o)}' object doesn't support item deletion`);
}

function sliceBound(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === 'boolean') return +x;
  if (typeof x === 'number' && Number.isInteger(x)) return x;
  throw typeError('slice indices must be integers or None or have an __index__ method');
}

/** CPython's PySlice_AdjustIndices: [start, stop, step, count]. */
function sliceIndices(length: number, lo: unknown, hi: unknown, stepArg: unknown): [number, number, number, number] {
  const step = sliceBound(stepArg) ?? 1;
  if (step === 0) throw new ValueError('slice step cannot be zero');
  const clamp = (v: number | null, dflt: number): number => {
    if (v === null) return dflt;
    if (v < 0) {
      v += length;
      if (v < 0) return step < 0 ? -1 : 0;
      return v;
    }
    if (v >= length) return step < 0 ? length - 1 : length;
    return v;
  };
  const start = clamp(sliceBound(lo), step < 0 ? length - 1 : 0);
  const stop = clamp(sliceBound(hi), step < 0 ? -1 : length);
  let count = 0;
  if (step > 0 && stop > start) count = Math.floor((stop - start - 1) / step) + 1;
  if (step < 0 && start > stop) count = Math.floor((start - stop - 1) / -step) + 1;
  return [start, stop, step, count];
}

function pick<T>(items: ArrayLike<T>, lo: unknown, hi: unknown, step: unknown): T[] {
  const [start, , s, count] = sliceIndices(items.length, lo, hi, step);
  const out: T[] = [];
  for (let i = 0, j = start; i < count; i++, j += s) out.push(items[j]!);
  return out;
}

export function getslice(o: unknown, lo: unknown, hi: unknown, step: unknown): unknown {
  if (Array.isArray(o) && Object.getPrototypeOf(o) === Array.prototype) {
    const out = pick(o, lo, hi, step);
    return Object.isFrozen(o) ? Object.freeze(out) : out;
  }
  if (typeof o === 'string') {
    const cps = codePoints(o);
    return pick(cps as ArrayLike<string>, lo, hi, step).join('');
  }
  if (o instanceof PyRange) {
    const [start, , s, count] = sliceIndices(o.__len__(), lo, hi, step);
    const first = o.start + start * o.step;
    return new PyRange(first, first + count * s * o.step, s * o.step);
  }
  if (Array.isArray(o)) return Object.freeze(pick(o as unknown[], lo, hi, step));
  throw typeError(`'${typeName(o)}' object is not subscriptable`);
}

export function setslice(o: unknown, lo: unknown, hi: unknown, step: unknown, value: unknown): void {
  if (!isList(o)) throw typeError(`'${typeName(o)}' object does not support slice assignment`);
  const items = [...iterate(value)];
  const [start, stop, s, count] = sliceIndices(o.length, lo, hi, step);
  if (s === 1) {
    o.splice(start, Math.max(0, stop - start), ...items);
    return;
  }
  if (items.length !== count) {
    throw new ValueError(`attempt to assign sequence of size ${items.length} to extended slice of size ${count}`);
  }
  for (let i = 0, j = start; i < count; i++, j += s) o[j] = items[i];
}

// ── len, in, unpacking ────────────────────────────────────────────────────────

export function len(x: unknown): number {
  if (typeof x === 'string') return SURROGATE.test(x) ? Array.from(x).length : x.length;
  if (Array.isArray(x)) return x.length;
  if (x !== null && x !== undefined) {
    const o = x as Any;
    if (typeof o.__len__ === 'function') {
      const n = o.__len__();
      if (typeof n !== 'number' || !Number.isInteger(n)) throw typeError(`'${typeName(n)}' object cannot be interpreted as an integer`);
      if (n < 0) throw new ValueError('__len__() should return >= 0');
      return n;
    }
    if (typeof o === 'function' && o.__members__ !== undefined) return Object.keys(o.__members__).length;
  }
  throw typeError(`object of type '${typeName(x)}' has no len()`);
}

/** `item in container` (arguments in Python's evaluation order). */
export function in_(item: unknown, container: unknown): boolean {
  if (typeof container === 'string') {
    if (typeof item !== 'string') throw typeError(`'in <string>' requires string as left operand, not ${typeName(item)}`);
    return container.includes(item);
  }
  if (Array.isArray(container)) {
    for (const x of container) if (x === item || eq(x, item)) return true;
    return false;
  }
  if (container !== null && container !== undefined) {
    const o = container as Any;
    if (typeof o.__contains__ === 'function') return truthy(o.__contains__(item));
    if (typeof o === 'function' && o.__members__ !== undefined) {
      return Object.values(o.__members__).includes(item);
    }
    if (typeof o === 'object' && (Symbol.iterator in o || typeof o.__iter__ === 'function')) {
      for (const x of iterate(o)) if (x === item || eq(x, item)) return true;
      return false;
    }
  }
  throw typeError(`argument of type '${typeName(container)}' is not iterable`);
}

/** `a, b = value` */
export function unpack(value: unknown, n: number): readonly unknown[] {
  if (Array.isArray(value)) {
    if (value.length === n) return value;
    if (value.length > n) throw new ValueError(`too many values to unpack (expected ${n}, got ${value.length})`);
    throw new ValueError(`not enough values to unpack (expected ${n}, got ${value.length})`);
  }
  const items: unknown[] = [];
  for (const x of iterate(value)) {
    items.push(x);
    if (items.length > n) throw new ValueError(`too many values to unpack (expected ${n})`);
  }
  if (items.length < n) throw new ValueError(`not enough values to unpack (expected ${n}, got ${items.length})`);
  return items;
}

/** `a, *rest, z = value`: the starred slot holds a list. */
export function unpack_star(value: unknown, before: number, after: number): readonly unknown[] {
  const items = Array.isArray(value) ? value : [...iterate(value)];
  if (items.length < before + after) {
    throw new ValueError(`not enough values to unpack (expected at least ${before + after}, got ${items.length})`);
  }
  return [...items.slice(0, before), items.slice(before, items.length - after), ...items.slice(items.length - after)];
}
