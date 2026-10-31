/**
 * The economy's engine components and their methods (sdk/parallax/economy.pyi). Methods
 * run with `this` = the component's fields; the owner is `componentEntity(this)`.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { ComponentDef, Fields } from '../../kernel/index.js';
import { bind, contentId, count, dictOf, finite, listOf, nonNegative, optionalEntity, text } from './args.js';
import * as inv from './inventory.js';
import {
  INVENTORY, INVENTORY_SCHEMA, ITEM, PICKUP, PICKUP_SCHEMA, SHOPKEEPER, SHOPKEEPER_SCHEMA, UPGRADE, UPGRADES, UPGRADES_SCHEMA,
  WALLET, WALLET_SCHEMA,
} from './schemas.js';
import type { EconomyState } from './state.js';
import * as trade from './trade.js';

type State = () => EconomyState;

function owner(fields: unknown): EntityId {
  return componentEntity(fields as Fields);
}

function withEntity(state: State, methods: object, getters: Record<string, (fields: Fields) => unknown> = {}): object {
  Object.defineProperty(methods, 'entity', {
    get(this: Fields): unknown { return state().kernel.handles.wrap(owner(this)); },
    enumerable: false,
  });
  for (const [name, read] of Object.entries(getters)) {
    Object.defineProperty(methods, name, { get(this: Fields): unknown { return read(this); }, enumerable: false });
  }
  return methods;
}

/** A `{pool: cost}` argument (a dict). */
function costs(value: unknown, where: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pool, cost] of Object.entries(dictOf<unknown>(value))) out[pool] = nonNegative(cost, `${where}["${pool}"]`);
  return out;
}

/** Wallet methods over any pool fields: a Wallet component, or the bank resource (`ownerOf` null). */
export function walletMethods(state: State, ownerOf: (fields: Fields) => EntityId | null): Record<string, unknown> {
  return {
    amount(this: Fields, ...args: unknown[]): number {
      const a = bind('amount', args, ['pool'], [], ['pool']);
      return state().amount(this, text(a['pool'], 'amount() pool'));
    },
    earn(this: Fields, ...args: unknown[]): number {
      const a = bind('earn', args, ['pool', 'amount'], [], ['pool', 'amount']);
      return state().earn(ownerOf(this), this, text(a['pool'], 'earn() pool'), finite(a['amount'], 'earn() amount'));
    },
    spend(this: Fields, ...args: unknown[]): boolean {
      const a = bind('spend', args, ['pool', 'amount'], [], ['pool', 'amount']);
      return state().spend(ownerOf(this), this, text(a['pool'], 'spend() pool'), nonNegative(a['amount'], 'spend() amount'));
    },
    can_afford(this: Fields, ...args: unknown[]): boolean {
      const a = bind('can_afford', args, ['costs'], [], ['costs']);
      return state().canAfford(this, costs(a['costs'], 'can_afford() costs'));
    },
    pay(this: Fields, ...args: unknown[]): boolean {
      const a = bind('pay', args, ['costs'], [], ['costs']);
      return state().pay(ownerOf(this), this, costs(a['costs'], 'pay() costs'));
    },
  };
}

function item(value: unknown, where: string): string {
  return contentId(value, ITEM, where);
}

function inventoryMethods(state: State): object {
  return withEntity(state, {
    add(this: Fields, ...args: unknown[]): number {
      const a = bind('add', args, ['item', 'count'], [], ['item']);
      return inv.add(state(), owner(this), this, item(a['item'], 'add() item'), a['count'] === undefined ? 1 : count(a['count'], 'add() count'));
    },
    remove(this: Fields, ...args: unknown[]): boolean {
      const a = bind('remove', args, ['item', 'count'], [], ['item']);
      return inv.remove(state(), owner(this), this, item(a['item'], 'remove() item'), a['count'] === undefined ? 1 : count(a['count'], 'remove() count'));
    },
    count(this: Fields, ...args: unknown[]): number {
      const a = bind('count', args, ['item'], [], ['item']);
      return inv.countOf(this, item(a['item'], 'count() item'));
    },
    has(this: Fields, ...args: unknown[]): boolean {
      const a = bind('has', args, ['item', 'count'], [], ['item']);
      return inv.countOf(this, item(a['item'], 'has() item')) >= (a['count'] === undefined ? 1 : count(a['count'], 'has() count'));
    },
    room(this: Fields, ...args: unknown[]): number {
      const a = bind('room', args, ['item'], [], ['item']);
      return inv.room(state(), this, item(a['item'], 'room() item'));
    },
    item_at(this: Fields, ...args: unknown[]): unknown {
      const a = bind('item_at', args, ['slot'], [], ['slot']);
      return state().ref(ITEM, inv.stackAt(this, count(a['slot'], 'item_at() slot')).item);
    },
    count_at(this: Fields, ...args: unknown[]): number {
      const a = bind('count_at', args, ['slot'], [], ['slot']);
      return inv.stackAt(this, count(a['slot'], 'count_at() slot')).count;
    },
    move(this: Fields, ...args: unknown[]): null {
      const a = bind('move', args, ['source', 'destination'], [], ['source', 'destination']);
      inv.move(state(), owner(this), this, count(a['source'], 'move() source'), count(a['destination'], 'move() destination'));
      return null;
    },
    select(this: Fields, ...args: unknown[]): null {
      const a = bind('select', args, ['slot'], [], ['slot']);
      inv.select(this, count(a['slot'], 'select() slot'));
      return null;
    },
    equip(this: Fields, ...args: unknown[]): boolean {
      const a = bind('equip', args, ['item'], ['slot'], ['item']);
      const slot = a['slot'] === undefined || a['slot'] === null ? null : text(a['slot'], 'equip() slot');
      return inv.equip(state(), owner(this), this, item(a['item'], 'equip() item'), slot);
    },
    unequip(this: Fields, ...args: unknown[]): boolean {
      const a = bind('unequip', args, ['slot'], [], ['slot']);
      return inv.unequip(state(), owner(this), this, text(a['slot'], 'unequip() slot'));
    },
    worn(this: Fields, ...args: unknown[]): unknown {
      const a = bind('worn', args, ['slot'], [], ['slot']);
      const slot = text(a['slot'], 'worn() slot');
      if (!listOf<string>(this['equip_slots']).includes(slot)) fail('PP7112', `worn("${slot}"): the inventory has no equip slot "${slot}"`);
      return state().ref(ITEM, inv.equippedOf(this)[slot] ?? null);
    },
  }, {
    held: (fields) => state().ref(ITEM, inv.selected(fields)),
  });
}

function shopMethods(state: State): object {
  const who = (value: unknown, where: string): EntityId => optionalEntity(state().kernel.handles, value, where)
    ?? fail('PP7102', `${where} must be an Entity, got None`);
  return withEntity(state, {
    price(this: Fields, ...args: unknown[]): number {
      const a = bind('price', args, ['item'], [], ['item']);
      return trade.price(state(), this, item(a['item'], 'price() item'));
    },
    sell_price(this: Fields, ...args: unknown[]): number {
      const a = bind('sell_price', args, ['item'], [], ['item']);
      return trade.sellPrice(state(), this, item(a['item'], 'sell_price() item'));
    },
    remaining(this: Fields, ...args: unknown[]): number {
      const a = bind('remaining', args, ['item'], [], ['item']);
      return trade.remaining(state(), this, item(a['item'], 'remaining() item'));
    },
    buy(this: Fields, ...args: unknown[]): boolean {
      const a = bind('buy', args, ['buyer', 'item', 'count'], [], ['buyer', 'item']);
      return trade.buy(state(), owner(this), this, who(a['buyer'], 'buy() buyer'), item(a['item'], 'buy() item'),
        a['count'] === undefined ? 1 : count(a['count'], 'buy() count'));
    },
    sell(this: Fields, ...args: unknown[]): boolean {
      const a = bind('sell', args, ['seller', 'item', 'count'], [], ['seller', 'item']);
      return trade.sell(state(), owner(this), this, who(a['seller'], 'sell() seller'), item(a['item'], 'sell() item'),
        a['count'] === undefined ? 1 : count(a['count'], 'sell() count'));
    },
  }, {
    offers: (fields) => trade.offersOf(state(), fields).map((o) => state().ref(ITEM, o.item)),
  });
}

function upgradeMethods(state: State): object {
  const upgrade = (value: unknown, where: string): string => contentId(value, UPGRADE, where);
  return withEntity(state, {
    draft(this: Fields, ...args: unknown[]): unknown[] {
      const a = bind('draft', args, ['count'], ['choices']);
      const from = a['choices'] === undefined || a['choices'] === null
        ? null : listOf<unknown>(a['choices']).map((c, i) => upgrade(c, `draft() choices[${i}]`));
      return trade.draft(state(), this, a['count'] === undefined ? 3 : count(a['count'], 'draft() count'), from)
        .map((id) => state().ref(UPGRADE, id));
    },
    pick(this: Fields, ...args: unknown[]): null {
      const a = bind('pick', args, ['upgrade'], [], ['upgrade']);
      trade.pick(state(), owner(this), this, upgrade(a['upgrade'], 'pick() upgrade'));
      return null;
    },
    grant(this: Fields, ...args: unknown[]): boolean {
      const a = bind('grant', args, ['upgrade'], [], ['upgrade']);
      return trade.grant(state(), owner(this), this, upgrade(a['upgrade'], 'grant() upgrade'));
    },
    picks(this: Fields, ...args: unknown[]): number {
      const a = bind('picks', args, ['upgrade'], [], ['upgrade']);
      return trade.picks(this, upgrade(a['upgrade'], 'picks() upgrade'));
    },
  });
}

export function economyComponents(state: State): ComponentDef[] {
  return [
    { id: WALLET, schema: WALLET_SCHEMA, methods: withEntity(state, walletMethods(state, (f) => owner(f))) },
    { id: INVENTORY, schema: INVENTORY_SCHEMA, methods: inventoryMethods(state) },
    { id: SHOPKEEPER, schema: SHOPKEEPER_SCHEMA, methods: shopMethods(state) },
    { id: UPGRADES, schema: UPGRADES_SCHEMA, methods: upgradeMethods(state) },
    { id: PICKUP, schema: PICKUP_SCHEMA, methods: withEntity(state, {}) },
  ];
}
