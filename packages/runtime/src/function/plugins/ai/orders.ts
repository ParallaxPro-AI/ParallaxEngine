/**
 * RTS unit orders on `Orders` entities (they move through their NavAgent):
 *
 *   move(point)          walk there; done on arrival (or at once when unreachable)
 *   attack(target)       chase until within `attack_range`, then stand and engage; done when it dies
 *   attack_move(point)   walk there, engaging enemies met on the way, then resume; done on arrival
 *   patrol(points)       attack-move around the points forever
 *   hold()               stand still; engage only what comes within `attack_range`
 *   stop()               drop every order
 *
 * Orders queue (`queue=True` appends). While idle, moving with attack_move/patrol, or
 * holding, the `stance` acquires enemies: "aggressive" within `acquire_range` (and chases
 * them, giving up beyond 1.5× that), "defensive" only within `attack_range` (never chases),
 * "passive" never. An enemy is the unit's Perception target when it has one in sight,
 * else the nearest entity of another Side. Engaging means standing within `attack_range`
 * of a live target: the game's behavior reads `orders.engaging` / `orders.target` and
 * fires — orders never deal damage themselves. Finishing an order emits `OrderDone`.
 *
 * A group order (`ctx.ai.command`) places units in a formation at the destination, facing
 * the way the group travels, assigns slots by distance, and caps everyone to the slowest
 * unit's speed so the formation arrives together.
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { NavService } from '../../services/index.js';
import { ORDERS, SIDE } from './schemas.js';

export type Order =
  | { readonly kind: 'move' | 'attack_move'; readonly point: Vec3; readonly maxSpeed?: number }
  | { readonly kind: 'attack'; readonly target: EntityId }
  | { readonly kind: 'patrol'; readonly points: readonly Vec3[]; index: number; readonly maxSpeed?: number }
  | { readonly kind: 'hold' };

interface UnitState {
  queue: Order[];
  current: Order | null;
  /** The current order's move was issued. */
  started: boolean;
  engage: EntityId | null;
  /** Engaging moved the unit off its order: re-issue the move when done. */
  diverted: boolean;
  /** The enemy the NavAgent is following now (a chase is issued once, not every step). */
  chasing: EntityId | null;
}

function tagId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const id = (value as { __tag_id__?: unknown }).__tag_id__;
  return typeof id === 'string' ? id : null;
}

export interface OrdersWorld {
  nav(): NavService;
  /** The unit's Perception target in sight, if it has Perception. */
  seen(unit: EntityId): EntityId | null;
  emit(payload: Fields): void;
}

export class Orders {
  readonly #kernel: Kernel;
  readonly #world: OrdersWorld;
  readonly #units = new Map<EntityId, UnitState>();

  constructor(kernel: Kernel, world: OrdersWorld) {
    this.#kernel = kernel;
    this.#world = world;
  }

  clear(): void {
    this.#units.clear();
  }

  removed(id: EntityId): void {
    this.#units.delete(id);
  }

  #state(id: EntityId): UnitState {
    if (!this.#kernel.world.get(id)?.components.has(ORDERS)) fail('PP3275', `entity ${id} has no Orders component`, { fix: 'Add Orders to units that take commands.' });
    let s = this.#units.get(id);
    if (s === undefined) {
      s = { queue: [], current: null, started: false, engage: null, diverted: false, chasing: null };
      this.#units.set(id, s);
    }
    return s;
  }

  give(id: EntityId, order: Order, queue: boolean): void {
    const s = this.#state(id);
    if (order.kind === 'attack' && order.target === id) fail('PP3275', 'A unit can\'t be ordered to attack itself');
    if (queue && (s.current !== null || s.queue.length > 0)) {
      s.queue.push(order);
      return;
    }
    this.#halt(id, s);
    s.queue = [];
    s.current = order;
    s.started = false;
  }

  stop(id: EntityId): void {
    const s = this.#state(id);
    this.#halt(id, s);
    s.queue = [];
    s.current = null;
  }

  #halt(id: EntityId, s: UnitState): void {
    s.engage = null;
    s.diverted = false;
    s.chasing = null;
    const nav = this.#world.nav();
    if (nav.hasAgent(id)) nav.stopAgent(id);
  }

  order(id: EntityId): string {
    return this.#units.get(id)?.current?.kind ?? 'idle';
  }

  queued(id: EntityId): number {
    return this.#units.get(id)?.queue.length ?? 0;
  }

  target(id: EntityId): EntityId | null {
    const s = this.#units.get(id);
    if (s === undefined) return null;
    const t = s.engage ?? (s.current?.kind === 'attack' ? s.current.target : null);
    return t !== null && this.#kernel.world.isAlive(t) ? t : null;
  }

  engaging(id: EntityId): boolean {
    const t = this.target(id);
    if (t === null) return false;
    const range = this.#kernel.world.require(id).components.get(ORDERS)!['attack_range'] as number;
    return this.#flat(id, t) <= range + 1e-6;
  }

  #flat(a: EntityId, b: EntityId): number {
    const p = this.#kernel.world.require(a).transform.worldPosition();
    const q = this.#kernel.world.require(b).transform.worldPosition();
    return Math.hypot(p.x - q.x, p.z - q.z);
  }

  #enemy(id: EntityId, range: number): EntityId | null {
    const seen = this.#world.seen(id);
    if (seen !== null && this.#flat(id, seen) <= range) return seen;
    const world = this.#kernel.world;
    const side = tagId(world.require(id).components.get(SIDE)?.['side']);
    if (side === null) return null;
    let best: EntityId | null = null;
    let bestD = Infinity;
    for (const [other, s] of world.query([SIDE])) {
      const o = tagId(s!['side']);
      if (other === id || o === null || o === side) continue;
      const d = this.#flat(id, other);
      if (d <= range && d < bestD) {
        best = other;
        bestD = d;
      }
    }
    return best;
  }

  step(): void {
    const world = this.#kernel.world;
    for (const [id, fields] of world.query([ORDERS])) {
      const s = this.#units.get(id);
      this.#unit(id, fields!, s ?? this.#state(id));
    }
  }

  #done(id: EntityId, s: UnitState, kind: string): void {
    s.current = s.queue.shift() ?? null;
    s.started = false;
    s.diverted = false;
    this.#world.emit({ entity: this.#kernel.handles.wrap(id), order: kind });
  }

  #unit(id: EntityId, f: Fields, s: UnitState): void {
    const nav = this.#world.nav();
    const world = this.#kernel.world;
    if (s.current === null && s.queue.length > 0) {
      s.current = s.queue.shift()!;
      s.started = false;
    }
    const order = s.current;
    if (order?.kind === 'attack' && !world.isAlive(order.target)) {
      this.#done(id, s, 'attack');
      return;
    }
    const stance = f['stance'] as string;
    const attackRange = f['attack_range'] as number;
    const acquireRange = f['acquire_range'] as number;
    const kind = order?.kind ?? 'idle';
    // Acquire and engage.
    if (order?.kind === 'attack') s.engage = order.target;
    else if (stance === 'passive' || kind === 'move') s.engage = null;
    else {
      const chases = stance === 'aggressive' && kind !== 'hold';
      if (s.engage !== null && (!world.isAlive(s.engage) || this.#flat(id, s.engage) > (chases ? acquireRange * 1.5 : attackRange))) s.engage = null;
      s.engage ??= this.#enemy(id, chases ? acquireRange : attackRange);
    }
    if (s.engage !== null) {
      const chases = order?.kind === 'attack' || (stance === 'aggressive' && kind !== 'hold');
      if (this.#flat(id, s.engage) <= attackRange) {
        if (nav.hasAgent(id) && (nav.agentMoving(id) || s.chasing !== null)) nav.stopAgent(id);
        s.chasing = null;
        if (order !== null && order.kind !== 'attack' && order.kind !== 'hold') s.diverted = true;
        return;
      }
      if (chases && nav.hasAgent(id) && s.chasing !== s.engage) {
        nav.moveAgent(id, s.engage, { stoppingDistance: attackRange * 0.9 });
        s.chasing = s.engage;
        if (order?.kind !== 'attack') s.diverted = true;
      }
      return;
    }
    s.chasing = null;
    if (order === null) return;
    switch (order.kind) {
      case 'hold':
        if (nav.hasAgent(id) && nav.agentMoving(id)) nav.stopAgent(id);
        return;
      case 'attack':
        return;
      case 'move':
      case 'attack_move':
        if (!s.started || s.diverted) {
          s.started = true;
          s.diverted = false;
          if (!nav.moveAgent(id, order.point, order.maxSpeed === undefined ? {} : { maxSpeed: order.maxSpeed })) this.#done(id, s, order.kind);
          return;
        }
        if (!nav.agentMoving(id)) this.#done(id, s, order.kind);
        return;
      case 'patrol': {
        if (s.started && !s.diverted && !nav.agentMoving(id)) {
          order.index = (order.index + 1) % order.points.length;
          s.started = false;
        }
        if (!s.started || s.diverted) {
          s.started = true;
          s.diverted = false;
          nav.moveAgent(id, order.points[order.index]!, order.maxSpeed === undefined ? {} : { maxSpeed: order.maxSpeed });
        }
        return;
      }
    }
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  snapshot(): Json {
    const v = (p: Vec3): Json => [p.x, p.y, p.z];
    const enc = (o: Order): JsonObject => {
      switch (o.kind) {
        case 'move': case 'attack_move': return { kind: o.kind, point: v(o.point), ...(o.maxSpeed !== undefined && { max_speed: o.maxSpeed }) };
        case 'attack': return { kind: o.kind, target: o.target };
        case 'patrol': return { kind: o.kind, points: o.points.map(v), index: o.index, ...(o.maxSpeed !== undefined && { max_speed: o.maxSpeed }) };
        case 'hold': return { kind: o.kind };
      }
    };
    return [...this.#units].map(([id, s]) => ({
      id, queue: s.queue.map(enc), current: s.current === null ? null : enc(s.current), started: s.started, engage: s.engage, diverted: s.diverted, chasing: s.chasing,
    }));
  }

  restore(json: Json, alive: (id: EntityId) => boolean): void {
    const vec = (j: Json | undefined): Vec3 => {
      const [x, y, z] = j as number[];
      return new Vec3(x!, y!, z!);
    };
    const dec = (o: JsonObject): Order => {
      const speed = typeof o['max_speed'] === 'number' ? { maxSpeed: o['max_speed'] } : {};
      switch (o['kind']) {
        case 'move': case 'attack_move': return { kind: o['kind'], point: vec(o['point']), ...speed };
        case 'attack': return { kind: 'attack', target: o['target'] as EntityId };
        case 'patrol': return { kind: 'patrol', points: (o['points'] as Json[]).map(vec), index: o['index'] as number, ...speed };
        default: return { kind: 'hold' };
      }
    };
    this.#units.clear();
    for (const u of json as JsonObject[]) {
      const id = u['id'] as EntityId;
      if (!alive(id)) continue;
      const engage = u['engage'] as EntityId | null;
      this.#units.set(id, {
        queue: (u['queue'] as JsonObject[]).map(dec), current: u['current'] === null ? null : dec(u['current'] as JsonObject),
        started: u['started'] === true, engage: engage !== null && alive(engage) ? engage : null, diverted: u['diverted'] === true,
        chasing: typeof u['chasing'] === 'number' && alive(u['chasing'] as EntityId) ? u['chasing'] as EntityId : null,
      });
    }
  }
}
