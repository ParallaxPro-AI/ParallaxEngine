/**
 * `ctx.economy` (EconomyApi in sdk/parallax/economy.pyi): the game-wide bank, loot rolls,
 * and drops. Python-style arguments throughout. (Projectiles are `ctx.combat.fire`.)
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import { attr, bind, contentId, dictOf, idOf, nonNegative, optionalEntity, point } from './args.js';
import { walletMethods } from './components.js';
import { add } from './inventory.js';
import { rollTable } from './loot.js';
import type { DropSpec } from './loot.js';
import { INVENTORY, ITEM, LOOT_TABLE, PICKUP } from './schemas.js';
import type { EconomyState } from './state.js';

/** One rolled drop: an item (ContentRef) or a wallet pool, and how many. */
export class Drop {
  readonly item: unknown;
  readonly pool: string | null;
  readonly count: number;

  constructor(item: unknown, pool: string | null, count: number) {
    this.item = item;
    this.pool = pool;
    this.count = count;
  }

  toString(): string {
    const what = this.pool ?? (this.item as { id?: string } | null)?.id ?? '?';
    return `Drop(${what} x${this.count})`;
  }
}

export interface Bank {
  readonly amounts: Readonly<Record<string, number>>;
  amount(...args: unknown[]): number;
  earn(...args: unknown[]): number;
  spend(...args: unknown[]): boolean;
  can_afford(...args: unknown[]): boolean;
  pay(...args: unknown[]): boolean;
}

export interface EconomyNamespace {
  readonly bank: Bank;
  /** roll(table) -> list[Drop] */
  roll(...args: unknown[]): Drop[];
  /** grant(table, to) -> list[Drop]: what didn't fit */
  grant(...args: unknown[]): Drop[];
  /** drop(table, at, *, spread=0.6, pool_prefab=None) -> list[Entity] */
  drop(...args: unknown[]): unknown[];
}

export function economyNamespace(state: () => EconomyState): EconomyNamespace {
  const wallet = walletMethods(state, () => null) as Record<string, (...args: unknown[]) => unknown>;
  const onBank = <T>(name: string) => (...args: unknown[]): T => wallet[name]!.apply(state().bank(), args) as T;
  const bank: Bank = {
    get amounts() { return dictOf<number>(state().bank()['amounts']); },
    amount: onBank('amount'),
    earn: onBank('earn'),
    spend: onBank('spend'),
    can_afford: onBank('can_afford'),
    pay: onBank('pay'),
  };
  const roll = (table: unknown, where: string): DropSpec[] => {
    const s = state();
    return rollTable((kind, id) => s.data(kind, id), s.random, contentId(table, LOOT_TABLE, where));
  };
  const present = (d: DropSpec): Drop => new Drop(state().ref(ITEM, d.item), d.pool, d.count);
  return {
    bank,
    roll(...args) {
      const a = bind('roll', args, ['table'], [], ['table']);
      return roll(a['table'], 'roll() table').map(present);
    },
    grant(...args) {
      const a = bind('grant', args, ['table', 'to'], [], ['table', 'to']);
      const s = state();
      const to = optionalEntity(s.kernel.handles, a['to'], 'grant() to') ?? fail('PP7102', 'grant() to must be an Entity, got None');
      const left: Drop[] = [];
      for (const d of roll(a['table'], 'grant() table')) {
        if (d.item !== null) {
          const rest = add(s, to, s.require(to, INVENTORY, 'grant()'), d.item, d.count);
          if (rest > 0) left.push(present({ ...d, count: rest }));
        } else {
          const got = s.earn(to, s.wallet(to, 'grant()'), d.pool!, d.count);
          if (got < d.count) left.push(present({ ...d, count: d.count - got }));
        }
      }
      return left;
    },
    drop(...args) {
      const a = bind('drop', args, ['table', 'at'], ['spread', 'pool_prefab'], ['table', 'at']);
      const s = state();
      const at = point(a['at'], 'drop() at');
      const spread = a['spread'] === undefined ? 0.6 : nonNegative(a['spread'], 'drop() spread');
      const poolPrefab = idOf(a['pool_prefab']);
      const drops = roll(a['table'], 'drop() table');
      return drops.map((d, i) => {
        let prefab: string | null;
        if (d.item !== null) {
          prefab = idOf(attr(s.data(ITEM, d.item), 'pickup'));
          if (prefab === null) fail('PP7122', `drop(): item "${d.item}" has no pickup prefab`, { fix: `Give content/item/${d.item}.json a "pickup" prefab with a Pickup component.` });
        } else {
          prefab = poolPrefab;
          if (prefab === null) fail('PP7122', `drop(): the table dropped ${d.count} ${d.pool}, and no pool_prefab was given`, { fix: 'Pass pool_prefab=Prefabs.coin (a prefab with a Pickup).' });
        }
        // A ring around `at`, the same every time for the same roll.
        const angle = (i / Math.max(1, drops.length)) * Math.PI * 2;
        const offset = drops.length === 1 ? Vec3.ZERO : new Vec3(Math.cos(angle) * spread, 0, Math.sin(angle) * spread);
        const p = at.__add__(offset);
        const pickup: Fields = d.item !== null ? { item: d.item, pool: null, count: d.count } : { item: null, pool: d.pool, count: d.count };
        const record = s.kernel.spawn(prefab, { at: [p.x, p.y, p.z] }, { components: { [PICKUP]: pickup } });
        return s.wrap(record.id);
      });
    },
  };
}
