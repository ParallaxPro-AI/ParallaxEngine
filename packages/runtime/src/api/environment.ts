/**
 * `ctx.environment` (sdk `EnvironmentApi`) and the `DayChanged` event, both in the
 * `parallax` module, and `coreEnvironment()`, the core plugin the runtime includes in
 * every game. The look itself lives in the environment plugin and its `environment`
 * service; this module binds Python arguments.
 */

import { Color, fail } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { DAY_CHANGED, environment, POST_FIELDS, POST_GROUPS } from '../function/plugins/environment/index.js';
import type { EnvironmentControl, FogChange } from '../function/plugins/environment/index.js';
import { eventHandle } from './events.js';
import { bindArgs } from './kwargs.js';
import { dictEntries } from './py.js';

export const DayChanged = eventHandle(DAY_CHANGED, 'DayChanged');

function number(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3223', `${where} must be a number, got ${value === null || value === undefined ? 'None' : String(value)}`);
}

/** `ctx.environment`: the scene-wide look, changed at runtime. */
export class EnvironmentApi {
  readonly #control: EnvironmentControl;

  constructor(control: EnvironmentControl) {
    this.#control = control;
  }

  get time_of_day(): number { return this.#control.timeOfDay; }
  set time_of_day(value: number) { this.#control.timeOfDay = number(value, 'time_of_day'); }

  get day_length(): number { return this.#control.dayLength; }
  set day_length(value: number) { this.#control.dayLength = number(value, 'day_length'); }

  get day(): number { return this.#control.day; }
  set day(value: number) { this.#control.day = number(value, 'day'); }

  get is_night(): boolean { return this.#control.isNight; }

  /** fog(density=None, *, near=None, far=None, color=None, volumetric=None, height_falloff=None, height=None, seconds=1) */
  fog(...args: unknown[]): void {
    const a = bindArgs('fog', args, { positional: ['density'], keyword: ['near', 'far', 'color', 'volumetric', 'height_falloff', 'height', 'seconds'] }).args;
    const given = (key: string): boolean => a[key] !== undefined && a[key] !== null;
    const color = a['color'];
    if (given('color') && !(color instanceof Color)) fail('PP3223', `fog() color must be a Color, got ${String(color)}`);
    const change: FogChange = {
      ...(given('density') && { density: number(a['density'], 'fog() density') }),
      ...(given('near') && { near: number(a['near'], 'fog() near') }),
      ...(given('far') && { far: number(a['far'], 'fog() far') }),
      ...(given('color') && { color: color as Color }),
      ...(given('volumetric') && { volumetric: number(a['volumetric'], 'fog() volumetric') }),
      ...(given('height_falloff') && { heightFalloff: number(a['height_falloff'], 'fog() height_falloff') }),
      ...(given('height') && { height: number(a['height'], 'fog() height') }),
      seconds: a['seconds'] === undefined ? 1 : number(a['seconds'], 'fog() seconds'),
    };
    this.#control.fog(change);
  }

  /**
   * post(preset=None, *, seconds=0, <any post setting>=...) — change post-processing at
   * runtime: a preset replaces the scene's look, settings override it; post() with nothing
   * goes back to the scene's own. Numbers blend over `seconds`.
   */
  post(...args: unknown[]): void {
    const keys = [...POST_FIELDS.filter((f) => f.group === undefined).map((f) => f.key), ...POST_GROUPS];
    const a = bindArgs('post', args, { positional: ['preset'], keyword: ['seconds', ...keys] }).args;
    const preset = a['preset'];
    if (preset !== undefined && preset !== null && typeof preset !== 'string') fail('PP3226', `post() preset must be a name, got ${String(preset)}`);
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      if (a[key] === undefined) continue;
      // A group (stylize={"pixelate": 4}) arrives as a dict.
      fields[key] = (POST_GROUPS as readonly string[]).includes(key) ? Object.fromEntries(dictEntries(a[key], `post() ${key}`)) : a[key];
    }
    this.#control.post({
      ...(typeof preset === 'string' && { preset }),
      fields,
      seconds: a['seconds'] === undefined ? 0 : number(a['seconds'], 'post() seconds'),
    });
  }

  /** clouds(coverage=None, *, density=None, speed=None, direction=None, seconds=1) — the drifting cloud layer; clouds(0) clears it. */
  clouds(...args: unknown[]): void {
    const a = bindArgs('clouds', args, { positional: ['coverage'], keyword: ['density', 'speed', 'direction', 'seconds'] }).args;
    const given = (key: string): boolean => a[key] !== undefined && a[key] !== null;
    this.#control.clouds({
      ...(given('coverage') && { coverage: number(a['coverage'], 'clouds() coverage') }),
      ...(given('density') && { density: number(a['density'], 'clouds() density') }),
      ...(given('speed') && { speed: number(a['speed'], 'clouds() speed') }),
      ...(given('direction') && { direction: number(a['direction'], 'clouds() direction') }),
      seconds: a['seconds'] === undefined ? 1 : number(a['seconds'], 'clouds() seconds'),
    });
  }

  /** The cloud layer's coverage now, 0..1 (weather included). */
  get cloud_cover(): number {
    return this.#control.cloudCover?.coverage ?? 0;
  }

  /** sky(preset, *, seconds=1) */
  sky(...args: unknown[]): void {
    const a = bindArgs('sky', args, { positional: ['preset'], keyword: ['seconds'], required: ['preset'] }).args;
    if (typeof a['preset'] !== 'string') fail('PP3221', `sky() preset must be a name, got ${String(a['preset'])}`);
    this.#control.sky(a['preset'], a['seconds'] === undefined ? 1 : number(a['seconds'], 'sky() seconds'));
  }
}

/** The core environment plugin with `ctx.environment` mounted (the runtime adds it to every game). */
export function coreEnvironment(): KernelPlugin {
  const plugin = environment();
  return { ...plugin, namespace: { name: 'environment', create: () => new EnvironmentApi(plugin.control()) } };
}
