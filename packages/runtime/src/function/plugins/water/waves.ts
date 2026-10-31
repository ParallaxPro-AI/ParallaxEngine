/**
 * Waves: a sum of Gerstner (trochoidal) waves, the same on the CPU and the GPU. Game code
 * samples the surface it sees (`ctx.water.height_at`), buoyancy pushes on it, and render3d
 * displaces the water mesh with the very same wave list (`Water3d.waves`), so a boat sits
 * on the wave it is drawn on.
 *
 * A wave set comes from a few numbers: significant height (the mean of the highest third
 * of waves, as sailors and weather reports use it), peak wavelength, direction, spread and
 * choppiness. Its waves are deep-water waves (ω² = g·k) scattered around the direction and
 * wavelength by a seeded stream, with amplitudes scaled so the set's significant height is
 * the one asked for, and steepness shared so crests sharpen without looping.
 *
 * Gerstner waves move water sideways as well as up, so the height above a world point is
 * found by solving for the rest position that lands there (a few fixed-point steps).
 * Everything is a pure function of the set and game time, so a run and its replay agree.
 * It uses the platform's Math.sin and Math.cos, like the rest of the simulation: the same
 * JavaScript engine gives the same bits, but two engines (V8, SpiderMonkey, JavaScriptCore)
 * may differ in the last bits. Only `ground_math` (core) is bit-identical across engines.
 */

import { SeededRandom } from '../../../core/index.js';
import { WAVE_FLOATS } from '../../../core/index.js';

export const GRAVITY = 9.81;

/** Waves per set. */
export const WAVES_PER_SET = 8;

export interface WaveSpec {
  /** Significant wave height, meters (0: still water). */
  readonly height: number;
  /** Peak wavelength, meters. */
  readonly wavelength: number;
  /** Compass degrees the waves travel toward (0: +z, 90: +x). */
  readonly direction: number;
  /** Degrees the waves fan out to either side of `direction`. */
  readonly spread: number;
  /** 0..1: how sharp the crests are (1: as sharp as they get without looping). */
  readonly choppiness: number;
  readonly seed: number;
}

export const WAVE_PRESETS = {
  none: { height: 0, wavelength: 10, choppiness: 0 },
  calm: { height: 0.12, wavelength: 5, choppiness: 0.3 },
  choppy: { height: 0.6, wavelength: 14, choppiness: 0.6 },
  rough: { height: 1.6, wavelength: 32, choppiness: 0.75 },
  storm: { height: 3.5, wavelength: 60, choppiness: 0.85 },
} as const;
export type WavePreset = keyof typeof WAVE_PRESETS;
export const WAVE_PRESET_NAMES = Object.keys(WAVE_PRESETS) as WavePreset[];

/** A wave set: `WAVES_PER_SET` × `WAVE_FLOATS` numbers (the layout of `Water3d.waves`). */
export type WaveSet = Float32Array;

/** Build the set for a spec, `scale` times as high (weather wind). */
export function buildWaves(spec: WaveSpec, scale = 1): WaveSet {
  const out = new Float32Array(WAVES_PER_SET * WAVE_FLOATS);
  const height = spec.height * scale;
  if (!(height > 0)) return out;
  const random = new SeededRandom(spec.seed);
  const base = (spec.direction * Math.PI) / 180;
  const spread = (spec.spread * Math.PI) / 180;
  const raw: { dir: number; length: number; amp: number; phase: number }[] = [];
  for (let i = 0; i < WAVES_PER_SET; i++) {
    // Wavelengths from 0.3× to 1.5× the peak; longer waves are taller (steepness alike).
    const length = spec.wavelength * (0.3 + 1.2 * ((i + random.next()) / WAVES_PER_SET));
    raw.push({ dir: base + (random.next() * 2 - 1) * spread, length, amp: length, phase: random.next() * Math.PI * 2 });
  }
  // Significant height of a sum of sines: 4·sqrt(Σ a²/2).
  const sumSq = raw.reduce((n, w) => n + w.amp * w.amp, 0);
  const norm = height / (4 * Math.sqrt(sumSq / 2));
  raw.forEach((w, i) => {
    const k = (2 * Math.PI) / w.length;
    const a = w.amp * norm;
    const o = i * WAVE_FLOATS;
    out[o] = Math.sin(w.dir);
    out[o + 1] = Math.cos(w.dir);
    out[o + 2] = k;
    out[o + 3] = Math.sqrt(GRAVITY * k);
    out[o + 4] = a;
    // Q·k·A summed over the set is the choppiness: crests sharpen but never fold over.
    out[o + 5] = spec.choppiness / (k * a * WAVES_PER_SET);
    out[o + 6] = w.phase;
  });
  return out;
}

/** The surface point a rest position (x, z) moves to at time t: [x, y, z] (y relative to the still level). */
export function displace(waves: WaveSet, x: number, z: number, t: number, out: Float64Array = new Float64Array(3)): Float64Array {
  let dx = 0; let dy = 0; let dz = 0;
  for (let o = 0; o < waves.length; o += WAVE_FLOATS) {
    const a = waves[o + 4]!;
    if (a === 0) continue;
    const theta = waves[o + 2]! * (waves[o]! * x + waves[o + 1]! * z) - waves[o + 3]! * t + waves[o + 6]!;
    const qa = waves[o + 5]! * a * Math.cos(theta);
    dx += qa * waves[o]!;
    dz += qa * waves[o + 1]!;
    dy += a * Math.sin(theta);
  }
  out[0] = x + dx; out[1] = dy; out[2] = z + dz;
  return out;
}

const scratch = new Float64Array(3);

/** Height of the surface above the still level at world (x, z), time t. */
export function waveHeight(waves: WaveSet, x: number, z: number, t: number): number {
  let x0 = x; let z0 = z;
  for (let i = 0; i < 4; i++) {
    displace(waves, x0, z0, t, scratch);
    x0 += x - scratch[0]!;
    z0 += z - scratch[2]!;
  }
  return displace(waves, x0, z0, t, scratch)[1]!;
}

/** The surface's unit normal at world (x, z), time t, as [x, y, z]. */
export function waveNormal(waves: WaveSet, x: number, z: number, t: number): [number, number, number] {
  let x0 = x; let z0 = z;
  for (let i = 0; i < 4; i++) {
    displace(waves, x0, z0, t, scratch);
    x0 += x - scratch[0]!;
    z0 += z - scratch[2]!;
  }
  let nx = 0; let ny = 1; let nz = 0;
  for (let o = 0; o < waves.length; o += WAVE_FLOATS) {
    const a = waves[o + 4]!;
    if (a === 0) continue;
    const k = waves[o + 2]!;
    const theta = k * (waves[o]! * x0 + waves[o + 1]! * z0) - waves[o + 3]! * t + waves[o + 6]!;
    const ka = k * a;
    nx -= waves[o]! * ka * Math.cos(theta);
    nz -= waves[o + 1]! * ka * Math.cos(theta);
    ny -= waves[o + 5]! * ka * Math.sin(theta);
  }
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}
