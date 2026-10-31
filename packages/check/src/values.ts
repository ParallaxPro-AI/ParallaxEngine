/**
 * Authored JSON against declared field schemas. Mirrors the kernel's `decode` and
 * `instantiate` (function/kernel/schema.ts) exactly for types, then adds what only the
 * checker can know: whether referenced ids exist, `choices`, and fields that must never
 * appear in data. Collects every problem instead of stopping at the first.
 */

import { closestMatch, COLOR_FORMS, diagnostic, parseColor } from '@parallax/runtime/core';
import type { Diagnostic, DiagnosticCode } from '@parallax/runtime/core';
import type { Json, JsonObject, Origin } from '@parallax/runtime/resource';
import type { DeclaredSchema, FieldType } from './declarations.js';

/** Answers "does this id exist" for ref targets; undefined means it exists (or can't be checked). */
export interface RefIndex {
  /** `message` / `fix`, when given, replace the default "Unknown <what>" report (a malformed asset URL). */
  missing(to: string, id: string): {
    readonly code: DiagnosticCode; readonly known: readonly string[]; readonly what: string; readonly message?: string; readonly fix?: string;
  } | undefined;
}

export function pointerTo(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function describe(value: Json): string {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Validator {
  readonly #refs: RefIndex;
  readonly #out: Diagnostic[];

  constructor(refs: RefIndex, out: Diagnostic[]) {
    this.#refs = refs;
    this.#out = out;
  }

  #report(code: DiagnosticCode, message: string, at: Origin, fix?: string): void {
    this.#out.push(diagnostic(code, message, {
      path: at.path, ...(at.pointer !== '' && { pointer: at.pointer }), ...(fix !== undefined && { fix }),
    }));
  }

  #invalid(name: string, expected: string, value: Json, at: Origin): void {
    this.#report('PP4102', `${name} must be ${expected}, got ${describe(value)}`, at);
  }

  value(type: FieldType, value: Json, name: string, at: Origin): void {
    switch (type.kind) {
      case 'number':
        if (typeof value !== 'number') this.#invalid(name, 'a number', value, at);
        return;
      case 'int':
        if (typeof value !== 'number' || !Number.isInteger(value)) this.#invalid(name, 'an integer', value, at);
        return;
      case 'bool':
        if (typeof value !== 'boolean') this.#invalid(name, 'true or false', value, at);
        return;
      case 'string':
        if (typeof value !== 'string') this.#invalid(name, 'a string', value, at);
        return;
      case 'tag':
      case 'ref':
      case 'entity': {
        if (typeof value !== 'string') {
          this.#invalid(name, type.kind === 'entity' ? 'a placed entity id' : 'a string', value, at);
          return;
        }
        const to = type.kind === 'ref' ? type.to : type.kind;
        const missing = this.#refs.missing(to, value);
        if (missing?.message !== undefined) {
          this.#report(missing.code, `${name}: ${missing.message}`, at, missing.fix);
        } else if (missing !== undefined) {
          const guess = closestMatch(value, missing.known);
          this.#report(missing.code, `Unknown ${missing.what} "${value}"`, at,
            guess !== undefined ? `Change "${value}" to "${guess}".`
              : missing.known.length > 0 && missing.known.length <= 12 ? `Known: ${missing.known.join(', ')}.` : undefined);
        }
        return;
      }
      case 'enum':
        if (typeof value !== 'string' || !type.values.includes(value)) {
          const guess = typeof value === 'string' ? closestMatch(value, type.values) : undefined;
          this.#report('PP4102', `${name} must be one of ${type.values.map((v) => `"${v}"`).join(', ')}, got ${describe(value)}`, at,
            guess !== undefined ? `Change it to "${guess}".` : undefined);
        }
        return;
      case 'vec2':
        if (!(Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number'))) {
          this.#invalid(name, 'a list of 2 numbers', value, at);
        }
        return;
      case 'vec3':
        if (!(Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every((n) => typeof n === 'number'))) {
          this.#invalid(name, 'a list of 3 numbers', value, at);
        }
        return;
      case 'color':
        // The runtime's one colour parser decides; a malformed hex string is PP4101, as at runtime.
        if (parseColor(value) !== null) return;
        if (typeof value === 'string') this.#report('PP4101', `${name}: not a hex color: "${value}"`, at, 'Use "#rrggbb" or "#rrggbbaa".');
        else this.#invalid(name, `a colour: ${COLOR_FORMS}`, value, at);
        return;
      case 'json':
        return;
      case 'optional':
        if (value !== null) this.value(type.of, value, name, at);
        return;
      case 'list':
        if (!Array.isArray(value)) {
          this.#invalid(name, 'a list', value, at);
          return;
        }
        value.forEach((item: Json, i: number) => this.value(type.of, item, `${name}[${i}]`, { path: at.path, pointer: pointerTo(at.pointer, i) }));
        return;
      case 'dict':
        if (!isObject(value)) {
          this.#invalid(name, 'an object', value, at);
          return;
        }
        for (const [key, item] of Object.entries(value)) {
          this.value(type.of, item, `${name}.${key}`, { path: at.path, pointer: pointerTo(at.pointer, key) });
        }
        return;
      case 'record':
        if (!isObject(value)) {
          this.#invalid(name, 'an object', value, at);
          return;
        }
        this.fields(type.fields as DeclaredSchema, value, name, at, true);
    }
  }

  /**
   * Fields of one component/config/content entry/record. `complete` = the data must give
   * every required field (a whole document); otherwise defaults may come from elsewhere.
   */
  fields(schema: DeclaredSchema, data: JsonObject, where: string, at: Origin, complete: boolean): void {
    for (const [key, value] of Object.entries(data)) {
      const spec = schema[key];
      const field: Origin = { path: at.path, pointer: pointerTo(at.pointer, key) };
      if (spec === undefined) {
        const guess = closestMatch(key, Object.keys(schema));
        this.#report('PP4104', `${where} has no field "${key}"`, field,
          guess !== undefined ? `Did you mean "${guess}"?` : `Fields: ${Object.keys(schema).join(', ') || '(none)'}.`);
        continue;
      }
      if (spec.runtime_only === true) {
        this.#report('PP4108', `${where}.${key} holds a live handle and can't be set in data`, field,
          `Remove "${key}"; it is set by code at runtime.`);
        continue;
      }
      this.value(spec.type, value, `${where}.${key}`, field);
      this.#range(spec, value, `${where}.${key}`, field);
      if (spec.choices !== undefined && !spec.choices.includes(value)) {
        this.#report('PP4109', `${where}.${key} must be one of ${spec.choices.map((c) => JSON.stringify(c)).join(', ')}, got ${describe(value)}`, field);
      }
    }
    if (complete) this.required(schema, data, where, at);
  }

  required(schema: DeclaredSchema, data: JsonObject, where: string, at: Origin): void {
    for (const [name, spec] of Object.entries(schema)) {
      if (data[name] !== undefined || 'default' in spec || spec.engine_default === true || spec.default_expr !== undefined) continue;
      if (spec.runtime_only === true) continue;
      this.#report('PP4105', `${where}.${name} is required`, at, `Set "${name}" (${spec.annotation}).`);
    }
  }

  #range(spec: { readonly min?: number; readonly max?: number }, value: Json, name: string, at: Origin): void {
    if (typeof value !== 'number') return;
    if (spec.min !== undefined && value < spec.min) this.#report('PP4103', `${name} is ${value}, below its minimum ${spec.min}`, at);
    if (spec.max !== undefined && value > spec.max) this.#report('PP4103', `${name} is ${value}, above its maximum ${spec.max}`, at);
  }
}

/** Every ref-typed value inside data, by its declared type (for feature boundaries). */
export function refsIn(schema: DeclaredSchema, data: JsonObject, pointer: string): { to: string; id: string; pointer: string }[] {
  const found: { to: string; id: string; pointer: string }[] = [];
  const walk = (type: FieldType, value: Json | undefined, at: string): void => {
    if (value === undefined || value === null) return;
    if (type.kind === 'ref' && typeof value === 'string') found.push({ to: type.to, id: value, pointer: at });
    else if (type.kind === 'optional') walk(type.of, value, at);
    else if (type.kind === 'list' && Array.isArray(value)) value.forEach((v: Json, i: number) => walk(type.of, v, pointerTo(at, i)));
    else if (type.kind === 'dict' && isObject(value)) for (const [k, v] of Object.entries(value)) walk(type.of, v, pointerTo(at, k));
    else if (type.kind === 'record' && isObject(value)) found.push(...refsIn(type.fields as DeclaredSchema, value, at));
  };
  for (const [name, spec] of Object.entries(schema)) walk(spec.type, data[name], pointerTo(pointer, name));
  return found;
}
