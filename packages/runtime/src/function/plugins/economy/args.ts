/**
 * Python call arguments for economy's component methods and `ctx.economy`, and readers for
 * the values game code and content hold. Compiled code passes keyword arguments as one
 * trailing api `Kwargs` (an object carrying `values`); plugins can't import the api, so a
 * trailing plain object or an object carrying `values` is taken as the keywords.
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
  return fail('PP7100', `${where} must be a finite number, got ${describe(value)}`);
}

export function nonNegative(value: unknown, where: string): number {
  const n = finite(value, where);
  if (n < 0) fail('PP7100', `${where} can't be negative (${n})`);
  return n;
}

export function count(value: unknown, where: string): number {
  const n = finite(value, where);
  if (!Number.isInteger(n) || n < 0) fail('PP7100', `${where} must be a whole number of at least 0, got ${n}`);
  return n;
}

export function text(value: unknown, where: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return fail('PP7100', `${where} must be a non-empty string, got ${describe(value)}`);
}

/** The id of a ContentRef / PrefabRef / Tag (an object with `id` or `__tag_id__`), or a bare id string. */
export function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const o = value as { id?: unknown; __tag_id__?: unknown };
    if (typeof o.__tag_id__ === 'string') return o.__tag_id__;
    if (typeof o.id === 'string') return o.id;
  }
  return null;
}

/** A content entry of `kind` (a ContentRef, or its id): its id. */
export function contentId(value: unknown, kind: string, where: string): string {
  const id = idOf(value);
  const k = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
  if (id === null || (k !== undefined && k !== kind)) {
    fail('PP7101', `${where} must be ${kind} content (Content.${kind}.<id>), got ${describe(value)}`, {
      fix: `Add content/${kind}/<id>.json and pass Content.${kind}.<id>.`,
    });
  }
  return id;
}

export function entityId(handles: EntityHandles, value: unknown, where: string): EntityId {
  const id = handles.unwrap(value);
  if (id === undefined) fail('PP7102', `${where} must be an Entity, got ${describe(value)}`);
  return id;
}

export function optionalEntity(handles: EntityHandles, value: unknown, where: string): EntityId | null {
  if (value === undefined || value === null) return null;
  return entityId(handles, value, where);
}

/** A point or direction: Vec3 as is, Vec2 → (x, y, 0). */
export function point(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (value instanceof Vec2) return new Vec3(value.x, value.y, 0);
  return fail('PP7100', `${where} must be a Vec3 or Vec2, got ${describe(value)}`);
}

/** A plain object view of a dict field or argument (pyrt dicts give theirs through `toJSON`). */
export function dictOf<T>(value: unknown): Readonly<Record<string, T>> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && Object.getPrototypeOf(value) !== Object.prototype && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return (value as { toJSON(): Record<string, T> }).toJSON();
  }
  return value as Readonly<Record<string, T>>;
}

/** A list field or argument as an array (pyrt lists are arrays; tuples and iterables are spread). */
export function listOf<T>(value: unknown): readonly T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'object' && Symbol.iterator in value) return [...(value as Iterable<T>)];
  return [];
}

/** A named attribute of a content entry's data or a record (decoded objects and plain JSON alike). */
export function attr(data: unknown, name: string): unknown {
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as Record<string, unknown>)[name];
}

export function num(data: unknown, name: string, fallback: number): number {
  const v = attr(data, name);
  return typeof v === 'number' ? v : fallback;
}
