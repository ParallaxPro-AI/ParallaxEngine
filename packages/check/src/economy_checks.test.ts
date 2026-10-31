/**
 * Economy data checks on a loaded project, with a minimal check context: the game lists
 * the economy plugin and declares a `character` component with one modifiable field.
 */

import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@parallax/runtime/core';
import { loadProject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { checkEconomy } from './economy_checks.js';

function run(data: Record<string, unknown>, plugins: readonly string[] = ['core', 'economy']): string[] {
  const text = Object.fromEntries(Object.entries(data).map(([p, v]) => [p, JSON.stringify(v)]));
  const project = loadProject({ list: () => Object.keys(text).sort(), read: (p) => text[p]! });
  const out: Diagnostic[] = [];
  const ctx = {
    plugins: new Set(plugins),
    project,
    components: new Map([['character', {
      id: 'character', feature: null,
      fields: { walk_speed: { type: { kind: 'number' }, modifiable: true }, name: { type: { kind: 'string' } } },
    }]]),
    report: (code: string, message: string, init: { pointer?: string; path?: string } = {}) => {
      out.push({ code, message, ...init } as unknown as Diagnostic);
    },
  } as unknown as CheckContext;
  checkEconomy(ctx);
  return out.map((d) => `${d.code} ${d.path ?? ''}${d.pointer ?? ''}`);
}

describe('economy checks', () => {
  it('accepts well-formed loot, upgrades, bonuses and world components', () => {
    expect(run({
      'content/loot_table/a.json': { rolls: 1, rolls_max: 2, entries: [{ item: 'x' }, { table: 'b', min: 1, max: 2 }] },
      'content/loot_table/b.json': { guaranteed: [{ pool: 'gold' }] },
      'content/upgrade/u1.json': { name: 'U1', bonuses: [{ component: 'character', field: 'walk_speed', multiply: 1.1 }] },
      'content/upgrade/u2.json': { name: 'U2', requires: ['u1'] },
      'prefabs/p.prefab.json': { components: { pickup: { item: 'x' }, spawner: { prefabs: [{ prefab: 'p' }], waves: [{ count: 2 }] }, door: { mode: 'joint', joint: 'hinge' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'p', id: 'one', components: { pickup: { count: 3 } } }] },
    })).toEqual([]);
  });

  it('reports bad entries, cycles, unmodifiable bonuses and incomplete components', () => {
    expect(run({
      'content/loot_table/a.json': { rolls: 3, rolls_max: 1, entries: [{ item: 'x', pool: 'gold' }, {}, { table: 'b', min: 3, max: 1 }] },
      'content/loot_table/b.json': { entries: [{ table: 'a' }] },
      'content/upgrade/u1.json': { name: 'U1', requires: ['u2'], bonuses: [{ component: 'charactr', field: 'walk_speed' }] },
      'content/upgrade/u2.json': { name: 'U2', requires: ['u1'], bonuses: [{ component: 'character', field: 'name' }] },
      'prefabs/p.prefab.json': { components: { pickup: {}, spawner: { prefabs: [], waves: [{}] }, door: { mode: 'joint' } } },
    })).toEqual([
      'PP2600 content/loot_table/a.json/entries/0',
      'PP2600 content/loot_table/a.json/entries/1',
      'PP2602 content/loot_table/a.json/entries/2/max',
      'PP2602 content/loot_table/a.json/rolls_max',
      'PP2601 content/loot_table/a.json',
      'PP2601 content/loot_table/b.json',
      'PP2603 content/upgrade/u1.json/requires',
      'PP2603 content/upgrade/u2.json/requires',
      'PP2604 content/upgrade/u1.json/bonuses/0/component',
      'PP2604 content/upgrade/u2.json/bonuses/0/field',
      'PP2605 prefabs/p.prefab.json/components/pickup',
      'PP2606 prefabs/p.prefab.json/components/spawner/waves/0',
      'PP2607 prefabs/p.prefab.json/components/door',
    ]);
  });

  it('a placement completes its prefab\'s pickup; games without the plugin are not checked', () => {
    const data = {
      'prefabs/p.prefab.json': { components: { pickup: { count: 1 } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'p', components: { pickup: { pool: 'gold' } } }] },
    };
    expect(run(data)).toEqual(['PP2605 prefabs/p.prefab.json/components/pickup']);
    expect(run(data, ['core'])).toEqual([]);
  });
});
