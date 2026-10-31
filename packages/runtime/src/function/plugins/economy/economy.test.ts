/**
 * The economy plugin on a bare kernel, with a stand-in content host (raw JSON content —
 * the api decodes it in real games), a `character` with a modifiable stat for bonuses,
 * and the interaction plugin (with a stand-in actions service) for doors whose keys are
 * economy items.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { Fields, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { ACTIONS_SERVICE } from '../../services/index.js';
import { DOOR_EVENTS, INTERACTION_EVENTS, interaction } from '../interaction/index.js';
import { ECONOMY_EVENTS, economy } from './index.js';
import type { EconomyHost, EconomyNamespace } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** A Python dict as game code passes it (pyrt dicts give their contents through toJSON). */
function dict(o: Record<string, number>): object {
  return Object.create({ toJSON: () => o }) as object;
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

const host: EconomyHost = {
  content: (k, kind, id) => {
    const entry = k.project.content.get(kind)?.get(id);
    if (entry === undefined) throw new Error(`no ${kind} ${id}`);
    return { id, kind, data: entry.values };
  },
  all: (k, kind) => [...(k.project.content.get(kind)?.values() ?? [])].map((e) => ({ id: e.id, kind, data: e.values })),
  tag: (id) => `tag:${id}`,
};

/** A component's fields with its engine methods, as game code calls them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Component = Record<string, any>;

interface Rig {
  readonly kernel: Kernel;
  readonly heard: string[];
  readonly ns: EconomyNamespace;
  step(frames?: number): void;
  id(placed: string): EntityId;
  get(placed: string, component: string): Component;
}

const CONTENT = {
  'content/item/coin.json': { name: 'Coin', max_stack: 99, value: 1 },
  'content/item/potion.json': { name: 'Potion', max_stack: 5, value: 10, pickup: 'potion_drop' },
  'content/item/sword.json': { name: 'Sword', value: 40, equip_slot: 'hand', bonuses: [{ component: 'character', field: 'walk_speed', multiply: 0.9 }] },
  'content/item/boots.json': { name: 'Boots', value: 20, equip_slot: 'feet', bonuses: [{ component: 'character', field: 'walk_speed', add: 2 }] },
  'content/item/key.json': { name: 'Key' },
  'content/loot_table/chest.json': {
    rolls: 2, rolls_max: 4,
    guaranteed: [{ pool: 'gold', min: 5, max: 10 }],
    entries: [{ item: 'potion', weight: 3 }, { item: 'sword', weight: 1 }, { table: 'gems', weight: 2 }],
  },
  'content/loot_table/gems.json': { entries: [{ pool: 'gems', min: 1, max: 3 }] },
  'content/loot_table/loop_a.json': { entries: [{ table: 'loop_b' }] },
  'content/loot_table/loop_b.json': { entries: [{ table: 'loop_a' }] },
  'content/loot_table/bad.json': { entries: [{ item: 'coin', pool: 'gold' }] },
  'content/shop/smith.json': {
    name: 'Smith', currency: 'gold', sell_rate: 0.5, restock: 10,
    stock: [{ item: 'sword', price: 30, quantity: 1 }, { item: 'potion', price: 5 }],
  },
  'content/upgrade/swift.json': { name: 'Swift', weight: 1, max_picks: 2, bonuses: [{ component: 'character', field: 'walk_speed', multiply: 1.1 }] },
  'content/upgrade/swifter.json': { name: 'Swifter', weight: 1, requires: ['swift'], bonuses: [{ component: 'character', field: 'walk_speed', add: 1 }] },
  'content/upgrade/tough.json': { name: 'Tough', weight: 1 },
};

function rig(data: Record<string, unknown>, seed = 7): Rig {
  const heard: string[] = [];
  let kernelRef: Kernel | undefined;
  const fake: KernelPlugin = {
    id: 'fake_world',
    components: [
      { id: 'character', schema: { walk_speed: t.number({ default: 5, min: 0, modifiable: true }) } },
    ],
    install(k) {
      // Interaction reads its action each frame; nothing presses it here.
      k.provide(ACTIONS_SERVICE, {
        pressed: () => false,
        held: () => false,
        live: () => true,
        device: () => 'keyboard',
        find: () => undefined,
        names: () => [],
        glyphs: () => [],
      });
    },
  };
  const events = [...Object.values(ECONOMY_EVENTS), ...Object.values(DOOR_EVENTS)];
  const listener: SystemDef = {
    id: 'listen', scenes: [],
    handlers: events.map((event) => ({ event, method: event.id })),
    create: () => Object.fromEntries(events.map((event) => [event.id, (_ctx: unknown, e: Fields) => {
      const who = (v: unknown): string => (typeof v === 'number' ? kernelRef!.world.peek(v as EntityId)?.placedId ?? `#${v}` : String(v));
      const ENTITIES = ['by', 'source', 'target'];
      const shown = (k: string, v: unknown): string => typeof v === 'object' && v !== null && 'id' in (v as object) ? (v as { id: string }).id
        : v instanceof Vec3 ? 'vec' : ENTITIES.includes(k) ? who(v) : String(v);
      const parts = Object.entries(e).filter(([k]) => k !== 'entity').map(([k, v]) => `${k}=${shown(k, v)}`);
      heard.push(`${event.id} ${who(e['entity'])}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`);
    }])),
  };
  const plugin = economy({ host });
  const project = loadProject(files({ ...CONTENT, ...data }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project, game: { components: [], events: [], behaviors: [], systems: [listener], resources: [] },
    plugins: [fake, plugin, interaction({ action: 'interact' })],
  });
  kernelRef = kernel;
  kernel.start('main', { seed });
  const r: Rig = {
    kernel, heard,
    ns: plugin.namespace!.create(kernel) as EconomyNamespace,
    step(frames = 1) { for (let i = 0; i < frames; i++) kernel.step(DT); },
    id(placed) {
      const found = kernel.world.query([]).find(([id]) => kernel.world.get(id)?.placedId === placed);
      if (found === undefined) throw new Error(`no ${placed}`);
      return found[0];
    },
    get(placed, component) {
      return kernel.world.get(r.id(placed))!.components.get(component) as Component;
    },
  };
  return r;
}

function scene(entities: unknown[], prefabs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'prefabs/thing.prefab.json': { components: {} },
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  };
}

const player = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  prefab: 'thing', id: 'player', at: [0, 0, 0],
  components: { wallet: {}, inventory: { size: 4, hotbar: 2, equip_slots: ['hand', 'feet'] }, character: {}, upgrades: {}, ...extra },
});

describe('wallets', () => {
  it('generators pay on their rhythm, per tagged entity, up to the cap; pay is all or nothing', () => {
    const r = rig(scene([
      player({ wallet: { amounts: { gold: 10 }, caps: { gold: 20 }, generators: [{ pool: 'gold', amount: 2, every: 1, per_tag: 'mine' }, { pool: 'wood', amount: 1, every: 0.5 }] } }),
      { prefab: 'thing', id: 'm1', tags: ['mine'] }, { prefab: 'thing', id: 'm2', tags: ['mine'] },
    ]));
    r.step(61);
    const w = r.get('player', 'wallet');
    expect(w.amount('gold')).toBe(14);
    expect(w.amount('wood')).toBe(2);
    r.step(120);
    expect(w.amount('gold')).toBe(20);
    expect(w.pay(dict({ gold: 5, wood: 100 }))).toBe(false);
    expect(w.amount('gold')).toBe(20);
    expect(w.pay(dict({ gold: 5, wood: 3 }))).toBe(true);
    expect([w.amount('gold'), w.amount('wood')]).toEqual([15, 3]);
    expect(code(() => w.earn('gold', -1))).toBe('PP7105');
    expect(r.heard.filter((h) => h.startsWith('pool_changed player pool=gold')).length).toBeGreaterThan(0);
  });

  it('the bank is a game-wide wallet', () => {
    const r = rig(scene([]));
    r.ns.bank.earn('gems', 3);
    expect(r.ns.bank.amount('gems')).toBe(3);
    expect(r.ns.bank.spend('gems', 4)).toBe(false);
    r.step();
    expect(r.heard).toContain('pool_changed null pool=gems amount=3 delta=3');
  });
});

describe('inventory', () => {
  it('stacks by max_stack, returns leftovers, removes newest-first, and the hotbar holds a selection', () => {
    const r = rig(scene([player()]));
    const inv = r.get('player', 'inventory');
    expect(inv.add('potion', 12)).toBe(0);
    expect([inv.count_at(0), inv.count_at(1), inv.count_at(2)]).toEqual([5, 5, 2]);
    expect(inv.add('coin', 200)).toBe(101);
    expect(inv.room('potion')).toBe(3);
    expect(inv.remove('potion', 4)).toBe(true);
    expect([inv.count_at(0), inv.count_at(1), inv.count_at(2)]).toEqual([5, 3, 0]);
    expect(inv.remove('potion', 100)).toBe(false);
    inv.select(1);
    expect((inv as unknown as { held: { id: string } }).held.id).toBe('potion');
    expect(code(() => inv.select(2))).toBe('PP7111');
    inv.move(1, 3);
    expect(inv.item_at(1)).toMatchObject({ id: 'coin' });
    expect(inv.item_at(3)).toMatchObject({ id: 'potion' });
  });

  it('equip moves an item into its slot and applies its bonuses; swapping and unequipping take them off', () => {
    const r = rig(scene([player()]));
    const inv = r.get('player', 'inventory');
    const ch = r.get('player', 'character');
    inv.add('sword');
    inv.add('boots');
    expect(inv.equip('sword')).toBe(true);
    expect(inv.count('sword')).toBe(0);
    expect(ch['walk_speed']).toBeCloseTo(4.5);
    expect(inv.equip('boots')).toBe(true);
    expect(ch['walk_speed']).toBeCloseTo((5 + 2) * 0.9);
    expect(inv.unequip('hand')).toBe(true);
    expect(ch['walk_speed']).toBeCloseTo(7);
    expect(inv.count('sword')).toBe(1);
    expect(code(() => inv.equip('potion'))).toBe('PP7113');
    expect(code(() => inv.equip('sword', { slot: 'feet' }))).toBe('PP7113');
    r.step();
    expect(r.heard).toContain('item_equipped player item=sword slot=hand');
  });
});

describe('shops', () => {
  it('sells limited stock for the currency, restocks later, and buys back at value × sell_rate', () => {
    const r = rig(scene([player({ wallet: { amounts: { gold: 50 } } }), { prefab: 'thing', id: 'smith', components: { shopkeeper: { shop: 'smith' } } }]));
    const shop = r.get('smith', 'shopkeeper');
    const buyer = r.id('player');
    expect(shop.remaining('sword')).toBe(1);
    expect(shop.remaining('potion')).toBe(-1);
    expect(shop.buy(buyer, 'sword')).toBe(true);
    expect(shop.buy(buyer, 'sword')).toBe(false);
    expect(r.get('player', 'wallet').amount('gold')).toBe(20);
    expect(shop.buy(buyer, 'potion', 5)).toBe(false); // 25 > 20
    expect(shop.buy(buyer, 'potion', 4)).toBe(true);
    expect(code(() => shop.price('key'))).toBe('PP7130');
    r.step(Math.ceil(10 / DT) + 2);
    expect(shop.remaining('sword')).toBe(1);
    expect(shop.sell_price('sword')).toBe(20);
    expect(shop.sell(buyer, 'sword')).toBe(true);
    expect(r.get('player', 'wallet').amount('gold')).toBe(20);
    expect(r.heard).toContain(`item_bought smith source=player item=sword count=1 price=30`);
  });
});

describe('loot', () => {
  const rolls = (seed: number): string[] => {
    const r = rig(scene([]), seed);
    return [0, 1, 2].map(() => r.ns.roll('chest').map(String).join(','));
  };

  it('is deterministic per seed: guaranteed, a rolls range, weights and nested tables', () => {
    expect(rolls(3)).toEqual(rolls(3));
    expect(rolls(3)).not.toEqual(rolls(4));
    const r = rig(scene([]), 3);
    for (let i = 0; i < 50; i++) {
      const drops = r.ns.roll('chest');
      const gold = drops.find((d) => d.pool === 'gold')!;
      expect(gold.count).toBeGreaterThanOrEqual(5);
      expect(gold.count).toBeLessThanOrEqual(10);
      const draws = drops.filter((d) => d.pool !== 'gold').reduce((n, d) => n + (d.pool === 'gems' ? 1 : d.count), 0);
      expect(draws).toBeLessThanOrEqual(4);
    }
    expect(code(() => r.ns.roll('loop_a'))).toBe('PP7121');
    expect(code(() => r.ns.roll('bad'))).toBe('PP7120');
  });

  it('grant fills inventory and wallet and returns what did not fit; drop spawns pickups', () => {
    const r = rig(scene([player()], { potion_drop: { components: { pickup: { item: 'potion' } } } }), 3);
    const left = r.ns.grant('chest', r.id('player'));
    expect(r.get('player', 'wallet').amount('gold')).toBeGreaterThanOrEqual(5);
    expect(left).toEqual([]);
    const spawned = r.ns.drop('gems', new Vec3(0, 0, 9), { pool_prefab: 'potion_drop' });
    expect(spawned.length).toBe(1);
    expect(r.kernel.world.get(spawned[0] as EntityId)!.components.get('pickup')).toMatchObject({ item: null, pool: 'gems' });
  });
});

describe('upgrade drafts', () => {
  it('offers eligible upgrades by weight, picks apply stacked bonuses, and requirements unlock later picks', () => {
    const r = rig(scene([player()]));
    const up = r.get('player', 'upgrades');
    const ch = r.get('player', 'character');
    const offer = (up.draft(3) as Array<{ id: string }>).map((u) => u.id).sort();
    expect(offer).toEqual(['swift', 'tough']); // swifter needs swift
    up.pick('swift');
    expect(ch['walk_speed']).toBeCloseTo(5.5);
    expect(code(() => up.pick('swift'))).toBe('PP7140');
    expect((up.draft(3) as Array<{ id: string }>).map((u) => u.id).sort()).toEqual(['swift', 'swifter', 'tough']);
    up.pick('swift');
    expect(ch['walk_speed']).toBeCloseTo(5 * 1.1 * 1.1);
    expect((up.draft(3) as Array<{ id: string }>).map((u) => u.id).sort()).toEqual(['swifter', 'tough']);
    expect(up.grant('swift')).toBe(false);
    expect(up.picks('swift')).toBe(2);
  });
});

describe('pickups', () => {
  it('the nearest collector in reach takes what fits; magnets pull; respawning pickups hide and come back', () => {
    const r = rig(scene([
      player(),
      { prefab: 'thing', id: 'near', at: [0.5, 0, 0], components: { pickup: { item: 'potion', count: 7 } } },
      { prefab: 'thing', id: 'coin', at: [3, 0, 0], components: { pickup: { pool: 'gold', count: 5, radius: 0.5, magnet: 4, magnet_speed: 6 } } },
      { prefab: 'thing', id: 'gem', at: [0, 0, -0.5], components: { pickup: { pool: 'gems', count: 1, respawn: 2 } } },
    ]));
    const near = r.id('near');
    r.step();
    expect(r.get('player', 'inventory').count('potion')).toBe(7);
    expect(r.kernel.world.isAlive(near)).toBe(false);
    const gem = r.kernel.world.get(r.id('gem'))!;
    expect(gem.visible).toBe(false);
    r.step(40);
    expect(r.get('player', 'wallet').amount('gold')).toBe(5);
    expect(r.get('player', 'wallet').amount('gems')).toBe(1);
    const body = r.kernel.world.get(r.id('player'))!.transform;
    body.position = new Vec3(20, 0, 0);
    r.step(90);
    expect(gem.visible).toBe(true);
    body.position = Vec3.ZERO;
    r.step();
    expect(r.get('player', 'wallet').amount('gems')).toBe(2);
    expect(r.heard).toContain('picked_up coin source=player item=null pool=gold count=5');
    expect(code(() => { r.kernel.addComponent(r.id('player'), 'pickup', {}); r.step(); })).toBe('PP7150');
  });
});

const INTERACTED = INTERACTION_EVENTS.interacted;

// Doors are the interaction plugin's; they live here because their keys are economy items.
describe('doors', () => {
  it('a locked door refuses without its key, opens with it over its seconds, swings about the hinge, and closes by itself', () => {
    const r = rig(scene([
      player(),
      { prefab: 'thing', id: 'door', at: [0, 0, 2], components: { door: { locked: true, key: 'key', consume_key: true, seconds: 0.5, hinge: [-0.5, 0, 0], auto_close: 1 } } },
    ]));
    const door = r.get('door', 'door');
    const who = r.id('player');
    expect(door.open({ by: who })).toBe(false);
    r.step();
    expect(r.heard).toContain('door_blocked door source=player key=key');
    r.get('player', 'inventory').add('key');
    expect(door.open({ by: who })).toBe(true);
    expect(r.get('player', 'inventory').count('key')).toBe(0);
    r.step(31);
    const tr = r.kernel.world.get(r.id('door'))!.transform;
    expect(tr.rotation.to_euler().y).toBeCloseTo(90, 3);
    // The hinge at local (-0.5, 0, 0) stays put; the leaf's centre swings a quarter turn round it (+90° turns +x to -z).
    expect(tr.position.__add__(tr.rotation.rotate(new Vec3(-0.5, 0, 0))).is_close(new Vec3(-0.5, 0, 2))).toBe(true);
    expect(tr.position.is_close(new Vec3(-0.5, 0, 1.5))).toBe(true);
    expect(r.heard).toContain('door_opened door');
    expect((door as unknown as { is_open: boolean }).is_open).toBe(true);
    r.step(60 + 31);
    expect(r.heard).toContain('door_closed door');
    expect(tr.position.is_close(new Vec3(0, 0, 2))).toBe(true);
  });

  it('using an Interactable door (Interacted) toggles it, its user\'s key unlocking it', () => {
    const r = rig(scene([
      player(),
      { prefab: 'thing', id: 'door', at: [0, 0, 2], components: { door: { locked: true, key: 'key', seconds: 0 } } },
      { prefab: 'thing', id: 'gate', at: [5, 0, 2], components: { door: { seconds: 0, toggle_on_interact: false } } },
    ]));
    const use = (placed: string): void => {
      r.kernel.emit(INTERACTED, { entity: r.id(placed), source: r.id('player') });
      r.step();
    };
    use('door');
    expect(r.heard).toContain('door_blocked door source=player key=key');
    r.get('player', 'inventory').add('key');
    use('door');
    expect(r.get('door', 'door')['wants_open']).toBe(true);
    use('door');
    expect(r.get('door', 'door')['wants_open']).toBe(false);
    use('gate');
    expect(r.get('gate', 'door')['wants_open']).toBe(false);
  });

  it('joint doors drive the Model joint', () => {
    const r = rig({
      ...scene([{ prefab: 'thing', id: 'hatch', components: { door: { mode: 'joint', joint: 'lid', open_value: 110, seconds: 0, wants_open: true } } }]),
    });
    expect(code(() => r.step())).toBe('PP3583');
  });
});

describe('snapshots', () => {
  it('restore rewinds loot rolls with the random state; component state comes back with the entities', () => {
    const r = rig(scene([player({ wallet: { amounts: { gold: 3 } } })]), 11);
    r.step();
    const snap = r.kernel.snapshot();
    const first = r.ns.roll('chest').map(String);
    r.get('player', 'wallet').earn('gold', 100);
    r.get('player', 'inventory').add('potion', 2);
    r.kernel.restore(snap);
    expect(r.ns.roll('chest').map(String)).toEqual(first);
    expect(r.get('player', 'wallet').amount('gold')).toBe(3);
    expect(r.get('player', 'inventory').count('potion')).toBe(0);
  });
});
