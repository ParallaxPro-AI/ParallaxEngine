/** Argument helpers: SDK values in, coded diagnostics out. */

import { fail, Vec2, Vec3 } from '../../../core/index.js';

export function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

export function vec3(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3 && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) return value;
  if (value instanceof Vec2) {
    return fail('PP7307', `${where} is a Vec2, but vehicles move in 3D`, { fix: 'Pass vec3(x, y, z).' });
  }
  return fail('PP7307', `${where} must be a Vec3, got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP7307', `${where} must be a finite number, got ${describe(value)}`);
}

/**
 * Python keyword arguments: one trailing api `Kwargs` (an object carrying `values`) from
 * compiled code, or a plain object from TypeScript. Unknown names are an error.
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
