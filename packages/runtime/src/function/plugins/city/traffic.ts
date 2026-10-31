/**
 * Ambient traffic on the lane graph. Cars are the game's prefabs carrying `city_car`:
 *
 *   - spawned on a random lane between `spawn_min` and `radius` of a streaming source
 *     (cameras, followed and player-owned entities), never within 12 m of another car on
 *     the same lane, and kept at `cars` within `radius`; one that drifts past radius·1.25 is
 *     removed;
 *   - driven along lane → connector → lane, picking turns at random (straight twice as
 *     likely as each turn); speed follows the intelligent driver model behind the car
 *     ahead, a closed junction, or a pedestrian on the crosswalk;
 *   - junctions: a signalized approach enters on green (and on yellow when it can no
 *     longer stop); an all-way stop enters after a full stop; either way only while no
 *     conflicting connector (crossing or merging) is occupied and the target lane has room.
 *
 * Two ways to move. A prefab with a `vehicle` component is driven through it
 * (`vehicle.drive(throttle, brake, steer)`: pure pursuit on the lane, speed held by
 * throttle and brake), so it is a real car the player can hit, push and steal — the vehicles
 * plugin's simulation tiers keep far ones cheap. Anything else moves kinematically along
 * the lane (exact, cheapest). A car whose driver is not the city (someone got in) or that is
 * knocked off its lane is released: `city_car.state` becomes "released" and the city stops
 * steering it (and despawns it once it is far away and unoccupied).
 */

import { Quat, SeededRandom, Vec3, fail, kw } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import type { CityLayout } from './layout.js';
import type { Connector, Lane, LaneGraph, Path } from './lanes.js';
import { pathAt, pathProject, signalState } from './lanes.js';
import type { CitySpec } from './spec.js';

export const CITY_CAR = 'city_car';

/** IDM parameters. */
const A_MAX = 2.2;
const B_COMFORT = 3.2;
const GAP_MIN = 2.2;
const HEADWAY = 1.3;
const CAR_LENGTH = 4.6;
const LOOKAHEAD = 60;

export interface CarView {
  readonly id: EntityId;
  readonly record: EntityRecord;
  readonly fields: Fields;
  /** 'L12' or 'C40'. */
  readonly on: string;
  readonly s: number;
  readonly path: Path;
}

export interface TrafficHost {
  readonly kernel: Kernel;
  readonly spec: CitySpec;
  readonly layout: CityLayout;
  readonly graph: LaneGraph;
  readonly rng: SeededRandom;
  /** Signal clock (s). */
  time(): number;
  /** Streaming sources' positions. */
  sources(): readonly Vec3[];
  /** Whether a pedestrian is on a crosswalk across `edge` at `node`. */
  crosswalkBusy(node: number, edge: number): boolean;
  /** Street level at (x, z) for a path point's y (terrain-following is the path's own y). */
  heightAt(x: number, y: number, z: number): number;
}

export class Traffic {
  readonly #h: TrafficHost;
  /** Path key → cars on it, ascending s (rebuilt every step). */
  #onPath = new Map<string, CarView[]>();
  /** Connector id → number of cars on it. */
  #occupied = new Map<number, number>();
  #lengths: number[];
  #total: number;

  constructor(host: TrafficHost) {
    this.#h = host;
    this.#lengths = host.graph.lanes.map((l) => l.path.length);
    this.#total = this.#lengths.reduce((a, b) => a + b, 0);
  }

  pathOf(fields: Fields): Path | null {
    const g = this.#h.graph;
    const connector = fields['connector'] as number;
    if (connector >= 0) return g.connectors[connector]?.path ?? null;
    return g.lanes[fields['lane'] as number]?.path ?? null;
  }

  /** Index the cars this step. */
  #collect(): CarView[] {
    const k = this.#h.kernel;
    const cars: CarView[] = [];
    this.#onPath.clear();
    this.#occupied.clear();
    for (const [id, fields] of k.world.query([CITY_CAR])) {
      if (fields!['state'] === 'released') continue;
      const record = k.world.get(id)!;
      const path = this.pathOf(fields!);
      if (path === null) {
        fields!['state'] = 'released';
        continue;
      }
      const connector = fields!['connector'] as number;
      const on = connector >= 0 ? `C${connector}` : `L${fields!['lane'] as number}`;
      const car: CarView = { id, record, fields: fields!, on, s: fields!['s'] as number, path };
      cars.push(car);
      (this.#onPath.get(on) ?? this.#onPath.set(on, []).get(on)!).push(car);
      if (connector >= 0) this.#occupied.set(connector, (this.#occupied.get(connector) ?? 0) + 1);
    }
    for (const list of this.#onPath.values()) list.sort((a, b) => a.s - b.s);
    return cars;
  }

  /** Whether a car may enter a connector now (signals, stops, conflicts, room). */
  #gateOpen(car: CarView, lane: Lane, next: Connector, distance: number, speed: number): boolean {
    const h = this.#h;
    const g = h.graph;
    const control = g.control.get(next.node) ?? 'none';
    if (control === 'signal' && lane.approach >= 0) {
      const state = signalState(g, g.approaches[lane.approach]!, h.time(), h.spec.traffic.signals);
      if (state === 'red') return false;
      if (state === 'yellow' && distance > (speed * speed) / (2 * B_COMFORT) + 1) return false;
    } else if (control === 'stop') {
      if (car.fields['stopped'] !== true) return false;
    }
    for (const c of next.conflicts) if ((this.#occupied.get(c) ?? 0) > 0) return false;
    // Room on the target lane.
    const target = this.#onPath.get(`L${next.to}`);
    if (target !== undefined && target.length > 0 && target[0]!.s < CAR_LENGTH + GAP_MIN + 1) return false;
    const queued = this.#onPath.get(`C${next.id}`);
    if (queued !== undefined && queued.length > 0 && queued[queued.length - 1]!.s < CAR_LENGTH + GAP_MIN) return false;
    const lanes = h.graph.lanes;
    if (h.crosswalkBusy(next.node, lanes[next.from]!.edge) || h.crosswalkBusy(next.node, lanes[next.to]!.edge)) return false;
    return true;
  }

  /** Gap to the next obstacle along the car's route, and its speed. */
  #leader(car: CarView, speed: number): { gap: number; speed: number } {
    const g = this.#h.graph;
    const list = this.#onPath.get(car.on)!;
    const index = list.indexOf(car);
    if (index < list.length - 1) {
      const ahead = list[index + 1]!;
      return { gap: ahead.s - car.s - CAR_LENGTH, speed: (ahead.fields['speed'] as number) };
    }
    const connector = car.fields['connector'] as number;
    let gap = car.path.length - car.s;
    if (connector < 0) {
      const lane = g.lanes[car.fields['lane'] as number]!;
      const next = g.connectors[car.fields['next'] as number];
      if (next === undefined) return { gap: gap - 1, speed: 0 };
      // Committed cars (within a car length of the line with the gate open last step) keep going.
      if (!this.#gateOpen(car, lane, next, gap, speed)) return { gap: Math.max(0, gap - 0.8), speed: 0 };
      const onNext = this.#onPath.get(`C${next.id}`);
      if (onNext !== undefined && onNext.length > 0) return { gap: gap + onNext[0]!.s - CAR_LENGTH, speed: onNext[0]!.fields['speed'] as number };
      gap += next.path.length;
      const onLane = this.#onPath.get(`L${next.to}`);
      if (onLane !== undefined && onLane.length > 0) return { gap: gap + onLane[0]!.s - CAR_LENGTH, speed: onLane[0]!.fields['speed'] as number };
      return { gap: LOOKAHEAD, speed: Infinity };
    }
    const to = g.connectors[connector]!.to;
    const onLane = this.#onPath.get(`L${to}`);
    if (onLane !== undefined && onLane.length > 0) return { gap: gap + onLane[0]!.s - CAR_LENGTH, speed: onLane[0]!.fields['speed'] as number };
    return { gap: LOOKAHEAD, speed: Infinity };
  }

  /** Choose the turn a car takes at the end of a lane. */
  pickNext(lane: Lane): number {
    const g = this.#h.graph;
    if (lane.out.length === 0) return -1;
    const weights = lane.out.map((c) => (g.connectors[c]!.turn === 'straight' ? 2 : g.connectors[c]!.turn === 'uturn' ? 0.25 : 1));
    let r = this.#h.rng.next() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return lane.out[i]!;
    }
    return lane.out[lane.out.length - 1]!;
  }

  /** Advance a car past the end of its path: lane → its chosen connector → that connector's lane. */
  #advance(fields: Fields, overshoot: number): void {
    const g = this.#h.graph;
    let left = overshoot;
    for (let guard = 0; guard < 4; guard++) {
      const connector = fields['connector'] as number;
      if (connector < 0) {
        const next = fields['next'] as number;
        if (next < 0) {
          fields['s'] = this.#lengths[fields['lane'] as number]!;
          return;
        }
        fields['connector'] = next;
        fields['s'] = left;
        fields['wait'] = 0;
        fields['stopped'] = false;
        // Claim the junction now, so cars handled later this step see it taken.
        this.#occupied.set(next, (this.#occupied.get(next) ?? 0) + 1);
        const len = g.connectors[next]!.path.length;
        if (left < len) return;
        left -= len;
      } else {
        const to = g.connectors[connector]!.to;
        fields['lane'] = to;
        fields['connector'] = -1;
        fields['next'] = this.pickNext(g.lanes[to]!);
        fields['s'] = left;
        if (left < this.#lengths[to]!) return;
        left -= this.#lengths[to]!;
      }
    }
  }

  step(dt: number): void {
    if (dt <= 0) return;
    const h = this.#h;
    const cars = this.#collect();
    for (const car of cars) {
      const f = car.fields;
      const vehicle = car.record.components.get('vehicle') as (Fields & { drive?: (...a: unknown[]) => void; driver?: unknown }) | undefined;
      if (vehicle !== undefined && vehicle.driver !== null && vehicle.driver !== undefined) {
        f['state'] = 'released';
        continue;
      }
      const speedNow = f['speed'] as number;
      const lane = (f['connector'] as number) < 0 ? h.graph.lanes[f['lane'] as number]! : h.graph.lanes[h.graph.connectors[f['connector'] as number]!.to]!;
      const limit = lane.speed * (f['pace'] as number);
      const lead = this.#leader(car, speedNow);
      const gap = Math.max(0.05, lead.gap);
      const dv = Number.isFinite(lead.speed) ? speedNow - lead.speed : 0;
      const sStar = GAP_MIN + Math.max(0, speedNow * HEADWAY + (speedNow * dv) / (2 * Math.sqrt(A_MAX * B_COMFORT)));
      let accel = A_MAX * (1 - (speedNow / Math.max(0.5, limit)) ** 4 - (lead.gap >= LOOKAHEAD ? 0 : (sStar / gap) ** 2));
      // Slow into turns.
      if ((f['connector'] as number) >= 0) {
        const c = h.graph.connectors[f['connector'] as number]!;
        if (c.turn !== 'straight' && speedNow > 6) accel = Math.min(accel, -1.5);
      }
      accel = Math.max(-9, Math.min(A_MAX, accel));
      const target = Math.max(0, speedNow + accel * dt);
      // A full stop at the line (stop signs count it before letting the car go).
      const atLine = (f['connector'] as number) < 0 && car.path.length - car.s < 3.5;
      f['wait'] = target < 0.3 ? (f['wait'] as number) + dt : 0;
      if (atLine && (f['wait'] as number) >= 0.6) f['stopped'] = true;
      // Blocked a long while (not by a red light): try another way out of the junction.
      if (atLine && (f['wait'] as number) > 14 && lane.out.length > 1) {
        const control = h.graph.control.get(lane.to);
        const red = control === 'signal' && lane.approach >= 0 && signalState(h.graph, h.graph.approaches[lane.approach]!, h.time(), h.spec.traffic.signals) !== 'green';
        if (!red) {
          f['next'] = this.pickNext(lane);
          f['wait'] = 7;
        }
      }
      if (vehicle !== undefined && typeof vehicle.drive === 'function') this.#driveVehicle(car, vehicle, target, dt);
      else this.#moveKinematic(car, target, dt);
    }
  }

  #moveKinematic(car: CarView, speed: number, dt: number): void {
    const f = car.fields;
    f['speed'] = speed;
    let s = (f['s'] as number) + speed * dt;
    const length = car.path.length;
    if (s >= length) {
      this.#advance(f, s - length);
      s = f['s'] as number;
    } else {
      f['s'] = s;
    }
    const path = this.pathOf(f)!;
    const p = pathAt(path, f['s'] as number);
    car.record.transform.position = new Vec3(p.x, this.#h.heightAt(p.x, p.y, p.z), p.z);
    const yaw = (Math.atan2(p.tx, p.tz) * 180) / Math.PI;
    const pitch = (-Math.asin(Math.max(-1, Math.min(1, p.ty))) * 180) / Math.PI;
    car.record.transform.rotation = Quat.from_euler(new Vec3(pitch, yaw, 0));
  }

  #driveVehicle(car: CarView, vehicle: Fields & { drive?: (...a: unknown[]) => void }, target: number, dt: number): void {
    const f = car.fields;
    const pos = car.record.transform.worldPosition();
    const last = f['last'] as Vec3 | null;
    const actual = last === null ? (f['speed'] as number) : Math.hypot(pos.x - last.x, pos.z - last.z) / dt;
    f['last'] = pos;
    // Where the car really is along its path.
    let path = this.pathOf(f)!;
    const hit = pathProject(path, pos.x, pos.z);
    if (Math.abs(hit.lateral) > 6) {
      f['state'] = 'released';
      vehicle.drive!(kw({ throttle: 0, brake: 1, steer: 0 }));
      return;
    }
    if (hit.s >= path.length - 0.3) {
      this.#advance(f, Math.max(0, hit.s - path.length));
      path = this.pathOf(f)!;
    } else {
      f['s'] = Math.max(f['s'] as number, hit.s);
    }
    f['speed'] = actual;
    // Pure pursuit on a point ahead (into the next path when this one ends).
    const ahead = Math.max(5, Math.min(14, actual * 0.9 + 3));
    const point = this.#pointAhead(f, ahead);
    const forward = car.record.transform.worldRotation().rotate(new Vec3(0, 0, 1));
    const dx = point.x - pos.x;
    const dz = point.z - pos.z;
    const alpha = Math.atan2(forward.x * dz - forward.z * dx, forward.x * dx + forward.z * dz);
    const steeringDeg = (vehicle['steering'] as number | undefined) ?? 35;
    const wheelbase = 2.7;
    const angle = Math.atan2(2 * wheelbase * Math.sin(-alpha), ahead);
    const steer = Math.max(-1, Math.min(1, angle / ((steeringDeg * Math.PI) / 180)));
    let throttle = 0;
    let brake = 0;
    if (target < 0.3 && actual < 1.5) brake = 1;
    else if (actual < target - 0.3) throttle = Math.max(0.2, Math.min(1, (target - actual) / 3));
    else if (actual > target + 0.6) brake = Math.max(0.15, Math.min(1, (actual - target) / 4));
    else throttle = 0.12;
    // `drive` is the SDK method: keyword arguments, as game code passes them.
    vehicle.drive!(kw({ throttle, brake, steer }));
  }

  #pointAhead(f: Fields, distance: number): { x: number; z: number } {
    const g = this.#h.graph;
    let path = this.pathOf(f)!;
    let s = (f['s'] as number) + distance;
    if (s <= path.length) {
      const p = pathAt(path, s);
      return { x: p.x, z: p.z };
    }
    s -= path.length;
    const connector = f['connector'] as number;
    const nextPath = connector < 0
      ? g.connectors[f['next'] as number]?.path
      : g.lanes[g.connectors[connector]!.to]?.path;
    if (nextPath === undefined) {
      const p = pathAt(path, path.length);
      return { x: p.x, z: p.z };
    }
    path = nextPath;
    const p = pathAt(path, Math.min(path.length, s));
    return { x: p.x, z: p.z };
  }

  /** Keep `cars` within `radius` of the sources: remove far ones, spawn one per call. */
  populate(): void {
    const h = this.#h;
    const spec = h.spec.traffic;
    if (spec.cars === 0 || h.graph.lanes.length === 0) return;
    const sources = h.sources();
    const k = h.kernel;
    let near = 0;
    for (const [id, fields] of k.world.query([CITY_CAR])) {
      const record = k.world.get(id)!;
      const p = record.transform.worldPosition();
      const d = nearest(sources, p.x, p.z);
      const vehicle = record.components.get('vehicle') as { driver?: unknown } | undefined;
      const occupied = vehicle !== undefined && vehicle.driver !== null && vehicle.driver !== undefined;
      if (d > spec.radius * 1.25 && !occupied && fields!['keep'] !== true) {
        k.destroy(id);
        continue;
      }
      if (fields!['state'] !== 'released' && d <= spec.radius) near++;
    }
    if (near >= spec.cars || sources.length === 0) return;
    // A few tries per frame at a random lane point in the ring around a source.
    for (let attempt = 0; attempt < 6; attempt++) {
      let r = h.rng.next() * this.#total;
      let laneId = 0;
      while (laneId < this.#lengths.length - 1 && r > this.#lengths[laneId]!) r -= this.#lengths[laneId++]!;
      const lane = h.graph.lanes[laneId]!;
      const s = Math.min(lane.path.length - 1, Math.max(1, r));
      const p = pathAt(lane.path, s);
      const d = nearest(sources, p.x, p.z);
      if (d < spec.spawnMin || d > spec.radius) continue;
      if (this.#crowded(laneId, s)) continue;
      const prefab = spec.prefabs[Math.floor(h.rng.next() * spec.prefabs.length)]!;
      const yaw = (Math.atan2(p.tx, p.tz) * 180) / Math.PI;
      const pace = 0.85 + h.rng.next() * 0.3;
      k.spawn(prefab, { at: [p.x, this.#h.heightAt(p.x, p.y, p.z) + 0.05, p.z], rotation: [0, yaw, 0] }, {
        components: {
          [CITY_CAR]: { lane: laneId, connector: -1, next: this.pickNext(lane), s, speed: lane.speed * pace * 0.6, pace, state: 'driving', wait: 0, stopped: false, last: null },
        },
      });
      return;
    }
  }

  #crowded(lane: number, s: number): boolean {
    const k = this.#h.kernel;
    for (const [, fields] of k.world.query([CITY_CAR])) {
      if (fields!['connector'] === -1 && fields!['lane'] === lane && Math.abs((fields!['s'] as number) - s) < 12) return true;
    }
    return false;
  }

  /** Cars on connectors at a node (pedestrians wait while any are crossing). */
  carsAt(node: number): number {
    let n = 0;
    for (const [c, count] of this.#occupied) if (this.#h.graph.connectors[c]!.node === node) n += count;
    return n;
  }

  /** Whether a car is on `edge`'s lanes into `node` within `within` meters of the stop line. */
  approaching(node: number, edge: number, within: number): boolean {
    for (const lane of this.#h.graph.lanes) {
      if (lane.edge !== edge || lane.to !== node) continue;
      const list = this.#onPath.get(`L${lane.id}`);
      if (list !== undefined && list.some((c) => lane.path.length - c.s < within && (c.fields['speed'] as number) > 0.5)) return true;
    }
    return false;
  }
}

export function nearest(sources: readonly Vec3[], x: number, z: number): number {
  let d = Infinity;
  for (const s of sources) d = Math.min(d, Math.hypot(s.x - x, s.z - z));
  return d;
}

export function requireLane(graph: LaneGraph, lane: number, where: string): Lane {
  const l = graph.lanes[lane];
  if (l === undefined) fail('PP7610', `${where}: there is no lane ${lane} in this city`, { fix: 'Use a lane from ctx.city.nearest_lane(...).' });
  return l;
}
