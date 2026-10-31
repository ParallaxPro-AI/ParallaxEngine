/**
 * Loot tables (`loot_table` content): `guaranteed` entries always drop, then `rolls` draws
 * (a whole number between `rolls` and `rolls_max` when that is set) pick one entry each by
 * `weight`, `nothing` being the weight of an empty draw; `unique` never draws an entry
 * twice in one roll. An entry names exactly one of an `item`, a wallet `pool` or a nested
 * `table` (rolled `min`..`max` times), with a `min`..`max` count. Draws use the plugin's
 * seeded random source, so a replay or playtest rolls the same drops. Drops of the same
 * thing merge, in the order first rolled.
 */

import { fail } from '../../../core/index.js';
import type { SeededRandom } from '../../../core/index.js';
import { attr, idOf, listOf, num } from './args.js';
import { LOOT_TABLE } from './schemas.js';

/** Nested tables deeper than this are a cycle (PP7121). */
export const MAX_LOOT_DEPTH = 8;

export interface DropSpec {
  readonly item: string | null;
  readonly pool: string | null;
  readonly count: number;
}

interface Entry {
  readonly item: string | null;
  readonly pool: string | null;
  readonly table: string | null;
  readonly weight: number;
  readonly min: number;
  readonly max: number;
}

function entriesOf(data: unknown, name: string, table: string): Entry[] {
  return listOf<unknown>(attr(data, name)).map((e, i) => {
    const entry: Entry = {
      item: idOf(attr(e, 'item')), pool: idOf(attr(e, 'pool')), table: idOf(attr(e, 'table')),
      weight: num(e, 'weight', 1), min: num(e, 'min', 1), max: num(e, 'max', num(e, 'min', 1)),
    };
    const named = [entry.item, entry.pool, entry.table].filter((x) => x !== null).length;
    if (named !== 1) {
      fail('PP7120', `loot_table "${table}" ${name}[${i}] names ${named === 0 ? 'nothing' : 'more than one thing'}`, {
        fix: 'Give each entry exactly one of "item", "pool" or "table".',
      });
    }
    if (entry.max < entry.min) fail('PP7120', `loot_table "${table}" ${name}[${i}]: max ${entry.max} is below min ${entry.min}`);
    return entry;
  });
}

export function rollTable(read: (kind: string, id: string) => unknown, random: SeededRandom, table: string): DropSpec[] {
  const out = new Map<string, { item: string | null; pool: string | null; count: number }>();
  const put = (item: string | null, pool: string | null, n: number): void => {
    if (n <= 0) return;
    const key = item !== null ? `i:${item}` : `p:${pool!}`;
    const have = out.get(key);
    if (have !== undefined) have.count += n;
    else out.set(key, { item, pool, count: n });
  };
  const roll = (id: string, depth: number): void => {
    if (depth > MAX_LOOT_DEPTH) {
      fail('PP7121', `loot_table "${id}" nests more than ${MAX_LOOT_DEPTH} tables deep (a table that includes itself?)`, {
        fix: 'Break the cycle of "table" entries.',
      });
    }
    const data = read(LOOT_TABLE, id);
    const take = (e: Entry): void => {
      const n = e.min === e.max ? e.min : random.int(e.min, e.max);
      if (e.table !== null) for (let k = 0; k < n; k++) roll(e.table, depth + 1);
      else put(e.item, e.pool, n);
    };
    for (const e of entriesOf(data, 'guaranteed', id)) take(e);
    const entries = entriesOf(data, 'entries', id);
    const lo = num(data, 'rolls', 1);
    const hiRaw = attr(data, 'rolls_max');
    const hi = typeof hiRaw === 'number' ? hiRaw : lo;
    if (hi < lo) fail('PP7120', `loot_table "${id}": rolls_max ${hi} is below rolls ${lo}`);
    const draws = lo === hi ? lo : random.int(lo, hi);
    const nothing = num(data, 'nothing', 0);
    const unique = attr(data, 'unique') === true;
    const open = entries.map(() => true);
    for (let d = 0; d < draws; d++) {
      const total = entries.reduce((sum, e, i) => sum + (open[i] ? e.weight : 0), 0) + nothing;
      if (total <= 0) break;
      let pick = random.next() * total;
      let chosen = -1;
      for (let i = 0; i < entries.length; i++) {
        if (!open[i]) continue;
        pick -= entries[i]!.weight;
        if (pick < 0) { chosen = i; break; }
      }
      // Rounding can leave a sliver past the last weight: that is the last entry, not nothing.
      if (chosen < 0 && nothing === 0) chosen = open.lastIndexOf(true);
      if (chosen < 0) continue; // The empty draw.
      if (unique) open[chosen] = false;
      take(entries[chosen]!);
    }
  };
  roll(table, 0);
  return [...out.values()];
}
