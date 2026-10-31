/**
 * Python call arguments for combat's component methods and `ctx.combat`, and the checks
 * on what game code passes. Compiled code passes keyword arguments as one trailing api
 * `Kwargs` value (`f(a, kw({ b: 1 }))`); plugins can't import the api layer, so a
 * trailing plain object, or an object carrying `values`, is taken as the keywords.
 * Unknown, duplicated and missing arguments are errors, as in CPython.
 */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityHandles } from '../../kernel/index.js';

export type Args = Readonly<Record<string, unknown>>;

function keywordsOf(last: unknown): Args | undefined {
  if (typeof last !== 'object' || last === null || Array.isArray(last)) return undefined;
  if (last instanceof Vec2 || last instanceof Vec3) return undefined;
  if (Object.getPrototypeOf(last) === Object.prototype) return last as Args;
  const values = (last as { values?: unknown }).values;
  if (typeof values === 'object' && values !== null && !Array.isArray(values)) return values as Args;
  return undefined;
}

/** Bind `args` to `positional` names (also passable by name), then keyword-only names. */
export function bind(name: string, args: readonly unknown[], positional: readonly string[], keyword: readonly string[] = [],
  required: readonly string[] = []): Args {
  const keywords = keywordsOf(args[args.length - 1]);
  const given = keywords === undefined ? args : args.slice(0, -1);
  if (given.length > positional.length) {
    fail('PP3030', `${name}() takes ${positional.length} positional argument${positional.length === 1 ? '' : 's'} but ${given.length} were given`, {
      fix: keyword.length > 0 ? `Pass ${keyword.join(', ')} by name.` : 'Remove the extra arguments.',
    });
  }
  const bound: Record<string, unknown> = {};
  given.forEach((value, i) => { bound[positional[i]!] = value; });
  const known = [...positional, ...keyword];
  for (const [key, value] of Object.entries(keywords ?? {})) {
    if (!known.includes(key)) {
      fail('PP3030', `${name}() got an unexpected keyword argument "${key}"`, { fix: `Accepted: ${known.join(', ') || '(none)'}.` });
    }
    if (key in bound) fail('PP3030', `${name}() got multiple values for argument "${key}"`);
    bound[key] = value;
  }
  for (const param of required) {
    if (bound[param] === undefined) fail('PP3030', `${name}() is missing the required argument "${param}"`);
  }
  return bound;
}

export function describe(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  if (typeof value === 'function') return value.name || 'function';
  return JSON.stringify(value);
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3900', `${where} must be a finite number, got ${describe(value)}`);
}

export function nonNegative(value: unknown, where: string): number {
  const n = finite(value, where);
  if (n < 0) fail('PP3900', `${where} is ${n}; it can't be negative`);
  return n;
}

export function positive(value: unknown, where: string): number {
  const n = finite(value, where);
  if (!(n > 0)) fail('PP3900', `${where} is ${n}; it must be greater than 0`);
  return n;
}

export function bool(value: unknown, where: string): boolean {
  if (typeof value === 'boolean') return value;
  return fail('PP3900', `${where} must be True or False, got ${describe(value)}`);
}

export function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return fail('PP3900', `${where} must be a str, got ${describe(value)}`);
}

/** A tag's id: game code passes `Tag` handles (`__tag_id__`); data and the kernel hold ids. */
export function tagId(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  const id = typeof value === 'object' && value !== null ? (value as { __tag_id__?: unknown }).__tag_id__ : undefined;
  if (typeof id === 'string') return id;
  return fail('PP3004', `${where} takes a Tag, got ${describe(value)}`, { fix: 'Pass a tag declared with tag("id").' });
}

/** An optional Tag argument (`kind=`), checked and kept as given (modifiers compare it). */
export function optionalTag(value: unknown, where: string): unknown {
  if (value === undefined || value === null) return null;
  tagId(value, where);
  return value;
}

/** An entity argument (`source=`), checked and kept as the game-facing handle; None → null. */
export function optionalEntity(handles: EntityHandles, value: unknown, where: string): unknown {
  if (value === undefined || value === null) return null;
  if (handles.unwrap(value) === undefined) fail('PP3901', `${where} must be an Entity or None, got ${describe(value)}`);
  return value;
}

export function entityId(handles: EntityHandles, value: unknown, where: string): EntityId {
  const id = handles.unwrap(value);
  if (id === undefined) fail('PP3901', `${where} must be an Entity, got ${describe(value)}`);
  return id;
}

/** A point argument (`point=`, `center`): a Vec3 or Vec2, or None. */
export function optionalPoint(value: unknown, where: string): Vec3 | Vec2 | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Vec3 || value instanceof Vec2) return value;
  return fail('PP3900', `${where} must be a Vec3 or Vec2, got ${describe(value)}`);
}
