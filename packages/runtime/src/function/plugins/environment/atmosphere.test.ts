/**
 * The physically based sky: colors at sun angles (blue noon, red sunset, dark night), the
 * sun reddening through the air, the "atmosphere" preset following the day cycle, clouds
 * from data and `clouds()`, and their drift being saved in snapshots.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE } from '../../services/index.js';
import { atmosphereLight, atmospherePalette, EARTH_ATMOSPHERE, environment, miePhase, rayleighPhase, skyRadiance, sunTransmittance, toSunAt } from './index.js';
import type { EnvironmentPlugin } from './index.js';
import { Vec3 } from '../../../core/index.js';

const deg = (d: number): [number, number, number] => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180), 0];

describe('scattering', () => {
  it('a high sun makes a blue sky: blue > green > red at the zenith', () => {
    const [r, g, b] = skyRadiance(EARTH_ATMOSPHERE, [0, 1, 0], deg(50));
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });

  it('a setting sun: the horizon under it turns orange-red, the zenith deepens, the sunlight reddens', () => {
    const low = deg(2);
    const [r, g, b] = skyRadiance(EARTH_ATMOSPHERE, [Math.cos(0.05), Math.sin(0.05), 0], low);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const noon = atmosphereLight(EARTH_ATMOSPHERE, deg(60));
    const dusk = atmosphereLight(EARTH_ATMOSPHERE, deg(2));
    expect(dusk.zenith[2]).toBeLessThan(noon.zenith[2] * 0.4);
    const sun = sunTransmittance(EARTH_ATMOSPHERE, deg(2));
    expect(sun[0] / sun[2]).toBeGreaterThan(5);
    const high = sunTransmittance(EARTH_ATMOSPHERE, deg(80));
    expect(high[0]).toBeGreaterThan(0.85);
    expect(high[2]).toBeGreaterThan(0.6);
  });

  it('night: the sun below the horizon leaves the sky nearly black and sends no sunlight', () => {
    const night = atmosphereLight(EARTH_ATMOSPHERE, deg(-12));
    expect(Math.max(...night.zenith)).toBeLessThan(0.002);
    expect(sunTransmittance(EARTH_ATMOSPHERE, deg(-3))).toEqual([0, 0, 0]);
  });

  it('haze scatters forward (Mie) where air scatters evenly (Rayleigh)', () => {
    expect(miePhase(1, 0.8) / miePhase(-1, 0.8)).toBeGreaterThan(100);
    expect(rayleighPhase(1)).toBeCloseTo(rayleighPhase(-1), 12);
    // Calibrated: a clear noon horizon near 0.75 of display white.
    const h = atmosphereLight(EARTH_ATMOSPHERE, deg(60)).horizon;
    expect(0.2126 * h[0] + 0.7152 * h[1] + 0.0722 * h[2]).toBeGreaterThan(0.6);
  });

  it('the palette follows the sun: blue noon, warm sunset sun, the night palette after dusk', () => {
    const noon = atmospherePalette(EARTH_ATMOSPHERE, toSunAt(12));
    expect(noon.zenith.b).toBeGreaterThan(noon.zenith.r);
    expect(noon.sunIntensity).toBeGreaterThan(0.9);
    const sunset = atmospherePalette(EARTH_ATMOSPHERE, toSunAt(17.8));
    expect(sunset.sunColor.r).toBeGreaterThan(sunset.sunColor.b * 1.5);
    expect(sunset.horizon.r).toBeGreaterThan(sunset.horizon.b);
    const night = atmospherePalette(EARTH_ATMOSPHERE, toSunAt(23));
    expect(night.zenith.r + night.zenith.g + night.zenith.b).toBeLessThan(0.2);
  });
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function kernelWith(env: JsonObject): { kernel: Kernel; plugin: EnvironmentPlugin } {
  const project = loadProject(files({ 'scenes/main/scene.json': { environment: env, entities: [] } }));
  expect(project.diagnostics).toEqual([]);
  const plugin = environment();
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins: [plugin], context: {}, fixedStep: 1 / 30,
  });
  kernel.start('main');
  return { kernel, plugin };
}

describe('the atmosphere sky in a scene', () => {
  it('resolves the scattering model, the sun toward its hour, and stars at night', () => {
    const { kernel, plugin } = kernelWith({ sky: 'atmosphere', time_of_day: 12, atmosphere: { haze: 2, sun_size: 3 } });
    const day = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(day.atmosphere?.mie).toBeCloseTo(EARTH_ATMOSPHERE.mie * 2, 12);
    expect(day.atmosphere?.sunRadius).toBeCloseTo(EARTH_ATMOSPHERE.sunRadius * 3, 12);
    expect(day.toSun.y).toBeGreaterThan(0.9);
    expect(day.stars).toBe(0);
    plugin.control().timeOfDay = 1;
    kernel.step(1 / 30);
    const night = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(night.toSun.y).toBeLessThan(0);
    expect(night.stars).toBe(1);
    expect(kernelWith({ sky: 'clear_day' }).kernel.service(ENVIRONMENT_SERVICE).resolve().atmosphere).toBeNull();
  });

  it('a fixed sun direction points the sky\'s sun the other way', () => {
    const { kernel } = kernelWith({ sky: 'atmosphere', sun: { direction: [0, -1, 1] } });
    const toSun = kernel.service(ENVIRONMENT_SERVICE).resolve().toSun;
    expect(toSun.is_close(new Vec3(0, 1, -1).normalized())).toBe(true);
  });

  it('clouds come from data, drift at their speed and direction, change with clouds(), and survive a snapshot', () => {
    const { kernel, plugin } = kernelWith({ clouds: { coverage: 0.3, speed: 10, direction: 90 } });
    kernel.step(1);
    const c = kernel.service(ENVIRONMENT_SERVICE).resolve().clouds!;
    expect(c.coverage).toBe(0.3);
    expect(c.offsetX).toBeCloseTo(10, 6);
    expect(Math.abs(c.offsetZ)).toBeLessThan(1e-6);
    plugin.control().clouds({ coverage: 0.9, seconds: 2 });
    kernel.step(1);
    expect(kernel.service(ENVIRONMENT_SERVICE).resolve().clouds!.coverage).toBeCloseTo(0.6, 6);
    const saved = kernel.snapshot();
    kernel.step(1);
    const later = kernel.service(ENVIRONMENT_SERVICE).resolve().clouds!;
    kernel.restore(saved);
    kernel.step(1);
    expect(kernel.service(ENVIRONMENT_SERVICE).resolve().clouds).toEqual(later);
    expect(() => plugin.control().clouds({ coverage: 2, seconds: 0 })).toThrow(/PP3228/);
    plugin.control().clouds({ coverage: 0, seconds: 0 });
    expect(kernel.service(ENVIRONMENT_SERVICE).resolve().clouds).toBeNull();
  });

  it('rejects bad cloud and atmosphere data (PP3220)', () => {
    const bad = (env: JsonObject) => () => kernelWith(env);
    expect(bad({ clouds: { coverage: 3 } })).toThrow(/PP3220[\s\S]*coverage/);
    expect(bad({ clouds: { cover: 0.3 } })).toThrow(/PP3220[\s\S]*coverage/);
    expect(bad({ atmosphere: { haze: -1 } })).toThrow(/PP3220[\s\S]*haze/);
  });
});
