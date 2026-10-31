/**
 * `parallax.city` (sdk/parallax/city.pyi): `CityApi` (the type of `ctx.city`), the CityCar,
 * CityWalker and CityPiece component handles, the values its queries return (CityRoad,
 * CityLane, CityBuilding, CityDistrict, CityLandmark) and the `city()` factory
 * (`parallax.plugins.city`). The city itself lives in the city plugin.
 */

import { fail, Vec2, Vec3 } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import {
  city as cityPlugin, CITY_CAR, CITY_CAR_SCHEMA, CITY_PIECE, CITY_PIECE_SCHEMA, CITY_WALKER, CITY_WALKER_SCHEMA, quadCenter, signalState,
} from '../function/plugins/city/index.js';
import type { Building, CityEngine, CityModel, RoadQuery } from '../function/plugins/city/index.js';
import { buildingAt, buildingsNear, districtAt, nearestLane, nearestRoad, roadAt, route, sidewalkNear } from '../function/plugins/city/index.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';

/** On every car the city drives: state ("driving" / "released"), lane, connector, s, speed, keep. */
export const CityCar = componentHandle({ id: CITY_CAR, schema: CITY_CAR_SCHEMA }, 'CityCar');
/** On every pedestrian the city walks: active (False: game code owns it), speed, flee, keep. */
export const CityWalker = componentHandle({ id: CITY_WALKER, schema: CITY_WALKER_SCHEMA }, 'CityWalker');
/** On every street prop the city placed: role, index, building. */
export const CityPiece = componentHandle({ id: CITY_PIECE, schema: CITY_PIECE_SCHEMA }, 'CityPiece');

const describe = (v: unknown): string => (v === null || v === undefined ? 'None' : String(v));

function point(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  return fail('PP7620', `${where} must be a Vec3, got ${describe(value)}`, { fix: 'Pass a world position, e.g. player.transform.position.' });
}

function number(value: unknown, where: string, fallback?: number): number {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP7620', `${where} must be a number, got ${describe(value)}`);
}

/** A street: where its centerline is nearest, which way it runs, how wide it is. */
export class CityRoad {
  readonly id: number;
  readonly point: Vec3;
  readonly direction: Vec3;
  readonly avenue: boolean;
  readonly lanes: number;
  readonly width: number;
  readonly distance: number;
  readonly bridge: boolean;
  readonly name: string;

  constructor(id: number, point: Vec3, direction: Vec3, avenue: boolean, lanes: number, width: number, distance: number, bridge: boolean, name: string) {
    this.id = id;
    this.point = point;
    this.direction = direction;
    this.avenue = avenue;
    this.lanes = lanes;
    this.width = width;
    this.distance = distance;
    this.bridge = bridge;
    this.name = name;
  }

  toString(): string { return `CityRoad(${this.id}, ${this.avenue ? 'avenue' : 'street'})`; }
}

/** A driving lane at its nearest point: direction of travel and speed limit. */
export class CityLane {
  readonly id: number;
  readonly point: Vec3;
  readonly direction: Vec3;
  readonly speed_limit: number;
  readonly distance: number;
  readonly road: number;

  constructor(id: number, point: Vec3, direction: Vec3, speed_limit: number, distance: number, road: number) {
    this.id = id;
    this.point = point;
    this.direction = direction;
    this.speed_limit = speed_limit;
    this.distance = distance;
    this.road = road;
  }

  toString(): string { return `CityLane(${this.id})`; }
}

export class CityBuilding {
  readonly id: number;
  readonly center: Vec3;
  readonly footprint: Vec3[];
  readonly height: number;
  readonly floors: number;
  readonly district: string;
  readonly kind: string;
  readonly enterable: boolean;
  readonly entrance: Vec3 | null;
  readonly entrance_yaw: number;
  readonly name: string;

  constructor(id: number, center: Vec3, footprint: Vec3[], height: number, floors: number, district: string, kind: string, enterable: boolean, entrance: Vec3 | null, entrance_yaw: number, name: string) {
    this.id = id;
    this.center = center;
    this.footprint = footprint;
    this.height = height;
    this.floors = floors;
    this.district = district;
    this.kind = kind;
    this.enterable = enterable;
    this.entrance = entrance;
    this.entrance_yaw = entrance_yaw;
    this.name = name;
  }

  toString(): string { return `CityBuilding(${this.id}, ${this.kind}, ${this.height.toFixed(0)} m)`; }
}

export class CityDistrict {
  readonly name: string;
  readonly kind: string;
  readonly downtown: number;

  constructor(name: string, kind: string, downtown: number) {
    this.name = name;
    this.kind = kind;
    this.downtown = downtown;
  }

  toString(): string { return `CityDistrict(${this.name})`; }
}

export class CityLandmark {
  readonly name: string;
  readonly kind: string;
  readonly center: Vec3;
  readonly size: Vec2;
  readonly height: number;

  constructor(name: string, kind: string, center: Vec3, size: Vec2, height: number) {
    this.name = name;
    this.kind = kind;
    this.center = center;
    this.size = size;
    this.height = height;
  }

  toString(): string { return `CityLandmark(${this.name}, ${this.kind})`; }
}

/** `ctx.city`: questions about the scene's generated city. */
export class CityApi {
  readonly #engine: CityEngine;

  constructor(engine: CityEngine) {
    this.#engine = engine;
  }

  #model(where: string): CityModel {
    const model = this.#engine.model();
    if (model === null) {
      fail('PP7621', `ctx.city.${where}: scene "${this.#engine.kernel.scene?.id ?? '?'}" has no "city" block`, {
        fix: 'Add a "city" block to the scene (see parallax.city), or check `ctx.city.present` first.',
      });
    }
    return model;
  }

  /** Whether the current scene has a city. */
  get present(): boolean { return this.#engine.model() !== null; }
  get seed(): number { return this.#model('seed').spec.seed; }
  /** Street level (m). */
  get ground(): number { return this.#model('ground').layout.ground; }
  /** The built area's corners (x, z): (min, max). */
  get bounds(): [Vec2, Vec2] {
    const b = this.#model('bounds').layout.bounds;
    return [new Vec2(b[0]!, b[1]!), new Vec2(b[2]!, b[3]!)];
  }

  #road(model: CityModel, q: RoadQuery): CityRoad {
    const e = q.edge;
    return new CityRoad(e.id, new Vec3(q.x, q.y, q.z), new Vec3(q.dx, 0, q.dz), e.major, e.lanes, e.halfWidth * 2, q.distance, e.bridge !== null, e.bridge?.name ?? '');
  }

  #building(b: Building): CityBuilding {
    const c = quadCenter(b.footprint);
    return new CityBuilding(
      b.id, new Vec3(c[0], b.base, c[1]), b.footprint.map((p) => new Vec3(p[0], b.base, p[1])), b.height, b.floors, b.district, b.archetype,
      b.enterable, b.door === null ? null : new Vec3(b.door.x, b.base, b.door.z), b.door?.yaw ?? 0, b.name,
    );
  }

  /** The street under a point (curb to curb), or None on a sidewalk, lot or outside the city. */
  road_at(...args: unknown[]): CityRoad | null {
    const p = point(bindArgs('road_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'road_at() point');
    const model = this.#model('road_at');
    const q = roadAt(model, p.x, p.z);
    return q === null ? null : this.#road(model, q);
  }

  /** The nearest street, wherever the point is. */
  nearest_road(...args: unknown[]): CityRoad {
    const p = point(bindArgs('nearest_road', args, { positional: ['point'], required: ['point'] }).args['point'], 'nearest_road() point');
    const model = this.#model('nearest_road');
    return this.#road(model, nearestRoad(model, p.x, p.z)!);
  }

  /** The nearest driving lane; with `heading` (yaw degrees), one running that way. */
  nearest_lane(...args: unknown[]): CityLane {
    const a = bindArgs('nearest_lane', args, { positional: ['point', 'heading'], required: ['point'] }).args;
    const p = point(a['point'], 'nearest_lane() point');
    const heading = a['heading'] === undefined || a['heading'] === null ? null : number(a['heading'], 'nearest_lane() heading');
    const model = this.#model('nearest_lane');
    const q = nearestLane(model, p.x, p.z, heading)!;
    return new CityLane(q.lane.id, new Vec3(q.x, q.y, q.z), new Vec3(q.tx, 0, q.tz), q.lane.speed, q.distance, q.lane.edge);
  }

  /** A driving route along street centerlines from near `start` to near `end` (for GPS lines and AI). */
  route(...args: unknown[]): Vec3[] {
    const a = bindArgs('route', args, { positional: ['start', 'end'], required: ['start', 'end'] }).args;
    const s = point(a['start'], 'route() start');
    const e = point(a['end'], 'route() end');
    return route(this.#model('route'), s.x, s.z, e.x, e.z).map(([x, y, z]) => new Vec3(x, y, z));
  }

  /** The building whose footprint holds the point, or None. */
  building_at(...args: unknown[]): CityBuilding | null {
    const p = point(bindArgs('building_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'building_at() point');
    const b = buildingAt(this.#model('building_at'), p.x, p.z);
    return b === null ? null : this.#building(b);
  }

  /** Buildings whose centers are within `radius`, nearest first; `enterable=True` keeps only those with an open ground floor. */
  buildings_near(...args: unknown[]): CityBuilding[] {
    const a = bindArgs('buildings_near', args, { positional: ['point', 'radius'], keyword: ['enterable'], required: ['point', 'radius'] }).args;
    const p = point(a['point'], 'buildings_near() point');
    const r = number(a['radius'], 'buildings_near() radius');
    const list = buildingsNear(this.#model('buildings_near'), p.x, p.z, r);
    return (a['enterable'] === true ? list.filter((b) => b.enterable) : list).map((b) => this.#building(b));
  }

  district_at(...args: unknown[]): CityDistrict {
    const p = point(bindArgs('district_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'district_at() point');
    const d = districtAt(this.#model('district_at'), p.x, p.z);
    return new CityDistrict(d.name, d.kind, d.downtown);
  }

  /** The nearest point on a sidewalk within `radius`, or None. */
  sidewalk_point(...args: unknown[]): Vec3 | null {
    const a = bindArgs('sidewalk_point', args, { positional: ['near', 'radius'], required: ['near'] }).args;
    const p = point(a['near'], 'sidewalk_point() near');
    const q = sidewalkNear(this.#model('sidewalk_point'), p.x, p.z, number(a['radius'], 'sidewalk_point() radius', 50));
    return q === null ? null : new Vec3(q[0], q[1], q[2]);
  }

  /** The light facing a driver at `point` heading `heading` (yaw degrees) at the next signal within 40 m: "green", "yellow", "red", or None. */
  signal_at(...args: unknown[]): string | null {
    const a = bindArgs('signal_at', args, { positional: ['point', 'heading'], required: ['point', 'heading'] }).args;
    const p = point(a['point'], 'signal_at() point');
    const heading = number(a['heading'], 'signal_at() heading');
    const model = this.#model('signal_at');
    const hx = Math.sin((heading * Math.PI) / 180);
    const hz = Math.cos((heading * Math.PI) / 180);
    let best: number | null = null;
    let bestD = 40;
    for (const approach of model.graph.approaches) {
      if (approach.phase < 0) continue;
      if (approach.dir[0] * hx + approach.dir[1] * hz < 0.7) continue;
      const node = model.layout.nodes[approach.node]!;
      const ahead = (node.x - p.x) * hx + (node.z - p.z) * hz;
      const d = Math.hypot(node.x - p.x, node.z - p.z);
      if (ahead > 0 && d < bestD) {
        bestD = d;
        best = approach.id;
      }
    }
    return best === null ? null : signalState(model.graph, model.graph.approaches[best]!, this.#engine.time(), model.spec.traffic.signals);
  }

  /** Startle pedestrians within `radius` of `point` (gunfire, a crash): they run from it for `seconds`. Returns how many. */
  alarm(...args: unknown[]): number {
    const a = bindArgs('alarm', args, { positional: ['point', 'radius', 'seconds'], required: ['point'] }).args;
    const p = point(a['point'], 'alarm() point');
    this.#model('alarm');
    return this.#engine.alarm(p, number(a['radius'], 'alarm() radius', 30), number(a['seconds'], 'alarm() seconds', 8));
  }

  /** The city's landmarks, in block order. */
  landmarks(...args: unknown[]): CityLandmark[] {
    bindArgs('landmarks', args, {});
    const model = this.#model('landmarks');
    return model.layout.landmarks.map((l) => {
      const y = model.layout.ground;
      if (l.kind === 'bridge' && l.edge >= 0) {
        const e = model.layout.edges[l.edge]!;
        const A = model.layout.nodes[e.a]!;
        const B = model.layout.nodes[e.b]!;
        return new CityLandmark(l.name, l.kind, new Vec3((A.x + B.x) / 2, y + (e.bridge?.height ?? 0), (A.z + B.z) / 2), new Vec2(e.length, e.halfWidth * 2), e.bridge?.height ?? 0);
      }
      return new CityLandmark(l.name, l.kind, new Vec3(l.at[0], y, l.at[1]), new Vec2(l.size[0], l.size[1]), l.height);
    });
  }

  toString(): string { return 'CityApi'; }
}

/** `parallax.plugins.city()`. */
export function city(...args: unknown[]): KernelPlugin {
  bindArgs('city', args, {});
  const plugin = cityPlugin();
  return { ...plugin, namespace: { name: 'city', create: () => new CityApi(plugin.engine) } };
}
