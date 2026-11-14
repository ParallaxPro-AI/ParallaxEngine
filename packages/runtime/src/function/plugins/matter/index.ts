/**
 * matter — physical stuff that cuts, heats, melts, boils and pours (sdk/parallax/matter.pyi):
 *
 *   Sliceable   a soft solid (a wax block, a clay rod, a gel slab, a foam brick) drawn from a
 *               shape, with a soft layer that sags, squashes and wobbles (soft.ts) on top of
 *               the rigid body physics3d moves. `slice(point, normal)` cuts it along a plane
 *               into two closed pieces with real cut faces (mesh.ts): the entity keeps one,
 *               a copy of it (same prefab, same component values) gets the other. Vertex
 *               colours carry scorching (`stain`), what was painted on (`paint`: dirt,
 *               soot) and a cut face's rim-to-middle gradient (a block heated on one side, cut open).
 *   Thermal     heat in a body: a surface and a core node (heat.ts), exchanging with the
 *               air, touching Thermal bodies (physics contacts), HeatSources and liquids;
 *               water in the surface boils off; a melt point melts and sets.
 *   HeatSource  a hot plate or heating element (heats the lowest Thermal body in its zone), a
 *               furnace (a thermostatted air volume) or volumetric heating (power into what is
 *               inside, as induction or dielectric heating deposits it).
 *   Liquid      liquid in a container (liquid.ts): volume, fill height, a level surface
 *               that sloshes, swirls when stirred, bubbles when it boils and spills over
 *               the lowest point of the rim into whatever is below; its own temperature,
 *               exchanging with the container and with what is submerged in it.
 *
 * Everything runs in the kernel's 'physics' hook, once per fixed step, after physics3d
 * (list it first). Heat runs `time_scale` times faster than the clock (a game's
 * accelerated time); motion never does. Surfaces reach renderers through the `matter_meshes` deformable
 * source (services/deformables.ts): sliceables in their entity's frame (drawn at its
 * interpolated pose), liquids in world space.
 */

import { bindArgs, Color, fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, Geometry3d, Rgba } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { compose } from '../../../resource/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, Fields, Kernel, KernelPlugin, Schema } from '../../kernel/index.js';
import { MATTER_MESHES, PHYSICS3D_SERVICE, RENDER_POSE_SERVICE } from '../../services/index.js';
import type { GeneratedMaterial, GeneratedMesh, GeneratedPart } from '../../services/index.js';
import { boxMetrics, capacities, exchange, fromSource, internalConductance, settle, WATER_LATENT } from './heat.js';
import { capacityLiters, heightOf, LiquidSim, radiusAt, smoothNormals } from './liquid.js';
import type { Pose, Vessel } from './liquid.js';
import { buildSolid, copyMesh, meshBounds, meshVolume, recenter, rotateMesh, slice, SOLID_SHAPES } from './mesh.js';
import type { SolidMesh, SolidShape } from './mesh.js';
import { SoftLayer } from './soft.js';

export { buildSolid, meshVolume, slice } from './mesh.js';
export { exchange, settle } from './heat.js';
export { heightOf, volumeAt } from './liquid.js';
export { SoftLayer } from './soft.js';

export const SLICEABLE = 'sliceable';
export const THERMAL = 'thermal';
export const HEAT_SOURCE = 'heat_source';
export const LIQUID = 'liquid';

const COLLIDER = 'collider';
const RIGIDBODY = 'rigidbody';

const optionalNumber = { type: { kind: 'optional', of: { kind: 'number' } }, default: null } as const;

export const SLICEABLE_SCHEMA: Schema = {
  shape: t.enum(SOLID_SHAPES, { default: 'box' }),
  size: t.vec3({ default: new Vec3(0.1, 0.1, 0.1) }),
  round: t.number({ default: 0.01, min: 0 }),
  taper: t.number({ default: 1, min: 0.05, max: 4 }),
  bump: t.number({ default: 0, min: 0, max: 0.3 }),
  segments: t.int({ default: 8, min: 2, max: 16 }),
  seed: t.int({ default: 0 }),
  color: t.color({ default: new Color(0.8, 0.3, 0.3, 1) }),
  color_variation: t.number({ default: 0.12, min: 0, max: 1 }),
  inner_color: t.color({ default: new Color(0.9, 0.5, 0.5, 1) }),
  inner_edge_color: t.color({ default: new Color(0.9, 0.5, 0.5, 1) }),
  inner_edge: t.number({ default: 0, min: 0, max: 1 }),
  pattern_color: t.color({ default: new Color(1, 1, 1, 1) }),
  pattern: t.number({ default: 0, min: 0, max: 1 }),
  stain_color: t.color({ default: new Color(0.55, 0.3, 0.12, 1) }),
  char_color: t.color({ default: new Color(0.08, 0.06, 0.05, 1) }),
  roughness: t.number({ default: 0.6, min: 0, max: 1 }),
  softness: t.number({ default: 0.2, min: 0, max: 1 }),
  damping: t.number({ default: 3, min: 0 }),
  density: t.number({ default: 1000, min: 0 }),
  fit_collider: t.bool({ default: true }),
  min_piece: t.number({ default: 2e-6, min: 0 }),
  cast_shadows: t.bool({ default: true }),
};

export const THERMAL_SCHEMA: Schema = {
  temperature: t.number({ default: 20 }),
  core: t.number({ default: 20 }),
  mass: t.number({ default: 0, min: 0 }),
  specific_heat: t.number({ default: 3500, min: 1 }),
  conductivity: t.number({ default: 0.5, min: 0 }),
  surface_share: t.number({ default: 0.25, min: 0.05, max: 0.95 }),
  contact: t.number({ default: 300, min: 0 }),
  air: t.number({ default: 10, min: 0 }),
  moisture: t.number({ default: 0, min: 0, max: 1 }),
  melt_point: optionalNumber,
  latent_heat: t.number({ default: 0, min: 0 }),
  melted: t.number({ default: 0, min: 0, max: 1 }),
};

export const HEAT_SOURCE_SCHEMA: Schema = {
  kind: t.enum(['surface', 'air', 'volumetric'], { default: 'surface' }),
  temperature: t.number({ default: 600 }),
  power: t.number({ default: 2000, min: 0 }),
  level: t.number({ default: 0, min: 0, max: 1 }),
  conductance: t.number({ default: 10, min: 0 }),
  coefficient: t.number({ default: 25, min: 0 }),
  zone: t.vec3({ default: new Vec3(0.25, 0.08, 0.25) }),
  zone_offset: t.vec3({ default: new Vec3(0, 0.04, 0) }),
  air_temperature: t.number({ default: 20 }),
};

export const LIQUID_SCHEMA: Schema = {
  volume: t.number({ default: 0, min: 0 }),
  radius: t.number({ default: 0.1, min: 0.005 }),
  top_radius: t.number({ default: 0, min: 0 }),
  depth: t.number({ default: 0.15, min: 0.002 }),
  floor: t.number({ default: 0.005 }),
  kind: t.string({ default: 'water' }),
  color: t.color({ default: new Color(0.55, 0.68, 0.78, 0.55) }),
  temperature: t.number({ default: 20 }),
  boil_point: t.number({ default: 100 }),
  specific_heat: t.number({ default: 4186, min: 1 }),
  density: t.number({ default: 1, min: 0.01 }),
  viscosity: t.number({ default: 0, min: 0, max: 1 }),
  coefficient: t.number({ default: 600, min: 0 }),
  wall: t.number({ default: 800, min: 0 }),
  swirl: t.number({ default: 0 }),
  spilled: t.number({ default: 0, min: 0 }),
};

// ── Small math ───────────────────────────────────────────────────────────────

type V3 = [number, number, number];

function mat3(q: Quat): number[] {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
}
const mul = (R: readonly number[], v: readonly number[]): V3 => [
  R[0]! * v[0]! + R[3]! * v[1]! + R[6]! * v[2]!,
  R[1]! * v[0]! + R[4]! * v[1]! + R[7]! * v[2]!,
  R[2]! * v[0]! + R[5]! * v[1]! + R[8]! * v[2]!,
];
const mulT = (R: readonly number[], v: readonly number[]): V3 => [
  R[0]! * v[0]! + R[1]! * v[1]! + R[2]! * v[2]!,
  R[3]! * v[0]! + R[4]! * v[1]! + R[5]! * v[2]!,
  R[6]! * v[0]! + R[7]! * v[1]! + R[8]! * v[2]!,
];
const v3 = (v: Vec3): V3 => [v.x, v.y, v.z];

/** The shortest rotation taking unit a to unit b. */
function between(a: V3, b: V3): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 1 - 1e-9) return Quat.IDENTITY;
  if (d < -1 + 1e-9) {
    const axis: V3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[1], a[0], 0];
    const l = Math.hypot(...axis);
    return new Quat(axis[0] / l, axis[1] / l, axis[2] / l, 0);
  }
  const c: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const w = 1 + d;
  const l = Math.hypot(c[0], c[1], c[2], w);
  return new Quat(c[0] / l, c[1] / l, c[2] / l, w / l);
}

function rgbaOf(value: unknown): Rgba {
  const c = value as { r: number; g: number; b: number; a: number };
  return [c.r, c.g, c.b, c.a];
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  return typeof value === 'object' ? (value.constructor?.name ?? 'object') : JSON.stringify(value);
}

function vec3Arg(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3 && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) return value;
  return fail('PP3491', `${where} must be a finite Vec3, got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

function numberArg(value: unknown, where: string, min = -Infinity): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min) return value;
  return fail('PP3491', `${where} must be a number${min > -Infinity ? ` of at least ${min}` : ''}, got ${describe(value)}`);
}

function colorArg(value: unknown, where: string): Rgba {
  if (value instanceof Color) return [value.r, value.g, value.b, value.a];
  return fail('PP3491', `${where} must be a Color, got ${describe(value)}`, { fix: 'Pass Color.hex("#6b3a1e") or Color(r, g, b).' });
}

// ── Per-entity state ─────────────────────────────────────────────────────────

type MutableGeometry = { -readonly [K in keyof Geometry3d]: Geometry3d[K] };

interface Solid {
  key: string;
  mesh: SolidMesh;
  soft: SoftLayer;
  geometry: MutableGeometry;
  /** Bumped when the mesh is replaced (a cut). */
  built: number;
  colorKey: string;
  colorsDirty: boolean;
  /** World position and velocity at the last step (the frame's acceleration). */
  lastPos: V3 | null;
  lastVel: V3 | null;
  /** The mesh differs from what its fields build (it was cut): saved in snapshots. */
  cut: boolean;
  cuts: number;
  /** The rest mesh's volume (m³) and bounds, kept with the mesh (it only changes on a cut). */
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
}

interface Wet {
  sim: LiquidSim;
  boiling: number;
  nearBoil: number;
  pouring: number;
  /** World y of the surface's middle, at the last step. */
  level: number;
}

const solidKey = (f: Fields): string => {
  const s = f['size'] as Vec3;
  return [f['shape'], s.x, s.y, s.z, f['round'], f['taper'], f['bump'], f['segments'], f['seed']].join(',');
};

const vesselOf = (f: Fields): Vessel => ({
  radius: f['radius'] as number,
  topRadius: f['top_radius'] as number,
  depth: f['depth'] as number,
  floor: f['floor'] as number,
});

export interface MatterOptions {
  /** Air temperature, °C. */
  readonly ambient?: number;
  /** Heat runs this many times faster than the clock. */
  readonly timeScale?: number;
}

export interface MatterPlugin extends KernelPlugin {
  /** The solid behind an entity's Sliceable (tests, tools). */
  solidOf(entity: EntityId): SolidMesh | undefined;
}

export function matter(options: MatterOptions = {}): MatterPlugin {
  let installed: Kernel | undefined;
  let ambient = options.ambient ?? 21;
  let timeScale = options.timeScale ?? 1;
  const solids = new Map<EntityId, Solid>();
  const wets = new Map<EntityId, Wet>();
  const heating = new Map<EntityId, number>();
  const evaporating = new Map<EntityId, number>();
  const pendingVelocity = new Map<EntityId, Vec3>();
  let revision = 0;
  let builds = 0;
  const kernelOf = (): Kernel => {
    if (installed === undefined) fail('PP9240', 'matter is used before its kernel was built');
    return installed;
  };
  const gravity = (kernel: Kernel): number => kernel.tryService(PHYSICS3D_SERVICE)?.gravity ?? -9.8;

  // ── Sliceable ───────────────────────────────────────────────────────────────

  const geometryFor = (id: EntityId, mesh: SolidMesh): MutableGeometry => {
    const nv = mesh.vp.length;
    return {
      id: `matter:${id}:${++builds}`,
      positions: new Float32Array(nv * 3),
      normals: new Float32Array(nv * 3),
      uvs: new Float32Array(nv * 2),
      indices: nv <= 0xffff ? Uint16Array.from(mesh.tris) : Uint32Array.from(mesh.tris),
      joints: null,
      weights: null,
      colors: new Float32Array(nv * 4),
      min: [0, 0, 0],
      max: [0, 0, 0],
      version: 0,
    };
  };

  const writePositions = (s: Solid): void => {
    const g = s.geometry;
    const x = s.soft.p.x;
    const vp = s.mesh.vp;
    for (let v = 0; v < vp.length; v++) {
      const p = vp[v]! * 3;
      g.positions[v * 3] = x[p]!;
      g.positions[v * 3 + 1] = x[p + 1]!;
      g.positions[v * 3 + 2] = x[p + 2]!;
    }
    smoothNormals(g.positions, g.indices, g.normals);
    const [min, max] = meshBounds(x);
    g.min = min;
    g.max = max;
    g.version = (g.version ?? 0) + 1;
  };

  const colorKeyOf = (f: Fields): string => [
    'color', 'color_variation', 'inner_color', 'inner_edge_color', 'inner_edge', 'pattern_color', 'pattern', 'stain_color', 'char_color',
  ].map((k) => {
    const v = f[k];
    return v instanceof Color ? `${v.r},${v.g},${v.b},${v.a}` : String(v);
  }).join('|');

  const writeColors = (s: Solid, f: Fields): void => {
    const c = s.geometry.colors!;
    const m = s.mesh;
    const base = rgbaOf(f['color']);
    const variation = f['color_variation'] as number;
    const inner = rgbaOf(f['inner_color']);
    const edge = rgbaOf(f['inner_edge_color']);
    const edgeShare = f['inner_edge'] as number;
    const pat = rgbaOf(f['pattern_color']);
    const patShare = f['pattern'] as number;
    const stain = rgbaOf(f['stain_color']);
    const char = rgbaOf(f['char_color']);
    for (let v = 0; v < m.vp.length; v++) {
      const cap = m.cap[v]!;
      const mot = m.mottle[v]!;
      let r: number;
      let g: number;
      let b: number;
      if (cap < 0) {
        const k = 1 + (mot - 0.5) * 2 * variation;
        r = base[0] * k;
        g = base[1] * k;
        b = base[2] * k;
      } else {
        // Rim → middle: the edge band, then the inner colour, with a pattern (grain, inclusions).
        const e = edgeShare > 0 ? Math.min(1, Math.max(0, (cap - (1 - edgeShare)) / Math.max(1e-3, edgeShare))) : 0;
        const k = 1 + (mot - 0.5) * variation;
        r = (inner[0] + (edge[0] - inner[0]) * e) * k;
        g = (inner[1] + (edge[1] - inner[1]) * e) * k;
        b = (inner[2] + (edge[2] - inner[2]) * e) * k;
        if (patShare > 0 && mot < patShare && cap < 0.97) {
          r = pat[0];
          g = pat[1];
          b = pat[2];
        }
      }
      // Paint (dirt, soot, pigment) over it.
      const pw = m.paint[v * 4 + 3]!;
      if (pw > 0) {
        r += (m.paint[v * 4]! - r) * pw;
        g += (m.paint[v * 4 + 1]! - g) * pw;
        b += (m.paint[v * 4 + 2]! - b) * pw;
      }
      // Scorching: base → stain over 0..0.7, stain → char over 0.7..1.
      const w = m.stain[v]!;
      if (w > 0) {
        if (w <= 0.7) {
          const a = w / 0.7;
          r += (stain[0] - r) * a;
          g += (stain[1] - g) * a;
          b += (stain[2] - b) * a;
        } else {
          const a = (w - 0.7) / 0.3;
          r = stain[0] + (char[0] - stain[0]) * a;
          g = stain[1] + (char[1] - stain[1]) * a;
          b = stain[2] + (char[2] - stain[2]) * a;
        }
      }
      c[v * 4] = Math.max(0, Math.min(1, r));
      c[v * 4 + 1] = Math.max(0, Math.min(1, g));
      c[v * 4 + 2] = Math.max(0, Math.min(1, b));
      c[v * 4 + 3] = cap < 0 ? base[3] : inner[3];
    }
    s.colorsDirty = false;
    s.geometry.version = (s.geometry.version ?? 0) + 1;
  };

  const setSolid = (kernel: Kernel, record: EntityRecord, mesh: SolidMesh, key: string, cut: boolean, cuts: number): Solid => {
    const fields = record.components.get(SLICEABLE)!;
    const soft = new SoftLayer(mesh);
    const [min, max] = meshBounds(mesh.rest);
    const solid: Solid = {
      key, mesh, soft, geometry: geometryFor(record.id, mesh), built: ++builds, colorKey: colorKeyOf(fields),
      colorsDirty: true, lastPos: null, lastVel: null, cut, cuts,
      volume: Math.max(1e-12, meshVolume(mesh.rest, mesh.vp, mesh.tris)), min, max,
    };
    solids.set(record.id, solid);
    writePositions(solid);
    writeColors(solid, fields);
    fitBody(kernel, record, solid, cut);
    revision++;
    return solid;
  };

  /** Mass from the volume; after a cut, the collider box fitted to the piece. */
  const fitBody = (kernel: Kernel, record: EntityRecord, solid: Solid, fit: boolean): void => {
    const fields = record.components.get(SLICEABLE)!;
    const density = fields['density'] as number;
    const volume = solid.volume;
    if (density > 0 && record.components.has(RIGIDBODY)) {
      kernel.mergeComponent(record.id, RIGIDBODY, { mass: Math.max(0.001, volume * density) });
    }
    if (fit && fields['fit_collider'] === true && record.components.has(COLLIDER)) {
      const { min, max } = solid;
      const scale = record.transform.worldScale();
      kernel.mergeComponent(record.id, COLLIDER, {
        shape: 'box',
        size: new Vec3(Math.max(0.002, (max[0] - min[0]) / scale.x), Math.max(0.002, (max[1] - min[1]) / scale.y), Math.max(0.002, (max[2] - min[2]) / scale.z)),
        offset: new Vec3((max[0] + min[0]) / 2 / scale.x, (max[1] + min[1]) / 2 / scale.y, (max[2] + min[2]) / 2 / scale.z),
      });
    }
  };

  const ensureSolid = (kernel: Kernel, record: EntityRecord): Solid | undefined => {
    const fields = record.components.get(SLICEABLE);
    if (fields === undefined) {
      if (solids.delete(record.id)) revision++;
      return undefined;
    }
    const key = solidKey(fields);
    const existing = solids.get(record.id);
    if (existing !== undefined && existing.key === key) return existing;
    const s = fields['size'] as Vec3;
    const mesh = buildSolid({
      shape: fields['shape'] as SolidShape,
      size: [s.x, s.y, s.z],
      round: fields['round'] as number,
      taper: fields['taper'] as number,
      bump: fields['bump'] as number,
      segments: fields['segments'] as number,
      seed: fields['seed'] as number,
    });
    return setSolid(kernel, record, mesh, key, false, 0);
  };

  const stepSolids = (kernel: Kernel, dt: number): void => {
    const g = gravity(kernel);
    for (const [id] of kernel.world.query([SLICEABLE])) {
      const record = kernel.world.get(id)!;
      const solid = ensureSolid(kernel, record)!;
      const fields = record.components.get(SLICEABLE)!;
      const t = record.transform;
      const pos = v3(t.worldPosition());
      const R = mat3(t.worldRotation());
      let acc: V3 = [0, 0, 0];
      if (solid.lastPos !== null) {
        const vel: V3 = [(pos[0] - solid.lastPos[0]) / dt, (pos[1] - solid.lastPos[1]) / dt, (pos[2] - solid.lastPos[2]) / dt];
        if (solid.lastVel !== null) acc = [(vel[0] - solid.lastVel[0]) / dt, (vel[1] - solid.lastVel[1]) / dt, (vel[2] - solid.lastVel[2]) / dt];
        solid.lastVel = vel;
      }
      solid.lastPos = pos;
      // A teleport (picked up, snapped into place) is not an acceleration to wobble from.
      const lim = 60;
      const am = Math.hypot(...acc);
      if (am > lim * 4) acc = [0, 0, 0];
      else if (am > lim) acc = [acc[0] * lim / am, acc[1] * lim / am, acc[2] * lim / am];
      const force = mulT(R, [-acc[0], g - acc[1], -acc[2]]);
      const down = mulT(R, [0, -1, 0]);
      const moved = solid.soft.step(dt, force, down, { softness: fields['softness'] as number, damping: fields['damping'] as number });
      if (moved) writePositions(solid);
      const ck = colorKeyOf(fields);
      if (solid.colorsDirty || ck !== solid.colorKey) {
        solid.colorKey = ck;
        writeColors(solid, fields);
      }
    }
  };

  const solidOfFields = (fields: Fields, what: string): { solid: Solid; record: EntityRecord; kernel: Kernel } => {
    const kernel = kernelOf();
    const id = componentEntity(fields);
    const record = kernel.world.get(id);
    if (record === undefined || !record.alive) fail('PP3002', `${what} on an entity that no longer exists`);
    return { solid: ensureSolid(kernel, record)!, record, kernel };
  };

  /** Split the record's solid by a world plane; the record keeps the back, a copy gets the front. */
  const cut = (kernel: Kernel, record: EntityRecord, solid: Solid, point: Vec3, normal: Vec3): EntityId | null => {
    const nl = normal.length();
    if (nl < 1e-9) fail('PP3491', 'Sliceable.slice() normal must not be zero', { fix: 'Pass the cut plane\'s normal, e.g. the blade\'s side direction.' });
    const fields = record.components.get(SLICEABLE)!;
    const t = record.transform;
    const pos = v3(t.worldPosition());
    const rot = t.worldRotation();
    const R = mat3(rot);
    const n = mulT(R, [normal.x / nl, normal.y / nl, normal.z / nl]);
    const pl = mulT(R, [point.x - pos[0], point.y - pos[1], point.z - pos[2]]);
    const d = n[0] * pl[0] + n[1] * pl[1] + n[2] * pl[2];
    const result = slice(solid.mesh, n, d, fields['min_piece'] as number);
    if (result === null) return null;
    if (record.prefab === undefined) {
      fail('PP3492', `Sliceable.slice(): entity ${record.placedId ?? record.id} was not spawned from a prefab, so the cut-off piece has nothing to copy`, {
        fix: 'Spawn sliceable things from a prefab (ctx.world.spawn(Prefabs.wax_block)) or place them from one in the scene.',
      });
    }
    // Each piece: recentred on its own volume, its frame turned so local +x is the cut
    // normal (a slab's collider box is then tight).
    const place = (mesh: SolidMesh, side: 1 | -1): { mesh: SolidMesh; position: Vec3; rotation: Quat } => {
      const { offset } = recenter(mesh);
      const axis: V3 = side > 0 ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
      const flip = axis[0] < 0 ? -1 : 1;
      const q = between([1, 0, 0], [axis[0] * flip, axis[1] * flip, axis[2] * flip]);
      const M = mat3(q);
      // Particles into the new frame: p' = Mᵀ p.
      rotateMesh(mesh, [M[0]!, M[3]!, M[6]!, M[1]!, M[4]!, M[7]!, M[2]!, M[5]!, M[8]!]);
      const w = mul(R, offset);
      return { mesh, position: new Vec3(pos[0] + w[0], pos[1] + w[1], pos[2] + w[2]), rotation: rot.__mul__(q) };
    };
    const back = place(result.back, -1);
    const front = place(result.front, 1);
    const physics = kernel.tryService(PHYSICS3D_SERVICE);
    const velocity = physics?.body(record.id)?.velocity ?? Vec3.ZERO;
    // The copy: the same prefab with every component's current values and the same tags.
    const components: Record<string, Fields> = {};
    for (const [cid, f] of record.components) {
      const copy: Fields = {};
      for (const [k, v] of Object.entries(f)) copy[k] = Array.isArray(v) ? [...v] : v;
      components[cid] = copy;
    }
    const twin = kernel.spawn(record.prefab, { tags: [...record.tags] }, {
      components,
      ...(record.parent !== null && { parent: record.parent }),
    });
    for (const [cid, f] of Object.entries(components)) if (!twin.components.has(cid)) kernel.addComponent(twin.id, cid, f);
    const key = solidKey(fields);
    record.transform.setWorldPosition(back.position);
    record.transform.rotation = record.transform.parent === null ? back.rotation : record.transform.parent.worldRotation().inverse().__mul__(back.rotation);
    twin.transform.setWorldPosition(front.position);
    twin.transform.rotation = twin.transform.parent === null ? front.rotation : twin.transform.parent.worldRotation().inverse().__mul__(front.rotation);
    setSolid(kernel, record, back.mesh, key, true, solid.cuts + 1);
    setSolid(kernel, twin, front.mesh, key, true, solid.cuts + 1);
    // The blade parts them a little.
    const nw = new Vec3(normal.x / nl, normal.y / nl, normal.z / nl);
    pendingVelocity.set(record.id, velocity.__sub__(nw.__mul__(0.12)));
    pendingVelocity.set(twin.id, velocity.__add__(nw.__mul__(0.12)));
    return twin.id;
  };

  const vertexWorld = (s: Solid, record: EntityRecord): { pos: (v: number) => V3; nrm: (v: number) => V3 } => {
    const t = record.transform;
    const p = v3(t.worldPosition());
    const R = mat3(t.worldRotation());
    const g = s.geometry;
    return {
      pos: (v) => {
        const w = mul(R, [g.positions[v * 3]!, g.positions[v * 3 + 1]!, g.positions[v * 3 + 2]!]);
        return [w[0] + p[0], w[1] + p[1], w[2] + p[2]];
      },
      nrm: (v) => mul(R, [g.normals[v * 3]!, g.normals[v * 3 + 1]!, g.normals[v * 3 + 2]!]),
    };
  };

  /** Per-vertex weight 0..1 of a brush: near `at` (fading to `radius`) and facing `facing` (cosine past 0.2). */
  const brush = (s: Solid, record: EntityRecord, at: Vec3 | null, radius: number, facing: Vec3 | null): (v: number) => number => {
    const w = vertexWorld(s, record);
    const f = facing === null ? null : facing.length() > 0 ? facing.normalized() : null;
    return (v) => {
      let k = 1;
      if (at !== null) {
        const p = w.pos(v);
        const dd = Math.hypot(p[0] - at.x, p[1] - at.y, p[2] - at.z);
        if (dd >= radius) return 0;
        k *= 1 - dd / radius;
      }
      if (f !== null) {
        const nn = w.nrm(v);
        const c = nn[0] * f.x + nn[1] * f.y + nn[2] * f.z;
        if (c <= 0.2) return 0;
        k *= Math.min(1, (c - 0.2) / 0.6);
      }
      return k;
    };
  };

  const optVec = (value: unknown, where: string): Vec3 | null => (value === undefined || value === null ? null : vec3Arg(value, where));

  const sliceableMethods = {
    /** slice(point, normal) → the cut-off piece (an Entity) or None when the plane misses or leaves a sliver. */
    slice(this: Fields, ...args: unknown[]): unknown {
      const a = bindArgs('Sliceable.slice', args, { positional: ['point', 'normal'], keyword: [], required: ['point', 'normal'] }).args;
      const point = vec3Arg(a['point'], 'Sliceable.slice() point');
      const normal = vec3Arg(a['normal'], 'Sliceable.slice() normal');
      const { solid, record, kernel } = solidOfFields(this, 'Sliceable.slice()');
      const twin = cut(kernel, record, solid, point, normal);
      return twin === null ? null : kernel.handles.wrap(twin);
    },
    /** push(velocity, *, at=None, radius=0.05): dent or shove the soft layer (m/s change). */
    push(this: Fields, ...args: unknown[]): void {
      const a = bindArgs('Sliceable.push', args, { positional: ['velocity'], keyword: ['at', 'radius'], required: ['velocity'] }).args;
      const velocity = vec3Arg(a['velocity'], 'Sliceable.push() velocity');
      const at = optVec(a['at'], 'Sliceable.push() at');
      const radius = numberArg(a['radius'] ?? 0.05, 'Sliceable.push() radius', 0);
      const { solid, record } = solidOfFields(this, 'Sliceable.push()');
      const t = record.transform;
      const R = mat3(t.worldRotation());
      const p = v3(t.worldPosition());
      const lat = at === null ? null : mulT(R, [at.x - p[0], at.y - p[1], at.z - p[2]]);
      solid.soft.push(lat, mulT(R, v3(velocity)), at === null ? 0 : radius);
    },
    /** stain(amount, *, facing=None, at=None, radius=0.05): darken toward stain_color then char_color. */
    stain(this: Fields, ...args: unknown[]): void {
      const a = bindArgs('Sliceable.stain', args, { positional: ['amount'], keyword: ['facing', 'at', 'radius'], required: ['amount'] }).args;
      const amount = numberArg(a['amount'], 'Sliceable.stain() amount');
      const { solid, record } = solidOfFields(this, 'Sliceable.stain()');
      const k = brush(solid, record, optVec(a['at'], 'Sliceable.stain() at'), numberArg(a['radius'] ?? 0.05, 'Sliceable.stain() radius', 0), optVec(a['facing'], 'Sliceable.stain() facing'));
      const st = solid.mesh.stain;
      for (let v = 0; v < st.length; v++) {
        const w = k(v);
        if (w > 0) st[v] = Math.max(0, Math.min(1, st[v]! + amount * w));
      }
      solid.colorsDirty = true;
    },
    /** paint(color, amount, *, coverage=1, facing=None, at=None, radius=0.05): blend a colour on (dirt, soot, pigment). */
    paint(this: Fields, ...args: unknown[]): void {
      const a = bindArgs('Sliceable.paint', args, { positional: ['color', 'amount'], keyword: ['coverage', 'facing', 'at', 'radius'], required: ['color', 'amount'] }).args;
      const color = colorArg(a['color'], 'Sliceable.paint() color');
      const amount = numberArg(a['amount'], 'Sliceable.paint() amount', 0);
      const coverage = numberArg(a['coverage'] ?? 1, 'Sliceable.paint() coverage', 0);
      const { solid, record } = solidOfFields(this, 'Sliceable.paint()');
      const k = brush(solid, record, optVec(a['at'], 'Sliceable.paint() at'), numberArg(a['radius'] ?? 0.05, 'Sliceable.paint() radius', 0), optVec(a['facing'], 'Sliceable.paint() facing'));
      const m = solid.mesh;
      for (let v = 0; v < m.vp.length; v++) {
        // Coverage picks a fixed share of the vertices (specks), by their mottle.
        if (coverage < 1 && ((m.mottle[v]! * 7.31) % 1) >= coverage) continue;
        const w = k(v) * Math.min(1, amount);
        if (w <= 0) continue;
        const old = m.paint[v * 4 + 3]!;
        const nw = Math.min(1, old + w * (1 - old));
        const share = nw > 0 ? (nw - old) / nw : 0;
        for (let c = 0; c < 3; c++) m.paint[v * 4 + c] = m.paint[v * 4 + c]! + (color[c]! - m.paint[v * 4 + c]!) * (old > 0 ? share : 1);
        m.paint[v * 4 + 3] = nw;
      }
      solid.colorsDirty = true;
    },
    /** clean(amount): wash paint off (each weight falls by `amount`, 0..1). */
    clean(this: Fields, ...args: unknown[]): void {
      const a = bindArgs('Sliceable.clean', args, { positional: ['amount'], keyword: [], required: ['amount'] }).args;
      const amount = numberArg(a['amount'], 'Sliceable.clean() amount', 0);
      const { solid } = solidOfFields(this, 'Sliceable.clean()');
      const p = solid.mesh.paint;
      for (let v = 3; v < p.length; v += 4) p[v] = Math.max(0, p[v]! - amount);
      solid.colorsDirty = true;
    },
    /** stain_level(facing=None): mean stain (0..1) of the vertices (facing a world direction, if given). */
    stain_level(this: Fields, ...args: unknown[]): number {
      const a = bindArgs('Sliceable.stain_level', args, { positional: ['facing'], keyword: [], required: [] }).args;
      const facing = optVec(a['facing'], 'Sliceable.stain_level() facing');
      const { solid, record } = solidOfFields(this, 'Sliceable.stain_level()');
      const k = brush(solid, record, null, 0, facing);
      let sum = 0;
      let wsum = 0;
      for (let v = 0; v < solid.mesh.stain.length; v++) {
        const w = k(v);
        sum += solid.mesh.stain[v]! * w;
        wsum += w;
      }
      return wsum > 0 ? sum / wsum : 0;
    },
    /** stain_max: the darkest vertex's stain (0..1). */
    get stain_max(): number {
      const { solid } = solidOfFields(this as unknown as Fields, 'Sliceable.stain_max');
      let out = 0;
      for (const w of solid.mesh.stain) out = Math.max(out, w);
      return out;
    },
    /** paint_level: mean paint weight (0..1). */
    get paint_level(): number {
      const { solid } = solidOfFields(this as unknown as Fields, 'Sliceable.paint_level');
      const p = solid.mesh.paint;
      let sum = 0;
      for (let v = 3; v < p.length; v += 4) sum += p[v]!;
      return p.length > 0 ? sum / (p.length / 4) : 0;
    },
    /** volume: m³ of this piece. */
    get volume(): number {
      const { solid } = solidOfFields(this as unknown as Fields, 'Sliceable.volume');
      return solid.volume;
    },
    /** cuts: how many cuts made this piece. */
    get cuts(): number {
      return solidOfFields(this as unknown as Fields, 'Sliceable.cuts').solid.cuts;
    },
    /** cut_share: share (0..1) of this piece's surface that is cut face. */
    get cut_share(): number {
      const { solid } = solidOfFields(this as unknown as Fields, 'Sliceable.cut_share');
      const g = solid.geometry;
      let all = 0;
      let cutArea = 0;
      for (let k = 0; k < g.indices.length; k += 3) {
        const a = g.indices[k]!;
        const b = g.indices[k + 1]!;
        const c = g.indices[k + 2]!;
        const p = g.positions;
        const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
        const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
        const area = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
        all += area;
        if (solid.mesh.cap[a]! >= 0) cutArea += area;
      }
      return all > 0 ? cutArea / all : 0;
    },
    /** size_now: the piece's extents (m) in its own frame. */
    get extents(): Vec3 {
      const { solid } = solidOfFields(this as unknown as Fields, 'Sliceable.extents');
      return new Vec3(solid.max[0] - solid.min[0], solid.max[1] - solid.min[1], solid.max[2] - solid.min[2]);
    },
    /** deformation: m, the largest a particle is off its rest place (how much it wobbles now). */
    get deformation(): number {
      return solidOfFields(this as unknown as Fields, 'Sliceable.deformation').solid.soft.deformation();
    },
    /** reset(): back to the whole, unstained shape its fields describe. */
    reset(this: Fields): void {
      const { record } = solidOfFields(this, 'Sliceable.reset()');
      solids.delete(record.id);
      ensureSolid(kernelOf(), record);
    },
  };

  // ── Heat ────────────────────────────────────────────────────────────────────

  interface HeatBody {
    readonly id: EntityId;
    readonly fields: Fields;
    readonly mass: number;
    readonly cs: number;
    readonly cc: number;
    readonly area: number;
    readonly thickness: number;
    readonly half: number;
    readonly internal: number;
    qs: number;
    qc: number;
  }

  const heatBodies = (kernel: Kernel): Map<EntityId, HeatBody> => {
    const out = new Map<EntityId, HeatBody>();
    const physics = kernel.tryService(PHYSICS3D_SERVICE);
    for (const [id, fields] of rows(kernel, THERMAL)) {
      const record = kernel.world.get(id)!;
      let half: V3 = [0.03, 0.03, 0.03];
      let volume = 0;
      const solid = record.components.has(SLICEABLE) ? ensureSolid(kernel, record) : undefined;
      if (solid !== undefined) {
        half = [(solid.max[0] - solid.min[0]) / 2, (solid.max[1] - solid.min[1]) / 2, (solid.max[2] - solid.min[2]) / 2];
        volume = solid.volume;
      } else {
        const b = physics?.bounds(id);
        if (b !== undefined) half = [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z];
      }
      let mass = fields['mass'] as number;
      if (mass <= 0) {
        const bodyMass = physics?.body(id)?.mass ?? 0;
        if (bodyMass > 0) mass = bodyMass;
        else if (solid !== undefined && volume > 0) mass = volume * ((record.components.get(SLICEABLE)!['density'] as number) || 1000);
        else mass = 1;
      }
      const { area, thickness } = boxMetrics(half);
      const meltPoint = fields['melt_point'] as number | null;
      const body = { mass, specificHeat: fields['specific_heat'] as number, surfaceShare: fields['surface_share'] as number, internal: 0, meltPoint, latentHeat: fields['latent_heat'] as number };
      const [cs, cc] = capacities(body);
      out.set(id, {
        id, fields, mass, cs, cc, area, thickness, half: thickness / 2,
        internal: internalConductance(fields['conductivity'] as number, area, thickness),
        qs: 0, qc: 0,
      });
    }
    return out;
  };

  /** The point in `record`'s local frame (scale ignored). */
  /** World poses read this step (each entity's composed once per step). */
  const poseCache = new Map<EntityId, { o: V3; R: number[] }>();
  const framed = (record: EntityRecord): { o: V3; R: number[] } => {
    let f = poseCache.get(record.id);
    if (f === undefined) {
      const t = record.transform;
      f = { o: v3(t.worldPosition()), R: mat3(t.worldRotation()) };
      poseCache.set(record.id, f);
    }
    return f;
  };
  const toLocal = (record: EntityRecord, p: V3): V3 => {
    const { o, R } = framed(record);
    return mulT(R, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
  };

  const inZone = (source: EntityRecord, fields: Fields, p: V3): boolean => {
    const l = toLocal(source, p);
    const z = fields['zone'] as Vec3;
    const o = fields['zone_offset'] as Vec3;
    return Math.abs(l[0] - o.x) <= z.x / 2 && Math.abs(l[1] - o.y) <= z.y / 2 && Math.abs(l[2] - o.z) <= z.z / 2;
  };

  const stepHeat = (kernel: Kernel, dt: number): void => {
    const h = dt * timeScale;
    const bodies = heatBodies(kernel);
    const physics = kernel.tryService(PHYSICS3D_SERVICE);
    const posOf = (id: EntityId): V3 => framed(kernel.world.get(id)!).o;
    const airOf = new Map<EntityId, { t: number; g: number }>();

    // Sources.
    for (const [sid, sf] of rows(kernel, HEAT_SOURCE)) {
      const source = kernel.world.get(sid)!;
      const kind = sf['kind'] as string;
      const level = sf['level'] as number;
      const inside: HeatBody[] = [];
      for (const body of bodies.values()) if (body.id !== sid && inZone(source, sf, posOf(body.id))) inside.push(body);
      if (kind === 'surface') {
        if (level <= 0 || inside.length === 0) continue;
        // What sits on it: the lowest body in the zone.
        let low = inside[0]!;
        for (const b of inside) if (posOf(b.id)[1] < posOf(low.id)[1]) low = b;
        low.qs += fromSource(sf['temperature'] as number, low.fields['temperature'] as number, low.cs, (sf['conductance'] as number) * level, h, (sf['power'] as number) * level);
      } else if (kind === 'air') {
        // A thermostatted volume of air (≈ 4 kJ/K with the cavity walls), losing heat to the room.
        const cAir = 4000;
        let tAir = sf['air_temperature'] as number;
        const target = sf['temperature'] as number;
        const heat = level > 0 && tAir < target ? Math.min((sf['power'] as number) * level * h, (target - tAir) * cAir) : 0;
        tAir += heat / cAir;
        tAir -= exchange(tAir, ambient, cAir, Infinity, 6, h) / cAir;
        for (const b of inside) {
          const q = exchange(tAir, b.fields['temperature'] as number, cAir, b.cs, (sf['coefficient'] as number) * b.area, h);
          tAir -= q / cAir;
          b.qs += q;
          airOf.set(b.id, { t: tAir, g: 0 });
        }
        sf['air_temperature'] = tAir;
      } else if (kind === 'volumetric') {
        if (level <= 0) continue;
        const power = (sf['power'] as number) * level * h;
        const takers: { w: number; body?: HeatBody; liquid?: Fields }[] = [];
        for (const b of inside) takers.push({ w: b.mass * (0.25 + (b.fields['moisture'] as number)), body: b });
        for (const [lid, lf] of rows(kernel, LIQUID)) {
          if ((lf['volume'] as number) > 0 && inZone(source, sf, posOf(lid))) takers.push({ w: (lf['volume'] as number) * (lf['density'] as number), liquid: lf });
        }
        const total = takers.reduce((s, x) => s + x.w, 0);
        if (total <= 0) continue;
        for (const x of takers) {
          const e = (power * x.w) / total;
          if (x.body !== undefined) {
            x.body.qs += e * 0.35;
            x.body.qc += e * 0.65;
          } else if (x.liquid !== undefined) {
            const lf = x.liquid;
            lf['temperature'] = (lf['temperature'] as number) + e / ((lf['volume'] as number) * (lf['density'] as number) * (lf['specific_heat'] as number));
          }
        }
      }
    }

    // Air, outside any furnace.
    for (const b of bodies.values()) {
      if (airOf.has(b.id)) continue;
      b.qs += fromSource(ambient, b.fields['temperature'] as number, b.cs, (b.fields['air'] as number) * b.area, h, Infinity);
    }

    // Touching bodies.
    if (physics !== undefined) {
      for (const a of bodies.values()) {
        for (const c of physics.contacts(a.id)) {
          if (c.entity === undefined || c.entity <= a.id) continue;
          const b = bodies.get(c.entity);
          if (b === undefined) continue;
          const g = Math.min(a.fields['contact'] as number, b.fields['contact'] as number) * Math.min(a.area, b.area) / 3;
          const q = exchange(a.fields['temperature'] as number, b.fields['temperature'] as number, a.cs, b.cs, g, h);
          a.qs -= q;
          b.qs += q;
        }
      }
    }

    // Liquids: with their container, with what is in them; boiling.
    for (const [lid, lf] of rows(kernel, LIQUID)) {
      const volumeL = lf['volume'] as number;
      const wet = wets.get(lid);
      if (volumeL <= 1e-6) {
        if (wet !== undefined) {
          wet.boiling = 0;
          wet.nearBoil = 0;
        }
        continue;
      }
      const record = kernel.world.get(lid)!;
      const vessel = vesselOf(lf);
      const height = heightOf(vessel, volumeL / 1000);
      const r = radiusAt(vessel, height);
      const mass = volumeL * (lf['density'] as number);
      const cl = mass * (lf['specific_heat'] as number);
      let tl = lf['temperature'] as number;
      const container = bodies.get(lid);
      if (container !== undefined) {
        const wetted = Math.PI * vessel.radius * vessel.radius + 2 * Math.PI * r * Math.min(height, vessel.depth);
        const q = exchange(container.fields['temperature'] as number, tl, container.cs, cl, (lf['wall'] as number) * wetted, h);
        container.qs -= q;
        tl += q / cl;
      }
      const ql = exchange(tl, ambient, cl, Infinity, 10 * Math.PI * r * r, h);
      tl -= ql / cl;
      for (const b of bodies.values()) {
        if (b.id === lid) continue;
        const l = toLocal(record, posOf(b.id));
        const radial = Math.hypot(l[0], l[2]);
        const surface = vessel.floor + height;
        if (radial > r + 0.01 || l[1] < vessel.floor - 0.02 || l[1] - b.half > surface) continue;
        const share = Math.max(0.15, Math.min(1, (surface - (l[1] - b.half)) / Math.max(1e-4, 2 * b.half)));
        const q = exchange(tl, b.fields['temperature'] as number, cl, b.cs, (lf['coefficient'] as number) * b.area * share, h);
        tl -= q / cl;
        b.qs += q;
      }
      const boil = lf['boil_point'] as number;
      const w = wet ?? ensureWet(lid);
      if (tl > boil) {
        const excess = (tl - boil) * cl;
        const evaporated = excess / WATER_LATENT;
        lf['volume'] = Math.max(0, volumeL - evaporated / (lf['density'] as number));
        tl = boil;
        const power = excess / Math.max(1e-6, h);
        const target = Math.min(1, power / (900 * Math.max(0.2, (Math.PI * r * r) / 0.03)));
        w.boiling += (Math.max(0.25, target) - w.boiling) * Math.min(1, dt * 3);
        w.nearBoil = 1;
      } else {
        w.boiling += (0 - w.boiling) * Math.min(1, dt * 2);
        w.nearBoil = Math.max(0, Math.min(1, (tl - (boil - 25)) / 25));
      }
      lf['temperature'] = tl;
    }

    // Settle every body.
    heating.clear();
    evaporating.clear();
    for (const b of bodies.values()) {
      const f = b.fields;
      const node = { surface: f['temperature'] as number, core: f['core'] as number, melted: f['melted'] as number, moisture: f['moisture'] as number };
      const { evaporated } = settle(node, {
        mass: b.mass, specificHeat: f['specific_heat'] as number, surfaceShare: f['surface_share'] as number, internal: b.internal,
        meltPoint: f['melt_point'] as number | null, latentHeat: f['latent_heat'] as number,
      }, b.qs, b.qc, h);
      f['temperature'] = node.surface;
      f['core'] = node.core;
      f['melted'] = node.melted;
      f['moisture'] = node.moisture;
      heating.set(b.id, (b.qs + b.qc) / Math.max(1e-6, h));
      evaporating.set(b.id, evaporated / Math.max(1e-6, dt));
    }
  };

  // ── Liquids ─────────────────────────────────────────────────────────────────

  const ensureWet = (id: EntityId): Wet => {
    let w = wets.get(id);
    if (w === undefined) {
      w = { sim: new LiquidSim(), boiling: 0, nearBoil: 0, pouring: 0, level: 0 };
      wets.set(id, w);
      revision++;
    }
    return w;
  };

  const poseOf = (record: EntityRecord, render: boolean, kernel: Kernel): Pose => {
    if (render) {
      const p = kernel.tryService(RENDER_POSE_SERVICE)?.world(record.id);
      if (p !== undefined) return { origin: v3(p.position), R: mat3(p.rotation) };
    }
    const t = record.transform;
    return { origin: v3(t.worldPosition()), R: mat3(t.worldRotation()) };
  };

  const lookOf = (f: Fields, w: Wet) => ({ color: rgbaOf(f['color']), boil: w.boiling, nearBoil: w.nearBoil });

  /** Add liters to a liquid's fields, mixing temperature and colour by volume. */
  const pourIn = (f: Fields, liters: number, temperature: number | null, color: Rgba | null, kind: string | null): void => {
    if (liters <= 0) return;
    const old = f['volume'] as number;
    const total = old + liters;
    const share = liters / total;
    if (temperature !== null) f['temperature'] = (f['temperature'] as number) * (1 - share) + temperature * share;
    if (color !== null) {
      const c = rgbaOf(f['color']);
      f['color'] = old <= 1e-6 ? new Color(color[0], color[1], color[2], color[3])
        : new Color(c[0] + (color[0] - c[0]) * share, c[1] + (color[1] - c[1]) * share, c[2] + (color[2] - c[2]) * share, c[3] + (color[3] - c[3]) * share);
    }
    if (kind !== null && (old <= 1e-6 || share >= 0.5)) f['kind'] = kind;
    f['volume'] = total;
  };

  const stepLiquids = (kernel: Kernel, dt: number): void => {
    const physics = kernel.tryService(PHYSICS3D_SERVICE);
    const all = rows(kernel, LIQUID);
    for (const [id, f] of all) {
      const record = kernel.world.get(id)!;
      const w = ensureWet(id);
      const vessel = vesselOf(f);
      const pose = poseOf(record, false, kernel);
      const volume = f['volume'] as number;
      const height = heightOf(vessel, volume / 1000);
      // Swirl slows by viscosity and friction with the wall.
      const visc = f['viscosity'] as number;
      let swirl = f['swirl'] as number;
      swirl *= Math.exp(-dt * (0.35 + 4 * visc));
      if (Math.abs(swirl) < 0.01) swirl = 0;
      f['swirl'] = swirl;
      w.sim.step(dt, pose, vessel, height, swirl, visc, lookOf(f, w), id);
      const top = pose.origin[1] + pose.R[4]! * (vessel.floor + Math.min(height, vessel.depth));
      w.level = top;
      // Spill: work it out from the surface at this pose — only a tipped, sloshing or
      // brim-full container can spill, so the others skip building it.
      const tipped = pose.R[4]! < 0.995 || Math.abs(w.sim.sx) + Math.abs(w.sim.sz) > 0.05 || height > vessel.depth * 0.9;
      if (tipped && volume > 0) w.sim.geometry(pose, vessel, height, swirl, lookOf(f, w));
      else w.sim.spill = { rate: 0, lip: [0, 0, 0] };
      const spill = w.sim.spill;
      w.pouring = volume > 0 ? spill.rate : 0;
      if (w.pouring > 0) {
        const liters = Math.min(volume, w.pouring * dt);
        f['volume'] = volume - liters;
        // What catches it: the highest other liquid container whose opening is under the lip.
        let best: Fields | null = null;
        let bestY = -Infinity;
        for (const [oid, of] of all) {
          if (oid === id) continue;
          const orec = kernel.world.get(oid)!;
          const ov = vesselOf(of);
          const l = toLocal(orec, spill.lip as V3);
          const rimR = radiusAt(ov, ov.depth);
          if (Math.hypot(l[0], l[2]) <= rimR && l[1] > ov.floor) {
            const oy = orec.transform.worldPosition().y + ov.floor + heightOf(ov, (of['volume'] as number) / 1000);
            if (oy > bestY) {
              bestY = oy;
              best = of;
            }
          }
        }
        if (best !== null) {
          pourIn(best, liters, f['temperature'] as number, rgbaOf(f['color']), f['kind'] as string);
          w.sim.streamEnd = bestY;
        } else {
          f['spilled'] = (f['spilled'] as number) + liters;
          const hit = physics?.raycast(new Vec3(spill.lip[0], spill.lip[1] - 0.01, spill.lip[2]), new Vec3(0, -1, 0), 3, { ignore: [id] });
          w.sim.streamEnd = hit !== undefined ? hit.point.y : spill.lip[1] - 1;
        }
      }
      // Stirring carries what floats or sinks in it round.
      if (physics !== undefined && Math.abs(swirl) > 0.05 && volume > 0) {
        const r = radiusAt(vessel, height);
        for (const [eid] of kernel.world.query([RIGIDBODY])) {
          if (eid === id) continue;
          const state = physics.body(eid);
          if (state === undefined || state.kind !== 'dynamic') continue;
          const l = toLocal(record, v3(state.position));
          if (Math.hypot(l[0], l[2]) > r || l[1] < vessel.floor - 0.02 || l[1] > vessel.floor + height + 0.03) continue;
          // Tangential flow of a forced vortex: Ω × r about the container axis.
          const target = mul(pose.R, [-swirl * l[2], 0, swirl * l[0]]);
          const v = state.velocity;
          const k = 6 * state.mass;
          physics.applyForce(eid, new Vec3((target[0] - v.x) * k, 0, (target[2] - v.z) * k));
        }
      }
    }
  };

  const liquidOf = (fields: Fields, what: string): { record: EntityRecord; wet: Wet; kernel: Kernel } => {
    const kernel = kernelOf();
    const id = componentEntity(fields);
    const record = kernel.world.get(id);
    if (record === undefined || !record.alive) fail('PP3002', `${what} on an entity that no longer exists`);
    return { record, wet: ensureWet(id), kernel };
  };

  const liquidMethods = {
    /** add(liters, *, temperature=None, color=None, kind=None): pour liquid in, mixing by volume. */
    add(this: Fields, ...args: unknown[]): void {
      const a = bindArgs('Liquid.add', args, { positional: ['liters'], keyword: ['temperature', 'color', 'kind'], required: ['liters'] }).args;
      const liters = numberArg(a['liters'], 'Liquid.add() liters', 0);
      const temperature = a['temperature'] === undefined || a['temperature'] === null ? null : numberArg(a['temperature'], 'Liquid.add() temperature');
      const color = a['color'] === undefined || a['color'] === null ? null : colorArg(a['color'], 'Liquid.add() color');
      const kind = a['kind'] === undefined || a['kind'] === null ? null : String(a['kind']);
      liquidOf(this, 'Liquid.add()');
      pourIn(this, liters, temperature, color, kind);
    },
    /** remove(liters) → the liters taken (no more than it holds). */
    remove(this: Fields, ...args: unknown[]): number {
      const a = bindArgs('Liquid.remove', args, { positional: ['liters'], keyword: [], required: ['liters'] }).args;
      const liters = numberArg(a['liters'], 'Liquid.remove() liters', 0);
      const taken = Math.min(liters, this['volume'] as number);
      this['volume'] = (this['volume'] as number) - taken;
      return taken;
    },
    /** stir(speed): spin it (rad/s added to `swirl`, positive counter-clockwise seen from above). */
    stir(this: Fields, ...args: unknown[]): void {
      const a = bindArgs('Liquid.stir', args, { positional: ['speed'], keyword: [], required: ['speed'] }).args;
      const speed = numberArg(a['speed'], 'Liquid.stir() speed');
      this['swirl'] = Math.max(-30, Math.min(30, (this['swirl'] as number) + speed));
    },
    /** pour_into(other, liters) → liters moved into another entity's Liquid. */
    pour_into(this: Fields, ...args: unknown[]): number {
      const a = bindArgs('Liquid.pour_into', args, { positional: ['other', 'liters'], keyword: [], required: ['other', 'liters'] }).args;
      const { kernel } = liquidOf(this, 'Liquid.pour_into()');
      const other = kernel.handles.unwrap(a['other']);
      const of = other === undefined ? undefined : kernel.world.get(other)?.components.get(LIQUID);
      if (of === undefined) fail('PP3493', 'Liquid.pour_into(): the other entity has no Liquid', { fix: 'Pour into an entity whose prefab has a "liquid" component (a beaker, a tank, a crucible).' });
      const liters = Math.min(numberArg(a['liters'], 'Liquid.pour_into() liters', 0), this['volume'] as number);
      this['volume'] = (this['volume'] as number) - liters;
      pourIn(of, liters, this['temperature'] as number, rgbaOf(this['color']), this['kind'] as string);
      return liters;
    },
    /** holds(entity): whether the entity's position is inside the liquid (submerged or floating in it). */
    holds(this: Fields, ...args: unknown[]): boolean {
      const a = bindArgs('Liquid.holds', args, { positional: ['entity'], keyword: [], required: ['entity'] }).args;
      const { record, kernel } = liquidOf(this, 'Liquid.holds()');
      const id = kernel.handles.unwrap(a['entity']);
      const other = id === undefined ? undefined : kernel.world.get(id);
      if (other === undefined || (this['volume'] as number) <= 0) return false;
      const v = vesselOf(this);
      const height = heightOf(v, (this['volume'] as number) / 1000);
      const l = toLocal(record, v3(other.transform.worldPosition()));
      return Math.hypot(l[0], l[2]) <= radiusAt(v, height) + 0.005 && l[1] >= v.floor - 0.02 && l[1] <= v.floor + height + 0.02;
    },
    /** level: world height of the surface's middle (m). */
    get level(): number {
      return liquidOf(this as unknown as Fields, 'Liquid.level').wet.level;
    },
    /** fill: volume over capacity (0..1+). */
    get fill(): number {
      const f = this as unknown as Fields;
      return (f['volume'] as number) / Math.max(1e-9, capacityLiters(vesselOf(f)));
    },
    /** capacity: liters it holds to the rim. */
    get capacity(): number {
      return capacityLiters(vesselOf(this as unknown as Fields));
    },
    /** boiling: 0..1, how hard it boils now. */
    get boiling(): number {
      return liquidOf(this as unknown as Fields, 'Liquid.boiling').wet.boiling;
    },
    /** near_boil: 0..1, how close to the boil (small bubbles). */
    get near_boil(): number {
      return liquidOf(this as unknown as Fields, 'Liquid.near_boil').wet.nearBoil;
    },
    /** pouring: liters per second spilling over the rim now. */
    get pouring(): number {
      return liquidOf(this as unknown as Fields, 'Liquid.pouring').wet.pouring;
    },
    /** pour_point: world point of the lip it spills from (meaningful while `pouring`). */
    get pour_point(): Vec3 {
      const l = liquidOf(this as unknown as Fields, 'Liquid.pour_point').wet.sim.spill.lip;
      return new Vec3(l[0], l[1], l[2]);
    },
  };

  const thermalMethods = {
    /** heating: W flowing into the body over the last step (negative: cooling). */
    get heating(): number {
      return heating.get(componentEntity(this as unknown as Fields)) ?? 0;
    },
    /** evaporating: kg/s of surface water boiling off over the last step (a hiss). */
    get evaporating(): number {
      return evaporating.get(componentEntity(this as unknown as Fields)) ?? 0;
    },
  };

  // ── Drawing ─────────────────────────────────────────────────────────────────

  const liquidGeometry = new Map<EntityId, MutableGeometry>();

  const source = {
    get revision() { return revision; },
    meshes(): GeneratedMesh[] {
      const kernel = kernelOf();
      const out: GeneratedMesh[] = [];
      const poses = kernel.tryService(RENDER_POSE_SERVICE);
      for (const [id] of kernel.world.query([SLICEABLE])) {
        const record = kernel.world.get(id)!;
        if (!record.visible) continue;
        const solid = ensureSolid(kernel, record)!;
        const fields = record.components.get(SLICEABLE)!;
        const pose = poses?.world(id);
        const p = pose?.position ?? record.transform.worldPosition();
        const q = pose?.rotation ?? record.transform.worldRotation();
        const base = rgbaOf(fields['color']);
        const material: GeneratedMaterial = {
          id: `sliceable|${fields['roughness']}|${base[3] < 1 ? 'blend' : 'opaque'}`,
          color: [1, 1, 1, 1],
          texture: null,
          roughness: fields['roughness'] as number,
          metallic: 0,
          blend: base[3] < 1,
          doubleSided: false,
          unlit: false,
        };
        out.push({
          key: `sliceable:${String(id).padStart(10, '0')}`,
          entity: id,
          version: solid.built,
          parts: [{ geometry: solid.geometry, material, castShadows: fields['cast_shadows'] === true }],
          world: compose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, 1, 1, 1),
          collision: null,
          collisionVersion: 0,
        });
      }
      for (const [id, f] of rows(kernel, LIQUID)) {
        const record = kernel.world.get(id)!;
        if (!record.visible) continue;
        const w = ensureWet(id);
        const vessel = vesselOf(f);
        const built = w.sim.geometry(poseOf(record, true, kernel), vessel, heightOf(vessel, (f['volume'] as number) / 1000), f['swirl'] as number, lookOf(f, w));
        if (built === null) continue;
        let g = liquidGeometry.get(id);
        if (g === undefined || g.positions.length !== built.positions.length || g.indices.length !== built.indices.length) {
          g = {
            id: `liquid:${id}:${++builds}`, positions: built.positions, normals: built.normals, uvs: new Float32Array((built.positions.length / 3) * 2),
            indices: built.indices, joints: null, weights: null, colors: built.colors, min: built.min, max: built.max, version: 0,
          };
          liquidGeometry.set(id, g);
        } else {
          g.positions.set(built.positions);
          g.normals.set(built.normals);
          g.colors!.set(built.colors);
          (g.indices as Uint16Array).set(built.indices);
          g.min = built.min;
          g.max = built.max;
          g.version = (g.version ?? 0) + 1;
        }
        const viscous = (f['viscosity'] as number) > 0.3;
        const part: GeneratedPart = {
          geometry: g,
          material: { id: `liquid|${viscous ? 'thick' : 'thin'}`, color: [1, 1, 1, 1], texture: null, roughness: viscous ? 0.35 : 0.06, metallic: 0, blend: true, doubleSided: true, unlit: false },
          castShadows: false,
        };
        out.push({
          key: `liquid:${String(id).padStart(10, '0')}`, entity: id, version: 1, parts: [part], world: IDENTITY, collision: null, collisionVersion: 0,
        });
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
  };

  const components: ComponentDef[] = [
    { id: SLICEABLE, schema: SLICEABLE_SCHEMA, methods: sliceableMethods },
    { id: THERMAL, schema: THERMAL_SCHEMA, methods: thermalMethods },
    { id: HEAT_SOURCE, schema: HEAT_SOURCE_SCHEMA },
    { id: LIQUID, schema: LIQUID_SCHEMA, methods: liquidMethods },
  ];

  const namespace = {
    name: 'matter',
    create(): object {
      return {
        get ambient(): number { return ambient; },
        set ambient(v: number) { ambient = numberArg(v, 'ctx.matter.ambient'); },
        get time_scale(): number { return timeScale; },
        set time_scale(v: number) { timeScale = numberArg(v, 'ctx.matter.time_scale', 0); },
      };
    },
  };

  const step = (kernel: Kernel, dt: number): void => {
    poseCache.clear();
    const physics = kernel.tryService(PHYSICS3D_SERVICE);
    if (physics !== undefined && pendingVelocity.size > 0) {
      for (const [id, v] of [...pendingVelocity]) {
        const body = physics.body(id);
        if (body === undefined) continue;
        if (body.kind === 'dynamic') physics.setVelocity(id, v);
        pendingVelocity.delete(id);
      }
    }
    stepSolids(kernel, dt);
    stepHeat(kernel, dt);
    stepLiquids(kernel, dt);
    poseCache.clear();
  };

  const forget = (id: EntityId): void => {
    if (solids.delete(id)) revision++;
    if (wets.delete(id)) revision++;
    liquidGeometry.delete(id);
    pendingVelocity.delete(id);
  };

  return {
    id: 'matter',
    components,
    namespace,
    solidOf: (entity) => solids.get(entity)?.mesh,
    install(kernel) {
      if (installed !== undefined) fail('PP3247', 'This matter plugin is already installed in another kernel', { fix: 'Call matter() once per game.' });
      installed = kernel;
      kernel.provide(MATTER_MESHES, source);
      kernel.addHook('physics', (dt) => step(kernel, dt));
      kernel.observeEntities({ removed: (records) => { for (const r of records) forget(r.id); } });
      kernel.observeScenes({
        loading: () => {
          solids.clear();
          wets.clear();
          liquidGeometry.clear();
          pendingVelocity.clear();
          revision++;
        },
      });
    },
    snapshot(): Json {
      const cut: Json[] = [];
      for (const [id, s] of [...solids].sort((a, b) => a[0] - b[0])) {
        if (!s.cut && !s.mesh.stain.some((v) => v > 0) && !s.mesh.paint.some((v) => v > 0)) continue;
        const m = s.mesh;
        cut.push({
          entity: id, key: s.key, cut: s.cut, cuts: s.cuts,
          rest: Array.from(m.rest), vp: Array.from(m.vp), cap: Array.from(m.cap), mottle: Array.from(m.mottle),
          stain: Array.from(m.stain), paint: Array.from(m.paint), tris: Array.from(m.tris),
        });
      }
      const liquids: Json[] = [];
      for (const [id, w] of [...wets].sort((a, b) => a[0] - b[0])) {
        liquids.push({ entity: id, slosh: [w.sim.sx, w.sim.sz, w.sim.vx, w.sim.vz, w.sim.phase], boiling: w.boiling, near_boil: w.nearBoil });
      }
      return { ambient, time_scale: timeScale, solids: cut, liquids };
    },
    restore(kernel, state) {
      const s = state as JsonObject;
      ambient = (s['ambient'] as number) ?? ambient;
      timeScale = (s['time_scale'] as number) ?? timeScale;
      solids.clear();
      wets.clear();
      liquidGeometry.clear();
      revision++;
      for (const saved of (s['solids'] as JsonObject[]) ?? []) {
        const record = kernel.world.get(saved['entity'] as EntityId);
        if (record === undefined || !record.components.has(SLICEABLE)) continue;
        const mesh: SolidMesh = {
          rest: Float64Array.from(saved['rest'] as number[]),
          vp: Uint32Array.from(saved['vp'] as number[]),
          cap: Float32Array.from(saved['cap'] as number[]),
          mottle: Float32Array.from(saved['mottle'] as number[]),
          stain: Float32Array.from(saved['stain'] as number[]),
          paint: Float32Array.from(saved['paint'] as number[]),
          tris: Uint32Array.from(saved['tris'] as number[]),
        };
        setSolid(kernel, record, copyMesh(mesh), saved['key'] as string, saved['cut'] === true, (saved['cuts'] as number) ?? 0);
      }
      for (const saved of (s['liquids'] as JsonObject[]) ?? []) {
        const id = saved['entity'] as EntityId;
        if (kernel.world.get(id) === undefined) continue;
        const w = ensureWet(id);
        const [sx, sz, vx, vz, phase] = saved['slosh'] as number[];
        Object.assign(w.sim, { sx, sz, vx, vz, phase });
        w.boiling = saved['boiling'] as number;
        w.nearBoil = saved['near_boil'] as number;
      }
    },
  };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Entities with a component and its fields. */
function rows(kernel: Kernel, component: string): Array<[EntityId, Fields]> {
  return kernel.world.query([component]).map((row) => [row[0], row[1]!]);
}
