/** Conversions between the SDK's value types and Rapier's plain `{x, y, z}`, and argument helpers. */

import { fail, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityHandles } from '../../kernel/index.js';

export interface XYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface XYZW extends XYZ {
  readonly w: number;
}

export function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

/** A Vec3 argument. A Vec2 in a 3D world is an error with the fix, never a guessed plane. */
export function vec3(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) {
    if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) return value;
    return fail('PP3153', `${where} must be finite, got ${value.toString()}`);
  }
  if (value instanceof Vec2) {
    return fail('PP3153', `${where} is a Vec2, but physics3d is 3D`, {
      fix: 'Pass a Vec3: vec3(x, y, z) (for a stick, ctx.camera.main.relative(stick)).',
    });
  }
  return fail('PP3153', `${where} must be a Vec3, got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3153', `${where} must be a finite number, got ${describe(value)}`);
}

export function toVec3(v: XYZ): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}

export function toQuat(q: XYZW): Quat {
  return new Quat(q.x, q.y, q.z, q.w);
}

/** A game-facing entity handle (or id) as its id. */
export function entityId(handles: EntityHandles, handle: unknown, where: string): EntityId {
  const id = handles.unwrap(handle);
  if (id === undefined) fail('PP3153', `${where} must be an entity, got ${describe(handle)}`);
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

/** Positional-or-keyword argument `i` named `name`. */
export function arg(p: readonly unknown[], k: Readonly<Record<string, unknown>>, i: number, name: string): unknown {
  return p[i] ?? k[name];
}
