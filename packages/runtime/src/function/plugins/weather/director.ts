/**
 * The weather director: where the weather is heading and how it gets there, in game time.
 *
 *   - A change (`set`, or the next pick of the cycle) blends every parameter from where it
 *     was to the target over its seconds, smoothstep-eased — a storm rolls in, it doesn't pop.
 *   - With a `cycle`, after each hold (a seeded pick within `hold`) the director picks the
 *     next preset by weight (never the one it is in when there is a choice) and blends to it.
 *   - Surfaces get wet while it rains (to soaked in ~20 s of full rain) and dry after (~90 s);
 *     snow settles (~45 s of full snow) and melts slowly (faster in rain).
 *   - Lightning strikes at `lightning` per minute: the intervals are a seeded Poisson process
 *     (at least 1.5 s apart), each strike lands within `lightning_radius` of the anchor (the
 *     first camera; the origin without one) and its thunder is heard distance / 343 m/s later.
 *     The flash is three flickers over ~0.3 s.
 *
 * Every random draw comes from one seeded stream, and all of it is in the snapshot: two
 * machines with the same seed and steps see the same weather.
 */

import { SeededRandom, Vec3 } from '../../../core/index.js';
import type { RandomState } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { LightningStrike, WeatherConditions } from '../../services/index.js';
import { lerpParams, PARAM_KEYS, WEATHER_PRESETS } from './presets.js';
import type { ParamKey, WeatherParams, WeatherPreset, WeatherSpec } from './presets.js';

export const SPEED_OF_SOUND = 343;
/** Fewest seconds between strikes. */
export const MIN_STRIKE_INTERVAL = 1.5;
/** The flash's flickers: seconds after the strike, and their brightness. */
export const FLICKERS: readonly (readonly [number, number])[] = [[0, 1], [0.08, 0.7], [0.22, 0.45]];
const FLICKER_DECAY = 0.05;
/** Meters above the ground a bolt starts (the cloud base it is drawn from). */
export const BOLT_HEIGHT = 900;
/** Seconds strikes are kept (bolts drawn, flash computed). */
const STRIKE_MEMORY = 3;

export interface Thunder {
  readonly at: number;
  readonly strike: LightningStrike;
  readonly distance: number;
}

/** What the director tells its plugin as it steps. */
export interface DirectorEvents {
  struck(strike: LightningStrike): void;
  thunder(strike: LightningStrike, distance: number): void;
  changed(preset: WeatherPreset, seconds: number, params: WeatherParams): void;
}

export interface DirectorWorld {
  /** Where lightning strikes around and thunder is heard from. */
  anchor(): Vec3;
  /** Ground height at (x, z) for a strike. */
  ground(x: number, z: number, from: Vec3): number;
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function paramsJson(p: WeatherParams): JsonObject {
  return { ...p };
}

function paramsFrom(o: Json): WeatherParams {
  const out: Record<ParamKey, number> = { ...WEATHER_PRESETS.clear };
  for (const key of PARAM_KEYS) out[key] = (o as JsonObject)[key] as number;
  return out;
}

function strikeJson(s: LightningStrike): JsonObject {
  return { time: s.time, point: [s.point.x, s.point.y, s.point.z], cloud: s.cloud, strength: s.strength, seed: s.seed };
}

function strikeFrom(o: JsonObject): LightningStrike {
  const p = o['point'] as number[];
  return { time: o['time'] as number, point: new Vec3(p[0]!, p[1]!, p[2]!), cloud: o['cloud'] as number, strength: o['strength'] as number, seed: o['seed'] as number };
}

export class WeatherDirector {
  readonly #spec: WeatherSpec;
  #preset: WeatherPreset;
  #from: WeatherParams;
  #to: WeatherParams;
  #start = 0;
  #seconds = 0;
  #wetness = 0;
  #snowCover = 0;
  #nextChange: number | null = null;
  #nextStrike: number | null = null;
  readonly #random: SeededRandom;
  #strikes: LightningStrike[] = [];
  #thunder: Thunder[] = [];

  constructor(spec: WeatherSpec, seed: number, now: number) {
    this.#spec = spec;
    this.#preset = spec.preset;
    this.#from = spec.params;
    this.#to = spec.params;
    this.#start = now;
    this.#random = new SeededRandom(seed);
    if (spec.cycle.length > 0) this.#nextChange = now + this.#hold();
  }

  get preset(): WeatherPreset {
    return this.#preset;
  }

  /** Blend toward `params` (named `preset`) over `seconds`, from wherever the weather is now. */
  set(preset: WeatherPreset, params: WeatherParams, seconds: number, now: number): void {
    this.#from = this.params(now);
    this.#to = params;
    this.#preset = preset;
    this.#start = now;
    this.#seconds = seconds;
  }

  /** The parameters now (mid-change: blended). */
  params(now: number): WeatherParams {
    if (this.#seconds <= 0) return this.#to;
    const t = (now - this.#start) / this.#seconds;
    return t >= 1 ? this.#to : lerpParams(this.#from, this.#to, smoothstep(t));
  }

  /** Lightning's brightness now: every remembered strike's flickers. */
  flash(now: number): number {
    let f = 0;
    for (const s of this.#strikes) {
      for (const [at, weight] of FLICKERS) {
        const age = now - s.time - at;
        if (age >= 0) f += s.strength * weight * Math.exp(-age / FLICKER_DECAY);
      }
    }
    return f;
  }

  recentStrikes(now: number, seconds: number): readonly LightningStrike[] {
    return this.#strikes.filter((s) => s.time <= now && now - s.time <= seconds);
  }

  conditions(now: number): WeatherConditions {
    const p = this.params(now);
    const extinction = p.fog + p.rain * 0.004 + p.snow * 0.015 + p.hail * 0.006;
    return {
      preset: this.#preset,
      rain: p.rain, snow: p.snow, hail: p.hail, clouds: p.clouds, overcast: p.overcast, fog: p.fog, wind: p.wind, lightning: p.lightning,
      wetness: this.#wetness,
      snowCover: this.#snowCover,
      visibility: extinction > 0 ? Math.min(10_000, 3 / extinction) : 10_000,
      friction: Math.min(1, Math.max(0.2, 1 - 0.3 * this.#wetness - 0.6 * this.#snowCover)),
      flash: this.flash(now),
    };
  }

  #hold(): number {
    const [lo, hi] = this.#spec.hold;
    return lo + (hi - lo) * this.#random.next();
  }

  #pick(): WeatherPreset {
    const choices = this.#spec.cycle.length > 1 ? this.#spec.cycle.filter((c) => c.preset !== this.#preset) : this.#spec.cycle;
    const total = choices.reduce((n, c) => n + c.weight, 0);
    let u = this.#random.next() * total;
    for (const c of choices) {
      u -= c.weight;
      if (u < 0) return c.preset;
    }
    return choices[choices.length - 1]!.preset;
  }

  step(now: number, dt: number, world: DirectorWorld, events: DirectorEvents): void {
    const p = this.params(now);
    // Surfaces: wet in the rain, dry after; snow settles and melts.
    const wetting = p.rain + p.hail * 0.5;
    this.#wetness = wetting > 0.05
      ? Math.min(1, this.#wetness + ((3 * wetting) / 20) * (1 - this.#wetness) * dt)
      : Math.max(0, this.#wetness - dt / 90);
    this.#snowCover = p.snow > 0.05
      ? Math.min(1, this.#snowCover + (p.snow / 45) * dt)
      : Math.max(0, this.#snowCover - (dt / 240) - (p.rain / 60) * dt);

    if (this.#nextChange !== null && now >= this.#nextChange) {
      const next = this.#pick();
      this.set(next, WEATHER_PRESETS[next], this.#spec.blend, now);
      events.changed(next, this.#spec.blend, WEATHER_PRESETS[next]);
      this.#nextChange = now + this.#spec.blend + this.#hold();
    }

    // Lightning.
    if (p.lightning > 0) {
      if (this.#nextStrike === null) this.#nextStrike = now + this.#interval(p.lightning);
      while (this.#nextStrike !== null && now >= this.#nextStrike) {
        this.strike(this.#nextStrike, undefined, world, events);
        this.#nextStrike += this.#interval(p.lightning);
      }
    } else {
      this.#nextStrike = null;
    }
    const due = this.#thunder.filter((t) => t.at <= now);
    this.#thunder = this.#thunder.filter((t) => t.at > now);
    for (const t of due) events.thunder(t.strike, t.distance);
    this.#strikes = this.#strikes.filter((s) => now - s.time <= STRIKE_MEMORY);
  }

  #interval(perMinute: number): number {
    return Math.max(MIN_STRIKE_INTERVAL, (-Math.log(1 - this.#random.next()) * 60) / perMinute);
  }

  /** A strike at `time`, at `point` (or a seeded spot around the anchor). */
  strike(time: number, point: Vec3 | undefined, world: DirectorWorld, events: DirectorEvents): LightningStrike {
    const anchor = world.anchor();
    let at = point;
    if (at === undefined) {
      const r = this.#spec.lightningRadius * Math.sqrt(this.#random.next());
      const a = this.#random.next() * Math.PI * 2;
      const x = anchor.x + Math.cos(a) * r;
      const z = anchor.z + Math.sin(a) * r;
      at = new Vec3(x, world.ground(x, z, anchor), z);
    }
    const strike: LightningStrike = {
      time, point: at, cloud: at.y + BOLT_HEIGHT, strength: 0.6 + 0.4 * this.#random.next(), seed: Math.floor(this.#random.next() * 2 ** 31),
    };
    this.#strikes.push(strike);
    const distance = anchor.distance_to(at);
    this.#thunder.push({ at: time + distance / SPEED_OF_SOUND, strike, distance });
    events.struck(strike);
    return strike;
  }

  snapshot(): JsonObject {
    return {
      preset: this.#preset, from: paramsJson(this.#from), to: paramsJson(this.#to), start: this.#start, seconds: this.#seconds,
      wetness: this.#wetness, snow_cover: this.#snowCover, next_change: this.#nextChange, next_strike: this.#nextStrike,
      random: [...this.#random.state()], strikes: this.#strikes.map(strikeJson),
      thunder: this.#thunder.map((t) => ({ at: t.at, strike: strikeJson(t.strike), distance: t.distance })),
    };
  }

  restore(o: JsonObject): void {
    this.#preset = o['preset'] as WeatherPreset;
    this.#from = paramsFrom(o['from']!);
    this.#to = paramsFrom(o['to']!);
    this.#start = o['start'] as number;
    this.#seconds = o['seconds'] as number;
    this.#wetness = o['wetness'] as number;
    this.#snowCover = o['snow_cover'] as number;
    this.#nextChange = o['next_change'] as number | null;
    this.#nextStrike = o['next_strike'] as number | null;
    this.#random.restore(o['random'] as unknown as RandomState);
    this.#strikes = (o['strikes'] as JsonObject[]).map(strikeFrom);
    this.#thunder = (o['thunder'] as JsonObject[]).map((t) => ({ at: t['at'] as number, strike: strikeFrom(t['strike'] as JsonObject), distance: t['distance'] as number }));
  }
}
