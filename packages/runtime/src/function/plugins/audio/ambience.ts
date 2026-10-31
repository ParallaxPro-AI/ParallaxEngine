/**
 * Ambience: what the world sounds like by itself, synthesized (synth_presets.ts) from the
 * state other plugins already keep — read through their services, so audio imports none of
 * them and a game without them is silent:
 *
 *   rain     WEATHER_SERVICE: a hiss as loud as it rains (hail counts half)
 *   wind     WIND_SERVICE (or the weather's wind without it): a rush that rises in volume and
 *            pitch with the wind at the listener, gusts included
 *   thunder  the weather's `thunder` event: a clap, quieter and lower with distance
 *   water    WATER_WORLD_SERVICE: a river babbles from its nearest point (louder where it
 *            flows fast), a lake laps at its nearest edge, the sea's surf fades with height
 *
 * A scene whose weather names its own sounds (`"sounds": {"rain": ..., "thunder": ...}`) gets
 * those instead of the synthesized rain and thunder (the weather plugin plays them).
 * `ctx.audio.ambience = False` silences it all. Levels are rounded so a steady world sends no
 * updates; every voice is a plugin loop (in snapshots, in the voice budget).
 */

import { Vec3 } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { WATER_WORLD_SERVICE, WEATHER_SERVICE, WIND_SERVICE } from '../../services/index.js';
import type { PluginSound, WaterBodyInfo } from '../../services/index.js';

export const AMBIENCE_KEYS = ['ambience.rain', 'ambience.wind', 'ambience.river', 'ambience.lake', 'ambience.surf'] as const;
export type AmbienceKey = (typeof AMBIENCE_KEYS)[number];

/** Wind speed (m/s) heard at full level. */
export const WIND_FULL = 20;
/** Meters from a river's bank / a lake's edge within which it is heard. */
export const RIVER_REACH = 70;
export const LAKE_REACH = 40;
/** Meters above the sea at which its surf has faded out. */
export const SURF_REACH = 60;
/** A river flowing this fast (m/s) or faster babbles at full level. */
const RIVER_FULL_FLOW = 4;

const level = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
const rate = (v: number): number => Math.round(v * 100) / 100;
const meters = (v: Vec3): Vec3 => new Vec3(Math.round(v.x * 2) / 2, Math.round(v.y * 2) / 2, Math.round(v.z * 2) / 2);

/** What the weather's own sounds already cover (the scene's weather "sounds"). */
export interface WeatherSounds {
  readonly rain: boolean;
  readonly thunder: boolean;
}

/** The scene's weather block's sounds (environment.weather.sounds), read from the scene's data. */
export function sceneWeatherSounds(environment: Readonly<Record<string, unknown>> | undefined): WeatherSounds {
  const weather = environment?.['weather'];
  const sounds = typeof weather === 'object' && weather !== null && !Array.isArray(weather) ? (weather as Record<string, unknown>)['sounds'] : undefined;
  const named = (key: string): boolean => typeof sounds === 'object' && sounds !== null && typeof (sounds as Record<string, unknown>)[key] === 'string';
  return { rain: named('rain'), thunder: named('thunder') };
}

/** The ambience loops wanted now (null: that loop is silent), heard at `at`. */
export function ambienceLoops(kernel: Kernel, at: Vec3 | null, covered: WeatherSounds): Map<AmbienceKey, PluginSound | null> {
  const out = new Map<AmbienceKey, PluginSound | null>(AMBIENCE_KEYS.map((k) => [k, null]));
  const weather = kernel.tryService(WEATHER_SERVICE)?.conditions();
  if (weather !== undefined && !covered.rain) {
    const rain = level(weather.rain + 0.5 * weather.hail);
    if (rain > 0) out.set('ambience.rain', { sound: 'synth/rain', volume: level(rain * 0.7) });
  }
  const wind = kernel.tryService(WIND_SERVICE);
  let speed = weather?.wind ?? 0;
  if (wind !== undefined) {
    const v = at === null ? wind.mean() : wind.sample(at.x, at.z);
    speed = Math.hypot(v[0]!, v[1]!);
  }
  const blow = level(speed / WIND_FULL);
  if (blow > 0.02) out.set('ambience.wind', { sound: 'synth/wind', volume: level(blow * 0.6), pitch: rate(0.8 + 0.45 * blow) });
  const water = kernel.tryService(WATER_WORLD_SERVICE);
  if (water !== undefined && at !== null) waterLoops(water.bodies(), at, out);
  return out;
}

function waterLoops(bodies: readonly WaterBodyInfo[], at: Vec3, out: Map<AmbienceKey, PluginSound | null>): void {
  let river: { d: number; point: Vec3; flow: number } | undefined;
  let lake: { d: number; point: Vec3 } | undefined;
  let surf = 0;
  for (const body of bodies) {
    if (body.kind === 'river' && body.course !== null) {
      const near = nearestOnCourse(body.course, at);
      const d = Math.max(0, near.d - body.width / 2);
      if (d <= RIVER_REACH && (river === undefined || d < river.d)) river = { d, point: near.point, flow: body.flow };
    } else if (body.kind === 'lake' || body.kind === 'pool') {
      const point = nearestOnArea(body, at);
      const d = point.distance_to(at);
      if (d <= LAKE_REACH && (lake === undefined || d < lake.d)) lake = { d, point };
    } else if (body.kind === 'ocean') {
      surf = Math.max(surf, 1 - Math.max(0, at.y - body.level) / SURF_REACH);
    }
  }
  if (river !== undefined) {
    out.set('ambience.river', { sound: 'synth/river', at: meters(river.point), volume: level(0.35 + 0.65 * Math.min(1, Math.abs(river.flow) / RIVER_FULL_FLOW)) });
  }
  if (lake !== undefined) out.set('ambience.lake', { sound: 'synth/lake', at: meters(lake.point), volume: 0.5 });
  if (level(surf) > 0) out.set('ambience.surf', { sound: 'synth/surf', volume: level(surf * 0.8) });
}

/** The nearest point of a river's course (a polyline) to `at`, on the ground plane, and its distance. */
export function nearestOnCourse(course: NonNullable<WaterBodyInfo['course']>, at: Vec3): { point: Vec3; d: number } {
  const { xs, ys, zs } = course;
  let best = { point: new Vec3(xs[0]!, ys[0]!, zs[0]!), d: Infinity };
  for (let i = 0; i < xs.length; i++) {
    const j = Math.min(i + 1, xs.length - 1);
    const ax = xs[i]!, az = zs[i]!, bx = xs[j]!, bz = zs[j]!;
    const dx = bx - ax, dz = bz - az;
    const len = dx * dx + dz * dz;
    const t = len > 0 ? Math.max(0, Math.min(1, ((at.x - ax) * dx + (at.z - az) * dz) / len)) : 0;
    const x = ax + dx * t, z = az + dz * t;
    const d = Math.hypot(at.x - x, at.z - z);
    if (d < best.d) best = { point: new Vec3(x, ys[i]! + (ys[j]! - ys[i]!) * t, z), d };
  }
  return best;
}

/** The nearest point of a lake or pool's surface to `at` (under it when over the water). */
export function nearestOnArea(body: WaterBodyInfo, at: Vec3): Vec3 {
  const c = Math.cos(body.yaw), s = Math.sin(body.yaw);
  const dx = at.x - body.center.x, dz = at.z - body.center.z;
  let lx = dx * c - dz * s;
  let lz = dx * s + dz * c;
  if (body.shape === 'ellipse') {
    const r = Math.hypot(lx / Math.max(1e-6, body.halfX), lz / Math.max(1e-6, body.halfZ));
    if (r > 1) { lx /= r; lz /= r; }
  } else {
    lx = Math.max(-body.halfX, Math.min(body.halfX, lx));
    lz = Math.max(-body.halfZ, Math.min(body.halfZ, lz));
  }
  // Back to the world: the inverse of the rotation above.
  return new Vec3(body.center.x + lx * c + lz * s, body.level, body.center.z - lx * s + lz * c);
}

/** A thunderclap's synthesized sound for a `thunder` event: quieter and lower with distance. */
export function thunderClap(strength: number, distance: number): PluginSound {
  const far = Math.min(1, Math.max(0, distance) / 3000);
  return { sound: 'synth/thunder', volume: level(strength * (1 - 0.75 * far)), pitch: rate(1.05 - 0.3 * far) };
}
