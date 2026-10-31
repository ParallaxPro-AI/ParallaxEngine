/**
 * `parallax.weather` (sdk/parallax/weather.pyi): the WeatherChanged, LightningStruck and
 * Thunder events, `ctx.weather` and the `weather()` factory `parallax.plugins` re-exports.
 * The weather itself lives in the weather plugin; this module binds Python arguments.
 *
 *     # scenes/coast/scene.json: "environment": {"sky": "atmosphere", "weather": "storm"}
 *     ctx.weather.set("clear", seconds=60)
 *     speed *= ctx.weather.friction
 */

import { fail, Vec3 } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { PARAM_KEYS, weather as weatherPlugin, WEATHER_EVENTS } from '../function/plugins/weather/index.js';
import type { WeatherControl } from '../function/plugins/weather/index.js';
import { eventHandle } from './events.js';
import { bindArgs } from './kwargs.js';

/** `@on(WeatherChanged)`: preset, seconds (how long the blend takes). */
export const WeatherChanged = eventHandle(WEATHER_EVENTS.changed, 'WeatherChanged');
/** `@on(LightningStruck)`: point, strength (0..1). */
export const LightningStruck = eventHandle(WEATHER_EVENTS.struck, 'LightningStruck');
/** `@on(Thunder)`: point, strength, distance (m from the camera; it arrives distance / 343 s after the strike). */
export const Thunder = eventHandle(WEATHER_EVENTS.thunder, 'Thunder');

/** `ctx.weather`. */
export class WeatherApi {
  readonly #control: WeatherControl;

  constructor(control: WeatherControl) {
    this.#control = control;
  }

  get preset(): string { return this.#control.conditions().preset; }
  get rain(): number { return this.#control.conditions().rain; }
  get snow(): number { return this.#control.conditions().snow; }
  get hail(): number { return this.#control.conditions().hail; }
  get clouds(): number { return this.#control.conditions().clouds; }
  get fog(): number { return this.#control.conditions().fog; }
  get wind(): number { return this.#control.conditions().wind; }
  get lightning(): number { return this.#control.conditions().lightning; }
  get wetness(): number { return this.#control.conditions().wetness; }
  get snow_cover(): number { return this.#control.conditions().snowCover; }
  get visibility(): number { return this.#control.conditions().visibility; }
  get friction(): number { return this.#control.conditions().friction; }

  /** set(preset=None, *, seconds=30, rain=, snow=, hail=, clouds=, overcast=, fog=, wind=, lightning=) */
  set(...args: unknown[]): void {
    const a = bindArgs('set', args, { positional: ['preset'], keyword: ['seconds', ...PARAM_KEYS] }).args;
    const preset = a['preset'];
    if (preset !== undefined && preset !== null && typeof preset !== 'string') fail('PP3381', `weather.set preset must be a name, got ${String(preset)}`);
    const fields: Record<string, unknown> = {};
    for (const key of PARAM_KEYS) if (a[key] !== undefined) fields[key] = a[key];
    const seconds = a['seconds'] === undefined ? 30 : a['seconds'];
    if (typeof seconds !== 'number') fail('PP3381', `weather.set seconds must be a number, got ${String(seconds)}`);
    this.#control.set({ ...(typeof preset === 'string' && { preset }), seconds, fields });
  }

  /** strike(point=None): lightning now, at the point or somewhere around the camera. */
  strike(...args: unknown[]): void {
    const a = bindArgs('strike', args, { positional: ['point'] }).args;
    const p = a['point'];
    if (p !== undefined && p !== null && !(p instanceof Vec3)) fail('PP3381', 'strike() point must be a Vec3');
    this.#control.strike(p instanceof Vec3 ? p : undefined);
  }

  /** is_sheltered(point): something solid is above it (rain doesn't reach it). */
  is_sheltered(...args: unknown[]): boolean {
    const a = bindArgs('is_sheltered', args, { positional: ['point'], required: ['point'] }).args;
    if (!(a['point'] instanceof Vec3)) fail('PP3381', 'is_sheltered() point must be a Vec3');
    return this.#control.sheltered(a['point']);
  }
}

/** `parallax.plugins.weather()`. */
export function weather(...args: unknown[]): KernelPlugin {
  bindArgs('weather', args, {});
  const plugin = weatherPlugin();
  return { ...plugin, namespace: { name: 'weather', create: () => new WeatherApi(plugin.control()) } };
}
