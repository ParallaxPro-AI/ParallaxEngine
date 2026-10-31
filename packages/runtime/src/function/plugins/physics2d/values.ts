/** Small conversions between the SDK's value types and Rapier's plain `{x, y}`. */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityHandles } from '../../kernel/index.js';

export interface XY {
  readonly x: number;
  readonly y: number;
}

/** A Vec2 or Vec3 argument as its x/y (2D physics ignores z). */
export function xy(value: unknown, where: string): XY {
  if (value instanceof Vec2 || value instanceof Vec3) return { x: value.x, y: value.y };
  return fail('PP3300', `${where} must be a Vec2 or Vec3, got ${describe(value)}`, {
    fix: 'Pass vec2(x, y) or vec3(x, y, z).',
  });
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3300', `${where} must be a finite number, got ${describe(value)}`);
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

/** A game-facing entity handle (or id) as its id. */
export function entityId(handles: EntityHandles, handle: unknown, where: string): EntityId {
  const id = handles.unwrap(handle);
  if (id === undefined) fail('PP3301', `${where} must be an entity`);
  return id;
}

/**
 * Python keyword arguments. Compiled code passes them as one trailing api `Kwargs` value
 * (`f(a, kw({ b: 1 }))`); TypeScript callers pass a plain object. Plugins can't import
 * the api layer, so a trailing plain object or an object carrying `values` is taken as
 * the keywords. Unknown names are an error, as in CPython.
 */
export function splitKeywords(args: readonly unknown[], name: string, allowed: readonly string[]): {
  positional: unknown[];
  keywords: Readonly<Record<string, unknown>>;
} {
  const last = args[args.length - 1];
  let keywords: Readonly<Record<string, unknown>> | undefined;
  if (typeof last === 'object' && last !== null && !(last instanceof Vec2) && !(last instanceof Vec3) && !Array.isArray(last)) {
    const values = (last as { values?: unknown }).values;
    if (Object.getPrototypeOf(last) === Object.prototype) keywords = last as Record<string, unknown>;
    else if (typeof values === 'object' && values !== null) keywords = values as Record<string, unknown>;
  }
  if (keywords === undefined) return { positional: [...args], keywords: {} };
  for (const key of Object.keys(keywords)) {
    if (!allowed.includes(key)) {
      fail('PP3030', `${name}() got an unexpected keyword argument "${key}"`, { fix: `Accepted: ${allowed.join(', ') || '(none)'}.` });
    }
  }
  return { positional: args.slice(0, -1), keywords };
}
