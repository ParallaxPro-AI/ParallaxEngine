/**
 * What the weather looks like (render3d's side of the `weather` service): rain, snow and
 * hail around the first camera, splashes where drops land, lightning bolts, and the cover
 * map that keeps all of it out from under roofs (and tells the surface pass what is exposed
 * to get wet).
 *
 * Precipitation is a stateless field: drop i's position is a function of its hash and game
 * time, anchored in world space (drops wrap around a box that follows the camera, so they
 * don't slide when it moves), slanted by the wind. A drop below its cell's cover height is
 * not drawn: it fell onto the roof above. Splashes land on the cover height itself — on the
 * ground in the open, on the roof under one.
 *
 * The cover map is the first surface a ray straight down meets (physics3d), per meter
 * around the camera. It is re-cast a slice per frame, round and round (the whole map every
 * 16 frames, so a roof that appears is soon dry underneath), and starts over when the camera
 * strays from its center.
 * Without physics3d the terrain's height is used; with neither, nothing is covered.
 */

import { hashNumbers } from '../../../core/index.js';
import type { BillboardBatch, CoverMap3d, Line3d, Quality3d, Rgb, View3d, Weather3d } from '../../../core/index.js';
import { BILLBOARD_STRIDE, Vec3 } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE, TERRAIN_SERVICE, WEATHER_SERVICE, WIND_SERVICE } from '../../services/index.js';
import type { LightningStrike, WeatherConditions } from '../../services/index.js';

/** Cells per side of the cover map, and meters per cell. */
export const COVER_CELLS = 64;
export const COVER_CELL = 1;
/** Cells the map re-casts per frame. */
const COVER_PER_FRAME = 256;
/** Meters above the camera rays start down from, and how far they reach. */
const COVER_TOP = 80;
const COVER_REACH = 400;
const UNCOVERED = -1e9;

/** Drops at full strength by quality. */
export const PRECIPITATION: Readonly<Record<Quality3d['level'], number>> = { low: 600, medium: 1500, high: 3000 };
/** The box around the camera precipitation falls in: meters across and tall. */
export const FALL_BOX = 36;
export const FALL_HEIGHT = 24;
/** Seconds a bolt is drawn. */
export const BOLT_SECONDS = 0.35;

function fract(n: number): number {
  return n - Math.floor(n);
}

/** Three values in [0, 1) from a drop's index (and a salt). */
function hash3(i: number, salt: number): [number, number, number] {
  const h = hashNumbers(i, salt);
  return [fract(h / 4294967296), fract(hashNumbers(h, 1) / 4294967296), fract(hashNumbers(h, 2) / 4294967296)];
}

/** `base + ((value - base) mod span)`: a coordinate wrapped into [base, base + span). */
function wrap(value: number, base: number, span: number): number {
  return base + (((value - base) % span) + span) % span;
}

export class CoverMap {
  readonly #heights = new Float32Array(COVER_CELLS * COVER_CELLS).fill(UNCOVERED);
  #originX = Number.NaN;
  #originZ = Number.NaN;
  #next = 0;
  #version = 0;
  #scene = '';

  /** Keep the map centered near (x, z): recenter (and start refilling) when the camera strays 16 m. */
  update(kernel: Kernel, x: number, y: number, z: number): CoverMap3d | null {
    const physics = kernel.tryService(PHYSICS3D_SERVICE);
    const terrain = kernel.tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (physics === undefined && terrain === null) return null;
    const scene = kernel.scene?.id ?? '';
    const half = (COVER_CELLS * COVER_CELL) / 2;
    const snap = 16;
    const ox = Math.round(x / snap) * snap - half;
    const oz = Math.round(z / snap) * snap - half;
    if (ox !== this.#originX || oz !== this.#originZ || scene !== this.#scene) {
      this.#originX = ox;
      this.#originZ = oz;
      this.#scene = scene;
      this.#heights.fill(UNCOVERED);
      this.#next = 0;
    }
    const total = this.#heights.length;
    const down = new Vec3(0, -1, 0);
    for (let n = 0; n < COVER_PER_FRAME; n++) {
      const i = this.#next;
      const cx = ox + ((i % COVER_CELLS) + 0.5) * COVER_CELL;
      const cz = oz + (Math.floor(i / COVER_CELLS) + 0.5) * COVER_CELL;
      const hit = physics?.raycast(new Vec3(cx, y + COVER_TOP, cz), down, COVER_REACH);
      this.#heights[i] = hit !== undefined ? hit.point.y : terrain !== null && terrain.contains(cx, cz) ? terrain.heightAt(cx, cz) : UNCOVERED;
      this.#next = (i + 1) % total;
    }
    this.#version++;
    return { originX: ox, originZ: oz, cell: COVER_CELL, size: COVER_CELLS, heights: this.#heights, version: this.#version };
  }
}

/** The cover height at (x, z) on a map (undefined off the map or not yet known). */
export function coverAt(map: CoverMap3d | null, x: number, z: number): number | undefined {
  if (map === null) return undefined;
  const cx = Math.floor((x - map.originX) / map.cell);
  const cz = Math.floor((z - map.originZ) / map.cell);
  if (cx < 0 || cz < 0 || cx >= map.size || cz >= map.size) return undefined;
  const h = map.heights[cz * map.size + cx]!;
  return h <= UNCOVERED ? undefined : h;
}

interface Precipitation {
  readonly count: number;
  readonly speed: number;
  readonly length: number;
  readonly width: number;
  readonly color: Rgb;
  readonly alpha: number;
  readonly flutter: number;
  readonly salt: number;
}

export interface WeatherDraws {
  readonly frame: Weather3d | null;
  readonly billboards: BillboardBatch[];
  readonly lines: Line3d[];
}

/** Lightness of unlit particles under the sky now: they shouldn't glow at night. */
function lightness(ambient: Rgb, flash: number): number {
  const l = 0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2];
  return Math.min(1, Math.max(0.12, l * 1.6 + flash));
}

export class WeatherVisuals {
  readonly cover = new CoverMap();

  build(kernel: Kernel, view: View3d | undefined, ambient: Rgb, quality: Quality3d): WeatherDraws {
    const service = kernel.tryService(WEATHER_SERVICE);
    if (service === undefined || view === undefined) return { frame: null, billboards: [], lines: [] };
    const w = service.conditions();
    const [cx, cy, cz] = view.position;
    const cover = this.cover.update(kernel, cx, cy, cz);
    const billboards: BillboardBatch[] = [];
    const t = kernel.time.now;
    const light = lightness(ambient, Math.min(1, w.flash));
    const wind = this.#wind(kernel, w, cx, cz);
    const max = PRECIPITATION[quality.level];
    const kinds: Precipitation[] = [
      { count: Math.round(max * w.rain), speed: 9.5, length: 0.45, width: 0.018, color: [0.72, 0.78, 0.85], alpha: 0.4, flutter: 0, salt: 11 },
      { count: Math.round(max * 0.6 * w.snow), speed: 1.3, length: 0.05, width: 0.05, color: [0.95, 0.97, 1], alpha: 0.9, flutter: 0.5, salt: 12 },
      { count: Math.round(max * 0.4 * w.hail), speed: 16, length: 0.14, width: 0.035, color: [0.92, 0.94, 0.96], alpha: 0.85, flutter: 0, salt: 13 },
    ];
    for (const kind of kinds) {
      if (kind.count <= 0) continue;
      const batch = this.#fall(kind, view, cover, wind, t, light);
      if (batch !== null) billboards.push(batch);
    }
    const splashes = this.#splashes(Math.round((max / 4) * (w.rain + w.hail)), view, cover, t, light);
    if (splashes !== null) billboards.push(splashes);
    const lines = service.recentStrikes(BOLT_SECONDS).flatMap((s) => bolt(s, t));
    return {
      frame: { wetness: w.wetness, snow: w.snowCover, rain: Math.max(w.rain, w.hail * 0.5), cover },
      billboards,
      lines,
    };
  }

  #wind(kernel: Kernel, w: WeatherConditions, x: number, z: number): [number, number] {
    const field = kernel.tryService(WIND_SERVICE);
    if (field !== undefined) {
      const s = field.sample(x, z);
      return [s[0]!, s[1]!];
    }
    return [w.wind * 0.7, 0];
  }

  #fall(kind: Precipitation, view: View3d, cover: CoverMap3d | null, wind: readonly [number, number], t: number, light: number): BillboardBatch | null {
    const data = new Float32Array(kind.count * BILLBOARD_STRIDE);
    const [cx, cy, cz] = view.position;
    const baseX = cx - FALL_BOX / 2;
    const baseZ = cz - FALL_BOX / 2;
    const baseY = cy - FALL_HEIGHT / 2;
    // Drops drift with the wind (light flakes all the way, heavy drops partly).
    const drift = kind.speed < 3 ? 1 : 0.6;
    const vx = wind[0] * drift;
    const vz = wind[1] * drift;
    const vy = -kind.speed;
    // The streak's angle on screen: along its velocity.
    const right = view.right; const up = view.up;
    const vr = vx * right[0] + vy * right[1] + vz * right[2];
    const vu = vx * up[0] + vy * up[1] + vz * up[2];
    const angle = (Math.atan2(vr, -vu) * 180) / Math.PI;
    const color = kind.color.map((c) => c * light);
    let n = 0;
    for (let i = 0; i < kind.count; i++) {
      const [h1, h2, h3] = hash3(i, kind.salt);
      const flutter = kind.flutter * Math.sin(t * 1.7 + h3 * 40);
      const x = wrap(h1 * FALL_BOX + vx * t + flutter, baseX, FALL_BOX);
      const z = wrap(h3 * FALL_BOX + vz * t + flutter * 0.6, baseZ, FALL_BOX);
      const y = wrap(h2 * FALL_HEIGHT + vy * t * (0.85 + 0.3 * h3), baseY, FALL_HEIGHT);
      const roof = coverAt(cover, x, z);
      if (roof !== undefined && y < roof) continue;
      const o = n * BILLBOARD_STRIDE;
      data[o] = x; data[o + 1] = y; data[o + 2] = z;
      data[o + 3] = 0; data[o + 4] = 0;
      data[o + 5] = kind.width; data[o + 6] = kind.length;
      data[o + 7] = angle;
      data[o + 8] = color[0]!; data[o + 9] = color[1]!; data[o + 10] = color[2]!; data[o + 11] = kind.alpha;
      n++;
    }
    if (n === 0) return null;
    return { layer: 'scene', shape: kind.flutter > 0 ? 'circle' : 'square', image: null, count: n, data: data.subarray(0, n * BILLBOARD_STRIDE), entity: null };
  }

  #splashes(count: number, view: View3d, cover: CoverMap3d | null, t: number, light: number): BillboardBatch | null {
    if (count <= 0 || cover === null) return null;
    const period = 0.6;
    const visible = 0.12;
    const data = new Float32Array(count * BILLBOARD_STRIDE);
    const [cx, , cz] = view.position;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const [phase] = hash3(i, 21);
      const cycle = Math.floor(t / period + phase);
      const age = (t / period + phase - cycle) * period;
      if (age > visible) continue;
      const [hx, hz] = hash3(i * 7919 + cycle, 22);
      const x = cx + (hx - 0.5) * FALL_BOX;
      const z = cz + (hz - 0.5) * FALL_BOX;
      const y = coverAt(cover, x, z);
      if (y === undefined) continue;
      const o = n * BILLBOARD_STRIDE;
      const size = 0.05 + 0.12 * (age / visible);
      data[o] = x; data[o + 1] = y + 0.02; data[o + 2] = z;
      data[o + 5] = size; data[o + 6] = size * 0.5;
      data[o + 8] = 0.8 * light; data[o + 9] = 0.85 * light; data[o + 10] = 0.9 * light; data[o + 11] = 0.5 * (1 - age / visible);
      n++;
    }
    if (n === 0) return null;
    return { layer: 'scene', shape: 'circle', image: null, count: n, data: data.subarray(0, n * BILLBOARD_STRIDE), entity: null };
  }
}

/**
 * A lightning bolt from the cloud base down to the strike: a jagged trunk (midpoint
 * displacement, seeded by the strike) inside a faint halo, with a few forks, flickering with the flash.
 */
export function bolt(strike: LightningStrike, now: number): Line3d[] {
  const age = now - strike.time;
  if (age < 0 || age > BOLT_SECONDS) return [];
  const flicker = Math.max(0.25, Math.abs(Math.cos(age * 40)));
  const alpha = Math.min(1, (1 - age / BOLT_SECONDS) * 1.6) * flicker;
  let seed = strike.seed;
  const random = (): number => {
    seed = hashNumbers(seed, 0x51ed);
    return seed / 4294967296;
  };
  const top: [number, number, number] = [strike.point.x + (random() - 0.5) * 200, strike.cloud, strike.point.z + (random() - 0.5) * 200];
  const bottom: [number, number, number] = [strike.point.x, strike.point.y, strike.point.z];
  const jag = (a: readonly number[], b: readonly number[], depth: number, spread: number): number[] => {
    let points: number[][] = [[...a], [...b]];
    for (let d = 0; d < depth; d++) {
      const next: number[][] = [points[0]!];
      for (let i = 1; i < points.length; i++) {
        const p = points[i - 1]!; const q = points[i]!;
        const len = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!);
        next.push([
          (p[0]! + q[0]!) / 2 + (random() - 0.5) * len * spread,
          (p[1]! + q[1]!) / 2 + (random() - 0.5) * len * spread * 0.3,
          (p[2]! + q[2]!) / 2 + (random() - 0.5) * len * spread,
        ], q);
      }
      points = next;
    }
    return points.flat();
  };
  const color = [0.86, 0.9, 1, alpha] as const;
  const trunk = jag(top, bottom, 6, 0.35);
  const core = Float32Array.from(trunk);
  // A wide faint halo around the core: lines can't be brighter than white, so the glow is drawn.
  const out: Line3d[] = [
    { layer: 'scene', points: core, width: 9 * strike.strength, color: [color[0], color[1], color[2], alpha * 0.22], entity: null },
    { layer: 'scene', points: core, width: 2 * strike.strength, color, entity: null },
  ];
  for (let f = 0; f < 3; f++) {
    const at = 3 * (8 + Math.floor(random() * 40));
    const from = trunk.slice(at, at + 3);
    const drop = (strike.cloud - strike.point.y) * (0.15 + 0.2 * random());
    const to = [from[0]! + (random() - 0.5) * drop, from[1]! - drop, from[2]! + (random() - 0.5) * drop];
    out.push({ layer: 'scene', points: Float32Array.from(jag(from, to, 4, 0.4)), width: 0.5 * strike.strength, color: [color[0], color[1], color[2], alpha * 0.7], entity: null });
  }
  return out;
}
