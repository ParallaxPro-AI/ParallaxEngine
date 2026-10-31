/**
 * Math helpers from the SDK: scalar helpers, angles (degrees), easing, value noise and
 * `scatter`. Pure functions except `scatter`, which draws from the game's random source.
 */

import { rt } from './types.js';
import { deg, EASE_KINDS, fail, rad, Vec2, Vec3, wrapAngle } from '../core/index.js';
import { bindArgs } from './kwargs.js';
import { activeRandom } from './random.js';

export { deg, rad };

export function vec2(x = 0, y = 0): Vec2 { return new Vec2(x, y); }
export function vec3(x = 0, y = 0, z = 0): Vec3 { return new Vec3(x, y, z); }

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

export function inverse_lerp(a: number, b: number, value: number): number {
  if (a === b) fail('PP3021', 'inverse_lerp() with a == b divides by zero');
  return (value - a) / (b - a);
}

export function remap(value: number, from_lo: number, from_hi: number, to_lo: number, to_hi: number): number {
  return lerp(to_lo, to_hi, inverse_lerp(from_lo, from_hi, value));
}

export function move_toward(current: number, target: number, max_step: number): number {
  if (Math.abs(target - current) <= max_step) return target;
  return current + Math.sign(target - current) * max_step;
}

export function approach(current: Vec3, target: Vec3, max_step: number): Vec3 {
  const delta = target.__sub__(current);
  const distance = delta.length();
  if (distance <= max_step || distance === 0) return target;
  return current.__add__(delta.__mul__(max_step / distance));
}

export function wrap_angle(degrees: number): number { return wrapAngle(degrees); }

export function angle_between(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  const dot = (a as Vec3).dot(b as Vec3);
  const lengths = a.length() * b.length();
  if (lengths === 0) return 0;
  return deg(Math.acos(clamp(dot / lengths, -1, 1)));
}

export function angle_to(origin: Vec2, target: Vec2): number { return target.__sub__(origin).angle(); }

/** Yaw (0 = +z, positive toward +x) from origin to target on the ground plane. */
export function heading_to(origin: Vec3, target: Vec3): number {
  return deg(Math.atan2(target.x - origin.x, target.z - origin.z));
}

export function rotate_toward(current_deg: number, target_deg: number, max_step_deg: number): number {
  const delta = wrapAngle(target_deg - current_deg);
  if (Math.abs(delta) <= max_step_deg) return current_deg + delta;
  return current_deg + Math.sign(delta) * max_step_deg;
}

// ── Easing ─────────────────────────────────────────────────────────────────────

// The table lives in core (core/values/ease.ts) so every timed engine feature eases alike.
export { ease, EASE_KINDS, easing } from '../core/index.js';

/** `Ease` (SDK `Literal["linear", …]`): the type of an ease name, usable in annotations and fields. */
export const Ease = rt.literal(...EASE_KINDS);

// ── Noise and scatter ──────────────────────────────────────────────────────────

/** Lattice value in -1..1, a pure function of (x, y, seed). */
function lattice(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function smooth(t: number): number { return t * t * (3 - 2 * t); }

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const top = lerp(lattice(x0, y0, seed), lattice(x0 + 1, y0, seed), tx);
  const bottom = lerp(lattice(x0, y0 + 1, seed), lattice(x0 + 1, y0 + 1, seed), tx);
  return lerp(top, bottom, ty);
}

/**
 * Smooth value noise in -1..1. `scale` is the feature size in world units (larger is
 * smoother); each extra octave adds detail at twice the frequency and half the amplitude.
 */
export function noise2d(x: number, y: number, ...args: unknown[]): number {
  const options = bindArgs('noise2d', args, { keyword: ['seed', 'octaves', 'scale'] }).args;
  const seed = (options['seed'] ?? 0) as number;
  const octaves = (options['octaves'] ?? 1) as number;
  const scale = (options['scale'] ?? 1) as number;
  if (!(scale > 0)) fail('PP3034', `noise2d() scale must be positive, got ${scale}`);
  if (!Number.isInteger(octaves) || octaves < 1) fail('PP3034', `noise2d() octaves must be a positive int, got ${octaves}`);
  let total = 0;
  let amplitude = 1;
  let norm = 0;
  let frequency = 1 / scale;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, y * frequency, seed + i * 1013) * amplitude;
    norm += amplitude;
    amplitude /= 2;
    frequency *= 2;
  }
  return total / norm;
}

/**
 * Up to `count` points in a disc around `center`, never closer than `min_spacing`. A Vec3
 * center scatters on the ground plane (x, z); a Vec2 center on the play plane, returned
 * as Vec3(x, y, 0).
 */
export function scatter(center: Vec3 | Vec2, radius: number, count: number, ...args: unknown[]): Vec3[] {
  const minSpacing = (bindArgs('scatter', args, { keyword: ['min_spacing'] }).args['min_spacing'] ?? 0) as number;
  const random = activeRandom();
  const points: Vec3[] = [];
  const attempts = count * 30;
  for (let i = 0; i < attempts && points.length < count; i++) {
    const r = radius * Math.sqrt(random.next());
    const a = random.next() * Math.PI * 2;
    const point = center instanceof Vec3
      ? new Vec3(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r)
      : new Vec3(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r, 0);
    if (minSpacing > 0 && points.some((p) => p.distance_to(point) < minSpacing)) continue;
    points.push(point);
  }
  return points;
}
