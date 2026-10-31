/**
 * economy — the things games trade, carry and find (sdk/parallax/economy.pyi): wallets and
 * the game-wide bank (pools with generators), inventories with a hotbar and equip slots,
 * shops, loot tables, upgrade drafts and pickups. Content kinds `item`, `loot_table`,
 * `shop` and `upgrade` are declared by the api (it decodes them); this plugin reads them
 * through the host it is given. (Projectiles live in combat, doors in interaction, wave
 * spawners in spawning.)
 *
 * Order each frame: the `economy.upkeep` system (before the game's systems) runs
 * generators, restocks and pickups on frame time. Cross-plugin effects go through SDK
 * component ids and their public methods only, never by importing a plugin.
 *
 * One `economy(...)` value serves one kernel.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { economyComponents } from './components.js';
import { economyNamespace } from './namespace.js';
import { BANK, BANK_SCHEMA, ECONOMY_EVENTS, SHOPKEEPER, WALLET } from './schemas.js';
import { EconomyState, rows } from './state.js';
import type { EconomyHost, Snapshot } from './state.js';
import { restock, tickShop } from './trade.js';
import { tickPickups } from './world.js';

export {
  BANK, ECONOMY_EVENTS, INVENTORY, INVENTORY_SCHEMA, ITEM, LOOT_TABLE, PICKUP, PICKUP_SCHEMA, SHOP, SHOPKEEPER, SHOPKEEPER_SCHEMA,
  UPGRADE, UPGRADES, UPGRADES_SCHEMA, WALLET, WALLET_SCHEMA,
} from './schemas.js';
export { Drop } from './namespace.js';
export type { Bank, EconomyNamespace } from './namespace.js';
export { MAX_LOOT_DEPTH, rollTable } from './loot.js';
export type { DropSpec } from './loot.js';
export type { ContentRefLike, EconomyHost } from './state.js';

export interface EconomyOptions {
  readonly host: EconomyHost;
}

export function economy(options: EconomyOptions): KernelPlugin {
  let state: EconomyState | undefined;
  let installedOn: Kernel | undefined;
  const current = (): EconomyState => state ?? fail('PP7190', 'The economy plugin is used before its kernel was built');
  const system: SystemDef = {
    id: 'economy.upkeep',
    scenes: [],
    handlers: [],
    create: () => ({
      update: (_ctx: unknown, dt: number) => {
        const s = current();
        s.generate(null, s.bank(), dt);
        for (const [id, wallet] of rows(s.kernel, WALLET)) s.generate(id, wallet, dt);
        for (const [, keeper] of rows(s.kernel, SHOPKEEPER)) tickShop(s, keeper);
        tickPickups(s, dt);
      },
    }),
  };
  return {
    id: 'economy',
    components: economyComponents(current),
    resources: [{ id: BANK, schema: BANK_SCHEMA }],
    events: Object.values(ECONOMY_EVENTS),
    systems: [system],
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP7191', 'This economy plugin is already installed in another kernel', { fix: 'Call economy() once per kernel.' });
      }
      installedOn = kernel;
      const created = new EconomyState(kernel, options.host);
      state = created;
      kernel.observeScenes({ loading: (_scene, request) => created.reseed(request.seed ?? 0) });
      kernel.observeEntities({
        added: (records) => {
          for (const record of records) {
            const keeper = record.components.get(SHOPKEEPER);
            // A fresh shopkeeper (not a restored or saved one) opens with full stock.
            if (keeper !== undefined && Object.keys(keeper['stock'] as object).length === 0 && (keeper['restock_at'] as number) < 0) {
              restock(created, keeper);
            }
          }
        },
      });
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved as unknown as Snapshot),
    namespace: { name: 'economy', create: () => economyNamespace(current) },
  };
}
