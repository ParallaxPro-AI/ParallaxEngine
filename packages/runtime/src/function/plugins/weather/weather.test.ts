/**
 * The weather plugin headless: presets and blending, the director's cycle, wetness and
 * snow, lightning timing and thunder delay, shelter from physics3d, what the environment
 * does with it (grey sky, fog, flash, cloud), the wind it blows, data errors, snapshots.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, Fields, KernelPlugin, LogicInstance } from '../../kernel/index.js';
import { AUDIO_SERVICE, ENVIRONMENT_SERVICE, WEATHER_SERVICE, WIND_SERVICE } from '../../services/index.js';
import type { AudioService } from '../../services/index.js';
import { environment } from '../environment/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { wind } from '../wind/index.js';
import {
  FLICKERS, lerpParams, MIN_STRIKE_INTERVAL, readWeather, SPEED_OF_SOUND, thunderVolume, weather, WEATHER_EVENTS, WEATHER_PRESETS, WeatherDirector, weatherProblems,
} from './index.js';
import type { WeatherPlugin } from './index.js';

const DT = 1 / 30;

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

type Log = Array<[string, Fields]>;

function game(env: JsonObject, entities: unknown[] = [], prefabs: Record<string, unknown> = {}, extra: KernelPlugin[] = []) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { environment: env, entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const log: Log = [];
  const watch: BehaviorDef = {
    id: 'watch', params: {}, state: {}, requires: [], handlers: [], create: () => ({}) as LogicInstance,
  };
  const listen = {
    id: 'listen', scenes: [], handlers: [
      { event: WEATHER_EVENTS.struck, method: 'struck' }, { event: WEATHER_EVENTS.thunder, method: 'thunder' },
      { event: WEATHER_EVENTS.changed, method: 'changed' },
    ],
    create: () => ({
      struck(_c: unknown, e: Fields) { log.push(['struck', e]); },
      thunder(_c: unknown, e: Fields) { log.push(['thunder', e]); },
      changed(_c: unknown, e: Fields) { log.push(['changed', e]); },
    }),
  };
  const plugin: WeatherPlugin = weather();
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [watch], systems: [listen] },
    plugins: [environment(), physics3d({ gravity: -9.8 }), plugin, ...extra], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  return {
    kernel, log, control: plugin.control(),
    conditions: () => kernel.service(WEATHER_SERVICE).conditions(),
    run: (seconds: number) => { for (let i = 0; i < Math.round(seconds / DT); i++) kernel.step(DT); },
  };
}

describe('presets and blending', () => {
  it('reads a preset name, or an object with fields over its preset; rejects mistakes with a hint', () => {
    const fail = (pointer: string) => (message: string): never => { throw new Error(`${pointer}: ${message}`); };
    expect(readWeather('storm', fail).params).toEqual(WEATHER_PRESETS.storm);
    expect(readWeather({ preset: 'rain', wind: 9 }, fail).params.wind).toBe(9);
    expect(weatherProblems('stormy')[0]!.fix).toMatch(/storm/);
    expect(weatherProblems({ preset: 'rain', rian: 1 })[0]!.pointer).toBe('/rian');
    expect(weatherProblems({ rain: 2 })[0]!.message).toMatch(/0 to 1/);
    expect(weatherProblems({ cycle: { clear: 0 } })).toHaveLength(1);
  });

  it('blends every setting from where it is to the target, eased, over the seconds asked', () => {
    const g = game({ weather: 'clear' });
    g.control.set({ preset: 'storm', seconds: 10, fields: {} });
    g.run(5);
    const mid = g.conditions();
    expect(mid.preset).toBe('storm');
    // Smoothstep: halfway in time is halfway in value.
    expect(mid.rain).toBeCloseTo(0.5, 1);
    expect(mid.wind).toBeCloseTo((2 + 14) / 2, 0);
    g.run(6);
    expect(g.conditions().rain).toBe(1);
    expect(g.log.filter(([m]) => m === 'changed').map(([, e]) => e['preset'])).toEqual(['storm']);
    expect(lerpParams(WEATHER_PRESETS.clear, WEATHER_PRESETS.rain, 0).rain).toBe(0);
  });

  it('a director cycle picks the next preset by weight after each hold, the same every run', () => {
    const run = (): string[] => {
      const g = game({ weather: { preset: 'clear', cycle: { clear: 1, rain: 1, snow: 1 }, hold: [10, 20], blend: 5 } });
      g.run(200);
      return g.log.filter(([m]) => m === 'changed').map(([, e]) => e['preset'] as string);
    };
    const first = run();
    expect(first.length).toBeGreaterThanOrEqual(6);
    // Never "changes" to the preset it is already in.
    first.forEach((p, i) => { if (i > 0) expect(p).not.toBe(first[i - 1]); });
    expect(run()).toEqual(first);
  });

  it('wets surfaces in the rain and dries them after; snow settles; grip and visibility follow', () => {
    const g = game({ weather: 'rain' });
    g.run(30);
    const wet = g.conditions();
    expect(wet.wetness).toBeGreaterThan(0.8);
    expect(wet.friction).toBeLessThan(0.8);
    expect(wet.visibility).toBeLessThan(500);
    g.control.set({ preset: 'clear', seconds: 0, fields: {} });
    g.run(30);
    expect(g.conditions().wetness).toBeLessThan(wet.wetness);
    expect(g.conditions().wetness).toBeGreaterThan(0.4);
    g.control.set({ preset: 'blizzard', seconds: 0, fields: {} });
    g.run(60);
    expect(g.conditions().snowCover).toBeGreaterThan(0.9);
    expect(g.conditions().friction).toBeLessThan(0.45);
  });
});

describe('lightning', () => {
  it('strikes at the rate asked (never closer than 1.5 s), and thunder arrives distance / 343 m/s later', () => {
    const g = game({ weather: { preset: 'storm', lightning: 20, lightning_radius: 1500 } });
    g.run(120);
    const strikes = g.log.filter(([m]) => m === 'struck');
    const thunders = g.log.filter(([m]) => m === 'thunder');
    // 20 per minute for two minutes: about 40 (Poisson).
    expect(strikes.length).toBeGreaterThan(20);
    expect(strikes.length).toBeLessThan(65);
    expect(thunders.length).toBeGreaterThan(strikes.length - 6);
    for (const [, e] of thunders) {
      expect(e['distance']).toBeCloseTo((e['point'] as Vec3).distance_to(Vec3.ZERO), 6);
      expect(e['distance'] as number).toBeLessThanOrEqual(1500);
    }
  });

  it('times strikes, flashes and thunder exactly in the director', () => {
    const times: number[] = [];
    const heard: [number, number][] = [];
    const director = new WeatherDirector(readWeather({ preset: 'storm', lightning: 30 }, () => () => { throw new Error(); }), 3, 0);
    const world = { anchor: () => new Vec3(0, 0, 0), ground: () => 0 };
    let now = 0;
    for (let i = 0; i < 6000; i++) {
      now = i / 100;
      director.step(now, 0.01, world, {
        struck: (s) => times.push(s.time),
        thunder: (s, d) => heard.push([now - s.time, d]),
        changed: () => {},
      });
    }
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(MIN_STRIKE_INTERVAL - 1e-9);
    for (const [late, d] of heard) expect(late).toBeCloseTo(d / SPEED_OF_SOUND, 1);
    const fresh = new WeatherDirector(readWeather('clear', () => () => { throw new Error(); }), 3, 0);
    const at = fresh.strike(10, new Vec3(0, 0, 0), world, { struck: () => {}, thunder: () => {}, changed: () => {} }).time;
    const flash = (t: number): number => fresh.flash(t);
    expect(flash(at - 0.01)).toBe(0);
    // The flickers are local peaks.
    expect(flash(at + FLICKERS[1]![0])).toBeGreaterThan(flash(at + FLICKERS[1]![0] - 0.02));
    expect(flash(at + 2)).toBeLessThan(0.01);
  });

  it('ctx.weather.strike(point) strikes there now', () => {
    const g = game({ weather: 'clear' });
    const s = g.control.strike(new Vec3(100, 0, 0));
    expect(s.point.x).toBe(100);
    g.run(100 / SPEED_OF_SOUND + 0.1);
    expect(g.log.map(([m]) => m)).toEqual(['struck', 'thunder']);
    expect(g.conditions().flash).toBeLessThan(0.02);
  });
});

describe('shelter', () => {
  it('a point under a roof is sheltered; in the open it is not', () => {
    const roof = { components: { collider: { shape: 'box', size: [6, 0.2, 6] } } };
    const g = game({ weather: 'rain' }, [{ prefab: 'roof', at: [0, 3, 0] }], { roof });
    g.run(DT);
    expect(g.kernel.service(WEATHER_SERVICE).sheltered(new Vec3(0, 0, 0))).toBe(true);
    expect(g.kernel.service(WEATHER_SERVICE).sheltered(new Vec3(10, 0, 0))).toBe(false);
  });
});

describe('the environment under the weather', () => {
  it('greys the sky, thickens fog, brings clouds that drift, and flashes', () => {
    const clear = game({ sky: 'clear_day' }, [], {}, []).kernel.service(ENVIRONMENT_SERVICE).resolve();
    const g = game({ sky: 'clear_day', weather: 'storm' });
    g.run(1);
    const storm = g.kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(storm.zenith.b).toBeLessThan(clear.zenith.b);
    expect(storm.sunIntensity).toBeLessThan(clear.sunIntensity * 0.3);
    expect(storm.fog.density).toBeGreaterThan(0.005);
    expect(storm.clouds?.coverage).toBe(1);
    const drift = storm.clouds!.offsetX;
    g.run(2);
    expect(g.kernel.service(ENVIRONMENT_SERVICE).resolve().clouds!.offsetX).not.toBe(drift);
    g.control.strike(undefined);
    g.kernel.step(DT);
    expect(g.kernel.service(ENVIRONMENT_SERVICE).resolve().flash).toBeGreaterThan(0.3);
  });

  it('a weather key without the weather plugin is PP3227', () => {
    const project = loadProject(files({ 'scenes/main/scene.json': { environment: { weather: 'rain' }, entities: [] } }));
    const kernel = new Kernel({
      project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins: [environment()], context: {}, fixedStep: DT,
    });
    expect(() => kernel.start('main')).toThrow(/PP3227/);
  });

  it('blows the wind plugin with the weather\'s wind', () => {
    const g = game({ weather: 'clear' }, [], {}, [wind()]);
    g.control.set({ preset: 'storm', seconds: 4, fields: {} });
    g.run(5);
    expect(g.kernel.service(WIND_SERVICE).settings().speed).toBeCloseTo(14, 3);
    // Storms gust.
    expect(g.kernel.service(WIND_SERVICE).settings().gusts).toBeGreaterThan(0.7);
  });

  it('owns wind, cloud cover and fog density while active, whatever the plugin order; leaves a scene without weather alone', () => {
    const owned = (env: JsonObject, order: 'wind_first' | 'weather_first') => {
      const project = loadProject(files({
        'scenes/main/scene.json': {
          environment: { sky: 'clear_day', fog: { density: 0.05 }, clouds: { coverage: 0.2 }, ...env },
          wind: { speed: 1, gusts: 0.1 }, entities: [],
        },
      }));
      const plugins = order === 'wind_first' ? [wind(), environment(), weather()] : [environment(), weather(), wind()];
      const kernel = new Kernel({
        project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins, context: {}, fixedStep: DT,
      });
      kernel.start('main');
      kernel.step(DT);
      return { wind: kernel.service(WIND_SERVICE).settings(), look: kernel.service(ENVIRONMENT_SERVICE).resolve() };
    };
    for (const order of ['wind_first', 'weather_first'] as const) {
      const storm = owned({ weather: 'storm' }, order);
      expect(storm.wind.speed).toBeCloseTo(WEATHER_PRESETS.storm.wind, 6);
      expect(storm.look.fog.density).toBeCloseTo(WEATHER_PRESETS.storm.fog, 6);
      expect(storm.look.clouds?.coverage).toBe(WEATHER_PRESETS.storm.clouds);
      const none = owned({}, order);
      expect(none.wind.speed).toBe(1);
      expect(none.look.fog.density).toBeCloseTo(0.05, 6);
      expect(none.look.clouds?.coverage).toBeCloseTo(0.2, 6);
    }
  });
});

describe('snapshots', () => {
  it('a storm continues identically after a restore (strikes, thunder, wetness, the stream)', () => {
    const g = game({ weather: { preset: 'storm', lightning: 30, cycle: { storm: 1, rain: 1 }, hold: [5, 8], blend: 2 } });
    g.run(10);
    const saved = g.kernel.snapshot();
    const mark = g.log.length;
    g.run(20);
    const after = g.log.slice(mark).map(([m, e]) => `${m}:${JSON.stringify(e['point'] ?? e['preset'])}`);
    const wet = g.conditions().wetness;
    g.log.length = mark;
    g.kernel.restore(saved);
    g.run(20);
    expect(g.log.slice(mark).map(([m, e]) => `${m}:${JSON.stringify(e['point'] ?? e['preset'])}`)).toEqual(after);
    expect(g.conditions().wetness).toBe(wet);
  });
});

/** An audio service stand-in that records what the weather asks for. */
function recorder() {
  const calls: Array<[string, string, number]> = [];
  const loops = new Map<string, number>();
  const plugin: KernelPlugin = {
    id: 'audio_recorder',
    install(kernel) {
      const service: AudioService = {
        play: (s) => { calls.push(['play', s.sound, s.volume ?? 1]); },
        loop: (key, s) => { loops.set(key, s.volume ?? 1); calls.push(['loop', s.sound, s.volume ?? 1]); },
        stop: (key) => { loops.delete(key); },
      };
      kernel.provide(AUDIO_SERVICE, service);
    },
  };
  return { plugin, calls, loops };
}

describe('sounds', () => {
  it('plays the scene\'s thunder with each Thunder and a rain loop as loud as it rains', () => {
    const audio = recorder();
    const g = game({ weather: { preset: 'storm', lightning: 20, sounds: { rain: 'sfx/rain_loop', thunder: 'sfx/thunder' } } }, [], {}, [audio.plugin]);
    g.run(30);
    const thunders = g.log.filter(([m]) => m === 'thunder');
    const claps = audio.calls.filter(([k, s]) => k === 'play' && s === 'sfx/thunder');
    expect(thunders.length).toBeGreaterThan(2);
    expect(claps).toHaveLength(thunders.length);
    claps.forEach(([, , volume], i) => expect(volume).toBeCloseTo(thunderVolume(thunders[i]![1]['strength'] as number, thunders[i]![1]['distance'] as number), 3));
    expect(audio.loops.get('weather.rain')).toBeCloseTo(Math.min(1, g.conditions().rain + 0.5 * g.conditions().hail), 2);
    // Clearing up: the loop stops once the rain is gone.
    g.control.set({ preset: 'clear', seconds: 0, fields: {} });
    g.run(1);
    expect(audio.loops.has('weather.rain')).toBe(false);
  });

  it('is silent without sounds in the data, and rejects an unknown sound key', () => {
    const audio = recorder();
    const g = game({ weather: { preset: 'storm', lightning: 20 } }, [], {}, [audio.plugin]);
    g.run(30);
    expect(audio.calls).toEqual([]);
    expect(weatherProblems({ preset: 'rain', sounds: { rian: 'sfx/rain' } }).map((p) => p.pointer)).toEqual(['/sounds/rian']);
    expect(weatherProblems({ preset: 'rain', sounds: { rain: 3 } }).map((p) => p.pointer)).toEqual(['/sounds/rain']);
  });
});
