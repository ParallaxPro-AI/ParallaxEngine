/**
 * Panel state across the frame boundary of a scripted panel (`frame_host.ts`): the page
 * turns a panel's state into plain JSON (`wireState`), and the frame reads it back with
 * the game language's text and truthiness rules (`WIRE_VALUES`).
 *
 * JSON keeps what scripts and bindings need — str, int/float, bool, None, lists, dicts —
 * and every other value (a ContentRef, an enum member, a Vec2, a Color) travels as its
 * `str()` text, made by the page with the game's own rules. A number's text follows
 * Python's `str()` for floats and ints (the page's numbers are JavaScript numbers, as in
 * the game, so both sides read them alike).
 */

import type { UiValueRules } from '../../../core/index.js';

export type Wire = null | boolean | number | string | Wire[] | { [key: string]: Wire };

/** A game-language dict: `__getitem__` and iteration over its keys. */
interface DictLike {
  __getitem__(key: unknown): unknown;
  __contains__(key: unknown): boolean;
  [Symbol.iterator](): Iterator<unknown>;
}

function isDictLike(value: object): value is DictLike {
  const v = value as Partial<DictLike>;
  return typeof v.__getitem__ === 'function' && typeof v.__contains__ === 'function' && typeof v[Symbol.iterator] === 'function';
}

const MAX_DEPTH = 32;

/** A panel's state (or any value in it) as JSON for the frame. */
export function wireState(value: unknown, values: UiValueRules, depth = 0): Wire {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : values.text(value);
  if (typeof value !== 'object' || depth > MAX_DEPTH) return values.text(value);
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [String(k), wireState(v, values, depth + 1)]));
  }
  if (isDictLike(value)) {
    const out: Record<string, Wire> = {};
    for (const key of { [Symbol.iterator]: () => value[Symbol.iterator]() }) out[String(key)] = wireState(value.__getitem__(key), values, depth + 1);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => wireState(v, values, depth + 1));
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wireState(v, values, depth + 1)]));
  }
  // A game list / tuple / set: iterable, not a str.
  if (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function' && typeof (value as { __str__?: unknown }).__str__ !== 'function') {
    return [...(value as Iterable<unknown>)].map((v) => wireState(v, values, depth + 1));
  }
  return values.text(value);
}

/** Python's `str()` of a number (`1.0` for a whole float can't be told from `1`: both are 1 in the game too). */
export function numberText(x: number): string {
  if (Number.isInteger(x)) return Math.abs(x) < 1e21 ? String(x) : BigInt(x).toString();
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const sign = x < 0 ? '-' : '';
  const [mant, expText] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '');
  const exp = Number(expText);
  const decpt = exp + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const rest = digits.length > 1 ? `.${digits.slice(1)}` : '';
  return `${sign}${digits[0]!}${rest}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

function wireText(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map(wireRepr).join(', ')}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${wireRepr(k)}: ${wireRepr(v)}`).join(', ')}}`;
}

function wireRepr(value: unknown): string {
  return typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : wireText(value);
}

/** The game language's rules over wire values (in the frame). */
export const WIRE_VALUES: UiValueRules = {
  text: wireText,
  truthy: (value) => {
    if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  },
};
