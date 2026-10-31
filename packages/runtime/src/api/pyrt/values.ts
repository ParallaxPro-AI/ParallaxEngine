/**
 * Python value semantics over JS representations:
 *
 *   None → null (undefined is read as None too)   bool → boolean   int, float → number
 *   str → string (indexed by code point)          list → Array      tuple → frozen Array
 *   dict → PyDict   set → PySet   frozenset → PyFrozenSet   range → PyRange
 *
 * One JS number type carries both int and float, so an integral float prints as an int
 * (`3`, not `3.0`) unless the transpiler knew statically it was a float (`str_float`).
 * Ints are exact up to 2**53.
 */

import { PyDict, PySet } from './collections.js';
import { OverflowError, StopIteration, typeError, ValueError, ZeroDivisionError } from './errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;

/** Python's `NotImplemented` singleton (returned by binary dunders; core value types return it too). */
import { NotImplemented } from '../../core/index.js';
export { NotImplemented };
export const Ellipsis: object = Object.freeze({ __repr__: () => 'Ellipsis' });

/** Builtin type objects (`int`, `list`, …) are functions tagged with their Python name. */
export const PY_TYPE = Symbol('pyrt.type');

export function isTuple(x: unknown): x is readonly unknown[] {
  return Array.isArray(x) && Object.isFrozen(x);
}

export function isList(x: unknown): x is unknown[] {
  return Array.isArray(x) && !Object.isFrozen(x);
}

export function isNone(x: unknown): x is null | undefined {
  return x === null || x === undefined;
}

/** The Python type name of a value, for error messages. */
/** `Symbol.toStringTag`s that are Python type names (pyrt containers), not JS built-ins'. */
const PYTHON_TAGS = /^(dict|set|frozenset|dict_keys|dict_values|dict_items)$/;

export function typeName(x: unknown): string {
  if (isNone(x)) return 'NoneType';
  switch (typeof x) {
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(x) ? 'int' : 'float';
    case 'string': return 'str';
    case 'function': {
      const f = x as Any;
      if (f[PY_TYPE] !== undefined || isClassLike(f)) return 'type';
      return 'function';
    }
    default: break;
  }
  if (Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype) return Object.isFrozen(x) ? 'tuple' : 'list';
  // pyrt's containers name their Python type (PyDict → dict, DictView → dict_keys).
  const tag = (x as Any)[Symbol.toStringTag];
  if (typeof tag === 'string' && PYTHON_TAGS.test(tag)) return tag;
  const ctor = (x as Any).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'object';
}

function isClassLike(f: Any): boolean {
  const d = Object.getOwnPropertyDescriptor(f, 'prototype');
  return d !== undefined && d.writable === false;
}

// ── Truthiness ────────────────────────────────────────────────────────────────

export function truthy(x: unknown): boolean {
  if (x === true) return true;
  if (x === false || x === null || x === undefined) return false;
  switch (typeof x) {
    case 'number': return x !== 0;
    case 'string': return x.length > 0;
    case 'function': return true;
    default: break;
  }
  if (Array.isArray(x)) return x.length > 0;
  const o = x as Any;
  if (typeof o.__bool__ === 'function') {
    const r = o.__bool__();
    if (typeof r !== 'boolean') throw typeError(`__bool__ should return bool, returned ${typeName(r)}`);
    return r;
  }
  if (typeof o.__len__ === 'function') return lenOf(o.__len__()) !== 0;
  return true;
}

function lenOf(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n)) throw typeError(`'${typeName(n)}' object cannot be interpreted as an integer`);
  if (n < 0) throw typeError('__len__() should return >= 0');
  return n;
}

// ── str / repr ────────────────────────────────────────────────────────────────

const reprStack = new Set<unknown>();

export function str(x: unknown): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return numberStr(x);
  if (x !== null && typeof x === 'object' && typeof (x as Any).__str__ === 'function') {
    const r = (x as Any).__str__();
    if (typeof r !== 'string') throw typeError(`__str__ returned non-string (type ${typeName(r)})`);
    return r;
  }
  return repr(x);
}

export function repr(x: unknown): string {
  if (x === null || x === undefined) return 'None';
  if (x === true) return 'True';
  if (x === false) return 'False';
  if (typeof x === 'number') return numberStr(x);
  if (typeof x === 'string') return strRepr(x);
  if (typeof x === 'function') {
    const f = x as Any;
    if (f[PY_TYPE] !== undefined) return `<class '${f[PY_TYPE]}'>`;
    if (isClassLike(f)) return `<class '${f.__qualname__ ?? f.name}'>`;
    return `<function ${f.__qualname__ ?? (f.name || '<lambda>')}>`;
  }
  const o = x as Any;
  if (typeof o.__repr__ === 'function') {
    const r = o.__repr__();
    if (typeof r !== 'string') throw typeError(`__repr__ returned non-string (type ${typeName(r)})`);
    return r;
  }
  if (Array.isArray(x)) {
    if (reprStack.has(x)) return Object.isFrozen(x) ? '(...)' : '[...]';
    reprStack.add(x);
    try {
      const items = x.map((v) => repr(v)).join(', ');
      if (!Object.isFrozen(x)) return `[${items}]`;
      return x.length === 1 ? `(${items},)` : `(${items})`;
    } finally {
      reprStack.delete(x);
    }
  }
  const ctor = o.constructor;
  const name = typeof ctor === 'function' ? (ctor.__qualname__ ?? ctor.name) : 'object';
  return `<${name} object>`;
}

/** Recursion guard for container reprs (dict, set). */
export function guardedRepr(container: unknown, empty: string, body: () => string): string {
  if (reprStack.has(container)) return empty;
  reprStack.add(container);
  try {
    return body();
  } finally {
    reprStack.delete(container);
  }
}

const PRINTABLE_EXCLUDED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python `repr(str)`: single quotes unless the text has ' and no ". */
export function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === ' ' || (code >= 0x20 && code < 0x7f)) out += ch;
    else if (code < 0x7f || (code < 0xa1 && code >= 0x7f) || PRINTABLE_EXCLUDED.test(ch)) {
      if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + quote;
}

/** A number whose int/float kind is unknown: integral values print as ints. */
export function numberStr(x: number): string {
  if (Number.isInteger(x)) return Math.abs(x) < 1e21 ? String(x) : BigInt(x).toString();
  return floatRepr(x);
}

/** Python `repr(float)`: shortest round-trip digits, CPython's layout. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, expText] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '');
  const exp = Number(expText);
  const decpt = exp + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const rest = digits.slice(1);
  const e = Math.abs(exp).toString().padStart(2, '0');
  return `${sign}${digits[0]}${rest ? `.${rest}` : ''}e${exp < 0 ? '-' : '+'}${e}`;
}

/** `str(x)` where the transpiler knows x is a float. */
export function str_float(x: unknown): string {
  return typeof x === 'number' ? floatRepr(x) : str(x);
}

export function repr_float(x: unknown): string {
  return typeof x === 'number' ? floatRepr(x) : repr(x);
}

// ── Equality and hashing ──────────────────────────────────────────────────────

export const BOUND_SELF = Symbol('pyrt.boundSelf');
export const BOUND_FUNC = Symbol('pyrt.boundFunc');

export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNone(a) || isNone(b)) {
    if (isNone(a) && isNone(b)) return true;
    return dunderEq(a, b);
  }
  const ta = typeof a;
  const tb = typeof b;
  if ((ta === 'number' || ta === 'boolean') && (tb === 'number' || tb === 'boolean')) return +(a as number) === +(b as number);
  if (ta === 'string' || tb === 'string') return ta === tb ? a === b : dunderEq(a, b);
  if (Array.isArray(a) && Array.isArray(b) && !hasOwnEq(a) && !hasOwnEq(b)) {
    if (Object.isFrozen(a) !== Object.isFrozen(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !eq(a[i], b[i])) return false;
    return true;
  }
  if (ta === 'function' && tb === 'function') {
    const fa = a as Any;
    const fb = b as Any;
    return fa[BOUND_FUNC] !== undefined && fa[BOUND_FUNC] === fb[BOUND_FUNC] && fa[BOUND_SELF] === fb[BOUND_SELF];
  }
  return dunderEq(a, b);
}

function hasOwnEq(a: unknown[]): boolean {
  return Object.getPrototypeOf(a) !== Array.prototype && typeof (a as Any).__eq__ === 'function';
}

function dunderEq(a: unknown, b: unknown): boolean {
  const fa = a !== null && a !== undefined ? (a as Any).__eq__ : undefined;
  if (typeof fa === 'function') {
    const r = fa.call(a, b);
    if (r !== NotImplemented) return truthy(r);
  }
  const fb = b !== null && b !== undefined ? (b as Any).__eq__ : undefined;
  if (typeof fb === 'function') {
    const r = fb.call(b, a);
    if (r !== NotImplemented) return truthy(r);
  }
  return a === b;
}

export function ne(a: unknown, b: unknown): boolean {
  if (a !== null && a !== undefined && typeof (a as Any).__ne__ === 'function') {
    const r = (a as Any).__ne__(b);
    if (r !== NotImplemented) return truthy(r);
  }
  return !eq(a, b);
}

/** A string key for hashing a string (FNV-1a). */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h | 0;
}

const identityHashes = new WeakMap<object, number>();
let nextIdentity = 1;

export function hash(x: unknown): number {
  if (isNone(x)) return 0x5f3759df;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'number') {
    if (Number.isInteger(x)) return Math.abs(x) < 2 ** 31 ? x : hashString(String(x));
    return hashString(floatRepr(x));
  }
  if (typeof x === 'string') return hashString(x);
  if (Array.isArray(x)) {
    if (!Object.isFrozen(x) && !hasOwnHash(x)) throw typeError("unhashable type: 'list'");
    if (hasOwnHash(x)) return callHash(x);
    let h = 0x345678;
    for (const item of x) h = Math.imul(h ^ hash(item), 1000003) | 0;
    return h ^ x.length;
  }
  const o = x as Any;
  if (typeof x === 'object' && '__hash__' in o) return callHash(o);
  if (x instanceof PyDict || x instanceof PySet) throw typeError(`unhashable type: '${typeName(x)}'`);
  let id = identityHashes.get(o as object);
  if (id === undefined) {
    id = nextIdentity++;
    identityHashes.set(o as object, id);
  }
  return id;
}

function hasOwnHash(a: unknown[]): boolean {
  return Object.getPrototypeOf(a) !== Array.prototype && '__hash__' in (a as Any);
}

function callHash(o: Any): number {
  if (typeof o.__hash__ !== 'function') throw typeError(`unhashable type: '${typeName(o)}'`);
  const h = o.__hash__();
  if (typeof h !== 'number' || !Number.isInteger(h)) throw typeError('__hash__ method should return an integer');
  return h;
}

// ── Ordering ──────────────────────────────────────────────────────────────────

const SURROGATE = /[\uD800-\uDFFF]/;

function compareStrings(a: string, b: string): number {
  if (!SURROGATE.test(a) && !SURROGATE.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const ca = Array.from(a);
  const cb = Array.from(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = ca[i]!.codePointAt(0)! - cb[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return ca.length - cb.length;
}

type Op = 'lt' | 'le' | 'gt' | 'ge';
const SYMBOL: Record<Op, string> = { lt: '<', le: '<=', gt: '>', ge: '>=' };
const REFLECT: Record<Op, Op> = { lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' };

function order(op: Op, a: unknown, b: unknown): boolean {
  const ta = typeof a;
  const tb = typeof b;
  if ((ta === 'number' || ta === 'boolean') && (tb === 'number' || tb === 'boolean')) {
    const x = +(a as number);
    const y = +(b as number);
    return op === 'lt' ? x < y : op === 'le' ? x <= y : op === 'gt' ? x > y : x >= y;
  }
  if (ta === 'string' && tb === 'string') {
    const c = compareStrings(a as string, b as string);
    return op === 'lt' ? c < 0 : op === 'le' ? c <= 0 : op === 'gt' ? c > 0 : c >= 0;
  }
  if (Array.isArray(a) && Array.isArray(b) && Object.isFrozen(a) === Object.isFrozen(b)
      && !hasOwnEq(a) && !hasOwnEq(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i] || eq(a[i], b[i])) continue;
      if (op === 'lt' || op === 'le') return order('lt', a[i], b[i]);
      return order('gt', a[i], b[i]);
    }
    const x = a.length;
    const y = b.length;
    return op === 'lt' ? x < y : op === 'le' ? x <= y : op === 'gt' ? x > y : x >= y;
  }
  const fa = a !== null && a !== undefined ? (a as Any)[`__${op}__`] : undefined;
  if (typeof fa === 'function') {
    const r = fa.call(a, b);
    if (r !== NotImplemented) return truthy(r);
  }
  const reflected = REFLECT[op];
  const fb = b !== null && b !== undefined ? (b as Any)[`__${reflected}__`] : undefined;
  if (typeof fb === 'function') {
    const r = fb.call(b, a);
    if (r !== NotImplemented) return truthy(r);
  }
  throw typeError(`'${SYMBOL[op]}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

export const lt = (a: unknown, b: unknown): boolean => order('lt', a, b);
export const le = (a: unknown, b: unknown): boolean => order('le', a, b);
export const gt = (a: unknown, b: unknown): boolean => order('gt', a, b);
export const ge = (a: unknown, b: unknown): boolean => order('ge', a, b);

// ── Arithmetic ────────────────────────────────────────────────────────────────

function isNum(x: unknown): x is number | boolean {
  return typeof x === 'number' || typeof x === 'boolean';
}

function isInt(x: unknown): boolean {
  return typeof x === 'boolean' || (typeof x === 'number' && Number.isInteger(x));
}

/**
 * Set by an in-place operator just before it falls back to the binary one, so the binary
 * one's error names the augmented symbol (`|=`), as CPython does. The binary operator
 * takes it on entry, so nothing a dunder runs sees it.
 */
let augmented = false;

function binaryDunder(name: string, symbol: string, a: unknown, b: unknown): unknown {
  const aug = augmented;
  augmented = false;
  const fa = a !== null && a !== undefined ? (a as Any)[`__${name}__`] : undefined;
  if (typeof fa === 'function') {
    const r = fa.call(a, b);
    if (r !== NotImplemented) return r;
  }
  const fb = b !== null && b !== undefined ? (b as Any)[`__r${name}__`] : undefined;
  if (typeof fb === 'function') {
    const r = fb.call(b, a);
    if (r !== NotImplemented) return r;
  }
  throw typeError(`unsupported operand type(s) for ${symbol}${aug ? '=' : ''}: '${typeName(a)}' and '${typeName(b)}'`);
}

function concatError(a: unknown, b: unknown): never {
  throw typeError(`can only concatenate ${typeName(a)} (not "${typeName(b)}") to ${typeName(a)}`);
}

export function add(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'string') {
    if (typeof b === 'string') return a + b;
    if (b === null || b === undefined || typeof b !== 'object' || typeof (b as Any).__radd__ !== 'function') concatError(a, b);
  }
  if (isNum(a) && isNum(b)) return +a + +b;
  if (Array.isArray(a) && Object.getPrototypeOf(a) === Array.prototype) {
    if (Array.isArray(b) && Object.isFrozen(a) === Object.isFrozen(b)) {
      const out = [...a, ...b];
      return Object.isFrozen(a) ? Object.freeze(out) : out;
    }
    if (!(b !== null && typeof b === 'object' && typeof (b as Any).__radd__ === 'function')) concatError(a, b);
  }
  return binaryDunder('add', '+', a, b);
}

export function sub(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (isNum(a) && isNum(b)) return +a - +b;
  return binaryDunder('sub', '-', a, b);
}

function repeat(seq: unknown, n: unknown): unknown {
  if (!isInt(n)) throw typeError(`can't multiply sequence by non-int of type '${typeName(n)}'`);
  const count = Math.max(0, +(n as number));
  if (typeof seq === 'string') return seq.repeat(count);
  const arr = seq as unknown[];
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(...arr);
  return Object.isFrozen(arr) ? Object.freeze(out) : out;
}

function isSeq(x: unknown): boolean {
  return typeof x === 'string' || (Array.isArray(x) && Object.getPrototypeOf(x) === Array.prototype);
}

export function mul(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  if (isNum(a) && isNum(b)) return +a * +b;
  if (isSeq(a) && isNum(b)) return repeat(a, b);
  if (isSeq(b) && isNum(a)) return repeat(b, a);
  if (isSeq(a) && !(b !== null && typeof b === 'object' && typeof (b as Any).__rmul__ === 'function')) {
    throw typeError(`can't multiply sequence by non-int of type '${typeName(b)}'`);
  }
  return binaryDunder('mul', '*', a, b);
}

export function truediv(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) {
    if (+b === 0) throw new ZeroDivisionError('division by zero');
    return +a / +b;
  }
  return binaryDunder('truediv', '/', a, b);
}

/** CPython's float_divmod (exact for integral inputs within 2**53). */
function divmodNumbers(a: number, b: number): [number, number] {
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0) {
    if ((b < 0) !== (mod < 0)) {
      mod += b;
      div -= 1;
    }
  } else {
    mod = b < 0 ? -0 : 0;
  }
  let floordiv: number;
  if (div !== 0) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else {
    floordiv = a / b < 0 ? -0 : 0;
  }
  return [floordiv, mod];
}

/** CPython 3.14 reports every int and float `//`, `%` and divmod by zero alike. */
function checkDivisor(b: unknown): void {
  if (+(b as number) === 0) throw new ZeroDivisionError('division by zero');
}

export function floordiv(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) {
    checkDivisor(b);
    const r = divmodNumbers(+a, +b)[0];
    return isInt(a) && isInt(b) ? r + 0 : r;
  }
  return binaryDunder('floordiv', '//', a, b);
}

export function mod(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) {
    checkDivisor(b);
    const r = divmodNumbers(+a, +b)[1];
    return isInt(a) && isInt(b) ? r + 0 : r;
  }
  if (typeof a === 'string') throw typeError("printf-style '%' formatting is not supported in Parallax Python; use an f-string");
  return binaryDunder('mod', '%', a, b);
}

export function divmod(a: unknown, b: unknown): readonly unknown[] {
  if (isNum(a) && isNum(b)) {
    checkDivisor(b);
    const [q, r] = divmodNumbers(+a, +b);
    return Object.freeze(isInt(a) && isInt(b) ? [q + 0, r + 0] : [q, r]);
  }
  return binaryDunder('divmod', 'divmod()', a, b) as readonly unknown[];
}

export function pow(a: unknown, b: unknown, m?: unknown): unknown {
  if (m !== undefined && m !== null) {
    if (!isInt(a) || !isInt(b) || !isInt(m)) throw typeError('pow() 3rd argument not allowed unless all arguments are integers');
    if (+m === 0) throw new ValueError('pow() 3rd argument cannot be 0');
    if (+(b as number) < 0) throw new ValueError('pow() negative exponent requires a modular inverse (not supported)');
    const r = BigInt(+(a as number)) ** BigInt(+(b as number)) % BigInt(+m);
    const n = Number(r);
    return n !== 0 && (n < 0) !== (+m < 0) ? n + +m : n;
  }
  if (isNum(a) && isNum(b)) {
    const x = +a;
    const y = +b;
    if (x === 0 && y < 0) {
      throw new ZeroDivisionError(isInt(a) && isInt(b) ? 'zero to a negative power' : 'zero to a negative power');
    }
    if (x < 0 && !Number.isInteger(y)) {
      throw new ValueError('Parallax Python has no complex numbers: a negative base to a fractional power');
    }
    if (isInt(a) && isInt(b) && y >= 0) {
      const r = x ** y;
      if (!Number.isSafeInteger(r)) {
        const exact = BigInt(x) ** BigInt(y);
        if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < -BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new OverflowError('integer result exceeds the exact int range (2**53) of Parallax Python');
        }
        return Number(exact);
      }
      return r;
    }
    const r = x ** y;
    if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) throw new OverflowError('(34, \'Numerical result out of range\')');
    return r;
  }
  return binaryDunder('pow', '** or pow()', a, b);
}

function toBig(a: unknown, symbol: string, b: unknown): [bigint, bigint] | null {
  if (isInt(a) && isInt(b)) return [BigInt(+(a as number)), BigInt(+(b as number))];
  if (isNum(a) && isNum(b)) throw typeError(`unsupported operand type(s) for ${symbol}: '${typeName(a)}' and '${typeName(b)}'`);
  return null;
}

function fromBig(x: bigint): number {
  if (x > BigInt(Number.MAX_SAFE_INTEGER) || x < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OverflowError('integer result exceeds the exact int range (2**53) of Parallax Python');
  }
  return Number(x);
}

function bitwise(name: string, symbol: string, a: unknown, b: unknown, f: (x: bigint, y: bigint) => bigint): unknown {
  if (typeof a === 'boolean' && typeof b === 'boolean' && (name === 'and' || name === 'or' || name === 'xor')) {
    return Boolean(f(BigInt(+a), BigInt(+b)));
  }
  const big = toBig(a, symbol, b);
  if (big !== null) return fromBig(f(big[0], big[1]));
  return binaryDunder(name, symbol, a, b);
}

export const and_ = (a: unknown, b: unknown): unknown => bitwise('and', '&', a, b, (x, y) => x & y);
export const or_ = (a: unknown, b: unknown): unknown => bitwise('or', '|', a, b, (x, y) => x | y);
export const xor = (a: unknown, b: unknown): unknown => bitwise('xor', '^', a, b, (x, y) => x ^ y);
export function lshift(a: unknown, b: unknown): unknown {
  return bitwise('lshift', '<<', a, b, (x, y) => {
    if (y < 0n) throw new ValueError('negative shift count');
    return x << y;
  });
}
export function rshift(a: unknown, b: unknown): unknown {
  return bitwise('rshift', '>>', a, b, (x, y) => {
    if (y < 0n) throw new ValueError('negative shift count');
    return x >> y;
  });
}
export const matmul = (a: unknown, b: unknown): unknown => binaryDunder('matmul', '@', a, b);

function unary(name: string, symbol: string, x: unknown): unknown {
  const f = x !== null && x !== undefined ? (x as Any)[`__${name}__`] : undefined;
  if (typeof f === 'function') return f.call(x);
  throw typeError(`bad operand type for unary ${symbol}: '${typeName(x)}'`);
}

export function neg(x: unknown): unknown {
  if (isNum(x)) return -(+x);
  return unary('neg', '-', x);
}

export function pos(x: unknown): unknown {
  if (isNum(x)) return +x;
  return unary('pos', '+', x);
}

export function invert(x: unknown): unknown {
  if (isInt(x)) return fromBig(~BigInt(+(x as number)));
  return unary('invert', '~', x);
}

// ── In-place operators: `x op= y` ─────────────────────────────────────────────

function inplace(name: string, fallback: (a: unknown, b: unknown) => unknown): (a: unknown, b: unknown) => unknown {
  return (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return fallback(a, b);
    const f = a !== null && a !== undefined && typeof a === 'object' ? (a as Any)[`__i${name}__`] : undefined;
    if (typeof f === 'function') {
      const r = f.call(a, b);
      if (r !== NotImplemented) return r;
    }
    augmented = true;
    try {
      return fallback(a, b);
    } finally {
      augmented = false;
    }
  };
}

export function iadd(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (isList(a) && Object.getPrototypeOf(a) === Array.prototype) {
    for (const item of iterate(b)) a.push(item);
    return a;
  }
  return inplace('add', add)(a, b);
}

export function imul(a: unknown, b: unknown): unknown {
  if (isList(a) && Object.getPrototypeOf(a) === Array.prototype && isNum(b)) {
    if (!isInt(b)) throw typeError(`can't multiply sequence by non-int of type '${typeName(b)}'`);
    const items = [...a];
    a.length = 0;
    for (let i = 0; i < +b; i++) a.push(...items);
    return a;
  }
  return inplace('mul', mul)(a, b);
}

export const isub = inplace('sub', sub);
export const itruediv = inplace('truediv', truediv);
export const ifloordiv = inplace('floordiv', floordiv);
export const imod = inplace('mod', mod);
export const ipow = inplace('pow', (a, b) => pow(a, b));
export const ilshift = inplace('lshift', lshift);
export const irshift = inplace('rshift', rshift);
export const iand = inplace('and', and_);
export const ior = inplace('or', or_);
export const ixor = inplace('xor', xor);
export const imatmul = inplace('matmul', matmul);

// ── Iteration ─────────────────────────────────────────────────────────────────

/** What `for x in v` iterates (a JS iterable). */
export function iterate(x: unknown): Iterable<unknown> {
  if (Array.isArray(x) || typeof x === 'string') return x;
  if (x !== null && x !== undefined) {
    const o = x as Any;
    if (typeof o === 'function' && o.__members__ !== undefined && typeof o.__members__ === 'object') {
      return Object.values(o.__members__);
    }
    if (typeof o[Symbol.iterator] === 'function') return o;
    if (typeof o.__iter__ === 'function') {
      const it = o.__iter__();
      if (it !== null && typeof it === 'object' && Symbol.iterator in it) return it;
      if (it !== null && typeof it === 'object' && typeof it.__next__ === 'function') return fromPyIterator(it);
      throw typeError(`iter() returned non-iterator of type '${typeName(it)}'`);
    }
    if (typeof o.__getitem__ === 'function' && typeof o.__len__ === 'function') return sequenceIterator(o);
  }
  throw typeError(`'${typeName(x)}' object is not iterable`);
}

function* fromPyIterator(it: Any): Generator<unknown> {
  for (;;) {
    let v: unknown;
    try {
      v = it.__next__();
    } catch (e) {
      if (e instanceof StopIteration) return;
      throw e;
    }
    yield v;
  }
}

function* sequenceIterator(o: Any): Generator<unknown> {
  const n = o.__len__();
  for (let i = 0; i < n; i++) yield o.__getitem__(i);
}
