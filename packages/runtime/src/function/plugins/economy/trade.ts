/**
 * Shops and upgrade drafts.
 *
 * Shops (`shop` content, sold by a `Shopkeeper`): each `stock` entry sells an item for
 * `price` of the shop's `currency` pool, `quantity` units (-1: unlimited). Units left are
 * kept on the shopkeeper (`stock`); after a sale, `restock` seconds later every entry is
 * back to its quantity. A buyer needs a Wallet and an Inventory with room; a sale is all
 * or nothing. Selling pays `item.value × sell_rate` per unit (rounded down); a shop with
 * `sell_rate` 0 buys nothing.
 *
 * Upgrade drafts (`upgrade` content, on an `Upgrades` component): `draft(n)` offers up to n
 * different upgrades drawn by `weight` among those picked fewer than `max_picks` times
 * whose `requires` are all picked; `pick(upgrade)` takes one from the offer, applies its
 * `bonuses` as permanent stacked stat modifiers (saved with the entity), and clears the
 * offer. `grant(upgrade)` applies one without a draft (bought, scripted).
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import { attr, dictOf, idOf, listOf, num } from './args.js';
import { add, countOf, remove, room } from './inventory.js';
import { ECONOMY_EVENTS, INVENTORY, ITEM, SHOP, UPGRADE } from './schemas.js';
import { bonusesOf } from './state.js';
import type { EconomyState } from './state.js';

// ── Shops ──────────────────────────────────────────────────────────────────────

interface Offer {
  readonly item: string;
  readonly price: number;
  readonly quantity: number;
}

export function offersOf(s: EconomyState, keeper: Fields): Offer[] {
  const shop = idOf(keeper['shop'])!;
  return listOf<unknown>(attr(s.data(SHOP, shop), 'stock')).map((e) => ({
    item: idOf(attr(e, 'item'))!, price: num(e, 'price', 0), quantity: num(e, 'quantity', -1),
  }));
}

/** Fill `stock` with every limited entry's quantity (on first sight and at restock). */
export function restock(s: EconomyState, keeper: Fields): void {
  const stock: Record<string, number> = {};
  for (const o of offersOf(s, keeper)) if (o.quantity >= 0) stock[o.item] = (stock[o.item] ?? 0) + o.quantity;
  keeper['stock'] = stock;
  keeper['restock_at'] = -1;
}

function offer(s: EconomyState, keeper: Fields, item: string, where: string): Offer {
  const found = offersOf(s, keeper).find((o) => o.item === item);
  if (found === undefined) {
    fail('PP7130', `${where}: shop "${idOf(keeper['shop'])}" doesn't sell "${item}"`, {
      fix: `Check shopkeeper.offers first, or add {"item": "${item}", "price": ...} to its stock.`,
    });
  }
  return found;
}

export function price(s: EconomyState, keeper: Fields, item: string): number {
  return offer(s, keeper, item, `price("${item}")`).price;
}

/** Units left; -1 when unlimited. */
export function remaining(s: EconomyState, keeper: Fields, item: string): number {
  const o = offer(s, keeper, item, `remaining("${item}")`);
  return o.quantity < 0 ? -1 : dictOf<number>(keeper['stock'])[item] ?? 0;
}

function currency(s: EconomyState, keeper: Fields): string {
  return String(attr(s.data(SHOP, idOf(keeper['shop'])!), 'currency'));
}

export function buy(s: EconomyState, shopkeeper: EntityId, keeper: Fields, buyer: EntityId, item: string, n: number): boolean {
  const o = offer(s, keeper, item, `buy("${item}")`);
  const wallet = s.wallet(buyer, `buy("${item}")`);
  const inv = s.require(buyer, INVENTORY, `buy("${item}")`);
  const left = remaining(s, keeper, item);
  if (n === 0 || (left >= 0 && left < n) || room(s, inv, item) < n) return false;
  const pool = currency(s, keeper);
  if (!s.pay(buyer, wallet, { [pool]: o.price * n })) return false;
  add(s, buyer, inv, item, n);
  if (left >= 0) keeper['stock'] = { ...dictOf<number>(keeper['stock']), [item]: left - n };
  const every = attr(s.data(SHOP, idOf(keeper['shop'])!), 'restock');
  if (typeof every === 'number' && (keeper['restock_at'] as number) < 0) keeper['restock_at'] = s.kernel.time.now + every;
  s.emit(ECONOMY_EVENTS.bought, { entity: s.wrap(shopkeeper), source: s.wrap(buyer), item: s.ref(ITEM, item), count: n, price: o.price * n });
  return true;
}

export function sellPrice(s: EconomyState, keeper: Fields, item: string): number {
  const rate = num(s.data(SHOP, idOf(keeper['shop'])!), 'sell_rate', 0.5);
  return Math.floor(num(s.data(ITEM, item), 'value', 0) * rate);
}

export function sell(s: EconomyState, shopkeeper: EntityId, keeper: Fields, seller: EntityId, item: string, n: number): boolean {
  const wallet = s.wallet(seller, `sell("${item}")`);
  const inv = s.require(seller, INVENTORY, `sell("${item}")`);
  const rate = num(s.data(SHOP, idOf(keeper['shop'])!), 'sell_rate', 0.5);
  if (n === 0 || rate <= 0 || countOf(inv, item) < n) return false;
  const each = sellPrice(s, keeper, item);
  remove(s, seller, inv, item, n);
  s.earn(seller, wallet, currency(s, keeper), each * n);
  s.emit(ECONOMY_EVENTS.sold, { entity: s.wrap(shopkeeper), source: s.wrap(seller), item: s.ref(ITEM, item), count: n, price: each * n });
  return true;
}

export function tickShop(s: EconomyState, keeper: Fields): void {
  const at = keeper['restock_at'] as number;
  if (at >= 0 && s.kernel.time.now >= at) restock(s, keeper);
}

// ── Upgrade drafts ─────────────────────────────────────────────────────────────

export function picks(up: Fields, upgrade: string): number {
  return dictOf<number>(up['picked'])[upgrade] ?? 0;
}

function eligible(s: EconomyState, up: Fields, id: string): boolean {
  const data = s.data(UPGRADE, id);
  if (picks(up, id) >= num(data, 'max_picks', 1)) return false;
  return listOf<unknown>(attr(data, 'requires')).every((r) => picks(up, idOf(r)!) > 0);
}

export function draft(s: EconomyState, up: Fields, n: number, from: readonly string[] | null): string[] {
  const pool = (from ?? s.host.all(s.kernel, UPGRADE).map((r) => r.id)).filter((id) => eligible(s, up, id));
  const weights = pool.map((id) => Math.max(0, num(s.data(UPGRADE, id), 'weight', 1)));
  const chosen: string[] = [];
  while (chosen.length < n) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let pick = s.random.next() * total;
    // Rounding past the end lands on the last one still in.
    let i = -1;
    for (let k = 0; k < pool.length; k++) {
      if (weights[k] === 0) continue;
      i = k;
      pick -= weights[k]!;
      if (pick < 0) break;
    }
    chosen.push(pool[i]!);
    weights[i] = 0;
  }
  up['offer'] = chosen;
  return chosen;
}

function apply(s: EconomyState, owner: EntityId, up: Fields, upgrade: string): void {
  s.applyBonuses(owner, bonusesOf(s.data(UPGRADE, upgrade)), { stack: true }, `upgrade "${upgrade}"`);
  const count = picks(up, upgrade) + 1;
  up['picked'] = { ...dictOf<number>(up['picked']), [upgrade]: count };
  s.emit(ECONOMY_EVENTS.upgradePicked, { entity: s.wrap(owner), upgrade: s.ref(UPGRADE, upgrade), picks: count });
}

export function pick(s: EconomyState, owner: EntityId, up: Fields, upgrade: string): void {
  const offer = listOf<unknown>(up['offer']).map((r) => idOf(r));
  if (!offer.includes(upgrade)) {
    fail('PP7140', `pick("${upgrade}"): it isn't in the current draft (${offer.join(', ') || 'none offered'})`, {
      fix: 'Pick one of upgrades.offer (from draft()), or apply it directly with grant().',
    });
  }
  up['offer'] = [];
  apply(s, owner, up, upgrade);
}

export function grant(s: EconomyState, owner: EntityId, up: Fields, upgrade: string): boolean {
  if (!eligible(s, up, upgrade)) return false;
  apply(s, owner, up, upgrade);
  return true;
}
