/**
 * The standard-library modules game code may import, the parts of them
 * Parallax Python implements. The transpiler rejects any other member (PP6012).
 *
 *   math         CPython's functions and domain errors
 *   random       CPython's algorithms over the running game's seeded source
 *                (`activeRandom()`, read on every draw — it changes on each scene load)
 *   enum         Enum (api `Enum` + `enum_class`, plus lookup by value, iteration, repr)
 *   dataclasses  dataclass, field, replace
 *   typing       annotation names, NamedTuple, Protocol
 *   collections  deque, Counter, defaultdict
 */

import { Kwargs, splitArgs } from '../kwargs.js';
import { activeRandom } from '../random.js';
import { Enum as ApiEnum, enum_class as apiEnumClass } from '../types.js';
import { getitem, len, PyDict, PySet, setitem } from './collections.js';
import { IndexError, KeyError, OverflowError, typeError, ValueError } from './errors.js';
import { format } from './format.js';
import { sortItems } from './methods.js';
import { bind, call, class_attr, NO_DEFAULT, PyObject, sig } from './objects.js';
import type { Sig } from './objects.js';
import {
  add as addValues, eq, floatRepr, hash, isList, iterate, lt, mul as mulValues, NotImplemented, repr, truthy, typeName,
} from './values.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;

function num(x: unknown, _name: string): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return +x;
  throw typeError(`must be real number, not ${typeName(x)}`);
}

function intArg(x: unknown): number {
  if (typeof x === 'boolean') return +x;
  if (typeof x === 'number' && Number.isInteger(x)) return x;
  throw typeError(`'${typeName(x)}' object cannot be interpreted as an integer`);
}

// ── math ──────────────────────────────────────────────────────────────────────

function domain(ok: boolean): void {
  if (!ok) throw new ValueError('math domain error');
}

function checked(r: number, ...inputs: number[]): number {
  if (!Number.isFinite(r) && inputs.every(Number.isFinite)) {
    if (Number.isNaN(r)) throw new ValueError('math domain error');
    throw new OverflowError('math range error');
  }
  return r;
}

function toInt(x: unknown, what: string): number {
  const v = num(x, what);
  if (Number.isNaN(v)) throw new ValueError('cannot convert float NaN to integer');
  if (!Number.isFinite(v)) throw new OverflowError('cannot convert float infinity to integer');
  return v;
}

const ISCLOSE = sig('isclose', ['a', 'b'], 2, [], ['rel_tol', 'abs_tol'], [1e-9, 0], null, null, false);

export const math = Object.freeze({
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
  inf: Infinity,
  nan: NaN,
  sqrt: (x: unknown): number => {
    const v = num(x, 'x');
    if (v < 0) throw new ValueError(`expected a nonnegative input, got ${floatRepr(v)}`);
    return Math.sqrt(v);
  },
  exp: (x: unknown): number => { const v = num(x, 'x'); return checked(Math.exp(v), v); },
  log: (x: unknown, base?: unknown): number => {
    const v = num(x, 'x');
    domain(v > 0 || Number.isNaN(v));
    if (base === undefined || base === null) return Math.log(v);
    const b = num(base, 'base');
    domain(b > 0 && b !== 1);
    return Math.log(v) / Math.log(b);
  },
  log2: (x: unknown): number => { const v = num(x, 'x'); domain(v > 0 || Number.isNaN(v)); return Math.log2(v); },
  log10: (x: unknown): number => { const v = num(x, 'x'); domain(v > 0 || Number.isNaN(v)); return Math.log10(v); },
  pow: (x: unknown, y: unknown): number => {
    const a = num(x, 'x');
    const b = num(y, 'y');
    domain(!(a === 0 && b < 0) && !(a < 0 && Number.isFinite(b) && !Number.isInteger(b)));
    return checked(a ** b, a, b);
  },
  fabs: (x: unknown): number => Math.abs(num(x, 'x')),
  floor: (x: unknown): number => {
    if (x !== null && typeof x === 'object' && typeof (x as Any).__floor__ === 'function') return (x as Any).__floor__();
    return Math.floor(toInt(x, 'x')) + 0;
  },
  ceil: (x: unknown): number => {
    if (x !== null && typeof x === 'object' && typeof (x as Any).__ceil__ === 'function') return (x as Any).__ceil__();
    return Math.ceil(toInt(x, 'x')) + 0;
  },
  trunc: (x: unknown): number => Math.trunc(toInt(x, 'x')) + 0,
  sin: (x: unknown): number => { const v = num(x, 'x'); domain(Number.isFinite(v) || Number.isNaN(v)); return Math.sin(v); },
  cos: (x: unknown): number => { const v = num(x, 'x'); domain(Number.isFinite(v) || Number.isNaN(v)); return Math.cos(v); },
  tan: (x: unknown): number => { const v = num(x, 'x'); domain(Number.isFinite(v) || Number.isNaN(v)); return Math.tan(v); },
  asin: (x: unknown): number => { const v = num(x, 'x'); domain(!(Math.abs(v) > 1)); return Math.asin(v); },
  acos: (x: unknown): number => { const v = num(x, 'x'); domain(!(Math.abs(v) > 1)); return Math.acos(v); },
  atan: (x: unknown): number => Math.atan(num(x, 'x')),
  atan2: (y: unknown, x: unknown): number => Math.atan2(num(y, 'y'), num(x, 'x')),
  sinh: (x: unknown): number => { const v = num(x, 'x'); return checked(Math.sinh(v), v); },
  cosh: (x: unknown): number => { const v = num(x, 'x'); return checked(Math.cosh(v), v); },
  tanh: (x: unknown): number => Math.tanh(num(x, 'x')),
  hypot: (...xs: unknown[]): number => Math.hypot(...xs.map((x) => num(x, 'x'))),
  dist: (p: unknown, q: unknown): number => {
    const a = [...iterate(p)].map((x) => num(x, 'x'));
    const b = [...iterate(q)].map((x) => num(x, 'x'));
    if (a.length !== b.length) throw new ValueError('both points must have the same number of dimensions');
    return Math.hypot(...a.map((x, i) => x - b[i]!));
  },
  degrees: (x: unknown): number => num(x, 'x') * (180 / Math.PI),
  radians: (x: unknown): number => num(x, 'x') * (Math.PI / 180),
  copysign: (x: unknown, y: unknown): number => {
    const a = Math.abs(num(x, 'x'));
    const b = num(y, 'y');
    return b < 0 || Object.is(b, -0) ? -a : a;
  },
  fmod: (x: unknown, y: unknown): number => {
    const a = num(x, 'x');
    const b = num(y, 'y');
    domain(!(b === 0 || !Number.isFinite(a)) || Number.isNaN(a) || Number.isNaN(b));
    return a % b;
  },
  isclose: (...args: unknown[]): boolean => {
    const [x, y, relTol, absTol] = bind(ISCLOSE, args) as number[];
    const a = num(x, 'a');
    const b = num(y, 'b');
    const rel = num(relTol, 'rel_tol');
    const abs = num(absTol, 'abs_tol');
    if (rel < 0 || abs < 0) throw new ValueError('tolerances must be non-negative');
    if (a === b) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const diff = Math.abs(b - a);
    return diff <= Math.abs(rel * b) || diff <= Math.abs(rel * a) || diff <= abs;
  },
  isfinite: (x: unknown): boolean => Number.isFinite(num(x, 'x')),
  isinf: (x: unknown): boolean => { const v = num(x, 'x'); return v === Infinity || v === -Infinity; },
  isnan: (x: unknown): boolean => Number.isNaN(num(x, 'x')),
  gcd: (...xs: unknown[]): number => {
    let g = 0;
    for (const x of xs) {
      let a = Math.abs(intArg(x));
      let b = g;
      while (b !== 0) [a, b] = [b, a % b];
      g = a;
    }
    return g;
  },
  factorial: (x: unknown): number => {
    const n = intArg(x);
    if (n < 0) throw new ValueError('factorial() not defined for negative values');
    let r = 1n;
    for (let i = 2n; i <= BigInt(n); i++) r *= i;
    if (r > BigInt(Number.MAX_SAFE_INTEGER)) throw new OverflowError('factorial() result exceeds the exact int range (2**53)');
    return Number(r);
  },
  prod: (...args: unknown[]): unknown => {
    const { positional, keywords } = splitArgs(args);
    let total: unknown = 'start' in keywords ? keywords['start'] : 1;
    for (const x of iterate(positional[0])) total = mulValues(total, x);
    return total;
  },
});

// ── random ────────────────────────────────────────────────────────────────────

/** CPython's `_randbelow` for a Random that only provides random(): int(random() * n). */
function randbelow(n: number): number {
  return Math.floor(activeRandom().next() * n);
}

const CHOICES = sig('choices', ['population', 'weights'], 0, [null], ['cum_weights', 'k'], [null, 1], null, null, false);
const SAMPLE = sig('sample', ['population', 'k'], 0, [], ['counts'], [null], null, null, false);

function bisectRight(xs: number[], x: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < xs[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function randrange(...args: unknown[]): number {
  const [a, b, c] = args;
  if (args.length === 1) {
    const stop = intArg(a);
    if (stop <= 0) throw new ValueError('empty range for randrange()');
    return randbelow(stop);
  }
  const start = intArg(a);
  const stop = intArg(b);
  const step = c === undefined ? 1 : intArg(c);
  const width = stop - start;
  if (step === 1) {
    if (width <= 0) throw new ValueError(`empty range in randrange(${start}, ${stop})`);
    return start + randbelow(width);
  }
  if (step === 0) throw new ValueError('zero step for randrange()');
  const n = step > 0 ? Math.floor((width + step - 1) / step) : Math.floor((width + step + 1) / step);
  if (n <= 0) throw new ValueError(`empty range in randrange(${start}, ${stop}, ${step})`);
  return start + step * randbelow(n);
}

export const random = Object.freeze({
  random: (): number => activeRandom().next(),
  uniform: (a: unknown, b: unknown): number => {
    const x = num(a, 'a');
    return x + (num(b, 'b') - x) * activeRandom().next();
  },
  randint: (a: unknown, b: unknown): number => randrange(a, intArg(b) + 1),
  randrange,
  choice: (seq: unknown): unknown => {
    const n = len(seq);
    if (n === 0) throw new IndexError('Cannot choose from an empty sequence');
    return getitem(seq, randbelow(n));
  },
  choices: (...args: unknown[]): unknown[] => {
    const [population, weights, cumWeights, kArg] = bind(CHOICES, args);
    const n = len(population);
    const k = intArg(kArg);
    const out: unknown[] = [];
    let cum: number[];
    if (cumWeights === null || cumWeights === undefined) {
      if (weights === null || weights === undefined) {
        for (let i = 0; i < k; i++) out.push(getitem(population, Math.floor(activeRandom().next() * n)));
        return out;
      }
      cum = [];
      let acc = 0;
      for (const w of iterate(weights)) {
        acc += num(w, 'weight');
        cum.push(acc);
      }
    } else {
      if (weights !== null && weights !== undefined) throw typeError('Cannot specify both weights and cumulative weights');
      cum = [...iterate(cumWeights)].map((w) => num(w, 'weight'));
    }
    if (cum.length !== n) throw new ValueError('The number of weights does not match the population');
    const total = cum[n - 1]! + 0.0;
    if (total <= 0) throw new ValueError('Total of weights must be greater than zero');
    if (!Number.isFinite(total)) throw new ValueError('Total of weights must be finite');
    for (let i = 0; i < k; i++) out.push(getitem(population, bisectRight(cum, activeRandom().next() * total, 0, n - 1)));
    return out;
  },
  sample: (...args: unknown[]): unknown[] => {
    const [population, kArg, counts] = bind(SAMPLE, args);
    if (counts !== null && counts !== undefined) throw typeError('sample(counts=) is not supported in Parallax Python');
    if (population instanceof PySet || population instanceof PyDict || !(Array.isArray(population) || typeof population === 'string'
        || (population !== null && typeof (population as Any).__getitem__ === 'function'))) {
      throw typeError('Population must be a sequence.  For dicts or sets, use sorted(d).');
    }
    const n = len(population);
    const k = intArg(kArg);
    if (k < 0 || k > n) throw new ValueError('Sample larger than population or is negative');
    const result: unknown[] = new Array(k).fill(null);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = [...iterate(population)];
      for (let i = 0; i < k; i++) {
        const j = randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = randbelow(n);
        while (selected.has(j)) j = randbelow(n);
        selected.add(j);
        result[i] = getitem(population, j);
      }
    }
    return result;
  },
  shuffle: (x: unknown): null => {
    if (!isList(x)) throw typeError(`'${typeName(x)}' object does not support item assignment`);
    for (let i = x.length - 1; i > 0; i--) {
      const j = randbelow(i + 1);
      [x[i], x[j]] = [x[j], x[i]];
    }
    return null;
  },
  /** CPython's gauss without its cached second value (the cache isn't in the game's
   * seeded state, so it would break replays after a restore). */
  gauss: (mu: unknown = 0, sigma: unknown = 1): number => {
    const x2pi = activeRandom().next() * 2 * Math.PI;
    const g2rad = Math.sqrt(-2 * Math.log(1 - activeRandom().next()));
    return num(mu, 'mu') + Math.cos(x2pi) * g2rad * num(sigma, 'sigma');
  },
});

// ── enum ──────────────────────────────────────────────────────────────────────

/** Python's Enum: the api `Enum` (field types, stored by value) with Python's class
 * behavior. `X(value)` looks a member up; `for m in X`, `len(X)`, `X["NAME"]` work. */
export class PyEnum extends ApiEnum {
  constructor(value: unknown) {
    const cls = new.target as Any;
    const members = cls.__members__ as Record<string, PyEnum> | undefined;
    const found = members === undefined ? undefined : Object.values(members).find((m) => eq(m.value, value));
    if (found === undefined) throw new ValueError(`${repr(value)} is not a valid ${cls.__qualname__ ?? cls.name}`);
    return found;
    super('', '');
  }

  __repr__(): string { return `<${this.constructor.name}.${this.name}: ${repr(this.value)}>`; }
  __str__(): string { return `${this.constructor.name}.${this.name}`; }
  __format__(spec: unknown): string { return format(this.__str__(), spec); }
}
Object.defineProperty(PyEnum, 'name', { value: 'Enum' });

export const enum_ = Object.freeze({ Enum: PyEnum });
export const enum_class = apiEnumClass;

// ── dataclasses ───────────────────────────────────────────────────────────────

const FIELDS = Symbol('pyrt.dataclass.fields');

class DataclassField {
  readonly default: unknown;
  readonly default_factory: unknown;
  readonly init: boolean;
  readonly repr: boolean;
  readonly compare: boolean;

  constructor(options: Record<string, unknown>) {
    this.default = 'default' in options ? options['default'] : NO_DEFAULT;
    this.default_factory = 'default_factory' in options ? options['default_factory'] : NO_DEFAULT;
    if (this.default !== NO_DEFAULT && this.default_factory !== NO_DEFAULT) {
      throw new ValueError('cannot specify both default and default_factory');
    }
    this.init = options['init'] !== false;
    this.repr = options['repr'] !== false;
    this.compare = options['compare'] !== false;
  }
}

interface FieldInfo {
  readonly name: string;
  readonly default: unknown;
  readonly factory: unknown;
  readonly init: boolean;
  readonly repr: boolean;
  readonly compare: boolean;
}

const UNSET = Symbol('pyrt.unset');
const FIELD = sig('field', [], 0, [], ['default', 'default_factory', 'init', 'repr', 'compare'],
  [UNSET, UNSET, true, true, true], null, null, false);

function field(...args: unknown[]): DataclassField {
  const [d, factory, init, reprFlag, compare] = bind(FIELD, args);
  const options: Record<string, unknown> = { init, repr: reprFlag, compare };
  if (d !== UNSET) options['default'] = d;
  if (factory !== UNSET) options['default_factory'] = factory;
  return new DataclassField(options);
}

function isMutableDefault(v: unknown): boolean {
  return isList(v) || v instanceof PyDict || v instanceof PySet;
}

const DATACLASS = sig('dataclass', ['cls'], 0, [null], ['init', 'repr', 'eq', 'order', 'unsafe_hash', 'frozen'],
  [true, true, true, false, false, false], null, null, false);

function process(cls: Any, options: { init: boolean; repr: boolean; eq: boolean; order: boolean; frozen: boolean; unsafe_hash: boolean }): Any {
  const inherited: FieldInfo[] = [];
  for (let base = Object.getPrototypeOf(cls); base !== null && base !== Function.prototype; base = Object.getPrototypeOf(base)) {
    if (Object.hasOwn(base, FIELDS)) {
      inherited.push(...(base[FIELDS] as FieldInfo[]));
      break;
    }
  }
  const fields = [...inherited];
  const annotations = Object.hasOwn(cls, '__annotations__') ? cls.__annotations__ as Record<string, unknown> : {};
  for (const name of Object.keys(annotations)) {
    let def: unknown = NO_DEFAULT;
    let factory: unknown = NO_DEFAULT;
    let flags = { init: true, repr: true, compare: true };
    if (Object.hasOwn(cls, name)) {
      const value = cls[name];
      if (value instanceof DataclassField) {
        def = value.default;
        factory = value.default_factory;
        flags = { init: value.init, repr: value.repr, compare: value.compare };
        if (def === NO_DEFAULT) delete cls[name];
        else class_attr(cls, name, def);
      } else def = value;
    }
    if (isMutableDefault(def)) {
      throw new ValueError(`mutable default ${repr(typeOf(def))} for field ${name} is not allowed: use default_factory`);
    }
    const info = { name, default: def, factory, ...flags };
    const at = fields.findIndex((f) => f.name === name);
    if (at >= 0) fields[at] = info;
    else fields.push(info);
  }
  let seenDefault: string | null = null;
  for (const f of fields) {
    if (!f.init) continue;
    const hasDefault = f.default !== NO_DEFAULT || f.factory !== NO_DEFAULT;
    if (hasDefault) seenDefault = f.name;
    else if (seenDefault !== null) throw typeError(`non-default argument '${f.name}' follows default argument '${seenDefault}'`);
  }
  Object.defineProperty(cls, FIELDS, { value: fields });
  const qualname = (): string => cls.__qualname__ ?? cls.name;
  const initFields = fields.filter((f) => f.init);
  const firstDefault = initFields.findIndex((f) => f.default !== NO_DEFAULT || f.factory !== NO_DEFAULT);
  const FACTORY = Symbol('factory');
  const signature: Sig = sig(`${qualname()}.__init__`, initFields.map((f) => f.name), 0,
    firstDefault < 0 ? [] : initFields.slice(firstDefault).map((f) => (f.factory !== NO_DEFAULT ? FACTORY : f.default)),
    [], [], null, null, true);
  const own = (name: string): boolean => Object.hasOwn(cls.prototype, name);
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(cls.prototype, name, { value, writable: true, enumerable: false, configurable: true });
  };
  if (options.init && !own('__init__')) {
    define('__init__', function (this: Any, ...args: unknown[]) {
      const values = bind(signature, args);
      const set = (name: string, value: unknown): void => {
        Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
      };
      initFields.forEach((f, i) => set(f.name, values[i] === FACTORY ? call(f.factory) : values[i]));
      for (const f of fields) if (!f.init && f.factory !== NO_DEFAULT) set(f.name, call(f.factory));
      if (typeof this.__post_init__ === 'function') this.__post_init__();
      if (options.frozen && this.constructor === cls) Object.freeze(this);
    });
  }
  const compared = fields.filter((f) => f.compare);
  const tupleOf = (o: Any): readonly unknown[] => Object.freeze(compared.map((f) => o[f.name]));
  if (options.repr && !own('__repr__')) {
    define('__repr__', function (this: Any) {
      return `${this.constructor.__qualname__ ?? this.constructor.name}(${fields.filter((f) => f.repr).map((f) => `${f.name}=${repr(this[f.name])}`).join(', ')})`;
    });
  }
  if (options.eq && !own('__eq__')) {
    define('__eq__', function (this: Any, other: unknown) {
      if (other === null || typeof other !== 'object' || (other as Any).constructor !== this.constructor) return NotImplemented;
      return eq(tupleOf(this), tupleOf(other));
    });
  }
  if (options.order) {
    const cmp = (op: (a: unknown, b: unknown) => boolean) => function (this: Any, other: unknown) {
      if (other === null || typeof other !== 'object' || (other as Any).constructor !== this.constructor) return NotImplemented;
      return op(tupleOf(this), tupleOf(other));
    };
    define('__lt__', cmp(lt));
    define('__le__', cmp((a, b) => lt(a, b) || eq(a, b)));
    define('__gt__', cmp((a, b) => lt(b, a)));
    define('__ge__', cmp((a, b) => lt(b, a) || eq(a, b)));
  }
  if (!own('__hash__') || cls.prototype.__hash__ === null) {
    if (options.unsafe_hash || (options.eq && options.frozen)) define('__hash__', function (this: Any) { return hash(tupleOf(this)); });
    else if (options.eq) define('__hash__', null);
  }
  return cls;
}

function typeOf(v: unknown): unknown {
  return isList(v) ? builtinType('list') : v instanceof PyDict ? builtinType('dict') : builtinType('set');
}

function builtinType(name: string): object {
  return { __repr__: () => `<class '${name}'>` };
}

function dataclass(...args: unknown[]): unknown {
  const [cls, init, reprFlag, eqFlag, order, unsafeHash, frozen] = bind(DATACLASS, args);
  const options = {
    init: truthy(init), repr: truthy(reprFlag), eq: truthy(eqFlag), order: truthy(order),
    unsafe_hash: truthy(unsafeHash), frozen: truthy(frozen),
  };
  if (options.order && !options.eq) throw new ValueError('eq must be true if order is true');
  if (cls !== null && cls !== undefined) return process(cls, options);
  return (c: unknown) => process(c, options);
}

function replace(obj: unknown, ...args: unknown[]): unknown {
  const o = obj as Any;
  const fields = o?.constructor?.[FIELDS] as FieldInfo[] | undefined;
  if (fields === undefined) throw typeError('replace() should be called on dataclass instances');
  const { positional, keywords } = splitArgs(args);
  if (positional.length > 0) throw typeError(`replace() takes 1 positional argument but ${positional.length + 1} were given`);
  const values: Record<string, unknown> = {};
  for (const f of fields) if (f.init) values[f.name] = o[f.name];
  for (const [k, v] of Object.entries(keywords)) {
    const f = fields.find((x) => x.name === k);
    if (f === undefined || !f.init) throw typeError(`${o.constructor.__qualname__ ?? o.constructor.name}.__init__() got an unexpected keyword argument '${k}'`);
    values[k] = v;
  }
  return call(o.constructor, new Kwargs(values));
}

export const dataclasses = Object.freeze({ dataclass, field, replace });

// ── typing ────────────────────────────────────────────────────────────────────

function typingName(name: string): object {
  return Object.freeze({ __repr__: () => `typing.${name}` });
}

/** `class P(Protocol)`: a structural interface; only its implementations are instantiated. */
export class Protocol extends PyObject {
  constructor(...args: unknown[]) {
    super(...args);
  }
}
Object.defineProperty(Protocol, 'name', { value: 'Protocol' });
Object.defineProperty(Protocol, '__init_subclass__', {
  value(this: Any) {
    if (Object.getPrototypeOf(this) === Protocol) {
      Object.defineProperty(this.prototype, '__init__', {
        value(this: Any) { throw typeError('Protocols cannot be instantiated'); },
        writable: true, configurable: true,
      });
    }
  },
  writable: true, configurable: true,
});

const NT = Symbol('pyrt.namedtuple');

/** `class Point(NamedTuple): x: int; y: int = 0` — instances are tuples with field names. */
export class NamedTuple extends Array {
  constructor(...args: unknown[]) {
    const cls = new.target as Any;
    const s = cls[NT] as Sig | undefined;
    if (s === undefined) throw typeError('NamedTuple must be subclassed');
    const values = bind(s, args);
    const tuple = Object.setPrototypeOf(values, cls.prototype);
    return Object.freeze(tuple);
    super();
  }

  static __init_subclass__(this: Any): void {
    const names = Object.keys(this.__annotations__ ?? {});
    const defaults: unknown[] = [];
    names.forEach((name, i) => {
      if (Object.hasOwn(this, name)) defaults.push(this[name]);
      else if (defaults.length > 0) throw typeError(`Non-default namedtuple field ${name} cannot follow default field`);
      Object.defineProperty(this.prototype, name, { get(this: unknown[]) { return this[i]; }, configurable: true });
    });
    Object.defineProperty(this, NT, { value: sig(this.__qualname__ ?? this.name, names, 0, defaults, [], [], null, null, false) });
  }

  __repr__(this: Any): string {
    const names = (this.constructor[NT] as Sig).params;
    return `${this.constructor.__qualname__ ?? this.constructor.name}(${names.map((n, i) => `${n}=${repr(this[i])}`).join(', ')})`;
  }

  _replace(this: Any, ...args: unknown[]): unknown {
    const s = this.constructor[NT] as Sig;
    const values: Record<string, unknown> = Object.fromEntries(s.params.map((n, i) => [n, this[i]]));
    const { keywords } = splitArgs(args);
    for (const [k, v] of Object.entries(keywords)) {
      if (!s.params.includes(k)) throw new ValueError(`Got unexpected field names: ['${k}']`);
      values[k] = v;
    }
    return new this.constructor(new Kwargs(values));
  }

  _asdict(this: Any): PyDict {
    const s = this.constructor[NT] as Sig;
    return PyDict.from(s.params.map((n, i) => [n, this[i]] as const));
  }
}

export const typing = Object.freeze({
  Any: typingName('Any'),
  Callable: typingName('Callable'),
  ClassVar: typingName('ClassVar'),
  Final: typingName('Final'),
  Literal: typingName('Literal'),
  Optional: typingName('Optional'),
  Union: typingName('Union'),
  Sequence: typingName('Sequence'),
  Iterable: typingName('Iterable'),
  Iterator: typingName('Iterator'),
  Mapping: typingName('Mapping'),
  Self: typingName('Self'),
  TYPE_CHECKING: false,
  NamedTuple,
  Protocol,
});

// ── collections ───────────────────────────────────────────────────────────────

const DEQUE = sig('deque', ['iterable', 'maxlen'], 0, [[], null], [], [], null, null, false);

export class Deque {
  readonly #items: unknown[];
  readonly maxlen: number | null;

  constructor(...args: unknown[]) {
    const [iterable, maxlen] = bind(DEQUE, args);
    this.maxlen = maxlen === null || maxlen === undefined ? null : intArg(maxlen);
    if (this.maxlen !== null && this.maxlen < 0) throw new ValueError('maxlen must be non-negative');
    this.#items = [];
    for (const x of iterate(iterable)) this.append(x);
  }

  #trim(fromLeft: boolean): void {
    while (this.maxlen !== null && this.#items.length > this.maxlen) {
      if (fromLeft) this.#items.shift();
      else this.#items.pop();
    }
  }

  append(x: unknown): void { this.#items.push(x); this.#trim(true); }
  appendleft(x: unknown): void { this.#items.unshift(x); this.#trim(false); }
  extend(xs: unknown): void { for (const x of [...iterate(xs)]) this.append(x); }
  extendleft(xs: unknown): void { for (const x of [...iterate(xs)]) this.appendleft(x); }

  pop(): unknown {
    if (this.#items.length === 0) throw new IndexError('pop from an empty deque');
    return this.#items.pop();
  }

  popleft(): unknown {
    if (this.#items.length === 0) throw new IndexError('pop from an empty deque');
    return this.#items.shift();
  }

  clear(): void { this.#items.length = 0; }
  count(x: unknown): number { return this.#items.filter((v) => v === x || eq(v, x)).length; }

  rotate(n: unknown = 1): void {
    const k = intArg(n);
    const len = this.#items.length;
    if (len === 0) return;
    const r = ((k % len) + len) % len;
    this.#items.unshift(...this.#items.splice(len - r, r));
  }

  __len__(): number { return this.#items.length; }
  [Symbol.iterator](): Iterator<unknown> { return this.#items[Symbol.iterator](); }
  __iter__(): Iterator<unknown> { return this[Symbol.iterator](); }
  __contains__(x: unknown): boolean { return this.#items.some((v) => v === x || eq(v, x)); }
  __getitem__(i: unknown): unknown {
    return getitem(this.#items, i);
  }
  __setitem__(i: unknown, v: unknown): void { setitem(this.#items, i, v); }
  __eq__(o: unknown): unknown { return o instanceof Deque ? eq(this.#items, [...o]) : NotImplemented; }

  __repr__(): string {
    const items = `[${this.#items.map((x) => repr(x)).join(', ')}]`;
    return this.maxlen === null ? `deque(${items})` : `deque(${items}, maxlen=${this.maxlen})`;
  }
}
Object.defineProperty(Deque, 'name', { value: 'deque' });

export class Counter extends PyDict {
  constructor(...args: unknown[]) {
    super();
    this.update(...args);
  }

  __missing__(): number { return 0; }

  override update(...args: unknown[]): void {
    const { positional, keywords } = splitArgs(args);
    if (positional.length > 1) throw typeError(`expected at most 1 argument, got ${positional.length}`);
    const source = positional[0];
    if (source instanceof PyDict) {
      for (const e of [...source.entries()]) this.__setitem__(e.key, addCount(this.get(e.key, 0), e.value));
    } else if (source !== undefined && source !== null) {
      for (const x of iterate(source)) this.__setitem__(x, addCount(this.get(x, 0), 1));
    }
    for (const [k, v] of Object.entries(keywords)) this.__setitem__(k, addCount(this.get(k, 0), v));
  }

  most_common(n: unknown = null): readonly unknown[][] {
    const items = [...this.entries()].map((e) => Object.freeze([e.key, e.value]));
    const sortedItems = sortItems(items, (p: unknown) => (p as unknown[])[1], true) as unknown[][];
    return n === null || n === undefined ? sortedItems : sortedItems.slice(0, Math.max(0, intArg(n)));
  }

  total(): unknown {
    let t: unknown = 0;
    for (const e of this.entries()) t = addCount(t, e.value);
    return t;
  }

  elements(): unknown[] {
    const out: unknown[] = [];
    for (const e of this.entries()) for (let i = 0; i < (e.value as number); i++) out.push(e.key);
    return out;
  }

  override __repr__(): string {
    if (this.__len__() === 0) return 'Counter()';
    return `Counter({${this.most_common().map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(', ')}})`;
  }
}

function addCount(a: unknown, b: unknown): unknown {
  return typeof a === 'number' && typeof b === 'number' ? a + b : addValues(a, b);
}
export class DefaultDict extends PyDict {
  readonly default_factory: unknown;

  constructor(factory: unknown = null, ...rest: unknown[]) {
    super();
    if (factory !== null && factory !== undefined && typeof factory !== 'function') {
      throw typeError('first argument must be callable or None');
    }
    this.default_factory = factory;
    this.update(...rest);
  }

  __missing__(key: unknown): unknown {
    if (this.default_factory === null || this.default_factory === undefined) throw new KeyError(key);
    const value = call(this.default_factory);
    this.__setitem__(key, value);
    return value;
  }

  override __repr__(): string {
    return `defaultdict(${repr(this.default_factory)}, ${super.__repr__()})`;
  }
}
Object.defineProperty(DefaultDict, 'name', { value: 'defaultdict' });

export const collections = Object.freeze({ deque: Deque, Counter, defaultdict: DefaultDict });

