/**
 * Inventories: `size` slots holding stacks of `item` content (`max_stack` per item), the
 * first `hotbar` of them a hotbar with one `selected`, and named `equip_slots`.
 *
 *   add      fills stacks of the same item first, then empty slots in order; returns what
 *            didn't fit (never a partial error)
 *   remove   all or nothing, taking from the last matching slot first (the newest stack)
 *   equip    moves one item from the slots into its equip slot (the item's `equip_slot`,
 *            or the one given); what was worn there goes back into the slots; the item's
 *            `bonuses` become stat modifiers on the owner keyed `equip:<slot>`, so they
 *            are saved with it and come off with `unequip`
 *
 * Every change raises `items_changed`. Slots are written back whole (a new list), so
 * snapshots, saves and replication see one value per change.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import { attr, dictOf, idOf, listOf, num } from './args.js';
import { ECONOMY_EVENTS, ITEM } from './schemas.js';
import { bonusesOf } from './state.js';
import type { EconomyState } from './state.js';

export interface Stack {
  item: string | null;
  count: number;
}

export function slotsOf(inv: Fields): Stack[] {
  const size = inv['size'] as number;
  const given = listOf<unknown>(inv['slots']);
  const out: Stack[] = [];
  for (let i = 0; i < size; i++) {
    const s = given[i];
    const item = idOf(attr(s, 'item'));
    const n = num(s, 'count', 0);
    out.push(item === null || n <= 0 ? { item: null, count: 0 } : { item, count: n });
  }
  return out;
}

function write(s: EconomyState, owner: EntityId, inv: Fields, slots: readonly Stack[]): void {
  inv['slots'] = slots.map((x) => ({ item: x.item, count: x.count }));
  s.emit(ECONOMY_EVENTS.itemsChanged, { entity: s.wrap(owner) });
}

export function maxStack(s: EconomyState, item: string): number {
  return Math.max(1, num(s.data(ITEM, item), 'max_stack', 1));
}

/** Put `n` of `item` into `slots` in place; returns the leftover. */
function fill(slots: Stack[], item: string, n: number, max: number): number {
  let left = n;
  for (const slot of slots) {
    if (left === 0) break;
    if (slot.item !== item || slot.count >= max) continue;
    const put = Math.min(max - slot.count, left);
    slot.count += put;
    left -= put;
  }
  for (const slot of slots) {
    if (left === 0) break;
    if (slot.item !== null) continue;
    const put = Math.min(max, left);
    slot.item = item;
    slot.count = put;
    left -= put;
  }
  return left;
}

export function room(s: EconomyState, inv: Fields, item: string): number {
  const max = maxStack(s, item);
  return slotsOf(inv).reduce((sum, slot) => sum + (slot.item === null ? max : slot.item === item ? Math.max(0, max - slot.count) : 0), 0);
}

export function add(s: EconomyState, owner: EntityId, inv: Fields, item: string, n: number): number {
  if (n === 0) return 0;
  const slots = slotsOf(inv);
  const left = fill(slots, item, n, maxStack(s, item));
  if (left !== n) write(s, owner, inv, slots);
  return left;
}

export function countOf(inv: Fields, item: string): number {
  return slotsOf(inv).reduce((sum, slot) => sum + (slot.item === item ? slot.count : 0), 0);
}

export function remove(s: EconomyState, owner: EntityId, inv: Fields, item: string, n: number): boolean {
  if (countOf(inv, item) < n) return false;
  if (n === 0) return true;
  const slots = slotsOf(inv);
  let left = n;
  for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
    const slot = slots[i]!;
    if (slot.item !== item) continue;
    const take = Math.min(slot.count, left);
    slot.count -= take;
    left -= take;
    if (slot.count === 0) slot.item = null;
  }
  write(s, owner, inv, slots);
  return true;
}

function slotIndex(inv: Fields, index: number, where: string): number {
  const size = inv['size'] as number;
  if (!Number.isInteger(index) || index < 0 || index >= size) {
    fail('PP7110', `${where}: slot ${index} is out of range`, { fix: `Slots are 0 to ${size - 1}.` });
  }
  return index;
}

/** Swap two slots, or merge `from` into `to` when they hold the same item. */
export function move(s: EconomyState, owner: EntityId, inv: Fields, from: number, to: number): void {
  const slots = slotsOf(inv);
  const a = slots[slotIndex(inv, from, 'move()')]!;
  const b = slots[slotIndex(inv, to, 'move()')]!;
  if (from === to) return;
  if (a.item !== null && a.item === b.item) {
    const put = Math.min(maxStack(s, a.item) - b.count, a.count);
    b.count += put;
    a.count -= put;
    if (a.count === 0) a.item = null;
  } else {
    slots[from] = b;
    slots[to] = a;
  }
  write(s, owner, inv, slots);
}

export function stackAt(inv: Fields, index: number): Stack {
  return slotsOf(inv)[slotIndex(inv, index, 'slot()')]!;
}

export function select(inv: Fields, index: number): void {
  const hotbar = inv['hotbar'] as number;
  if (hotbar === 0) fail('PP7111', 'select() on an inventory without a hotbar', { fix: 'Set "hotbar": N in its inventory data.' });
  if (!Number.isInteger(index) || index < 0 || index >= hotbar) {
    fail('PP7111', `select(${index}): the hotbar has slots 0 to ${hotbar - 1}`, { fix: 'Wrap the index: (i % hotbar).' });
  }
  inv['selected'] = index;
}

/** The item in the selected hotbar slot, or null. */
export function selected(inv: Fields): string | null {
  if ((inv['hotbar'] as number) === 0) return null;
  return slotsOf(inv)[inv['selected'] as number]?.item ?? null;
}

export function equippedOf(inv: Fields): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [slot, item] of Object.entries(dictOf<unknown>(inv['equipped']))) {
    const id = idOf(item);
    if (id !== null) out[slot] = id;
  }
  return out;
}

function equipSlot(inv: Fields, slot: string, where: string): string {
  const slots = listOf<string>(inv['equip_slots']);
  if (!slots.includes(slot)) {
    fail('PP7112', `${where}: the inventory has no equip slot "${slot}"`, { fix: `Equip slots: ${slots.join(', ') || '(none; set "equip_slots")'}.` });
  }
  return slot;
}

export function equip(s: EconomyState, owner: EntityId, inv: Fields, item: string, given: string | null): boolean {
  const def = s.data(ITEM, item);
  const own = idOf(attr(def, 'equip_slot'));
  if (own === null) fail('PP7113', `equip(): item "${item}" has no equip_slot`, { fix: `Give content/item/${item}.json an "equip_slot".` });
  if (given !== null && given !== own) {
    fail('PP7113', `equip(): item "${item}" goes in "${own}", not "${given}"`, { fix: `Call equip(item) or equip(item, slot="${own}").` });
  }
  const slot = equipSlot(inv, own, `equip("${item}")`);
  if (countOf(inv, item) === 0) return false;
  const worn = equippedOf(inv)[slot];
  // What is worn now goes back into the slots: there must be room once one `item` is out.
  const slots = slotsOf(inv);
  let left = 1;
  for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
    const x = slots[i]!;
    if (x.item !== item) continue;
    x.count -= 1;
    left = 0;
    if (x.count === 0) x.item = null;
  }
  if (worn !== undefined && fill(slots, worn, 1, maxStack(s, worn)) > 0) return false;
  if (worn !== undefined) {
    s.kernel.unmodify(owner, `equip:${slot}`);
    s.emit(ECONOMY_EVENTS.unequipped, { entity: s.wrap(owner), item: s.ref(ITEM, worn), slot });
  }
  inv['equipped'] = { ...equippedOf(inv), [slot]: item };
  write(s, owner, inv, slots);
  s.applyBonuses(owner, bonusesOf(def), { key: `equip:${slot}` }, `item "${item}"`);
  s.emit(ECONOMY_EVENTS.equipped, { entity: s.wrap(owner), item: s.ref(ITEM, item), slot });
  return true;
}

export function unequip(s: EconomyState, owner: EntityId, inv: Fields, slot: string): boolean {
  equipSlot(inv, slot, `unequip("${slot}")`);
  const worn = equippedOf(inv)[slot];
  if (worn === undefined) return true;
  const slots = slotsOf(inv);
  if (fill(slots, worn, 1, maxStack(s, worn)) > 0) return false;
  const rest = { ...equippedOf(inv) };
  delete rest[slot];
  inv['equipped'] = rest;
  s.kernel.unmodify(owner, `equip:${slot}`);
  write(s, owner, inv, slots);
  s.emit(ECONOMY_EVENTS.unequipped, { entity: s.wrap(owner), item: s.ref(ITEM, worn), slot });
  return true;
}
