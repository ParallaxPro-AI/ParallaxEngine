/**
 * conveyors — items riding conveyor lanes (sdk/parallax/conveyors.pyi), simulated each
 * fixed step and drawn by render3d through the `conveyors` service as instanced copies of
 * each item kind's model. A factory with thousands of items on its belts spends no
 * entities and no game code per item per frame: the game builds lanes, links them, and
 * pushes, takes and pops items where its machines meet the belts.
 *
 * A lane is a polyline (`points`, world meters) its items ride from the first point to the
 * last at `speed` meters per second, kept at least `spacing` meters apart. An item that
 * reaches the end waits there (`front`, `pop`) unless the lane feeds another
 * (`connect(lane, to, at)`): it then moves on to `to`, `at` meters along it, as soon as
 * there's room. Items queue behind a stopped item, so a full belt backs up.
 *
 * State: every lane with its items (kind ids, distances) and the kind names, as plain
 * JSON for snapshots. Lanes are cleared when a scene loads.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { CONVEYOR_ITEM_STRIDE, CONVEYOR_SERVICE } from '../../services/index.js';
import type { ConveyorDraw, ConveyorSource } from '../../services/index.js';

const EPS = 1e-6;

/** How a kind of item looks on a lane. */
export interface ItemLook {
  readonly model: string;
  readonly scale: number;
  /** Meters above the lane's points. */
  readonly lift: number;
}

interface Lane {
  readonly id: number;
  /** x, y, z per point. */
  readonly points: Float64Array;
  /** Distance along the lane at each point. */
  readonly along: Float64Array;
  readonly length: number;
  speed: number;
  readonly spacing: number;
  visible: boolean;
  /** Items, front (largest distance) first. */
  kinds: number[];
  dist: number[];
  /** Each item's distance one fixed step ago (drawing interpolates). */
  prev: number[];
  to: number | null;
  at: number;
}

export interface LaneOptions {
  readonly speed: number;
  readonly spacing: number;
  readonly visible?: boolean;
}

function bad(what: string, fix?: string): never {
  return fail('PP3910', what, fix === undefined ? undefined : { fix });
}

/** The lanes, their items and the kinds' looks: the plugin's whole state, usable on its own (tests, tools). */
export class ConveyorNet implements ConveyorSource {
  readonly #lanes = new Map<number, Lane>();
  readonly #kindIds = new Map<string, number>();
  readonly #kindNames: string[] = [];
  readonly #looks = new Map<number, ItemLook>();
  #next = 1;

  // ── Kinds and looks ───────────────────────────────────────────────────────

  kindId(kind: string): number {
    if (typeof kind !== 'string' || kind === '') bad(`An item kind must be a non-empty string, got ${String(kind)}`);
    let id = this.#kindIds.get(kind);
    if (id === undefined) {
      id = this.#kindNames.length;
      this.#kindNames.push(kind);
      this.#kindIds.set(kind, id);
    }
    return id;
  }

  kindName(id: number): string {
    return this.#kindNames[id]!;
  }

  look(kind: string, look: ItemLook): void {
    if (!(look.scale > 0)) bad(`conveyors.look("${kind}") scale must be above 0, got ${look.scale}`);
    this.#looks.set(this.kindId(kind), look);
  }

  // ── Lanes ─────────────────────────────────────────────────────────────────

  lane(points: readonly (readonly [number, number, number])[], options: LaneOptions): number {
    if (points.length < 2) bad(`A conveyor lane needs at least 2 points, got ${points.length}`, 'Pass the start and end of the lane (and any corners between).');
    if (!(options.speed >= 0) || !Number.isFinite(options.speed)) bad(`A conveyor lane's speed must be 0 or more, got ${options.speed}`);
    if (!(options.spacing > 0) || !Number.isFinite(options.spacing)) bad(`A conveyor lane's spacing must be above 0, got ${options.spacing}`);
    const flat = new Float64Array(points.length * 3);
    const along = new Float64Array(points.length);
    let length = 0;
    points.forEach((p, i) => {
      for (const v of p) if (!Number.isFinite(v)) bad(`Conveyor lane point ${i} is not finite`);
      flat[i * 3] = p[0];
      flat[i * 3 + 1] = p[1];
      flat[i * 3 + 2] = p[2];
      if (i > 0) {
        const dx = p[0] - flat[i * 3 - 3]!;
        const dy = p[1] - flat[i * 3 - 2]!;
        const dz = p[2] - flat[i * 3 - 1]!;
        length += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      along[i] = length;
    });
    if (!(length > EPS)) bad('A conveyor lane must have some length: its points are all in one place');
    const id = this.#next++;
    this.#lanes.set(id, {
      id, points: flat, along, length, speed: options.speed, spacing: options.spacing, visible: options.visible ?? true,
      kinds: [], dist: [], prev: [], to: null, at: 0,
    });
    return id;
  }

  #get(id: number, where: string): Lane {
    const lane = this.#lanes.get(id);
    if (lane === undefined) bad(`conveyors.${where}: no lane ${String(id)} (removed, or never made)`, 'Use the id conveyors.lane() returned, and stop using it once removed.');
    return lane;
  }

  has(id: number): boolean {
    return this.#lanes.has(id);
  }

  /** Remove a lane; returns the kinds of the items that were on it, front first. Lanes feeding it stop at their ends. */
  remove(id: number): string[] {
    const lane = this.#get(id, 'remove');
    this.#lanes.delete(id);
    for (const other of this.#lanes.values()) if (other.to === id) other.to = null;
    return lane.kinds.map((k) => this.kindName(k));
  }

  clear(): void {
    this.#lanes.clear();
  }

  /** Feed the end of `id` into `to`, `at` meters along it (null: the lane's items wait at its end). */
  connect(id: number, to: number | null, at = 0): void {
    const lane = this.#get(id, 'connect');
    if (to === null) {
      lane.to = null;
      return;
    }
    const target = this.#get(to, 'connect');
    if (to === id) bad('conveyors.connect: a lane cannot feed itself');
    if (!(at >= 0 && at <= target.length)) bad(`conveyors.connect at=${at} is off lane ${to}, which is ${target.length.toFixed(3)} m long`);
    lane.to = to;
    lane.at = at;
  }

  setSpeed(id: number, speed: number): void {
    if (!(speed >= 0) || !Number.isFinite(speed)) bad(`A conveyor lane's speed must be 0 or more, got ${speed}`);
    this.#get(id, 'set_speed').speed = speed;
  }

  setVisible(id: number, visible: boolean): void {
    this.#get(id, 'set_visible').visible = visible;
  }

  length(id: number): number {
    return this.#get(id, 'length').length;
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  #room(lane: Lane, at: number): boolean {
    const s = lane.spacing - EPS;
    for (const d of lane.dist) if (Math.abs(d - at) < s) return false;
    return true;
  }

  /** Whether an item fits `at` meters along the lane now. */
  room(id: number, at = 0): boolean {
    const lane = this.#get(id, 'room');
    return this.#room(lane, clampAt(lane, at));
  }

  #insert(lane: Lane, kind: number, at: number, prev = at): void {
    let i = 0;
    while (i < lane.dist.length && lane.dist[i]! > at) i++;
    lane.kinds.splice(i, 0, kind);
    lane.dist.splice(i, 0, at);
    lane.prev.splice(i, 0, prev);
  }

  /** Put an item on the lane `at` meters along it, if it fits; false when it doesn't. */
  push(id: number, kind: string, at = 0): boolean {
    const lane = this.#get(id, 'push');
    const k = this.kindId(kind);
    const d = clampAt(lane, at);
    if (!this.#room(lane, d)) return false;
    this.#insert(lane, k, d);
    return true;
  }

  /** The kind of the item waiting at the lane's end, or null. */
  front(id: number): string | null {
    const lane = this.#get(id, 'front');
    return lane.dist.length > 0 && lane.dist[0]! >= lane.length - EPS ? this.kindName(lane.kinds[0]!) : null;
  }

  /** Take the item waiting at the lane's end; null when none has arrived. */
  pop(id: number): string | null {
    const lane = this.#get(id, 'pop');
    if (lane.dist.length === 0 || lane.dist[0]! < lane.length - EPS) return null;
    lane.dist.shift();
    lane.prev.shift();
    return this.kindName(lane.kinds.shift()!);
  }

  /** Take the item nearest `near` meters along the lane within `reach`, of one of `kinds` when given; null when none. */
  take(id: number, near: number, reach: number, kinds: readonly string[] | null = null): string | null {
    const lane = this.#get(id, 'take');
    const wanted = kinds === null ? null : kinds.map((k) => this.#kindIds.get(k)).filter((k): k is number => k !== undefined);
    let best = -1;
    let bestGap = reach + EPS;
    for (let i = 0; i < lane.dist.length; i++) {
      const gap = Math.abs(lane.dist[i]! - near);
      if (gap <= bestGap && (wanted === null || wanted.includes(lane.kinds[i]!))) {
        best = i;
        bestGap = gap;
      }
    }
    if (best < 0) return null;
    const kind = lane.kinds[best]!;
    lane.kinds.splice(best, 1);
    lane.dist.splice(best, 1);
    lane.prev.splice(best, 1);
    return this.kindName(kind);
  }

  /** The lane's item kinds, front first. */
  items(id: number): string[] {
    return this.#get(id, 'items').kinds.map((k) => this.kindName(k));
  }

  /** Each item's distance along the lane, front first (matches `items`). */
  positions(id: number): number[] {
    return [...this.#get(id, 'positions').dist];
  }

  /** Items on one lane, or on every lane. */
  count(id: number | null = null): number {
    if (id !== null) return this.#get(id, 'count').kinds.length;
    let n = 0;
    for (const lane of this.#lanes.values()) n += lane.kinds.length;
    return n;
  }

  get laneCount(): number {
    return this.#lanes.size;
  }

  /** The world point `at` meters along the lane, and the lane's heading there (radians about +y, 0 = +z). */
  point(id: number, at: number): [number, number, number, number] {
    const lane = this.#get(id, 'point');
    return pointAlong(lane, clampAt(lane, at));
  }

  // ── Simulation ────────────────────────────────────────────────────────────

  /** Move every item `dt` seconds along, then hand lane ends on to the lanes they feed. */
  step(dt: number): void {
    for (const lane of this.#lanes.values()) {
      const n = lane.dist.length;
      if (n === 0) continue;
      const move = lane.speed * dt;
      const d = lane.dist;
      const prev = lane.prev;
      for (let i = 0; i < n; i++) {
        const now = d[i]!;
        prev[i] = now;
        const cap = i === 0 ? lane.length : d[i - 1]! - lane.spacing;
        let next = now + move;
        if (next > cap) next = Math.max(now, cap);
        d[i] = next;
      }
    }
    for (const lane of this.#lanes.values()) {
      if (lane.to === null || lane.dist.length === 0 || lane.dist[0]! < lane.length - EPS) continue;
      const target = this.#lanes.get(lane.to);
      if (target === undefined || !this.#room(target, lane.at)) continue;
      const kind = lane.kinds.shift()!;
      lane.dist.shift();
      lane.prev.shift();
      this.#insert(target, kind, lane.at, Math.max(0, lane.at - target.speed * dt));
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  draws(alpha: number): ConveyorDraw[] {
    const counts = new Map<number, number>();
    for (const lane of this.#lanes.values()) {
      if (!lane.visible) continue;
      for (const k of lane.kinds) if (this.#looks.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out = new Map<number, { look: ItemLook; items: Float32Array; n: number }>();
    for (const [k, n] of counts) out.set(k, { look: this.#looks.get(k)!, items: new Float32Array(n * CONVEYOR_ITEM_STRIDE), n: 0 });
    const a = Math.min(1, Math.max(0, alpha));
    for (const lane of this.#lanes.values()) {
      if (!lane.visible) continue;
      for (let i = 0; i < lane.kinds.length; i++) {
        const draw = out.get(lane.kinds[i]!);
        if (draw === undefined) continue;
        const d = lane.prev[i]! + (lane.dist[i]! - lane.prev[i]!) * a;
        const [x, y, z, yaw] = pointAlong(lane, d);
        const o = draw.n++ * CONVEYOR_ITEM_STRIDE;
        draw.items[o] = x;
        draw.items[o + 1] = y + draw.look.lift;
        draw.items[o + 2] = z;
        draw.items[o + 3] = yaw;
      }
    }
    return [...out.values()].map((d) => ({ model: d.look.model, scale: d.look.scale, count: d.n, items: d.items }));
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  snapshot(): Json {
    const lanes: Json[] = [];
    for (const l of this.#lanes.values()) {
      lanes.push({
        id: l.id, points: [...l.points], speed: l.speed, spacing: l.spacing, visible: l.visible,
        kinds: [...l.kinds], dist: [...l.dist], to: l.to, at: l.at,
      });
    }
    const looks: Json[] = [...this.#looks].map(([k, look]) => ({ kind: k, model: look.model, scale: look.scale, lift: look.lift }));
    return { next: this.#next, kinds: [...this.#kindNames], looks, lanes };
  }

  restore(state: Json): void {
    const s = state as unknown as {
      next: number; kinds: string[]; looks: { kind: number; model: string; scale: number; lift: number }[];
      lanes: { id: number; points: number[]; speed: number; spacing: number; visible: boolean; kinds: number[]; dist: number[]; to: number | null; at: number }[];
    };
    this.#lanes.clear();
    this.#kindIds.clear();
    this.#kindNames.length = 0;
    this.#looks.clear();
    for (const name of s.kinds) this.kindId(name);
    for (const l of s.looks) this.#looks.set(l.kind, { model: l.model, scale: l.scale, lift: l.lift });
    for (const l of s.lanes) {
      const pts: [number, number, number][] = [];
      for (let i = 0; i < l.points.length; i += 3) pts.push([l.points[i]!, l.points[i + 1]!, l.points[i + 2]!]);
      this.#next = l.id;
      const id = this.lane(pts, { speed: l.speed, spacing: l.spacing, visible: l.visible });
      const lane = this.#lanes.get(id)!;
      lane.kinds = [...l.kinds];
      lane.dist = [...l.dist];
      lane.prev = [...l.dist];
      lane.to = l.to;
      lane.at = l.at;
    }
    this.#next = s.next;
  }
}

function clampAt(lane: Lane, at: number): number {
  if (!Number.isFinite(at)) bad(`A distance along a conveyor lane must be finite, got ${at}`);
  return Math.min(lane.length, Math.max(0, at));
}

/** x, y, z and heading (radians about +y; 0 faces +z) `d` meters along the lane. */
function pointAlong(lane: Lane, d: number): [number, number, number, number] {
  const along = lane.along;
  const p = lane.points;
  let s = 1;
  while (s < along.length - 1 && along[s]! < d) s++;
  const a = s - 1;
  const span = along[s]! - along[a]!;
  const t = span > EPS ? (d - along[a]!) / span : 0;
  const dx = p[s * 3]! - p[a * 3]!;
  const dy = p[s * 3 + 1]! - p[a * 3 + 1]!;
  const dz = p[s * 3 + 2]! - p[a * 3 + 2]!;
  return [p[a * 3]! + dx * t, p[a * 3 + 1]! + dy * t, p[a * 3 + 2]! + dz * t, Math.atan2(dx, dz)];
}

/** `parallax.plugins.conveyors()`: conveyor lanes and the items on them. */
export function conveyors(): KernelPlugin & { readonly net: ConveyorNet } {
  const net = new ConveyorNet();
  let installedOn: Kernel | undefined;
  return {
    id: 'conveyors',
    net,
    install(kernel) {
      if (installedOn !== undefined) fail('PP3247', 'This conveyors plugin is already installed in another kernel', { fix: 'Call conveyors() once per game.' });
      installedOn = kernel;
      kernel.provide(CONVEYOR_SERVICE, net);
      kernel.addHook('physics', (dt) => net.step(dt));
      kernel.observeScenes({ loading: () => net.clear() });
    },
    snapshot: () => net.snapshot(),
    restore: (_kernel, state) => net.restore(state),
  };
}
