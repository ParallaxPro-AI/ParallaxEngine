/**
 * Python's exception hierarchy. Every exception is a JS `Error` (so stacks work), with
 * Python's `args`, `__str__`/`__repr__` and `__cause__`. Engine errors (`ParallaxError`)
 * and JS runtime errors stay catchable: `except Exception` matches them, and
 * `exception_of` turns a JS `TypeError`/`RangeError` into its Python counterpart.
 */

import { repr, str } from './values.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Python values are untyped */

export class BaseException extends Error {
  declare args: readonly unknown[];
  declare __cause__: unknown;

  constructor(...args: unknown[]) {
    super();
    this.args = Object.freeze([...args]);
    this.__cause__ = null;
    (this as any).__init__(...args);
  }

  __init__(...args: unknown[]): void {
    this.args = Object.freeze([...args]);
  }

  __str__(): string {
    if (this.args.length === 0) return '';
    if (this.args.length === 1) return str(this.args[0]);
    return repr(this.args);
  }

  __repr__(): string {
    const inner = this.args.length === 1 ? repr(this.args[0]) : this.args.map((a) => repr(a)).join(', ');
    return `${this.constructor.name}(${inner})`;
  }
}

// Error's `message`/`name` follow Python's str() and class name (stack traces read them).
Object.defineProperties(BaseException.prototype, {
  message: { get(this: BaseException) { return str(this); }, configurable: true },
  name: { get(this: BaseException) { return this.constructor.name; }, configurable: true },
});

export class Exception extends BaseException {}
export class ArithmeticError extends Exception {}
export class ZeroDivisionError extends ArithmeticError {}
export class OverflowError extends ArithmeticError {}
export class AssertionError extends Exception {}
export class AttributeError extends Exception {}
export class LookupError extends Exception {}
export class IndexError extends LookupError {}
export class KeyError extends LookupError {
  override __str__(): string {
    return this.args.length === 1 ? repr(this.args[0]) : super.__str__();
  }
}
export class NameError extends Exception {}
export class RuntimeError extends Exception {}
export class NotImplementedError extends RuntimeError {}
export class RecursionError extends RuntimeError {}
export class StopIteration extends Exception {}
class PyTypeError extends Exception {}
class PyValueError extends Exception {}
Object.defineProperty(PyTypeError, 'name', { value: 'TypeError' });
Object.defineProperty(PyValueError, 'name', { value: 'ValueError' });
export { PyTypeError as TypeError, PyValueError as ValueError };

/** Convenience constructors for runtime code. */
export const typeError = (message: string): PyTypeError => new PyTypeError(message);
export const valueError = (message: string): PyValueError => new PyValueError(message);

/** A caught value as a Python exception (JS runtime errors become their counterpart). */
export function exception_of(error: unknown): unknown {
  if (error instanceof BaseException) return error;
  if (error instanceof globalThis.TypeError) return withCause(new PyTypeError(error.message), error);
  if (error instanceof globalThis.RangeError && /call stack/i.test(error.message)) {
    return withCause(new RecursionError('maximum recursion depth exceeded'), error);
  }
  if (error instanceof Error) return error; // engine errors: matched by `except Exception`
  return withCause(new RuntimeError(String(error)), error);
}

function withCause(exc: BaseException, cause: unknown): BaseException {
  exc.__cause__ = cause;
  return exc;
}

function isExceptionClass(value: unknown): value is new (...args: unknown[]) => BaseException {
  return typeof value === 'function' && (value === BaseException || value.prototype instanceof BaseException);
}

/** `except T:` — T is an exception class or a tuple of them. */
export function exception_matches(error: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((t) => exception_matches(error, t));
  if (!isExceptionClass(type)) throw new PyTypeError('catching classes that do not inherit from BaseException is not allowed');
  if (error instanceof type) return true;
  return !(error instanceof BaseException) && (type === Exception || type === BaseException);
}

/** `raise X` / `raise X(...)`: the exception instance to throw. */
export function raise_(value: unknown): BaseException {
  if (value instanceof BaseException) return value;
  if (isExceptionClass(value)) return new value();
  return new PyTypeError('exceptions must derive from BaseException');
}

export function raise_from(value: unknown, cause: unknown): BaseException {
  const exc = raise_(value);
  exc.__cause__ = cause === null || cause === undefined ? null : raise_(cause);
  return exc;
}

export function assertion_error(...message: unknown[]): AssertionError {
  return new AssertionError(...message);
}
