/**
 * `parallax.water`, `parallax.weather` and the environment's new calls, as compiled Python
 * calls them: Python argument binding, handles, events and errors.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../core/index.js';
import { loadProject } from '../resource/index.js';
import type { JsonObject } from '../resource/index.js';
import { Kernel } from '../function/kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../function/kernel/index.js';
import { initPhysics3d } from '../function/plugins/physics3d/index.js';
import { coreEnvironment, EnvironmentApi } from './environment.js';
import { kw } from './kwargs.js';
import { physics3d } from './physics3d.js';
import { Buoyancy, water, WaterApi, WaterBody, WaterEntered } from './water.js';
import { LightningStruck, Thunder, weather, WeatherApi, WeatherChanged } from './weather.js';

beforeAll(async () => {
  await initPhysics3d();
});

function run(plugins: KernelPlugin[], env: JsonObject, entities: unknown[] = [], prefabs: Record<string, unknown> = {}): { kernel: Kernel; ns: Record<string, unknown> } {
  const text: Record<string, string> = {
    'scenes/main/scene.json': JSON.stringify({ environment: env, entities }),
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, JSON.stringify(p)])),
  };
  const project = loadProject({ list: () => Object.keys(text).sort(), read: (path) => text[path]! });
  expect(project.diagnostics).toEqual([]);
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game, plugins, context: {}, fixedStep: 1 / 30 });
  kernel.start('main');
  const ns: Record<string, unknown> = {};
  for (const p of plugins) if (p.namespace !== undefined) ns[p.namespace.name] = p.namespace.create(kernel);
  return { kernel, ns };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const LAKE = { components: { water_body: { kind: 'lake', area: { center: [0, 0], size: [20, 20] }, waves: 'none', depth: 4 } } };

describe('parallax.water', () => {
  it('ctx.water binds points and x, z; handles and events carry their ids', () => {
    expect(WaterBody.__component_id__).toBe('water_body');
    expect(Buoyancy.__component_id__).toBe('buoyancy');
    expect(WaterEntered.__event_id__).toBe('water_entered');
    const { ns } = run([coreEnvironment(), physics3d(), water()], {}, [{ prefab: 'lake', at: [0, 1, 0] }], { lake: LAKE });
    const api = ns['water'] as WaterApi;
    expect(api).toBeInstanceOf(WaterApi);
    expect(api.height_at(new Vec3(0, 0, 0))).toBeCloseTo(1, 6);
    expect(api.height_at(kw({ point: new Vec3(3, 0, 4) }))).toBeCloseTo(1, 6);
    expect(api.height_at(new Vec3(50, 0, 0))).toBeNull();
    expect(code(() => api.height_at(0, 0))).toBe('PP3030');
    expect(code(() => api.height_at(0))).toBe('PP3373');
    expect(api.depth_at(new Vec3(0, -1, 0))).toBeCloseTo(2, 6);
    expect(api.in_water(new Vec3(0, 0, 0))).toBe(true);
    expect(api.flow_at(new Vec3(0, 0, 0))).toEqual(Vec3.ZERO);
    expect(api.body_at(new Vec3(0, 0, 0))).not.toBeNull();
    api.splash(new Vec3(0, 1, 0), kw({ strength: 0.5 }));
    expect(code(() => api.splash(new Vec3(0, 1, 0), kw({ strength: 3 })))).toBe('PP3372');
    expect(code(() => api.depth_at(3))).toBe('PP3373');
    expect(code(() => water(1))).toBe('PP3030');
  });
});

describe('parallax.weather', () => {
  it('ctx.weather reads conditions and set() binds a preset and settings', () => {
    expect(WeatherChanged.__event_id__).toBe('weather_changed');
    expect(LightningStruck.__event_id__).toBe('lightning_struck');
    expect(Thunder.__event_id__).toBe('thunder');
    const { kernel, ns } = run([coreEnvironment(), physics3d(), weather()], { weather: 'clear' });
    const api = ns['weather'] as WeatherApi;
    expect(api.preset).toBe('clear');
    api.set('rain', kw({ seconds: 0, wind: 9 }));
    kernel.step(1 / 30);
    expect(api.preset).toBe('rain');
    expect(api.rain).toBeCloseTo(0.65, 6);
    expect(api.wind).toBe(9);
    expect(api.friction).toBeLessThanOrEqual(1);
    expect(api.visibility).toBeLessThan(10_000);
    api.set(kw({ seconds: 0, snow: 0.4 }));
    expect(api.snow).toBe(0.4);
    expect(api.preset).toBe('rain');
    api.strike(new Vec3(5, 0, 5));
    expect(api.is_sheltered(new Vec3(0, 0, 0))).toBe(false);
    expect(code(() => api.set('drizle'))).toBe('PP3381');
    expect(code(() => api.set(kw({ rian: 1 })))).toBe('PP3030');
    expect(code(() => api.set(kw({ rain: 5 })))).toBe('PP3381');
  });
});

describe('ctx.environment.clouds', () => {
  it('binds coverage and keywords, and reads the cover back', () => {
    const { ns } = run([coreEnvironment()], { clouds: { coverage: 0.2 } });
    const env = ns['environment'] as EnvironmentApi;
    expect(env.cloud_cover).toBe(0.2);
    env.clouds(0.7, kw({ seconds: 0 }));
    expect(env.cloud_cover).toBe(0.7);
    env.clouds(kw({ density: 0.9, seconds: 0 }));
    expect(code(() => env.clouds())).toBe('PP3228');
    expect(code(() => env.clouds('x'))).toBe('PP3223');
  });
});
