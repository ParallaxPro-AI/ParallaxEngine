/**
 * Economy data a field schema can't check (the economy plugin, sdk/parallax/economy.pyi):
 *
 *   - loot tables: each entry names exactly one of item / pool / table (PP2600); nested
 *     tables don't cycle (PP2601); `max` ≥ `min`, `rolls_max` ≥ `rolls` (PP2602)
 *   - upgrades: `requires` never leads back to the upgrade itself (PP2603)
 *   - item and upgrade `bonuses` name a component and one of its modifiable number fields
 *     (PP2604)
 *   - Pickup: exactly one of item / pool (PP2605); Spawner (spawning plugin) waves have a
 *     count or a budget (PP2606); a "joint" Door (interaction plugin) names its joint
 *     (PP2607) — on prefabs and placements alike
 *
 * Every one of these is also a runtime error; checking them here reports them before the
 * game runs, with the file and pointer.
 */

import { closestMatch } from '@parallax/runtime/core';
import type { JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

const NUMERIC = new Set(['number', 'int']);

function pointerTo(...parts: (string | number)[]): string {
  return parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function contentOf(ctx: CheckContext, kind: string): Array<{ id: string; path: string; values: JsonObject }> {
  return [...(ctx.project.content.get(kind)?.values() ?? [])].map((e) => ({ id: e.id, path: e.path, values: e.values }));
}

function checkLoot(ctx: CheckContext): void {
  const tables = contentOf(ctx, 'loot_table');
  const nested = new Map<string, string[]>();
  for (const table of tables) {
    const children: string[] = [];
    for (const list_ of ['entries', 'guaranteed'] as const) {
      list(table.values[list_]).forEach((raw, i) => {
        const entry = object(raw);
        if (entry === undefined) return;
        const named = ['item', 'pool', 'table'].filter((k) => entry[k] !== undefined && entry[k] !== null);
        if (named.length !== 1) {
          ctx.report('PP2600', `loot_table "${table.id}" ${list_}[${i}] names ${named.length === 0 ? 'nothing' : named.join(' and ')}`, {
            path: table.path, pointer: pointerTo(list_, i), fix: 'Give each entry exactly one of "item", "pool" or "table".',
          });
        }
        const min = typeof entry['min'] === 'number' ? entry['min'] : 1;
        const max = typeof entry['max'] === 'number' ? entry['max'] : 1;
        if (max < min) {
          ctx.report('PP2602', `loot_table "${table.id}" ${list_}[${i}]: max ${max} is below min ${min}`, {
            path: table.path, pointer: pointerTo(list_, i, 'max'), fix: 'Make max at least min (or drop max for exactly min).',
          });
        }
        if (typeof entry['table'] === 'string') children.push(entry['table']);
      });
    }
    const rolls = typeof table.values['rolls'] === 'number' ? table.values['rolls'] : 1;
    const rollsMax = table.values['rolls_max'];
    if (typeof rollsMax === 'number' && rollsMax < rolls) {
      ctx.report('PP2602', `loot_table "${table.id}": rolls_max ${rollsMax} is below rolls ${rolls}`, {
        path: table.path, pointer: '/rolls_max', fix: 'Make rolls_max at least rolls.',
      });
    }
    nested.set(table.id, children);
  }
  for (const table of tables) {
    const path = cycleFrom(table.id, nested);
    if (path !== undefined) {
      ctx.report('PP2601', `loot_table "${table.id}" includes itself: ${path.join(' → ')}`, {
        path: table.path, fix: 'Break the cycle of "table" entries.',
      });
    }
  }
}

/** The cycle back to `start` through `edges`, if there is one. */
function cycleFrom(start: string, edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const seen = new Set<string>();
  const walk = (at: string, trail: string[]): string[] | undefined => {
    for (const next of edges.get(at) ?? []) {
      if (next === start) return [...trail, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...trail, next]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(start, [start]);
}

function checkBonuses(ctx: CheckContext, kind: string): void {
  for (const entry of contentOf(ctx, kind)) {
    list(entry.values['bonuses']).forEach((raw, i) => {
      const bonus = object(raw);
      if (bonus === undefined || typeof bonus['component'] !== 'string' || typeof bonus['field'] !== 'string') return;
      const component = bonus['component'];
      const field = bonus['field'];
      const info = ctx.components.get(component);
      if (info === undefined) {
        const guess = closestMatch(component, [...ctx.components.keys()]);
        ctx.report('PP2604', `${kind} "${entry.id}" bonuses[${i}] names no component "${component}"`, {
          path: entry.path, pointer: pointerTo('bonuses', i, 'component'), fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Name a component id, e.g. "health".',
        });
        return;
      }
      const spec = info.fields[field];
      if (spec === undefined || !NUMERIC.has(spec.type.kind) || spec.modifiable !== true) {
        const ok = Object.entries(info.fields).filter(([, f]) => NUMERIC.has(f.type.kind) && f.modifiable === true).map(([n]) => n);
        ctx.report('PP2604', `${kind} "${entry.id}" bonuses[${i}]: ${component}.${field} is not a modifiable number field`, {
          path: entry.path, pointer: pointerTo('bonuses', i, 'field'), fix: `Modifiable fields of ${component}: ${ok.join(', ') || '(none)'}.`,
        });
      }
    });
  }
}

function checkUpgrades(ctx: CheckContext): void {
  const upgrades = contentOf(ctx, 'upgrade');
  const edges = new Map(upgrades.map((u) => [u.id, list(u.values['requires']).filter((r): r is string => typeof r === 'string')]));
  for (const u of upgrades) {
    const path = cycleFrom(u.id, edges);
    if (path !== undefined) {
      ctx.report('PP2603', `upgrade "${u.id}" requires itself: ${path.join(' → ')}`, {
        path: u.path, pointer: '/requires', fix: 'An upgrade can never be drafted if it needs itself first; remove the cycle.',
      });
    }
  }
}

function checkEntity(ctx: CheckContext, components: Readonly<Record<string, JsonObject>>, merged: (id: string) => JsonObject | undefined,
  at: { readonly path: string; readonly pointer: string }): void {
  if ('pickup' in components) {
    const pickup = merged('pickup') ?? {};
    const named = ['item', 'pool'].filter((k) => pickup[k] !== undefined && pickup[k] !== null);
    if (named.length !== 1) {
      ctx.report('PP2605', `Pickup has ${named.length === 0 ? 'neither "item" nor "pool"' : 'both "item" and "pool"'}`, {
        path: at.path, pointer: `${at.pointer}/components/pickup`, fix: 'Give it exactly one: "item": "<item id>" or "pool": "gold".',
      });
    }
  }
  const spawner = components['spawner'];
  if (spawner !== undefined) {
    list(spawner['waves']).forEach((raw, i) => {
      const wave = object(raw);
      if (wave === undefined) return;
      const count = typeof wave['count'] === 'number' ? wave['count'] : 0;
      const budget = typeof wave['budget'] === 'number' ? wave['budget'] : 0;
      if (count === 0 && budget === 0) {
        ctx.report('PP2606', `Spawner waves[${i}] has neither a count nor a budget`, {
          path: at.path, pointer: `${at.pointer}/components/spawner/waves/${i}`, fix: 'Give the wave "count": N or "budget": points.',
        });
      }
    });
  }
  if ('door' in components) {
    const door = merged('door') ?? {};
    if (door['mode'] === 'joint' && (typeof door['joint'] !== 'string' || door['joint'] === '')) {
      ctx.report('PP2607', 'A "joint" Door needs "joint": the Model joint it drives', {
        path: at.path, pointer: `${at.pointer}/components/door`, fix: 'Set "joint": "<hinge joint name>", or use "mode": "swing".',
      });
    }
  }
}

export function checkEconomy(ctx: CheckContext): void {
  // Spawners (spawning plugin) and doors (interaction plugin) are checked here too, with pickups.
  const economy = ctx.plugins.has('economy');
  if (!economy && !ctx.plugins.has('spawning') && !ctx.plugins.has('interaction')) return;
  if (economy) {
    checkLoot(ctx);
    checkUpgrades(ctx);
    checkBonuses(ctx, 'item');
    checkBonuses(ctx, 'upgrade');
  }
  for (const prefab of ctx.project.prefabs.values()) {
    checkEntity(ctx, prefab.components, (id) => prefab.components[id], { path: prefab.path, pointer: '' });
  }
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) {
      const own = placement.components;
      if (!('pickup' in own) && !('spawner' in own) && !('door' in own)) continue;
      const base = ctx.project.prefabs.get(placement.prefab)?.components ?? {};
      checkEntity(ctx, own, (id) => ({ ...(base[id] ?? {}), ...(own[id] ?? {}) }), placement.origin);
    }
  }
}
