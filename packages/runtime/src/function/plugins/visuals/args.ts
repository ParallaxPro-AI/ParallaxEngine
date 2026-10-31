/**
 * Python call arguments for component methods, and the checks on what game code passes.
 * Compiled code passes keyword arguments as one trailing api `Kwargs` value
 * (`f(a, kw({ b: 1 }))`); plugins can't import the api layer, so a trailing plain object,
 * or an object carrying `values`, is taken as the keywords. TypeScript callers pass a
 * plain object. Unknown, duplicated and missing arguments are errors, as in CPython.
 */

import { Color, fail, Vec2, Vec3 } from '../../../core/index.js';

export type Args = Readonly<Record<string, unknown>>;

function keywordsOf(last: unknown): Args | undefined {
  if (typeof last !== 'object' || last === null || Array.isArray(last)) return undefined;
  if (last instanceof Vec2 || last instanceof Vec3 || last instanceof Color) return undefined;
  if (Object.getPrototypeOf(last) === Object.prototype) return last as Args;
  const values = (last as { values?: unknown }).values;
  if (typeof values === 'object' && values !== null && !Array.isArray(values)) return values as Args;
  return undefined;
}

/**
 * Bind `args` to a Python signature: `positional` names in order (also passable by name),
 * then keyword-only `keyword` names. Returns every given argument by name.
 */
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
  if (value === null || value === undefined) return value === null ? 'None' : 'nothing';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3700', `${where} must be a finite number, got ${describe(value)}`);
}

export function nonNegative(value: unknown, where: string): number {
  const n = finite(value, where);
  if (n < 0) fail('PP3700', `${where} is ${n}; it can't be negative`);
  return n;
}

export function bool(value: unknown, where: string): boolean {
  if (typeof value === 'boolean') return value;
  return fail('PP3700', `${where} must be True or False, got ${describe(value)}`);
}

export function vec2(value: unknown, where: string): Vec2 {
  if (value instanceof Vec2) return value;
  return fail('PP3700', `${where} must be a Vec2, got ${describe(value)}`, { fix: 'Pass vec2(x, y).' });
}

export function vec3(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (value instanceof Vec2) return new Vec3(value.x, value.y, 0);
  return fail('PP3700', `${where} must be a Vec3 (or a Vec2 in 2D), got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

/**
 * The stored form of a reference field: a string as authored, or the api's reference
 * object (`Assets.images.x`, `Clips.run`) through its `toJSON`.
 */
export function storedRef(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  const toJSON = typeof value === 'object' && value !== null ? (value as { toJSON?: unknown }).toJSON : undefined;
  if (typeof toJSON === 'function') {
    const form = (toJSON as () => unknown).call(value);
    if (typeof form === 'string') return form;
  }
  return fail('PP3700', `${where} must be an asset or clip reference, got ${describe(value)}`);
}
