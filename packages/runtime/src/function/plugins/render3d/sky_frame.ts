/**
 * The outdoors for one frame (`Frame3d.nature`): the sky model and clouds (environment
 * service), water (water_frame.ts), and weather on surfaces with rain, snow, splashes and
 * bolts (weather_frame.ts). Each part is null when its service is absent, and the sky is
 * only described when the per-pixel sky adds something over the plain gradient (the
 * "atmosphere" preset, a cloud layer, stars, lightning, or water or weather to go with it):
 * a scene with none of these renders exactly as before.
 */

import { EARTH_ATMOSPHERE } from '../../../core/index.js';
import type { BillboardBatch, Clouds3d, Environment3d, Line3d, Nature3d, Quality3d, Sky3d, View3d } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE } from '../../services/index.js';
import { WaterVisuals } from './water_frame.js';
import { WeatherVisuals } from './weather_frame.js';

export interface NatureFrame {
  readonly frame: Nature3d | null;
  readonly billboards: readonly BillboardBatch[];
  readonly lines: readonly Line3d[];
  /** The water plugin draws the scene's water (the terrain's flat plane is left out). */
  readonly hidesTerrainWater: boolean;
}

export class NatureDraws {
  readonly #water = new WaterVisuals();
  readonly #weather = new WeatherVisuals();

  build(kernel: Kernel, views: readonly View3d[], environment: Environment3d, quality: Quality3d): NatureFrame {
    const water = this.#water.build(kernel, environment.ambient);
    const weather = this.#weather.build(kernel, views[0], environment.ambient, quality);
    const sky = skyOf(kernel, environment, water.frame !== null || weather.frame !== null);
    const frame = sky === null && water.frame === null && weather.frame === null ? null : { sky, water: water.frame, weather: weather.frame };
    return {
      frame,
      billboards: [...water.billboards, ...weather.billboards],
      lines: weather.lines,
      hidesTerrainWater: water.frame !== null,
    };
  }
}

function skyOf(kernel: Kernel, environment: Environment3d, outdoors: boolean): Sky3d | null {
  const service = kernel.tryService(ENVIRONMENT_SERVICE);
  if (service === undefined) return null;
  const r = service.resolve();
  if (r.atmosphere === null && r.clouds === null && r.stars <= 0 && r.flash <= 0 && !outdoors) return null;
  const c = r.clouds;
  const clouds: Clouds3d | null = c === null
    ? null
    : { coverage: c.coverage, density: c.density, base: c.base, thickness: c.thickness, offset: [c.offsetX, c.offsetZ], scale: c.scale, darkness: c.darkness };
  const sun = environment.sun;
  return {
    model: r.atmosphere === null ? 'gradient' : 'atmosphere',
    zenith: environment.sky.zenith,
    horizon: environment.sky.horizon,
    toSun: [r.toSun.x, r.toSun.y, r.toSun.z],
    sunColor: sun === null ? [r.sunColor.r, r.sunColor.g, r.sunColor.b] : sun.color,
    sunIntensity: sun === null ? 0 : sun.intensity,
    atmosphere: r.atmosphere ?? EARTH_ATMOSPHERE,
    clouds,
    stars: r.stars,
    flash: r.flash,
    time: kernel.time.now,
  };
}
