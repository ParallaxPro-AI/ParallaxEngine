/**
 * The economy plugin's shared state: the kernel, the api's content host, the plugin's own
 * seeded random source (loot rolls, drafts — reseeded on every scene load
 * from the load's seed, saved in snapshots), content readers, events, and wallets.
 *
 * Wallets. A pool is a named amount (`gold`, `wood`, `mana`) in a `Wallet` component or
 * the game-wide bank resource (`ctx.economy.bank`); both have the same fields. `caps`
 * bound a pool; `generators` add `amount` every `every` seconds (times the number of live
 * entities with `per_tag`, for mines and farms), their clocks kept in `clocks` so they
 * survive saves. Every change goes through `earn` / `spend` and raises `pool_changed`.
 *
 * Everything else the plugin keeps lives in its components (see each file), so the only
 * snapshot state is the random generator.
 */

import { fail, hashNumbers, SeededRandom } from '../../../core/index.js';
import type { EntityId, RandomState } from '../../../core/index.js';
import type { EventDef, Fields, Kernel } from '../../kernel/index.js';
import { attr, dictOf, idOf, listOf, num } from './args.js';
import { BANK, ECONOMY_EVENTS, WALLET } from './schemas.js';

/** A content entry as the api hands it over: a ContentRef (`id`, `kind`, decoded `data`). */
export interface ContentRefLike {
  readonly id: string;
  readonly kind: string;
  readonly data: unknown;
}

/** What the api supplies: content entries (decoded, defaults filled) and game-facing tags. */
export interface EconomyHost {
  /** PP2050 (from the api) for an id that doesn't exist. */
  content(kernel: Kernel, kind: string, id: string): ContentRefLike;
  /** Every entry of a kind, in content order. */
  all(kernel: Kernel, kind: string): readonly ContentRefLike[];
  tag(id: string): unknown;
}

/** A stat change from item or upgrade content: `component.field` scaled and offset. */
export interface Bonus {
  readonly component: string;
  readonly field: string;
  readonly multiply: number;
  readonly add: number;
}

export interface Snapshot {
  readonly random: RandomState;
}

export function bonusesOf(data: unknown): Bonus[] {
  return listOf<unknown>(attr(data, 'bonuses')).map((b) => ({
    component: String(attr(b, 'component')),
    field: String(attr(b, 'field')),
    multiply: num(b, 'multiply', 1),
    add: num(b, 'add', 0),
  }));
}

export class EconomyState {
  readonly kernel: Kernel;
  readonly host: EconomyHost;
  random = new SeededRandom(0);

  constructor(kernel: Kernel, host: EconomyHost) {
    this.kernel = kernel;
    this.host = host;
  }

  reseed(seed: number): void {
    this.random = new SeededRandom(hashNumbers(seed, 0xec0)); // Its own stream: game rolls don't shift loot.
  }

  snapshot(): Snapshot {
    return { random: this.random.state() };
  }

  restore(saved: Snapshot): void {
    this.random.restore(saved.random);
  }

  content(kind: string, id: string): ContentRefLike {
    return this.host.content(this.kernel, kind, id);
  }

  data(kind: string, id: string): unknown {
    return this.content(kind, id).data;
  }

  /** A content ref as game code sees it, or None. */
  ref(kind: string, id: string | null): unknown {
    return id === null ? null : this.content(kind, id);
  }

  wrap(id: EntityId | null): unknown {
    return id === null ? null : this.kernel.handles.wrap(id);
  }

  emit(type: EventDef, payload: Fields): void {
    this.kernel.emit(type, payload);
  }

  where(id: EntityId, component: string): string {
    const record = this.kernel.world.peek(id);
    return `entity ${record?.placedId ?? record?.prefab ?? id} ${component}`;
  }

  /** The component's fields, or a coded error naming what the entity is missing. */
  require(id: EntityId, component: string, why: string): Fields {
    const fields = this.kernel.world.get(id)?.components.get(component);
    if (fields === undefined) {
      fail('PP7103', `${why}: ${this.where(id, '')}has no "${component}" component`, { fix: `Add "${component}" to its prefab (or spawn it with one).` });
    }
    return fields;
  }

  /** Apply `bonuses` to `owner` as kernel stat modifiers (DESIGN §4.23). */
  applyBonuses(owner: EntityId, bonuses: readonly Bonus[], how: { key: string } | { stack: true }, what: string): void {
    const record = this.kernel.world.require(owner);
    for (const b of bonuses) {
      if (!record.components.has(b.component)) {
        fail('PP7104', `${what} changes ${b.component}.${b.field}, but ${this.where(owner, '')}has no "${b.component}"`, {
          fix: `Give it a "${b.component}" component, or remove that bonus from ${what}.`,
        });
      }
      this.kernel.modify(owner, b.component, b.field, { ...how, multiply: b.multiply, add: b.add });
    }
  }

  // ── Wallets ──────────────────────────────────────────────────────────────────

  bank(): Fields {
    return this.kernel.resource(BANK);
  }

  wallet(id: EntityId, why: string): Fields {
    return this.require(id, WALLET, why);
  }

  amount(wallet: Fields, pool: string): number {
    return dictOf<number>(wallet['amounts'])[pool] ?? 0;
  }

  /** Add up to the cap; returns what was added. Negative amounts are `spend`'s job. */
  earn(owner: EntityId | null, wallet: Fields, pool: string, amount: number): number {
    if (amount < 0) fail('PP7105', `earn("${pool}", ${amount}) can't take a negative amount`, { fix: `Use spend("${pool}", ${-amount}).` });
    const amounts = dictOf<number>(wallet['amounts']);
    const before = amounts[pool] ?? 0;
    const cap = dictOf<number>(wallet['caps'])[pool];
    const after = cap === undefined ? before + amount : Math.max(before, Math.min(cap, before + amount));
    if (after === before) return 0;
    wallet['amounts'] = { ...amounts, [pool]: after };
    this.emit(ECONOMY_EVENTS.poolChanged, { entity: this.wrap(owner), pool, amount: after, delta: after - before });
    return after - before;
  }

  spend(owner: EntityId | null, wallet: Fields, pool: string, amount: number): boolean {
    return this.pay(owner, wallet, { [pool]: amount });
  }

  canAfford(wallet: Fields, costs: Readonly<Record<string, number>>): boolean {
    return Object.entries(costs).every(([pool, cost]) => {
      if (cost < 0) fail('PP7105', `A cost of ${cost} ${pool} can't be negative`);
      return this.amount(wallet, pool) >= cost;
    });
  }

  /** All costs or nothing. */
  pay(owner: EntityId | null, wallet: Fields, costs: Readonly<Record<string, number>>): boolean {
    if (!this.canAfford(wallet, costs)) return false;
    for (const [pool, cost] of Object.entries(costs)) {
      if (cost === 0) continue;
      const amounts = dictOf<number>(wallet['amounts']);
      const after = (amounts[pool] ?? 0) - cost;
      wallet['amounts'] = { ...amounts, [pool]: after };
      this.emit(ECONOMY_EVENTS.poolChanged, { entity: this.wrap(owner), pool, amount: after, delta: -cost });
    }
    return true;
  }

  /** Generators: one fixed rhythm per wallet, clocks saved in the wallet. */
  generate(owner: EntityId | null, wallet: Fields, dt: number): void {
    const generators = listOf<unknown>(wallet['generators']);
    if (generators.length === 0) return;
    const clocks = [...listOf<number>(wallet['clocks'])];
    generators.forEach((g, i) => {
      const every = num(g, 'every', 1);
      let clock = (clocks[i] ?? 0) + dt;
      let ticks = 0;
      while (clock >= every - 1e-9) {
        clock -= every;
        ticks += 1;
      }
      clocks[i] = Math.max(0, clock);
      if (ticks === 0) return;
      const tag = idOf(attr(g, 'per_tag'));
      const times = tag === null ? 1 : this.kernel.world.query([], { tagged: [tag] }).length;
      const amount = num(g, 'amount', 1) * times * ticks;
      if (amount > 0) this.earn(owner, wallet, String(attr(g, 'pool')), amount);
    });
    wallet['clocks'] = clocks;
  }
}

/** `[entity, fields]` for every live entity with `component`, in spawn order. */
export function rows(kernel: Kernel, component: string): Array<[EntityId, Fields]> {
  return kernel.world.query([component]).map((r) => [r[0], r[1]!]);
}
