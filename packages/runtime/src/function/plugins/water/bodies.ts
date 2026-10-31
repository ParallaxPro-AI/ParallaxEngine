/**
 * Water bodies: the `water_body` component and what one is in the world.
 *
 *   ocean   no edge: water everywhere at the entity's height, `depth` meters deep
 *   lake    an `area` footprint (the terrain's schema: {"center", "radius"} a circle, or
 *           {"center", "size": [w, d], "rotation"} a rectangle; in the entity's own x and z,
 *           turned with its yaw), its surface at the entity's height
 *   pool    a lake that is still unless told otherwise (`waves` "none" by default)
 *   river   a ribbon `width` meters wide along `points` (entity-local, smoothed through
 *           with a Catmull-Rom curve); its surface follows the points' heights, and it
 *           flows downstream (first point to last) at `flow` m/s on average — fastest in
 *           the middle, slack at the banks (a parabolic profile, 1.5× the mean at the center)
 *
 * The surface carries the body's waves (waves.ts). Where two bodies overlap (a pool above
 * the sea), a point is in the one with the highest surface whose bed is below it.
 */

import { closestMatch, fail, readFootprint, Vec3 } from '../../../core/index.js';
import type { Color, EntityId, Footprint, Quat } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { Schema } from '../../kernel/index.js';
import { buildWaves, WAVE_PRESET_NAMES, WAVE_PRESETS, waveHeight } from './waves.js';
import type { WavePreset, WaveSet, WaveSpec } from './waves.js';

export const WATER_BODY = 'water_body';
export const WATER_KINDS = ['ocean', 'lake', 'pool', 'river'] as const;
export type WaterKind = (typeof WATER_KINDS)[number];

const optional = (kind: 'number' | 'color' | 'string'): Schema[string] => ({ type: { kind: 'optional', of: { kind } }, default: null });

export const WATER_BODY_SCHEMA: Schema = {
  kind: t.enum(WATER_KINDS, { default: 'lake' }),
  /** lake/pool: a footprint in the entity's x and z ({"center", "radius"} or {"center", "size", "rotation"}). */
  area: t.json({ default: null }),
  /** Meters from the still surface to the bed; None: ocean 100, lake 6, pool 2, river 2. */
  depth: optional('number'),
  /** A wave preset (none, calm, choppy, rough, storm); None: ocean choppy, lake and river calm, pool none. */
  waves: optional('string'),
  /** Overrides of the preset: significant height (m), peak wavelength (m), direction (compass degrees), spread (degrees), choppiness (0..1). */
  wave_height: optional('number'),
  wavelength: optional('number'),
  wave_direction: t.number({ default: 0 }),
  wave_spread: t.number({ default: 35, min: 0, max: 180 }),
  choppiness: optional('number'),
  /** Waves grow with the weather's wind (oceans and lakes; needs weather()). */
  wind_waves: t.bool({ default: true }),
  seed: t.int({ default: 1 }),
  /** Deep water and shallows, as seen from above (None: the kind's own). */
  color: optional('color'),
  shallow_color: optional('color'),
  /** Meters light crosses before the water is mostly opaque. */
  clarity: t.number({ default: 8, min: 0.1 }),
  foam: t.number({ default: 0.5, min: 0, max: 1 }),
  caustics: t.number({ default: 0.6, min: 0, max: 1 }),
  /** 0..2: strength of the small ripples (chop) on the waves; 1 as drawn by default. */
  ripple: t.number({ default: 1, min: 0, max: 2 }),
  /** Meters from the camera over which the surface calms to a mirror of the sky (far water reads as
   *  haze, not texture); 0: never. */
  calm_distance: t.number({ default: 0, min: 0 }),
  /** A sound for splashes on this body (anything falling in, a swimmer going in, `ctx.water.splash`); None: silent. */
  splash_sound: { type: { kind: 'optional', of: { kind: 'ref', to: 'asset/sfx' } }, default: null },
  /** kg/m³: 1000 fresh water, 1025 sea water. */
  density: t.number({ default: 1000, min: 1 }),
  /** river: the course, entity-local, upstream first. */
  points: t.list({ kind: 'vec3' }, { default: [] }),
  /** river: meters across. */
  width: t.number({ default: 6, min: 0.1 }),
  /** river: mean speed downstream, m/s. */
  flow: t.number({ default: 1.5, min: 0 }),
};

/** A stored sound reference (its id string, or a SoundRef the api stored) as written; null: none. */
function writtenRef(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    const json = (value as { toJSON(): unknown }).toJSON();
    if (typeof json === 'string') return json;
  }
  return null;
}

const DEPTHS: Record<WaterKind, number> = { ocean: 100, lake: 6, pool: 2, river: 2 };
const DEFAULT_WAVES: Record<WaterKind, WavePreset> = { ocean: 'choppy', lake: 'calm', pool: 'none', river: 'calm' };

/** The problems with a water_body's fields that a schema can't state (check and runtime share them). */
export interface FieldProblem {
  readonly pointer: string;
  readonly message: string;
  readonly fix: string;
}

/** A lake's or pool's `area` (authored JSON, or a game-side dict) as a footprint, or the problem with it. */
function readArea(value: unknown): Footprint | FieldProblem {
  const plain = typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON(): unknown }).toJSON() : value;
  const box: { problem?: FieldProblem } = {};
  const stop = new Error('footprint');
  try {
    const shape = readFootprint(plain, '/area', (pointer, message, fix) => {
      box.problem = { pointer, message, fix };
      throw stop;
    });
    if (shape.kind === 'polygon') {
      return { pointer: '/area/points', message: 'a lake or pool is a circle or a rectangle, not a polygon', fix: 'Give a "center" with a "radius" or a "size": [w, d].' };
    }
    return shape;
  } catch (e) {
    if (e === stop && box.problem !== undefined) return box.problem;
    throw e;
  }
}

function footprintProblem(value: unknown): FieldProblem | null {
  const area = readArea(value);
  return 'pointer' in area ? area : null;
}

function fieldNumber(fields: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = fields[key];
  return typeof v === 'number' ? v : null;
}

/** Field rules across fields, on authored JSON or runtime fields alike. */
export function waterBodyProblems(fields: Readonly<Record<string, unknown>>): FieldProblem[] {
  const out: FieldProblem[] = [];
  const kind = (fields['kind'] ?? 'lake') as WaterKind;
  const waves = fields['waves'];
  if (typeof waves === 'string' && !(WAVE_PRESET_NAMES as string[]).includes(waves)) {
    const guess = closestMatch(waves, WAVE_PRESET_NAMES);
    out.push({ pointer: '/waves', message: `unknown wave preset "${waves}"`, fix: guess === undefined ? `Use one of: ${WAVE_PRESET_NAMES.join(', ')}.` : `Did you mean "${guess}"?` });
  }
  // Old spellings: a lake's region is an `area` footprint now (`size` alone means full extents).
  if (fields['size'] !== undefined && fields['size'] !== null) {
    out.push({ pointer: '/size', message: 'a water body\'s region is "area", a footprint', fix: 'Write "area": {"center": [0, 0], "size": [w, d]} (full width and depth) instead of "size".' });
  }
  if (fields['shape'] !== undefined && fields['shape'] !== null) {
    out.push({ pointer: '/shape', message: 'a water body\'s shape comes from its "area" footprint', fix: 'Write "area": {"center": [0, 0], "radius": r} for a round lake, {"center": [0, 0], "size": [w, d]} for a rectangle.' });
  }
  if (kind === 'lake' || kind === 'pool') {
    const area = fields['area'];
    if (area === undefined || area === null) {
      out.push({ pointer: '/area', message: `a ${kind} needs an "area" footprint`, fix: 'Add "area": {"center": [0, 0], "size": [40, 25]} or {"center": [0, 0], "radius": 15}.' });
    } else {
      const problem = footprintProblem(area);
      if (problem !== null) out.push(problem);
    }
  }
  if (kind === 'river') {
    const points = fields['points'];
    if (!Array.isArray(points) || points.length < 2) {
      out.push({ pointer: '/points', message: 'a river needs at least two points (its course, upstream first)', fix: 'Add "points": [[0, 0, 0], [0, -1, 40], [10, -2, 80]].' });
    }
  }
  const depth = fieldNumber(fields, 'depth');
  if (depth !== null && !(depth > 0)) out.push({ pointer: '/depth', message: `depth is ${depth}; it must be above 0`, fix: 'Give the meters down to the bed.' });
  const height = fieldNumber(fields, 'wave_height');
  if (height !== null && !(height >= 0)) out.push({ pointer: '/wave_height', message: `wave_height is ${height}; it can't be negative`, fix: 'Use 0 for still water.' });
  const length = fieldNumber(fields, 'wavelength');
  if (length !== null && !(length > 0.1)) out.push({ pointer: '/wavelength', message: `wavelength is ${length}; it must be above 0.1 m`, fix: 'Give the meters from crest to crest.' });
  const chop = fieldNumber(fields, 'choppiness');
  if (chop !== null && !(chop >= 0 && chop <= 1)) out.push({ pointer: '/choppiness', message: `choppiness is ${chop}; it must be 0 to 1`, fix: 'Use 0 for round swells, 1 for the sharpest crests.' });
  return out;
}

/** Deep and shallow colors by kind (sRGB). */
const COLORS: Record<WaterKind, { deep: [number, number, number]; shallow: [number, number, number] }> = {
  ocean: { deep: [0.02, 0.12, 0.2], shallow: [0.1, 0.45, 0.48] },
  lake: { deep: [0.03, 0.14, 0.16], shallow: [0.18, 0.4, 0.34] },
  pool: { deep: [0.05, 0.35, 0.55], shallow: [0.4, 0.8, 0.85] },
  river: { deep: [0.06, 0.16, 0.14], shallow: [0.3, 0.42, 0.32] },
};

/** A river's course, resampled finely: points (x, y, z world) with the distance along it. */
export interface Course {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly zs: Float64Array;
  /** Meters from the source to each point. */
  readonly along: Float64Array;
  readonly length: number;
}

/** Catmull-Rom through the points, 8 pieces per span. */
export function riverCourse(points: readonly Vec3[]): Course {
  const n = points.length;
  const at = (i: number): Vec3 => points[Math.min(n - 1, Math.max(0, i))]!;
  const xs: number[] = []; const ys: number[] = []; const zs: number[] = [];
  const pieces = 8;
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1); const p1 = at(i); const p2 = at(i + 1); const p3 = at(i + 2);
    for (let s = 0; s < pieces; s++) {
      const u = s / pieces;
      const u2 = u * u; const u3 = u2 * u;
      const f = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      xs.push(f(p0.x, p1.x, p2.x, p3.x));
      ys.push(f(p0.y, p1.y, p2.y, p3.y));
      zs.push(f(p0.z, p1.z, p2.z, p3.z));
    }
  }
  const last = at(n - 1);
  xs.push(last.x); ys.push(last.y); zs.push(last.z);
  const along = new Float64Array(xs.length);
  for (let i = 1; i < xs.length; i++) along[i] = along[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!);
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), zs: Float64Array.from(zs), along, length: along[along.length - 1]! };
}

/** Where a point is relative to a river: the closest place on its course. */
export interface RiverSpot {
  /** Meters from the center line (signed: + to the right looking downstream). */
  readonly across: number;
  readonly along: number;
  /** Surface height of the course there. */
  readonly y: number;
  /** Unit downstream direction (x, z). */
  readonly dirX: number;
  readonly dirZ: number;
}

export function riverSpot(course: Course, x: number, z: number): RiverSpot {
  let best = Infinity;
  let spot: RiverSpot = { across: Infinity, along: 0, y: course.ys[0]!, dirX: 0, dirZ: 1 };
  for (let i = 0; i + 1 < course.xs.length; i++) {
    const ax = course.xs[i]!; const az = course.zs[i]!;
    const ex = course.xs[i + 1]! - ax; const ez = course.zs[i + 1]! - az;
    const len2 = ex * ex + ez * ez;
    if (len2 === 0) continue;
    const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2));
    const px = ax + ex * u; const pz = az + ez * u;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best) {
      best = d2;
      const len = Math.sqrt(len2);
      const dirX = ex / len; const dirZ = ez / len;
      // Right of downstream (y-up, left-handed: +z forward, +x right): (dirZ, -dirX).
      const across = (x - px) * dirZ - (z - pz) * dirX;
      spot = {
        across, along: course.along[i]! + len * u, y: course.ys[i]! + (course.ys[i + 1]! - course.ys[i]!) * u, dirX, dirZ,
      };
    }
  }
  return spot;
}

/** One water body as the world has it now. */
export class Body {
  /** Null for the terrain's own water (its `water_level`). */
  readonly entity: EntityId | null;
  readonly kind: WaterKind;
  readonly level: number;
  readonly center: Vec3;
  readonly halfX: number;
  readonly halfZ: number;
  /** The entity's yaw, radians. */
  readonly yaw: number;
  readonly shape: 'rect' | 'ellipse';
  readonly depth: number;
  readonly density: number;
  /** The game's splash sound for this body, or null (silent). */
  readonly splashSound: string | null;
  readonly waveSpec: WaveSpec;
  readonly windWaves: boolean;
  readonly deep: [number, number, number];
  readonly shallow: [number, number, number];
  readonly clarity: number;
  readonly foam: number;
  readonly caustics: number;
  readonly ripple: number;
  readonly calmDistance: number;
  readonly course: Course | null;
  readonly width: number;
  readonly flow: number;
  #waves: { scale: number; set: WaveSet } | null = null;

  /** `fields` in runtime form (every schema key); `position` and `rotation` are the entity's world pose. */
  constructor(entity: EntityId | null, name: string, position: Vec3, rotation: Quat, fields: Readonly<Record<string, unknown>>) {
    const problems = waterBodyProblems(fields);
    if (problems.length > 0) {
      const p = problems[0]!;
      fail('PP3370', `${name} water_body: ${p.message}`, { fix: p.fix });
    }
    this.entity = entity;
    this.kind = fields['kind'] as WaterKind;
    this.splashSound = writtenRef(fields['splash_sound']);
    const forward = rotation.rotate(new Vec3(0, 0, 1));
    const entityYaw = Math.atan2(forward.x, forward.z);
    this.level = position.y;
    // lake/pool: the `area` footprint, in the entity's x and z (turned with its yaw).
    const area = this.kind === 'lake' || this.kind === 'pool' ? readArea(fields['area']) : null;
    if (area === null || 'pointer' in area || area.kind === 'polygon') {
      this.center = position;
      this.yaw = entityYaw;
      this.halfX = 0;
      this.halfZ = 0;
      this.shape = 'rect';
    } else {
      const local = rotation.rotate(new Vec3(area.x, 0, area.z));
      this.center = new Vec3(position.x + local.x, position.y, position.z + local.z);
      if (area.kind === 'circle') {
        this.yaw = entityYaw;
        this.halfX = area.radius;
        this.halfZ = area.radius;
        this.shape = 'ellipse';
      } else {
        // Footprint rotation is counter-clockwise seen from above; yaw turns clockwise.
        this.yaw = entityYaw - Math.atan2(area.sin, area.cos);
        this.halfX = area.hx;
        this.halfZ = area.hz;
        this.shape = 'rect';
      }
    }
    this.depth = (fields['depth'] as number | null) ?? DEPTHS[this.kind];
    this.density = fields['density'] as number;
    const preset = WAVE_PRESETS[((fields['waves'] as string | null) ?? DEFAULT_WAVES[this.kind]) as WavePreset];
    this.waveSpec = {
      height: (fields['wave_height'] as number | null) ?? preset.height,
      wavelength: (fields['wavelength'] as number | null) ?? preset.wavelength,
      direction: fields['wave_direction'] as number,
      spread: fields['wave_spread'] as number,
      choppiness: (fields['choppiness'] as number | null) ?? preset.choppiness,
      seed: fields['seed'] as number,
    };
    this.windWaves = fields['wind_waves'] === true && this.kind !== 'pool' && this.kind !== 'river';
    const color = fields['color'] as Color | null;
    const shallow = fields['shallow_color'] as Color | null;
    this.deep = color === null ? COLORS[this.kind].deep : [color.r, color.g, color.b];
    this.shallow = shallow === null ? COLORS[this.kind].shallow : [shallow.r, shallow.g, shallow.b];
    this.clarity = fields['clarity'] as number;
    this.foam = fields['foam'] as number;
    this.caustics = fields['caustics'] as number;
    this.ripple = fields['ripple'] as number;
    this.calmDistance = fields['calm_distance'] as number;
    this.width = fields['width'] as number;
    this.flow = fields['flow'] as number;
    if (this.kind === 'river') {
      const points = (fields['points'] as Vec3[]).map((p) => position.__add__(rotation.rotate(p)));
      this.course = riverCourse(points);
    } else {
      this.course = null;
    }
  }

  /** The wave set at a wind scale (cached while the scale holds). */
  waves(scale: number): WaveSet {
    const s = this.windWaves ? scale : 1;
    if (this.#waves === null || this.#waves.scale !== s) this.#waves = { scale: s, set: buildWaves(this.waveSpec, s) };
    return this.#waves.set;
  }

  /** Whether (x, z) is over this body; rivers also give where on the course. */
  covers(x: number, z: number): boolean {
    if (this.kind === 'ocean') return true;
    if (this.course !== null) return Math.abs(riverSpot(this.course, x, z).across) <= this.width / 2;
    const dx = x - this.center.x;
    const dz = z - this.center.z;
    const c = Math.cos(this.yaw); const s = Math.sin(this.yaw);
    // Into the body's frame: its +x is (cos, -sin), its +z (sin, cos) on the ground.
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (this.shape === 'ellipse') return (lx * lx) / (this.halfX * this.halfX) + (lz * lz) / (this.halfZ * this.halfZ) <= 1;
    return Math.abs(lx) <= this.halfX && Math.abs(lz) <= this.halfZ;
  }

  /** Still-water level at (x, z): the entity's height, or the river course's there. */
  levelAt(x: number, z: number): number {
    return this.course === null ? this.level : riverSpot(this.course, x, z).y;
  }

  /** Surface height at (x, z) and time t, waves included (assumes `covers`). */
  surfaceAt(x: number, z: number, t: number, windScale: number): number {
    return this.levelAt(x, z) + waveHeight(this.waves(windScale), x, z, t);
  }

  /** The water's own velocity at (x, z): downstream in a river (parabolic across), still elsewhere. */
  flowAt(x: number, z: number): Vec3 {
    if (this.course === null || this.flow === 0) return Vec3.ZERO;
    const spot = riverSpot(this.course, x, z);
    const s = (2 * spot.across) / this.width;
    const speed = this.flow * 1.5 * Math.max(0, 1 - s * s);
    return new Vec3(spot.dirX * speed, 0, spot.dirZ * speed);
  }
}
