/**
 * Weather presets and the scene's `"weather"` (in its environment block).
 *
 *   "weather": "rain"
 *   "weather": {"preset": "clear", "rain": 0.2, "wind": 9,                    a preset, fields overridden
 *               "cycle": {"clear": 3, "cloudy": 2, "rain": 1, "storm": 0.5},  and a director: weights of
 *               "hold": [90, 240], "blend": 30,                               what comes next, seconds each
 *               "lightning_radius": 600}                                      lasts, seconds to blend in;
 *                                                                             meters around the camera bolts strike
 *
 * A preset is a bundle of blendable numbers (`WeatherParams`). Fields given beside it
 * replace the preset's; `ctx.weather.set(...)` takes the same names.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';

export interface WeatherParams {
  /** 0..1 strength of rain, snow, hail. */
  readonly rain: number;
  readonly snow: number;
  readonly hail: number;
  /** 0..1 cloud cover. */
  readonly clouds: number;
  /** 0..1 grey sky and dim sun. */
  readonly overcast: number;
  /** Fog density per meter added to the scene's. */
  readonly fog: number;
  /** Mean wind, m/s. */
  readonly wind: number;
  /** Lightning strikes per minute. */
  readonly lightning: number;
}

export const PARAM_KEYS = ['rain', 'snow', 'hail', 'clouds', 'overcast', 'fog', 'wind', 'lightning'] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

const p = (rain: number, snow: number, hail: number, clouds: number, overcast: number, fog: number, wind: number, lightning: number): WeatherParams => ({
  rain, snow, hail, clouds, overcast, fog, wind, lightning,
});

export const WEATHER_PRESETS = {
  clear: p(0, 0, 0, 0.1, 0, 0, 2, 0),
  cloudy: p(0, 0, 0, 0.55, 0.25, 0, 4, 0),
  overcast: p(0, 0, 0, 0.9, 0.7, 0.002, 5, 0),
  foggy: p(0, 0, 0, 0.6, 0.5, 0.03, 1, 0),
  drizzle: p(0.25, 0, 0, 0.8, 0.6, 0.004, 3, 0),
  rain: p(0.65, 0, 0, 0.95, 0.8, 0.006, 6, 0),
  storm: p(1, 0, 0, 1, 1, 0.01, 14, 6),
  snow: p(0, 0.6, 0, 0.9, 0.6, 0.006, 3, 0),
  blizzard: p(0, 1, 0, 1, 0.9, 0.03, 16, 0),
  hail: p(0.3, 0, 0.8, 1, 0.9, 0.004, 10, 2),
} as const satisfies Record<string, WeatherParams>;
export type WeatherPreset = keyof typeof WEATHER_PRESETS;
export const WEATHER_PRESET_NAMES = Object.keys(WEATHER_PRESETS) as WeatherPreset[];

/** Upper bounds per parameter (lower bounds are 0). */
const LIMITS: Readonly<Record<ParamKey, number>> = { rain: 1, snow: 1, hail: 1, clouds: 1, overcast: 1, fog: 0.5, wind: 60, lightning: 120 };

export interface WeatherSpec {
  readonly preset: WeatherPreset;
  readonly params: WeatherParams;
  /** The director's weights (none: the weather holds). */
  readonly cycle: readonly { readonly preset: WeatherPreset; readonly weight: number }[];
  readonly hold: readonly [number, number];
  readonly blend: number;
  readonly lightningRadius: number;
  /** The game's sounds for the weather (none: silent): a rain loop and a thunderclap. */
  readonly sounds: WeatherSounds;
}

export interface WeatherSounds {
  readonly rain: string | null;
  readonly thunder: string | null;
}

export const SOUND_KEYS = ['rain', 'thunder'] as const;

const KEYS = ['preset', ...PARAM_KEYS, 'cycle', 'hold', 'blend', 'lightning_radius', 'sounds'] as const;

export const NO_WEATHER: WeatherSpec = {
  preset: 'clear', params: WEATHER_PRESETS.clear, cycle: [], hold: [120, 300], blend: 30, lightningRadius: 600,
  sounds: { rain: null, thunder: null },
};

export function presetNamed(name: unknown, problem: (message: string, fix: string) => never): WeatherPreset {
  if (typeof name === 'string' && (WEATHER_PRESET_NAMES as string[]).includes(name)) return name as WeatherPreset;
  const guess = typeof name === 'string' ? closestMatch(name, WEATHER_PRESET_NAMES) : undefined;
  return problem(`unknown weather preset ${JSON.stringify(name)}`, guess === undefined ? `Use one of: ${WEATHER_PRESET_NAMES.join(', ')}.` : `Did you mean "${guess}"?`);
}

/** A parameter value, checked: the problem (or undefined). */
export function paramProblem(key: ParamKey, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number`;
  if (value < 0 || value > LIMITS[key]) return `${key} is ${value}; it must be 0 to ${LIMITS[key]}`;
  return undefined;
}

/** Thrown to stop reading at the first problem when problems are collected. */
class Stop {}

/** The first problem with a `"weather"` value, as (pointer under /environment/weather, message, fix); check and runtime share the rules. */
export function weatherProblems(value: Json): { pointer: string; message: string; fix: string }[] {
  const out: { pointer: string; message: string; fix: string }[] = [];
  try {
    readWeather(value, (pointer) => (message, fix) => {
      out.push({ pointer, message, fix });
      throw new Stop();
    });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return out;
}

/** Read a `"weather"` value; `problem(pointer)` reports (and never returns). */
export function readWeather(value: Json, problem: (pointer: string) => (message: string, fix: string) => never): WeatherSpec {
  if (typeof value === 'string') {
    const preset = presetNamed(value, problem(''));
    return { ...NO_WEATHER, preset, params: WEATHER_PRESETS[preset] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return problem('')('weather must be a preset name or an object', 'Write "weather": "rain" or {"preset": "rain", ...}.');
  }
  const o = value as JsonObject;
  for (const key of Object.keys(o)) {
    if ((KEYS as readonly string[]).includes(key)) continue;
    const guess = closestMatch(key, KEYS);
    problem(`/${key}`)(`unknown key "${key}"`, guess === undefined ? `Keys here: ${KEYS.join(', ')}.` : `Did you mean "${guess}"?`);
  }
  const preset = o['preset'] === undefined ? 'clear' : presetNamed(o['preset'], problem('/preset'));
  const params: Record<ParamKey, number> = { ...WEATHER_PRESETS[preset] };
  for (const key of PARAM_KEYS) {
    if (o[key] === undefined) continue;
    const bad = paramProblem(key, o[key]);
    if (bad !== undefined) problem(`/${key}`)(bad, `Change ${key}.`);
    params[key] = o[key] as number;
  }
  const cycle: { preset: WeatherPreset; weight: number }[] = [];
  if (o['cycle'] !== undefined) {
    const c = o['cycle'];
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      problem('/cycle')('cycle must be an object of preset weights', 'e.g. "cycle": {"clear": 3, "rain": 1}.');
    }
    for (const [name, weight] of Object.entries(c as JsonObject)) {
      const p = presetNamed(name, problem(`/cycle/${name}`));
      if (typeof weight !== 'number' || !(weight > 0)) problem(`/cycle/${name}`)(`the weight of ${name} must be a number above 0`, 'Give a relative weight like 1 or 2.5.');
      cycle.push({ preset: p, weight: weight as number });
    }
    if (cycle.length === 0) problem('/cycle')('cycle names no presets', 'List at least one, e.g. {"clear": 1}.');
  }
  let hold: [number, number] = [...NO_WEATHER.hold];
  if (o['hold'] !== undefined) {
    const h = o['hold'];
    if (!Array.isArray(h) || h.length !== 2 || !h.every((n) => typeof n === 'number') || !((h[0] as number) > 0 && (h[0] as number) <= (h[1] as number))) {
      problem('/hold')('hold must be [min, max] seconds with 0 < min <= max', 'e.g. "hold": [90, 240].');
    }
    const [lo, hi] = h as number[];
    hold = [lo!, hi!];
  }
  const blend = o['blend'] === undefined ? NO_WEATHER.blend : o['blend'];
  if (typeof blend !== 'number' || !(blend >= 0)) problem('/blend')('blend must be seconds, at least 0', 'e.g. "blend": 30.');
  const radius = o['lightning_radius'] === undefined ? NO_WEATHER.lightningRadius : o['lightning_radius'];
  if (typeof radius !== 'number' || !(radius > 0)) problem('/lightning_radius')('lightning_radius must be meters above 0', 'e.g. 600.');
  const sounds: { rain: string | null; thunder: string | null } = { rain: null, thunder: null };
  if (o['sounds'] !== undefined) {
    const given = o['sounds'];
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
      problem('/sounds')('sounds must be an object naming the rain loop and the thunder', 'e.g. "sounds": {"rain": "sfx/rain_loop", "thunder": "sfx/thunder"}.');
    }
    for (const [key, value] of Object.entries(given as JsonObject)) {
      if (!(SOUND_KEYS as readonly string[]).includes(key)) {
        const guess = closestMatch(key, SOUND_KEYS);
        problem(`/sounds/${key}`)(`unknown sound "${key}"`, guess === undefined ? `Sounds here: ${SOUND_KEYS.join(', ')}.` : `Did you mean "${guess}"?`);
      }
      if (typeof value !== 'string' || value === '') problem(`/sounds/${key}`)(`sounds.${key} must name a sound`, 'e.g. "sfx/thunder".');
      sounds[key as 'rain' | 'thunder'] = value as string;
    }
  }
  return { preset, params, cycle, hold, blend: blend as number, lightningRadius: radius as number, sounds };
}

/**
 * Scene values a weather replaces while it is active (check warning PP3382): the weather
 * owns wind speed and gusts, cloud cover, fog density and the sky's mood.
 * `key` is the weather field to set instead.
 */
export function weatherOverrides(environment: JsonObject, wind: Json | undefined): { pointer: string; what: string; key: ParamKey }[] {
  const out: { pointer: string; what: string; key: ParamKey }[] = [];
  const has = (o: Json | undefined, key: string): boolean =>
    typeof o === 'object' && o !== null && !Array.isArray(o) && (o as JsonObject)[key] !== undefined;
  if (has(wind, 'speed')) out.push({ pointer: '/wind/speed', what: 'wind "speed"', key: 'wind' });
  if (has(wind, 'gusts')) out.push({ pointer: '/wind/gusts', what: 'wind "gusts"', key: 'wind' });
  if (has(environment['clouds'], 'coverage')) out.push({ pointer: '/environment/clouds/coverage', what: 'clouds "coverage"', key: 'clouds' });
  if (has(environment['fog'], 'density')) out.push({ pointer: '/environment/fog/density', what: 'fog "density"', key: 'fog' });
  return out;
}

/** The scene's weather (clear and still without a "weather" key). PP3380 on a bad value. */
export function readWeatherSpec(scene: SceneDoc): WeatherSpec {
  const value = scene.environment?.['weather'];
  if (value === undefined) return NO_WEATHER;
  return readWeather(value, (pointer) => (message, fix) => fail('PP3380', `Scene "${scene.id}" weather: ${message}`, {
    fix, path: scene.path, pointer: `/environment/weather${pointer}`,
  }));
}

export function lerpParams(a: WeatherParams, b: WeatherParams, t: number): WeatherParams {
  const out: Record<ParamKey, number> = { ...a };
  for (const key of PARAM_KEYS) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}
