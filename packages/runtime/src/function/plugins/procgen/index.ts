/**
 * procgen — geometry generated from data (sdk/parallax/procgen.pyi): Spline (+ Sweep)
 * paths, race Tracks along a Spline (track.ts; their terrain grading, track_grade.ts), Structures from character grids, Dungeons from a seed. Meshes go
 * to renderers and physics through the procgen service (function/services/procgen.ts);
 * Splines' sampled centerlines serve racing AI, laps and minimaps there and through the
 * Spline component's methods.
 *
 * Lifecycle. Geometry is a pure function of the components' fields (and, for
 * `ground: "terrain"` splines, the terrain and the entity's transform): it is built on
 * first use and rebuilt whenever that data changes, so a game edits a Spline's points or a
 * Dungeon's seed and the mesh follows. Nothing is rebuilt or re-read while nothing changed:
 * the generators are tracked through entity lifecycle events, a field assigned anew is seen
 * at once (each top-level value is compared by identity), an edit inside a value (a plan
 * row, one point of a list) within DEEP_EVERY frames (the fields' JSON), and only then is
 * the full data key compared. `meshes()` hands back the same array while no mesh changed,
 * so physics and nav, which ask every step and every query, skip their own comparisons
 * (`stats()` counts the work). Structures and Dungeons also spawn pieces — door
 * prefabs, keys, locked gates, objectives, treasures, enemies, prop-kit dressing — as
 * children of the generator, each carrying `generated_piece(source, role, room, lock)`.
 * Pieces are spawned in the 'input' hook at the start of a frame (the first frame after
 * the generator appears, and after its data changes: the old pieces are destroyed first).
 * They are ordinary entities, so snapshots hold them; this plugin's snapshot holds which
 * generators were dressed with which data, so a restore never spawns them twice.
 */

import { bindArgs, fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, Geometry3d } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { componentEntity, encodeFields } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, Fields, Kernel, KernelPlugin } from '../../kernel/index.js';
import { PROCGEN_SERVICE, TERRAIN_GRADING_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { GeneratedMaterial, GeneratedMesh, GeneratedPart, PathHit as PathHitData, PathSample, ProcgenService, SampledPath } from '../../services/index.js';
import { SeededRandom } from '../../../core/index.js';
import { dressRoom } from './dressing.js';
import type { PropKit, PropPlacement } from './dressing.js';
import { dungeonGeometry, layoutDungeon } from './dungeon.js';
import type { DungeonLayout } from './dungeon.js';
import { collisionOf, MeshBuilder } from './mesh.js';
import type { Surface, V3 } from './mesh.js';
import {
  checkLayer, DUNGEON, dungeonSpec, materialOf, PIECE, PROCGEN_SCHEMAS, profileOf, readKits, readProfiles,
  rgba, SPLINE, splineSpec, STRUCTURE, STRUCTURE_MATERIALS, structureSpec, SWEEP, TRACK, trackSpec,
} from './schemas.js';
import type { MaterialSpec } from './schemas.js';
import { centerline, nearestOn, sampleAt } from './spline.js';
import type { Centerline, Sample } from './spline.js';
import { buildStructure, problemSite, structureProblems } from './structure.js';
import type { StructureGeometry } from './structure.js';
import { sweepLayer } from './sweep.js';
import type { Profile } from './sweep.js';
import { buildTrack } from './track.js';
import { trackGradePaths } from './track_grade.js';
import type { Ground, TrackGeometry } from './track.js';

export { BUILTIN_PROFILES, sweepLayer } from './sweep.js';
export type { Outline, Profile, SweepLayerSpec } from './sweep.js';
export { centerline, nearestOn, sampleAt, splineProblem } from './spline.js';
export type { Centerline, Sample, SplineSpec } from './spline.js';
export { latheMesh } from './lathe.js';
export { buildStructure, problemSite, rectangles, STAIR_MAX_PITCH, STAIR_RISE, STRUCTURE_RESERVED, structureProblems } from './structure.js';
export { legendKeyProblem, PLAN_CHARACTERS, planCharacterList, RETIRED_PLAN_CHARACTERS, STAIR_CLIMBS } from './plan.js';
export type { PlanCellKind, PlanCharacter, StairClimb } from './plan.js';
export type { StructureGeometry, StructureProblem, StructureSpec, StructureStair } from './structure.js';
export { CORRIDOR_FLOOR, dungeonGeometry, dungeonProblem, layoutDungeon, reachable, ROOM_FLOOR, VOID, WALL } from './dungeon.js';
export type { DungeonLayout, DungeonSpec } from './dungeon.js';
export { dressRoom } from './dressing.js';
export { barrierOffset, buildTrack, curvature, findCorners, racingOffsets, trackProblem } from './track.js';
export type { TrackCorner, TrackGeometry, TrackPart, TrackSpec } from './track.js';
export { TRACK_DEFAULTS, trackGradePaths } from './track_grade.js';
export type { TrackGradePath } from './track_grade.js';
export type { PropKit, PropPlacement } from './dressing.js';
export { MeshBuilder } from './mesh.js';
export type { Surface } from './mesh.js';
export {
  DUNGEON, DUNGEON_SCHEMA, dungeonSpec, MATERIAL_RECORD, PIECE, PIECE_SCHEMA, PROCGEN_SCHEMAS,
  PROFILE_KIND, PROP_KIT_KIND, readKits, readProfiles, ROOM_LEGEND_RECORD, SPLINE, SPLINE_SCHEMA, splineSpec, STRUCTURE,
  STRUCTURE_FLOOR_RECORD, STRUCTURE_SCHEMA, structureSpec, SWEEP, SWEEP_PART_RECORD, SWEEP_SCHEMA, checkLayer, profileOf,
  TRACK, TRACK_SCHEMA, trackSpec,
} from './schemas.js';

// ── Game-facing values (sdk PathPoint, PathHit, GeneratedRoom, GeneratedDoor) ─────

export class PathPoint {
  readonly distance: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly bank: number;

  constructor(distance: number, point: Vec3, tangent: Vec3, right: Vec3, up: Vec3, bank: number) {
    this.distance = distance;
    this.point = point;
    this.tangent = tangent;
    this.right = right;
    this.up = up;
    this.bank = bank;
  }

  toString(): string { return `PathPoint(distance=${this.distance.toFixed(2)}, point=${String(this.point)})`; }
}

export class PathHit extends PathPoint {
  readonly lateral: number;
  readonly offset: number;

  constructor(sample: PathPoint, lateral: number, offset: number) {
    super(sample.distance, sample.point, sample.tangent, sample.right, sample.up, sample.bank);
    this.lateral = lateral;
    this.offset = offset;
  }

  override toString(): string { return `PathHit(distance=${this.distance.toFixed(2)}, lateral=${this.lateral.toFixed(2)})`; }
}

export class GeneratedRoom {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly floor: number;
  readonly center: Vec3;
  readonly area: number;
  readonly critical: boolean;
  readonly region: number;

  constructor(id: string, name: string, role: string, floor: number, center: Vec3, area: number, critical: boolean, region: number) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.floor = floor;
    this.center = center;
    this.area = area;
    this.critical = critical;
    this.region = region;
  }

  toString(): string { return `GeneratedRoom(${this.id}, ${this.role})`; }
}

export class GeneratedDoor {
  readonly kind: string;
  readonly position: Vec3;
  readonly yaw: number;
  readonly width: number;
  readonly rooms: string[];
  readonly lock: number | null;

  constructor(kind: string, position: Vec3, yaw: number, width: number, rooms: string[], lock: number | null) {
    this.kind = kind;
    this.position = position;
    this.yaw = yaw;
    this.width = width;
    this.rooms = rooms;
    this.lock = lock;
  }

  toString(): string { return `GeneratedDoor(${this.kind}, ${this.rooms.join(' -> ')})`; }
}

export class GeneratedStair {
  readonly floor: number;
  readonly bottom: Vec3;
  readonly top: Vec3;
  readonly yaw: number;
  readonly width: number;
  readonly steps: number;

  constructor(floor: number, bottom: Vec3, top: Vec3, yaw: number, width: number, steps: number) {
    this.floor = floor;
    this.bottom = bottom;
    this.top = top;
    this.yaw = yaw;
    this.width = width;
    this.steps = steps;
  }

  toString(): string { return `GeneratedStair(floor ${this.floor} -> ${this.floor + 1})`; }
}

// ── Built state ─────────────────────────────────────────────────────────────────

interface PartSpec {
  readonly surface: Surface;
  readonly material: GeneratedMaterial;
  readonly castShadows: boolean;
  readonly collide: boolean;
  /** Left out of nav's collision (a Structure's stepped treads: `navExtra` stands in). */
  readonly navSkip?: boolean;
}

interface Built {
  readonly key: string;
  readonly version: number;
  readonly parts: readonly PartSpec[];
  readonly line?: Centerline;
  readonly structure?: StructureGeometry;
  readonly dungeon?: DungeonLayout;
  readonly track?: TrackGeometry;
  /** Solid for nav only (a Structure's flights as slopes). */
  readonly navExtra?: Surface;
  /** What the data was when `key` was last confirmed (see `ensure`). */
  watch: Watch;
  /** Cached service mesh (rebuilt when the entity's world matrix changes). */
  mesh?: GeneratedMesh;
  /** The transform chain's values when `mesh.world` was taken (`samePose`). */
  pose?: readonly unknown[];
}

/**
 * The cheap half of change detection: the component's fields object and every top-level
 * value in it (the spline's too, for sweeps and tracks), by identity, and for a
 * terrain-grounded spline the terrain version and the transform chain. Assigning a field
 * changes one of these at once; editing inside a value (a plan row, a point of a list)
 * doesn't, and is found by comparing the fields' JSON every DEEP_EVERY frames (`checked`).
 */
const DEEP_EVERY = 4;
interface Watch {
  readonly fields: Fields;
  readonly values: readonly unknown[];
  readonly spline: Fields | undefined;
  readonly splineValues: readonly unknown[];
  readonly terrain: string | null;
  readonly pose: readonly unknown[] | null;
  /** The fields (and spline) as JSON: compared every DEEP_EVERY frames for edits inside values; cheaper than the data key. */
  readonly quick: string;
  /** Kernel frame of the last `quick` comparison. */
  checked: number;
}

/** The scene's generators, sorted by built key (`component:id`). */
type Roster = readonly { readonly key: string; readonly id: EntityId; readonly component: string }[];

/** A transform node as procgen reads it (kernel TransformNode). */
interface PoseNode {
  readonly position: unknown;
  readonly rotation: unknown;
  readonly scale: unknown;
  readonly parent: PoseNode | null;
}

/** The transform chain's values, root last (compared by identity: Vec3/Quat are replaced, never edited). */
function poseOf(node: PoseNode): unknown[] {
  const out: unknown[] = [];
  for (let n: PoseNode | null = node; n !== null; n = n.parent) out.push(n.position, n.rotation, n.scale, n.parent);
  return out;
}

function samePose(node: PoseNode, saved: readonly unknown[]): boolean {
  let i = 0;
  for (let n: PoseNode | null = node; n !== null; n = n.parent) {
    if (saved[i] !== n.position || saved[i + 1] !== n.rotation || saved[i + 2] !== n.scale || saved[i + 3] !== n.parent) return false;
    i += 4;
  }
  return i === saved.length;
}

const sameValues = (fields: Fields, values: readonly unknown[]): boolean => {
  let i = 0;
  // Own fields only: component methods sit on the prototype.
  for (const key in fields) if (Object.hasOwn(fields, key) && fields[key] !== values[i++]) return false;
  return i === values.length;
};
const valuesOf = (fields: Fields | undefined): unknown[] => (fields === undefined ? [] : Object.values(fields));

const DEFAULT_MATERIALS: Readonly<Record<string, Partial<MaterialSpec>>> = {
  wall: { color: [0.85, 0.81, 0.75, 1] },
  roof: { color: [0.54, 0.29, 0.23, 1] },
  slab: { color: [0.6, 0.58, 0.54, 1] },
  floor: { color: [0.69, 0.54, 0.35, 1] },
  glass: { color: [0.62, 0.78, 0.85, 0.35], roughness: 0.1 },
  stair: { color: [0.6, 0.58, 0.54, 1] },
  ceiling: { color: [0.45, 0.43, 0.4, 1] },
  plinth: { color: [0.62, 0.6, 0.56, 1], roughness: 0.9 },
  coping: { color: [0.62, 0.6, 0.56, 1], roughness: 0.9 },
  balcony: { color: [0.62, 0.6, 0.56, 1], roughness: 0.9 },
  shutter: { color: [0.36, 0.25, 0.16, 1], roughness: 0.8 },
  mullion: { color: [0.22, 0.22, 0.22, 1], roughness: 0.5, metallic: 0.6 },
  awning: { color: [0.76, 0.68, 0.52, 1], roughness: 1 },
};

function material(id: string, spec: MaterialSpec, extra: { blend?: boolean; doubleSided?: boolean; unlit?: boolean } = {}): GeneratedMaterial {
  const normal = spec.normal ?? null;
  return {
    id: `procgen|${id}|${spec.color.join(',')}|${spec.texture ?? ''}|${normal ?? ''}|${spec.roughness}|${spec.metallic}|${extra.doubleSided === true}|${extra.unlit === true}`,
    color: spec.color, texture: spec.texture, ...(normal !== null && { normal }), roughness: spec.roughness, metallic: spec.metallic,
    blend: extra.blend ?? spec.color[3] < 1, doubleSided: extra.doubleSided ?? false, unlit: extra.unlit ?? false,
  };
}

function geometryOf(id: string, s: Surface): Geometry3d {
  return {
    id, positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices, joints: null, weights: null, colors: s.colors,
    min: [s.min[0], s.min[1], s.min[2]], max: [s.max[0], s.max[1], s.max[2]],
  };
}

/** Rescale a surface's uvs (meters) by a material tile size. */
function tiled(s: Surface, tile: number): Surface {
  if (tile === 1) return s;
  const uvs = new Float32Array(s.uvs.length);
  for (let i = 0; i < uvs.length; i++) uvs[i] = s.uvs[i]! / tile;
  return { ...s, uvs };
}

function worldMatrix(record: EntityRecord): Float32Array {
  const t = record.transform;
  const o = t.toWorld(Vec3.ZERO);
  const x = t.toWorld(new Vec3(1, 0, 0)).__sub__(o);
  const y = t.toWorld(new Vec3(0, 1, 0)).__sub__(o);
  const z = t.toWorld(new Vec3(0, 0, 1)).__sub__(o);
  return new Float32Array([x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, o.x, o.y, o.z, 1]);
}

function sameMatrix(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

const toVec = (p: readonly number[]): Vec3 => new Vec3(p[0]!, p[1]!, p[2]!);

/** Mesh and collision versions: one counter for every procgen plugin, so generated geometry ids never repeat across games (hot reload). */
let versionCounter = 0;
const nextVersion = (): number => ++versionCounter;

/**
 * Builds by content (component + data key, plan files' text included), shared across
 * plugin instances: reloading a scene or the game (hot reload) reuses an unchanged
 * Structure or Dungeon — the same geometry, version and so GPU buffers — instead of
 * rebuilding it. The most recent BUILD_CACHE entries are kept.
 */
const BUILD_CACHE = new Map<string, unknown>();
const BUILD_CACHE_SIZE = 64;

/** How far (m) a flight's nav link reaches off its foot and head onto the floors it joins. */
const STAIR_LINK_REACH = 0.35;

export interface ProcgenPlugin extends KernelPlugin {
  readonly service: ProcgenService;
  /** Work counters (tests): full data-key comparisons and generator builds so far. */
  stats(): { readonly keyed: number; readonly builds: number };
}

export function procgen(): ProcgenPlugin {
  let installed: Kernel | undefined;
  const built = new Map<string, Built>();
  /** Generator entity → the data key its pieces were spawned for. */
  const dressed = new Map<EntityId, string>();
  let profiles: Map<string, Profile> | undefined;
  let kits: Map<string, PropKit> | undefined;
  let revision = 0;

  const kernel = (): Kernel => {
    if (installed === undefined) fail('PP3644', 'procgen is used before its game started', { fix: 'Add procgen() to Game(plugins=[...]).' });
    return installed;
  };
  const project = () => kernel().project;
  const profileTable = (): Map<string, Profile> => (profiles ??= readProfiles(project()));
  const kitTable = (): Map<string, PropKit> => (kits ??= readKits(project()));

  const terrainVersion = (): string => {
    const field = kernel().tryService(TERRAIN_SERVICE)?.current() ?? null;
    return field === null ? 'none' : `${(field as { version?: number }).version ?? 0}:${(field as { scene?: string }).scene ?? ''}`;
  };

  const dataKey = (record: EntityRecord, component: string): string => {
    const fields = record.components.get(component)!;
    const encoded = encodeFields(PROCGEN_SCHEMAS[component]!, fields, `entity ${record.id} ${component}`);
    let key = JSON.stringify(encoded);
    // A Structure drawn in a plan file: the file's text is part of its data.
    const plan = component === STRUCTURE ? fields['plan'] as string | null : null;
    if (plan !== null) key += `|${project().plans?.get(plan) ?? ''}`;
    if (component === SWEEP || component === SPLINE || component === TRACK) {
      const spline = record.components.get(SPLINE);
      if (spline !== undefined) {
        key += `|${JSON.stringify(encodeFields(PROCGEN_SCHEMAS[SPLINE]!, spline, `entity ${record.id} spline`))}`;
        if (spline['ground'] === 'terrain') key += `|${terrainVersion()}|${Array.from(worldMatrix(record)).join(',')}`;
      }
    }
    return key;
  };

  const lineOf = (record: EntityRecord): Centerline => {
    const fields = record.components.get(SPLINE)!;
    const where = `Entity ${record.id} spline`;
    const spec = splineSpec(fields, where);
    const line = centerline(spec);
    if (fields['ground'] !== 'terrain') return line;
    const field = kernel().tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (field === null) {
      fail('PP3640', `${where}: ground is "terrain" but the scene has no terrain`, { fix: 'Add a "terrain" block to the scene and terrain() to the plugins, or set ground to "none".' });
    }
    const lift = fields['lift'] as number;
    const t = record.transform;
    return centerline(spec, (p) => {
      const w = t.toWorld(toVec(p));
      const local = t.toLocal(new Vec3(w.x, field.heightAt(w.x, w.z) + lift, w.z));
      return [local.x, local.y, local.z];
    });
  };

  /** The terrain height under a point of the entity's local space, as a local y (null: no terrain-grounded spline). */
  const groundOf = (record: EntityRecord): Ground | null => {
    if (record.components.get(SPLINE)?.['ground'] !== 'terrain') return null;
    const field = kernel().tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (field === null) return null;
    const t = record.transform;
    return (x, z) => {
      const w = t.toWorld(new Vec3(x, 0, z));
      return t.toLocal(new Vec3(w.x, field.heightAt(w.x, w.z), w.z)).y;
    };
  };

  const build = (record: EntityRecord, component: string, key: string): Omit<Built, 'watch'> => {
    const id = record.id;
    const version = nextVersion();
    const fields = record.components.get(component)!;
    const where = `Entity ${id} ${component}`;
    const parts: PartSpec[] = [];
    const add = (name: string, surface: Surface, spec: MaterialSpec, opts: { collide: boolean; shadows?: boolean; blend?: boolean; doubleSided?: boolean; unlit?: boolean; navSkip?: boolean }): void => {
      if (surface.indices.length === 0) return;
      parts.push({
        surface: tiled(surface, spec.tile), material: material(name, spec, opts), castShadows: opts.shadows ?? true, collide: opts.collide,
        ...(opts.navSkip === true && { navSkip: true }),
      });
    };
    if (component === SWEEP) {
      if (!record.components.has(SPLINE)) {
        fail('PP3641', `${where}: a Sweep follows the Spline on the same entity, and this one has none`, { fix: 'Add a "spline" component with the path\'s points next to the "sweep".' });
      }
      const line = lineOf(record);
      (fields['parts'] as Fields[]).forEach((layer, i) => {
        const at = `${where}.parts[${i}]`;
        checkLayer(layer, at);
        const profile = profileOf(layer['profile'] as string, profileTable(), at);
        const width = (layer['width'] as number | null) ?? profile.width;
        const height = (layer['height'] as number | null) ?? profile.height;
        const offset = layer['offset'] as { x: number; y: number };
        const colors = (layer['colors'] as unknown[]).map(rgba);
        const stripe = layer['stripe'] as number | null;
        const base = {
          profile, width, height, uvLength: layer['uv_length'] as number, uvWidth: (layer['uv_width'] as number | null) ?? (layer['uv_length'] as number),
          start: layer['start'] as number, end: (layer['end'] as number | null) ?? undefined, caps: layer['caps'] as boolean,
          stripe: stripe ?? undefined, colors: stripe === null ? [rgba(layer['color'])] : colors,
        };
        const spec = materialOf({ color: { r: 1, g: 1, b: 1, a: 1 }, texture: layer['texture'], roughness: layer['roughness'], metallic: layer['metallic'] });
        const opts = { collide: layer['collide'] as boolean, shadows: layer['shadows'] as boolean, doubleSided: layer['double_sided'] as boolean,
          blend: base.colors.some((c) => c[3] < 1) };
        add(`sweep:${i}`, sweepLayer(line, { ...base, offset: [offset.x, offset.y] }), spec, opts);
        if (layer['mirror'] as boolean) {
          const mirrored: Profile = { ...profile, outlines: profile.outlines.map((o) => ({ ...o, points: o.points.map(([x, y]) => [-x, y] as const).reverse() })) };
          add(`sweep:${i}:mirror`, sweepLayer(line, { ...base, profile: mirrored, offset: [-offset.x, offset.y] }), spec, opts);
        }
      });
      return { key, version, parts, line };
    }
    if (component === TRACK) {
      if (!record.components.has(SPLINE)) {
        fail('PP3645', `${where}: a Track follows the Spline on the same entity, and this one has none`, { fix: 'Add a "spline" component with the circuit\'s points next to the "track".' });
      }
      const spec = trackSpec(fields, where);
      const line = lineOf(record);
      const track = buildTrack(line, spec, groundOf(record));
      for (const part of track.parts) {
        add(part.name, part.surface, { ...part.material, color: [...part.material.color] as [number, number, number, number] },
          { collide: part.collide, shadows: part.shadows, unlit: part.material.unlit === true });
      }
      return { key, version, parts, line, track };
    }
    if (component === SPLINE) return { key, version, parts, line: lineOf(record) };
    const materials = fields['materials'] as Record<string, Fields>;
    const colors = (fields['colors'] ?? {}) as Record<string, unknown>;
    /** A material by key: as given, else its fallback's (STRUCTURE_MATERIALS: slab → wall, …), else the default; `colors` recolours it. */
    const mat = (name: string): MaterialSpec => {
      let key: string | null = name;
      while (key !== null && materials[key] === undefined && colors[key] === undefined) key = STRUCTURE_MATERIALS[key] ?? null;
      const source = key ?? name;
      const spec = materialOf(materials[source], DEFAULT_MATERIALS[name] ?? DEFAULT_MATERIALS[source] ?? DEFAULT_MATERIALS['floor']);
      const tint = colors[name] ?? colors[source];
      return tint === undefined ? spec : { ...spec, color: rgba(tint) };
    };
    const collide = fields['collide'] as boolean;
    if (component === STRUCTURE) {
      const spec = structureSpec(fields, where, project().plans);
      const problems = structureProblems(spec);
      if (problems.length > 0) {
        const p = problems[0]!;
        // A plan file's problem at its file:line:column, as `parallax check` reports it.
        const site = problemSite(spec, p);
        const at = site.path !== undefined ? site.text : `${where} ${site.text}`;
        fail('PP3650', `${at}: ${p.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`, {
          fix: p.fix, ...(site.path !== undefined && { path: site.path }), ...(site.line !== undefined && { line: site.line }),
        });
      }
      const geometry = buildStructure(spec);
      for (const [name, mesh] of [...geometry.solid].sort((a, b) => (a[0] < b[0] ? -1 : 1))) add(`structure:${name}`, mesh.build(), mat(name), { collide, navSkip: name === 'stair' });
      // Dressing (shutters, mullions, awnings): drawn, not solid.
      for (const [name, mesh] of [...geometry.trim].sort((a, b) => (a[0] < b[0] ? -1 : 1))) add(`structure:${name}`, mesh.build(), mat(name), { collide: false });
      add('structure:glass', geometry.glass.build(), mat('glass'), { collide: false, shadows: false, blend: true });
      add('structure:glass_wall', geometry.glassWalls.build(), mat('glass'), { collide, shadows: false, blend: true });
      const navExtra = collide && geometry.navStairs.triangleCount > 0 ? geometry.navStairs.build() : undefined;
      return { key, version, parts, structure: geometry, ...(navExtra !== undefined && { navExtra }) };
    }
    const spec = dungeonSpec(fields, where);
    const layout = layoutDungeon(spec);
    const geometry = dungeonGeometry(layout, spec);
    add('dungeon:floor', geometry.floor.build(), mat('floor'), { collide });
    add('dungeon:wall', geometry.walls.build(), mat('wall'), { collide });
    add('dungeon:ceiling', geometry.ceiling.build(), mat('ceiling'), { collide });
    return { key, version, parts, dungeon: layout };
  };

  const SOURCES = [SWEEP, TRACK, STRUCTURE, DUNGEON] as const;
  const GENERATORS = [...SOURCES, SPLINE] as const;
  const isGenerator = (record: EntityRecord): boolean => GENERATORS.some((c) => record.components.has(c));

  const watchOf = (record: EntityRecord, component: string, checked: number): Watch => {
    const fields = record.components.get(component)!;
    const spline = component === SWEEP || component === SPLINE || component === TRACK ? record.components.get(SPLINE) : undefined;
    const grounded = spline?.['ground'] === 'terrain';
    return {
      fields, values: valuesOf(fields), spline, splineValues: valuesOf(spline),
      terrain: grounded ? terrainVersion() : null, pose: grounded ? poseOf(record.transform) : null, quick: quickOf(fields, spline), checked,
    };
  };
  const quickOf = (fields: Fields, spline: Fields | undefined): string => (spline === undefined ? JSON.stringify(fields) : `${JSON.stringify(fields)}|${JSON.stringify(spline)}`);
  const watched = (record: EntityRecord, component: string, w: Watch): boolean => {
    if (record.components.get(component) !== w.fields || !sameValues(w.fields, w.values)) return false;
    const spline = component === SWEEP || component === SPLINE || component === TRACK ? record.components.get(SPLINE) : undefined;
    if (spline !== w.spline || (spline !== undefined && !sameValues(spline, w.splineValues))) return false;
    if ((spline?.['ground'] === 'terrain') !== (w.terrain !== null)) return false;
    return w.terrain === null || (w.terrain === terrainVersion() && samePose(record.transform, w.pose!));
  };

  /**
   * The built state of a source on an entity (rebuilt when its data changed). While no
   * field was assigned, the cached build is returned as is, so physics, nav and rendering
   * can ask every step for free; every few frames the fields' JSON is compared too (edits
   * inside a value: a plan row, a point of a list). Only when either differs is the full
   * data key (every field encoded) compared.
   */
  const ensure = (record: EntityRecord, component: string): Built => {
    const k = `${component}:${record.id}`;
    const frame = kernel().time.frame;
    const cached = built.get(k);
    if (cached !== undefined && watched(record, component, cached.watch)) {
      if (frame - cached.watch.checked < DEEP_EVERY) return cached;
      cached.watch.checked = frame;
      const spline = component === SWEEP || component === SPLINE || component === TRACK ? record.components.get(SPLINE) : undefined;
      if (quickOf(cached.watch.fields, spline) === cached.watch.quick) return cached;
    }
    const key = dataKey(record, component);
    keyed++;
    if (cached !== undefined && cached.key === key) {
      cached.watch = watchOf(record, component, frame - (record.id % DEEP_EVERY));
      return cached;
    }
    // Staggered by entity, so a scene of generators doesn't compare them all on one frame.
    const cacheable = component === STRUCTURE || component === DUNGEON;
    const content = `${component}|${key}`;
    let made = cacheable ? BUILD_CACHE.get(content) as Omit<Built, 'watch'> | undefined : undefined;
    if (made === undefined) {
      made = build(record, component, key);
      builds++;
      if (cacheable) {
        BUILD_CACHE.set(content, made);
        if (BUILD_CACHE.size > BUILD_CACHE_SIZE) BUILD_CACHE.delete(BUILD_CACHE.keys().next().value!);
      }
    } else {
      // Most recently used last.
      BUILD_CACHE.delete(content);
      BUILD_CACHE.set(content, made);
    }
    const next: Built = { ...made, watch: watchOf(record, component, frame - (record.id % DEEP_EVERY)) };
    built.set(k, next);
    revision++;
    return next;
  };

  /** Generators in the scene, sorted by built key; null: re-read (an entity with one was added, removed or changed). */
  let roster: Roster | null = null;
  let synced: Roster | null = null;
  const rosterOf = (k: Kernel): Roster => {
    if (roster !== null) return roster;
    const list: { readonly key: string; readonly id: EntityId; readonly component: string }[] = [];
    for (const component of GENERATORS) {
      for (const [id] of k.world.query([component])) {
        const record = k.world.get(id)!;
        if (component === SPLINE && (record.components.has(SWEEP) || record.components.has(TRACK))) continue;
        list.push({ key: `${component}:${id}`, id, component });
      }
    }
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return (roster = list);
  };

  /** Bring every generator up to date: drop the gone, build the new or changed. */
  const sync = (): void => {
    const k = kernel();
    // A restore (an editor's Stop, a slot load) can swap the world before procgen's own
    // restore runs, with no entity events: a roster naming entities that are gone is stale.
    const stale = (g: { readonly id: EntityId; readonly component: string }): boolean => k.world.get(g.id)?.components.has(g.component) !== true;
    if (rosterOf(k).some(stale)) roster = null;
    const list = rosterOf(k);
    if (list !== synced) {
      const seen = new Set(list.map((g) => g.key));
      for (const key of [...built.keys()]) {
        if (!seen.has(key)) {
          built.delete(key);
          revision++;
        }
      }
      synced = list;
      meshList = null;
    }
    for (const g of list) ensure(k.world.get(g.id)!, g.component);
  };

  /** Drop everything derived from the scene's entities (a scene load, a restore). */
  const forget = (): void => {
    roster = null;
    synced = null;
    meshList = null;
    revision++;
  };

  /** The last `meshes()` answer: returned again (the same array) while no mesh changed. */
  let meshList: GeneratedMesh[] | null = null;
  /** Full data keys computed (tests read it through `stats`: a quiet scene computes none after the first). */
  let keyed = 0;
  let builds = 0;

  const meshOf = (record: EntityRecord, component: string, b: Built): GeneratedMesh | undefined => {
    if (b.parts.length === 0) return undefined;
    if (b.mesh !== undefined && b.mesh.version === b.version && b.pose !== undefined && samePose(record.transform, b.pose)) return b.mesh;
    b.pose = poseOf(record.transform);
    const world = worldMatrix(record);
    if (b.mesh !== undefined && b.mesh.version === b.version && sameMatrix(b.mesh.world, world)) return b.mesh;
    const solid = b.parts.filter((p) => p.collide).map((p) => p.surface);
    const parts: GeneratedPart[] = b.parts.map((p, i) => ({
      geometry: geometryOf(`procgen:${component}:${record.id}:${b.version}:${i}`, p.surface), material: p.material, castShadows: p.castShadows,
    }));
    const previous = b.mesh;
    const layer = component === STRUCTURE || component === DUNGEON ? record.components.get(component)!['layer'] as string : 'default';
    const links = b.structure === undefined || b.structure.stairs.length === 0 ? undefined : b.structure.stairs.map((st) => {
      // Climb direction (local), and the ends a little off the flight onto the floors it joins.
      const dx = Math.sin((st.yaw * Math.PI) / 180);
      const dz = Math.cos((st.yaw * Math.PI) / 180);
      const at = (p: V3, out: number): [number, number, number] => {
        const w = record.transform.toWorld(new Vec3(p[0] + dx * out, p[1], p[2] + dz * out));
        return [w.x, w.y, w.z];
      };
      return { start: at(st.bottom, -STAIR_LINK_REACH), end: at(st.top, STAIR_LINK_REACH) };
    });
    b.mesh = {
      key: `${component}:${record.id}`, entity: record.id, version: b.version, ...(layer !== 'default' && { layer }), ...(links !== undefined && { links }),
      parts: previous?.version === b.version ? previous.parts : parts,
      world,
      collision: solid.length === 0 ? null : collisionOf(solid, world),
      ...(b.navExtra !== undefined && { navCollision: collisionOf([...b.parts.filter((p) => p.collide && p.navSkip !== true).map((p) => p.surface), b.navExtra], world) }),
      collisionVersion: nextVersion(),
    };
    return b.mesh;
  };

  const pathOf = (record: EntityRecord): SampledPath | undefined => {
    if (!record.components.has(SPLINE)) return undefined;
    const b = ensure(record, record.components.has(SWEEP) ? SWEEP : record.components.has(TRACK) ? TRACK : SPLINE);
    return sampledPath(record, b.line!, b.version);
  };

  const service: ProcgenService = {
    get revision() { return revision; },
    meshes() {
      sync();
      const k = kernel();
      const out: GeneratedMesh[] = [];
      for (const g of synced!) {
        if (g.component === SPLINE) continue;
        const mesh = meshOf(k.world.get(g.id)!, g.component, built.get(g.key)!);
        if (mesh !== undefined) out.push(mesh);
      }
      // Unchanged: the same array, so callers (nav, physics) can skip their own comparison.
      const last = meshList;
      if (last !== null && last.length === out.length && out.every((m, i) => m === last[i])) return last;
      return (meshList = out);
    },
    path(entity) {
      const record = kernel().world.get(entity);
      return record === undefined ? undefined : pathOf(record);
    },
    paths() {
      const out: SampledPath[] = [];
      for (const record of kernel().world.live()) {
        const path = pathOf(record);
        if (path !== undefined) out.push(path);
      }
      return out;
    },
  };

  // ── Pieces (Structure doors and dressing; Dungeon keys, gates, objectives, …) ───

  const piecesOf = (k: Kernel, source: EntityId): EntityId[] => {
    const out: EntityId[] = [];
    for (const record of k.world.live()) {
      const piece = record.components.get(PIECE);
      if (piece !== undefined && k.handles.unwrap(piece['source']) === source) out.push(record.id);
    }
    return out;
  };

  const spawnPiece = (k: Kernel, parent: EntityId, prefab: string, at: V3, yaw: number, scale: number, role: string, room: string, lock: number | null): void => {
    k.spawn(prefab, { at: [at[0], at[1], at[2]], rotation: [0, yaw, 0], scale }, {
      parent,
      components: { [PIECE]: { source: k.handles.wrap(parent), role, room, lock } },
    });
  };

  const placeProps = (k: Kernel, parent: EntityId, placements: readonly PropPlacement[], y: number, room: string): void => {
    for (const p of placements) spawnPiece(k, parent, p.prefab, [p.x, y, p.z], p.yaw, p.scale, 'prop', room, null);
  };

  const kitOf = (name: string | null, where: string): PropKit | null => {
    if (name === null) return null;
    const kit = kitTable().get(name);
    if (kit === undefined) fail('PP3661', `${where}: there is no prop kit "${name}"`, { fix: `Add content/prop_kit/${name}.json, or remove "kit".` });
    return kit;
  };

  const dress = (k: Kernel, record: EntityRecord, component: string, b: Built): void => {
    const fields = record.components.get(component)!;
    const where = `Entity ${record.id} ${component}`;
    const id = record.id;
    const seed = (fields['seed'] as number) ^ 0x70726f70;
    if (component === STRUCTURE) {
      const g = b.structure!;
      const doorPrefab = fields['door_prefab'] as string | null;
      if (doorPrefab !== null) {
        for (const o of g.openings) if (o.kind === 'door') spawnPiece(k, id, doorPrefab, o.position, o.yaw, 1, 'door', o.rooms.join('|'), null);
      }
      const kit = kitOf(fields['kit'] as string | null, where);
      if (kit !== null) {
        const cell = fields['cell'] as number;
        // Stairwells (the slab left out over a flight) and the cells at a flight's foot stay clear.
        const wells = new Set(g.stairs.flatMap((st) => st.cells.map(([r, c]) => `${st.floor + 1}:${r},${c}`)));
        g.rooms.forEach((room, i) => {
          const xs = room.cells.map((c) => c[1]);
          const zs = room.cells.map((c) => c[0]);
          const [fx0, fz0] = g.footprint;
          const inside = new Set(room.cells.map((c) => `${c[0]},${c[1]}`));
          const area = { x0: fx0 + Math.min(...xs) * cell, z0: fz0 + Math.min(...zs) * cell, x1: fx0 + (Math.max(...xs) + 1) * cell, z1: fz0 + (Math.max(...zs) + 1) * cell };
          const doors = g.openings.filter((o) => o.floor === room.floor && o.kind !== 'window' && o.rooms.includes(room.id)).map((o) => [o.position[0], o.position[2]] as const);
          const feet = g.stairs.filter((st) => st.floor === room.floor).map((st) => [st.bottom[0], st.bottom[2]] as const);
          const placements = dressRoom(kit, area, new SeededRandom(seed + i * 7919), { keepClear: [...doors, ...feet, [room.center[0], room.center[2]]], center: true })
            .filter((p) => {
              const at = `${Math.floor((p.z - fz0) / cell)},${Math.floor((p.x - fx0) / cell)}`;
              return inside.has(at) && !wells.has(`${room.floor}:${at}`);
            });
          placeProps(k, id, placements, room.center[1], room.id);
        });
      }
      return;
    }
    if (component !== DUNGEON) return;
    const layout = b.dungeon!;
    const prefab = (name: string): string | null => fields[name] as string | null;
    const roomName = (n: number): string => String(n);
    for (const door of layout.doors) {
      if (door.lock !== null) spawnPiece(k, id, prefab('gate_prefab')!, door.position, door.yaw, 1, 'gate', roomName(door.room), door.lock);
      else if (prefab('door_prefab') !== null) spawnPiece(k, id, prefab('door_prefab')!, door.position, door.yaw, 1, 'door', roomName(door.room), null);
    }
    const rng = new SeededRandom((fields['seed'] as number) ^ 0x656e656d);
    const kit = kitOf(fields['kit'] as string | null, where);
    const tile = fields['tile'] as number;
    for (const room of layout.rooms) {
      const name = roomName(room.id);
      if (room.key !== null) spawnPiece(k, id, prefab('key_prefab')!, room.center, 0, 1, 'key', name, room.key);
      if (room.role === 'objective' && prefab('objective_prefab') !== null) spawnPiece(k, id, prefab('objective_prefab')!, room.center, 0, 1, 'objective', name, null);
      if (room.role === 'treasure' && prefab('treasure_prefab') !== null) spawnPiece(k, id, prefab('treasure_prefab')!, room.center, 0, 1, 'treasure', name, null);
      const [i0, j0, i1, j1] = room.rect;
      const area = { x0: layout.origin[0] + i0 * tile, z0: layout.origin[1] + j0 * tile, x1: layout.origin[0] + i1 * tile, z1: layout.origin[1] + j1 * tile };
      const enemies = room.role === 'entrance' ? 0 : (fields['enemies'] as number);
      const enemy = prefab('enemy_prefab');
      if (enemy !== null && enemies > 0) {
        // Evenly round the center at a third of the room's smaller half-size, seeded start angle.
        const r = Math.min(area.x1 - area.x0, area.z1 - area.z0) / 3;
        const start = rng.next() * 360;
        for (let e = 0; e < enemies; e++) {
          const a = ((start + (360 * e) / enemies) * Math.PI) / 180;
          spawnPiece(k, id, enemy, [room.center[0] + Math.sin(a) * r, 0, room.center[2] + Math.cos(a) * r], (start + (360 * e) / enemies + 180) % 360, 1, 'enemy', name, null);
        }
      }
      if (kit !== null) {
        const doors = layout.doors.filter((d) => d.room === room.id).map((d) => [d.position[0], d.position[2]] as const);
        const placements = dressRoom(kit, area, new SeededRandom(seed + room.id * 7919), {
          keepClear: [...doors, [room.center[0], room.center[2]]], center: room.role === 'room',
        });
        placeProps(k, id, placements, 0, name);
      }
    }
  };

  const syncPieces = (): void => {
    const k = kernel();
    const dressable = rosterOf(k).filter((g) => g.component === STRUCTURE || g.component === DUNGEON);
    if (dressable.length === 0 && dressed.size === 0) return;
    for (const g of dressable) {
      const record = k.world.get(g.id);
      if (record === undefined) continue;
      const b = ensure(record, g.component);
      if (dressed.get(record.id) === b.key) continue;
      for (const piece of piecesOf(k, record.id)) k.destroy(piece);
      dressed.set(record.id, b.key);
      dress(k, record, g.component, b);
    }
    for (const id of [...dressed.keys()]) if (!k.world.isAlive(id)) dressed.delete(id);
  };

  // ── Component methods ───────────────────────────────────────────────────────────

  const recordOf = (fields: Fields): EntityRecord => kernel().world.require(componentEntity(fields));
  const vecArg = (value: unknown, where: string): Vec3 => {
    if (value instanceof Vec3) return value;
    return fail('PP3643', `${where} must be a Vec3, got ${value === null || value === undefined ? 'None' : String(value)}`);
  };
  const numArg = (value: unknown, where: string): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return fail('PP3643', `${where} must be a number, got ${String(value)}`);
  };
  const pointOf = (s: PathSample): PathPoint => new PathPoint(s.distance, toVec(s.point), toVec(s.tangent), toVec(s.right), toVec(s.up), s.bank);
  const pathFor = (fields: Fields): SampledPath => pathOf(recordOf(fields))!;

  const splineMethods = {
    length(this: Fields, ...args: unknown[]): number {
      bindArgs('length', args, {});
      return pathFor(this).length;
    },
    sample(this: Fields, ...args: unknown[]): PathPoint {
      const a = bindArgs('sample', args, { positional: ['distance'], required: ['distance'] }).args;
      return pointOf(pathFor(this).at(numArg(a['distance'], 'sample() distance')));
    },
    nearest(this: Fields, ...args: unknown[]): PathHit {
      const a = bindArgs('nearest', args, { positional: ['point'], required: ['point'] }).args;
      const p = vecArg(a['point'], 'nearest() point');
      const hit = pathFor(this).nearest(p.x, p.y, p.z);
      return new PathHit(pointOf(hit), hit.lateral, hit.offset);
    },
    progress(this: Fields, ...args: unknown[]): number {
      const a = bindArgs('progress', args, { positional: ['point'], required: ['point'] }).args;
      const p = vecArg(a['point'], 'progress() point');
      const path = pathFor(this);
      return path.length > 0 ? path.nearest(p.x, p.y, p.z).distance / path.length : 0;
    },
    polyline(this: Fields, ...args: unknown[]): Vec3[] {
      const a = bindArgs('polyline', args, { positional: ['spacing'] }).args;
      const path = pathFor(this);
      const spacing = a['spacing'] === undefined || a['spacing'] === null ? undefined : numArg(a['spacing'], 'polyline() spacing');
      if (spacing === undefined) return path.samples.map((s) => toVec(s.point));
      if (!(spacing > 0)) fail('PP3643', 'polyline() spacing must be above 0');
      const count = Math.max(1, Math.round(path.length / spacing));
      const out: Vec3[] = [];
      for (let i = 0; i < (path.closed ? count : count + 1); i++) out.push(toVec(path.at((i * path.length) / count).point));
      return out;
    },
  };

  const trackOf = (fields: Fields): { record: EntityRecord; b: Built } => {
    const record = recordOf(fields);
    return { record, b: ensure(record, TRACK) };
  };
  const trackMethods = {
    racing_line(this: Fields, ...args: unknown[]): Vec3[] {
      const a = bindArgs('racing_line', args, { positional: ['spacing'] }).args;
      const { record, b } = trackOf(this);
      const line = b.line!;
      const offsets = b.track!.racing;
      const spacing = a['spacing'] === undefined || a['spacing'] === null ? undefined : numArg(a['spacing'], 'racing_line() spacing');
      if (spacing !== undefined && !(spacing > 0)) fail('PP3643', 'racing_line() spacing must be above 0');
      const pointAt = (i: number): Vec3 => {
        const s = line.samples[i]!;
        const o = offsets[i]!;
        return record.transform.toWorld(new Vec3(s.point[0] + s.right[0] * o, s.point[1] + s.right[1] * o, s.point[2] + s.right[2] * o));
      };
      if (spacing === undefined) return line.samples.map((_, i) => pointAt(i));
      const count = Math.max(1, Math.round(line.length / spacing));
      const out: Vec3[] = [];
      const n = line.samples.length;
      for (let k = 0; k < (line.closed ? count : count + 1); k++) {
        const d = (k * line.length) / count;
        let i = 0;
        while (i + 1 < n && line.samples[i + 1]!.distance <= d) i++;
        const j = i + 1 < n ? i + 1 : line.closed ? 0 : i;
        const d1 = j === 0 && line.closed ? line.length : line.samples[j]!.distance;
        const f = d1 > line.samples[i]!.distance ? (d - line.samples[i]!.distance) / (d1 - line.samples[i]!.distance) : 0;
        const p = pointAt(i);
        const q = pointAt(j);
        out.push(new Vec3(p.x + (q.x - p.x) * f, p.y + (q.y - p.y) * f, p.z + (q.z - p.z) * f));
      }
      return out;
    },
    surface_at(this: Fields, ...args: unknown[]): string {
      const a = bindArgs('surface_at', args, { positional: ['point'], required: ['point'] }).args;
      const p = vecArg(a['point'], 'surface_at() point');
      const { record, b } = trackOf(this);
      const hit = sampledPath(record, b.line!, b.version).nearest(p.x, p.y, p.z);
      const lateral = Math.abs(hit.lateral);
      const side = hit.lateral >= 0 ? 1 : -1;
      const width = this['width'] as number;
      const kerbs = this['kerbs'] as Fields;
      const verge = this['runoff'] as Fields;
      const kerb = kerbs['on'] === 'none' ? 0 : kerbs['width'] as number;
      const runoff = verge['kind'] === 'none' ? 0 : verge['width'] as number;
      if (lateral <= width / 2) return 'road';
      const kerbed = b.track!.kerbs.some((k) => k.side === side && hit.distance >= k.start && hit.distance <= k.end);
      if (lateral <= width / 2 + kerb) return kerbed ? 'kerb' : runoff > 0 ? 'runoff' : 'off';
      if (lateral <= width / 2 + kerb + runoff) return 'runoff';
      return 'off';
    },
    corners(this: Fields, ...args: unknown[]): Vec2[] {
      bindArgs('corners', args, {});
      return trackOf(this).b.track!.corners.map((c) => new Vec2(c.start, c.end));
    },
  };

  const structureOf = (fields: Fields): { record: EntityRecord; g: StructureGeometry } => {
    const record = recordOf(fields);
    return { record, g: ensure(record, STRUCTURE).structure! };
  };
  const dungeonOf = (fields: Fields): { record: EntityRecord; d: DungeonLayout } => {
    const record = recordOf(fields);
    return { record, d: ensure(record, DUNGEON).dungeon! };
  };
  const world = (record: EntityRecord, p: V3): Vec3 => record.transform.toWorld(toVec(p));
  const structureRooms = (record: EntityRecord, g: StructureGeometry): GeneratedRoom[] =>
    g.rooms.map((r) => new GeneratedRoom(r.id, r.name, 'room', r.floor, world(record, r.center), r.area, false, 0));
  const dungeonRooms = (record: EntityRecord, d: DungeonLayout, tile: number): GeneratedRoom[] =>
    d.rooms.map((r) => new GeneratedRoom(String(r.id), String(r.id), r.role, 0, world(record, r.center),
      (r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]) * tile * tile, r.critical, r.region));
  const yawOf = (record: EntityRecord, yaw: number): number => {
    const forward = record.transform.toWorld(new Vec3(Math.sin((yaw * Math.PI) / 180), 0, Math.cos((yaw * Math.PI) / 180))).__sub__(record.transform.toWorld(Vec3.ZERO));
    return (Math.atan2(forward.x, forward.z) * 180) / Math.PI;
  };

  const structureMethods = {
    rooms(this: Fields, ...args: unknown[]): GeneratedRoom[] {
      bindArgs('rooms', args, {});
      const { record, g } = structureOf(this);
      return structureRooms(record, g);
    },
    doors(this: Fields, ...args: unknown[]): GeneratedDoor[] {
      bindArgs('doors', args, {});
      const { record, g } = structureOf(this);
      return g.openings.map((o) => new GeneratedDoor(o.kind, world(record, o.position), yawOf(record, o.yaw), o.width, [...o.rooms], null));
    },
    stairs(this: Fields, ...args: unknown[]): GeneratedStair[] {
      bindArgs('stairs', args, {});
      const { record, g } = structureOf(this);
      return g.stairs.map((st) => new GeneratedStair(st.floor, world(record, st.bottom), world(record, st.top), yawOf(record, st.yaw), st.width, st.steps));
    },
    room_at(this: Fields, ...args: unknown[]): GeneratedRoom | null {
      const a = bindArgs('room_at', args, { positional: ['point'], required: ['point'] }).args;
      const { record, g } = structureOf(this);
      const local = record.transform.toLocal(vecArg(a['point'], 'room_at() point'));
      const cell = this['cell'] as number;
      const c = Math.floor((local.x - g.footprint[0]) / cell);
      const r = Math.floor((local.z - g.footprint[1]) / cell);
      const heights = (this['floors'] as Fields[]).map((f) => f['height'] as number);
      let floor = 0;
      for (let y = local.y; floor < heights.length - 1 && y >= heights[floor]!; floor++) y -= heights[floor]!;
      const index = g.rooms.findIndex((room) => room.floor === floor && room.cells.some(([rr, cc]) => rr === r && cc === c));
      return index < 0 ? null : structureRooms(record, g)[index]!;
    },
  };

  const dungeonMethods = {
    rooms(this: Fields, ...args: unknown[]): GeneratedRoom[] {
      bindArgs('rooms', args, {});
      const { record, d } = dungeonOf(this);
      return dungeonRooms(record, d, this['tile'] as number);
    },
    doors(this: Fields, ...args: unknown[]): GeneratedDoor[] {
      bindArgs('doors', args, {});
      const { record, d } = dungeonOf(this);
      return d.doors.map((o) => new GeneratedDoor(o.lock !== null ? 'gate' : 'door', world(record, o.position), yawOf(record, o.yaw),
        (this['corridor'] as number) * (this['tile'] as number), [String(o.room), String(o.to)], o.lock));
    },
    entrance(this: Fields, ...args: unknown[]): Vec3 {
      bindArgs('entrance', args, {});
      const { record, d } = dungeonOf(this);
      return world(record, d.rooms[0]!.center);
    },
    room_at(this: Fields, ...args: unknown[]): GeneratedRoom | null {
      const a = bindArgs('room_at', args, { positional: ['point'], required: ['point'] }).args;
      const { record, d } = dungeonOf(this);
      const local = record.transform.toLocal(vecArg(a['point'], 'room_at() point'));
      const tile = this['tile'] as number;
      const i = Math.floor((local.x - d.origin[0]) / tile);
      const j = Math.floor((local.z - d.origin[1]) / tile);
      const index = d.rooms.findIndex((r) => i >= r.rect[0] && i < r.rect[2] && j >= r.rect[1] && j < r.rect[3]);
      return index < 0 ? null : dungeonRooms(record, d, tile)[index]!;
    },
  };

  const components: ComponentDef[] = [
    { id: SPLINE, schema: PROCGEN_SCHEMAS[SPLINE]!, methods: splineMethods },
    { id: SWEEP, schema: PROCGEN_SCHEMAS[SWEEP]! },
    { id: TRACK, schema: PROCGEN_SCHEMAS[TRACK]!, methods: trackMethods },
    { id: STRUCTURE, schema: PROCGEN_SCHEMAS[STRUCTURE]!, methods: structureMethods },
    { id: DUNGEON, schema: PROCGEN_SCHEMAS[DUNGEON]!, methods: dungeonMethods },
    { id: PIECE, schema: PROCGEN_SCHEMAS[PIECE]! },
  ];

  return {
    id: 'procgen',
    service,
    components,
    stats: () => ({ keyed, builds }),
    install(k) {
      if (installed !== undefined) fail('PP3644', 'This procgen plugin is already installed in another kernel', { fix: 'Call procgen() once per game.' });
      installed = k;
      k.provide(PROCGEN_SERVICE, service);
      k.provide(TERRAIN_GRADING_SERVICE, { paths: trackGradePaths });
      k.observeScenes({ loading: () => { built.clear(); dressed.clear(); forget(); } });
      // Generators come and go with entities and components; their data is watched in `ensure`.
      const touched = (records: readonly EntityRecord[]): void => { if (roster !== null && records.some(isGenerator)) roster = null; };
      k.observeEntities({ added: touched, removed: touched, changed: () => { roster = null; } });
      k.addHook('input', () => syncPieces());
    },
    snapshot: (): Json => ({ dressed: [...dressed].map(([id, key]) => [id, key]) }),
    restore(_k, saved) {
      const list = ((saved as JsonObject)['dressed'] ?? []) as Json[];
      dressed.clear();
      for (const entry of list) {
        const [id, key] = entry as [number, string];
        dressed.set(id as EntityId, key);
      }
      built.clear();
      forget();
    },
  };
}

/** A centerline (entity-local) as a world-space `SampledPath`. */
function sampledPath(record: EntityRecord, line: Centerline, version: number): SampledPath {
  const t = record.transform;
  const o = t.toWorld(Vec3.ZERO);
  const dir = (v: readonly number[]): [number, number, number] => {
    const w = t.toWorld(new Vec3(v[0]!, v[1]!, v[2]!)).__sub__(o);
    const l = w.length();
    return l > 0 ? [w.x / l, w.y / l, w.z / l] : [0, 0, 1];
  };
  const pos = (p: readonly number[]): [number, number, number] => {
    const w = t.toWorld(new Vec3(p[0]!, p[1]!, p[2]!));
    return [w.x, w.y, w.z];
  };
  // World distances: scale by the transform's stretch along the path (uniform scale: exact).
  const samples: Sample[] = [];
  let distance = 0;
  line.samples.forEach((s, i) => {
    const point = pos(s.point);
    if (i > 0) {
      const prev = samples[i - 1]!.point;
      distance += Math.hypot(point[0] - prev[0], point[1] - prev[1], point[2] - prev[2]);
    }
    samples.push({ distance, point, tangent: dir(s.tangent), right: dir(s.right), up: dir(s.up), bank: s.bank });
  });
  let length = distance;
  if (line.closed && samples.length > 1) {
    const a = samples[samples.length - 1]!.point;
    const b = samples[0]!.point;
    length += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  const worldLine: Centerline = { closed: line.closed, length, samples };
  const toHit = (sample: Sample, lateral: number, offset: number): PathHitData => ({ ...sample, lateral, offset });
  return {
    entity: record.id, version, closed: line.closed, length, samples,
    at: (d) => sampleAt(worldLine, d),
    nearest: (x, y, z) => {
      const hit = nearestOn(worldLine, [x, y, z]);
      return toHit(hit.sample, hit.lateral, hit.offset);
    },
  };
}
