/**
 * The built-in fire and smoke flipbooks: 8 × 8 frames of a burst simulated as a tiny 2D
 * fluid (semi-Lagrangian advection, buoyancy, curl-noise turbulence), so the density and
 * heat really advect from frame to frame and a puff billows instead of scrolling noise.
 * A port of research/particle-flipbook-baker; generated here (deterministic, no files),
 * once, the first time a surface uploads either atlas.
 *
 *   fire   rgb: black-body color (sRGB), a: emission  — drawn additive
 *   smoke  rgb: the puff's self-shadowing (lit from above, 0..1 grey, linear), a: density
 *          — drawn alpha-blended, tinted by the particle's color
 *
 * Frame i of a sheet is cell (i % 8, ⌊i / 8⌋), rows top to bottom.
 */

import type { Texture3d } from '../../../core/index.js';
import { encodePng } from './foliage_textures.js';

/** Frames per side of each built-in sheet. */
export const FLIPBOOK_SIDE = 8;
/** Texels per frame. */
const CELL = 64;
/** Simulation cells per side (one per texel). */
const N = CELL;
const ATLAS = FLIPBOOK_SIDE * CELL;
/** Simulation steps between baked frames. */
const SUBSTEPS = 2;
const DT = 0.5;
/** Upward push per unit of heat. */
const BUOYANCY = 1;
/** Swirl strength. */
const TURBULENCE = 14;

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi); const b = hash(xi + 1, yi); const c = hash(xi, yi + 1); const d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number): number {
  let s = 0;
  let amp = 0.5;
  for (let i = 0; i < 4; i++) {
    s += amp * vnoise(x, y);
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return s;
}

/** The two finished sheets as RGBA pixels (rows top to bottom). */
export interface FlipbookPixels {
  readonly size: number;
  readonly fire: Uint8Array;
  readonly smoke: Uint8Array;
}

/** Run the burst and bake both sheets. Deterministic: the same pixels every run. */
export function bakeFlipbooks(): FlipbookPixels {
  const n2 = N * N;
  const dens = new Float32Array(n2);
  const temp = new Float32Array(n2);
  const vx = new Float32Array(n2);
  const vy = new Float32Array(n2);
  const tmp = new Float32Array(n2);
  // A fixed LCG for the blast's initial jitter (the baker's).
  let seed = 1337 >>> 0;
  const rand = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

  const sample = (f: Float32Array, x: number, y: number): number => {
    x = Math.max(0, Math.min(N - 1.001, x));
    y = Math.max(0, Math.min(N - 1.001, y));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * N + x0;
    return f[i]! * (1 - fx) * (1 - fy) + f[i + 1]! * fx * (1 - fy) + f[i + N]! * (1 - fx) * fy + f[i + N + 1]! * fx * fy;
  };
  /**
   * A field as the baked frames see it: cubic B-spline smooth (a frame zooms in, and
   * bilinear facets would show as straight creases), nothing outside the domain, fading out
   * near its walls (no square edge in a zoomed-out frame).
   */
  const seen = (f: Float32Array, x: number, y: number): number => {
    const wall = Math.min(x, y, N - 1 - x, N - 1 - y);
    if (wall <= 0) return 0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const wx = bspline(x - x0);
    const wy = bspline(y - y0);
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const yy = Math.max(0, Math.min(N - 1, y0 - 1 + j)) * N;
      for (let i = 0; i < 4; i++) sum += f[yy + Math.max(0, Math.min(N - 1, x0 - 1 + i))]! * wx[i]! * wy[j]!;
    }
    return sum * Math.min(1, wall / 8);
  };
  const advect = (f: Float32Array, dt: number): void => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        tmp[i] = sample(f, x - vx[i]! * dt, y - vy[i]! * dt);
      }
    }
    f.set(tmp);
  };

  const soften = (f: Float32Array): void => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const l = f[x > 0 ? i - 1 : i]!; const r = f[x < N - 1 ? i + 1 : i]!;
        const d = f[y > 0 ? i - N : i]!; const u = f[y < N - 1 ? i + N : i]!;
        tmp[i] = f[i]! * 0.8 + (l + r + d + u) * 0.05;
      }
    }
    f.set(tmp);
  };

  // The blast: a hot, dense blob in the middle of the domain, flung outward and a little up.
  const cx = N * 0.5;
  const cy = N * 0.42;
  const radius = N * 0.17;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // A lumpy blob: its edge pushed in and out by noise, its body clumped.
      const r = Math.hypot(dx, dy) / (0.75 + 0.5 * vnoise(Math.atan2(dy, dx) * 1.6 + 7, 3.3));
      if (r >= radius) continue;
      const i = y * N + x;
      const f = 1 - r / radius;
      const jitter = 0.35 + 1.3 * fbm(x * 0.16, y * 0.16);
      temp[i] = f * 1.9 * jitter;
      dens[i] = f * 1.7 * jitter;
      const nr = r < 0.001 ? 1 : r;
      vx[i] = (dx / nr) * f * 3.5 + (rand() - 0.5) * 1.7;
      vy[i] = (dy / nr) * f * 3.5 + f * 1.2;
    }
  }

  // The curl field is smooth (features ~8 cells across): evaluated on a coarse grid, sampled bilinearly.
  const C = N / 4 + 1;
  const curlX = new Float32Array(C * C);
  const curlY = new Float32Array(C * C);
  const step = (t: number): void => {
    const p = (px: number, py: number): number => vnoise(px + t * 0.7, py - t * 0.5) + 0.5 * vnoise(px * 2 + 11, py * 2 - t);
    for (let gy = 0; gy < C; gy++) {
      for (let gx = 0; gx < C; gx++) {
        const sx = gx * 4 * 0.12;
        const sy = gy * 4 * 0.12;
        const e = 0.12;
        curlX[gy * C + gx] = (p(sx, sy + e) - p(sx, sy - e)) / 2;
        curlY[gy * C + gx] = -(p(sx + e, sy) - p(sx - e, sy)) / 2;
      }
    }
    for (let y = 0; y < N; y++) {
      const fy = y / 4;
      const y0 = Math.min(C - 2, Math.floor(fy));
      const ty = fy - y0;
      for (let x = 0; x < N; x++) {
        const fx = x / 4;
        const x0 = Math.min(C - 2, Math.floor(fx));
        const tx = fx - x0;
        const g = y0 * C + x0;
        const w00 = (1 - tx) * (1 - ty); const w10 = tx * (1 - ty); const w01 = (1 - tx) * ty; const w11 = tx * ty;
        const cxv = curlX[g]! * w00 + curlX[g + 1]! * w10 + curlX[g + C]! * w01 + curlX[g + C + 1]! * w11;
        const cyv = curlY[g]! * w00 + curlY[g + 1]! * w10 + curlY[g + C]! * w01 + curlY[g + C + 1]! * w11;
        const i = y * N + x;
        const turb = (0.6 + temp[i]! * 1.5) * DT * TURBULENCE;
        vx[i] = (vx[i]! + cxv * turb) * 0.975;
        vy[i] = (vy[i]! + temp[i]! * BUOYANCY * DT + cyv * turb) * 0.975;
      }
    }
    // No net drift: the gas billows and spreads about its own center instead of rising into the walls.
    let mass = 0; let mvx = 0; let mvy = 0;
    for (let i = 0; i < n2; i++) {
      const w = dens[i]! + temp[i]!;
      mass += w; mvx += vx[i]! * w; mvy += vy[i]! * w;
    }
    if (mass > 1e-6) {
      mvx /= mass; mvy /= mass;
      for (let i = 0; i < n2; i++) { vx[i]! -= mvx; vy[i]! -= mvy; }
    }
    advect(vx, DT); advect(vy, DT); advect(temp, DT); advect(dens, DT);
    // A little diffusion keeps the gas billowing in soft puffs instead of creasing into filaments.
    soften(dens); soften(temp); soften(vx); soften(vy);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        // A sponge along the walls: gas that reaches them fades instead of piling up.
        const wall = Math.min(1, Math.min(x, y, N - 1 - x, N - 1 - y) / 6);
        temp[i]! *= 0.984 * wall;
        dens[i]! *= 0.997 * wall;
        vx[i]! *= wall;
        vy[i]! *= wall;
      }
    }
  };

  const fire = new Uint8Array(ATLAS * ATLAS * 4);
  const smoke = new Uint8Array(ATLAS * ATLAS * 4);
  const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  const frames = FLIPBOOK_SIDE * FLIPBOOK_SIDE;
  let t = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let s = 0; s < SUBSTEPS; s++) {
      step(t);
      t += DT;
    }
    // Each sheet's frame is framed on its field: centered on its mass, zoomed to its spread,
    // normalized to its peak — the puff fills every frame, and the sheet's own fade (not
    // the gas drifting out of view) ends it.
    const life = frame / (frames - 1);
    const fade = 1 - smoothstep(0.55, 1, life);
    const fireWin = framing(temp, N);
    const smokeWin = framing(dens, N);
    const ox = (frame % FLIPBOOK_SIDE) * CELL;
    const oy = Math.floor(frame / FLIPBOOK_SIDE) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        // u, v in -1..1 across the frame, v up (texel row 0 is the top).
        const u = ((x + 0.5) / CELL) * 2 - 1;
        const v = 1 - ((y + 0.5) / CELL) * 2;
        // A round vignette so no frame shows its square edge on a billboard.
        const edge = 1 - smoothstep(0.76, 1, Math.hypot(u, v));
        const o = ((oy + y) * ATLAS + ox + x) * 4;

        const fx = fireWin.x + u * fireWin.half;
        const fy = fireWin.y + v * fireWin.half;
        const heat = Math.min(1, seen(temp, fx, fy) / fireWin.peak);
        const [r, g, b] = fireRamp(heat * (1 - 0.65 * life) + 0.08);
        fire[o] = byte(r); fire[o + 1] = byte(g); fire[o + 2] = byte(b);
        // Soft-edged, broken up by flickering tongues of noise rather than a flat plateau.
        const tongues = Math.min(1, 0.55 + 0.6 * fbm(fx * 0.3 + frame * 0.35, fy * 0.3 - frame * 0.6));
        fire[o + 3] = byte(smoothstep(0.03, 0.85, heat) * tongues * edge * fade);

        const sx = smokeWin.x + u * smokeWin.half;
        const sy = smokeWin.y + v * smokeWin.half;
        const d = seen(dens, sx, sy) / smokeWin.peak;
        const body = smoothstep(0.04, 0.55, d);
        const wisps = Math.max(0, Math.min(1, 0.55 + 0.6 * fbm(sx * 0.27 + frame * 0.3, sy * 0.27 - frame * 0.12)));
        // Self-shadowing: the density gradient as a normal, lit from above-left.
        const e = Math.max(1, smokeWin.half / 24);
        let nx = (seen(dens, sx - e, sy) - seen(dens, sx + e, sy)) / smokeWin.peak;
        let ny = (seen(dens, sx, sy - e) - seen(dens, sx, sy + e)) / smokeWin.peak;
        let nz = 0.35;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const lit = Math.max(0, (nx * -0.35 + ny * 0.8 + nz * 0.5) / 1.0153);
        const shade = byte(0.3 + 0.7 * lit);
        smoke[o] = shade; smoke[o + 1] = shade; smoke[o + 2] = shade;
        smoke[o + 3] = byte(body * wisps * edge * fade * 0.95);
      }
    }
  }
  return { size: ATLAS, fire, smoke };
}

/** Where a field's mass is: its centroid, a half-width covering its spread, and its peak. */
function framing(f: Float32Array, n: number): { x: number; y: number; half: number; peak: number } {
  let mass = 0; let mx = 0; let my = 0; let peak = 1e-6;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const w = f[y * n + x]!;
      mass += w; mx += w * x; my += w * y;
      if (w > peak) peak = w;
    }
  }
  if (mass <= 1e-6) return { x: n / 2, y: n / 2, half: n / 2, peak };
  mx /= mass; my /= mass;
  let spread = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) spread += f[y * n + x]! * ((x - mx) ** 2 + (y - my) ** 2);
  const half = Math.max(n * 0.12, Math.min(n * 0.5, Math.sqrt(spread / mass) * 2.2));
  return { x: mx, y: my, half, peak };
}

/** Cubic B-spline weights of the 4 taps around a sample t (0..1) past the second. */
function bspline(t: number): [number, number, number, number] {
  const u = 1 - t;
  return [u * u * u / 6, (3 * t * t * t - 6 * t * t + 4) / 6, (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6, t * t * t / 6];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Deep red → orange → yellow → near white. */
function fireRamp(t: number): [number, number, number] {
  const stops: readonly [number, number, number, number][] = [
    [0, 0.02, 0, 0], [0.25, 0.7, 0.06, 0.01], [0.5, 1, 0.35, 0.04], [0.75, 1, 0.75, 0.2], [1, 1, 0.95, 0.7],
  ];
  const c = Math.max(0, Math.min(1, t));
  for (let k = 0; k < stops.length - 1; k++) {
    const a = stops[k]!;
    const b = stops[k + 1]!;
    if (c <= b[0]) {
      const u = (c - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [1, 0.95, 0.7];
}

let baked: { fire: Uint8Array; smoke: Uint8Array } | null = null;

function png(which: 'fire' | 'smoke'): Uint8Array {
  if (baked === null) {
    const pixels = bakeFlipbooks();
    baked = { fire: encodePng(pixels.size, pixels.size, pixels.fire), smoke: encodePng(pixels.size, pixels.size, pixels.smoke) };
  }
  return baked[which];
}

/** A built-in sheet as a texture; its pixels are baked the first time a surface reads its source. */
function sheet(which: 'fire' | 'smoke'): Texture3d {
  let source: Texture3d['source'] | null = null;
  return {
    id: `builtin:flipbook:${which}`,
    get source(): Texture3d['source'] {
      source ??= { kind: 'bytes', bytes: png(which), mimeType: 'image/png' };
      return source;
    },
    colorSpace: which === 'fire' ? 'srgb' : 'linear',
    wrapU: 'clamp',
    wrapV: 'clamp',
    filter: 'linear',
  };
}

export const FIRE_FLIPBOOK: Texture3d = sheet('fire');
export const SMOKE_FLIPBOOK: Texture3d = sheet('smoke');
