/**
 * Stat modifiers on `modifiable` fields (SDK `field(modifiable=)`):
 *
 *   effective = (base + Σadd) × Πmultiply, clamped to the field's min/max; int fields round
 *   reading the field gives the effective value; assigning sets the base — immediately
 *   a key is scoped to (component, field): reusing it on the same field replaces it
 *   stack=True adds a permanent keyless modifier; timed modifiers expire on their own
 *
 * The first modifier on a field turns it into an accessor property on the fields object,
 * so every reader — game code, plugins, the renderer — sees the effective value without
 * knowing modifiers exist.
 */

import { fail } from '../../core/index.js';
import type { FieldSpec, Fields } from './schema.js';

export interface ModifierInit {
  readonly multiply?: number;
  readonly add?: number;
  /** Required unless `stack` is true. */
  readonly key?: string;
  /** Lifetime in game seconds; undefined = until removed. */
  readonly seconds?: number;
  /** A permanent keyless modifier that accumulates with every call. */
  readonly stack?: boolean;
}

interface Modifier {
  readonly key: string | undefined;
  readonly multiply: number;
  readonly add: number;
  readonly expires: number | undefined;
}

interface ModifiedField {
  base: number;
  modifiers: Modifier[];
  readonly spec: FieldSpec;
}

/** A modifier is "expired" against game time, read through this callback. */
export type Now = () => number;

const STATE = Symbol('modifiers');

type ModifiableFields = Fields & { [STATE]?: Map<string, ModifiedField> };

function effective(field: ModifiedField, now: number): number {
  let add = 0;
  let multiply = 1;
  for (const m of field.modifiers) {
    if (m.expires !== undefined && m.expires <= now) continue;
    add += m.add;
    multiply *= m.multiply;
  }
  let value = (field.base + add) * multiply;
  if (field.spec.min !== undefined) value = Math.max(field.spec.min, value);
  if (field.spec.max !== undefined) value = Math.min(field.spec.max, value);
  return field.spec.type.kind === 'int' ? Math.round(value) : value;
}

function stateOf(fields: ModifiableFields): Map<string, ModifiedField> {
  let state = fields[STATE];
  if (state === undefined) {
    state = new Map();
    Object.defineProperty(fields, STATE, { value: state, enumerable: false });
  }
  return state;
}

/** Turn `fields[name]` into an accessor over a base and a modifier list. */
function track(fields: Fields, name: string, spec: FieldSpec, base: number, modifiers: Modifier[], now: Now): ModifiedField {
  const field: ModifiedField = { base, modifiers, spec };
  stateOf(fields as ModifiableFields).set(name, field);
  Object.defineProperty(fields, name, {
    get: () => effective(field, now()),
    set: (value: number) => { field.base = value; },
    enumerable: true,
    configurable: true,
  });
  return field;
}

/** Add a modifier to `fields[name]`. `where` names the field in errors. */
export function modify(fields: Fields, name: string, spec: FieldSpec | undefined, init: ModifierInit, now: Now, where: string): void {
  if (spec === undefined) fail('PP4104', `${where} does not exist`);
  if (spec.modifiable !== true) {
    fail('PP4106', `${where} is not modifiable`, { fix: 'Declare it with field(..., modifiable=True) to stack modifiers on it.' });
  }
  if (init.stack !== true && init.key === undefined) {
    fail('PP4107', `A modifier on ${where} needs a key (or stack=True for a permanent upgrade)`);
  }
  let field = stateOf(fields as ModifiableFields).get(name);
  if (field === undefined) {
    const base = fields[name];
    if (typeof base !== 'number') fail('PP4106', `${where} is not a number and can't take modifiers`);
    field = track(fields, name, spec, base, [], now);
  }
  const modifier: Modifier = {
    key: init.stack === true ? undefined : init.key,
    multiply: init.multiply ?? 1,
    add: init.add ?? 0,
    expires: init.seconds === undefined ? undefined : now() + init.seconds,
  };
  const at = now();
  const kept = field.modifiers.filter((m) =>
    (m.expires === undefined || m.expires > at) && (modifier.key === undefined || m.key !== modifier.key));
  field.modifiers = [...kept, modifier];
}

/** One modifier as snapshots hold it: no key = a stacked one; `expires` is in game time. */
export interface ModifierState {
  readonly key?: string;
  readonly add: number;
  readonly multiply: number;
  readonly expires?: number;
}

/**
 * The modifier list of every field that has taken a modifier, by field name — including
 * fields whose modifiers were all removed, since those still read clamped and rounded.
 * Expired modifiers that haven't been pruned yet are included: restoring them is exact.
 */
export function modifierStates(fields: Fields): Record<string, ModifierState[]> {
  const out: Record<string, ModifierState[]> = {};
  for (const [name, field] of (fields as ModifiableFields)[STATE] ?? []) {
    out[name] = field.modifiers.map((m) => ({
      ...(m.key !== undefined && { key: m.key }),
      add: m.add,
      multiply: m.multiply,
      ...(m.expires !== undefined && { expires: m.expires }),
    }));
  }
  return out;
}

/** Drop modifier tracking (of the fields `which` picks): each becomes a plain field holding its base. */
export function clearModifiers(fields: Fields, which: (name: string) => boolean = () => true): void {
  const state = (fields as ModifiableFields)[STATE];
  if (state === undefined) return;
  for (const [name, field] of [...state]) {
    if (!which(name)) continue;
    Object.defineProperty(fields, name, { value: field.base, writable: true, enumerable: true, configurable: true });
    state.delete(name);
  }
}

/** Re-attach saved modifier lists; `fields[name]` must already hold the base value. */
export function restoreModifiers(
  fields: Fields, specs: Readonly<Record<string, FieldSpec>>, states: Readonly<Record<string, readonly ModifierState[]>>,
  now: Now, where: string,
): void {
  for (const [name, list] of Object.entries(states)) {
    const spec = specs[name];
    if (spec?.modifiable !== true) fail('PP4106', `${where}.${name} is not modifiable, but saved data has modifiers on it`);
    const base = fields[name];
    if (typeof base !== 'number') fail('PP4106', `${where}.${name} is not a number and can't take modifiers`);
    track(fields, name, spec, base, list.map((m) => ({ key: m.key, add: m.add, multiply: m.multiply, expires: m.expires })), now);
  }
}

/** Remove every modifier with `key`, on every field of these fields objects. */
export function unmodify(fieldsList: Iterable<Fields>, key: string): void {
  for (const fields of fieldsList) {
    const state = (fields as ModifiableFields)[STATE];
    if (state === undefined) continue;
    for (const field of state.values()) field.modifiers = field.modifiers.filter((m) => m.key !== key);
  }
}

/** The base (unmodified) value of a field. */
export function baseValue(fields: Fields, name: string): unknown {
  return (fields as ModifiableFields)[STATE]?.get(name)?.base ?? fields[name];
}
