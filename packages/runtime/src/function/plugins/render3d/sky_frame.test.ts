/**
 * The outdoors in a frame (sky_frame.ts, water_frame.ts, weather_frame.ts), headless: an
 * ocean in a storm under the atmosphere sky — the sky model and drifting clouds, the
 * bodies with the very waves gameplay samples, river ribbons, splash rings and spray, rain
 * kept out from under a roof by the cover map, and lightning bolts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { RIPPLE_FLOATS, Vec3, WAVE_FLOATS } from '../../../core/index.js';
import type { Environment3d, ProjectFiles, Quality3d, View3d } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import { WATER_WORLD_SERVICE, WEATHER_SERVICE } from '../../services/index.js';
import { environment } from '../environment/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { water, waveHeight } from '../water/index.js';
import { weather } from '../weather/index.js';
import { fromResolved } from './environment.js';
import { QUALITY_LADDER } from './quality.js';
import { NatureDraws } from './sky_frame.js';
import { bolt, coverAt, FALL_BOX } from './weather_frame.js';
import { riverRibbon } from './water_frame.js';
import { ENVIRONMENT_SERVICE } from '../../services/index.js';

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const view = (x: number, y: number, z: number): View3d => ({
  camera: 1, viewport: { x: 0, y: 0, width: 640, height: 360 }, position: [x, y, z], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
  view: [], projection: [], viewProjection: [], inverseViewProjection: [], near: 0.1, far: 1000, clear: null, colorVision: 'none',
});

function scene(env: JsonObject, entities: unknown[], prefabs: Record<string, unknown>) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { environment: env, entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [environment(), physics3d({ gravity: -9.8 }), water(), weather()], context: {}, fixedStep: 1 / 30,
  });
  kernel.start('main');
  const draws = new NatureDraws();
  const quality = (QUALITY_LADDER as Readonly<Record<string, Quality3d>>)['high']!;
  const build = (v: View3d) => {
    const env: Environment3d = fromResolved(kernel.service(ENVIRONMENT_SERVICE).resolve());
    return draws.build(kernel, [v], env, quality);
  };
  return { kernel, build };
}

const SEA = { components: { water_body: { kind: 'ocean', waves: 'rough' } } };
const ROOF = { components: { collider: { shape: 'box', size: [12, 0.4, 12] } } };
const GROUND = { components: { collider: { shape: 'box', size: [200, 1, 200], offset: [0, -0.5, 0] } } };

describe('the sky in a frame', () => {
  it('the atmosphere preset carries its model, the sun, and clouds that drift', () => {
    const g = scene({ sky: 'atmosphere', time_of_day: 17.5, clouds: { coverage: 0.5, speed: 12, direction: 90 } }, [], {});
    const first = g.build(view(0, 2, 0)).frame!.sky!;
    expect(first.model).toBe('atmosphere');
    expect(first.toSun[1]).toBeGreaterThan(0);
    expect(first.clouds!.coverage).toBe(0.5);
    g.kernel.step(1);
    expect(g.build(view(0, 2, 0)).frame!.sky!.clouds!.offset[0]).toBeGreaterThan(first.clouds!.offset[0] + 5);
  });

  it('a plain gradient day with nothing outdoors adds no nature at all', () => {
    const project = loadProject(files({ 'scenes/main/scene.json': { environment: { sky: 'clear_day' }, entities: [] } }));
    const kernel = new Kernel({
      project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins: [environment()], context: {}, fixedStep: 1 / 30,
    });
    kernel.start('main');
    const env = fromResolved(kernel.service(ENVIRONMENT_SERVICE).resolve());
    const out = new NatureDraws().build(kernel, [view(0, 2, 0)], env, (QUALITY_LADDER as Readonly<Record<string, Quality3d>>)['low']!);
    expect(out.frame).toBeNull();
    expect(out.hidesTerrainWater).toBe(false);
  });
});

describe('water in a frame', () => {
  it('draws each body with the waves gameplay samples, and hides the terrain plane', () => {
    const g = scene({ sky: 'atmosphere' }, [{ prefab: 'sea', at: [0, -1, 0] }], { sea: SEA });
    g.kernel.step(1 / 30);
    const out = g.build(view(0, 2, 0));
    const w = out.frame!.water!;
    expect(out.hidesTerrainWater).toBe(true);
    expect(w.bodies).toHaveLength(1);
    const body = w.bodies[0]!;
    expect(body.kind).toBe('ocean');
    expect(body.level).toBe(-1);
    const set = w.waves.subarray(body.firstWave * WAVE_FLOATS, (body.firstWave + body.waveCount) * WAVE_FLOATS);
    // The surface the shader displaces is the one ctx.water.height_at reports.
    const world = g.kernel.service(WATER_WORLD_SERVICE);
    expect(body.level + waveHeight(set, 3, 4, w.time)).toBeCloseTo(world.heightAt(3, 4)!, 6);
  });

  it('splashes become rings on the surface and spray above it', () => {
    const g = scene({}, [{ prefab: 'sea', at: [0, 0, 0] }], { sea: SEA });
    g.kernel.service(WATER_WORLD_SERVICE).splash(new Vec3(2, 0, 3), 1);
    g.kernel.step(0.2);
    const out = g.build(view(0, 2, 0));
    const w = out.frame!.water!;
    expect(w.rippleCount).toBe(1);
    expect(w.ripples[0]).toBe(2);
    expect(w.ripples[RIPPLE_FLOATS - 2]).toBeGreaterThan(0.3);
    expect(out.billboards.some((b) => b.count >= 6)).toBe(true);
  });

  it('a river is a ribbon wound up, carrying its flow per vertex', () => {
    const g = scene({}, [{ prefab: 'river', at: [0, 0, 0] }], { river: { components: { water_body: { kind: 'river', points: [[0, 0, 0], [0, -1, 30]], width: 6, flow: 2 } } } });
    const body = g.kernel.service(WATER_WORLD_SERVICE).bodies()[0]!;
    const ribbon = riverRibbon(body);
    const p = ribbon.positions; const i = ribbon.indices;
    const a = [p[i[0]! * 3]!, p[i[0]! * 3 + 1]!, p[i[0]! * 3 + 2]!];
    const b = [p[i[1]! * 3]!, p[i[1]! * 3 + 1]!, p[i[1]! * 3 + 2]!];
    const c = [p[i[2]! * 3]!, p[i[2]! * 3 + 1]!, p[i[2]! * 3 + 2]!];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    expect(u[2]! * v[0]! - u[0]! * v[2]!).toBeGreaterThan(0);
    // The center line flows downstream at 1.5× the mean.
    expect(ribbon.colors![2 * 4 + 1]).toBeCloseTo(1, 3);
    expect(ribbon.colors![2 * 4 + 2]).toBeCloseTo(3, 3);
    expect(g.build(view(0, 2, 0)).frame!.water!.bodies[0]!.ribbon).toBe(g.build(view(0, 2, 0)).frame!.water!.bodies[0]!.ribbon);
  });
});

describe('weather in a frame', () => {
  it('rain falls around the camera but not under a roof, and the surfaces know how wet they are', () => {
    const g = scene({ weather: 'storm' }, [{ prefab: 'ground' }, { prefab: 'roof', at: [0, 4, 0] }], { ground: GROUND, roof: ROOF });
    g.kernel.step(1 / 30);
    let out = g.build(view(0, 2, 0));
    for (let i = 0; i < 16; i++) out = g.build(view(0, 2, 0));
    const w = out.frame!.weather!;
    expect(w.rain).toBe(1);
    expect(w.cover).not.toBeNull();
    expect(coverAt(w.cover, 0, 0)).toBeCloseTo(4.2, 3);
    expect(coverAt(w.cover, 15, 15)).toBeCloseTo(0, 3);
    const rain = out.billboards[0]!;
    expect(rain.count).toBeGreaterThan(1000);
    let underRoof = 0; let inBox = 0;
    for (let i = 0; i < rain.count; i++) {
      const x = rain.data[i * 12]!; const y = rain.data[i * 12 + 1]!; const z = rain.data[i * 12 + 2]!;
      if (Math.abs(x) <= FALL_BOX / 2 && Math.abs(z) <= FALL_BOX / 2) inBox++;
      if (Math.abs(x) < 5.5 && Math.abs(z) < 5.5 && y < 4) underRoof++;
    }
    expect(inBox).toBe(rain.count);
    expect(underRoof).toBe(0);
    g.kernel.step(30);
    expect(g.kernel.service(WEATHER_SERVICE).conditions().wetness).toBeGreaterThan(0.5);
  });

  it('a strike is drawn as a bolt from the cloud base to the point, then fades', () => {
    const strike = { time: 1, point: new Vec3(10, 0, 5), cloud: 900, strength: 1, seed: 42 };
    const lines = bolt(strike, 1.05);
    expect(lines.length).toBe(5);
    expect(lines[0]!.width).toBeGreaterThan(lines[1]!.width);
    const trunk = lines[1]!.points;
    expect(trunk[1]).toBe(900);
    expect([trunk[trunk.length - 3], trunk[trunk.length - 2], trunk[trunk.length - 1]]).toEqual([10, 0, 5]);
    expect(bolt(strike, 1.05)[2]!.points).toEqual(lines[2]!.points);
    expect(bolt(strike, 2)).toEqual([]);
  });
});
