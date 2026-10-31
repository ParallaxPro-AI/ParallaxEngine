/**
 * Component ids, schemas, content kinds and events of the economy plugin
 * (sdk/parallax/economy.pyi). Field names are the SDK's verbatim; the extract pass reads
 * the stub, so both must say the same thing.
 */

import { t } from '../../kernel/index.js';
import type { EventDef, FieldSpec, FieldType, Schema } from '../../kernel/index.js';

export const WALLET = 'wallet';
export const INVENTORY = 'inventory';
export const SHOPKEEPER = 'shopkeeper';
export const UPGRADES = 'upgrades';
export const PICKUP = 'pickup';
/** The game-wide wallet (`ctx.economy.bank`). */
export const BANK = 'economy_bank';

export const ITEM = 'item';
export const LOOT_TABLE = 'loot_table';
export const SHOP = 'shop';
export const UPGRADE = 'upgrade';

export const ECONOMY_EVENTS = {
  poolChanged: { id: 'pool_changed', target: 'entity' },
  itemsChanged: { id: 'items_changed', target: 'entity' },
  equipped: { id: 'item_equipped', target: 'entity' },
  unequipped: { id: 'item_unequipped', target: 'entity' },
  bought: { id: 'item_bought', target: 'entity' },
  sold: { id: 'item_sold', target: 'entity' },
  upgradePicked: { id: 'upgrade_picked', target: 'entity' },
  pickedUp: { id: 'picked_up', target: 'entity' },
} as const satisfies Record<string, EventDef>;

const optional = (of: FieldType): FieldSpec => ({ type: { kind: 'optional', of }, default: null });
const ref = (to: string): FieldType => ({ kind: 'ref', to });
const record = (fields: Schema): FieldType => ({ kind: 'record', fields });

export const GENERATOR_RECORD: Schema = {
  pool: t.string(),
  amount: t.number({ default: 1 }),
  every: t.number({ default: 1, min: 0.001 }),
  per_tag: optional({ kind: 'tag' }),
};

const POOL_FIELDS: Schema = {
  amounts: { type: { kind: 'dict', of: { kind: 'number' } }, default: {} },
  caps: { type: { kind: 'dict', of: { kind: 'number' } }, default: {} },
  generators: t.list(record(GENERATOR_RECORD), { default: [] }),
  /** Seconds into each generator's period (kept by the engine). */
  clocks: t.list({ kind: 'number' }, { default: [] }),
};

export const WALLET_SCHEMA: Schema = POOL_FIELDS;
export const BANK_SCHEMA: Schema = POOL_FIELDS;

export const ITEM_STACK_RECORD: Schema = {
  item: optional(ref(`content/${ITEM}`)),
  count: t.int({ default: 0, min: 0 }),
};

export const INVENTORY_SCHEMA: Schema = {
  size: t.int({ default: 20, min: 1 }),
  /** The first `hotbar` slots are the hotbar. */
  hotbar: t.int({ default: 0, min: 0 }),
  /** Hotbar slot in hand (0-based). */
  selected: t.int({ default: 0, min: 0 }),
  equip_slots: t.list({ kind: 'string' }, { default: [] }),
  /** Slot contents; shorter than `size` means the rest are empty. */
  slots: t.list(record(ITEM_STACK_RECORD), { default: [] }),
  /** Equip slot → item worn there. */
  equipped: { type: { kind: 'dict', of: ref(`content/${ITEM}`) }, default: {} },
};

export const SHOPKEEPER_SCHEMA: Schema = {
  shop: t.ref(`content/${SHOP}`),
  /** Item → units left (kept by the engine; unlimited stock isn't listed). */
  stock: { type: { kind: 'dict', of: { kind: 'int' } }, default: {} },
  /** `ctx.time.now` of the next restock; -1: none pending (kept by the engine). */
  restock_at: t.number({ default: -1 }),
};

export const UPGRADES_SCHEMA: Schema = {
  /** Upgrade → times picked (kept by the engine). */
  picked: { type: { kind: 'dict', of: { kind: 'int' } }, default: {} },
  /** The draft on offer (kept by the engine). */
  offer: t.list(ref(`content/${UPGRADE}`), { default: [] }),
};

export const PICKUP_SCHEMA: Schema = {
  item: optional(ref(`content/${ITEM}`)),
  pool: optional({ kind: 'string' }),
  count: t.number({ default: 1, min: 0 }),
  radius: t.number({ default: 1, min: 0 }),
  magnet: t.number({ default: 0, min: 0 }),
  magnet_speed: t.number({ default: 8, min: 0 }),
  collector_tag: optional({ kind: 'tag' }),
  respawn: { ...optional({ kind: 'number' }), min: 0 },
  /** `ctx.time.now` it comes back at; -1: it is out (kept by the engine). */
  respawn_at: t.number({ default: -1 }),
};
