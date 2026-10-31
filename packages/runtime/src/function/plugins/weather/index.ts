/**
 * weather — rain, snow, hail, fog, wind and lightning, blended between presets
 * (sdk/parallax/weather.pyi). The scene's environment block names it
 * (`"weather": "storm"` or an object with a director cycle: presets.ts).
 *
 * The plugin is game state only (director.ts); it provides the `weather` service
 * (function/services/weather.ts) and everyone else reads it:
 *
 *   environment  greys the sky, dims the sun, thickens fog, adds cloud, flashes with lightning
 *   render3d     draws rain/snow/hail where the sky isn't covered, bolts, wet and snowy surfaces
 *   wind         blows the weather's wind (when the wind plugin is in the game)
 *   water        grows ocean and lake waves with the wind
 *   gameplay     `ctx.weather.friction` / `visibility`; other plugins read the service
 *
 * Sounds: the scene's weather may name a rain loop and a thunderclap (`"sounds": {"rain":
 * ..., "thunder": ...}`); the plugin plays them through the audio service — the loop at
 * the rain's strength, the thunder when its `thunder` event fires — and is silent without.
 *
 * Net: the course (preset blends, the director's schedule and random stream, strikes) is
 * `weather_sync` (services/sync.ts); a client follows the server's whenever it changes.
 *
 * Events: `weather_changed(preset, seconds)` when the director (or `set`) heads somewhere
 * new, `lightning_struck(point, strength)` at the strike, `thunder(point, strength,
 * distance)` when its sound reaches the anchor (the first camera).
 */

import { fail, hashNumbers, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { EventDef, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { AUDIO_SERVICE, PHYSICS3D_SERVICE, TERRAIN_SERVICE, WEATHER_SERVICE, WEATHER_SYNC_SERVICE, WIND_SERVICE } from '../../services/index.js';
import type { LightningStrike, WeatherConditions, WeatherService } from '../../services/index.js';
import { WeatherDirector } from './director.js';
import type { DirectorEvents, DirectorWorld } from './director.js';
import { NO_WEATHER, paramProblem, PARAM_KEYS, presetNamed, readWeatherSpec, WEATHER_PRESETS } from './presets.js';
import type { ParamKey, WeatherParams, WeatherPreset, WeatherSpec } from './presets.js';

export { BOLT_HEIGHT, FLICKERS, MIN_STRIKE_INTERVAL, SPEED_OF_SOUND, WeatherDirector } from './director.js';
export {
  lerpParams, NO_WEATHER, PARAM_KEYS, readWeather, readWeatherSpec, WEATHER_PRESET_NAMES, WEATHER_PRESETS, weatherOverrides, weatherProblems,
} from './presets.js';
export type { WeatherParams, WeatherPreset, WeatherSpec } from './presets.js';

export const WEATHER_EVENTS = {
  changed: { id: 'weather_changed' },
  struck: { id: 'lightning_struck' },
  thunder: { id: 'thunder' },
} as const satisfies Record<string, EventDef>;

/** The rain loop's key with the audio service. */
const RAIN_LOOP = 'weather.rain';

/** A thunderclap's volume: its strength, falling to a quarter over 3 km. */
export function thunderVolume(strength: number, distance: number): number {
  return Math.round(strength * (1 - 0.75 * Math.min(1, distance / 3000)) * 1000) / 1000;
}

/** Meters above a point that count as cover (a roof, a tree, a bridge). */
export const SHELTER_REACH = 60;
const CAMERA = 'camera';

/** What `ctx.weather.set(...)` passes. */
export interface WeatherChange {
  readonly preset?: string;
  readonly seconds: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The engine side of `ctx.weather`. */
export interface WeatherControl {
  conditions(): WeatherConditions;
  set(change: WeatherChange): void;
  strike(point: Vec3 | undefined): LightningStrike;
  sheltered(point: Vec3): boolean;
}

export interface WeatherPlugin extends KernelPlugin {
  control(): WeatherControl;
}

class WeatherState implements WeatherService, WeatherControl, DirectorWorld, DirectorEvents {
  readonly #kernel: Kernel;
  #spec: WeatherSpec = NO_WEATHER;
  #director: WeatherDirector;
  #active = false;
  #windPending = false;
  /** Bumped when the weather's course changes (net clients follow it: WEATHER_SYNC_SERVICE). */
  course = 0;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
    this.#director = new WeatherDirector(NO_WEATHER, 0, 0);
  }

  load(spec: WeatherSpec, seed: number, active: boolean): void {
    this.#spec = spec;
    this.#active = active;
    this.#director = new WeatherDirector(spec, hashNumbers(seed, 0x77ea), this.#kernel.time.now);
    if (active) this.#blowWind(spec.params.wind, 0);
    // The wind plugin may read the scene's own "wind" after this (plugin order): blow again
    // on the first step unless a `set` has taken the wind somewhere since.
    this.#windPending = active;
    // A new scene's weather starts quiet (its own rain sound, if any, comes in with its rain).
    this.#kernel.tryService(AUDIO_SERVICE)?.stop(RAIN_LOOP);
    this.course++;
  }

  // ── WEATHER_SERVICE ─────────────────────────────────────────────────────────

  conditions(): WeatherConditions {
    return this.#director.conditions(this.#kernel.time.now);
  }

  /**
   * Whether a weather is running: the scene names one, or `ctx.weather.set` started one.
   * While active the weather owns wind speed and gusts, cloud cover, fog density and the
   * sky's mood; inactive, the scene's own values stand.
   */
  active(): boolean {
    return this.#active;
  }

  recentStrikes(seconds: number): readonly LightningStrike[] {
    return this.#director.recentStrikes(this.#kernel.time.now, seconds);
  }

  sheltered(point: Vec3, ignore: readonly EntityId[] = []): boolean {
    const physics = this.#kernel.tryService(PHYSICS3D_SERVICE);
    if (physics === undefined) return false;
    return physics.raycast(point.__add__(new Vec3(0, 0.05, 0)), Vec3.UP, SHELTER_REACH, ignore.length > 0 ? { ignore: [...ignore] } : undefined) !== undefined;
  }

  // ── ctx.weather ─────────────────────────────────────────────────────────────

  set(change: WeatherChange): void {
    if (!(Number.isFinite(change.seconds) && change.seconds >= 0)) fail('PP3381', `weather.set seconds is ${change.seconds}; it can't be negative`);
    const problem = (message: string, fix: string): never => fail('PP3381', `weather.set: ${message}`, { fix });
    const preset: WeatherPreset = change.preset === undefined ? this.#director.preset : presetNamed(change.preset, problem);
    const base = change.preset === undefined ? this.#director.params(this.#kernel.time.now) : WEATHER_PRESETS[preset];
    const params: Record<ParamKey, number> = { ...base };
    for (const [key, value] of Object.entries(change.fields)) {
      if (!(PARAM_KEYS as readonly string[]).includes(key)) problem(`unknown setting "${key}"`, `Settings: ${PARAM_KEYS.join(', ')}.`);
      const bad = paramProblem(key as ParamKey, value);
      if (bad !== undefined) problem(bad, `Pass ${key} in range.`);
      params[key as ParamKey] = value as number;
    }
    this.#director.set(preset, params, change.seconds, this.#kernel.time.now);
    this.changed(preset, change.seconds, params);
  }

  strike(point: Vec3 | undefined): LightningStrike {
    return this.#director.strike(this.#kernel.time.now, point, this, this);
  }

  // ── The director's world ────────────────────────────────────────────────────

  anchor(): Vec3 {
    for (const [id] of this.#kernel.world.query([CAMERA])) return this.#kernel.world.require(id).transform.worldPosition();
    return Vec3.ZERO;
  }

  ground(x: number, z: number, from: Vec3): number {
    const physics = this.#kernel.tryService(PHYSICS3D_SERVICE);
    const top = from.y + 2000;
    const hit = physics?.raycast(new Vec3(x, top, z), new Vec3(0, -1, 0), 6000);
    if (hit !== undefined) return hit.point.y;
    const terrain = this.#kernel.tryService(TERRAIN_SERVICE)?.current();
    return terrain === null || terrain === undefined ? 0 : terrain.heightAt(x, z);
  }

  struck(strike: LightningStrike): void {
    this.course++;
    this.#kernel.emit(WEATHER_EVENTS.struck, { point: strike.point, strength: strike.strength });
  }

  thunder(strike: LightningStrike, distance: number): void {
    this.#kernel.emit(WEATHER_EVENTS.thunder, { point: strike.point, strength: strike.strength, distance });
    const sound = this.#spec.sounds.thunder;
    // Heard everywhere (thunder carries for kilometres), quieter and lower with distance.
    if (sound !== null) {
      this.#kernel.tryService(AUDIO_SERVICE)?.play({ sound, volume: thunderVolume(strike.strength, distance), pitch: distance > 1500 ? 0.85 : 1 });
    }
  }

  /** The rain loop follows how hard it rains (hail counts): silent at none, or without a "rain" sound. */
  #rainSound(): void {
    const sound = this.#spec.sounds.rain;
    const audio = this.#kernel.tryService(AUDIO_SERVICE);
    if (sound === null || audio === undefined) return;
    const c = this.conditions();
    const level = Math.round(Math.min(1, c.rain + 0.5 * c.hail) * 100) / 100;
    if (level > 0) audio.loop(RAIN_LOOP, { sound, volume: level });
    else audio.stop(RAIN_LOOP, 2);
  }

  changed(preset: WeatherPreset, seconds: number, params: WeatherParams): void {
    this.course++;
    this.#active = true;
    this.#windPending = false;
    this.#blowWind(params.wind, seconds);
    this.#kernel.emit(WEATHER_EVENTS.changed, { preset, seconds });
  }

  /** The wind plugin blows the weather's wind, gustier as it rises (0.2 calm, 0.8 at 15 m/s and up). */
  #blowWind(speed: number, seconds: number): void {
    this.#kernel.tryService(WIND_SERVICE)?.set({ speed, gusts: Math.min(0.8, 0.2 + speed / 25), seconds });
  }

  // ── The clock ───────────────────────────────────────────────────────────────

  advance(dt: number): void {
    if (dt <= 0) return;
    if (this.#windPending) {
      this.#windPending = false;
      this.#blowWind(this.#director.params(this.#kernel.time.now).wind, 0);
    }
    this.#director.step(this.#kernel.time.now, dt, this, this);
    this.#rainSound();
  }

  snapshot(): Json {
    return { ...this.#director.snapshot(), active: this.#active };
  }

  restore(kernel: Kernel, state: Json): void {
    this.#spec = kernel.scene === undefined ? NO_WEATHER : readWeatherSpec(kernel.scene);
    this.#director = new WeatherDirector(this.#spec, 0, kernel.time.now);
    this.#follow(state as JsonObject, kernel.scene?.environment?.['weather'] !== undefined);
    this.#windPending = false;
  }

  /** A net client takes over its server's weather as it is (same scene, same game time). */
  follow(state: Json): void {
    this.#follow(state as JsonObject, this.#active);
  }

  #follow(state: JsonObject, fallbackActive: boolean): void {
    this.#director.restore(state);
    this.#active = typeof state['active'] === 'boolean' ? state['active'] : fallbackActive;
  }
}

/** The weather plugin. One value serves one kernel. */
export function weather(): WeatherPlugin {
  let state: WeatherState | undefined;
  const current = (): WeatherState => {
    if (state === undefined) fail('PP9250', 'The weather plugin is used before its kernel was built');
    return state;
  };
  const clock: SystemDef = {
    id: 'weather_clock',
    scenes: [],
    handlers: [],
    create: () => ({ update: (_ctx: unknown, dt: number) => current().advance(dt) }),
  };
  return {
    id: 'weather',
    events: Object.values(WEATHER_EVENTS),
    systems: [clock],
    install(kernel) {
      if (state !== undefined) fail('PP3247', 'This weather plugin is already installed in another kernel', { fix: 'Call weather() once per kernel.' });
      const created = new WeatherState(kernel);
      state = created;
      kernel.provide(WEATHER_SERVICE, created);
      kernel.provide(WEATHER_SYNC_SERVICE, {
        get revision() { return created.course; },
        state: () => created.snapshot(),
        follow: (saved) => created.follow(saved),
      });
      kernel.observeScenes({
        loading: (scene, request) => created.load(readWeatherSpec(scene), request.seed ?? 0, scene.environment?.['weather'] !== undefined),
      });
    },
    control: current,
    snapshot: () => current().snapshot(),
    restore: (kernel, saved) => current().restore(kernel, saved),
  };
}
