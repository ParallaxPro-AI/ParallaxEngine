/**
 * Cross-file checks over a loaded project: every id a data file names must exist.
 * (Ids defined in code — behaviors, components, panels, tags — are checked by
 * `parallax check`, which also has the compiled game.)
 */

import { closestMatch, diagnostic } from '../core/index.js';
import type { Diagnostic } from '../core/index.js';
import { childPointer } from './reader.js';
import type { Origin, Project } from './model.js';

type LoadedData = Omit<Project, 'diagnostics'>;

const SOURCE_LANGUAGE = 'en';

function unknown(what: string, name: string, known: Iterable<string>, at: Origin, code: 'PP2041' | 'PP2042'): Diagnostic {
  const guess = closestMatch(name, known);
  return diagnostic(code, `Unknown ${what} "${name}"`, {
    path: at.path,
    pointer: at.pointer,
    fix: guess !== undefined ? `Change "${name}" to "${guess}".` : `Create prefabs/${name}.prefab.json or fix the name.`,
  });
}

export function checkReferences(data: LoadedData): Diagnostic[] {
  const found: Diagnostic[] = [];
  const prefabIds = [...data.prefabs.keys()];

  for (const prefab of data.prefabs.values()) {
    if (prefab.extends !== undefined && !data.prefabs.has(prefab.extends)) {
      found.push(unknown('base prefab', prefab.extends, prefabIds, { path: prefab.path, pointer: '/extends' }, 'PP2042'));
    }
    const names = new Set<string>();
    for (const child of prefab.children) {
      if (child.name !== undefined) {
        if (names.has(child.name)) {
          found.push(diagnostic('PP2012', `Child name "${child.name}" is used twice in this prefab`, {
            path: child.origin.path, pointer: child.origin.pointer, fix: 'Child names must be unique within a prefab.',
          }));
        }
        names.add(child.name);
      }
      if (child.prefab !== undefined && !data.prefabs.has(child.prefab)) {
        found.push(unknown('prefab', child.prefab, prefabIds, { ...child.origin, pointer: childPointer(child.origin.pointer, 'prefab') }, 'PP2041'));
      }
    }
  }
  found.push(...extendsCycles(data));

  for (const scene of data.scenes.values()) {
    const placedIds = new Map<string, string>();
    for (const placement of scene.entities) {
      if (!data.prefabs.has(placement.prefab)) {
        found.push(unknown('prefab', placement.prefab, prefabIds,
          { ...placement.origin, pointer: childPointer(placement.origin.pointer, 'prefab') }, 'PP2041'));
      }
      if (placement.id !== undefined) {
        const first = placedIds.get(placement.id);
        if (first !== undefined) {
          found.push(diagnostic('PP2011', `Placed id "${placement.id}" is already used in ${first}`, {
            path: placement.origin.path, pointer: placement.origin.pointer,
            fix: 'Placed ids must be unique within a scene and its regions.',
          }));
        } else {
          placedIds.set(placement.id, placement.origin.path);
        }
      }
      if (placement.layer !== undefined && scene.world?.layers.has(placement.layer) !== true) {
        const known = [...(scene.world?.layers.keys() ?? [])];
        const guess = closestMatch(placement.layer, known);
        found.push(diagnostic('PP2044', `Unknown world layer "${placement.layer}"`, {
          path: placement.origin.path, pointer: childPointer(placement.origin.pointer, 'layer'),
          fix: guess !== undefined
            ? `Change it to "${guess}".`
            : `Declare it under "layers" in scenes/${scene.id}/world.json.`,
        }));
      }
    }
  }

  found.push(...regionBudgets(data));
  found.push(...localeGaps(data));
  return found;
}

function extendsCycles(data: LoadedData): Diagnostic[] {
  const found: Diagnostic[] = [];
  const reported = new Set<string>();
  for (const start of data.prefabs.values()) {
    const chain: string[] = [];
    let current = start.id as string | undefined;
    while (current !== undefined && data.prefabs.has(current)) {
      if (chain.includes(current)) {
        const cycle = chain.slice(chain.indexOf(current));
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          const at = data.prefabs.get(current)!;
          found.push(diagnostic('PP2043', `Prefabs extend each other in a cycle: ${[...cycle, current].join(' → ')}`, {
            path: at.path, pointer: '/extends', fix: 'Remove "extends" from one of them.',
          }));
        }
        break;
      }
      chain.push(current);
      current = data.prefabs.get(current)!.extends;
    }
  }
  return found;
}

/** A region declaring `budget.entities` must not place more (grid placements count each instance). */
function regionBudgets(data: LoadedData): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const scene of data.scenes.values()) {
    const counts = new Map<string, number>();
    for (const placement of scene.entities) {
      if (placement.region === undefined) continue;
      const instances = placement.grid === undefined ? 1 : placement.grid.cols * placement.grid.rows;
      counts.set(placement.region, (counts.get(placement.region) ?? 0) + instances);
    }
    for (const region of scene.regions.values()) {
      const limit = region.budget?.entities;
      const count = counts.get(region.id) ?? 0;
      if (limit !== undefined && count > limit) {
        found.push(diagnostic('PP5010', `Region "${region.id}" places ${count} entities; its budget is ${limit}`, {
          severity: 'warning', path: region.path, pointer: '/budget/entities',
          fix: 'Move placements to a neighbouring region, raise the budget, or use fewer, larger pieces.',
        }));
      }
    }
  }
  return found;
}

function localeGaps(data: LoadedData): Diagnostic[] {
  const source = data.locales.get(SOURCE_LANGUAGE);
  if (source === undefined) return [];
  const found: Diagnostic[] = [];
  const keys = new Set(Object.keys(source.strings));
  for (const locale of data.locales.values()) {
    if (locale === source) continue;
    for (const key of keys) {
      if (!(key in locale.strings)) {
        found.push(diagnostic('PP2060', `"${key}" is missing in ${locale.language}`, {
          path: locale.path, fix: `Add "${key}" (from ${source.path}).`,
        }));
      }
    }
    for (const key of Object.keys(locale.strings)) {
      if (!keys.has(key)) {
        found.push(diagnostic('PP2061', `"${key}" is not in ${SOURCE_LANGUAGE}`, {
          path: locale.path, pointer: childPointer('', key), fix: `Remove it, or add it to ${source.path}.`,
        }));
      }
    }
  }
  return found;
}
