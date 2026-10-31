/**
 * Functions, classes and attributes with Python semantics.
 *
 * Calling convention (shared with the api layer, `api/kwargs.ts`): keyword arguments are
 * ONE trailing `Kwargs` value, `f(a, b=1)` → `f(a, kw({ b: 1 }))`. A compiled `def` binds
 * its arguments with `bind(sig, arguments)` — CPython's rules and TypeError messages —
 * after a fast path for exactly its positional parameters.
 *
 * Attribute reads that are values (`f = self.on_hit`) go through `attr`, which binds
 * methods (Python's bound methods), raises AttributeError for a missing name and never
 * returns a JavaScript builtin (`"".length`, `x.toString`) as a Python attribute.
 */

import { Kwargs } from '../kwargs.js';
import { PyDict, SPLAT } from './collections.js';
import { AttributeError, typeError } from './errors.js';
import { BOUND_FUNC, BOUND_SELF, typeName } from './values.js';
import { pythonMethod } from './methods.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */
type Any = any;

// ── Signatures and argument binding ───────────────────────────────────────────

/** Marks a keyword-only parameter without a default. */
export const NO_DEFAULT = Symbol('pyrt.noDefault');

export interface Sig {
  readonly name: string;
  readonly params: readonly string[];
  readonly posonly: number;
  readonly defaults: readonly unknown[];
  readonly kwonly: readonly string[];
  readonly kwdefaults: readonly unknown[];
  readonly vararg: string | null;
  readonly kwarg: string | null;
  /** A method: CPython counts `self` in its messages. */
  readonly method: boolean;
}

export function sig(
  name: string, params: readonly string[], posonly: number, defaults: readonly unknown[], kwonly: readonly string[],
  kwdefaults: readonly unknown[], vararg: string | null, kwarg: string | null, method: boolean,
): Sig {
  return { name, params, posonly, defaults, kwonly, kwdefaults, vararg, kwarg, method };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameList(names: string[]): string {
  const quoted = names.map((n) => `'${n}'`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
}

/** Bind call arguments to `s` as CPython does; values in JS-parameter order. */
export function bind(s: Sig, args: ArrayLike<unknown>): unknown[] {
  let n = args.length;
  let keywords: Readonly<Record<string, unknown>> | null = null;
  const last = n > 0 ? args[n - 1] : undefined;
  if (last instanceof Kwargs) {
    keywords = last.values;
    n--;
  }
  const P = s.params.length;
  const values: unknown[] = new Array(P);
  const filled: boolean[] = new Array(P).fill(false);
  for (let i = 0; i < Math.min(n, P); i++) {
    values[i] = args[i];
    filled[i] = true;
  }
  let rest: unknown[] = [];
  if (n > P) {
    if (s.vararg === null) {
      const m = s.method ? 1 : 0;
      const required = P - s.defaults.length;
      const takes = s.defaults.length > 0 ? `from ${required + m} to ${P + m} positional arguments` : plural(P + m, 'positional argument');
      throw typeError(`${s.name}() takes ${takes} but ${n + m} ${n + m === 1 ? 'was' : 'were'} given`);
    }
    rest = Array.prototype.slice.call(args, P, n);
  }
  const kwValues: unknown[] = s.kwonly.map(() => NO_DEFAULT);
  const extra = s.kwarg !== null ? new PyDict() : null;
  if (keywords !== null) {
    for (const key of Object.keys(keywords)) {
      const value = keywords[key];
      const i = s.params.indexOf(key);
      if (i >= s.posonly) {
        if (filled[i]) throw typeError(`${s.name}() got multiple values for argument '${key}'`);
        values[i] = value;
        filled[i] = true;
        continue;
      }
      const k = s.kwonly.indexOf(key);
      if (k >= 0) {
        kwValues[k] = value;
        continue;
      }
      if (extra !== null) {
        extra.__setitem__(key, value);
        continue;
      }
      if (i >= 0) throw typeError(`${s.name}() got some positional-only arguments passed as keyword arguments: '${key}'`);
      throw typeError(`${s.name}() got an unexpected keyword argument '${key}'`);
    }
  }
  const firstDefault = P - s.defaults.length;
  const missing: string[] = [];
  for (let i = 0; i < P; i++) {
    if (filled[i]) continue;
    if (i >= firstDefault) values[i] = s.defaults[i - firstDefault];
    else missing.push(s.params[i]!);
  }
  if (missing.length > 0) {
    throw typeError(`${s.name}() missing ${plural(missing.length, 'required positional argument')}: ${nameList(missing)}`);
  }
  const missingKw: string[] = [];
  s.kwonly.forEach((name, k) => {
    if (kwValues[k] !== NO_DEFAULT) return;
    if (s.kwdefaults[k] !== NO_DEFAULT) kwValues[k] = s.kwdefaults[k];
    else missingKw.push(name);
  });
  if (missingKw.length > 0) {
    throw typeError(`${s.name}() missing ${plural(missingKw.length, 'required keyword-only argument')}: ${nameList(missingKw)}`);
  }
  return [...values, ...(s.vararg !== null ? [Object.freeze(rest)] : []), ...kwValues, ...(extra !== null ? [extra] : [])];
}

/** `f(**a, k=v, **b)`: a flat list [key, value | SPLAT, mapping, …] → one Kwargs. */
export function kw_merge(flat: unknown[]): Kwargs {
  const values: Record<string, unknown> = {};
  const put = (key: unknown, value: unknown): void => {
    if (typeof key !== 'string') throw typeError('keywords must be strings');
    if (Object.hasOwn(values, key)) throw typeError(`got multiple values for keyword argument '${key}'`);
    values[key] = value;
  };
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] !== SPLAT) {
      put(flat[i], flat[i + 1]);
      continue;
    }
    const m = flat[i + 1];
    if (!(m instanceof PyDict)) throw typeError(`argument after ** must be a mapping, not ${typeName(m)}`);
    for (const e of [...m.entries()]) put(e.key, e.value);
  }
  return new Kwargs(values);
}

// ── Calls ─────────────────────────────────────────────────────────────────────

const classes = new WeakMap<object, boolean>();

/** A JS class (constructed with `new`), as opposed to a plain function. */
export function isClass(f: unknown): boolean {
  if (typeof f !== 'function') return false;
  let known = classes.get(f);
  if (known === undefined) {
    const d = Object.getOwnPropertyDescriptor(f, 'prototype');
    known = d !== undefined && d.writable === false;
    classes.set(f, known);
  }
  return known;
}

/** `f(...)` where f isn't statically known to be a plain function. */
export function call(f: unknown, ...args: unknown[]): unknown {
  if (typeof f === 'function') {
    if (isClass(f)) return new (f as new (...a: unknown[]) => unknown)(...args);
    return (f as (...a: unknown[]) => unknown)(...args);
  }
  if (f !== null && f !== undefined && typeof (f as Any).__call__ === 'function') return (f as Any).__call__(...args);
  throw typeError(`'${typeName(f)}' object is not callable`);
}

function isBuiltinValue(o: unknown): boolean {
  const t = typeof o;
  return t === 'string' || t === 'number' || t === 'boolean' || (Array.isArray(o) && Object.getPrototypeOf(o) === Array.prototype);
}

function noAttribute(o: unknown, name: string): never {
  if (o === null || o === undefined) throw new AttributeError(`'NoneType' object has no attribute '${name}'`);
  if (typeof o === 'function' && isClass(o)) {
    throw new AttributeError(`type object '${(o as Any).__qualname__ ?? (o as Any).name}' has no attribute '${name}'`);
  }
  throw new AttributeError(`'${typeName(o)}' object has no attribute '${name}'`);
}

/** A JS builtin member that Python can't see: Object/Function prototype members. */
function isJsBuiltinMember(o: unknown, name: string, value: unknown): boolean {
  if (value === (Object.prototype as Any)[name]) return true;
  if (typeof o === 'function') {
    if (value === (Function.prototype as Any)[name]) return true;
    if (name === 'name' || name === 'length') {
      const d = Object.getOwnPropertyDescriptor(o, name);
      return d !== undefined && d.writable === false && d.enumerable === false;
    }
  }
  return false;
}

/** `obj.Name(...)` / `obj.toString(...)`: a member call that must be checked. */
export function callm(o: unknown, name: string, ...args: unknown[]): unknown {
  if (o === null || o === undefined || isBuiltinValue(o)) {
    const method = pythonMethod(o, name);
    if (method === undefined) noAttribute(o, name);
    return method(...args);
  }
  const value = (o as Any)[name];
  if (value === undefined && !(name in (o as object))) noAttribute(o, name);
  if (isJsBuiltinMember(o, name, value)) noAttribute(o, name);
  if (typeof value !== 'function') throw typeError(`'${typeName(value)}' object is not callable`);
  if (isClass(value)) return new (value as new (...a: unknown[]) => unknown)(...args);
  return (value as (...a: unknown[]) => unknown).apply(o, args);
}

function bindMethod(o: unknown, f: (...a: unknown[]) => unknown): unknown {
  const bound = f.bind(o) as Any;
  bound[BOUND_SELF] = o;
  bound[BOUND_FUNC] = f;
  return bound;
}

/** `obj.name` as a value. */
export function attr(o: unknown, name: string): unknown {
  if (o === null || o === undefined || isBuiltinValue(o)) {
    const method = pythonMethod(o, name);
    if (method === undefined) noAttribute(o, name);
    return method;
  }
  let value = (o as Any)[name];
  if (value === undefined) {
    if (name in (o as object)) return value;
    // A class attribute assigned after the class body (`cls.x = 1` in a decorator).
    value = classAttribute(o, name);
    if (value === undefined) noAttribute(o, name);
  }
  if (isJsBuiltinMember(o, name, value)) noAttribute(o, name);
  if (typeof value === 'function' && typeof o !== 'function' && !Object.hasOwn(o as object, name) && !isClass(value)) {
    return bindMethod(o, value as (...a: unknown[]) => unknown);
  }
  return value;
}

function classAttribute(o: unknown, name: string): unknown {
  if (typeof o !== 'object') return undefined;
  for (let c = (o as Any).constructor; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const d = Object.getOwnPropertyDescriptor(c, name);
    if (d !== undefined && d.enumerable === true) return d.get !== undefined ? d.get.call(c) : d.value;
  }
  return undefined;
}

/** `getattr(obj, "name"[, default])` — the transpiler only allows literal names. */
export function getattr(o: unknown, name: unknown, ...fallback: unknown[]): unknown {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  try {
    return attr(o, name);
  } catch (e) {
    if (e instanceof AttributeError && fallback.length > 0) return fallback[0];
    throw e;
  }
}

export function hasattr(o: unknown, name: unknown): boolean {
  try {
    getattr(o, name);
    return true;
  } catch (e) {
    if (e instanceof AttributeError) return false;
    throw e;
  }
}

export function setattr(o: unknown, name: unknown, value: unknown): null {
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  if (o === null || o === undefined || isBuiltinValue(o)) {
    throw new AttributeError(`'${typeName(o)}' object has no attribute '${name}' and no __dict__ for setting new attributes`);
  }
  (o as Any)[name] = value;
  return null;
}

export function delattr(o: unknown, name: string): void {
  if (o === null || o === undefined || isBuiltinValue(o) || !(name in (o as object))) noAttribute(o, name);
  if (!Object.hasOwn(o as object, name)) noAttribute(o, name);
  delete (o as Any)[name];
}

// ── Classes ───────────────────────────────────────────────────────────────────

/** `object`: the base of compiled classes. `X(...)` runs `__init__` (Python's protocol). */
export class PyObject {
  constructor(...args: unknown[]) {
    (this as Any).__init__(...args);
  }

  __init__(...args: unknown[]): void {
    if (args.length > 0 && !(args.length === 1 && args[0] instanceof Kwargs && Object.keys(args[0].values).length === 0)) {
      const cls = this.constructor as Any;
      throw typeError(`${cls.__qualname__ ?? cls.name}() takes no arguments`);
    }
  }
}
Object.defineProperty(PyObject, 'name', { value: 'object' });

/** A class attribute (`speed = 3` in a class body): on the class, and readable from
 * instances until an instance sets its own (Python's class-attribute lookup). */
export function class_attr(cls: Any, name: string, value: unknown): void {
  Object.defineProperty(cls, name, { value, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(cls.prototype, name, {
    get(this: Any) { return this.constructor[name]; },
    set(this: Any, v: unknown) { Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true }); },
    enumerable: false,
    configurable: true,
  });
}

export function class_info(cls: Any, qualname: string): void {
  Object.defineProperty(cls, '__qualname__', { value: qualname, writable: true, enumerable: false, configurable: true });
}

/** A class that defines `__eq__` without `__hash__` is unhashable, as in Python. */
export function no_hash(cls: Any): void {
  Object.defineProperty(cls.prototype, '__hash__', { value: null, writable: true, enumerable: false, configurable: true });
}

/** Python calls the parent's `__init_subclass__` (an implicit classmethod) for each subclass. */
export function init_subclass(cls: Any): void {
  const parent = Object.getPrototypeOf(cls) as Any;
  const hook = parent?.__init_subclass__;
  if (typeof hook === 'function') hook.call(cls);
}

/** `@staticmethod`: also reachable from instances. */
export function static_method(cls: Any, name: string): void {
  Object.defineProperty(cls.prototype, name, { value: cls[name], writable: true, enumerable: false, configurable: true });
}

/** `@classmethod`: called on an instance, `cls` is its class. */
export function class_method(cls: Any, name: string): void {
  Object.defineProperty(cls.prototype, name, {
    value(this: Any, ...args: unknown[]) { return this.constructor[name](...args); },
    writable: true, enumerable: false, configurable: true,
  });
}

/** A decorated method: the decorator's result replaces it. */
export function set_method(cls: Any, name: string, value: unknown): void {
  Object.defineProperty(cls.prototype, name, { value, writable: true, enumerable: false, configurable: true });
}

const PYFN = Symbol('pyrt.pyfn');
const AS_PY = Symbol('pyrt.asPy');
const AS_THIS = Symbol('pyrt.asThis');

/** Mark a compiled `def`: it takes `self` as its first argument when used as a method. */
export function pyfn<T>(fn: T, signature?: () => Sig): T {
  Object.defineProperty(fn, PYFN, { value: true });
  // A `def`'s signature (a thunk: its const may be declared after the function), for engine
  // code that calls it by name (panel actions).
  if (signature !== undefined) Object.defineProperty(fn, '__sig__', { get: signature });
  return fn;
}

/** A `this`-style compiled method as a Python function taking `self` first. */
function asPy(method: Any): Any {
  if (method[AS_THIS] !== undefined) return method[AS_THIS];
  const fn = function (self: unknown, ...args: unknown[]) { return method.apply(self, args); };
  Object.defineProperty(fn, AS_PY, { value: method });
  return pyfn(fn);
}

/** A Python function placed on a class, called the JS way (`this` is self). */
function asThis(fn: Any): Any {
  if (fn[AS_PY] !== undefined) return fn[AS_PY];
  const method = function (this: unknown, ...args: unknown[]) { return fn(this, ...args); };
  Object.defineProperty(method, AS_THIS, { value: fn });
  return method;
}

/**
 * Apply method decorators (listed outermost first) the way Python does. Compiled
 * decorators (`def logged(fn)`) receive and return Python functions that take `self`
 * first; api decorators (`@on(Event)`) receive and return `this`-style methods. The
 * result is installed in the form the api and compiled callers use: `this`-style.
 */
export function decorate_method(cls: Any, name: string, decorators: readonly unknown[]): void {
  let value: Any = cls.prototype[name];
  let python = false;
  for (const deco of [...decorators].reverse()) {
    if (typeof deco === 'function' && (deco as Any)[PYFN] === true) {
      value = call(deco, python ? value : asPy(value));
      python = typeof value === 'function' && !isClass(value);
    } else {
      value = call(deco, python ? asThis(value) : value);
      python = false;
    }
  }
  set_method(cls, name, python ? asThis(value) : value);
}

/** `f.__annotations__` thunks for an annotated function's parameters (read by the api). */
export function fn_annotations<T>(fn: T, annotations: Record<string, () => unknown>): T {
  Object.defineProperty(fn, '__annotations__', { value: annotations, writable: true, enumerable: false, configurable: true });
  return fn;
}

// ── Tasks (async def → generator, await → yield) ─────────────────────────────

const ASYNC = Symbol('pyrt.async');

/** Mark an `async def` (a generator function): its calls make coroutines. */
export function mark_async<T>(fn: T): T {
  const proto = (fn as Any)?.prototype;
  if (proto !== undefined && proto !== null) Object.defineProperty(proto, ASYNC, { value: true });
  return fn;
}

export const async_fn = mark_async;

/** `await x`: run a coroutine (a compiled async def call) inline; yield anything else
 * (a kernel `Wait`) to the task scheduler and resume with what it sends back. */
export function* await_(x: unknown): Generator<unknown, unknown, unknown> {
  if (x !== null && typeof x === 'object' && (x as Any)[ASYNC] === true) return yield* (x as Generator<unknown, unknown, unknown>);
  return yield x;
}

export function isCoroutine(x: unknown): boolean {
  return x !== null && typeof x === 'object' && (x as Any)[ASYNC] === true;
}

