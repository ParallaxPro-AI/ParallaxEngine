/**
 * Which tests a project has (sdk/parallax/test.pyi): every `test_*.py` under `tests/`;
 * in each, the `@playtest` functions and the plain `test_*` functions (pure rules tests,
 * called with no arguments), in definition order. Other modules in `tests/` are helpers.
 */

import type { TestKind } from './results.js';
import { playtestMark } from './sdk.js';

export interface Collected {
  readonly name: string;
  readonly title: string;
  readonly kind: Exclude<TestKind, 'module'>;
}

/** Is this project path a test module? */
export function isTestModule(source: string): boolean {
  if (!source.startsWith('tests/') || !source.endsWith('.py')) return false;
  const base = source.slice(source.lastIndexOf('/') + 1);
  return base.startsWith('test_');
}

/** Top-level `def`/`async def` names in source order (definition order for collection). */
export function definitionOrder(python: string): Map<string, number> {
  const order = new Map<string, number>();
  for (const m of python.matchAll(/^(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    if (!order.has(m[1]!)) order.set(m[1]!, m.index);
  }
  return order;
}

function isClass(fn: Function): boolean {
  return /^class\b/.test(Function.prototype.toString.call(fn));
}

/** The tests one module defines: its exports, ordered by where the source defines them. */
export function collect(exports: Readonly<Record<string, unknown>>, python: string): Collected[] {
  const order = definitionOrder(python);
  const found: (Collected & { readonly at: number; readonly tie: number })[] = [];
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== 'function' || isClass(value)) continue;
    const mark = playtestMark(value);
    if (mark !== undefined) {
      found.push({ name, title: mark.name, kind: 'playtest', at: order.get(name) ?? Infinity, tie: mark.order });
    } else if (name.startsWith('test_')) {
      found.push({ name, title: name, kind: 'test', at: order.get(name) ?? Infinity, tie: Infinity });
    }
  }
  found.sort((a, b) => a.at - b.at || a.tie - b.tie || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found.map(({ name, title, kind }) => ({ name, title, kind }));
}
