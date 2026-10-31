/**
 * Ribbon geometry for `ctx.vfx`: trails (an entity's recent path, smoothed, tapering and
 * fading to its tail), beams (a glowing core inside a soft halo) and lightning (a jagged
 * bolt by midpoint displacement, with forking branches, re-struck a few times a second).
 * Pure functions to `Ribbon3d`s (RIBBON_STRIDE numbers per point); render-only, so
 * nothing here touches the game's random generator — a bolt's shape is a hash of its seed.
 */

import { RIBBON_STRIDE } from '../../../core/index.js';
import type { Rgba, Ribbon3d } from '../../../core/index.js';

type Point = readonly [number, number, number];

/** A small deterministic generator (mulberry32) for a bolt's shape. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from numbers (positions, a count): the same numbers give the same bolt on every machine. */
export function seedOf(...values: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    h = Math.imul(h ^ Math.round(v * 1000), 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** Catmull-Rom through x, y, z points: `steps` points per segment, the last point kept. */
export function smoothPath(points: readonly number[], steps: number): number[] {
  const n = points.length / 3;
  if (n < 3 || steps <= 1) return [...points];
  const at = (i: number, c: number): number => points[Math.max(0, Math.min(n - 1, i)) * 3 + c]!;
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let c = 0; c < 3; c++) {
        const p0 = at(i - 1, c); const p1 = at(i, c); const p2 = at(i + 1, c); const p3 = at(i + 2, c);
        out.push(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
      }
    }
  }
  out.push(at(n - 1, 0), at(n - 1, 1), at(n - 1, 2));
  return out;
}

/** Points with a width and color each, oldest (tail) first. */
function strip(points: readonly number[], width: (u: number) => number, color: (u: number) => Rgba): Float32Array {
  const n = points.length / 3;
  const out = new Float32Array(n * RIBBON_STRIDE);
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 1 : i / (n - 1);
    const c = color(u);
    out.set([points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!, width(u), c[0], c[1], c[2], c[3]], i * RIBBON_STRIDE);
  }
  return out;
}

export interface TrailLook {
  readonly width: number;
  readonly color: Rgba;
  /** Additive with a bright core (energy, magic, tracer trails), else a soft alpha strip (smoke, sword swipes). */
  readonly glow: boolean;
}

/** A trail through its samples (x, y, z, time — oldest first): tapering to a quarter width and fading out at the tail. */
export function trailRibbon(samples: readonly number[], look: TrailLook, entity: number | null): Ribbon3d | null {
  const n = samples.length / 4;
  if (n < 2) return null;
  const points: number[] = [];
  for (let i = 0; i < n; i++) points.push(samples[i * 4]!, samples[i * 4 + 1]!, samples[i * 4 + 2]!);
  const smooth = smoothPath(points, n <= 48 ? 3 : 1);
  const { width, color } = look;
  return {
    blend: look.glow ? 'additive' : 'alpha',
    points: strip(smooth, (u) => width * (0.25 + 0.75 * u), (u) => [color[0], color[1], color[2], color[3] * u * u * (3 - 2 * u)]),
    intensity: look.glow ? 2 : 1,
    core: look.glow ? 0.3 : 0,
    entity,
  };
}

/** A beam: a white-hot core inside a halo of its color, fading over its last third of life (`left`: 1 → 0). */
export function beamRibbons(start: Point, end: Point, width: number, color: Rgba, intensity: number, left: number): Ribbon3d[] {
  const k = Math.min(1, left * 3);
  const points = [...start, ...end];
  return [{
    blend: 'additive',
    points: strip(points, () => width * 3, () => [color[0], color[1], color[2], color[3] * k]),
    intensity,
    core: 0.22,
    entity: null,
  }];
}

export interface Bolt {
  readonly start: Point;
  readonly end: Point;
  readonly width: number;
  readonly color: Rgba;
  readonly branches: number;
  readonly seed: number;
  /** Seconds it shows and seconds since it struck. */
  readonly seconds: number;
  readonly age: number;
}

/** How many times a second a bolt re-strikes (a new shape) while it shows. */
const RESTRIKES = 18;

/** A jagged path from a to b: midpoint displacement, `levels` halvings, sideways by `jag` × length at first. */
function jagged(a: Point, b: Point, levels: number, jag: number, rand: () => number): number[] {
  let pts: number[] = [...a, ...b];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  let amount = len * jag;
  for (let l = 0; l < levels; l++) {
    const next: number[] = [];
    for (let i = 0; i + 3 < pts.length; i += 3) {
      const ax = pts[i]!; const ay = pts[i + 1]!; const az = pts[i + 2]!;
      const bx = pts[i + 3]!; const by = pts[i + 4]!; const bz = pts[i + 5]!;
      // A random offset perpendicular to the segment.
      let dx = bx - ax; let dy = by - ay; let dz = bz - az;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      let rx = rand() * 2 - 1; let ry = rand() * 2 - 1; let rz = rand() * 2 - 1;
      const along = rx * dx + ry * dy + rz * dz;
      rx -= along * dx; ry -= along * dy; rz -= along * dz;
      const rl = Math.hypot(rx, ry, rz) || 1;
      const m = amount * (rand() * 2 - 1);
      next.push(ax, ay, az, (ax + bx) / 2 + (rx / rl) * m, (ay + by) / 2 + (ry / rl) * m, (az + bz) / 2 + (rz / rl) * m);
    }
    next.push(pts[pts.length - 3]!, pts[pts.length - 2]!, pts[pts.length - 1]!);
    pts = next;
    amount *= 0.5;
  }
  return pts;
}

/** A lightning bolt now: its main channel and forks, flickering and fading over its life. */
export function lightningRibbons(bolt: Bolt): Ribbon3d[] {
  const { start, end, width, color } = bolt;
  const t = bolt.age / Math.max(bolt.seconds, 1e-3);
  if (t >= 1) return [];
  const strike = Math.floor(bolt.age * RESTRIKES);
  const rand = generator(seedOf(bolt.seed, strike));
  const len = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const levels = Math.max(2, Math.min(7, Math.round(Math.log2(Math.max(1, len / 0.35)))));
  const main = jagged(start, end, levels, 0.16, rand);
  // Bright when struck, flickering, then dying away.
  const flicker = 0.55 + 0.45 * rand();
  const k = (1 - t) * (1 - t) * flicker;
  const out: Ribbon3d[] = [];
  const bright = (alpha: number): Rgba => [color[0], color[1], color[2], color[3] * alpha];
  out.push({ blend: 'additive', points: strip(main, () => width * 3.5, () => bright(k)), intensity: 4, core: 0.2, entity: null });
  const n = main.length / 3;
  for (let b = 0; b < bolt.branches; b++) {
    const at = Math.floor(n * (0.15 + 0.7 * rand()));
    const from: Point = [main[at * 3]!, main[at * 3 + 1]!, main[at * 3 + 2]!];
    // Forks run on roughly toward the end, turned aside.
    const reach = len * (0.15 + 0.3 * rand());
    let dx = end[0] - from[0] + (rand() * 2 - 1) * len * 0.5;
    let dy = end[1] - from[1] + (rand() * 2 - 1) * len * 0.5;
    let dz = end[2] - from[2] + (rand() * 2 - 1) * len * 0.5;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx = (dx / dl) * reach; dy = (dy / dl) * reach; dz = (dz / dl) * reach;
    const fork = jagged(from, [from[0] + dx, from[1] + dy, from[2] + dz], Math.max(1, levels - 2), 0.22, rand);
    out.push({
      blend: 'additive',
      points: strip(fork, (u) => width * 2.2 * (1 - 0.85 * u), (u) => bright(k * 0.75 * (1 - u * 0.7))),
      intensity: 3,
      core: 0.18,
      entity: null,
    });
  }
  return out;
}
