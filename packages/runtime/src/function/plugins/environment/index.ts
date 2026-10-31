/**
 * environment — the scene-wide look (sdk `EnvironmentApi`): the scene's
 * "environment" block, runtime changes through `ctx.environment`, the day cycle and the
 * `DayChanged` event, and EnvironmentZone blending. Core: the runtime includes it in
 * every game.
 *
 * It renders nothing. It provides the `environment` service (function/services/
 * environment.ts) with the look resolved per frame; renderers read that. EnvironmentZone
 * is the visuals plugin's component: this plugin reads it by id — its override fields and
 * the `__weight__` getter visuals keeps up to date around the camera.
 *
 * Lifetimes. Each scene load applies the scene's block: sky, time of day, day length, fog,
 * sun and post, and clears runtime fog/sky/post overrides. `day` counts on across scenes and is
 * reset to 0 only by `new_run=True`. Everything is in snapshots; `persist`/`load` carry the
 * run-lifetime part for save slots.
 *
 * The sky. "atmosphere" is physically based (atmosphere.ts: its palette follows the sun
 * through single scattering, and render3d draws the same model); the cloud layer drifts in
 * game time (its offset is state). A weather plugin, looked up at use, owns the sky's mood
 * while a weather is active (WeatherService.active): it greys the sky, dims the sun, sets
 * fog density and cloud cover and darkness (the scene's authored values for those are
 * replaced; check warns, PP3382), and flashes everything with lightning. The sky preset
 * only picks the hour's light; grey/rain/storm skies are weather presets.
 *
 * The clock runs in a plugin system's `update` (game time: hitstop and pause stop it).
 * `DayChanged(day)` fires when the clock passes 06:00 (`day` increases first); setting
 * `time_of_day` or `day` directly fires nothing.
 */

import { Color, fail, parseColor } from '../../../core/index.js';
import type { EventDef, Fields, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { ENVIRONMENT_SERVICE, ENVIRONMENT_SYNC_SERVICE, WEATHER_SERVICE } from '../../services/index.js';
import type { EnvironmentService, ResolvedClouds, ResolvedEnvironment, ResolvedFog, WeatherConditions } from '../../services/index.js';
import type { Atmosphere3d, Vec3 } from '../../../core/index.js';
import { EARTH_ATMOSPHERE, withHaze } from './atmosphere.js';
import { cycled, daylight, daylightAt, isNight, lerpPalette, lightDirection, overcastPalette, palette, toSunAt } from './sky.js';
import type { Palette, SkyPreset } from './sky.js';
import { checkFog, cloudProblem, DEFAULT_CLOUDS, DEFAULT_ENVIRONMENT, readEnvironmentSpec, skyPreset } from './spec.js';
import type { CloudSpec, EnvironmentSpec, FogSpec } from './spec.js';
import {
  lerpPost, POST_PRESETS, postEntries, postLayerFrom, postLayerJson, postPreset, postSettingsFrom, postSettingsJson, postValue,
  resolvePost,
} from './post.js';
import type { PostField, PostLayer, PostValue } from './post.js';
import type { PostPresetName, PostSettings } from '../../services/index.js';

export { atmospherePalette, DAWN, DUSK, SKY_PRESETS, toSunAt } from './sky.js';
export type { SkyPreset } from './sky.js';
export { atmosphereLight, EARTH_ATMOSPHERE, miePhase, rayleighPhase, skyRadiance, sunTransmittance, withHaze } from './atmosphere.js';
export { DEFAULT_CLOUDS, readEnvironmentSpec } from './spec.js';
export type { CloudSpec, DebugViewSpec, EnvironmentSpec, FogSpec } from './spec.js';
export { DEFAULT_POST, POST_FIELDS, POST_GROUPS, POST_PRESETS, resolvePost } from './post.js';
export type { PostLayer } from './post.js';

export const DAY_CHANGED: EventDef = { id: 'day_changed' };
const ENVIRONMENT_ZONE = 'environment_zone';

/** What `ctx.environment.fog(...)` passes (absent: unchanged). */
export interface FogChange {
  readonly density?: number;
  readonly near?: number;
  readonly far?: number;
  readonly color?: Color;
  readonly volumetric?: number;
  /** Exponential fog's thinning with height (1/m; 0 uniform); kept from the current fog when absent. */
  readonly heightFalloff?: number;
  readonly height?: number;
  readonly seconds: number;
}

/**
 * What `ctx.environment.post(...)` passes: a preset and fields by their scene keys
 * (`bloom`, `vignette`, …), values as Python gives them. Nothing at all clears the runtime layer.
 */
export interface PostChange {
  readonly preset?: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly seconds: number;
}

/** What `ctx.environment.clouds(...)` passes (absent: unchanged). */
export interface CloudChange {
  readonly coverage?: number;
  readonly density?: number;
  readonly speed?: number;
  readonly direction?: number;
  readonly seconds: number;
}

/** The engine side of `ctx.environment` (the api layer binds Python arguments onto it). */
export interface EnvironmentControl {
  timeOfDay: number;
  dayLength: number;
  day: number;
  readonly isNight: boolean;
  fog(change: FogChange): void;
  sky(preset: string, seconds: number): void;
  post(change: PostChange): void;
  clouds(change: CloudChange): void;
  /** The cloud layer now (null: none). */
  readonly cloudCover: ResolvedClouds | null;
  /** The post settings in effect this frame (preset expanded). */
  readonly postSettings: PostSettings;
}

export interface EnvironmentPlugin extends KernelPlugin {
  /** The control for this plugin's kernel (built at install). */
  control(): EnvironmentControl;
}

interface Transition<T> {
  readonly from: T;
  readonly start: number;
  readonly seconds: number;
}

/** A fog with its colour decided (transitions blend between these). */
interface ConcreteFog {
  readonly density: number;
  readonly near: number | null;
  readonly far: number | null;
  readonly color: Color;
  readonly volumetric: number;
  readonly heightFalloff: number;
  readonly height: number;
}

function finite(value: number, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3223', `${where} must be a finite number, got ${String(value)}`);
  return value;
}

function nonNegative(value: number, where: string): number {
  if (finite(value, where) < 0) fail('PP3223', `${where} can't be negative, got ${value}`);
  return value;
}

function multiply(a: Color, b: Color): Color {
  return new Color(a.r * b.r, a.g * b.g, a.b * b.b, a.a);
}

function colorJson(c: Color | null): Json {
  return c === null ? null : [c.r, c.g, c.b, c.a];
}

function colorFrom(value: Json, where: string): Color | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number')) {
    const [r, g, b, a] = value as number[];
    return new Color(r!, g!, b!, a!);
  }
  return fail('PP9220', `${where}: not a saved colour: ${JSON.stringify(value)}`);
}

function fogJson(f: FogSpec | ConcreteFog): JsonObject {
  return {
    density: f.density, near: f.near, far: f.far, color: colorJson(f.color), volumetric: f.volumetric, height_falloff: f.heightFalloff, height: f.height,
  };
}

function cloudsJson(c: CloudSpec | null): Json {
  return c === null ? null : { ...c };
}

function cloudsFrom(value: Json | undefined, where: string): CloudSpec | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return fail('PP9220', `${where}: not saved clouds`);
  const o = value as JsonObject;
  const num = (key: keyof CloudSpec): number => {
    const v = o[key];
    if (typeof v !== 'number') fail('PP9220', `${where}: saved clouds have no ${key}`);
    return v;
  };
  return {
    coverage: num('coverage'), density: num('density'), height: num('height'), thickness: num('thickness'), scale: num('scale'),
    speed: num('speed'), direction: num('direction'),
  };
}

function fogFrom(value: Json, where: string): FogSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('PP9220', `${where}: not a saved fog`);
  const o = value as JsonObject;
  const num = (v: Json | undefined): number | null => (typeof v === 'number' ? v : null);
  return {
    density: num(o['density']) ?? 0, near: num(o['near']), far: num(o['far']), color: colorFrom(o['color'] ?? null, where),
    volumetric: num(o['volumetric']) ?? 0,
    heightFalloff: num(o['height_falloff']) ?? 0,
    height: num(o['height']) ?? 0,
  };
}

/** 0..1 stars showing for the sun's height (sine of its elevation): none until it is down, all by deep twilight. */
export function starlight(sunY: number): number {
  const t = Math.min(1, Math.max(0, (-sunY - 0.02) / 0.16));
  return t * t * (3 - 2 * t);
}

class EnvironmentState implements EnvironmentControl, EnvironmentService {
  readonly #kernel: Kernel;
  #spec: EnvironmentSpec = DEFAULT_ENVIRONMENT;
  #time = DEFAULT_ENVIRONMENT.timeOfDay;
  #dayLength = 0;
  #day = 0;
  #sky: SkyPreset = DEFAULT_ENVIRONMENT.sky;
  #skyChange: Transition<SkyPreset> | null = null;
  #fog: FogSpec = DEFAULT_ENVIRONMENT.fog;
  #fogChange: Transition<ConcreteFog> | null = null;
  /** The runtime post layer (`ctx.environment.post`), null: the scene's post only. */
  #post: PostLayer | null = null;
  #postChange: Transition<PostSettings> | null = null;
  /** A cinematic's grade over the post settings (`grade()`), not saved: its owner sets it every frame. */
  #grade: { readonly look: JsonObject; readonly preset: PostPresetName | null; readonly fields: Partial<Record<PostField, PostValue>>; readonly weight: number } | null = null;
  #overridden = { fog: false, sky: false, clouds: false };
  /** The cloud layer: the scene's, or a runtime change's target (null: none). */
  #clouds: CloudSpec | null = null;
  #cloudChange: Transition<CloudSpec> | null = null;
  /** Meters the clouds have drifted. */
  #drift: [number, number] = [0, 0];
  #cache: { readonly frame: number; readonly revision: number; readonly value: ResolvedEnvironment } | null = null;
  #revision = 0;
  #course = 0;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  // ── Scene ───────────────────────────────────────────────────────────────────

  apply(spec: EnvironmentSpec, resetRun: boolean): void {
    this.#spec = spec;
    this.#time = spec.timeOfDay;
    this.#dayLength = spec.dayLength;
    if (resetRun) this.#day = 0;
    this.#sky = spec.sky;
    this.#skyChange = null;
    this.#fog = spec.fog;
    this.#fogChange = null;
    this.#post = null;
    this.#postChange = null;
    this.#clouds = spec.clouds;
    this.#cloudChange = null;
    this.#drift = [0, 0];
    this.#overridden = { fog: false, sky: false, clouds: false };
    if (spec.weather !== undefined && this.#kernel.tryService(WEATHER_SERVICE) === undefined) {
      fail('PP3227', 'The scene\'s environment names a "weather", but the game has no weather plugin', {
        fix: 'Add weather() to Game(plugins=[...]), or remove "weather" from the environment block.',
      });
    }
    this.#steered();
  }

  #changed(): void {
    this.#revision++;
  }

  /** A change the clock won't repeat on a client (net follows it: ENVIRONMENT_SYNC_SERVICE). */
  #steered(): void {
    this.#course++;
    this.#changed();
  }

  get course(): number { return this.#course; }

  // ── Control (ctx.environment) ───────────────────────────────────────────────

  get timeOfDay(): number { return this.#time; }
  set timeOfDay(value: number) {
    finite(value, 'time_of_day');
    if (value < 0 || value > 24) fail('PP3223', `time_of_day must be between 0 and 24, got ${value}`, { fix: 'Use hours: 0 is midnight, 13.5 is 1:30 pm.' });
    this.#time = value % 24;
    this.#steered();
  }

  get dayLength(): number { return this.#dayLength; }
  set dayLength(value: number) {
    this.#dayLength = nonNegative(value, 'day_length');
    this.#steered();
  }

  get day(): number { return this.#day; }
  set day(value: number) {
    if (!Number.isInteger(value) || value < 0) fail('PP3223', `day must be a whole number of days, at least 0, got ${String(value)}`);
    this.#day = value;
    this.#steered();
  }

  get isNight(): boolean { return isNight(this.#time); }

  fog(change: FogChange): void {
    const seconds = nonNegative(change.seconds, 'fog() seconds');
    const linear = change.near !== undefined || change.far !== undefined;
    if (change.density === undefined && !linear && change.color === undefined && change.volumetric === undefined && change.heightFalloff === undefined && change.height === undefined) {
      fail('PP3222', 'fog() needs a density, near and far, a color, volumetric or height_falloff', { fix: 'e.g. fog(0.01), fog(near=20, far=80) or fog(color=...); fog(0) clears it.' });
    }
    if (change.density !== undefined) nonNegative(change.density, 'fog() density');
    if (change.near !== undefined) finite(change.near, 'fog() near');
    if (change.far !== undefined) finite(change.far, 'fog() far');
    if (change.volumetric !== undefined) finite(change.volumetric, 'fog() volumetric');
    if (change.heightFalloff !== undefined) finite(change.heightFalloff, 'fog() height_falloff');
    if (change.height !== undefined) finite(change.height, 'fog() height');
    const base = this.#fog;
    const volumetric = change.volumetric ?? base.volumetric;
    const height = change.height ?? base.height;
    const heightFalloff = linear ? 0 : change.heightFalloff ?? base.heightFalloff;
    const next: FogSpec = change.density !== undefined
      ? { density: change.density, near: null, far: null, color: change.color ?? base.color, volumetric, heightFalloff, height }
      : linear
        ? { density: 0, near: change.near ?? null, far: change.far ?? null, color: change.color ?? base.color, volumetric, heightFalloff, height }
        : { ...base, color: change.color ?? base.color, volumetric, heightFalloff, height };
    checkFog(next, 'fog()');
    const from = this.#currentFog(this.#kernel.time.now);
    this.#fog = next;
    this.#fogChange = seconds > 0 ? { from, start: this.#kernel.time.now, seconds } : null;
    this.#overridden.fog = true;
    this.#steered();
  }

  sky(preset: string, seconds: number): void {
    const target = skyPreset(preset, 'sky()');
    nonNegative(seconds, 'sky() seconds');
    const now = this.#kernel.time.now;
    const from = this.#skyChange !== null && now < this.#skyChange.start + this.#skyChange.seconds ? this.#skyChange.from : this.#sky;
    this.#skyChange = seconds > 0 && from !== target ? { from, start: now, seconds } : null;
    this.#sky = target;
    this.#overridden.sky = true;
    this.#steered();
  }

  post(change: PostChange): void {
    const seconds = nonNegative(change.seconds, 'post() seconds');
    const problem = (message: string, fix: string): never => fail('PP3226', `post(): ${message}`, { fix });
    const keys = Object.keys(change.fields);
    let next: PostLayer | null = null;
    if (change.preset !== undefined || keys.length > 0) {
      const fields: Partial<Record<PostField, PostValue>> = {};
      for (const [spec, value] of postEntries(change.fields, (_at, message, fix) => problem(message, fix))) {
        fields[spec.prop] = postValue(spec, value, (v) => (v instanceof Color ? v : null), problem);
      }
      next = { preset: change.preset === undefined ? null : postPreset(change.preset, problem), fields };
    }
    const now = this.#kernel.time.now;
    const from = this.#currentPost(now);
    this.#post = next;
    this.#postChange = seconds > 0 ? { from, start: now, seconds } : null;
    this.#steered();
  }

  clouds(change: CloudChange): void {
    const seconds = nonNegative(change.seconds, 'clouds() seconds');
    if (change.coverage === undefined && change.density === undefined && change.speed === undefined && change.direction === undefined) {
      fail('PP3228', 'clouds() needs a coverage, density, speed or direction', { fix: 'e.g. clouds(0.7) or clouds(density=0.9, seconds=20); clouds(0) clears the sky.' });
    }
    for (const [key, v] of Object.entries(change)) if (key !== 'seconds' && v !== undefined) finite(v as number, `clouds() ${key}`);
    const now = this.#kernel.time.now;
    const base = this.#clouds ?? { ...DEFAULT_CLOUDS, coverage: 0 };
    const from = this.#currentClouds(now) ?? base;
    const next: CloudSpec = {
      ...base,
      ...(change.coverage !== undefined && { coverage: change.coverage }),
      ...(change.density !== undefined && { density: change.density }),
      ...(change.speed !== undefined && { speed: change.speed }),
      ...(change.direction !== undefined && { direction: change.direction }),
    };
    const problem = cloudProblem(next);
    if (problem !== undefined) fail('PP3228', `clouds(): ${problem.message}`, { fix: `Pass a ${problem.key} in range.` });
    this.#clouds = next;
    this.#cloudChange = seconds > 0 ? { from, start: now, seconds } : null;
    this.#overridden.clouds = true;
    this.#steered();
  }

  get cloudCover(): ResolvedClouds | null {
    return this.resolve().clouds;
  }

  /** The cloud spec now (a running change blended), before weather. */
  #currentClouds(now: number): CloudSpec | null {
    const target = this.#clouds;
    const change = this.#cloudChange;
    const t = this.#progress(change, now);
    if (change === null || t >= 1 || target === null) return target;
    const f = change.from;
    const mix = (a: number, b: number): number => a + (b - a) * t;
    return {
      coverage: mix(f.coverage, target.coverage), density: mix(f.density, target.density), height: mix(f.height, target.height),
      thickness: mix(f.thickness, target.thickness), scale: mix(f.scale, target.scale), speed: mix(f.speed, target.speed),
      direction: t < 0.5 ? f.direction : target.direction,
    };
  }

  /** The clouds' drift velocity now (m/s, x and z): their own speed, faster in a weather wind. */
  #cloudVelocity(clouds: CloudSpec, weather: WeatherConditions | undefined): [number, number] {
    const speed = Math.max(clouds.speed, (weather?.wind ?? 0) * 1.5);
    const d = (clouds.direction * Math.PI) / 180;
    return [Math.sin(d) * speed, Math.cos(d) * speed];
  }

  get postSettings(): PostSettings {
    return this.#graded(this.#currentPost(this.#kernel.time.now));
  }

  /** EnvironmentService.grade: a scene "post" block blended over the look at `weight` (0 or null: none). */
  grade(look: JsonObject | null, weight: number): void {
    if (look === null || !(weight > 0)) {
      if (this.#grade !== null) { this.#grade = null; this.#revision++; }
      return;
    }
    const known = this.#grade;
    if (known !== null && known.look === look && known.weight === weight) return;
    let parsed = known !== null && known.look === look ? known : null;
    if (parsed === null) {
      const problem = (message: string, fix: string): never => fail('PP3226', `cinematic grade: ${message}`, { fix });
      const fields: Partial<Record<PostField, PostValue>> = {};
      for (const [spec, value] of postEntries(look, (_at, message, fix) => problem(message, fix))) {
        fields[spec.prop] = postValue(spec, value, parseColor, problem);
      }
      const preset = look['preset'] === undefined || look['preset'] === null ? null : postPreset(look['preset'], problem);
      parsed = { look, preset, fields, weight };
    }
    this.#grade = { ...parsed, weight: Math.min(1, weight) };
    this.#revision++;
  }

  #graded(post: PostSettings): PostSettings {
    const g = this.#grade;
    if (g === null) return post;
    const target = { ...post, ...(g.preset === null ? {} : POST_PRESETS[g.preset]), ...g.fields, preset: g.preset ?? post.preset } as PostSettings;
    return lerpPost(post, target, g.weight);
  }

  #currentPost(now: number): PostSettings {
    const target = resolvePost(this.#spec.post, this.#post);
    const change = this.#postChange;
    const post = change === null ? target : lerpPost(change.from, target, this.#progress(change, now));
    // The "debug" block's wireframe view, over whatever look is in effect.
    const debug = this.#spec.debug;
    if (debug === undefined || debug === null || !debug.wireframe) return post;
    return { ...post, mode: 'wireframe', wireColor: debug.wireColor, wireBackground: debug.wireBackground };
  }

  // ── The clock ───────────────────────────────────────────────────────────────

  advance(dt: number): void {
    if (dt <= 0) return;
    const weather = this.#weather();
    const clouds = this.#currentClouds(this.#kernel.time.now) ?? (weather !== undefined && weather.clouds > 0 ? DEFAULT_CLOUDS : null);
    if (clouds !== null) {
      const [vx, vz] = this.#cloudVelocity(clouds, weather);
      this.#drift = [this.#drift[0] + vx * dt, this.#drift[1] + vz * dt];
      this.#changed();
    }
    if (this.#dayLength <= 0) return;
    const start = this.#time;
    const end = start + (24 * dt) / this.#dayLength;
    const dawns = Math.floor((end - 6) / 24) - Math.floor((start - 6) / 24);
    this.#time = end % 24;
    for (let i = 0; i < dawns; i++) {
      this.#day++;
      this.#kernel.emit(DAY_CHANGED, { day: this.#day });
    }
    this.#changed();
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  #progress(change: Transition<unknown> | null, now: number): number {
    if (change === null || change.seconds <= 0) return 1;
    return Math.min(1, Math.max(0, (now - change.start) / change.seconds));
  }

  /** The running weather's conditions (undefined: no weather plugin, or none is active). */
  #weather(): WeatherConditions | undefined {
    const service = this.#kernel.tryService(WEATHER_SERVICE);
    if (service === undefined || service.active?.() === false) return undefined;
    return service.conditions();
  }

  #toSun(): Vec3 {
    const fixed = this.#spec.sunDirection;
    return fixed === null ? toSunAt(this.#time) : fixed.__neg__();
  }

  #air(): Atmosphere3d {
    const spec = this.#spec;
    const base = spec.haze === 1 ? EARTH_ATMOSPHERE : withHaze(EARTH_ATMOSPHERE, spec.haze);
    return spec.sunSize === 1 ? base : { ...base, sunRadius: base.sunRadius * spec.sunSize };
  }

  #palette(now: number): Palette {
    const air = { model: this.#air(), toSun: this.#toSun() };
    const target = palette(this.#sky, air);
    const t = this.#progress(this.#skyChange, now);
    return t >= 1 ? target : lerpPalette(palette(this.#skyChange!.from, air), target, t);
  }

  #concrete(fog: FogSpec, horizon: Color): ConcreteFog {
    return {
      density: fog.density, near: fog.near, far: fog.far, color: fog.color ?? horizon, volumetric: fog.volumetric, heightFalloff: fog.heightFalloff, height: fog.height,
    };
  }

  /** The fog before zones: the target, blended from where a running change started. */
  #currentFog(now: number): ConcreteFog {
    const target = this.#concrete(this.#fog, this.#palette(now).horizon);
    const change = this.#fogChange;
    const t = this.#progress(change, now);
    if (change === null || t >= 1) return target;
    const from = change.from;
    const linear = t < 0.5 ? from : target;
    const both = from.near !== null && target.near !== null;
    return {
      density: from.density + (target.density - from.density) * t,
      near: both ? from.near! + (target.near! - from.near!) * t : linear.near,
      far: both ? from.far! + (target.far! - from.far!) * t : linear.far,
      color: from.color.lerp(target.color, t),
      volumetric: from.volumetric + (target.volumetric - from.volumetric) * t,
      heightFalloff: from.heightFalloff + (target.heightFalloff - from.heightFalloff) * t,
      height: from.height + (target.height - from.height) * t,
    };
  }

  resolve(): ResolvedEnvironment {
    const frame = this.#kernel.time.frame;
    const cached = this.#cache;
    if (cached !== null && cached.frame === frame && cached.revision === this.#revision) return cached.value;
    const now = this.#kernel.time.now;
    const spec = this.#spec;
    const time = this.#time;
    const cycle = this.#dayLength > 0;
    const light = cycle ? daylight(time) : 1;
    const toSun = this.#toSun();
    const weather = this.#weather();
    const overcast = weather?.overcast ?? 0;

    let pal = this.#palette(now);
    if (cycle && this.#sky !== 'atmosphere') pal = cycled(pal, time);
    if (overcast > 0) {
      // Weather greys the sky toward an overcast (storm-dark) palette, as dark as the hour is.
      const grey = overcastPalette(Math.max(0, (overcast - 0.6) / 0.4));
      const lit = this.#sky === 'atmosphere' ? daylightAt(toSun.y) : light;
      const dark = 1 - (0.06 + 0.94 * lit);
      const dimmed: Palette = {
        zenith: grey.zenith.lerp(Color.BLACK, dark), horizon: grey.horizon.lerp(Color.BLACK, dark),
        ambient: grey.ambient.lerp(Color.BLACK, dark), sunColor: pal.sunColor, sunIntensity: pal.sunIntensity * (1 - 0.9 * overcast),
      };
      pal = lerpPalette(pal, dimmed, overcast);
    }
    let zenith = pal.zenith;
    let horizon = pal.horizon;
    let ambient = spec.ambient === null ? pal.ambient : cycle ? spec.ambient.lerp(Color.BLACK, 0.7 * (1 - light)) : spec.ambient;
    const sunColor = spec.sunColor === null ? pal.sunColor : spec.sunColor;
    const sunIntensity = spec.sunIntensity === null
      ? pal.sunIntensity
      : spec.sunIntensity * (cycle ? 0.1 + 0.9 * light : 1) * (1 - 0.9 * overcast);
    let fog: ResolvedFog = this.#currentFog(now);
    if (weather !== undefined) fog = this.#weatherFog(fog, weather.fog, horizon);

    for (const [id, zone] of this.#kernel.world.query([ENVIRONMENT_ZONE])) {
      const weight = (zone as { __weight__?: unknown }).__weight__;
      if (typeof weight !== 'number') {
        fail('PP9221', `environment_zone on entity ${id} has no __weight__`, { fix: 'EnvironmentZone weights come from the visuals plugin (core).' });
      }
      if (weight <= 0) continue;
      const z = zone as Fields;
      const density = z['fog_density'] as number | null;
      const fogColor = z['fog_color'] as Color | null;
      const zoneAmbient = z['ambient'] as Color | null;
      const tint = z['sky_tint'] as Color | null;
      if (density !== null || fogColor !== null) {
        fog = {
          ...fog,
          density: density === null ? fog.density : fog.density + (density - fog.density) * weight,
          color: fogColor === null ? fog.color : fog.color.lerp(fogColor, weight),
        };
      }
      if (zoneAmbient !== null) ambient = ambient.lerp(zoneAmbient, weight);
      if (tint !== null) {
        const by = Color.WHITE.lerp(tint, weight);
        zenith = multiply(zenith, by);
        horizon = multiply(horizon, by);
      }
    }

    const flash = weather?.flash ?? 0;
    if (flash > 0) {
      // Lightning: the sky and every shadow light up blue-white for an instant.
      const bolt = new Color(0.85, 0.9, 1);
      const k = Math.min(1, flash);
      ambient = ambient.lerp(bolt, 0.7 * k);
      zenith = zenith.lerp(bolt, 0.5 * k);
      horizon = horizon.lerp(bolt, 0.6 * k);
    }

    const value: ResolvedEnvironment = {
      frame,
      sky: this.#sky,
      zenith,
      horizon,
      clear: horizon,
      sunDirection: spec.sunDirection ?? lightDirection(time),
      sunColor,
      sunIntensity,
      shadowDistance: spec.sunShadowDistance ?? null,
      ambient,
      fog,
      post: this.#graded(this.#currentPost(now)),
      timeOfDay: time,
      day: this.#day,
      isNight: isNight(time),
      // Lights with when="night" follow this: in over the ~hour around dusk, out around dawn.
      night: 1 - daylight(time),
      toSun,
      atmosphere: this.#sky === 'atmosphere' ? this.#air() : null,
      clouds: this.#resolvedClouds(now, weather),
      // Stars come out in twilight, once the sun is below the horizon (not while it still sets).
      skybox: spec.skybox,
      stars: spec.skybox !== null ? 0 : this.#sky === 'night' ? 1 : this.#sky === 'atmosphere' || cycle ? starlight(toSun.y) : 0,
      flash,
    };
    this.#cache = { frame, revision: this.#revision, value };
    return value;
  }

  /**
   * Fog under an active weather. The weather owns exponential fog density: the scene's
   * authored density is replaced (check warns, PP3382), while one the game set at run time
   * (`ctx.environment.fog`) is thickened. The scene keeps colour, height falloff and
   * volumetrics. Linear fog: the far end draws nearer.
   */
  #weatherFog(fog: ResolvedFog, density: number, horizon: Color): ResolvedFog {
    if (fog.near !== null && fog.far !== null) {
      return { ...fog, far: Math.max(fog.near + 1, fog.far / (1 + (density * fog.far) / 3)) };
    }
    const base = this.#overridden.fog ? fog.density : 0;
    return { ...fog, density: base + density, color: this.#fog.color !== null ? fog.color : horizon };
  }

  /**
   * The cloud layer. Under an active weather, cover and darkness are the weather's (the
   * scene's layer gives density, height, thickness and scale, and the weather's overcast
   * thickens it); the game's run-time `ctx.environment.clouds` change still sets a floor.
   */
  #resolvedClouds(now: number, weather: WeatherConditions | undefined): ResolvedClouds | null {
    const own = this.#currentClouds(now);
    if (own === null && (weather === undefined || weather.clouds <= 0)) return null;
    const c = own ?? { ...DEFAULT_CLOUDS, coverage: 0 };
    const kept = weather === undefined || this.#overridden.clouds;
    const coverage = weather === undefined ? c.coverage : Math.max(kept ? c.coverage : 0, weather.clouds);
    if (coverage <= 0) return null;
    const overcast = weather?.overcast ?? 0;
    return {
      coverage,
      density: Math.max(c.density, 0.4 + 0.6 * overcast),
      base: c.height,
      thickness: c.thickness,
      scale: c.scale,
      offsetX: this.#drift[0],
      offsetZ: this.#drift[1],
      darkness: overcast * overcast,
    };
  }

  // ── Saves and snapshots ─────────────────────────────────────────────────────

  persist(): JsonObject {
    return {
      time_of_day: this.#time,
      day_length: this.#dayLength,
      day: this.#day,
      sky: this.#overridden.sky ? this.#sky : null,
      fog: this.#overridden.fog ? fogJson(this.#fog) : null,
      post: this.#post === null ? null : postLayerJson(this.#post),
      clouds: this.#overridden.clouds ? cloudsJson(this.#clouds) : null,
    };
  }

  load(state: Json): void {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) fail('PP3224', 'An environment save must be an object');
    const o = state as JsonObject;
    const known = ['time_of_day', 'day_length', 'day', 'sky', 'fog', 'post', 'clouds'];
    for (const key of Object.keys(o)) if (!known.includes(key)) fail('PP3224', `An environment save has an unknown key "${key}"`);
    if (o['time_of_day'] !== undefined) this.timeOfDay = o['time_of_day'] as number;
    if (o['day_length'] !== undefined) this.dayLength = o['day_length'] as number;
    if (o['day'] !== undefined) this.day = o['day'] as number;
    if (typeof o['sky'] === 'string') {
      this.#sky = skyPreset(o['sky'], 'environment save');
      this.#skyChange = null;
      this.#overridden.sky = true;
    }
    if (o['fog'] !== undefined && o['fog'] !== null) {
      const fog = fogFrom(o['fog'], 'environment save');
      checkFog(fog, 'environment save');
      this.#fog = fog;
      this.#fogChange = null;
      this.#overridden.fog = true;
    }
    if (o['post'] !== undefined && o['post'] !== null) {
      this.#post = postLayerFrom(o['post'], 'environment save');
      this.#postChange = null;
    }
    if (o['clouds'] !== undefined && o['clouds'] !== null) {
      this.#clouds = cloudsFrom(o['clouds'], 'environment save');
      this.#cloudChange = null;
      this.#overridden.clouds = true;
    }
    this.#steered();
  }

  snapshot(): JsonObject {
    const sky = this.#skyChange;
    const fog = this.#fogChange;
    return {
      time: this.#time,
      day_length: this.#dayLength,
      day: this.#day,
      sky: this.#sky,
      sky_change: sky === null ? null : { from: sky.from, start: sky.start, seconds: sky.seconds },
      fog: fogJson(this.#fog),
      fog_change: fog === null ? null : { from: fogJson(fog.from), start: fog.start, seconds: fog.seconds },
      post: this.#post === null ? null : postLayerJson(this.#post),
      post_change: this.#postChange === null
        ? null
        : { from: postSettingsJson(this.#postChange.from), start: this.#postChange.start, seconds: this.#postChange.seconds },
      clouds: cloudsJson(this.#clouds),
      cloud_change: this.#cloudChange === null
        ? null
        : { from: cloudsJson(this.#cloudChange.from), start: this.#cloudChange.start, seconds: this.#cloudChange.seconds },
      drift: [...this.#drift],
      overridden: { fog: this.#overridden.fog, sky: this.#overridden.sky, clouds: this.#overridden.clouds },
    };
  }

  restore(kernel: Kernel, state: Json): void {
    const o = state as JsonObject;
    this.#spec = kernel.scene === undefined ? DEFAULT_ENVIRONMENT : readEnvironmentSpec(kernel.scene);
    this.#time = o['time'] as number;
    this.#dayLength = o['day_length'] as number;
    this.#day = o['day'] as number;
    this.#sky = skyPreset(o['sky'], 'snapshot');
    const sky = o['sky_change'] as JsonObject | null;
    this.#skyChange = sky === null
      ? null
      : { from: skyPreset(sky['from'], 'snapshot'), start: sky['start'] as number, seconds: sky['seconds'] as number };
    this.#fog = fogFrom(o['fog']!, 'snapshot');
    const fog = o['fog_change'] as JsonObject | null;
    if (fog === null) {
      this.#fogChange = null;
    } else {
      const from = fogFrom(fog['from']!, 'snapshot');
      if (from.color === null) fail('PP9220', 'snapshot: a running fog change has no starting colour');
      this.#fogChange = { from: { ...from, color: from.color }, start: fog['start'] as number, seconds: fog['seconds'] as number };
    }
    this.#post = o['post'] === null || o['post'] === undefined ? null : postLayerFrom(o['post'], 'snapshot');
    const post = (o['post_change'] ?? null) as JsonObject | null;
    this.#postChange = post === null
      ? null
      : { from: postSettingsFrom(post['from']!, 'snapshot'), start: post['start'] as number, seconds: post['seconds'] as number };
    const overridden = o['overridden'] as JsonObject;
    this.#clouds = cloudsFrom(o['clouds'], 'snapshot');
    const clouds = (o['cloud_change'] ?? null) as JsonObject | null;
    this.#cloudChange = clouds === null
      ? null
      : { from: cloudsFrom(clouds['from'], 'snapshot')!, start: clouds['start'] as number, seconds: clouds['seconds'] as number };
    const drift = o['drift'] as number[];
    this.#drift = [drift[0]!, drift[1]!];
    this.#overridden = { fog: overridden['fog'] === true, sky: overridden['sky'] === true, clouds: overridden['clouds'] === true };
    this.#cache = null;
    this.#changed();
  }
}

/** The environment plugin. One value serves one kernel. */
export function environment(): EnvironmentPlugin {
  let state: EnvironmentState | undefined;
  const current = (): EnvironmentState => {
    if (state === undefined) fail('PP9222', 'The environment is used before its kernel was built');
    return state;
  };
  const clock: SystemDef = {
    id: 'environment_clock',
    scenes: [],
    handlers: [],
    create: () => ({ update: (_ctx: unknown, dt: number) => current().advance(dt) }),
  };

  return {
    id: 'environment',
    events: [DAY_CHANGED],
    systems: [clock],
    install(kernel) {
      if (state !== undefined) fail('PP3225', 'This environment plugin is already installed in another kernel', { fix: 'Build one per kernel.' });
      const created = new EnvironmentState(kernel);
      state = created;
      kernel.provide(ENVIRONMENT_SERVICE, created);
      // Net clients follow the server's course (a script's set_*, its fog and cloud changes).
      kernel.provide(ENVIRONMENT_SYNC_SERVICE, {
        get revision() { return created.course; },
        state: () => created.snapshot(),
        follow: (saved) => created.restore(kernel, saved),
      });
      kernel.observeScenes({ loading: (scene, request) => created.apply(readEnvironmentSpec(scene), request.newRun === true) });
    },
    control: current,
    snapshot: () => current().snapshot(),
    restore: (kernel, saved) => current().restore(kernel, saved),
  };
}
