/**
 * `ctx.world.query(...)`: rows of `[entity, ...components]` (or plain entities for a
 * tags-only query), in spawn order. A query is evaluated when it is read, so it always
 * reflects the current world; destroyed entities never appear.
 */

import { fail, Vec2, Vec3 } from '../core/index.js';
import type { Entity } from './entity.js';
import { truthy } from './py.js';
import type { GameRuntime } from './runtime.js';

type Row = unknown;

function entityOf(row: Row): Entity {
  return (Array.isArray(row) ? row[0] : row) as Entity;
}

/**
 * Distance from an entity to a point. A Vec2 compares x/y only; so does every point in a
 * 2D game (`planar`), where z is draw order, not space (SDK `Transform.position`).
 */
function distance(entity: Entity, point: unknown, planar: boolean): number {
  const position = entity.transform.position;
  if (point instanceof Vec2 || (planar && point instanceof Vec3)) {
    return Math.hypot(position.x - (point as Vec2).x, position.y - (point as Vec2).y);
  }
  if (point instanceof Vec3) return position.distance_to(point);
  return fail('PP3007', `Expected a Vec2 or Vec3 point, got ${String(point)}`);
}

export class Query<T = Row> {
  readonly #rows: () => T[];
  readonly #planar: boolean;

  /** `planar`: a 2D game, where distances ignore z (draw order). */
  constructor(rows: () => T[], planar = false) {
    this.#rows = rows;
    this.#planar = planar;
  }

  [Symbol.iterator](): Iterator<T> { return this.#rows()[Symbol.iterator](); }
  __iter__(): Iterator<T> { return this[Symbol.iterator](); }

  first(): T | null { return this.#rows()[0] ?? null; }

  single(): T {
    const rows = this.#rows();
    if (rows.length !== 1) {
      fail('PP3010', `single() expected exactly one row, found ${rows.length}`, {
        fix: rows.length === 0 ? 'Use first() when the row may be missing.' : 'Narrow the query (tagged=, where()) or use first().',
      });
    }
    return rows[0]!;
  }

  count(): number { return this.#rows().length; }

  /** Filter with the row unpacked: `.where(lambda e, lane: lane.index == 3)`. */
  where(predicate: (...row: unknown[]) => unknown): Query<T> {
    return new Query(() => this.#rows().filter((row) => truthy(Array.isArray(row) ? predicate(...row) : predicate(row))), this.#planar);
  }

  /** Rows whose entity position is within `radius` of `point` (a Vec2, or any point in 2D, compares x/y only). */
  near(point: Vec3 | Vec2, radius: number): Query<T> {
    return new Query(() => this.#rows().filter((row) => distance(entityOf(row), point, this.#planar) <= radius), this.#planar);
  }

  /** All rows, nearest first (ties keep spawn order). */
  by_distance(point: Vec3 | Vec2): T[] {
    return this.#rows()
      .map((row, i) => ({ row, i, d: distance(entityOf(row), point, this.#planar) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((x) => x.row);
  }

  nearest(point: Vec3 | Vec2, count?: number): T | null | T[] {
    const sorted = this.by_distance(point);
    if (count === undefined) return sorted[0] ?? null;
    if (!Number.isInteger(count) || count < 0) fail('PP3007', `nearest() count must be an int >= 0, got ${count}`);
    return sorted.slice(0, count);
  }

  entities(): Entity[] { return this.#rows().map(entityOf); }
  to_list(): T[] { return this.#rows(); }
}

/** `world.query(*components, tagged=(), without=())` against the kernel world. */
export function runQuery(rt: GameRuntime, componentIds: readonly string[], tagged: readonly string[], without: readonly string[]): Query {
  return new Query(() => rt.kernel.world.query(componentIds, { tagged, without }).map(([id, ...fields]) => {
    const entity = rt.wrap(id);
    if (componentIds.length === 0) return entity;
    return [entity, ...fields.map((f, i) => rt.presentComponent(componentIds[i]!, f))];
  }), rt.mode === '2d');
}
