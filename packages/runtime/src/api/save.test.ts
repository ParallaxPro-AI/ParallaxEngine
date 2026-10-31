import { afterEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import { migrateDocument } from '../function/plugins/save/index.js';
import type { SaveDocument } from '../function/services/index.js';
import { kw } from './kwargs.js';
import { local_players } from './local_players.js';
import { PyDict } from './pyrt/collections.js';
import { migration, registeredMigrations, resetMigrations, save, SaveApi, SaveData } from './save.js';
import { PrefabRef } from './types.js';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParallaxError) return error.diagnostic.code;
    throw error;
  }
  throw new Error('expected a coded error');
}

const v1 = (): SaveDocument => ({
  version: 1, scene: 'town', seed: 3,
  resources: { bag: { health_potions: 2, mana_potions: 1 }, wallet: { gold: 5 } },
  modifiers: { bag: { health_potions: [{ add: 1, multiply: 1 }] }, wallet: { gold: [{ add: 2, multiply: 1 }] } },
  entities: { hero: { armour: { points: 4 } } },
  facts: { 'quest.done': true },
});

afterEach(() => resetMigrations());

describe('@migration and SaveData', () => {
  it('runs Python-shaped migrations over dicts and writes the result back as JSON', () => {
    // The shape of examples/open_world_rpg/migrations/0002_bag_by_item.py, as compiled code calls it.
    migration(kw({ from_version: 1, to_version: 2 }))(function bag_by_item(s: SaveData) {
      const bag = s.resources.__getitem__('bag') as PyDict;
      bag.__setitem__('items', PyDict.from([['health_potion', bag.pop('health_potions', 0)], ['mana_potion', bag.pop('mana_potions', 0)]]));
      s.facts.__setitem__('quest_done', s.facts.pop('quest.done', false));
      const hero = s.entities.get('hero') as PyDict;
      (hero.setdefault('health', new PyDict()) as PyDict).__setitem__('shield', (hero.pop('armour') as PyDict).get('points', 0));
    });
    expect(registeredMigrations().map((m) => [m.from, m.to, m.name])).toEqual([[1, 2, 'bag_by_item']]);
    const migrated = migrateDocument(v1(), 2, registeredMigrations(), 'slot');
    expect(migrated).toMatchObject({
      version: 2,
      resources: { bag: { items: { health_potion: 2, mana_potion: 1 } }, wallet: { gold: 5 } },
      entities: { hero: { health: { shield: 4 } } },
      facts: { quest_done: true },
    });
    // The removed field's modifiers go with it; the kept field's stay.
    expect(migrated.modifiers).toEqual({ wallet: { gold: [{ add: 2, multiply: 1 }] } });
    expect(migrated['quests']).toBeUndefined();
  });

  it('refuses values a save cannot hold and bad declarations', () => {
    migration(kw({ from_version: 1, to_version: 2 }))(function bad(s: SaveData) {
      s.facts.__setitem__('when', new Date());
    });
    expect(code(() => migrateDocument(v1(), 2, registeredMigrations(), 'slot'))).toBe('PP3959');
    resetMigrations();
    migration(kw({ from_version: 1, to_version: 2 }))(function nan(s: SaveData) {
      s.facts.__setitem__('x', Number.NaN);
    });
    expect(code(() => migrateDocument(v1(), 2, registeredMigrations(), 'slot'))).toBe('PP3959');
    expect(code(() => migration(kw({ from_version: 1.5, to_version: 2 })))).toBe('PP3951');
    expect(code(() => migration(kw({ from_version: 1, to_version: 2 }))(3))).toBe('PP3951');
  });
});

describe('Python arguments', () => {
  it('ctx.save defaults the slot to "auto"; delete needs one', () => {
    const plugin = save();
    const calls: unknown[] = [];
    const engine = { save: (s: unknown) => calls.push(['save', s]), load: () => true, exists: () => false, delete: (s: unknown) => calls.push(['delete', s]) };
    const api = new SaveApi(engine as never);
    api.save();
    api.save('career');
    api.delete('career');
    expect(calls).toEqual([['save', 'auto'], ['save', 'career'], ['delete', 'career']]);
    expect(code(() => api.delete())).toBe('PP3030');
    expect(plugin.id).toBe('save');
    expect(plugin.namespace?.name).toBe('save');
  });

  it('local_players binds its keywords and checks controls and layouts', () => {
    const chef = new PrefabRef('chef');
    expect(code(() => local_players(kw({ seats: 2, player_prefab: chef, controls: [1, 2] })))).toBe('PP3960');
    expect(code(() => local_players(kw({ seats: 2, player_prefab: 'chef', controls: 'gamepads' })))).toBe('PP3960');
    expect(code(() => local_players(kw({ seats: 2, player_prefab: chef, controls: 'gamepads', split_screen: 'diagonal' })))).toBe('PP3960');
    expect(local_players(kw({ seats: 2, player_prefab: chef, controls: 'gamepads' })).id).toBe('local_players');
  });
});
