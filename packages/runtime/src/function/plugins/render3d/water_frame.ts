/**
 * What water looks like (render3d's side of the `water_world` service): each body as a
 * `WaterBody3d` with its Gerstner waves (the very set gameplay samples), river ribbons as
 * geometry, splash and wake rings for the surface shader, and splash spray as billboards.
 *
 * Spray is a stateless field: each splash throws `12 × strength` droplets on seeded
 * ballistic arcs, drawn while they are above the surface it hit (about a second).
 */

import { BILLBOARD_STRIDE, hashNumbers, RIPPLE_FLOATS, WAVE_FLOATS } from '../../../core/index.js';
import type { BillboardBatch, Geometry3d, Rgb, Water3d, WaterBody3d } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { SPLASH_SECONDS, WAKE_SECONDS, WATER_WORLD_SERVICE } from '../../services/index.js';
import type { WaterBodyInfo, WaterDisturbance } from '../../services/index.js';

/** Most ripples the surface shader takes. */
export const MAX_RIPPLES = 32;
/** Seconds spray flies, and the droplets a full-strength splash throws. */
export const SPRAY_SECONDS = 1.2;
export const SPRAY_DROPLETS = 12;
const GRAVITY = 9.81;

export interface WaterDraws {
  readonly frame: Water3d | null;
  readonly billboards: BillboardBatch[];
}

/** A ring's radius and strength `age` seconds in. */
export function ripple(d: WaterDisturbance, age: number): { radius: number; strength: number } {
  const life = d.kind === 'splash' ? SPLASH_SECONDS : WAKE_SECONDS;
  const speed = d.kind === 'splash' ? 1.6 : 0.7;
  return { radius: 0.3 + speed * age, strength: d.strength * Math.max(0, 1 - age / life) };
}

/** A river's ribbon: five vertices across per course point, uvs (meters along, -1..1 across), colors (flow x, flow z, speed, 1). */
export function riverRibbon(body: WaterBodyInfo): Geometry3d {
  const c = body.course!;
  const n = c.xs.length;
  const across = 5;
  const count = n * across;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 4);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let along = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1); const b = Math.min(n - 1, i + 1);
    let dx = c.xs[b]! - c.xs[a]!; let dz = c.zs[b]! - c.zs[a]!;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    if (i > 0) along += Math.hypot(c.xs[i]! - c.xs[i - 1]!, c.zs[i]! - c.zs[i - 1]!);
    for (let k = 0; k < across; k++) {
      const s = (k / (across - 1)) * 2 - 1;
      const v = i * across + k;
      // Right of downstream is (dz, -dx).
      const x = c.xs[i]! + dz * s * (body.width / 2);
      const y = c.ys[i]!;
      const z = c.zs[i]! - dx * s * (body.width / 2);
      positions.set([x, y, z], v * 3);
      normals.set([0, 1, 0], v * 3);
      uvs.set([along, s], v * 2);
      colors.set([dx, dz, body.flow * 1.5 * (1 - s * s), 1], v * 4);
      min[0] = Math.min(min[0]!, x); min[1] = Math.min(min[1]!, y); min[2] = Math.min(min[2]!, z);
      max[0] = Math.max(max[0]!, x); max[1] = Math.max(max[1]!, y); max[2] = Math.max(max[2]!, z);
    }
  }
  const indices = new Uint32Array((n - 1) * (across - 1) * 6);
  let o = 0;
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k + 1 < across; k++) {
      const a = i * across + k; const b = a + 1; const d = a + across; const e = d + 1;
      // Wound so the cross product points up.
      indices[o++] = a; indices[o++] = e; indices[o++] = b;
      indices[o++] = a; indices[o++] = d; indices[o++] = e;
    }
  }
  return {
    id: `water:river:${body.entity}:${body.version}`, positions, normals, uvs, indices, joints: null, weights: null, colors,
    min: [min[0]!, min[1]! - 0.5, min[2]!], max: [max[0]!, max[1]! + 0.5, max[2]!],
  };
}

export class WaterVisuals {
  readonly #ribbons = new Map<string, Geometry3d>();

  build(kernel: Kernel, light: Rgb): WaterDraws {
    const world = kernel.tryService(WATER_WORLD_SERVICE);
    if (world === undefined) return { frame: null, billboards: [] };
    const bodies = world.bodies();
    const now = kernel.time.now;
    const waves: number[] = [];
    const seen = new Set<string>();
    const out: WaterBody3d[] = bodies.map((b) => {
      const firstWave = waves.length / WAVE_FLOATS;
      for (const n of b.waves) waves.push(n);
      let ribbon: Geometry3d | null = null;
      if (b.course !== null) {
        const key = `${b.entity}:${b.version}`;
        ribbon = this.#ribbons.get(key) ?? riverRibbon(b);
        this.#ribbons.set(key, ribbon);
        seen.add(key);
      }
      return {
        kind: b.kind, entity: b.entity, level: b.level, center: [b.center.x, b.center.y, b.center.z], halfSize: [b.halfX, b.halfZ],
        yaw: b.yaw, shape: b.shape, depth: b.depth, firstWave, waveCount: b.waves.length / WAVE_FLOATS, deep: b.deep, shallow: b.shallow,
        clarity: b.clarity, foam: b.foam, roughness: 0.04, caustics: b.caustics, ripple: b.ripple, calmDistance: b.calmDistance, ribbon,
      };
    });
    for (const key of [...this.#ribbons.keys()]) if (!seen.has(key)) this.#ribbons.delete(key);

    const disturbances = world.disturbances();
    const live = disturbances.slice(-MAX_RIPPLES);
    const ripples = new Float32Array(Math.max(1, live.length) * RIPPLE_FLOATS);
    live.forEach((d, i) => {
      const r = ripple(d, now - d.start);
      ripples.set([d.x, d.z, r.radius, r.strength], i * RIPPLE_FLOATS);
    });
    return {
      frame: bodies.length === 0 ? null : { time: now, waves: Float32Array.from(waves), bodies: out, ripples, rippleCount: live.length },
      billboards: spray(disturbances, now, light),
    };
  }
}

/** Splash spray: droplets on ballistic arcs from each recent splash. */
export function spray(disturbances: readonly WaterDisturbance[], now: number, light: Rgb): BillboardBatch[] {
  const drops: number[] = [];
  const shade = Math.min(1, Math.max(0.15, (0.2126 * light[0] + 0.7152 * light[1] + 0.0722 * light[2]) * 1.6));
  for (const d of disturbances) {
    if (d.kind !== 'splash') continue;
    const age = now - d.start;
    if (age < 0 || age > SPRAY_SECONDS) continue;
    const count = Math.max(3, Math.round(SPRAY_DROPLETS * d.strength));
    for (let i = 0; i < count; i++) {
      const h = hashNumbers(d.start, d.x, d.z, i);
      const a = ((h & 0xffff) / 0xffff) * Math.PI * 2;
      const up = 2 + 3.5 * d.strength * (((h >>> 16) & 0xff) / 0xff);
      const out = 0.6 + 1.6 * d.strength * ((h >>> 24) / 0xff);
      const y = d.y + up * age - 0.5 * GRAVITY * age * age;
      if (y < d.y) continue;
      const size = 0.05 + 0.1 * d.strength;
      drops.push(d.x + Math.cos(a) * out * age, y, d.z + Math.sin(a) * out * age, 0, 0, size, size, 0,
        0.92 * shade, 0.96 * shade, shade, 0.8 * (1 - age / SPRAY_SECONDS));
    }
  }
  if (drops.length === 0) return [];
  return [{ layer: 'scene', shape: 'circle', image: null, count: drops.length / BILLBOARD_STRIDE, data: Float32Array.from(drops), entity: null }];
}
