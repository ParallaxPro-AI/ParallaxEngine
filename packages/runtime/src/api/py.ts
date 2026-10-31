/**
 * The few Python semantics the api layer itself needs when it calls game code: the
 * truthiness of what a `when=` / `where=` lambda returns, reading a dict game code passed,
 * and string hashing for value handles. Compiled code gets the full set from `pyrt`.
 */

import { fail } from '../core/index.js';
import { PyDict } from './pyrt/collections.js';

/** Python `bool(value)`. */
export function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === 'object') {
    const object = value as { __bool__?: () => unknown; __len__?: () => unknown };
    if (typeof object.__bool__ === 'function') return object.__bool__() === true;
    if (typeof object.__len__ === 'function') return object.__len__() !== 0;
  }
  return true;
}

/** A stable 32-bit hash of a string (FNV-1a over UTF-16 code units). */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The `str`-keyed entries of a dict game code passed (a pyrt `PyDict`; a plain object from
 * TypeScript callers). `where` names the argument in errors.
 */
export function dictEntries(value: unknown, where: string): [string, unknown][] {
  if (value instanceof PyDict) {
    return [...value.entries()].map(({ key, value: v }) => {
      if (typeof key !== 'string') fail('PP3004', `${where} keys must be str, got ${String(key)}`);
      return [key, v];
    });
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value);
  }
  return fail('PP3004', `${where} must be a dict, got ${String(value)}`, { fix: 'Pass a dict literal: {"name": value}.' });
}
