/**
 * The procgen components' schemas (sdk/parallax/procgen.pyi, field names verbatim) and the
 * readers that turn their runtime fields — and the `profile` / `prop_kit` content entries —
 * into generator specs. Every reader fails with a coded diagnostic naming the entity's
 * component and field; `check` runs the same readers over placements and prefabs.
 */

import { closestMatch, Color, fail, Vec2, Vec3 } from '../../../core/index.js';
import type { Json, JsonObject, Project } from '../../../resource/index.js';
import { instantiate, t } from '../../kernel/index.js';
import type { FieldType, Fields, Schema } from '../../kernel/index.js';
import type { KitProp, PropKit, PropPlace } from './dressing.js';
import type { DungeonSpec } from './dungeon.js';
import { dungeonProblem } from './dungeon.js';
import type { CurveKind, FrameMode, SplineSpec } from './spline.js';
import { splineProblem } from './spline.js';
import { legendKeyProblem, parsePlan } from './plan.js';
import type { OpeningSet, RoofType, StructureSpec } from './structure.js';
import type { Profile } from './sweep.js';
import { BUILTIN_PROFILES } from './sweep.js';
import type { BarrierKind, CrowdSide, KerbMode, RunoffKind, TrackSpec } from './track.js';
import { trackProblem } from './track.js';
import { TRACK_DEFAULTS } from './track_grade.js';

export const SPLINE = 'spline';
export const SWEEP = 'sweep';
export const STRUCTURE = 'structure';
export const DUNGEON = 'dungeon';
export const PIECE = 'generated_piece';
export const TRACK = 'track';
export const PROFILE_KIND = 'profile';
export const PROP_KIT_KIND = 'prop_kit';

const record = (fields: Schema): FieldType => ({ kind: 'record', fields });
const optional = (of: FieldType, spec: { default?: unknown } = { default: null }) => ({ type: { kind: 'optional', of } as FieldType, ...spec });
const num: FieldType = { kind: 'number' };
const str: FieldType = { kind: 'string' };

/** How a generated part looks (sdk ProcMaterial). */
export const MATERIAL_RECORD: Schema = {
  color: t.color({ default: Color.hex('#9a9a9a') }),
  texture: t.string({ default: '' }),
  normal_map: t.string({ default: '' }),
  tile: t.number({ default: 1, min: 0 }),
  roughness: t.number({ default: 0.85, min: 0, max: 1 }),
  metallic: t.number({ default: 0, min: 0, max: 1 }),
};

export const SPLINE_SCHEMA: Schema = {
  points: t.list({ kind: 'vec3' }, { default: [] }),
  closed: t.bool({ default: false }),
  curve: t.enum(['catmull_rom', 'bezier', 'linear'], { default: 'catmull_rom' }),
  frame: t.enum(['level', 'transport'], { default: 'level' }),
  bank: t.list(num, { default: [] }),
  auto_bank: t.number({ default: 0 }),
  bank_radius: t.number({ default: 20 }),
  spacing: t.number({ default: 1 }),
  ground: t.enum(['none', 'terrain'], { default: 'none' }),
  lift: t.number({ default: 0.05 }),
};

/** sdk SweepPart: one profile of a Sweep (`layer` means a collision layer, so these are parts). */
export const SWEEP_PART_RECORD: Schema = {
  profile: t.string({ default: 'road' }),
  width: optional(num),
  height: optional(num),
  offset: t.vec2({ default: new Vec2(0, 0) }),
  mirror: t.bool({ default: false }),
  color: t.color({ default: Color.hex('#7a7a7a') }),
  colors: t.list({ kind: 'color' }, { default: [] }),
  stripe: optional(num),
  texture: t.string({ default: '' }),
  uv_length: t.number({ default: 4 }),
  uv_width: optional(num),
  start: t.number({ default: 0 }),
  end: optional(num),
  caps: t.bool({ default: false }),
  collide: t.bool({ default: true }),
  shadows: t.bool({ default: true }),
  double_sided: t.bool({ default: false }),
  roughness: t.number({ default: 0.85, min: 0, max: 1 }),
  metallic: t.number({ default: 0, min: 0, max: 1 }),
};

export const SWEEP_SCHEMA: Schema = {
  parts: t.list(record(SWEEP_PART_RECORD), { default: [instantiate(SWEEP_PART_RECORD, { profile: 'road' }, 'sweep.parts[0]')] }),
};

export const STRUCTURE_FLOOR_RECORD: Schema = {
  plan: t.list(str, { default: [] }),
  height: t.number({ default: 3 }),
};

export const ROOM_LEGEND_RECORD: Schema = {
  name: t.string({ default: '' }),
  floor: t.string({ default: 'floor' }),
  height: optional(num),
};

const LEVELS = optional({ kind: 'list', of: { kind: 'int' } });
const OPENINGS = ['windows', 'doors', 'all'];

export const SHUTTERS_RECORD: Schema = {
  width: t.number({ default: 0.5, min: 0.1, max: 1 }),
  levels: LEVELS,
};

export const MULLIONS_RECORD: Schema = {
  spacing: t.number({ default: 1.2, min: 0.2 }),
  width: t.number({ default: 0.06, min: 0.01 }),
  levels: LEVELS,
};

export const AWNINGS_RECORD: Schema = {
  on: t.enum(OPENINGS, { default: 'windows' }),
  depth: t.number({ default: 1.1, min: 0.2 }),
  drop: t.number({ default: 0.25, min: 0 }),
  rise: t.number({ default: 0.15, min: 0 }),
  levels: LEVELS,
};

export const BALCONIES_RECORD: Schema = {
  on: t.enum(OPENINGS, { default: 'windows' }),
  depth: t.number({ default: 1, min: 0.2 }),
  rail: t.number({ default: 0.95, min: 0 }),
  levels: LEVELS,
};

export const ROOF_RECORD: Schema = {
  kind: t.enum(['flat', 'gable', 'hip', 'shed', 'none'], { default: 'gable' }),
  pitch: t.number({ default: 30 }),
  overhang: t.number({ default: 0.3 }),
  access: t.bool({ default: false }),
  parapet: t.number({ default: 0, min: 0 }),
  coping: t.bool({ default: false }),
};

export const FACADE_RECORD: Schema = {
  plinth: t.number({ default: 0, min: 0 }),
  shutters: optional(record(SHUTTERS_RECORD)),
  mullions: optional(record(MULLIONS_RECORD)),
  awnings: optional(record(AWNINGS_RECORD)),
  balconies: optional(record(BALCONIES_RECORD)),
};

export const STRUCTURE_SCHEMA: Schema = {
  plan: optional(str),
  floors: t.list(record(STRUCTURE_FLOOR_RECORD), { default: [] }),
  legend: { type: { kind: 'dict', of: record(ROOM_LEGEND_RECORD) }, default: {} },
  materials: { type: { kind: 'dict', of: record(MATERIAL_RECORD) }, default: {} },
  colors: { type: { kind: 'dict', of: { kind: 'color' } }, default: {} },
  cell: t.number({ default: 1 }),
  slab: t.number({ default: 0.2 }),
  door_height: t.number({ default: 2.2 }),
  window_sill: t.number({ default: 0.9 }),
  window_height: t.number({ default: 1.2 }),
  roof: { type: record(ROOF_RECORD), default: instantiate(ROOF_RECORD, {}, 'structure.roof') },
  facade: { type: record(FACADE_RECORD), default: instantiate(FACADE_RECORD, {}, 'structure.facade') },
  door_prefab: optional({ kind: 'ref', to: 'prefab' }),
  kit: optional(str),
  seed: t.int({ default: 0 }),
  collide: t.bool({ default: true }),
  layer: t.string({ default: 'default' }),
};

/** Material keys a Structure reads (besides its rooms' floor keys), and what each falls back to when `materials` leaves it out. */
export const STRUCTURE_MATERIALS: Readonly<Record<string, string | null>> = {
  wall: null, roof: null, glass: null, floor: null, slab: 'wall', stair: 'slab', plinth: 'roof', coping: 'roof', balcony: 'roof',
  shutter: null, mullion: null, awning: null,
};

export const DUNGEON_SCHEMA: Schema = {
  seed: t.int({ default: 0 }),
  rooms: t.int({ default: 10 }),
  locks: t.int({ default: 0 }),
  treasures: t.int({ default: 1 }),
  loops: t.int({ default: 0 }),
  room_min: t.int({ default: 5 }),
  room_max: t.int({ default: 9 }),
  corridor: t.int({ default: 2 }),
  tile: t.number({ default: 2 }),
  wall_height: t.number({ default: 4 }),
  ceiling: t.bool({ default: false }),
  materials: { type: { kind: 'dict', of: record(MATERIAL_RECORD) }, default: {} },
  kit: optional(str),
  key_prefab: optional({ kind: 'ref', to: 'prefab' }),
  gate_prefab: optional({ kind: 'ref', to: 'prefab' }),
  door_prefab: optional({ kind: 'ref', to: 'prefab' }),
  objective_prefab: optional({ kind: 'ref', to: 'prefab' }),
  treasure_prefab: optional({ kind: 'ref', to: 'prefab' }),
  enemy_prefab: optional({ kind: 'ref', to: 'prefab' }),
  enemies: t.int({ default: 0 }),
  collide: t.bool({ default: true }),
  layer: t.string({ default: 'default' }),
};

const colors = (...hex: string[]) => t.list({ kind: 'color' }, { default: hex.map((h) => Color.hex(h)) });

/** A Track's tarmac (sdk TrackSurface). */
export const TRACK_SURFACE_RECORD: Schema = {
  color: t.color({ default: Color.hex('#4a4a52') }),
  texture: t.string({ default: '' }),
  tile: t.number({ default: 6 }),
  roughness: t.number({ default: 0.72, min: 0, max: 1 }),
  crown: t.number({ default: 0.1 }),
};

/** Painted lines along the tarmac's edges (sdk TrackEdgeLines). */
export const TRACK_EDGE_LINES_RECORD: Schema = {
  width: t.number({ default: 0.22 }),
  inset: t.number({ default: 0.3 }),
  color: t.color({ default: Color.hex('#f2ece0') }),
};

/** sdk TrackKerbs. */
export const TRACK_KERBS_RECORD: Schema = {
  on: t.enum(['corners', 'apex', 'full', 'none'], { default: TRACK_DEFAULTS.kerbs.on }),
  width: t.number({ default: TRACK_DEFAULTS.kerbs.width }),
  height: t.number({ default: 0.11 }),
  stripe: t.number({ default: 2.2 }),
  colors: colors('#e0453f', '#f2ece0'),
  radius: t.number({ default: 120 }),
  extend: t.number({ default: 12 }),
};

/** sdk TrackRunoff. */
export const TRACK_RUNOFF_RECORD: Schema = {
  kind: t.enum(['gravel', 'grass', 'tarmac', 'none'], { default: TRACK_DEFAULTS.runoff.kind }),
  width: t.number({ default: TRACK_DEFAULTS.runoff.width }),
  color: optional({ kind: 'color' }),
};

/** sdk TrackBarrier. */
export const TRACK_BARRIER_RECORD: Schema = {
  kind: t.enum(['armco', 'wall', 'none'], { default: TRACK_DEFAULTS.barrier.kind }),
  gap: t.number({ default: TRACK_DEFAULTS.barrier.gap }),
  height: t.number({ default: 0.75 }),
  colors: t.list({ kind: 'color' }, { default: [] }),
  post_every: t.number({ default: 4 }),
  collide: t.bool({ default: true }),
  tyre_walls: t.bool({ default: true }),
  tyre_colors: colors('#1d1d1f', '#f2ece0'),
};

/** sdk TrackCrowd. */
export const TRACK_CROWD_RECORD: Schema = {
  sections: t.list({ kind: 'vec2' }, { default: [] }),
  side: t.enum(['both', 'left', 'right'], { default: 'both' }),
  rows: t.int({ default: 4 }),
  row_gap: t.number({ default: 0.9 }),
  row_rise: t.number({ default: 0.45 }),
  density: t.number({ default: 1.1 }),
  setback: t.number({ default: 2 }),
  max: t.int({ default: 1200 }),
  stands: t.bool({ default: true }),
  stand_color: t.color({ default: Color.hex('#8d8a84') }),
  colors: t.list({ kind: 'color' }, { default: [] }),
};

/** sdk TrackGantry. */
export const TRACK_GANTRY_RECORD: Schema = {
  color: t.color({ default: Color.hex('#1f3a6b') }),
};

/** sdk TrackSigns. */
export const TRACK_SIGNS_RECORD: Schema = {
  every: t.number({ default: 0 }),
  colors: t.list({ kind: 'color' }, { default: [] }),
};

/** sdk TrackGrade. */
export const TRACK_GRADE_RECORD: Schema = {
  feather: t.number({ default: TRACK_DEFAULTS.grade.feather }),
  paint: optional(str),
};

const part = (fields: Schema, where: string) => ({ type: record(fields), default: instantiate(fields, {}, where) });
const optionalPart = (fields: Schema, where: string) => optional(record(fields), { default: instantiate(fields, {}, where) });

/** A race track along the entity's Spline (sdk Track; track.ts builds it, track_grade.ts grades the ground). */
export const TRACK_SCHEMA: Schema = {
  width: t.number({ default: TRACK_DEFAULTS.width }),
  start: t.number({ default: 0 }),
  surface: part(TRACK_SURFACE_RECORD, 'track.surface'),
  edge_lines: optionalPart(TRACK_EDGE_LINES_RECORD, 'track.edge_lines'),
  kerbs: part(TRACK_KERBS_RECORD, 'track.kerbs'),
  runoff: part(TRACK_RUNOFF_RECORD, 'track.runoff'),
  barrier: part(TRACK_BARRIER_RECORD, 'track.barrier'),
  crowd: part(TRACK_CROWD_RECORD, 'track.crowd'),
  gantry: optionalPart(TRACK_GANTRY_RECORD, 'track.gantry'),
  finish_line: t.bool({ default: true }),
  signs: part(TRACK_SIGNS_RECORD, 'track.signs'),
  grade: optionalPart(TRACK_GRADE_RECORD, 'track.grade'),
  seed: t.int({ default: 0 }),
  collide: t.bool({ default: true }),
};

/** On every entity a Structure or Dungeon spawns (kept by the engine). */
export const PIECE_SCHEMA: Schema = {
  source: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
  role: t.string({ default: '' }),
  room: t.string({ default: '' }),
  lock: optional({ kind: 'int' }),
};

export const PROCGEN_SCHEMAS: Readonly<Record<string, Schema>> = {
  [SPLINE]: SPLINE_SCHEMA, [SWEEP]: SWEEP_SCHEMA,[STRUCTURE]: STRUCTURE_SCHEMA, [DUNGEON]: DUNGEON_SCHEMA,
  [PIECE]: PIECE_SCHEMA, [TRACK]: TRACK_SCHEMA,
};

// ── Readers ─────────────────────────────────────────────────────────────────────

export interface MaterialSpec {
  readonly color: readonly [number, number, number, number];
  readonly texture: string | null;
  /** Tangent-space normal map, tiled like the texture. */
  readonly normal?: string | null;
  readonly tile: number;
  readonly roughness: number;
  readonly metallic: number;
}

export function rgba(value: unknown): [number, number, number, number] {
  const c = value as Color;
  return [c.r, c.g, c.b, c.a];
}

export function materialOf(fields: Fields | undefined, fallback: Partial<MaterialSpec> = {}): MaterialSpec {
  const f = fields ?? {};
  const texture = (f['texture'] as string | undefined) ?? '';
  const normal = (f['normal_map'] as string | undefined) ?? '';
  return {
    color: f['color'] !== undefined ? rgba(f['color']) : fallback.color ?? [0.6, 0.6, 0.6, 1],
    texture: texture === '' ? fallback.texture ?? null : texture,
    normal: normal === '' ? fallback.normal ?? null : normal,
    tile: (f['tile'] as number | undefined) ?? fallback.tile ?? 1,
    roughness: (f['roughness'] as number | undefined) ?? fallback.roughness ?? 0.85,
    metallic: (f['metallic'] as number | undefined) ?? fallback.metallic ?? 0,
  };
}

/** Where a spec came from, for messages: "entity 12 spline". */
export type Where = string;

export function splineSpec(fields: Fields, where: Where): SplineSpec {
  const spec: SplineSpec = {
    points: (fields['points'] as Vec3[]).map((p) => [p.x, p.y, p.z] as const),
    closed: fields['closed'] as boolean,
    curve: fields['curve'] as CurveKind,
    frame: fields['frame'] as FrameMode,
    bank: [...(fields['bank'] as number[])],
    autoBank: fields['auto_bank'] as number,
    bankRadius: fields['bank_radius'] as number,
    spacing: fields['spacing'] as number,
  };
  const problem = splineProblem(spec);
  if (problem !== undefined) {
    fail('PP3640', `${where}: ${problem}`, {
      fix: 'Give the Spline its control points in the entity\'s local space: {"spline": {"points": [[0, 0, 0], [20, 0, 10], ...], "closed": true}}.',
    });
  }
  return spec;
}

/** The project's profile content entries, read once (sdk ProfileDef). */
export function readProfiles(project: Project): Map<string, Profile> {
  const out = new Map<string, Profile>();
  for (const entry of project.content.get(PROFILE_KIND)?.values() ?? []) {
    const v = entry.values;
    const bad = (pointer: string, message: string, fix: string): never => fail('PP3641', `content/profile/${entry.id}.json: ${message}`, { path: entry.path, pointer, fix });
    const points = v['points'];
    if (!Array.isArray(points) || points.length < 2) bad('/points', '"points" must list at least 2 [x, y] points', 'Write "points": [[0.5, 0], [-0.5, 0]] (x right, y up, meters).');
    const pts = (points as Json[]).map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return bad(`/points/${i}`, `point ${i} must be [x, y]`, 'Write each point as two numbers.');
      }
      return [p[0] as number, p[1] as number] as const;
    });
    const flag = (key: string): boolean => {
      const value = v[key];
      if (value === undefined) return false;
      return typeof value === 'boolean' ? value : bad(`/${key}`, `"${key}" must be true or false`, `Write "${key}": true or false.`);
    };
    const size = (key: string): number => {
      const value = v[key];
      if (value === undefined) return 1;
      return typeof value === 'number' && value > 0 ? value : bad(`/${key}`, `"${key}" must be a number above 0`, 'Profiles are scaled by the layer\'s width and height; 1 keeps the points as meters.');
    };
    out.set(entry.id, { outlines: [{ points: pts, closed: flag('closed'), smooth: flag('smooth') }], width: size('width'), height: size('height') });
  }
  return out;
}

export function profileOf(name: string, profiles: ReadonlyMap<string, Profile>, where: Where): Profile {
  const profile = BUILTIN_PROFILES[name] ?? profiles.get(name);
  if (profile === undefined) {
    const known = [...Object.keys(BUILTIN_PROFILES), ...profiles.keys()];
    const guess = closestMatch(name, known);
    fail('PP3641', `${where}: there is no profile "${name}"`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?` : `Use a built-in (${Object.keys(BUILTIN_PROFILES).join(', ')}) or add content/profile/${name}.json.`,
    });
  }
  return profile;
}

export function checkLayer(layer: Fields, where: Where): void {
  const positive = (key: string, optionalField = false): void => {
    const value = layer[key];
    if (optionalField && (value === null || value === undefined)) return;
    if (!(typeof value === 'number' && value > 0 && Number.isFinite(value))) {
      fail('PP3641', `${where}: ${key} must be a number above 0, got ${String(value)}`, { fix: `Set ${key} to a positive number of meters${optionalField ? ', or leave it out' : ''}.` });
    }
  };
  positive('width', true);
  positive('height', true);
  positive('uv_length');
  positive('uv_width', true);
  positive('stripe', true);
  if (layer['stripe'] !== null && (layer['colors'] as unknown[]).length === 0) {
    fail('PP3641', `${where}: stripe needs colors to cycle`, { fix: 'Add "colors": ["#e0453f", "#f2ece0"], or remove "stripe".' });
  }
  const start = layer['start'] as number;
  const end = layer['end'] as number | null;
  if (start < 0 || (end !== null && end <= start)) {
    fail('PP3641', `${where}: start ${start} / end ${String(end)} must satisfy 0 <= start < end`, { fix: 'Distances are meters along the spline.' });
  }
}


/**
 * A Structure's spec. `plans` holds the project's `.plan` files (Project.plans): with
 * `plan` set, the storeys and legend come from that file (inline `legend` entries add to
 * and override its legend). Plan-file problems are PP3653 at the file's line and column.
 */
export function structureSpec(fields: Fields, where: Where, plans?: ReadonlyMap<string, string>): StructureSpec {
  let floors: { plan: string[]; height: number }[] = (fields['floors'] as Fields[]).map((f) => ({ plan: [...(f['plan'] as string[])], height: f['height'] as number }));
  let rows: readonly (readonly number[])[] | undefined;
  const fileLegend: Record<string, { name: string; floor: string; height: number | null }> = {};
  const planPath = fields['plan'] as string | null;
  if (planPath !== null) {
    if (floors.length > 0) fail('PP3651', `${where}: has both a plan file ("${planPath}") and inline floors`, { fix: 'Keep one: "plan" names a .plan file; "floors" draws the storeys inline.' });
    const text = plans?.get(planPath);
    if (text === undefined) {
      const guess = closestMatch(planPath, [...plans?.keys() ?? []]);
      fail('PP3653', `${where}: there is no plan file "${planPath}"`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Name a project-relative .plan file, e.g. "buildings/shop.plan".' });
    }
    const parsed = parsePlan(text);
    const p = parsed.problems[0];
    if (p !== undefined) fail('PP3653', `${planPath} line ${p.line}, column ${p.column}: ${p.message}${parsed.problems.length > 1 ? ` (and ${parsed.problems.length - 1} more)` : ''}`, { fix: p.fix, path: planPath, line: p.line });
    floors = parsed.floors.map((f) => ({ plan: [...f.plan], height: f.height }));
    rows = parsed.floors.map((f) => f.lines);
    Object.assign(fileLegend, parsed.legend);
  }
  const legend: Record<string, { name: string; floor: string; height: number | null }> = { ...fileLegend };
  for (const [ch, entry] of Object.entries(fields['legend'] as Record<string, Fields>)) {
    if ([...ch].length !== 1) {
      fail('PP3651', `${where}: legend key "${ch}" must be one character`, { fix: 'Legend keys are the plan characters they style: {"legend": {"k": {"name": "kitchen"}}}.' });
    }
    const reserved = legendKeyProblem(ch);
    if (reserved !== undefined) fail('PP3651', `${where}: ${reserved.message}`, { fix: reserved.fix });
    const height = entry['height'] as number | null;
    if (height !== null && !(height > 0)) fail('PP3651', `${where}: legend "${ch}" height must be above 0, got ${height}`, { fix: 'Give the room\'s wall height in meters, or leave it out (the storey\'s).' });
    legend[ch] = { name: (entry['name'] as string) || ch, floor: entry['floor'] as string, height };
  }
  // Material keys: the ones the generator reads and the rooms' floors; anything else is a typo.
  const known = [...Object.keys(STRUCTURE_MATERIALS), ...Object.values(legend).map((l) => l.floor)];
  for (const key of [...Object.keys(fields['materials'] as object), ...Object.keys(fields['colors'] as object)]) {
    if (known.includes(key)) continue;
    const guess = closestMatch(key, known);
    fail('PP3652', `${where}: material key "${key}" is not one a Structure reads`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?` : `Keys: ${Object.keys(STRUCTURE_MATERIALS).join(', ')} and the legend's floor keys.`,
    });
  }
  const positive = (key: string): number => {
    const value = fields[key] as number;
    if (!(value > 0)) fail('PP3651', `${where}: ${key} must be above 0, got ${value}`, { fix: `Set ${key} in meters.` });
    return value;
  };
  const roof = fields['roof'] as Fields;
  const pitch = roof['pitch'] as number;
  if (!(pitch > 0 && pitch < 80)) fail('PP3651', `${where}: roof.pitch must be between 0 and 80 degrees, got ${pitch}`);
  const overhang = roof['overhang'] as number;
  if (!(overhang >= 0)) fail('PP3651', `${where}: roof.overhang can't be negative`);
  const nonNegative = (key: string, value: unknown): number => {
    if (!(typeof value === 'number' && value >= 0 && Number.isFinite(value))) fail('PP3651', `${where}: ${key} must be 0 or more meters, got ${String(value)}`, { fix: `Set ${key} in meters (0: none).` });
    return value;
  };
  const levels = (key: string, value: unknown): number[] | null => {
    if (value === null) return null;
    const list = value as number[];
    const bad = list.find((n) => !(Number.isInteger(n) && n >= 0 && n < floors.length));
    if (bad !== undefined) fail('PP3651', `${where}: facade.${key}.levels has ${bad}, which is not a storey (0 to ${floors.length - 1})`, { fix: 'List storeys by index, the ground floor 0; None for the default.' });
    return [...list];
  };
  const f = fields['facade'] as Fields;
  const block = <T>(key: string, read: (b: Fields) => T): T | null => {
    const value = f[key] as Fields | null;
    return value === null ? null : read(value);
  };
  const facade = {
    shutters: block('shutters', (b) => ({ width: b['width'] as number, levels: levels('shutters', b['levels']) })),
    mullions: block('mullions', (b) => ({ spacing: b['spacing'] as number, width: b['width'] as number, levels: levels('mullions', b['levels']) })),
    awnings: block('awnings', (b) => ({
      on: b['on'] as OpeningSet, depth: b['depth'] as number, drop: nonNegative('facade.awnings.drop', b['drop']), rise: nonNegative('facade.awnings.rise', b['rise']),
      levels: levels('awnings', b['levels']),
    })),
    balconies: block('balconies', (b) => ({
      on: b['on'] as OpeningSet, depth: b['depth'] as number, rail: nonNegative('facade.balconies.rail', b['rail']), levels: levels('balconies', b['levels']),
    })),
  };
  return {
    floors,
    legend,
    cell: positive('cell'),
    slab: positive('slab'),
    doorHeight: positive('door_height'),
    windowSill: fields['window_sill'] as number,
    windowHeight: positive('window_height'),
    roof: {
      type: roof['kind'] as RoofType, pitch, overhang, access: roof['access'] as boolean,
      parapet: nonNegative('roof.parapet', roof['parapet']), coping: roof['coping'] as boolean,
    },
    plinth: nonNegative('facade.plinth', f['plinth']),
    facade,
    ...(planPath !== null && rows !== undefined && { source: { path: planPath, rows } }),
  };
}

export function dungeonSpec(fields: Fields, where: Where): DungeonSpec {
  const spec: DungeonSpec = {
    seed: fields['seed'] as number,
    rooms: fields['rooms'] as number,
    locks: fields['locks'] as number,
    treasures: fields['treasures'] as number,
    loops: fields['loops'] as number,
    roomSize: [fields['room_min'] as number, fields['room_max'] as number],
    corridor: fields['corridor'] as number,
    tile: fields['tile'] as number,
    wallHeight: fields['wall_height'] as number,
    ceiling: fields['ceiling'] as boolean,
  };
  const problem = dungeonProblem(spec);
  if (problem !== undefined) fail('PP3660', `${where}: ${problem}`, { fix: 'See sdk/parallax/procgen.pyi Dungeon for the ranges.' });
  if ((fields['locks'] as number) > 0 && (fields['key_prefab'] === null || fields['gate_prefab'] === null)) {
    fail('PP3660', `${where}: locks need key_prefab and gate_prefab`, { fix: 'Name the prefabs spawned as each lock\'s key and locked door, or set locks to 0.' });
  }
  return spec;
}

const PLACES: readonly PropPlace[] = ['center', 'corner', 'wall', 'floor'];
const KIT_KEYS = ['density', 'max_per_room', 'wall_step', 'clearance', 'inset', 'props'];
const PROP_KEYS = ['prefab', 'place', 'weight', 'radius', 'scale'];

/** The project's prop kits (sdk PropKitDef), prefab names checked. */
export function readKits(project: Project): Map<string, PropKit> {
  const out = new Map<string, PropKit>();
  for (const entry of project.content.get(PROP_KIT_KIND)?.values() ?? []) {
    const v = entry.values;
    const bad = (pointer: string, message: string, fix: string): never => fail('PP3661', `content/prop_kit/${entry.id}.json: ${message}`, { path: entry.path, pointer, fix });
    const keys = (obj: JsonObject, at: string, allowed: readonly string[]): void => {
      for (const key of Object.keys(obj)) {
        if (allowed.includes(key)) continue;
        const guess = closestMatch(key, allowed);
        bad(`${at}/${key}`, `unknown key "${key}"`, guess !== undefined ? `Did you mean "${guess}"?` : `Keys: ${allowed.join(', ')}.`);
      }
    };
    keys(v, '', KIT_KEYS);
    const number = (obj: JsonObject, key: string, at: string, fallback: number, min: number): number => {
      const value = obj[key];
      if (value === undefined) return fallback;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return bad(`${at}/${key}`, `"${key}" must be a number >= ${min}`, `Write "${key}": <number>.`);
      return value;
    };
    const propsJson = v['props'];
    if (!Array.isArray(propsJson) || propsJson.length === 0) bad('/props', '"props" must list at least one prop', 'Add "props": [{"prefab": "barrel", "place": "wall"}].');
    const props = (propsJson as Json[]).map((value, i): KitProp => {
      const at = `/props/${i}`;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad(at, `prop ${i} must be an object`, 'Write {"prefab": "...", "place": "wall"}.');
      const p = value as JsonObject;
      keys(p, at, PROP_KEYS);
      const prefab = p['prefab'];
      if (typeof prefab !== 'string') return bad(`${at}/prefab`, '"prefab" must name a prefab', 'Write "prefab": "<prefab id>".');
      if (!project.prefabs.has(prefab)) {
        const guess = closestMatch(prefab, project.prefabs.keys());
        bad(`${at}/prefab`, `there is no prefab "${prefab}"`, guess !== undefined ? `Did you mean "${guess}"?` : `Create prefabs/${prefab}.prefab.json.`);
      }
      const place = p['place'] ?? 'floor';
      if (typeof place !== 'string' || !(PLACES as readonly string[]).includes(place)) {
        return bad(`${at}/place`, `"place" must be one of ${PLACES.join(', ')}`, 'Pick where the prop goes in a room.');
      }
      let scale: [number, number] = [1, 1];
      const s = p['scale'];
      if (s !== undefined) {
        if (!Array.isArray(s) || s.length !== 2 || !s.every((n) => typeof n === 'number' && n > 0) || (s[0] as number) > (s[1] as number)) {
          return bad(`${at}/scale`, '"scale" must be [min, max] above 0', 'Write "scale": [0.9, 1.1].');
        }
        scale = [s[0] as number, s[1] as number];
      }
      return { prefab, place: place as PropPlace, weight: number(p, 'weight', at, 1, 0), radius: number(p, 'radius', at, 0.5, 0), scale };
    });
    out.set(entry.id, {
      id: entry.id,
      density: number(v, 'density', '', 6, 0),
      maxPerRoom: Math.floor(number(v, 'max_per_room', '', 12, 0)),
      wallStep: number(v, 'wall_step', '', 3, 0),
      clearance: number(v, 'clearance', '', 1.5, 0),
      inset: number(v, 'inset', '', 0.8, 0),
      props,
    });
  }
  return out;
}

export function trackSpec(fields: Fields, where: Where): TrackSpec {
  const list = (from: Fields, key: string): [number, number, number, number][] => (from[key] as unknown[]).map(rgba);
  const surface = fields['surface'] as Fields;
  const edge = fields['edge_lines'] as Fields | null;
  const kerbs = fields['kerbs'] as Fields;
  const runoff = fields['runoff'] as Fields;
  const barrier = fields['barrier'] as Fields;
  const crowd = fields['crowd'] as Fields;
  const gantry = fields['gantry'] as Fields | null;
  const signs = fields['signs'] as Fields;
  const spec: TrackSpec = {
    width: fields['width'] as number,
    crown: surface['crown'] as number,
    surface: materialOf({ color: surface['color'], texture: surface['texture'], tile: surface['tile'], roughness: surface['roughness'], metallic: 0 }),
    edgeLines: edge === null ? null : { width: edge['width'] as number, inset: edge['inset'] as number, color: rgba(edge['color']) },
    kerbs: kerbs['on'] as KerbMode,
    kerbWidth: kerbs['width'] as number,
    kerbHeight: kerbs['height'] as number,
    kerbStripe: kerbs['stripe'] as number,
    kerbColors: list(kerbs, 'colors'),
    kerbRadius: kerbs['radius'] as number,
    kerbExtend: kerbs['extend'] as number,
    runoff: runoff['kind'] as RunoffKind,
    runoffWidth: runoff['width'] as number,
    runoffColor: runoff['color'] === null ? null : rgba(runoff['color']),
    barrier: barrier['kind'] as BarrierKind,
    barrierGap: barrier['gap'] as number,
    barrierHeight: barrier['height'] as number,
    barrierColors: list(barrier, 'colors'),
    postEvery: barrier['post_every'] as number,
    barrierCollide: barrier['collide'] as boolean,
    tyreWalls: barrier['tyre_walls'] as boolean,
    tyreColors: list(barrier, 'tyre_colors'),
    crowd: (crowd['sections'] as Vec2[]).map((v) => [v.x, v.y] as const),
    crowdSide: crowd['side'] as CrowdSide,
    crowdRows: crowd['rows'] as number,
    crowdRowGap: crowd['row_gap'] as number,
    crowdRowRise: crowd['row_rise'] as number,
    crowdDensity: crowd['density'] as number,
    crowdSetback: crowd['setback'] as number,
    crowdMax: crowd['max'] as number,
    stands: crowd['stands'] as boolean,
    standColor: rgba(crowd['stand_color']),
    crowdColors: list(crowd, 'colors'),
    gantry: gantry !== null,
    start: fields['start'] as number,
    gantryColor: rgba(gantry?.['color'] ?? Color.hex('#1f3a6b')),
    finishLine: fields['finish_line'] as boolean,
    signsEvery: signs['every'] as number,
    signColors: list(signs, 'colors'),
    seed: fields['seed'] as number,
    collide: fields['collide'] as boolean,
  };
  const problem = trackProblem(spec);
  if (problem !== undefined) {
    fail('PP3645', `${where}: ${problem}`, { fix: 'See sdk/parallax/procgen.pyi Track for each field\'s meaning and range.' });
  }
  return spec;
}
