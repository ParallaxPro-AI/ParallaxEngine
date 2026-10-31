/**
 * The scene's `"city"` block (sdk/parallax/city.pyi has the authoring guide):
 *
 *   "city": {
 *     "seed": 7,
 *     "style": "metropolis",            metropolis | grid | suburb | old_town | industrial
 *     "area": {"center": [0, 0], "size": [1200, 1000]},  the built rectangle (required; full extents)
 *     "ground": 0,                      street level (m); "terrain": the terrain's height at the area's center
 *     "downtown": [0, 0],               x, z of the tallest district (default: the area's center)
 *     "drive": "right",                 which side traffic keeps to
 *     "roads": {"block": [90, 70], "major_every": 4, "major_lanes": 2, "minor_lanes": 1,
 *               "lane_width": 3.3, "sidewalk": 3.5, "curb": 0.15, "angle": 0, "curviness": 0.15,
 *               "merge": 0.12},
 *     "buildings": {"density": 0.85, "height": [8, 160], "falloff": 1.4, "floor_height": 3.4,
 *                   "interiors": 0.15},
 *     "districts": [{"name": "harbor", "kind": "industrial", "at": [-400, 200], "radius": 180}],
 *     "parks": 0.06,
 *     "exclude": [{"center": [x, z], "size": [w, d]}],  footprints the city leaves alone (hand-built places)
 *
 * `area` and `exclude` use the terrain's footprint schema (core/values/footprint_json.ts):
 * {"center", "radius"} | {"center", "size", "rotation"} | {"points"}, world [x, z]. The area
 * is an unrotated {"center", "size"} rectangle (turn the street grid with `roads.angle`).
 *     "props": {"streetlight": "street_lamp", "tree": "street_tree", "hydrant": "fire_hydrant",
 *               "bench": "bench", "bin": "litter_bin", "bus_stop": "bus_stop", "parked": ["sedan"],
 *               "interior": ["counter", "shelf"], "radius": 140},
 *     "traffic": {"cars": 24, "prefabs": ["sedan", "taxi"], "radius": 180, "spawn_min": 70,
 *                 "speed": 13, "signals": {"cycle": 30, "yellow": 3, "all_red": 1}},
 *     "pedestrians": {"count": 30, "prefabs": ["walker_a"], "radius": 90, "spawn_min": 35, "speed": 1.4},
 *     "landmarks": [{"kind": "tower", "at": [40, -30], "height": 320},
 *                   {"kind": "park", "at": [200, 100], "size": [160, 120]},
 *                   {"kind": "plaza", "at": [0, 0], "size": [80, 80]},
 *                   {"kind": "stadium", "at": [-300, -250], "size": [180, 140]},
 *                   {"kind": "bridge", "from": [500, 0], "to": [700, 0], "width": 16, "height": 8}],
 *     "skyline": {"radius": [900, 1800], "count": 80, "height": [30, 140]},
 *     "lod": {"near": 140, "mid": 480, "chunk": 128}
 *   }
 *
 * Everything is deterministic from the block: the same block builds the same city on every
 * machine and thread. Bad data is PP7600 with a JSON pointer and a fix.
 */

import { closestMatch, fail, footprintBounds, readFootprint } from '../../../core/index.js';
import type { Footprint } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';

export const CITY_STYLES = ['metropolis', 'grid', 'suburb', 'old_town', 'industrial'] as const;
export type CityStyle = typeof CITY_STYLES[number];

export const DISTRICT_KINDS = ['downtown', 'commercial', 'residential', 'suburban', 'industrial', 'park'] as const;
export type DistrictKind = typeof DISTRICT_KINDS[number];

export const LANDMARK_KINDS = ['tower', 'park', 'plaza', 'stadium', 'bridge'] as const;
export type LandmarkKind = typeof LANDMARK_KINDS[number];

export const PROP_ROLES = ['streetlight', 'tree', 'hydrant', 'bench', 'bin', 'bus_stop'] as const;
export type PropRole = typeof PROP_ROLES[number];

export interface RoadSpec {
  /** Meters between street centerlines along the grid's x and z. */
  readonly block: readonly [number, number];
  /** Every n-th grid line is an avenue (n >= 2), plus the city's edge. */
  readonly majorEvery: number;
  readonly majorLanes: number;
  readonly minorLanes: number;
  readonly laneWidth: number;
  readonly sidewalk: number;
  readonly curb: number;
  /** Grid rotation, degrees. */
  readonly angle: number;
  /** 0: straight lines; 1: streets bend about a quarter block. */
  readonly curviness: number;
  /** Chance a minor street is left out, merging two blocks. */
  readonly merge: number;
}

export interface BuildingSpec {
  readonly density: number;
  /** Typical height at the edge and at downtown (m). */
  readonly height: readonly [number, number];
  /** How fast height falls off from downtown (higher: a sharper peak). */
  readonly falloff: number;
  readonly floorHeight: number;
  /** Share of buildings with an enterable ground floor. */
  readonly interiors: number;
}

export interface DistrictSpec {
  readonly name: string;
  readonly kind: DistrictKind;
  readonly at: readonly [number, number];
  readonly radius: number;
}

export interface PropSpec {
  readonly roles: Readonly<Partial<Record<PropRole, string>>>;
  readonly parked: readonly string[];
  readonly interior: readonly string[];
  /** Props are entities within this distance of a streaming source. */
  readonly radius: number;
}

export interface SignalSpec {
  readonly cycle: number;
  readonly yellow: number;
  readonly allRed: number;
}

export interface TrafficSpec {
  readonly cars: number;
  readonly prefabs: readonly string[];
  readonly radius: number;
  readonly spawnMin: number;
  /** Street speed limit (m/s); avenues drive 1.25x. */
  readonly speed: number;
  readonly signals: SignalSpec;
}

export interface PedestrianSpec {
  readonly count: number;
  readonly prefabs: readonly string[];
  readonly radius: number;
  readonly spawnMin: number;
  readonly speed: number;
}

export interface LandmarkSpec {
  readonly kind: LandmarkKind;
  readonly name: string;
  readonly at: readonly [number, number];
  readonly size: readonly [number, number];
  readonly height: number;
  /** Bridges: deck ends. */
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly width: number;
}

export interface SkylineSpec {
  readonly radius: readonly [number, number];
  readonly count: number;
  readonly height: readonly [number, number];
}

export interface LodSpec {
  readonly near: number;
  readonly mid: number;
  readonly chunk: number;
}

export interface CitySpec {
  readonly seed: number;
  readonly style: CityStyle;
  readonly area: readonly [number, number, number, number];
  /** Street level, or "terrain" (resolved by the plugin at scene load). */
  readonly ground: number | 'terrain';
  readonly downtown: readonly [number, number];
  readonly drive: 'right' | 'left';
  readonly roads: RoadSpec;
  readonly buildings: BuildingSpec;
  readonly districts: readonly DistrictSpec[];
  readonly parks: number;
  /** Footprints the city leaves alone. */
  readonly exclude: readonly Footprint[];
  readonly props: PropSpec;
  readonly traffic: TrafficSpec;
  readonly pedestrians: PedestrianSpec;
  readonly landmarks: readonly LandmarkSpec[];
  readonly skyline: SkylineSpec | null;
  readonly lod: LodSpec;
}

interface StylePreset {
  readonly roads: Omit<RoadSpec, 'laneWidth' | 'sidewalk' | 'curb' | 'angle'>;
  readonly buildings: Omit<BuildingSpec, 'floorHeight' | 'interiors'>;
  readonly parks: number;
  /** The district every block outside downtown's reach becomes. */
  readonly base: DistrictKind;
}

/** A style fills in every default a field then overrides — pick a style, get a whole city. */
export const STYLE_PRESETS: Readonly<Record<CityStyle, StylePreset>> = {
  metropolis: {
    roads: { block: [92, 74], majorEvery: 4, majorLanes: 2, minorLanes: 1, curviness: 0.12, merge: 0.08 },
    buildings: { density: 0.9, height: [10, 170], falloff: 1.5 }, parks: 0.06, base: 'residential',
  },
  grid: {
    roads: { block: [80, 200], majorEvery: 3, majorLanes: 2, minorLanes: 1, curviness: 0, merge: 0.03 },
    buildings: { density: 0.95, height: [24, 140], falloff: 0.9 }, parks: 0.04, base: 'commercial',
  },
  suburb: {
    roads: { block: [120, 90], majorEvery: 5, majorLanes: 1, minorLanes: 1, curviness: 0.35, merge: 0.18 },
    buildings: { density: 0.55, height: [6, 16], falloff: 1.2 }, parks: 0.12, base: 'suburban',
  },
  old_town: {
    roads: { block: [62, 54], majorEvery: 4, majorLanes: 1, minorLanes: 1, curviness: 0.4, merge: 0.1 },
    buildings: { density: 0.95, height: [9, 30], falloff: 1 }, parks: 0.07, base: 'commercial',
  },
  industrial: {
    roads: { block: [150, 110], majorEvery: 3, majorLanes: 2, minorLanes: 1, curviness: 0.05, merge: 0.2 },
    buildings: { density: 0.7, height: [8, 22], falloff: 0.8 }, parks: 0.02, base: 'industrial',
  },
};

const BLOCK_KEYS = [
  'seed', 'style', 'area', 'ground', 'downtown', 'drive', 'roads', 'buildings', 'districts', 'parks', 'exclude', 'props', 'traffic',
  'pedestrians', 'landmarks', 'skyline', 'lod',
] as const;

/** Reads JSON with pointers; every failure is PP7600. */
class Reader {
  readonly where: string;

  constructor(where: string) {
    this.where = where;
  }

  bad(pointer: string, message: string, fix: string): never {
    return fail('PP7600', `${this.where}${pointer}: ${message}`, { fix });
  }

  object(value: Json | undefined, pointer: string, keys: readonly string[]): JsonObject {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) this.bad(pointer, 'must be an object', 'Write {"key": value, ...}.');
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        const guess = closestMatch(key, [...keys]);
        this.bad(`${pointer}/${key}`, `"${key}" is not a field here`, guess === undefined ? `Fields: ${keys.join(', ')}.` : `Did you mean "${guess}"?`);
      }
    }
    return value as JsonObject;
  }

  number(obj: JsonObject, key: string, pointer: string, fallback: number, min = -Infinity, max = Infinity): number {
    const value = obj[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) this.bad(`${pointer}/${key}`, `must be a number, got ${JSON.stringify(value)}`, `Write "${key}": ${fallback}.`);
    if (value < min || value > max) this.bad(`${pointer}/${key}`, `${value} is out of range`, `Use ${min} to ${max === Infinity ? 'any larger value' : max}.`);
    return value;
  }

  int(obj: JsonObject, key: string, pointer: string, fallback: number, min = 0, max = Infinity): number {
    const value = this.number(obj, key, pointer, fallback, min, max);
    if (!Number.isInteger(value)) this.bad(`${pointer}/${key}`, `must be a whole number, got ${value}`, `Write "${key}": ${Math.round(value)}.`);
    return value;
  }

  string(obj: JsonObject, key: string, pointer: string, fallback: string): string {
    const value = obj[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') this.bad(`${pointer}/${key}`, `must be a string, got ${JSON.stringify(value)}`, `Write "${key}": "${fallback}".`);
    return value;
  }

  choice<T extends string>(obj: JsonObject, key: string, pointer: string, choices: readonly T[], fallback: T): T {
    const value = this.string(obj, key, pointer, fallback);
    if (!(choices as readonly string[]).includes(value)) {
      const guess = closestMatch(value, [...choices]);
      this.bad(`${pointer}/${key}`, `"${value}" is not one of ${choices.join(', ')}`, guess === undefined ? `Use one of ${choices.join(', ')}.` : `Did you mean "${guess}"?`);
    }
    return value as T;
  }

  pair(value: Json | undefined, pointer: string, fallback: readonly [number, number] | undefined, what = 'x, z'): [number, number] {
    if (value === undefined || value === null) {
      if (fallback === undefined) this.bad(pointer, `is required (${what})`, `Write [${what}].`);
      return [fallback[0], fallback[1]];
    }
    if (typeof value === 'number' && Number.isFinite(value)) return [value, value];
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      this.bad(pointer, `must be two numbers [${what}], got ${JSON.stringify(value)}`, `Write [${what}].`);
    }
    return [value[0] as number, value[1] as number];
  }

  strings(obj: JsonObject, key: string, pointer: string): string[] {
    const value = obj[key];
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) this.bad(`${pointer}/${key}`, 'must be a list of prefab ids', `Write "${key}": ["prefab_id"].`);
    return value as string[];
  }

  /** A footprint (the terrain's schema); PP7600 at its pointer. */
  footprint(value: Json | undefined, pointer: string): Footprint {
    return readFootprint(value, pointer, (at, message, fix) => this.bad(at, message, fix));
  }

  list(obj: JsonObject, key: string, pointer: string): Json[] {
    const value = obj[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) this.bad(`${pointer}/${key}`, 'must be a list', `Write "${key}": [...].`);
    return value;
  }
}

/** The scene's city block as a resolved spec (style defaults filled in). PP7600 on bad data. */
export function readCitySpec(raw: Json, where = 'city'): CitySpec {
  const r = new Reader(where);
  const obj = r.object(raw, '', BLOCK_KEYS);
  const style = r.choice(obj, 'style', '', CITY_STYLES, 'metropolis');
  const preset = STYLE_PRESETS[style];
  if (obj['area'] === undefined) r.bad('/area', 'is required', 'Write "area": {"center": [x, z], "size": [w, d]} — the city\'s rectangle, full width and depth.');
  const areaShape = r.footprint(obj['area'], '/area');
  if (areaShape.kind !== 'rect' || Math.abs(areaShape.sin) > 1e-9 || areaShape.cos < 0) {
    r.bad('/area', 'a city area is an unrotated {"center": [x, z], "size": [w, d]} rectangle', 'Write "area": {"center": [x, z], "size": [w, d]}; turn the street grid with "roads": {"angle": deg}, and leave places out with "exclude".');
  }
  const areaBounds = footprintBounds(areaShape, 0);
  const rect: [number, number, number, number] = [areaBounds.minX, areaBounds.minZ, areaBounds.maxX, areaBounds.maxZ];
  if (rect[2] - rect[0] < 60 || rect[3] - rect[1] < 60) r.bad('/area', 'must be at least 60 m on each side', 'Make the area larger.');
  if (rect[2] - rect[0] > 8000 || rect[3] - rect[1] > 8000) r.bad('/area', 'must be at most 8 km on each side', 'Split a larger world into several scenes, or shrink the area.');

  const groundRaw = obj['ground'];
  let ground: number | 'terrain' = 0;
  if (groundRaw === 'terrain') ground = 'terrain';
  else if (groundRaw !== undefined) ground = r.number(obj, 'ground', '', 0);

  const roadsObj = r.object(obj['roads'], '/roads', ['block', 'major_every', 'major_lanes', 'minor_lanes', 'lane_width', 'sidewalk', 'curb', 'angle', 'curviness', 'merge']);
  const block = r.pair(roadsObj['block'], '/roads/block', preset.roads.block, 'along x, along z');
  if (block[0] < 30 || block[1] < 30) r.bad('/roads/block', 'blocks must be at least 30 m between street centerlines', 'Use 50 to 200.');
  const roads: RoadSpec = {
    block,
    majorEvery: r.int(roadsObj, 'major_every', '/roads', preset.roads.majorEvery, 2, 50),
    majorLanes: r.int(roadsObj, 'major_lanes', '/roads', preset.roads.majorLanes, 1, 4),
    minorLanes: r.int(roadsObj, 'minor_lanes', '/roads', preset.roads.minorLanes, 1, 2),
    laneWidth: r.number(roadsObj, 'lane_width', '/roads', 3.3, 2.5, 5),
    sidewalk: r.number(roadsObj, 'sidewalk', '/roads', style === 'suburb' ? 2.2 : 3.5, 1, 10),
    curb: r.number(roadsObj, 'curb', '/roads', 0.15, 0, 0.4),
    angle: r.number(roadsObj, 'angle', '/roads', 0, -180, 180),
    curviness: r.number(roadsObj, 'curviness', '/roads', preset.roads.curviness, 0, 1),
    merge: r.number(roadsObj, 'merge', '/roads', preset.roads.merge, 0, 0.6),
  };

  const bObj = r.object(obj['buildings'], '/buildings', ['density', 'height', 'falloff', 'floor_height', 'interiors']);
  const height = r.pair(bObj['height'], '/buildings/height', preset.buildings.height, 'edge, downtown');
  if (height[0] < 3 || height[1] < height[0] || height[1] > 600) r.bad('/buildings/height', 'must be [edge, downtown] with 3 <= edge <= downtown <= 600', 'Write "height": [10, 150].');
  const buildings: BuildingSpec = {
    density: r.number(bObj, 'density', '/buildings', preset.buildings.density, 0, 1),
    height,
    falloff: r.number(bObj, 'falloff', '/buildings', preset.buildings.falloff, 0.2, 5),
    floorHeight: r.number(bObj, 'floor_height', '/buildings', 3.4, 2.6, 6),
    interiors: r.number(bObj, 'interiors', '/buildings', 0.12, 0, 1),
  };

  const districts = r.list(obj, 'districts', '').map((raw, i): DistrictSpec => {
    const p = `/districts/${i}`;
    const d = r.object(raw, p, ['name', 'kind', 'at', 'radius']);
    if (d['kind'] === undefined) r.bad(`${p}/kind`, 'is required', `Use one of ${DISTRICT_KINDS.join(', ')}.`);
    const kind = r.choice(d, 'kind', p, DISTRICT_KINDS, 'commercial');
    return { name: r.string(d, 'name', p, `${kind}_${i}`), kind, at: r.pair(d['at'], `${p}/at`, undefined), radius: r.number(d, 'radius', p, 200, 10) };
  });

  const exclude = r.list(obj, 'exclude', '').map((raw, i) => r.footprint(raw, `/exclude/${i}`));

  const pObj = r.object(obj['props'], '/props', [...PROP_ROLES, 'parked', 'interior', 'radius']);
  const roles: Partial<Record<PropRole, string>> = {};
  for (const role of PROP_ROLES) {
    const id = pObj[role];
    if (id === undefined || id === null) continue;
    if (typeof id !== 'string' || id === '') r.bad(`/props/${role}`, 'must be a prefab id', `Write "${role}": "<prefab id>", or leave it out.`);
    roles[role] = id as string;
  }
  const props: PropSpec = {
    roles, parked: r.strings(pObj, 'parked', '/props'), interior: r.strings(pObj, 'interior', '/props'),
    radius: r.number(pObj, 'radius', '/props', 140, 20, 1000),
  };

  const tObj = r.object(obj['traffic'], '/traffic', ['cars', 'prefabs', 'radius', 'spawn_min', 'speed', 'signals']);
  const sObj = r.object(tObj['signals'], '/traffic/signals', ['cycle', 'yellow', 'all_red']);
  const traffic: TrafficSpec = {
    cars: r.int(tObj, 'cars', '/traffic', 0, 0, 400),
    prefabs: r.strings(tObj, 'prefabs', '/traffic'),
    radius: r.number(tObj, 'radius', '/traffic', 180, 30, 2000),
    spawnMin: r.number(tObj, 'spawn_min', '/traffic', 70, 0, 2000),
    speed: r.number(tObj, 'speed', '/traffic', 12, 2, 60),
    signals: {
      cycle: r.number(sObj, 'cycle', '/traffic/signals', 30, 8, 240),
      yellow: r.number(sObj, 'yellow', '/traffic/signals', 3, 0.5, 10),
      allRed: r.number(sObj, 'all_red', '/traffic/signals', 1, 0, 10),
    },
  };
  if (traffic.cars > 0 && traffic.prefabs.length === 0) r.bad('/traffic/prefabs', 'is empty but "cars" is above 0', 'List the car prefabs: "prefabs": ["sedan", "taxi"].');
  if (traffic.spawnMin >= traffic.radius) r.bad('/traffic/spawn_min', 'must be below "radius"', 'Spawn cars between spawn_min and radius of the player.');
  if ((traffic.signals.yellow + traffic.signals.allRed) * 2 >= traffic.signals.cycle) r.bad('/traffic/signals', 'yellow and all_red leave no green time', 'Lengthen "cycle" or shorten "yellow" / "all_red".');

  const wObj = r.object(obj['pedestrians'], '/pedestrians', ['count', 'prefabs', 'radius', 'spawn_min', 'speed']);
  const pedestrians: PedestrianSpec = {
    count: r.int(wObj, 'count', '/pedestrians', 0, 0, 400),
    prefabs: r.strings(wObj, 'prefabs', '/pedestrians'),
    radius: r.number(wObj, 'radius', '/pedestrians', 90, 10, 1000),
    spawnMin: r.number(wObj, 'spawn_min', '/pedestrians', 30, 0, 1000),
    speed: r.number(wObj, 'speed', '/pedestrians', 1.4, 0.3, 6),
  };
  if (pedestrians.count > 0 && pedestrians.prefabs.length === 0) r.bad('/pedestrians/prefabs', 'is empty but "count" is above 0', 'List the walker prefabs: "prefabs": ["pedestrian"].');
  if (pedestrians.spawnMin >= pedestrians.radius) r.bad('/pedestrians/spawn_min', 'must be below "radius"', 'Spawn walkers between spawn_min and radius of the player.');

  const center: [number, number] = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
  const landmarks = r.list(obj, 'landmarks', '').map((raw, i): LandmarkSpec => {
    const p = `/landmarks/${i}`;
    const l = r.object(raw, p, ['kind', 'name', 'at', 'size', 'height', 'from', 'to', 'width']);
    if (l['kind'] === undefined) r.bad(`${p}/kind`, 'is required', `Use one of ${LANDMARK_KINDS.join(', ')}.`);
    const kind = r.choice(l, 'kind', p, LANDMARK_KINDS, 'tower');
    const bridge = kind === 'bridge';
    const from = bridge ? r.pair(l['from'], `${p}/from`, undefined) : [0, 0] as [number, number];
    const to = bridge ? r.pair(l['to'], `${p}/to`, undefined) : [0, 0] as [number, number];
    const at = bridge ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] as [number, number] : r.pair(l['at'], `${p}/at`, undefined);
    const defaults: Record<LandmarkKind, [number, number, number]> = {
      tower: [40, 40, 300], park: [140, 110, 0], plaza: [70, 70, 0], stadium: [190, 150, 28], bridge: [0, 0, 8],
    };
    const [dw, dd, dh] = defaults[kind];
    const size = r.pair(l['size'], `${p}/size`, [dw, dd], 'x, z');
    return {
      kind, name: r.string(l, 'name', p, `${kind}_${i}`), at, size, height: r.number(l, 'height', p, dh, 0, 1200), from, to,
      width: r.number(l, 'width', p, 14, 4, 60),
    };
  });

  let skyline: SkylineSpec | null = null;
  if (obj['skyline'] !== undefined && obj['skyline'] !== null) {
    const k = r.object(obj['skyline'], '/skyline', ['radius', 'count', 'height']);
    const span = Math.max(rect[2] - rect[0], rect[3] - rect[1]);
    const radius = r.pair(k['radius'], '/skyline/radius', [span * 0.8, span * 1.6], 'inner, outer');
    if (radius[1] <= radius[0]) r.bad('/skyline/radius', 'outer must be above inner', 'Write "radius": [900, 1800].');
    skyline = { radius, count: r.int(k, 'count', '/skyline', 60, 0, 2000), height: r.pair(k['height'], '/skyline/height', [25, 120], 'low, high') };
  }

  const lObj = r.object(obj['lod'], '/lod', ['near', 'mid', 'chunk']);
  const lod: LodSpec = {
    near: r.number(lObj, 'near', '/lod', 140, 20, 2000),
    mid: r.number(lObj, 'mid', '/lod', 480, 40, 8000),
    chunk: r.number(lObj, 'chunk', '/lod', 128, 32, 1024),
  };
  if (lod.mid <= lod.near) r.bad('/lod/mid', 'must be above "near"', 'Write "lod": {"near": 140, "mid": 480}.');

  return {
    seed: r.int(obj, 'seed', '', 1, 0, 2 ** 31 - 1),
    style,
    area: rect,
    ground,
    downtown: r.pair(obj['downtown'], '/downtown', center),
    drive: r.choice(obj, 'drive', '', ['right', 'left'] as const, 'right'),
    roads,
    buildings,
    districts,
    parks: r.number(obj, 'parks', '', preset.parks, 0, 0.8),
    exclude,
    props,
    traffic,
    pedestrians,
    landmarks,
    skyline,
    lod,
  };
}

/** The district kind a style uses where no district or downtown reaches. */
export function baseDistrict(style: CityStyle): DistrictKind {
  return STYLE_PRESETS[style].base;
}

/** Every prefab id the spec names, with the JSON pointer naming it (for checks). */
export function prefabsOf(spec: CitySpec): { readonly id: string; readonly pointer: string }[] {
  const out: { id: string; pointer: string }[] = [];
  for (const role of PROP_ROLES) {
    const id = spec.props.roles[role];
    if (id !== undefined) out.push({ id, pointer: `/props/${role}` });
  }
  spec.props.parked.forEach((id, i) => out.push({ id, pointer: `/props/parked/${i}` }));
  spec.props.interior.forEach((id, i) => out.push({ id, pointer: `/props/interior/${i}` }));
  spec.traffic.prefabs.forEach((id, i) => out.push({ id, pointer: `/traffic/prefabs/${i}` }));
  spec.pedestrians.prefabs.forEach((id, i) => out.push({ id, pointer: `/pedestrians/prefabs/${i}` }));
  return out;
}
