/**
 * Python call arguments for the ai plugin's component methods and `ctx.ai`: checked
 * values, entities through the kernel's handles, coded errors (PP3290) with fixes.
 */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityHandles } from '../../kernel/index.js';

export function describe(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  if (typeof value === 'function') return value.name || 'function';
  return JSON.stringify(value);
}

export function number(value: unknown, where: string, min = -Infinity): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min) return value;
  return fail('PP3290', `${where} must be a number${min > -Infinity ? ` of at least ${min}` : ''}, got ${describe(value)}`);
}

export function optionalNumber(value: unknown, where: string, min = -Infinity): number | null {
  return value === undefined || value === null ? null : number(value, where, min);
}

export function bool(value: unknown, where: string): boolean {
  if (typeof value === 'boolean') return value;
  return fail('PP3290', `${where} must be True or False, got ${describe(value)}`);
}

export function string(value: unknown, where: string): string {
  if (typeof value === 'string' && value !== '') return value;
  return fail('PP3290', `${where} must be a non-empty str, got ${describe(value)}`);
}

export function point(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (value instanceof Vec2) {
    return fail('PP3291', `${where}: the ai plugin works in 3D (Vec3 points)`, { fix: 'Pass a Vec3 (vec2.to_ground() gives one).' });
  }
  return fail('PP3290', `${where} must be a Vec3, got ${describe(value)}`);
}

export function entity(handles: EntityHandles, value: unknown, where: string): EntityId {
  const id = value === null || value === undefined ? undefined : handles.unwrap(value);
  if (id === undefined) fail('PP3290', `${where} must be an Entity, got ${describe(value)}`);
  return id;
}

/** An Entity or a Vec3: `{ id }` or `{ at }`. */
export function place(handles: EntityHandles, value: unknown, where: string): { id: EntityId } | { at: Vec3 } {
  if (value instanceof Vec3 || value instanceof Vec2) return { at: point(value, where) };
  const id = value === null || value === undefined ? undefined : handles.unwrap(value);
  if (id === undefined) fail('PP3290', `${where} must be an Entity or a Vec3, got ${describe(value)}`);
  return { id };
}

export function tagId(value: unknown, where: string): string {
  if (typeof value === 'string' && value !== '') return value;
  const id = typeof value === 'object' && value !== null ? (value as { __tag_id__?: unknown }).__tag_id__ : undefined;
  if (typeof id === 'string') return id;
  return fail('PP3004', `${where} takes a Tag, got ${describe(value)}`, { fix: 'Pass a tag declared with tag("id").' });
}

/** A tag id from a field value (Tag handle or id string), or null. */
export function fieldTag(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const id = (value as { __tag_id__?: unknown }).__tag_id__;
  return typeof id === 'string' ? id : null;
}

export function list(value: unknown, where: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && Symbol.iterator in value && typeof value !== 'string') return [...(value as Iterable<unknown>)];
  return fail('PP3290', `${where} must be a list, got ${describe(value)}`);
}
