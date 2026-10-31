/**
 * Methods of the builtin values that are JS primitives or arrays (str, list, tuple, int,
 * float). JS strings and arrays carry no Python methods, so a call `x.split()` compiles
 * to `M.split(x)`, which dispatches on the receiver: str/list/tuple get the Python
 * method; any other object gets its own `split`.
 */

import { AttributeError, IndexError, typeError, ValueError } from './errors.js';
import { bind, sig } from './objects.js';
import { eq, isNone, iterate, lt, typeName } from './values.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;
type Method = (self: Any, ...args: unknown[]) => unknown;

const SURROGATE = /[\uD800-\uDFFF]/;
const cps = (s: string): string[] => Array.from(s);
const cpLen = (s: string): number => (SURROGATE.test(s) ? Array.from(s).length : s.length);

// Python's str.isspace() characters.
const WS = '\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0                　';
const isWs = (ch: string): boolean => WS.includes(ch);
const LINE_BREAKS = '\n\r\v\f\x1c\x1d\x1e\x85  ';

function str(x: unknown, what: string): string {
  if (typeof x !== 'string') throw typeError(`${what} must be str, not ${typeName(x)}`);
  return x;
}

function int(x: unknown, what: string): number {
  if (typeof x === 'boolean') return +x;
  if (typeof x !== 'number' || !Number.isInteger(x)) throw typeError(`'${typeName(x)}' object cannot be interpreted as an integer${what ? '' : ''}`);
  return x;
}

/** Python's slice of a string by optional start/end, as code points, and its offset. */
function window(s: string, start: unknown, end: unknown): { text: string; offset: number; outside: boolean } {
  const chars = SURROGATE.test(s) ? cps(s) : null;
  const n = chars ? chars.length : s.length;
  let a = isNone(start) ? 0 : int(start, 'start');
  let b = isNone(end) ? n : int(end, 'end');
  if (a < 0) a = Math.max(0, a + n);
  if (b < 0) b = Math.max(0, b + n);
  b = Math.min(b, n);
  if (a > n) return { text: '', offset: a, outside: true };
  const text = a >= b ? '' : chars ? chars.slice(a, b).join('') : s.slice(a, b);
  return { text, offset: a, outside: false };
}

/** Code-point index of a UTF-16 index inside `s`. */
function cpIndex(s: string, unit: number): number {
  return SURROGATE.test(s) ? Array.from(s.slice(0, unit)).length : unit;
}

function find(s: string, sub: string, start: unknown, end: unknown, fromRight: boolean): number {
  const w = window(s, start, end);
  if (w.outside) return -1;
  const i = fromRight ? w.text.lastIndexOf(sub) : w.text.indexOf(sub);
  return i < 0 ? -1 : w.offset + cpIndex(w.text, i);
}

function caseOf(ch: string): 'upper' | 'lower' | 'title' | null {
  if (/\p{Lt}/u.test(ch)) return 'title';
  if (/\p{Uppercase}/u.test(ch)) return 'upper';
  if (/\p{Lowercase}/u.test(ch)) return 'lower';
  return null;
}

function splitWhitespace(s: string, maxsplit: number): string[] {
  const out: string[] = [];
  let i = 0;
  const chars = cps(s);
  while (i < chars.length) {
    while (i < chars.length && isWs(chars[i]!)) i++;
    if (i >= chars.length) break;
    if (maxsplit >= 0 && out.length === maxsplit) {
      out.push(chars.slice(i).join(''));
      return out;
    }
    let j = i;
    while (j < chars.length && !isWs(chars[j]!)) j++;
    out.push(chars.slice(i, j).join(''));
    i = j;
  }
  return out;
}

function stripChars(s: string, chars: unknown, left: boolean, right: boolean): string {
  const set = isNone(chars) ? null : str(chars, 'strip arg');
  const test = (ch: string): boolean => (set === null ? isWs(ch) : set.includes(ch));
  const c = cps(s);
  let a = 0;
  let b = c.length;
  if (left) while (a < b && test(c[a]!)) a++;
  if (right) while (b > a && test(c[b - 1]!)) b--;
  return c.slice(a, b).join('');
}

function fillChar(x: unknown): string {
  if (typeof x !== 'string' || cpLen(x) !== 1) throw typeError('The fill character must be exactly one character long');
  return x;
}

function anyPrefix(s: string, prefix: unknown, start: unknown, end: unknown, at: 'start' | 'end', name: string): boolean {
  const w = window(s, start, end);
  const options = Array.isArray(prefix) && Object.isFrozen(prefix) ? prefix : [prefix];
  return options.some((p) => {
    if (typeof p !== 'string') {
      throw typeError(`${name} first arg must be str or a tuple of str, not ${typeName(p)}`);
    }
    if (w.outside) return false;
    return at === 'start' ? w.text.startsWith(p) : w.text.endsWith(p);
  });
}

const S = {
  split: sig('str.split', ['sep', 'maxsplit'], 0, [null, -1], [], [], null, null, false),
  strip: sig('str.strip', ['chars'], 1, [null], [], [], null, null, false),
  range3: sig('str.find', ['sub', 'start', 'end'], 3, [null, null], [], [], null, null, false),
  just: sig('str.center', ['width', 'fillchar'], 2, [' '], [], [], null, null, false),
  replace: sig('str.replace', ['old', 'new', 'count'], 3, [-1], [], [], null, null, false),
  splitlines: sig('str.splitlines', ['keepends'], 0, [false], [], [], null, null, false),
  one: sig('str method', ['arg'], 1, [], [], [], null, null, false),
  none: sig('str method', [], 0, [], [], [], null, null, false),
  sort: sig('list.sort', [], 0, [], ['key', 'reverse'], [null, false], null, null, false),
  pop: sig('list.pop', ['index'], 1, [-1], [], [], null, null, false),
  insert: sig('list.insert', ['index', 'object'], 2, [], [], [], null, null, false),
  index: sig('list.index', ['value', 'start', 'stop'], 3, [0, null], [], [], null, null, false),
};

const STR: Record<string, Method> = {
  upper: (s, ...a) => (bind(S.none, a), s.toUpperCase()),
  lower: (s, ...a) => (bind(S.none, a), s.toLowerCase()),
  swapcase: (s, ...a) => (bind(S.none, a), cps(s).map((c) => {
    const k = caseOf(c);
    return k === 'upper' ? c.toLowerCase() : k === 'lower' ? c.toUpperCase() : c;
  }).join('')),
  capitalize: (s, ...a) => {
    bind(S.none, a);
    const c = cps(s);
    return c.length === 0 ? '' : c[0]!.toUpperCase() + c.slice(1).join('').toLowerCase();
  },
  title: (s, ...a) => {
    bind(S.none, a);
    let prevCased = false;
    let out = '';
    for (const c of s) {
      out += prevCased ? c.toLowerCase() : c.toUpperCase();
      prevCased = caseOf(c) !== null;
    }
    return out;
  },
  split: (s, ...a) => {
    const [sep, maxsplit] = bind(S.split, a);
    const max = int(maxsplit, 'maxsplit');
    if (isNone(sep)) return splitWhitespace(s, max);
    const sepStr = str(sep, 'sep');
    if (sepStr === '') throw new ValueError('empty separator');
    const parts = s.split(sepStr);
    if (max < 0 || parts.length <= max + 1) return parts;
    return [...parts.slice(0, max), parts.slice(max).join(sepStr)];
  },
  rsplit: (s, ...a) => {
    const [sep, maxsplit] = bind(S.split, a);
    const max = int(maxsplit, 'maxsplit');
    if (isNone(sep)) {
      if (max < 0) return splitWhitespace(s, -1);
      const reversed = splitWhitespace(cps(s).reverse().join(''), max);
      return reversed.map((p) => cps(p).reverse().join('')).reverse();
    }
    const sepStr = str(sep, 'sep');
    if (sepStr === '') throw new ValueError('empty separator');
    const parts = s.split(sepStr);
    if (max < 0 || parts.length <= max + 1) return parts;
    return [parts.slice(0, parts.length - max).join(sepStr), ...parts.slice(parts.length - max)];
  },
  splitlines: (s, ...a) => {
    const [keepends] = bind(S.splitlines, a);
    const out: string[] = [];
    let line = '';
    const chars = cps(s);
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (c === '\r' && chars[i + 1] === '\n') {
        out.push(keepends ? `${line}\r\n` : line);
        line = '';
        i++;
      } else if (LINE_BREAKS.includes(c)) {
        out.push(keepends ? line + c : line);
        line = '';
      } else line += c;
    }
    if (line !== '') out.push(line);
    return out;
  },
  join: (s, ...a) => {
    const [items] = bind(S.one, a);
    const parts: string[] = [];
    let i = 0;
    for (const item of iterate(items)) {
      if (typeof item !== 'string') throw typeError(`sequence item ${i}: expected str instance, ${typeName(item)} found`);
      parts.push(item);
      i++;
    }
    return parts.join(s);
  },
  strip: (s, ...a) => stripChars(s, bind(S.strip, a)[0], true, true),
  lstrip: (s, ...a) => stripChars(s, bind(S.strip, a)[0], true, false),
  rstrip: (s, ...a) => stripChars(s, bind(S.strip, a)[0], false, true),
  startswith: (s, ...a) => {
    const [p, start, end] = bind(S.range3, a);
    return anyPrefix(s, p, start, end, 'start', 'startswith');
  },
  endswith: (s, ...a) => {
    const [p, start, end] = bind(S.range3, a);
    return anyPrefix(s, p, start, end, 'end', 'endswith');
  },
  find: (s, ...a) => {
    const [sub, start, end] = bind(S.range3, a);
    return find(s, str(sub, 'must be str'), start, end, false);
  },
  rfind: (s, ...a) => {
    const [sub, start, end] = bind(S.range3, a);
    return find(s, str(sub, 'must be str'), start, end, true);
  },
  index: (s, ...a) => {
    const [sub, start, end] = bind(S.range3, a);
    const i = find(s, str(sub, 'must be str'), start, end, false);
    if (i < 0) throw new ValueError('substring not found');
    return i;
  },
  rindex: (s, ...a) => {
    const [sub, start, end] = bind(S.range3, a);
    const i = find(s, str(sub, 'must be str'), start, end, true);
    if (i < 0) throw new ValueError('substring not found');
    return i;
  },
  count: (s, ...a) => {
    const [sub, start, end] = bind(S.range3, a);
    const w = window(s, start, end);
    if (w.outside) return 0;
    const needle = str(sub, 'must be str');
    if (needle === '') return cpLen(w.text) + 1;
    return w.text.split(needle).length - 1;
  },
  replace: (s, ...a) => {
    const [oldArg, newArg, countArg] = bind(S.replace, a);
    const old = str(oldArg, 'replace() argument 1');
    const neu = str(newArg, 'replace() argument 2');
    let count = int(countArg, 'count');
    if (count < 0) count = Infinity;
    if (old === '') {
      const chars = cps(s);
      let out = '';
      let n = 0;
      for (let i = 0; i <= chars.length; i++) {
        if (n < count) {
          out += neu;
          n++;
        }
        if (i < chars.length) out += chars[i];
      }
      return out;
    }
    const parts = s.split(old);
    if (parts.length - 1 <= count) return parts.join(neu);
    return parts.slice(0, count + 1).join(neu) + old + parts.slice(count + 1).join(old);
  },
  center: (s, ...a) => {
    const [w, f] = bind(S.just, a);
    const width = int(w, 'width');
    const fill = fillChar(f);
    const n = cpLen(s);
    if (width <= n) return s;
    const marg = width - n;
    const left = Math.floor(marg / 2) + (marg & width & 1);
    return fill.repeat(left) + s + fill.repeat(marg - left);
  },
  ljust: (s, ...a) => {
    const [w, f] = bind(S.just, a);
    const width = int(w, 'width');
    return s + fillChar(f).repeat(Math.max(0, width - cpLen(s)));
  },
  rjust: (s, ...a) => {
    const [w, f] = bind(S.just, a);
    const width = int(w, 'width');
    return fillChar(f).repeat(Math.max(0, width - cpLen(s))) + s;
  },
  zfill: (s, ...a) => {
    const width = int(bind(S.one, a)[0], 'width');
    const n = cpLen(s);
    if (width <= n) return s;
    const sign = s[0] === '+' || s[0] === '-' ? s[0] : '';
    return sign + '0'.repeat(width - n) + s.slice(sign.length);
  },
  partition: (s, ...a) => {
    const sep = str(bind(S.one, a)[0], 'sep');
    if (sep === '') throw new ValueError('empty separator');
    const i = s.indexOf(sep);
    return Object.freeze(i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]);
  },
  rpartition: (s, ...a) => {
    const sep = str(bind(S.one, a)[0], 'sep');
    if (sep === '') throw new ValueError('empty separator');
    const i = s.lastIndexOf(sep);
    return Object.freeze(i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)]);
  },
  removeprefix: (s, ...a) => {
    const p = str(bind(S.one, a)[0], 'removeprefix() argument');
    return p !== '' && s.startsWith(p) ? s.slice(p.length) : s;
  },
  removesuffix: (s, ...a) => {
    const p = str(bind(S.one, a)[0], 'removesuffix() argument');
    return p !== '' && s.endsWith(p) ? s.slice(0, s.length - p.length) : s;
  },
  isalpha: (s, ...a) => (bind(S.none, a), /^\p{L}+$/u.test(s)),
  isdecimal: (s, ...a) => (bind(S.none, a), /^\p{Nd}+$/u.test(s)),
  isdigit: (s, ...a) => (bind(S.none, a), /^[\p{Nd}²³¹⁰⁴-⁹₀-₉①-⑨⑴-⑼⒈-⒐]+$/u.test(s)),
  isnumeric: (s, ...a) => (bind(S.none, a), /^\p{N}+$/u.test(s)),
  isalnum: (s, ...a) => (bind(S.none, a), /^[\p{L}\p{N}]+$/u.test(s)),
  isspace: (s, ...a) => (bind(S.none, a), s.length > 0 && cps(s).every(isWs)),
  isascii: (s, ...a) => (bind(S.none, a), /^[\x00-\x7f]*$/.test(s)),
  islower: (s, ...a) => {
    bind(S.none, a);
    const kinds = cps(s).map(caseOf);
    return kinds.includes('lower') && !kinds.includes('upper') && !kinds.includes('title');
  },
  isupper: (s, ...a) => {
    bind(S.none, a);
    const kinds = cps(s).map(caseOf);
    return kinds.includes('upper') && !kinds.includes('lower') && !kinds.includes('title');
  },
  istitle: (s, ...a) => {
    bind(S.none, a);
    let prevCased = false;
    let cased = false;
    for (const c of s) {
      const k = caseOf(c);
      if (k === 'upper' || k === 'title') {
        if (prevCased) return false;
        prevCased = true;
        cased = true;
      } else if (k === 'lower') {
        if (!prevCased) return false;
        prevCased = true;
        cased = true;
      } else prevCased = false;
    }
    return cased;
  },
};

// ── list / tuple ──────────────────────────────────────────────────────────────

/** Python's stable sort with key= and reverse= (comparisons use `<` only). */
export function sortItems(items: unknown[], key: unknown, reverse: unknown): unknown[] {
  const keys = isNone(key) ? items : items.map((x) => (key as (v: unknown) => unknown)(x));
  const order = items.map((_, i) => i);
  const rev = reverse === true || reverse === 1;
  order.sort((i, j) => {
    const a = keys[i];
    const b = keys[j];
    if (rev) return lt(b, a) ? -1 : lt(a, b) ? 1 : 0;
    return lt(a, b) ? -1 : lt(b, a) ? 1 : 0;
  });
  return order.map((i) => items[i]);
}

function indexOf(xs: readonly unknown[], args: unknown[], kind: string): number {
  const [value, start, stop] = bind(S.index, args);
  const n = xs.length;
  let a = int(start, 'start');
  let b = isNone(stop) ? n : int(stop, 'stop');
  if (a < 0) a = Math.max(0, a + n);
  if (b < 0) b = Math.max(0, b + n);
  for (let i = a; i < Math.min(b, n); i++) if (xs[i] === value || eq(xs[i], value)) return i;
  throw new ValueError(`${kind}.index(x): x not in ${kind}`);
}

function countOf(xs: readonly unknown[], args: unknown[]): number {
  const [value] = bind(S.one, args);
  let n = 0;
  for (const x of xs) if (x === value || eq(x, value)) n++;
  return n;
}

const LIST: Record<string, Method> = {
  append: (xs, ...a) => { xs.push(bind(S.one, a)[0]); return null; },
  extend: (xs, ...a) => {
    const items = [...iterate(bind(S.one, a)[0])];
    for (const x of items) xs.push(x);
    return null;
  },
  insert: (xs, ...a) => {
    const [i, x] = bind(S.insert, a);
    let at = int(i, 'index');
    if (at < 0) at = Math.max(0, at + xs.length);
    xs.splice(Math.min(at, xs.length), 0, x);
    return null;
  },
  remove: (xs, ...a) => {
    const [value] = bind(S.one, a);
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] === value || eq(xs[i], value)) {
        xs.splice(i, 1);
        return null;
      }
    }
    throw new ValueError('list.remove(x): x not in list');
  },
  pop: (xs, ...a) => {
    if (xs.length === 0) throw new IndexError('pop from empty list');
    let i = int(bind(S.pop, a)[0], 'index');
    if (i < 0) i += xs.length;
    if (i < 0 || i >= xs.length) throw new IndexError('pop index out of range');
    return xs.splice(i, 1)[0];
  },
  clear: (xs, ...a) => { bind(S.none, a); xs.length = 0; return null; },
  index: (xs, ...a) => indexOf(xs, a, 'list'),
  count: (xs, ...a) => countOf(xs, a),
  sort: (xs, ...a) => {
    const [key, reverse] = bind(S.sort, a);
    const sorted = sortItems([...xs], key, reverse);
    for (let i = 0; i < sorted.length; i++) xs[i] = sorted[i];
    return null;
  },
  reverse: (xs, ...a) => { bind(S.none, a); xs.reverse(); return null; },
  copy: (xs, ...a) => { bind(S.none, a); return [...xs]; },
};

const TUPLE: Record<string, Method> = {
  index: (xs, ...a) => indexOf(xs, a, 'tuple'),
  count: (xs, ...a) => countOf(xs, a),
};

const NUMBER: Record<string, Method> = {
  is_integer: (x, ...a) => (bind(S.none, a), Number.isInteger(x)),
  bit_length: (x, ...a) => (bind(S.none, a), x === 0 ? 0 : BigInt(Math.abs(int(x, ''))).toString(2).length),
};

function table(o: unknown): Record<string, Method> | null {
  if (typeof o === 'string') return STR;
  if (Array.isArray(o)) return Object.isFrozen(o) ? TUPLE : LIST;
  if (typeof o === 'number' || typeof o === 'boolean') return NUMBER;
  return null;
}

/** The Python method `name` of a builtin value, bound to it (undefined if it has none). */
export function pythonMethod(o: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  const t = table(o);
  const m = t !== null && Object.hasOwn(t, name) ? t[name] : undefined;
  return m === undefined ? undefined : (...args: unknown[]) => m(o, ...args);
}

function missing(o: unknown, name: string): never {
  throw new AttributeError(`'${typeName(o)}' object has no attribute '${name}'`);
}

function dispatcher(name: string): Method {
  return (o, ...args) => {
    const t = table(o);
    if (t !== null) {
      const m = Object.hasOwn(t, name) ? t[name] : undefined;
      if (m === undefined) missing(o, name);
      return m(o, ...args);
    }
    if (o === null || o === undefined) missing(o, name);
    const f = o[name];
    if (typeof f !== 'function') {
      if (f === undefined && !(name in o)) missing(o, name);
      throw typeError(`'${typeName(f)}' object is not callable`);
    }
    return f.apply(o, args);
  };
}

/** `x.name(...)` for the str/list method names: dispatched on the receiver. */
export const M: Record<string, Method> = Object.fromEntries(
  [...new Set([...Object.keys(STR), ...Object.keys(LIST)])].map((name) => [name, dispatcher(name)]),
);
