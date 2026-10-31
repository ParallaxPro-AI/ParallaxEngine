/**
 * Python call arguments for the grid's component methods, and the checks on what game
 * code passes. Compiled code passes keyword arguments as one trailing api `Kwargs` value
 * (`f(a, kw({ b: 1 }))`); plugins can't import the api layer, so a trailing plain object,
 * or an object carrying `values`, is taken as the keywords. Unknown, duplicated and
 * missing arguments are errors, as in CPython.
 */

import { Cell, fail, Vec2, Vec3 } from '../../../core/index.js';

export type Args = Readonly<Record<string, unknown>>;

function keywordsOf(last: unknown): Args | undefined {
  if (typeof last !== 'object' || last === null || Array.isArray(last)) return undefined;
  if (last instanceof Cell || last instanceof Vec2 || last instanceof Vec3) return undefined;
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

export function cellArg(value: unknown, where: string): Cell {
  if (value instanceof Cell) return value;
  return fail('PP7500', `${where} must be a Cell, got ${describe(value)}`, { fix: 'Pass Cell(col, row).' });
}

/** A unit step: one of the eight neighbouring offsets. */
export function stepArg(value: unknown, where: string): Cell {
  const step = cellArg(value, where);
  if (Math.max(Math.abs(step.col), Math.abs(step.row)) !== 1) {
    fail('PP7500', `${where} must be a one-cell step, got ${String(step)}`, {
      fix: 'Pass Cell.UP, Cell.DOWN, Cell.LEFT or Cell.RIGHT (or a diagonal such as Cell.UP + Cell.LEFT).',
    });
  }
  return step;
}

export function boolArg(value: unknown, where: string): boolean {
  if (typeof value === 'boolean') return value;
  return fail('PP7500', `${where} must be True or False, got ${describe(value)}`);
}

/** A tag's id: game code passes `Tag` handles (`__tag_id__`); data and the kernel hold ids. */
export function tagId(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  const id = typeof value === 'object' && value !== null ? (value as { __tag_id__?: unknown }).__tag_id__ : undefined;
  if (typeof id === 'string') return id;
  return fail('PP3004', `${where} takes Tags, got ${describe(value)}`, { fix: 'Pass a tag declared with tag("id").' });
}

function items(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'object' && Symbol.iterator in value && typeof value !== 'string') return [...(value as Iterable<unknown>)];
  return fail('PP3004', `${where} must be a list, got ${describe(value)}`);
}

/** `tagged=`: one Tag or a sequence of them (SDK `TagFilter`). */
export function tagFilter(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string' || (typeof value === 'object' && '__tag_id__' in value)) return [tagId(value, where)];
  return items(value, where).map((t) => tagId(t, where));
}

/** `having=`: component handles (`__component_id__`) or ids. */
export function componentFilter(value: unknown, where: string): string[] {
  return items(value, where).map((c) => {
    if (typeof c === 'string') return c;
    const id = typeof c === 'function' ? (c as { __component_id__?: unknown }).__component_id__ : undefined;
    if (typeof id === 'string') return id;
    return fail('PP3003', `${where}: ${describe(c)} is not a component`, { fix: 'Pass component classes, e.g. having=[Crate].' });
  });
}
