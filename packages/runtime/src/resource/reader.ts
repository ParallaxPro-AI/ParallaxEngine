/**
 * Reading one data file: parse JSON, then pull typed fields out of it. Readers never
 * throw — every problem becomes a diagnostic with the file and a JSON pointer, so one
 * load reports everything wrong with a project, not just the first thing.
 */

import { closestMatch, diagnostic } from '../core/index.js';
import type { Diagnostic, DiagnosticCode } from '../core/index.js';
import type { Json, JsonObject, Origin } from './model.js';

export function childPointer(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DocReader {
  readonly path: string;
  readonly #diagnostics: Diagnostic[];

  constructor(path: string, diagnostics: Diagnostic[]) {
    this.path = path;
    this.#diagnostics = diagnostics;
  }

  origin(pointer: string): Origin {
    return { path: this.path, pointer };
  }

  report(code: DiagnosticCode, message: string, pointer: string, fix?: string, severity?: 'warning'): void {
    this.#diagnostics.push(diagnostic(code, message, {
      ...(severity !== undefined && { severity }),
      path: this.path,
      ...(pointer !== '' && { pointer }),
      ...(fix !== undefined && { fix }),
    }));
  }

  /** The parsed document, or undefined after reporting PP1001 with the line. */
  parse(text: string): Json | undefined {
    try {
      return JSON.parse(text) as Json;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = /position (\d+)/.exec(message);
      const line = position === null ? undefined : text.slice(0, Number(position[1])).split('\n').length;
      this.#diagnostics.push(diagnostic('PP1001', `Invalid JSON: ${message}`, {
        path: this.path,
        ...(line !== undefined && { line }),
        fix: 'Fix the JSON syntax (a missing comma, quote or bracket is the usual cause).',
      }));
      return undefined;
    }
  }

  object(value: Json | undefined, pointer: string, what: string): JsonObject | undefined {
    if (isObject(value)) return value;
    this.report('PP1002', `${what} must be an object`, pointer);
    return undefined;
  }

  /** Report keys outside `allowed`; `renamed` maps a known wrong key to the fix for it. */
  keys(obj: JsonObject, pointer: string, allowed: readonly string[], renamed: Readonly<Record<string, string>> = {}): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const fix = renamed[key]
        ?? (closestMatch(key, allowed) !== undefined
          ? `Did you mean "${closestMatch(key, allowed)}"?`
          : `Allowed keys: ${allowed.join(', ')}.`);
      this.report('PP1003', `Unknown key "${key}"`, childPointer(pointer, key), fix);
    }
  }

  string(obj: JsonObject, key: string, pointer: string, required = false): string | undefined {
    return this.#typed(obj, key, pointer, required, 'a string', (v) => typeof v === 'string');
  }

  number(obj: JsonObject, key: string, pointer: string, required = false): number | undefined {
    return this.#typed(obj, key, pointer, required, 'a number', (v) => typeof v === 'number');
  }

  boolean(obj: JsonObject, key: string, pointer: string): boolean | undefined {
    return this.#typed(obj, key, pointer, false, 'true or false', (v) => typeof v === 'boolean');
  }

  numbers(obj: JsonObject, key: string, pointer: string, lengths: readonly number[], required = false): readonly number[] | undefined {
    const described = `a list of ${lengths.join(' or ')} numbers`;
    return this.#typed(obj, key, pointer, required, described, (v) =>
      Array.isArray(v) && lengths.includes(v.length) && v.every((n) => typeof n === 'number'));
  }

  /** A number, or a list of numbers of an allowed length (rotation, scale). */
  numberOrNumbers(obj: JsonObject, key: string, pointer: string, lengths: readonly number[]): number | readonly number[] | undefined {
    if (typeof obj[key] === 'number') return obj[key];
    return this.numbers(obj, key, pointer, lengths);
  }

  strings(obj: JsonObject, key: string, pointer: string): readonly string[] {
    return this.#typed(obj, key, pointer, false, 'a list of strings', (v) =>
      Array.isArray(v) && v.every((s) => typeof s === 'string')) ?? [];
  }

  /**
   * An object whose every value is an object: `{ "health": {...}, "shape": {...} }`.
   * With `nullable`, an entry may be `null` (it deletes an inherited entry; see merge.ts)
   * and is left out of the result.
   */
  objectMap(obj: JsonObject, key: string, pointer: string, nullable = false): Readonly<Record<string, JsonObject>> {
    const value = obj[key];
    if (value === undefined) return {};
    const map = this.object(value, childPointer(pointer, key), `"${key}"`);
    if (map === undefined) return {};
    const result: Record<string, JsonObject> = {};
    for (const [name, entry] of Object.entries(map)) {
      if (nullable && entry === null) continue;
      const checked = this.object(entry, childPointer(childPointer(pointer, key), name), `"${key}.${name}"`);
      if (checked !== undefined) result[name] = checked;
    }
    return result;
  }

  #typed<T>(obj: JsonObject, key: string, pointer: string, required: boolean, described: string,
    is: (value: Json) => boolean): T | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (required) this.report('PP1002', `Missing required "${key}" (${described})`, pointer);
      return undefined;
    }
    if (is(value)) return value as T;
    this.report('PP1002', `"${key}" must be ${described}`, childPointer(pointer, key));
    return undefined;
  }
}
