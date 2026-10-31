/**
 * Python call arguments. Compiled code passes keyword arguments as one trailing `Kwargs`
 * value — `f(a, b=1)` → `f(a, kw({ b: 1 }))` — and every api function binds its
 * arguments the way CPython does: positional parameters in order, keyword-only ones by
 * name, and an unknown, duplicated or missing argument is a coded error, never silently
 * ignored. It lives in core so
 * the value types (Vec3.from_yaw_pitch, Quat.look_rotation…) bind them too.
 */

import { fail } from './diagnostics.js';
import { closestMatch } from './suggest.js';

export class Kwargs {
  readonly values: Readonly<Record<string, unknown>>;

  constructor(values: Readonly<Record<string, unknown>>) {
    this.values = values;
  }
}

/** `f(x=1)` → `f(kw({ x: 1 }))`. */
export function kw(values: Readonly<Record<string, unknown>>): Kwargs {
  return new Kwargs(values);
}

export interface Signature {
  /** Parameters that may be passed by position (in order) or by name. */
  readonly positional?: readonly string[];
  /** Keyword-only parameters (after `*` in the Python signature). */
  readonly keyword?: readonly string[];
  /** Parameters without a default. */
  readonly required?: readonly string[];
  /** Extra positional arguments are collected (`*args`) instead of rejected. */
  readonly rest?: boolean;
  /** Extra keyword arguments are collected (`**kwargs`) instead of rejected. */
  readonly restKeywords?: boolean;
}

export interface Bound {
  /** Every argument given, by parameter name. Absent parameters are absent keys. */
  readonly args: Record<string, unknown>;
  readonly rest: unknown[];
  readonly restKeywords: Record<string, unknown>;
}

/** Split compiled call arguments into positional values and the keyword object. */
export function splitArgs(args: readonly unknown[]): { positional: unknown[]; keywords: Readonly<Record<string, unknown>> } {
  const last = args[args.length - 1];
  if (last instanceof Kwargs) return { positional: args.slice(0, -1), keywords: last.values };
  return { positional: [...args], keywords: {} };
}

/** Bind `args` to `signature` exactly as CPython would, or fail with PP3030. */
export function bindArgs(name: string, args: readonly unknown[], signature: Signature): Bound {
  const { positional, keywords } = splitArgs(args);
  const names = signature.positional ?? [];
  const keywordOnly = signature.keyword ?? [];
  const bound: Record<string, unknown> = {};
  const rest: unknown[] = [];
  const restKeywords: Record<string, unknown> = {};

  positional.forEach((value, i) => {
    const param = names[i];
    if (param !== undefined) bound[param] = value;
    else if (signature.rest === true) rest.push(value);
    else {
      fail('PP3030', `${name}() takes ${names.length} positional argument${names.length === 1 ? '' : 's'} but ${positional.length} were given`, {
        fix: keywordOnly.length > 0 ? `Pass ${keywordOnly.join(', ')} by name.` : 'Remove the extra arguments.',
      });
    }
  });

  const known = [...names, ...keywordOnly];
  for (const [key, value] of Object.entries(keywords)) {
    if (!known.includes(key)) {
      if (signature.restKeywords === true) { restKeywords[key] = value; continue; }
      const guess = closestMatch(key, known);
      fail('PP3030', `${name}() got an unexpected keyword argument "${key}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Accepted: ${known.join(', ') || '(none)'}.`,
      });
    }
    if (key in bound) fail('PP3030', `${name}() got multiple values for argument "${key}"`);
    bound[key] = value;
  }

  for (const param of signature.required ?? []) {
    if (!(param in bound)) fail('PP3030', `${name}() is missing the required argument "${param}"`);
  }
  return { args: bound, rest, restKeywords };
}
