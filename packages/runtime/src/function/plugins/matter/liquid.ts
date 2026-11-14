/**
 * Liquid held in a container: how high it stands, how its surface looks and moves, when
 * it spills — plain arithmetic over the container's pose (no kernel).
 *
 * The container's interior is a frustum along its local +y: `radius` at the floor (local
 * y = `floor`), `top_radius` at the rim, `depth` tall. The volume decides the fill height
 * (exactly, for the frustum). The surface stays level in the world however the container
 * tilts: each surface vertex is the interior's cross-section point whose world height is the
 * surface's (a tilted cylinder's surface is the ellipse it cuts), clamped to the floor (a dry
 * patch) and to the rim (where it spills over the lowest point of the rim).
 *
 * On that level surface ride:
 *   slosh   a damped tilt the container's horizontal acceleration drives (tan θ = a/g at
 *           rest), so a jerked tray's liquid runs up one side and rocks back
 *   swirl   stirring spins the liquid (an angular velocity viscosity slows); the forced
 *           vortex dips the middle by Ω²(ρ² − R²/2)/2g (volume kept) and turns streaks
 *   bubbles boiling rolls domes over the surface (rate and size grow with the boil);
 *           near the boil a few small ones rise
 *   stream  while it spills, a falling stream from the lip down to what catches it
 */

import { hash01 } from './mesh.js';

export const GRAVITY = 9.81;

export interface Vessel {
  readonly radius: number;
  readonly topRadius: number;
  readonly depth: number;
  readonly floor: number;
}

/** Radius of the interior at height h above the floor. */
export function radiusAt(v: Vessel, h: number): number {
  const top = v.topRadius > 0 ? v.topRadius : v.radius;
  return v.radius + ((top - v.radius) * Math.max(0, Math.min(v.depth, h))) / Math.max(1e-6, v.depth);
}

/** Volume (m³) up to height h above the floor (frustum). */
export function volumeAt(v: Vessel, h: number): number {
  const hh = Math.max(0, h);
  const r0 = v.radius;
  const r1 = radiusAt(v, hh);
  return (Math.PI * hh * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
}

/** Fill height (m above the floor) of `volume` m³; past the rim it keeps rising as a straight wall. */
export function heightOf(v: Vessel, volume: number): number {
  if (volume <= 0) return 0;
  const full = volumeAt(v, v.depth);
  if (volume >= full) {
    const r = radiusAt(v, v.depth);
    return v.depth + (volume - full) / (Math.PI * r * r);
  }
  let lo = 0;
  let hi = v.depth;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (volumeAt(v, mid) < volume) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Capacity (liters) of the vessel. */
export function capacityLiters(v: Vessel): number {
  return volumeAt(v, v.depth) * 1000;
}

export interface Pose {
  /** World position of the container's origin. */
  readonly origin: readonly [number, number, number];
  /** Column-major 3×3 rotation (local → world). */
  readonly R: readonly number[];
}

export interface Bubble {
  x: number;
  z: number;
  r: number;
  age: number;
  life: number;
}

const RINGS = 7;
const SEGMENTS = 36;
const BUBBLE_SIDES = 8;
const MAX_BUBBLES = 40;
const STREAM_SIDES = 6;
const STREAM_ROWS = 8;

export interface SurfaceLook {
  readonly color: readonly [number, number, number, number];
  /** 0..1: how hard it boils (bubbles, foam). */
  readonly boil: number;
  /** 0..1: below the boil, small bubbles rising. */
  readonly nearBoil: number;
}

export interface SpillState {
  /** Liters per second leaving over the rim. */
  readonly rate: number;
  /** World point of the lip it leaves from. */
  readonly lip: readonly [number, number, number];
}

/** World-space surface mesh pieces, rebuilt each step. */
export interface LiquidGeometry {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  min: [number, number, number];
  max: [number, number, number];
}

export class LiquidSim {
  /** Slosh tilt (dh/dx, dh/dz in the world) and its rate. */
  sx = 0;
  sz = 0;
  vx = 0;
  vz = 0;
  /** Stream phase for colour streaks, radians. */
  phase = 0;
  bubbles: Bubble[] = [];
  #lastVel: [number, number, number] | null = null;
  #lastPos: [number, number, number] | null = null;
  #seq = 0;
  /** Where the stream falls to (world y), set by the plugin from what catches it. */
  streamEnd = 0;
  spill: SpillState = { rate: 0, lip: [0, 0, 0] };

  /** Container motion → slosh, swirl decay, bubbles. `viscosity` 0 water … 1 glycerin. */
  step(dt: number, pose: Pose, v: Vessel, height: number, swirl: number, viscosity: number, look: SurfaceLook, seed: number): void {
    const p = pose.origin;
    let ax = 0;
    let az = 0;
    if (this.#lastPos !== null && dt > 0) {
      const vel: [number, number, number] = [(p[0] - this.#lastPos[0]) / dt, (p[1] - this.#lastPos[1]) / dt, (p[2] - this.#lastPos[2]) / dt];
      if (this.#lastVel !== null) {
        ax = (vel[0] - this.#lastVel[0]) / dt;
        az = (vel[2] - this.#lastVel[2]) / dt;
      }
      this.#lastVel = vel;
    }
    this.#lastPos = [p[0], p[1], p[2]];
    // Keep a teleport (a pickup snapping into the hand) from flinging the whole container out.
    const lim = 3 * GRAVITY;
    ax = Math.max(-lim, Math.min(lim, ax));
    az = Math.max(-lim, Math.min(lim, az));
    const R = Math.max(0.01, radiusAt(v, height));
    const w = Math.sqrt((GRAVITY * 1.84) / R);
    const zeta = 0.06 + 0.9 * viscosity;
    const tx = -ax / GRAVITY;
    const tz = -az / GRAVITY;
    // Semi-implicit, substepped (the slosh frequency of a cup is high).
    const n = 4;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.vx += (w * w * (tx - this.sx) - 2 * zeta * w * this.vx) * h;
      this.vz += (w * w * (tz - this.sz) - 2 * zeta * w * this.vz) * h;
      this.sx += this.vx * h;
      this.sz += this.vz * h;
    }
    const maxTilt = 0.9;
    this.sx = Math.max(-maxTilt, Math.min(maxTilt, this.sx));
    this.sz = Math.max(-maxTilt, Math.min(maxTilt, this.sz));
    this.phase += swirl * dt;
    // Bubbles: spawn by a deterministic sequence, age, pop.
    for (const b of this.bubbles) b.age += dt;
    this.bubbles = this.bubbles.filter((b) => b.age < b.life);
    const rate = look.boil * 60 + look.nearBoil * 6;
    const expected = rate * dt;
    let count = Math.floor(expected);
    if (hash01(this.#seq, 3, 5, seed) < expected - count) count++;
    for (let i = 0; i < count && this.bubbles.length < MAX_BUBBLES; i++) {
      const s = ++this.#seq;
      const ang = hash01(s, 1, 2, seed) * Math.PI * 2;
      const rad = Math.sqrt(hash01(s, 2, 3, seed)) * 0.85;
      const big = look.boil > 0 ? look.boil : 0.25;
      const size = (0.002 + 0.006 * big) * (0.5 + hash01(s, 4, 5, seed)) * Math.min(1.5, R / 0.08 + 0.4);
      this.bubbles.push({ x: Math.cos(ang) * rad, z: Math.sin(ang) * rad, r: size, age: 0, life: 0.18 + 0.4 * hash01(s, 6, 7, seed) });
    }
  }

  /**
   * Build the surface (and bubbles and stream) for the container at `pose` filled to
   * `height` above its floor, and work out the spill. Returns null when it holds nothing.
   */
  geometry(pose: Pose, v: Vessel, height: number, swirl: number, look: SurfaceLook): LiquidGeometry | null {
    if (height <= 1e-5) {
      this.spill = { rate: 0, lip: [0, 0, 0] };
      return null;
    }
    const R = pose.R;
    const o = pose.origin;
    const ay = R[4]!;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const world = (x: number, y: number, z: number): [number, number, number] => [
      o[0] + R[0]! * x + R[3]! * y + R[6]! * z,
      o[1] + R[1]! * x + R[4]! * y + R[7]! * z,
      o[2] + R[2]! * x + R[5]! * y + R[8]! * z,
    ];
    const axisPoint = world(0, v.floor + Math.min(height, v.depth), 0);
    const level = axisPoint[1];
    const rim = v.floor + v.depth;
    const Rh = radiusAt(v, Math.min(height, v.depth));
    let spillExcess = 0;
    let lip: [number, number, number] = [0, 0, 0];
    const [cr, cg, cb, ca] = look.color;
    /** The interior point at angle φ, radial share u (0..1), whose world height is the surface's. */
    const surfacePoint = (u: number, phi: number): { p: [number, number, number]; y: number } => {
      const cx = Math.cos(phi);
      const cz = Math.sin(phi);
      // Two passes: the frustum's radius depends on the height found.
      let y = v.floor + Math.min(height, v.depth);
      let p: [number, number, number] = [0, 0, 0];
      for (let pass = 0; pass < 2; pass++) {
        const r = radiusAt(v, y - v.floor) * u;
        const lx = cx * r;
        const lz = cz * r;
        // World height of (lx, 0, lz) plus the axis's share of y.
        const base = o[1] + R[1]! * lx + R[7]! * lz;
        const wx = o[0] + R[0]! * lx + R[6]! * lz - axisPoint[0];
        const wz = o[2] + R[2]! * lx + R[8]! * lz - axisPoint[2];
        const rho2 = wx * wx + wz * wz;
        const target = level + this.sx * wx + this.sz * wz + (swirl * swirl * (rho2 - (Rh * Rh) / 2)) / (2 * GRAVITY);
        y = Math.abs(ay) > 0.05 ? (target - base) / ay : v.floor + height;
        y = Math.max(v.floor + 0.0015, y);
        p = world(lx, Math.min(y, rim), lz);
      }
      return { p, y };
    };
    // Disc: a middle vertex, then rings out to the wall.
    const centre = surfacePoint(0, 0);
    pos.push(...centre.p);
    const shade = (u: number, phi: number, foam: number): void => {
      const streak = swirl !== 0 ? 0.06 * Math.min(1, Math.abs(swirl) / 6) * Math.sin(3 * (phi - this.phase) + u * 5) : 0;
      const k = 1 + streak + 0.1 * u;
      const f = Math.min(1, foam);
      col.push(Math.min(1, cr * k + (1 - cr) * f * 0.6), Math.min(1, cg * k + (1 - cg) * f * 0.6), Math.min(1, cb * k + (1 - cb) * f * 0.6), Math.min(1, ca + f * 0.3));
    };
    shade(0, 0, look.boil * 0.3);
    for (let ring = 1; ring <= RINGS; ring++) {
      const u = ring / RINGS;
      for (let s = 0; s < SEGMENTS; s++) {
        const phi = (s / SEGMENTS) * Math.PI * 2;
        const sp = surfacePoint(u, phi);
        pos.push(...sp.p);
        shade(u, phi, look.boil * (0.2 + 0.4 * u));
        if (ring === RINGS && sp.y > rim && sp.y - rim > spillExcess) {
          spillExcess = sp.y - rim;
          lip = sp.p;
        }
      }
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const s1 = (s + 1) % SEGMENTS;
      idx.push(0, 1 + s1, 1 + s);
    }
    for (let ring = 1; ring < RINGS; ring++) {
      const a = 1 + (ring - 1) * SEGMENTS;
      const b = 1 + ring * SEGMENTS;
      for (let s = 0; s < SEGMENTS; s++) {
        const s1 = (s + 1) % SEGMENTS;
        idx.push(a + s, a + s1, b + s1, a + s, b + s1, b + s);
      }
    }
    // Bubbles: low domes standing on the surface.
    for (const bub of this.bubbles) {
      const u = Math.hypot(bub.x, bub.z);
      const phi = Math.atan2(bub.z, bub.x);
      const at = surfacePoint(u, phi).p;
      const grow = Math.sin((Math.PI * bub.age) / bub.life);
      const r = bub.r * (0.6 + 0.4 * grow);
      const top = r * 0.9 * grow;
      const base = pos.length / 3;
      pos.push(at[0], at[1] + top, at[2]);
      col.push(Math.min(1, cr + 0.25), Math.min(1, cg + 0.25), Math.min(1, cb + 0.25), Math.min(1, ca + 0.25));
      for (let k = 0; k < BUBBLE_SIDES; k++) {
        const t = (k / BUBBLE_SIDES) * Math.PI * 2;
        pos.push(at[0] + Math.cos(t) * r, at[1] + 0.0005, at[2] + Math.sin(t) * r);
        col.push(Math.min(1, cr + 0.15), Math.min(1, cg + 0.15), Math.min(1, cb + 0.15), Math.min(1, ca + 0.2));
      }
      for (let k = 0; k < BUBBLE_SIDES; k++) idx.push(base, base + 1 + ((k + 1) % BUBBLE_SIDES), base + 1 + k);
    }
    // Spill: over a weir, rate ∝ excess^1.5.
    const rate = spillExcess > 0 ? Math.min(2.5, 1000 * 1.7 * Math.max(0.01, Rh) * Math.pow(spillExcess, 1.5) * 2.5) : 0;
    this.spill = { rate, lip };
    if (rate > 0.001 && lip[1] > this.streamEnd) {
      const width = Math.min(0.02, 0.003 + 0.006 * Math.sqrt(rate));
      const base = pos.length / 3;
      for (let row = 0; row <= STREAM_ROWS; row++) {
        const t = row / STREAM_ROWS;
        const y = lip[1] + (this.streamEnd - lip[1]) * t;
        // Falling water speeds up and thins.
        const wr = width * (1 - 0.55 * Math.sqrt(t));
        for (let k = 0; k < STREAM_SIDES; k++) {
          const a = (k / STREAM_SIDES) * Math.PI * 2;
          pos.push(lip[0] + Math.cos(a) * wr, y, lip[2] + Math.sin(a) * wr);
          col.push(cr, cg, cb, Math.min(1, ca + 0.15));
        }
      }
      for (let row = 0; row < STREAM_ROWS; row++) {
        for (let k = 0; k < STREAM_SIDES; k++) {
          const k1 = (k + 1) % STREAM_SIDES;
          const a = base + row * STREAM_SIDES;
          const b = a + STREAM_SIDES;
          idx.push(a + k, b + k1, b + k, a + k, a + k1, b + k1);
        }
      }
    }
    const positions = Float32Array.from(pos);
    const normals = new Float32Array(positions.length);
    smoothNormals(positions, idx, normals);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < positions.length; k++) {
      const a = k % 3;
      if (positions[k]! < min[a]!) min[a] = positions[k]!;
      if (positions[k]! > max[a]!) max[a] = positions[k]!;
    }
    return { positions, normals, colors: Float32Array.from(col), indices: Uint16Array.from(idx), min, max };
  }
}

/** Area-weighted vertex normals of a triangle list (counter-clockwise faces up). */
export function smoothNormals(x: Float32Array, idx: ArrayLike<number>, out: Float32Array): void {
  out.fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    const e1x = x[b]! - x[a]!;
    const e1y = x[b + 1]! - x[a + 1]!;
    const e1z = x[b + 2]! - x[a + 2]!;
    const e2x = x[c]! - x[a]!;
    const e2y = x[c + 1]! - x[a + 1]!;
    const e2z = x[c + 2]! - x[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      out[v] = out[v]! + nx;
      out[v + 1] = out[v + 1]! + ny;
      out[v + 2] = out[v + 2]! + nz;
    }
  }
  for (let k = 0; k < out.length; k += 3) {
    const l = Math.hypot(out[k]!, out[k + 1]!, out[k + 2]!);
    if (l > 0) {
      out[k] = out[k]! / l;
      out[k + 1] = out[k + 1]! / l;
      out[k + 2] = out[k + 2]! / l;
    } else {
      out[k + 1] = 1;
    }
  }
}
