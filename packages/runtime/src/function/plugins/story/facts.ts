/**
 * Facts: the story's typed key → value store (`ctx.story.facts`). Keys are the snake_case
 * names `.yarn` reads as `$key`; each is declared once by the game (`fact(key, default)`)
 * with a bool, number or str default that fixes its type. Facts are run-level: a
 * `new_run=True` scene load puts every fact back to its default, and slot saves keep them.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { valueType } from './yarn.js';
import type { FactValue, ValueType } from './yarn.js';

export interface FactDecl {
  readonly key: string;
  readonly default: FactValue;
}

const KEY = /^[a-z][a-z0-9_]*$/;

export function checkFactDecl(key: unknown, value: unknown): FactDecl {
  if (typeof key !== 'string' || !KEY.test(key)) {
    fail('PP4180', `fact key ${JSON.stringify(key)} must be a snake_case identifier`, {
      fix: 'Use lowercase letters, digits and underscores, no dots: fact("met_queen", False) is $met_queen in .yarn.',
    });
  }
  if (typeof value !== 'boolean' && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    fail('PP4180', `fact("${key}", ...) default must be a bool, int, float or str, got ${String(value)}`, {
      fix: 'Pass a literal default: fact("gold_found", 0).',
    });
  }
  return { key, default: value };
}

export class FactStore {
  readonly #decls = new Map<string, FactDecl>();
  readonly #values = new Map<string, FactValue>();

  constructor(decls: readonly FactDecl[]) {
    for (const decl of decls) {
      const existing = this.#decls.get(decl.key);
      if (existing !== undefined && existing.default !== decl.default) {
        fail('PP4181', `Fact "${decl.key}" is declared twice, with defaults ${JSON.stringify(existing.default)} and ${JSON.stringify(decl.default)}`, {
          fix: 'Declare each fact once (one module of facts) and import the handle where it is used.',
        });
      }
      this.#decls.set(decl.key, decl);
      this.#values.set(decl.key, decl.default);
    }
  }

  /** Declared facts and their types (for checking .yarn files and quests). */
  types(): Map<string, ValueType> {
    return new Map([...this.#decls].map(([k, d]) => [k, valueType(d.default)]));
  }

  has(key: string): boolean {
    return this.#decls.has(key);
  }

  #decl(key: string, where: string): FactDecl {
    const decl = this.#decls.get(key);
    if (decl === undefined) {
      const guess = closestMatch(key, this.#decls.keys());
      fail('PP3980', `${where}: "${key}" is not a declared fact`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Declare it: fact("${key}", <default>) from parallax.story.`,
      });
    }
    return decl;
  }

  get(key: string, where = 'facts.get()'): FactValue {
    this.#decl(key, where);
    return this.#values.get(key)!;
  }

  /** Set a fact; true when the value changed. */
  set(key: string, value: unknown, where = 'facts.set()'): boolean {
    const decl = this.#decl(key, where);
    const want = valueType(decl.default);
    const ok = want === 'number' ? typeof value === 'number' && Number.isFinite(value) : want === 'bool' ? typeof value === 'boolean' : typeof value === 'string';
    if (!ok) {
      fail('PP3981', `${where}: fact "${key}" holds a ${want === 'string' ? 'str' : want}, got ${JSON.stringify(value) ?? String(value)}`, {
        fix: `Its default (${JSON.stringify(decl.default)}) fixes its type; set a value of that type.`,
      });
    }
    if (this.#values.get(key) === value) return false;
    this.#values.set(key, value as FactValue);
    return true;
  }

  /** Add to a number fact; returns the new value. */
  add(key: string, amount: unknown, where = 'facts.add()'): number {
    const decl = this.#decl(key, where);
    if (typeof decl.default !== 'number') {
      fail('PP3981', `${where}: fact "${key}" is a ${valueType(decl.default) === 'bool' ? 'bool' : 'str'}; add() needs an int or float fact`, {
        fix: 'Use facts.set() for bool and str facts.',
      });
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) fail('PP3981', `${where}: amount must be a number, got ${String(amount)}`);
    const next = (this.#values.get(key) as number) + amount;
    this.set(key, next, where);
    return next;
  }

  /** Every fact back to its default (New Game). */
  reset(): string[] {
    const changed: string[] = [];
    for (const [key, decl] of this.#decls) {
      if (this.#values.get(key) !== decl.default) changed.push(key);
      this.#values.set(key, decl.default);
    }
    return changed;
  }

  toJSON(): JsonObject {
    return Object.fromEntries(this.#values);
  }

  /** Put saved values back (`SaveData.facts`); keys missing from `data` take their defaults. */
  load(data: Json | undefined, where: string): void {
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      fail('PP3982', `${where}: facts must be an object of key → value`);
    }
    const saved = (data ?? {}) as JsonObject;
    for (const key of Object.keys(saved)) {
      if (!this.#decls.has(key)) {
        fail('PP3982', `${where}: the saved fact "${key}" is not declared by the game`, {
          fix: `Declare it again, or add a save migration that removes it: save.facts.pop("${key}", None).`,
        });
      }
    }
    for (const [key, decl] of this.#decls) this.#values.set(key, decl.default);
    for (const [key, value] of Object.entries(saved)) this.set(key, value, `${where} "${key}"`);
  }
}
