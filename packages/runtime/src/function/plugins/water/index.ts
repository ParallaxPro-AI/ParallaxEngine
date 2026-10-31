/**
 * water — oceans, lakes, pools and rivers (sdk/parallax/water.pyi).
 *
 * Water bodies are data: a `water_body` component on an entity (bodies.ts) — its height is
 * the sea level, a lake's size is in its fields, a river is a course of points. The surface
 * carries Gerstner waves (waves.ts) that are a pure function of game time, so gameplay
 * samples exactly what render3d draws.
 *
 * Provides
 *   - `water` (WATER_SERVICE): the water at a point — characters swim with it;
 *   - `water_world` (WATER_WORLD_SERVICE): the bodies, their waves and the splashes and
 *     wakes on them — render3d draws them, vehicles read how deep a hull sits;
 *   - `ctx.water` (height_at, depth_at, flow_at, in_water, body_at, splash).
 *
 * Buoyancy (buoyancy.ts): in the 'physics' hook every `buoyancy` body is pushed up by the
 * water it displaces and dragged by the water's motion (it needs physics3d). A body that
 * hits the water falling faster than 1.5 m/s raises `water_entered` and splashes; one moving
 * through it faster than 1.5 m/s leaves a wake. With a weather plugin, ocean and lake waves
 * grow with its wind.
 *
 * The terrain's `water_level` (terrain plugin) becomes calm water drawn and sampled like any
 * other body (render3d then leaves out its flat water plane): open sea to the horizon when
 * most of the terrain's border is under it (an island, a coast), else a lake over the terrain.
 *
 * Sound: a body's `splash_sound` (the game's sound; none: silent) plays at each splash on
 * it, as loud as the splash is strong, through the audio service.
 *
 * State: splashes and wakes (snapshot); bodies are rebuilt from components; Buoyancy's
 * `submerged` is a component field. Net: a client's replicas don't float (the server sends
 * their poses); the server's splashes and wakes reach clients through `water_sync`.
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { EntityRecord, EventDef, Fields, Kernel, KernelPlugin } from '../../kernel/index.js';
import {
  AUDIO_SERVICE, PHYSICS3D_SERVICE, SPLASH_SECONDS, TERRAIN_SERVICE, WAKE_SECONDS, WATER_SERVICE, WATER_SYNC_SERVICE, WATER_WORLD_SERVICE, WEATHER_SERVICE,
} from '../../services/index.js';
import type { WaterBodyInfo, WaterDisturbance, WaterSample, WaterSource, WaterSync, WaterWorld } from '../../services/index.js';
import { Body, WATER_BODY, WATER_BODY_SCHEMA } from './bodies.js';
import { BUOYANCY, BUOYANCY_SCHEMA, float } from './buoyancy.js';
import type { WaterHere } from './buoyancy.js';

export { BUOYANCY, BUOYANCY_SCHEMA, float } from './buoyancy.js';
export { Body, riverCourse, riverSpot, WATER_BODY, WATER_BODY_SCHEMA, WATER_KINDS, waterBodyProblems } from './bodies.js';
export type { FieldProblem, WaterKind } from './bodies.js';
export { buildWaves, displace, GRAVITY, WAVE_PRESET_NAMES, WAVE_PRESETS, WAVES_PER_SET, waveHeight, waveNormal } from './waves.js';
export type { WaveSet, WaveSpec } from './waves.js';

const RIGIDBODY = 'rigidbody';

export const WATER_EVENTS = {
  /** entity, point, speed (m/s down at the moment it touched the surface). */
  entered: { id: 'water_entered', target: 'entity' },
} as const satisfies Record<string, EventDef>;

/** Most splashes and wakes kept at once (the oldest go first). */
export const MAX_DISTURBANCES = 96;
/** m/s: falling faster splashes; moving faster leaves a wake. */
export const SPLASH_SPEED = 1.5;
export const WAKE_SPEED = 1.5;
/** Seconds between wake rings behind a moving body. */
export const WAKE_INTERVAL = 0.15;

/** The engine side of `ctx.water` (the api layer binds Python arguments onto it). */
export interface WaterControl {
  heightAt(x: number, z: number): number | undefined;
  /** Meters below the surface (negative above it); undefined when the point is in no water. */
  depthAt(point: Vec3): number | undefined;
  flowAt(point: Vec3): Vec3;
  inWater(point: Vec3): boolean;
  bodyAt(point: Vec3): EntityId | undefined;
  splash(point: Vec3, strength: number): void;
}

export interface WaterPlugin extends KernelPlugin {
  control(): WaterControl;
}

/**
 * Whether a terrain's water is open sea: most of its border is under the water level (an
 * island or a coast), so the water runs on past the terrain's edge to the horizon instead
 * of stopping at it. Otherwise it is a lake over the terrain.
 */
export function openSea(heights: Float32Array, columns: number, rows: number, level: number): boolean {
  let under = 0;
  let total = 0;
  const at = (c: number, r: number): void => {
    total++;
    if (heights[r * columns + c]! < level) under++;
  };
  for (let c = 0; c < columns; c++) { at(c, 0); at(c, rows - 1); }
  for (let r = 1; r + 1 < rows; r++) { at(0, r); at(columns - 1, r); }
  return total > 0 && under * 2 > total;
}

/** Waves grow with the weather's wind: ×1 up to 6 m/s, then +1 for every 8 m/s more (quantized). */
export function windWaveScale(wind: number): number {
  return Math.round((1 + Math.max(0, wind - 6) / 8) * 50) / 50;
}

interface Placed {
  body: Body;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
  readonly fields: Fields;
  version: number;
}

class WaterState implements WaterSource, WaterWorld, WaterControl, WaterSync {
  readonly #kernel: Kernel;
  readonly #bodies = new Map<EntityId, Placed>();
  readonly #floating = new Set<EntityId>();
  /** The terrain's water (its key: scene and version), or null without one. */
  #terrainWater: { readonly key: string; readonly body: Body; readonly version: number } | null = null;
  #disturbances: WaterDisturbance[] = [];
  /** Disturbances ever made; the last live one is number `#made - 1`. */
  #made = 0;
  #version = 0;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  // ── Keeping bodies in step with the world ───────────────────────────────────

  track(record: EntityRecord): void {
    const fields = record.components.get(WATER_BODY);
    if (fields === undefined) this.#bodies.delete(record.id);
    else this.#place(record, fields);
    if (record.components.has(BUOYANCY)) this.#floating.add(record.id);
    else this.#floating.delete(record.id);
  }

  forget(record: EntityRecord): void {
    this.#bodies.delete(record.id);
    this.#floating.delete(record.id);
  }

  rebuild(): void {
    this.#bodies.clear();
    this.#floating.clear();
    for (const record of this.#kernel.world.live()) this.track(record);
  }

  #place(record: EntityRecord, fields: Fields): void {
    const p = record.transform.worldPosition();
    const q = record.transform.worldRotation();
    this.#bodies.set(record.id, {
      body: new Body(record.id, record.name ?? `entity ${record.id}`, p, q, fields), x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, fields, version: ++this.#version,
    });
  }

  /** The terrain's water_level as a lake over the terrain, kept in step with the field. */
  #terrain(): Body | null {
    const field = this.#kernel.tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (field === null || field.waterLevel === null) {
      this.#terrainWater = null;
      return null;
    }
    const key = `${field.scene}:${field.version}`;
    if (this.#terrainWater?.key !== key) {
      const fields = {
        ...Object.fromEntries(Object.entries(WATER_BODY_SCHEMA).map(([k, spec]) => [k, spec.default])),
        kind: openSea(field.heights, field.columns, field.rows, field.waterLevel) ? 'ocean' : 'lake',
        area: { center: [0, 0], size: [field.width, field.depth] }, waves: 'calm',
        depth: Math.max(1, field.waterLevel - field.minHeight + 1),
      };
      const center = new Vec3(field.minX + field.width / 2, field.waterLevel, field.minZ + field.depth / 2);
      this.#terrainWater = { key, body: new Body(null, 'the terrain\'s water_level', center, new Quat(0, 0, 0, 1), fields), version: ++this.#version };
    }
    return this.#terrainWater.body;
  }

  #all(): { body: Body; version: number }[] {
    const out: { body: Body; version: number }[] = [...this.#bodies.values()];
    const terrain = this.#terrain();
    if (terrain !== null) out.push({ body: terrain, version: this.#terrainWater!.version });
    return out;
  }

  /** Bodies whose entity moved are rebuilt (cheap check: a moving lake is rare). */
  #refresh(): void {
    for (const [id, placed] of this.#bodies) {
      const record = this.#kernel.world.get(id);
      if (record === undefined) continue;
      const p = record.transform.worldPosition();
      const q = record.transform.worldRotation();
      if (p.x !== placed.x || p.y !== placed.y || p.z !== placed.z || q.x !== placed.qx || q.y !== placed.qy || q.z !== placed.qz || q.w !== placed.qw) {
        this.#place(record, placed.fields);
      }
    }
  }

  #windScale(): number {
    const weather = this.#kernel.tryService(WEATHER_SERVICE);
    return weather === undefined ? 1 : windWaveScale(weather.conditions().wind);
  }

  /** The body a point is in (highest surface whose bed is below it), with its surface there. */
  #find(x: number, y: number, z: number): { body: Body; surface: number } | undefined {
    const t = this.#kernel.time.now;
    const scale = this.#windScale();
    let best: { body: Body; surface: number } | undefined;
    for (const { body } of this.#all()) {
      if (!body.covers(x, z)) continue;
      const level = body.levelAt(x, z);
      if (y < level - body.depth) continue;
      const surface = body.surfaceAt(x, z, t, scale);
      if (best === undefined || surface > best.surface) best = { body, surface };
    }
    return best;
  }

  // ── WATER_SERVICE ───────────────────────────────────────────────────────────

  sample(point: Vec3): WaterSample | undefined {
    const found = this.#find(point.x, point.y, point.z);
    return found === undefined ? undefined : { surface: found.surface, flow: found.body.flowAt(point.x, point.z) };
  }

  // ── WATER_WORLD_SERVICE ─────────────────────────────────────────────────────

  bodies(): readonly WaterBodyInfo[] {
    this.#refresh();
    const scale = this.#windScale();
    return this.#all().map(({ body, version }) => ({
      entity: body.entity, kind: body.kind, level: body.level, center: body.center, halfX: body.halfX, halfZ: body.halfZ,
      yaw: body.yaw, shape: body.shape, depth: body.depth, waves: body.waves(scale), deep: body.deep, shallow: body.shallow,
      clarity: body.clarity, foam: body.foam, caustics: body.caustics, ripple: body.ripple, calmDistance: body.calmDistance, course: body.course, width: body.width, flow: body.flow, version,
    }));
  }

  disturbances(): readonly WaterDisturbance[] {
    return this.#disturbances;
  }

  heightAt(x: number, z: number): number | undefined {
    return this.#find(x, Number.POSITIVE_INFINITY, z)?.surface;
  }

  submerged(entity: EntityId): number | undefined {
    const fields = this.#kernel.world.get(entity)?.components.get(BUOYANCY);
    return fields === undefined ? undefined : (fields['submerged'] as number);
  }

  splash(point: Vec3, strength: number): void {
    if (!(strength > 0 && strength <= 1)) fail('PP3372', `splash strength is ${strength}; it must be above 0 and at most 1`);
    const surface = this.heightAt(point.x, point.z) ?? point.y;
    this.#disturb({ kind: 'splash', x: point.x, y: surface, z: point.z, start: this.#kernel.time.now, strength });
  }

  #disturb(d: WaterDisturbance): void {
    if (d.kind === 'splash') {
      const sound = this.#find(d.x, d.y - 0.01, d.z)?.body.splashSound ?? null;
      if (sound !== null) this.#kernel.tryService(AUDIO_SERVICE)?.play({ sound, at: new Vec3(d.x, d.y, d.z), volume: d.strength });
    }
    this.#made++;
    this.#disturbances.push(d);
    if (this.#disturbances.length > MAX_DISTURBANCES) this.#disturbances.splice(0, this.#disturbances.length - MAX_DISTURBANCES);
  }

  // ── WATER_SYNC_SERVICE ──────────────────────────────────────────────────────

  get made(): number {
    return this.#made;
  }

  since(after: number): readonly WaterDisturbance[] {
    const fresh = Math.max(0, this.#made - after);
    return fresh === 0 ? [] : this.#disturbances.slice(Math.max(0, this.#disturbances.length - fresh));
  }

  follow(disturbances: readonly WaterDisturbance[]): void {
    for (const d of disturbances) this.#disturb(d);
  }

  // ── ctx.water ───────────────────────────────────────────────────────────────

  depthAt(point: Vec3): number | undefined {
    const found = this.#find(point.x, point.y, point.z);
    return found === undefined ? undefined : found.surface - point.y;
  }

  flowAt(point: Vec3): Vec3 {
    return this.#find(point.x, point.y, point.z)?.body.flowAt(point.x, point.z) ?? Vec3.ZERO;
  }

  inWater(point: Vec3): boolean {
    const depth = this.depthAt(point);
    return depth !== undefined && depth >= 0;
  }

  bodyAt(point: Vec3): EntityId | undefined {
    const found = this.#find(point.x, point.y, point.z);
    return found !== undefined && found.surface >= point.y ? found.body.entity ?? undefined : undefined;
  }

  // ── The fixed step ──────────────────────────────────────────────────────────

  step(dt: number): void {
    const now = this.#kernel.time.now;
    this.#disturbances = this.#disturbances.filter((d) => now - d.start < (d.kind === 'splash' ? SPLASH_SECONDS : WAKE_SECONDS));
    if (this.#floating.size === 0) return;
    this.#refresh();
    const physics = this.#kernel.service(PHYSICS3D_SERVICE);
    const here = (p: Vec3): WaterHere | undefined => {
      const found = this.#find(p.x, p.y, p.z);
      return found === undefined ? undefined : { surface: found.surface, flow: found.body.flowAt(p.x, p.z), density: found.body.density };
    };
    const wakeTick = Math.floor(now / WAKE_INTERVAL) !== Math.floor((now - dt) / WAKE_INTERVAL);
    for (const id of this.#floating) {
      const record = this.#kernel.world.get(id);
      if (record === undefined || !record.alive) continue;
      // A body the network drives (a net client's replica: its Rigidbody says dynamic, its body is
      // kinematic) floats on its server, which sends its pose and the splashes and wakes it makes.
      if (record.components.get(RIGIDBODY)?.['kind'] === 'dynamic' && physics.body(id)?.kind === 'kinematic') continue;
      const fields = record.components.get(BUOYANCY)!;
      const before = fields['submerged'] as number;
      const result = float(physics, id, fields, here, dt);
      if (result.center === undefined) continue;
      const velocity = physics.body(id)!.velocity;
      if (before === 0 && -velocity.y > SPLASH_SPEED) {
        const point = result.center;
        this.#disturb({ kind: 'splash', x: point.x, y: point.y, z: point.z, start: now, strength: Math.min(1, -velocity.y / 8) });
        this.#kernel.emit(WATER_EVENTS.entered, { entity: this.#kernel.handles.wrap(id), point, speed: -velocity.y });
      }
      const speed = velocity.flat().length();
      if (wakeTick && speed > WAKE_SPEED) {
        const p = record.transform.worldPosition();
        const surface = this.heightAt(p.x, p.z) ?? p.y;
        this.#disturb({ kind: 'wake', x: p.x, y: surface, z: p.z, start: now, strength: Math.min(1, speed / 10) });
      }
    }
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  snapshot(): Json {
    return {
      made: this.#made,
      disturbances: this.#disturbances.map((d) => ({ kind: d.kind, x: d.x, y: d.y, z: d.z, start: d.start, strength: d.strength })),
    };
  }

  restore(state: Json): void {
    const o = state as JsonObject;
    this.#made = o['made'] as number;
    this.#disturbances = (o['disturbances'] as JsonObject[]).map((d) => ({
      kind: d['kind'] as 'splash' | 'wake', x: d['x'] as number, y: d['y'] as number, z: d['z'] as number,
      start: d['start'] as number, strength: d['strength'] as number,
    }));
    this.rebuild();
  }
}

/** The water plugin. One value serves one kernel. List it after physics3d when bodies float. */
export function water(): WaterPlugin {
  let state: WaterState | undefined;
  const current = (): WaterState => {
    if (state === undefined) fail('PP9240', 'The water plugin is used before its kernel was built');
    return state;
  };
  return {
    id: 'water',
    components: [
      { id: WATER_BODY, schema: WATER_BODY_SCHEMA },
      { id: BUOYANCY, schema: BUOYANCY_SCHEMA },
    ],
    events: Object.values(WATER_EVENTS),
    install(kernel) {
      if (state !== undefined) fail('PP3247', 'This water plugin is already installed in another kernel', { fix: 'Call water() once per kernel.' });
      const created = new WaterState(kernel);
      state = created;
      kernel.provide(WATER_SERVICE, created);
      kernel.provide(WATER_WORLD_SERVICE, created);
      kernel.provide(WATER_SYNC_SERVICE, created);
      kernel.observeEntities({
        added: (records) => { for (const r of records) created.track(r); },
        removed: (records) => { for (const r of records) created.forget(r); },
        changed: (record) => created.track(record),
      });
      kernel.addHook('physics', (dt) => created.step(dt));
    },
    control: current,
    snapshot: () => current().snapshot(),
    restore: (_kernel, saved) => current().restore(saved),
  };
}
