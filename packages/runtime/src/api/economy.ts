/**
 * `parallax.economy` (sdk/parallax/economy.pyi): the Wallet, Inventory, Shopkeeper,
 * Upgrades and Pickup handles, the economy events, the built-in
 * content kinds `item`, `loot_table`, `shop` and `upgrade` with their records, and the
 * `economy()` factory `parallax.plugins` re-exports. The behavior lives in the economy
 * plugin; this module is its Python-facing names and the content host it reads through.
 */

import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import {
  ECONOMY_EVENTS, economy as economyPlugin, INVENTORY, INVENTORY_SCHEMA, ITEM, LOOT_TABLE, PICKUP, PICKUP_SCHEMA, SHOP,
  SHOPKEEPER, SHOPKEEPER_SCHEMA, UPGRADE, UPGRADES, UPGRADES_SCHEMA, WALLET, WALLET_SCHEMA,
} from '../function/plugins/economy/index.js';
import type { ContentRefLike } from '../function/plugins/economy/index.js';
import { ContentRef } from './content.js';
import type { Context } from './context.js';
import { content, declareBuiltIns, record } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs, kw } from './kwargs.js';
import { field, ImageRef, Localized, PrefabRef, rt, Tag } from './types.js';

export { Drop } from '../function/plugins/economy/index.js';
export type { Bank, EconomyNamespace as EconomyApi } from '../function/plugins/economy/index.js';

/** `entity.get(Wallet)`: amounts, caps, generators; amount / earn / spend / can_afford / pay. */
export const Wallet = componentHandle({ id: WALLET, schema: WALLET_SCHEMA }, 'Wallet');
/** Slots, hotbar and equip slots: add / remove / count / equip / unequip / select / move… */
export const Inventory = componentHandle({ id: INVENTORY, schema: INVENTORY_SCHEMA }, 'Inventory');
/** Sells a `shop`: buy / sell / price / remaining / offers. */
export const Shopkeeper = componentHandle({ id: SHOPKEEPER, schema: SHOPKEEPER_SCHEMA }, 'Shopkeeper');
/** Upgrade drafts: draft / pick / grant / picks. */
export const Upgrades = componentHandle({ id: UPGRADES, schema: UPGRADES_SCHEMA }, 'Upgrades');
export const Pickup = componentHandle({ id: PICKUP, schema: PICKUP_SCHEMA }, 'Pickup');

export const PoolChanged = eventHandle(ECONOMY_EVENTS.poolChanged, 'PoolChanged');
export const ItemsChanged = eventHandle(ECONOMY_EVENTS.itemsChanged, 'ItemsChanged');
export const ItemEquipped = eventHandle(ECONOMY_EVENTS.equipped, 'ItemEquipped');
export const ItemUnequipped = eventHandle(ECONOMY_EVENTS.unequipped, 'ItemUnequipped');
export const ItemBought = eventHandle(ECONOMY_EVENTS.bought, 'ItemBought');
export const ItemSold = eventHandle(ECONOMY_EVENTS.sold, 'ItemSold');
export const UpgradePicked = eventHandle(ECONOMY_EVENTS.upgradePicked, 'UpgradePicked');
export const PickedUp = eventHandle(ECONOMY_EVENTS.pickedUp, 'PickedUp');

// ── Records ────────────────────────────────────────────────────────────────────

class StatBonusFields {
  static readonly __annotations__ = { component: () => rt.str, field: () => rt.str, multiply: () => rt.float, add: () => rt.float };
  static readonly multiply = field(1);
  static readonly add = field(0);
}
/** A stat change an item (while equipped) or an upgrade (once picked) applies: component id + field. */
export const StatBonus = record(StatBonusFields);

class GeneratorFields {
  static readonly __annotations__ = { pool: () => rt.str, amount: () => rt.float, every: () => rt.float, per_tag: () => rt.optional(Tag) };
  static readonly amount = field(1);
  static readonly every = field(1, kw({ min: 0.001, unit: 's' }));
  static readonly per_tag = field(null);
}
export const Generator = record(GeneratorFields);

class ItemStackFields {
  static readonly __annotations__ = { item: () => rt.optional(rt.generic(ContentRef, ItemDef)), count: () => rt.int };
  static readonly item = field(null);
  static readonly count = field(0, kw({ min: 0 }));
}
export const ItemStack = record(ItemStackFields);

class LootEntryFields {
  static readonly __annotations__ = {
    item: () => rt.optional(rt.generic(ContentRef, ItemDef)),
    pool: () => rt.optional(rt.str),
    table: () => rt.optional(rt.generic(ContentRef, LootTableDef)),
    weight: () => rt.float,
    min: () => rt.int,
    max: () => rt.int,
  };
  static readonly item = field(null);
  static readonly pool = field(null);
  static readonly table = field(null);
  static readonly weight = field(1, kw({ min: 0 }));
  static readonly min = field(1, kw({ min: 0 }));
  static readonly max = field(1, kw({ min: 0 }));
}
/** One loot entry: exactly one of item, pool or table, and min..max of it. */
export const LootEntry = record(LootEntryFields);

class ShopStockFields {
  static readonly __annotations__ = { item: () => rt.generic(ContentRef, ItemDef), price: () => rt.int, quantity: () => rt.int };
  static readonly price = field(kw({ min: 0 }));
  static readonly quantity = field(-1, kw({ min: -1, doc: '-1: unlimited.' }));
}
export const ShopStock = record(ShopStockFields);

// ── Content kinds ──────────────────────────────────────────────────────────────

class ItemFields {
  static readonly __annotations__ = {
    name: () => Localized,
    icon: () => rt.optional(ImageRef),
    max_stack: () => rt.int,
    value: () => rt.int,
    equip_slot: () => rt.optional(rt.str),
    bonuses: () => rt.list(StatBonus),
    pickup: () => rt.optional(PrefabRef),
  };
  static readonly icon = field(null);
  static readonly max_stack = field(1, kw({ min: 1 }));
  static readonly value = field(0, kw({ min: 0 }));
  static readonly equip_slot = field(null);
  static readonly bonuses = field([]);
  static readonly pickup = field(null);
}

class LootTableFields {
  static readonly __annotations__ = {
    rolls: () => rt.int,
    rolls_max: () => rt.optional(rt.int),
    nothing: () => rt.float,
    unique: () => rt.bool,
    entries: () => rt.list(LootEntry),
    guaranteed: () => rt.list(LootEntry),
  };
  static readonly rolls = field(1, kw({ min: 0 }));
  static readonly rolls_max = field(null);
  static readonly nothing = field(0, kw({ min: 0 }));
  static readonly unique = field(false);
  static readonly entries = field([]);
  static readonly guaranteed = field([]);
}

class ShopFields {
  static readonly __annotations__ = {
    name: () => Localized,
    currency: () => rt.str,
    stock: () => rt.list(ShopStock),
    sell_rate: () => rt.float,
    restock: () => rt.optional(rt.float),
  };
  static readonly stock = field([]);
  static readonly sell_rate = field(0.5, kw({ min: 0 }));
  static readonly restock = field(null, kw({ unit: 's' }));
}

class UpgradeFields {
  static readonly __annotations__ = {
    name: () => Localized,
    rarity: () => rt.str,
    weight: () => rt.float,
    max_picks: () => rt.int,
    requires: () => rt.list(rt.generic(ContentRef, UpgradeDef)),
    bonuses: () => rt.list(StatBonus),
  };
  static readonly rarity = field('common');
  static readonly weight = field(1, kw({ min: 0 }));
  static readonly max_picks = field(1, kw({ min: 1 }));
  static readonly requires = field([]);
  static readonly bonuses = field([]);
}

/** Built-in content kinds: games add entries in content/<kind>/*.json. */
export const ItemDef = declareBuiltIns(() => content(ITEM)(ItemFields), 'economy');
export const LootTableDef = declareBuiltIns(() => content(LOOT_TABLE)(LootTableFields), 'economy');
export const ShopDef = declareBuiltIns(() => content(SHOP)(ShopFields), 'economy');
export const UpgradeDef = declareBuiltIns(() => content(UPGRADE)(UpgradeFields), 'economy');

const KINDS: Readonly<Record<string, unknown>> = { [ITEM]: ItemDef, [LOOT_TABLE]: LootTableDef, [SHOP]: ShopDef, [UPGRADE]: UpgradeDef };

function listOf(kernel: Kernel, kind: string): Iterable<ContentRefLike> {
  return (kernel.context as Context).content(KINDS[kind]) as unknown as Iterable<ContentRefLike>;
}

/** `parallax.plugins.economy()`. */
export function economy(...args: unknown[]): KernelPlugin {
  bindArgs('economy', args, {});
  return economyPlugin({
    host: {
      content: (kernel, kind, id) => (kernel.context as Context).content(KINDS[kind]).get(id) as unknown as ContentRefLike,
      all: (kernel, kind) => [...listOf(kernel, kind)],
      tag: (id) => Tag.of(id),
    },
  });
}
