/**
 * city — procedural cities from the scene's `"city"` block (sdk/parallax/city.pyi): a warped
 * street grid with avenues, blocks with sidewalks and curbs, lots and building massing by
 * district (towers with setbacks, podiums, storefront blocks, apartments, houses, warehouses),
 * facades and enterable ground floors, parks and plazas, landmarks (a spire, a stadium,
 * bridges) and a far skyline; ambient traffic on lanes through signalized and stop-controlled
 * junctions; pedestrians on the sidewalks and crosswalks; street furniture from the game's
 * prefabs. Everything is a pure function of the block, so every machine builds the same city.
 *
 * Geometry streams by chunk (`lod.chunk` m squares) at three levels of detail around the
 * streaming sources (cameras, followed and player-owned entities), built off the main thread
 * through the job runner (`city.chunk`) when it has workers — a chunk keeps its coarser mesh
 * until the finer one lands — and on the spot otherwise. Collision is per chunk, the same at
 * every level, built at scene load. Renderers, physics and nav read it all through
 * CITY_SERVICE (procgen's GeneratedMesh shape).
 *
 * Entities. Props (`city_piece`) are spawned within `props.radius` of a source and removed
 * beyond it; one the game destroys, or a parked car someone moves or drives, is never put
 * back this scene. Traffic (`city_car`, traffic.ts) and pedestrians (`city_walker`,
 * walkers.ts) are topped up in the 'input' hook and moved in the 'physics' hook (walkers
 * first, so cars see who is on a crosswalk). They are ordinary entities: snapshots hold
 * them, and this plugin's snapshot holds the signal clock, its random state and which
 * props are out.
 */

import { closestMatch, fail, SeededRandom, Vec3 } from '../../../core/index.js';
import type { EntityId, JobKey } from '../../../core/index.js';
import { jobKey } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { t } from '../../kernel/index.js';
import type { ComponentDef, Kernel, KernelPlugin, Schema } from '../../kernel/index.js';
import { CITY_SERVICE, ENVIRONMENT_SERVICE, JOBS_SERVICE, NAV_SERVICE, STREAMING_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { CityMap, CityService, GeneratedMaterial, GeneratedMesh, GeneratedPart } from '../../services/index.js';
import { chunkCollision, chunkGeometry, indexChunks, PART_NAMES, signalLamps, skylineGeometry } from './geometry.js';
import type { ChunkContent, ChunkGeometry, ChunkIndex, Lod, PartName } from './geometry.js';
import type { CityLayout } from './layout.js';
import { generateCity } from './layout.js';
import type { LaneGraph, SignalState } from './lanes.js';
import { buildLanes, signalState } from './lanes.js';
import type { CitySurface } from './mesh.js';
import type { CitySpec } from './spec.js';
import { prefabsOf, readCitySpec } from './spec.js';
import { CITY_CAR, Traffic } from './traffic.js';
import { buildWalkGraph, CITY_WALKER, Walkers } from './walkers.js';
import type { WalkGraph } from './walkers.js';

export { CITY_STYLES, DISTRICT_KINDS, LANDMARK_KINDS, PROP_ROLES, readCitySpec, STYLE_PRESETS } from './spec.js';
export type { CitySpec, CityStyle, DistrictKind, LandmarkKind, PropRole } from './spec.js';
export { bilinear, districtOf, edgeHeight, generateCity, inQuad, insetQuad, quadCenter } from './layout.js';
export type { Building, Cell, CityLayout, PropPlacement, Quad, RoadEdge, RoadNode, XZ } from './layout.js';
export { buildLanes, crossDistance, pathAt, pathProject, signalState, stopDistance } from './lanes.js';
export type { Approach, Connector, Lane, LaneGraph, Path, SignalState, Turn } from './lanes.js';
export { chunkCollision, chunkGeometry, indexChunks, PART_NAMES } from './geometry.js';
export type { ChunkContent, ChunkGeometry, ChunkGeometry as CityChunkGeometry, ChunkIndex, Lod } from './geometry.js';
export { buildWalkGraph, CITY_WALKER } from './walkers.js';
export type { WalkEdge, WalkGraph, WalkNode } from './walkers.js';
export { CITY_CAR } from './traffic.js';
export { buildingAt, buildingsNear, districtAt, nearestLane, nearestRoad, roadAt, route, sidewalkNear } from './queries.js';
export type { LaneQuery, RoadQuery } from './queries.js';

export const CITY_PIECE = 'city_piece';

export const CITY_CAR_SCHEMA: Schema = {
  /** "driving", or "released": the city no longer steers it (someone got in, it was knocked off its lane). */
  state: t.enum(['driving', 'released'], { default: 'driving' }),
  lane: t.int({ default: 0, min: 0 }),
  /** The junction connector it is crossing, −1 on a lane. */
  connector: t.int({ default: -1, min: -1 }),
  /** The connector it will take at the end of its lane (−1: none yet). */
  next: t.int({ default: -1, min: -1 }),
  /** Meters along its lane or connector. */
  s: t.number({ default: 0, min: 0 }),
  speed: t.number({ default: 0 }),
  /** Its own pace: a multiple of the speed limit. */
  pace: t.number({ default: 1, min: 0.1 }),
  wait: t.number({ default: 0, min: 0 }),
  stopped: t.bool({ default: false }),
  /** Never despawned by distance. */
  keep: t.bool({ default: false }),
  last: { type: { kind: 'optional', of: { kind: 'vec3' } }, default: null },
};

export const CITY_WALKER_SCHEMA: Schema = {
  /** False: game code owns this walker (the city only removes it when far, unless `keep`). */
  active: t.bool({ default: true }),
  edge: t.int({ default: 0, min: 0 }),
  forward: t.bool({ default: true }),
  s: t.number({ default: 0, min: 0 }),
  /** Meters right of the walking line. */
  offset: t.number({ default: 0.5 }),
  speed: t.number({ default: 1.4, min: 0 }),
  wait: t.number({ default: 0, min: 0 }),
  /** Seconds left running from an alarm. */
  flee: t.number({ default: 0, min: 0 }),
  danger: { type: { kind: 'optional', of: { kind: 'vec3' } }, default: null },
  sent: t.bool({ default: false }),
  keep: t.bool({ default: false }),
};

export const CITY_PIECE_SCHEMA: Schema = {
  /** streetlight, tree, hydrant, bench, bin, bus_stop, parked or interior. */
  role: t.string({ default: '' }),
  /** The placement's index in the city plan. */
  index: t.int({ default: 0, min: 0 }),
  /** The building it furnishes (interiors), else −1. */
  building: t.int({ default: -1, min: -1 }),
};

/** The chunk job: the plan is rebuilt from the spec (and cached) on whichever thread runs it. */
export interface CityChunkInput {
  readonly spec: CitySpec;
  readonly ground: number;
  readonly chunk: string;
  readonly lod: Lod;
  readonly builtinLamps: boolean;
}
export const CITY_CHUNK: JobKey<CityChunkInput, ChunkGeometry> = jobKey<CityChunkInput, ChunkGeometry>('city.chunk');

export interface CityModel {
  readonly key: string;
  readonly spec: CitySpec;
  readonly layout: CityLayout;
  readonly graph: LaneGraph;
  readonly walk: WalkGraph;
  readonly index: ChunkIndex;
}

const models = new Map<string, CityModel>();

/** The plan, lanes, sidewalks and chunk index of a spec at a street level (memoized: workers build each city once). */
export function cityModel(spec: CitySpec, ground: number): CityModel {
  const key = `${JSON.stringify(spec)}|${ground}`;
  const hit = models.get(key);
  if (hit !== undefined) return hit;
  const layout = generateCity(spec, ground);
  const graph = buildLanes(layout, { drive: spec.drive, speed: spec.traffic.speed, seed: spec.seed, signals: spec.traffic.signals });
  const model: CityModel = { key, spec, layout, graph, walk: buildWalkGraph(layout), index: indexChunks(layout, graph, spec.lod.chunk) };
  if (models.size >= 4) models.delete(models.keys().next().value!);
  models.set(key, model);
  return model;
}

/** The `city.chunk` job (boot/jobs.ts serves it). */
export function buildChunkJob(input: CityChunkInput): ChunkGeometry {
  const model = cityModel(input.spec, input.ground);
  const content = model.index.chunks.get(input.chunk);
  if (content === undefined) fail('PP9760', `city.chunk: there is no chunk ${input.chunk}`);
  return chunkGeometry(model.layout, model.graph, content, input.lod, { builtinLamps: input.builtinLamps, drive: input.spec.drive });
}

/** A textured city material: a photographed, tileable surface on the ParallaxPro asset store
 *  (CC0, content-addressed), tiled by the part's world-projected UVs (`PART_TILES`). A run
 *  that can't fetch it draws the vertex colours alone. */
function textured(name: string, sha: string, roughness: number): GeneratedMaterial {
  const texture = `https://r2.parallaxpro.ai/assets/image_texture/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.jpg`;
  return { id: `city|${name}`, color: [1, 1, 1, 1], texture, roughness, metallic: 0, blend: false, doubleSided: false, unlit: false };
}

const MATERIALS: Readonly<Record<PartName, GeneratedMaterial>> = {
  matte: { id: 'city|matte', color: [1, 1, 1, 1], texture: null, roughness: 0.9, metallic: 0, blend: false, doubleSided: false, unlit: false },
  glass: { id: 'city|glass', color: [1, 1, 1, 1], texture: null, roughness: 0.12, metallic: 0.45, blend: false, doubleSided: false, unlit: false },
  metal: { id: 'city|metal', color: [1, 1, 1, 1], texture: null, roughness: 0.42, metallic: 0.65, blend: false, doubleSided: false, unlit: false },
  lit: { id: 'city|lit', color: [1, 1, 1, 1], texture: null, roughness: 1, metallic: 0, blend: false, doubleSided: false, unlit: true },
  asphalt: textured('asphalt', '99b6f6bdfbd09279f3f550ac9593336df541aa2319537566eeb3e737d8512010', 0.92),
  paving: textured('paving', '70d3ff969a7421c7ae057b5d16386d11f5e59c6740db643352e1039413f419c4', 0.88),
  brick: textured('brick', '415017e21a9efc3ed5ab2a43a1c58855fadac8d4181c4bb84e4366a1cc0b687e', 0.88),
  plaster: textured('plaster', 'a1ebbe091bd1ae93d2abd5de8d69f9003a8d0ee6532bcf9a87c2492c97051f23', 0.88),
};
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface ChunkState {
  readonly content: ChunkContent;
  readonly collision: { readonly vertices: Float32Array; readonly indices: Uint32Array } | null;
  readonly collisionVersion: number;
  /** The level it should show (with hysteresis). */
  want: Lod;
  readonly built: Map<Lod, ChunkGeometry>;
  readonly used: Map<Lod, number>;
  /** Levels with a job in flight. */
  readonly pending: Set<Lod>;
  /** The mesh last handed out: rebuilt when the shown level or night changes. */
  mesh: GeneratedMesh | null;
  meshLod: Lod | -1;
  meshNight: boolean;
}

interface CityState {
  readonly model: CityModel;
  readonly sceneId: string;
  readonly chunks: Map<string, ChunkState>;
  readonly traffic: Traffic;
  readonly walkers: Walkers;
  readonly skyline: GeneratedMesh | null;
  frame: number;
  list: readonly GeneratedMesh[];
  signals: GeneratedMesh | null;
  signalKey: string;
  /** Prop index → its entity. */
  readonly props: Map<number, EntityId>;
  /** Props that never come back this scene (destroyed by the game, parked cars taken). */
  readonly gone: Set<number>;
  nextProps: number;
}

/** What `ctx.city` is built on. */
export interface CityEngine {
  readonly kernel: Kernel;
  /** The current scene's city, or null when it has no "city" block. */
  model(): CityModel | null;
  /** Signal clock (s). */
  time(): number;
  signal(approach: number): SignalState;
  alarm(point: Vec3, radius: number, seconds: number): number;
  random(): number;
}

export interface CityPlugin extends KernelPlugin {
  readonly service: CityService;
  readonly engine: CityEngine;
}

const MAX_JOBS = 3;
const LOD_HYSTERESIS = 1.12;

/** The city as a street map draws it (CityService.map). */
export function cityMap(layout: CityLayout): CityMap {
  const nodes = layout.nodes;
  return {
    bounds: layout.bounds,
    blocks: layout.cells.map((c) => c.curb),
    parks: layout.cells.filter((c) => c.kind === 'park' || c.kind === 'plaza').map((c) => c.lot),
    buildings: layout.buildings.map((b) => b.footprint),
    streets: layout.edges.map((e) => ({
      a: [nodes[e.a]!.x, nodes[e.a]!.z] as const, b: [nodes[e.b]!.x, nodes[e.b]!.z] as const, width: e.halfWidth * 2, major: e.major,
    })),
  };
}

export function city(): CityPlugin {
  let installed: Kernel | undefined;
  /** undefined: not built for this scene yet; null: the scene has no city. */
  let state: CityState | null | undefined;
  let clock = 0;
  let rng = new SeededRandom(0x63697479);
  let revision = 0;
  let restored: { clock: number; rng: readonly [number, number, number, number]; gone: number[]; props: [number, number][] } | null = null;
  let versions = 0;

  const kernel = (): Kernel => {
    if (installed === undefined) fail('PP9761', 'city is used before its game started', { fix: 'Add city() to Game(plugins=[...]).' });
    return installed;
  };

  const sources = (): Vec3[] => kernel().tryService(STREAMING_SERVICE)?.sources().map((s) => s.position) ?? [];

  const ensure = (): CityState | null => {
    if (state !== undefined) return state;
    const k = kernel();
    const scene = k.scene;
    const block = scene?.plugins['city'];
    if (scene === undefined || block === undefined) {
      state = null;
      return null;
    }
    const where = `scenes/${scene.id}/scene.json "city"`;
    const spec = readCitySpec(block as Json, where);
    for (const { id, pointer } of prefabsOf(spec)) {
      if (k.project.prefabs.has(id)) continue;
      const guess = closestMatch(id, k.project.prefabs.keys());
      fail('PP7601', `${where}${pointer}: there is no prefab "${id}"`, {
        fix: guess === undefined ? 'Add the prefab (parallax library add <piece> copies one), or remove it from the city block.' : `Did you mean "${guess}"?`,
      });
    }
    let ground = 0;
    if (spec.ground === 'terrain') {
      const field = k.tryService(TERRAIN_SERVICE)?.current() ?? null;
      if (field === null) fail('PP7602', `${where}/ground: "terrain" but the scene has no terrain`, { fix: 'Give "ground" a number, or add a terrain block and terrain() to the plugins.' });
      ground = field.heightAt((spec.area[0] + spec.area[2]) / 2, (spec.area[1] + spec.area[3]) / 2);
    } else {
      ground = spec.ground;
    }
    const model = cityModel(spec, ground);
    const chunks = new Map<string, ChunkState>();
    for (const content of model.index.chunks.values()) {
      const solid = chunkCollision(model.layout, content);
      chunks.set(content.key, {
        content, collision: solid.indices.length === 0 ? null : solid, collisionVersion: ++versions, want: 2, built: new Map(), used: new Map(),
        pending: new Set(), mesh: null, meshLod: -1, meshNight: false,
      });
    }
    if (restored === null) {
      clock = 0;
      rng = new SeededRandom((spec.seed ^ 0x63697479) >>> 0);
    }
    const host = {
      kernel: k, spec, layout: model.layout, graph: model.graph, rng, walk: model.walk,
      time: () => clock, sources,
    };
    let walkers: Walkers;
    const traffic = new Traffic({
      ...host,
      crosswalkBusy: (node: number, edge: number) => walkers.busy.has(`${node}:${edge}`),
      heightAt: (_x: number, y: number) => y,
    });
    walkers = new Walkers({
      ...host,
      trafficOn: (node: number, edge: number) => traffic.approaching(node, edge, 16) || traffic.carsAt(node) > 0,
      nav: () => k.tryService(NAV_SERVICE),
    });
    const sky = skylineGeometry(model.layout);
    const skyline: GeneratedMesh | null = sky === null ? null : {
      key: 'city:skyline', entity: null, version: ++versions, world: IDENTITY, collision: null, collisionVersion: 0,
      parts: [part(`city:${scene.id}:skyline`, sky, MATERIALS.matte, false)],
    };
    const fresh: CityState = {
      model, sceneId: scene.id, chunks, traffic, walkers, skyline, frame: -1, list: [], signals: null, signalKey: '', props: new Map(), gone: new Set(), nextProps: 0,
    };
    if (restored !== null) {
      for (const g of restored.gone) fresh.gone.add(g);
      for (const [p, e] of restored.props) fresh.props.set(p, e as EntityId);
      restored = null;
    }
    state = fresh;
    revision++;
    return state;
  };

  const part = (id: string, s: CitySurface, material: GeneratedMaterial, shadows: boolean): GeneratedPart => ({
    geometry: {
      id, positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices, joints: null, weights: null, colors: s.colors,
      min: [s.min[0], s.min[1], s.min[2]], max: [s.max[0], s.max[1], s.max[2]],
    },
    material,
    castShadows: shadows,
  });

  const distanceTo = (bounds: readonly number[], points: readonly Vec3[]): number => {
    let d = Infinity;
    for (const p of points) {
      const dx = Math.max(bounds[0]! - p.x, 0, p.x - bounds[2]!);
      const dz = Math.max(bounds[1]! - p.z, 0, p.z - bounds[3]!);
      d = Math.min(d, Math.hypot(dx, dz));
    }
    return d;
  };

  /** Ask for a chunk level: built now (inline runners), or a job (workers). */
  const request = (s: CityState, c: ChunkState, lod: Lod, inFlight: { n: number }): void => {
    if (c.built.has(lod) || c.pending.has(lod)) return;
    const spec = s.model.spec;
    const input: CityChunkInput = { spec, ground: s.model.layout.ground, chunk: c.content.key, lod, builtinLamps: spec.props.roles.streetlight === undefined };
    const jobs = kernel().tryService(JOBS_SERVICE);
    if (jobs !== undefined && jobs.mode === 'workers' && lod !== 2) {
      if (inFlight.n >= MAX_JOBS) return;
      inFlight.n++;
      c.pending.add(lod);
      void jobs.run(CITY_CHUNK, input).then((geometry) => {
        c.pending.delete(lod);
        if (state !== s) return;
        c.built.set(lod, geometry);
        s.frame = -1;
      }, () => {
        c.pending.delete(lod);
        if (state !== s) return;
        // A failed job: build it here instead.
        c.built.set(lod, buildChunkJob(input));
        s.frame = -1;
      });
      return;
    }
    c.built.set(lod, chunkGeometry(s.model.layout, s.model.graph, c.content, lod, { builtinLamps: input.builtinLamps, drive: spec.drive }));
  };

  const night = (): boolean => kernel().tryService(ENVIRONMENT_SERVICE)?.resolve().isNight ?? false;

  const update = (s: CityState): readonly GeneratedMesh[] => {
    const k = kernel();
    if (s.frame === k.time.frame) return s.list;
    s.frame = k.time.frame;
    const lod = s.model.spec.lod;
    const points = sources();
    const isNight = night();
    const jobs = { n: [...s.chunks.values()].reduce((n, c) => n + c.pending.size, 0) };
    const order = [...s.chunks.values()].map((c) => ({ c, d: points.length === 0 ? Infinity : distanceTo(c.content.bounds, points) }));
    order.sort((a, b) => a.d - b.d);
    let changed = false;
    const list: GeneratedMesh[] = [];
    for (const { c, d } of order) {
      const near = lod.near * (c.want === 0 ? LOD_HYSTERESIS : 1);
      const mid = lod.mid * (c.want <= 1 ? LOD_HYSTERESIS : 1);
      c.want = d <= near ? 0 : d <= mid ? 1 : 2;
      request(s, c, 2, jobs);
      request(s, c, c.want, jobs);
      // Show the wanted level, else the closest one built (finer first while it is still near).
      let show: Lod | undefined = c.built.has(c.want) ? c.want : undefined;
      if (show === undefined) for (const l of [c.want + 1, c.want - 1, c.want + 2, c.want - 2]) if ((l === 0 || l === 1 || l === 2) && c.built.has(l)) { show = l; break; }
      if (show === undefined) continue;
      c.used.set(show, s.frame);
      if (c.mesh === null || c.meshLod !== show || c.meshNight !== isNight) {
        const geometry = c.built.get(show)!;
        const parts: GeneratedPart[] = [];
        for (const name of PART_NAMES) {
          const surface = geometry.parts[name];
          if (surface === null || (name === 'lit' && !isNight)) continue;
          parts.push(part(`city:${s.sceneId}:${s.model.key.length}:${c.content.key}:${show}:${name}`, surface, MATERIALS[name], name !== 'lit'));
        }
        c.mesh = {
          key: `city:${c.content.key}`, entity: null, version: ++versions, parts, world: IDENTITY, collision: c.collision, collisionVersion: c.collisionVersion,
        };
        c.meshLod = show;
        c.meshNight = isNight;
        changed = true;
      }
      list.push(c.mesh);
    }
    // Free finer levels nobody has looked at for a while.
    for (const c of s.chunks.values()) {
      for (const [l, frame] of c.used) {
        if (l !== 2 && l !== c.want && s.frame - frame > 600) {
          c.built.delete(l);
          c.used.delete(l);
        }
      }
    }
    // Signal lamps near the sources.
    const graph = s.model.graph;
    const lit: { approach: (typeof graph.approaches)[number]; state: SignalState }[] = [];
    for (const { c } of order) {
      if (c.want !== 0) continue;
      for (const a of c.content.approaches) lit.push({ approach: graph.approaches[a]!, state: signalState(graph, graph.approaches[a]!, clock, s.model.spec.traffic.signals) });
    }
    const key = lit.map((l) => `${l.approach.id}${l.state[0]}`).join('');
    if (key !== s.signalKey) {
      s.signalKey = key;
      const surface = signalLamps(lit);
      const version = ++versions;
      s.signals = surface === null ? null : {
        key: 'city:signals', entity: null, version, world: IDENTITY, collision: null, collisionVersion: 0,
        parts: [part(`city:${s.sceneId}:signals:${version}`, surface, MATERIALS.lit, false)],
      };
      changed = true;
    }
    if (s.signals !== null) list.push(s.signals);
    if (s.skyline !== null) list.push(s.skyline);
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (changed || list.length !== s.list.length) revision++;
    s.list = list;
    return list;
  };

  let planned: { readonly layout: CityLayout; readonly map: CityMap } | undefined;
  const service: CityService = {
    get revision() { return revision; },
    meshes() {
      if (installed === undefined) return [];
      const s = ensure();
      return s === null ? [] : update(s);
    },
    map() {
      if (installed === undefined) return null;
      const s = ensure();
      if (s === null) return null;
      if (planned?.layout !== s.model.layout) planned = { layout: s.model.layout, map: cityMap(s.model.layout) };
      return planned.map;
    },
  };

  /** Spawn props near the sources, remove far ones; never respawn what the game took. */
  const streamProps = (s: CityState): void => {
    const k = kernel();
    if (k.time.now < s.nextProps) return;
    s.nextProps = k.time.now + 0.25;
    const radius = s.model.spec.props.radius;
    const points = sources();
    const layout = s.model.layout;
    for (const [index, id] of [...s.props]) {
      const record = k.world.get(id);
      const p = layout.props[index]!;
      if (record === undefined) {
        s.props.delete(index);
        s.gone.add(index);
        continue;
      }
      if (p.role === 'parked') {
        const vehicle = record.components.get('vehicle') as { driver?: unknown } | undefined;
        const at = record.transform.worldPosition();
        if ((vehicle?.driver !== null && vehicle?.driver !== undefined) || Math.hypot(at.x - p.x, at.z - p.z) > 3) {
          // Someone took it: it is just a car now.
          k.removeComponent(id, CITY_PIECE);
          s.props.delete(index);
          s.gone.add(index);
          continue;
        }
      }
      const d = points.length === 0 ? Infinity : Math.min(...points.map((q) => Math.hypot(q.x - p.x, q.z - p.z)));
      if (d > radius * 1.15) {
        k.destroy(id);
        s.props.delete(index);
      }
    }
    if (points.length === 0) return;
    for (const q of points) {
      // Chunks within reach of this source.
      const size = s.model.index.size;
      const r = Math.ceil(radius / size);
      const cx = Math.floor(q.x / size);
      const cz = Math.floor(q.z / size);
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          const content = s.model.index.chunks.get(`${cx + i},${cz + j}`);
          if (content === undefined) continue;
          for (const index of content.props) {
            if (s.props.has(index) || s.gone.has(index)) continue;
            const p = layout.props[index]!;
            if (p.prefab === '' || Math.hypot(q.x - p.x, q.z - p.z) > radius) continue;
            const record = k.spawn(p.prefab, { at: [p.x, p.y, p.z], rotation: [0, p.yaw, 0] }, {
              components: { [CITY_PIECE]: { role: p.role, index, building: p.building } },
            });
            s.props.set(index, record.id);
          }
        }
      }
    }
  };

  const engine: CityEngine = {
    get kernel() { return kernel(); },
    model: () => ensure()?.model ?? null,
    time: () => clock,
    signal: (approach) => {
      const m = ensure()!.model;
      return signalState(m.graph, m.graph.approaches[approach]!, clock, m.spec.traffic.signals);
    },
    alarm: (point, radius, seconds) => ensure()?.walkers.alarm(point, radius, seconds) ?? 0,
    random: () => rng.next(),
  };

  const components: ComponentDef[] = [
    { id: CITY_CAR, schema: CITY_CAR_SCHEMA },
    { id: CITY_WALKER, schema: CITY_WALKER_SCHEMA },
    { id: CITY_PIECE, schema: CITY_PIECE_SCHEMA },
  ];

  return {
    id: 'city',
    service,
    engine,
    components,
    install(k) {
      if (installed !== undefined) fail('PP3247', 'This city plugin is already installed in another kernel', { fix: 'Call city() once per game.' });
      installed = k;
      k.provide(CITY_SERVICE, service);
      k.observeScenes({ loading: () => { state = undefined; revision++; } });
      k.addHook('input', () => {
        const s = ensure();
        if (s === null) return;
        streamProps(s);
        s.traffic.populate();
        s.walkers.populate();
      });
      k.addHook('physics', (dt) => {
        const s = ensure();
        if (s === null) return;
        clock += dt;
        s.walkers.step(dt);
        s.traffic.step(dt);
      });
    },
    snapshot: (): Json => {
      const s = state ?? null;
      return {
        clock, rng: [...rng.state()],
        gone: s === null ? [] : [...s.gone],
        props: s === null ? [] : [...s.props].map(([p, e]) => [p, e as number]),
      };
    },
    restore(_k, saved) {
      const o = saved as JsonObject;
      clock = (o['clock'] as number | undefined) ?? 0;
      const r = (o['rng'] as number[] | undefined) ?? [0, 0, 0, 0];
      rng.restore([r[0]!, r[1]!, r[2]!, r[3]!]);
      restored = {
        clock, rng: [r[0]!, r[1]!, r[2]!, r[3]!], gone: ((o['gone'] as number[] | undefined) ?? []),
        props: ((o['props'] as [number, number][] | undefined) ?? []),
      };
      state = undefined;
      revision++;
    },
  };
}
