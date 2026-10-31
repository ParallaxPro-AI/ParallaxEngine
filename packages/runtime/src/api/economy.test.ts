/**
 * `parallax.economy` the way a game uses it: `plugins.economy()` next to `plugins.combat()`,
 * content decoded through the declared kinds (defaults filled, refs as ContentRefs),
 * component methods with ContentRef arguments, loot through `ctx.economy`, and a projectile
 * (`ctx.combat.fire`) hurting a real combat Health through its damage pipeline.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { combat, Health } from './combat.js';
import { Drop, economy, Inventory, ItemDef, LootTableDef, UpgradeDef, Upgrades, Wallet } from './economy.js';
import { content, createRuntime, EntityRef, field, Game, kw, resetDeclarations, rt, SceneRef } from './index.js';
import type { GameRuntime } from './index.js';
import { PrefabRef } from './types.js';

const STEP = 1 / 60;

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function setup(seed = 5): GameRuntime {
  const projectFiles = files({
    'content/item/potion.json': { name: 'Potion', max_stack: 3 },
    'content/item/blade.json': { name: 'Blade', equip_slot: 'hand', bonuses: [{ component: 'health', field: 'max', add: 50 }] },
    'content/upgrade/swift.json': { name: 'Swift', bonuses: [{ component: 'health', field: 'max', add: 5 }] },
    'content/upgrade/tough.json': { name: 'Tough', bonuses: [{ component: 'health', field: 'max', add: 10 }] },
    'content/loot_table/crate.json': { rolls: 1, entries: [{ item: 'potion', min: 2, max: 2 }], guaranteed: [{ pool: 'gold', min: 3, max: 3 }] },
    'prefabs/hero.prefab.json': { components: { wallet: {}, inventory: { size: 3, equip_slots: ['hand'] }, health: {}, upgrades: {} } },
    'prefabs/dummy.prefab.json': { components: { health: { max: 100, current: 100 } } },
    'prefabs/bullet.prefab.json': { components: { projectile: { speed: 40, damage: 30 } } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'hero', id: 'hero', at: [0, 0, 0] },
        { prefab: 'dummy', id: 'dummy', at: [0, 0, 6] },
      ],
    },
  });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({
    id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', plugins: [combat(), economy()],
  }));
  const r = createRuntime(game, project, {
    seed, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  r.start();
  r.step(STEP);
  return r;
}

describe('content kinds are scoped to their plugin', () => {
  it('without economy() a game declares its own "item" kind; with it, ItemDef owns the kind', () => {
    class ItemFields {
      static __annotations__ = { label: () => rt.str, weight: () => rt.float };
      static label = field('');
      static weight = field(1);
    }
    const Item = content('item')(ItemFields);
    const projectFiles = files({ 'content/item/rock.json': { label: 'Rock', weight: 3 }, 'scenes/main/scene.json': { entities: [] } });
    const project = loadProject(projectFiles);
    const make = (plugins: unknown[]): GameRuntime => createRuntime(new Game(kw({
      id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', plugins,
    })), project, {
      seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
      surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
    });
    const r = make([]);
    r.start();
    expect(((r.ctx as Any).content(Item).get('rock')).data.weight).toBe(3);
    // With economy() both declare "item": the game must extend ItemDef instead.
    expect(() => make([economy()])).toThrow(/PP2010/);
  });
});

describe('parallax.economy', () => {
  it('content decodes with defaults; inventories take ContentRefs; equip bonuses reach Health.max', () => {
    const r = setup();
    const ctx = r.ctx as Any;
    const potion = ctx.content(ItemDef).get('potion');
    const blade = ctx.content(ItemDef).get('blade');
    expect(blade.data.max_stack).toBe(1);
    const hero = ctx.world.placed(new EntityRef('hero'));
    const inv = hero.get(Inventory) as Any;
    expect(inv.add(potion, 5)).toBe(0);
    expect(inv.add(blade)).toBe(0);
    expect(inv.add(potion, 5)).toBe(4);
    expect(inv.item_at(0)).toBe(potion);
    expect(inv.equip(blade)).toBe(true);
    expect((hero.get(Health) as Any).max).toBe(150);
    expect(inv.worn('hand')).toBe(blade);
  });

  it('reads content-ref fields of engine components as ContentRefs, lists included', () => {
    const r = setup();
    const ctx = r.ctx as Any;
    const hero = ctx.world.placed(new EntityRef('hero'));
    const up = hero.get(Upgrades) as Any;
    const drafted = up.draft(2);
    const swift = ctx.content(UpgradeDef).get('swift');
    expect(up.offer).toEqual(drafted);
    expect(up.offer.map((u: Any) => u.id).sort()).toEqual(['swift', 'tough']);
    expect(up.offer).toContain(swift);
    up.pick(up.offer[0]);
    expect(up.offer).toEqual([]);
    up.offer = [swift];
    expect(up.offer[0]).toBe(swift);
    expect(r.kernel.world.require(r.kernel.handles.unwrap(hero)!).components.get('upgrades')!['offer']).toEqual(['swift']);
  });

  it('ctx.economy rolls and grants loot deterministically', () => {
    const a = setup(9);
    const ctx = a.ctx as Any;
    const crate = ctx.content(LootTableDef).get('crate');
    const drops = ctx.economy.roll(crate) as Drop[];
    expect(drops.map(String)).toEqual(['Drop(gold x3)', 'Drop(potion x2)']);
    expect(drops[1]!.item).toBe(ctx.content(ItemDef).get('potion'));
    const hero = ctx.world.placed(new EntityRef('hero'));
    expect(ctx.economy.grant(crate, hero)).toEqual([]);
    expect((hero.get(Wallet) as Any).amount('gold')).toBe(3);
  });

  it('a projectile hurts a combat Health through the damage pipeline, crediting its source', () => {
    const r = setup();
    const ctx = r.ctx as Any;
    const hero = ctx.world.placed(new EntityRef('hero'));
    const dummy = ctx.world.placed(new EntityRef('dummy'));
    ctx.combat.fire(new PrefabRef('bullet'), kw({ at: new Vec3(0, 0, 0), direction: new Vec3(0, 0, 1), source: hero }));
    for (let i = 0; i < 20; i++) r.step(STEP);
    expect((dummy.get(Health) as Any).current).toBe(70);
  });
});
