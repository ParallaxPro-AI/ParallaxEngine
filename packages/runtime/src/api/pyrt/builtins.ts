/**
 * Python's builtin functions. The builtin types (`int`, `str`, `list`, …) are plain
 * functions tagged with `PY_TYPE`, so they work both as constructors (`int("3")`) and as
 * `isinstance` / `defaultdict(list)` arguments.
 */

import { Kwargs } from '../kwargs.js';
import { len, PyDict, PyFrozenSet, PyRange, PySet } from './collections.js';
import { OverflowError, StopIteration, typeError, ValueError } from './errors.js';
import { format, roundFloat } from './format.js';
import { sortItems } from './methods.js';
import { bind, call, isClass, PyObject, sig } from './objects.js';
import {
  add, divmod as divmodOp, gt, hash as hashOf, isList, isNone, isTuple, iterate, lt, PY_TYPE, pow as powOp, repr as reprOf,
  str as strOf, truthy, typeName,
} from './values.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;

function pyType<T extends (...args: any[]) => unknown>(name: string, fn: T): T {
  Object.defineProperty(fn, PY_TYPE, { value: name });
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

const NO_ARG = Symbol('pyrt.noArg');
const ABSENT = Symbol('pyrt.absent');

function intArg(x: unknown, what = ''): number {
  if (typeof x === 'boolean') return +x;
  if (typeof x === 'number' && Number.isInteger(x)) return x;
  throw typeError(`'${typeName(x)}' object cannot be interpreted as an integer${what}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

const PY_INT = /^[+-]?(\d(_?\d)*)$/;

export const int = pyType('int', (x: unknown = 0, base: unknown = NO_ARG): number => {
  if (base !== NO_ARG) {
    if (typeof x !== 'string') throw typeError("int() can't convert non-string with explicit base");
    const b = intArg(base);
    const text = x.trim().replace(/_/g, '').toLowerCase().replace(/^([+-]?)0[box]/, '$1');
    const n = parseInt(text, b);
    if (Number.isNaN(n) || !/^[+-]?[0-9a-z]+$/.test(text)) throw new ValueError(`invalid literal for int() with base ${b}: ${reprOf(x)}`);
    return n;
  }
  if (typeof x === 'boolean') return +x;
  if (typeof x === 'number') {
    if (Number.isNaN(x)) throw new ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(x)) throw new OverflowError('cannot convert float infinity to integer');
    return Math.trunc(x) + 0;
  }
  if (typeof x === 'string') {
    const text = x.trim();
    if (!PY_INT.test(text)) throw new ValueError(`invalid literal for int() with base 10: ${reprOf(x)}`);
    return Number(text.replace(/_/g, ''));
  }
  if (x !== null && x !== undefined && typeof (x as Any).__int__ === 'function') return (x as Any).__int__();
  throw typeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(x)}'`);
});

const PY_FLOAT = /^[+-]?((\d(_?\d)*)?\.?\d(_?\d)*([eE][+-]?\d(_?\d)*)?|\d(_?\d)*\.)$/;

export const float = pyType('float', (x: unknown = 0): number => {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return +x;
  if (typeof x === 'string') {
    const text = x.trim().toLowerCase();
    const m = /^([+-]?)(inf|infinity|nan)$/.exec(text);
    if (m !== null) return m[2] === 'nan' ? NaN : m[1] === '-' ? -Infinity : Infinity;
    if (!PY_FLOAT.test(text)) throw new ValueError(`could not convert string to float: ${reprOf(x)}`);
    return Number(text.replace(/_/g, ''));
  }
  if (x !== null && x !== undefined && typeof (x as Any).__float__ === 'function') return (x as Any).__float__();
  throw typeError(`float() argument must be a string or a real number, not '${typeName(x)}'`);
});

export const str = pyType('str', (x: unknown = ''): string => strOf(x));
export const bool = pyType('bool', (x: unknown = false): boolean => truthy(x));
export const list = pyType('list', (x: unknown = []): unknown[] => [...iterate(x)]);
export const tuple = pyType('tuple', (x: unknown = []): readonly unknown[] =>
  (isTuple(x) && Object.getPrototypeOf(x) === Array.prototype ? x : Object.freeze([...iterate(x)])));
export const set = pyType('set', (x: unknown = []): PySet => new PySet(iterate(x)));
export const frozenset = pyType('frozenset', (x: unknown = []): PyFrozenSet => (x instanceof PyFrozenSet ? x : new PyFrozenSet(iterate(x))));
export const dict = Object.assign(pyType('dict', (...args: unknown[]): PyDict => {
  const d = new PyDict();
  d.update(...args);
  return d;
}), { fromkeys: (keys: unknown, value: unknown = null): PyDict => PyDict.fromkeys(keys, value) });
export const range = pyType('range', (...args: unknown[]): PyRange => {
  if (args.length === 0 || args.length > 3) throw typeError(`range expected at least 1 argument, got ${args.length}`);
  const [a, b, c] = args.map((x) => intArg(x));
  if (args.length === 1) return new PyRange(0, a!, 1);
  if (c === 0) throw new ValueError('range() arg 3 must not be zero');
  return new PyRange(a!, b!, c ?? 1);
});
export const object = PyObject;

/** `type(x)`: the class of x (builtin values give their type function). */
export function type(x: unknown): unknown {
  if (isNone(x)) return NoneType;
  switch (typeof x) {
    case 'boolean': return bool;
    case 'number': return Number.isInteger(x) ? int : float;
    case 'string': return str;
    default: break;
  }
  if (Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype) return Object.isFrozen(x) ? tuple : list;
  const ctor = (x as Any).constructor;
  return ctor === PyDict ? dict : ctor === PySet ? set : ctor === PyFrozenSet ? frozenset : ctor === PyRange ? range : ctor;
}

const NoneType = pyType('NoneType', (): null => null);

// ── isinstance ────────────────────────────────────────────────────────────────

/** Note: one JS number type carries int and float, so `isinstance(3.0, int)` is True and
 * `isinstance(3.0, float)` False — Parallax Python can't tell an integral float apart. */
function isInstanceOne(x: unknown, t: unknown): boolean {
  if (t === int) return typeof x === 'boolean' || (typeof x === 'number' && Number.isInteger(x));
  if (t === float) return typeof x === 'number' && !Number.isInteger(x);
  if (t === bool) return typeof x === 'boolean';
  if (t === str) return typeof x === 'string';
  if (t === list) return isList(x);
  if (t === tuple) return isTuple(x);
  if (t === dict) return x instanceof PyDict;
  if (t === set) return x instanceof PySet;
  if (t === frozenset) return x instanceof PyFrozenSet;
  if (t === range) return x instanceof PyRange;
  if (t === NoneType) return isNone(x);
  if (t === PyObject) return true;
  if (typeof t === 'function' && isClass(t)) return x !== null && x !== undefined && (x instanceof (t as Any));
  throw typeError('isinstance() arg 2 must be a type, a tuple of types, or a union');
}

export function isinstance(x: unknown, t: unknown): boolean {
  if (isTuple(t)) return t.some((u) => isinstance(x, u));
  return isInstanceOne(x, t);
}

export function issubclass(c: unknown, t: unknown): boolean {
  if (isTuple(t)) return t.some((u) => issubclass(c, u));
  if (typeof c !== 'function') throw typeError('issubclass() arg 1 must be a class');
  if (typeof t !== 'function') throw typeError('issubclass() arg 2 must be a class, a tuple of classes, or a union');
  return c === t || t === PyObject || (c as Any).prototype instanceof (t as Any);
}

export function callable(x: unknown): boolean {
  return typeof x === 'function' || (x !== null && typeof x === 'object' && typeof (x as Any).__call__ === 'function');
}

// ── Output ────────────────────────────────────────────────────────────────────

let sink: (text: string) => void = (text) => {
  console.log(text.endsWith('\n') ? text.slice(0, -1) : text);
};

/** Where `print` writes (the runtime routes it to the game's log). */
export function setPrintSink(fn: (text: string) => void): void {
  sink = fn;
}

const PRINT = sig('print', [], 0, [], ['sep', 'end'], [' ', '\n'], 'values', null, false);

export function print(...args: unknown[]): null {
  const [values, sep, end] = bind(PRINT, args) as [readonly unknown[], unknown, unknown];
  const s = isNone(sep) ? ' ' : sep;
  const e = isNone(end) ? '\n' : end;
  if (typeof s !== 'string') throw typeError(`sep must be None or a string, not ${typeName(s)}`);
  if (typeof e !== 'string') throw typeError(`end must be None or a string, not ${typeName(e)}`);
  sink(values.map((v) => strOf(v)).join(s) + e);
  return null;
}

export function repr(x: unknown): string { return reprOf(x); }

// ── Numbers ───────────────────────────────────────────────────────────────────

export function abs(x: unknown): unknown {
  if (typeof x === 'number') return Math.abs(x);
  if (typeof x === 'boolean') return +x;
  if (x !== null && x !== undefined && typeof (x as Any).__abs__ === 'function') return (x as Any).__abs__();
  throw typeError(`bad operand type for abs(): '${typeName(x)}'`);
}

const ROUND = sig('round', ['number', 'ndigits'], 0, [null], [], [], null, null, false);

/** CPython `round`: half to even, on the exact value. */
export function round(...args: unknown[]): unknown {
  const [x, ndigits] = bind(ROUND, args);
  if (typeof x !== 'number' && typeof x !== 'boolean') {
    if (x !== null && x !== undefined && typeof (x as Any).__round__ === 'function') {
      return isNone(ndigits) ? (x as Any).__round__() : (x as Any).__round__(ndigits);
    }
    throw typeError(`type ${typeName(x)} doesn't define __round__ method`);
  }
  const v = +x;
  if (isNone(ndigits)) {
    if (Number.isNaN(v)) throw new ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(v)) throw new OverflowError('cannot convert float infinity to integer');
    const f = Math.floor(v);
    const diff = v - f;
    const r = diff > 0.5 ? f + 1 : diff < 0.5 ? f : f % 2 === 0 ? f : f + 1;
    return r + 0;
  }
  const n = intArg(ndigits);
  if (Number.isInteger(v) && n >= 0) return v;
  if (Number.isInteger(v)) {
    const m = 10 ** -n;
    const q = Math.floor(v / m);
    const rem = v - q * m;
    const r = 2 * rem > m || (2 * rem === m && q % 2 !== 0) ? q + 1 : q;
    return r * m + 0;
  }
  return roundFloat(v, n);
}

export function divmod(a: unknown, b: unknown): unknown { return divmodOp(a, b); }
export function pow(a: unknown, b: unknown, m?: unknown): unknown { return powOp(a, b, m); }

export function chr(i: unknown): string {
  const n = intArg(i);
  if (n < 0 || n > 0x10ffff) throw new ValueError('chr() arg not in range(0x110000)');
  return String.fromCodePoint(n);
}

export function ord(c: unknown): number {
  if (typeof c !== 'string') throw typeError(`ord() expected string of length 1, but ${typeName(c)} found`);
  const chars = Array.from(c);
  if (chars.length !== 1) throw typeError(`ord() expected a character, but string of length ${chars.length} found`);
  return chars[0]!.codePointAt(0)!;
}

function baseString(x: unknown, base: number, prefix: string): string {
  const n = intArg(x);
  const digits = BigInt(Math.abs(n)).toString(base);
  return `${n < 0 ? '-' : ''}${prefix}${digits}`;
}
export const bin = (x: unknown): string => baseString(x, 2, '0b');
export const oct = (x: unknown): string => baseString(x, 8, '0o');
export const hex = (x: unknown): string => baseString(x, 16, '0x');

export function hash(x: unknown): number { return hashOf(x); }

export { format };

// ── Iteration ─────────────────────────────────────────────────────────────────

const MINMAX = sig('max', [], 0, [], ['key', 'default'], [null, ABSENT], 'args', null, false);

function extreme(name: string, args: unknown[], better: (a: unknown, b: unknown) => boolean): unknown {
  const [values, key, fallback] = bind({ ...MINMAX, name }, args) as [readonly unknown[], unknown, unknown];
  let items: Iterable<unknown>;
  if (values.length === 0) throw typeError(`${name} expected at least 1 argument, got 0`);
  if (values.length === 1) items = iterate(values[0]);
  else {
    if (fallback !== ABSENT) throw typeError(`Cannot specify a default for ${name}() with multiple positional arguments`);
    items = values;
  }
  let best: unknown = NO_ARG;
  let bestKey: unknown;
  for (const item of items) {
    const k = isNone(key) ? item : call(key, item);
    if (best === NO_ARG || better(k, bestKey)) {
      best = item;
      bestKey = k;
    }
  }
  if (best === NO_ARG) {
    if (fallback !== ABSENT) return fallback;
    throw new ValueError(`${name}() iterable argument is empty`);
  }
  return best;
}

export const max = (...args: unknown[]): unknown => extreme('max', args, gt);
export const min = (...args: unknown[]): unknown => extreme('min', args, lt);

const SUM = sig('sum', ['iterable', 'start'], 1, [0], [], [], null, null, false);

/** CPython 3.12+ `sum`: exact for ints, Neumaier-compensated for floats. */
export function sum(...args: unknown[]): unknown {
  const [iterable, start] = bind(SUM, args);
  if (typeof start === 'string') throw typeError("sum() can't sum strings [use ''.join(seq) instead]");
  let total: unknown = start;
  const it = iterate(iterable)[Symbol.iterator]();
  if (typeof total === 'number' || typeof total === 'boolean') {
    let f = +total;
    let c = 0;
    let compensated = false;
    for (;;) {
      const step = it.next();
      if (step.done === true) return compensated && c !== 0 && Number.isFinite(c) ? f + c : f;
      const x = step.value;
      if (typeof x === 'number' || typeof x === 'boolean') {
        const v = +x;
        if (!compensated && Number.isInteger(v) && Number.isInteger(f)) {
          f += v;
          continue;
        }
        compensated = true;
        const t = f + v;
        if (Math.abs(f) >= Math.abs(v)) c += (f - t) + v;
        else c += (v - t) + f;
        f = t;
        continue;
      }
      total = add(compensated && c !== 0 && Number.isFinite(c) ? f + c : f, x);
      break;
    }
  }
  for (let step = it.next(); step.done !== true; step = it.next()) total = add(total, step.value);
  return total;
}

const SORTED = sig('sorted', ['iterable'], 1, [], ['key', 'reverse'], [null, false], null, null, false);

export function sorted(...args: unknown[]): unknown[] {
  const [iterable, key, reverse] = bind(SORTED, args);
  return sortItems([...iterate(iterable)], isNone(key) ? null : (v: unknown) => call(key, v), truthy(reverse));
}

export function* reversed(x: unknown): Generator<unknown> {
  if (x !== null && x !== undefined && typeof (x as Any).__reversed__ === 'function') {
    yield* iterate((x as Any).__reversed__());
    return;
  }
  if (x instanceof PyDict) {
    yield* [...x].reverse();
    return;
  }
  if (typeof x === 'string') {
    yield* Array.from(x).reverse();
    return;
  }
  if (x instanceof PyRange) {
    yield* [...x].reverse();
    return;
  }
  if (!Array.isArray(x)) throw typeError(`'${typeName(x)}' object is not reversible`);
  for (let i = x.length - 1; i >= 0; i--) {
    if (i >= x.length) continue;
    yield x[i];
  }
}

const ENUMERATE = sig('enumerate', ['iterable', 'start'], 0, [0], [], [], null, null, false);

export function enumerate(...args: unknown[]): Generator<readonly unknown[]> {
  const [iterable, start] = bind(ENUMERATE, args);
  const items = iterate(iterable);
  let i = intArg(start);
  return (function* () {
    for (const x of items) yield Object.freeze([i++, x]);
  })();
}

export function zip(...args: unknown[]): Generator<readonly unknown[]> {
  let strict = false;
  const last = args[args.length - 1];
  if (last instanceof Kwargs) {
    args = args.slice(0, -1);
    for (const k of Object.keys(last.values)) {
      if (k !== 'strict') throw typeError(`zip() got an unexpected keyword argument '${k}'`);
    }
    strict = truthy(last.values['strict']);
  }
  const its = args.map((a) => iterate(a)[Symbol.iterator]());
  return (function* () {
    if (its.length === 0) return;
    for (;;) {
      const row: unknown[] = [];
      for (let i = 0; i < its.length; i++) {
        const step = its[i]!.next();
        if (step.done === true) {
          if (strict && (i > 0 || its.slice(1).some((it) => it.next().done !== true))) {
            throw new ValueError(`zip() argument ${i > 0 ? i + 1 : 2} is ${i > 0 ? 'shorter' : 'longer'} than argument${i > 1 ? `s 1-${i}` : ' 1'}`);
          }
          return;
        }
        row.push(step.value);
      }
      yield Object.freeze(row);
    }
  })();
}

export function map(f: unknown, ...iterables: unknown[]): Generator<unknown> {
  if (iterables.length === 0) throw typeError('map() must have at least two arguments.');
  const its = iterables.map((a) => iterate(a)[Symbol.iterator]());
  return (function* () {
    for (;;) {
      const row: unknown[] = [];
      for (const it of its) {
        const step = it.next();
        if (step.done === true) return;
        row.push(step.value);
      }
      yield call(f, ...row);
    }
  })();
}

export function filter(f: unknown, iterable: unknown): Generator<unknown> {
  const items = iterate(iterable);
  return (function* () {
    for (const x of items) if (truthy(isNone(f) ? x : call(f, x))) yield x;
  })();
}

export function any(iterable: unknown): boolean {
  for (const x of iterate(iterable)) if (truthy(x)) return true;
  return false;
}

export function all(iterable: unknown): boolean {
  for (const x of iterate(iterable)) if (!truthy(x)) return false;
  return true;
}

/** `iter(x)`: a JS iterator. */
export function iter(x: unknown): Iterator<unknown> {
  const items = iterate(x);
  const it = items[Symbol.iterator]();
  return Symbol.iterator in it ? it : { next: () => it.next(), [Symbol.iterator]() { return this; } } as Iterator<unknown>;
}

/** `next(it[, default])`. */
export function next(it: unknown, ...fallback: unknown[]): unknown {
  const o = it as Any;
  if (o !== null && o !== undefined && typeof o.next === 'function' && Symbol.iterator in o) {
    const step = o.next();
    if (step.done !== true) return step.value;
  } else if (o !== null && o !== undefined && typeof o.__next__ === 'function') {
    try {
      return o.__next__();
    } catch (e) {
      if (!(e instanceof StopIteration) || fallback.length === 0) throw e;
      return fallback[0];
    }
  } else {
    throw typeError(`'${typeName(it)}' object is not an iterator`);
  }
  if (fallback.length > 0) return fallback[0];
  throw new StopIteration();
}

export { len };
