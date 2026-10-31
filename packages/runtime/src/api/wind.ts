/**
 * `parallax.wind` (sdk/parallax/wind.pyi): `WindApi`, the type of `ctx.wind`, and the
 * `wind()` plugin factory (`parallax.plugins.wind`). The field lives in the wind plugin and
 * its `wind` service; this module binds Python arguments.
 */

import { fail, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { bearing, wind as windPlugin } from '../function/plugins/wind/index.js';
import { WIND_SERVICE } from '../function/services/index.js';
import type { WindChange } from '../function/services/index.js';
import { bindArgs } from './kwargs.js';

function describe(value: unknown): string {
  return value === null || value === undefined ? 'None' : String(value);
}

/** `ctx.wind`: the air the scene's things move through. */
export class WindApi {
  readonly #kernel: Kernel;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  get #service() {
    return this.#kernel.service(WIND_SERVICE);
  }

  /** Wind velocity (m/s, horizontal) at a point now, gusts included. */
  at(...args: unknown[]): Vec3 {
    const p = bindArgs('at', args, { positional: ['point'], required: ['point'] }).args['point'];
    if (!(p instanceof Vec3)) fail('PP3213', `wind.at() point must be a Vec3, got ${describe(p)}`);
    const v = this.#service.sample(p.x, p.z);
    return new Vec3(v[0]!, 0, v[1]!);
  }

  /** Unit direction the wind blows toward. */
  get direction(): Vec3 {
    const s = this.#service.settings();
    return new Vec3(s.dirX, 0, s.dirZ);
  }

  get speed(): number {
    return this.#service.settings().speed;
  }

  get gusts(): number {
    return this.#service.settings().gusts;
  }

  /** Change the wind, eased in over `seconds` of game time. */
  set(...args: unknown[]): void {
    const a = bindArgs('set', args, { keyword: ['direction', 'speed', 'gusts', 'seconds'] }).args;
    const change: { -readonly [K in keyof WindChange]: WindChange[K] } = {};
    const d = a['direction'];
    if (d instanceof Vec3) {
      change.dirX = d.x;
      change.dirZ = d.z;
    } else if (typeof d === 'number' && Number.isFinite(d)) {
      [change.dirX, change.dirZ] = bearing(d);
    } else if (d !== undefined && d !== null) {
      fail('PP3237', `wind.set direction must be a Vec3 or degrees, got ${describe(d)}`);
    }
    for (const key of ['speed', 'gusts', 'seconds'] as const) {
      const v = a[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number') fail('PP3237', `wind.set ${key} must be a number, got ${describe(v)}`);
      change[key] = v;
    }
    this.#service.set(change);
  }
}

/** `parallax.plugins.wind()`. */
export function wind(...args: unknown[]): KernelPlugin {
  bindArgs('wind', args, {});
  return { ...windPlugin(), namespace: { name: 'wind', create: (kernel) => new WindApi(kernel) } };
}
