/**
 * The viewmodel's motion primitives: a damped spring that stays stable at any frame time, a
 * smooth noise that never visibly repeats, and an exponential ease. All state is plain
 * numbers ({x, v}), so it snapshots as JSON; nothing here allocates per step.
 *
 * Stability. Explicit integration of a stiff spring diverges once dt·ω nears 1 (a 110 ms
 * hitch at 9 Hz). Steps are cut into slices of at most `MAX_SLICE` (semi-implicit Euler),
 * and one call integrates at most `MAX_STEP`, so a long stall settles instead of exploding.
 */

const TAU = Math.PI * 2;
export const MAX_SLICE = 0.004;
export const MAX_STEP = 0.25;

export interface SpringState {
  x: number;
  v: number;
}

export function spring(): SpringState {
  return { x: 0, v: 0 };
}

/**
 * Advance a damped harmonic oscillator toward `target`: `frequency` is its natural frequency
 * (Hz), `damping` the ratio (1 critical; below 1 it overshoots and rings, which is what sells
 * mass in a held object).
 */
export function stepSpring(s: SpringState, target: number, frequency: number, damping: number, dt: number): number {
  if (!(dt > 0)) return s.x;
  const omega = frequency * TAU;
  let remaining = Math.min(dt, MAX_STEP);
  while (remaining > 1e-12) {
    const h = Math.min(remaining, MAX_SLICE);
    remaining -= h;
    s.v += (-omega * omega * (s.x - target) - 2 * damping * omega * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}

/** Kick the velocity: how a shot or a landing enters a spring. */
export function kick(s: SpringState, dv: number): void {
  s.v += dv;
}

/** Exponential approach, frame-rate independent: `rate` per second. */
export function ease(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

function hash(n: number, seed: number): number {
  // An integer hash (lowbias32) to [-1, 1): deterministic on every machine.
  let h = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x80000000 - 1;
}

/** Smooth value noise at `t` (one lattice point per unit), smootherstep-blended: continuous to the second derivative. */
export function noise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash(i, seed);
  const b = hash(i + 1, seed);
  return a + (b - a) * s;
}

/** Three octaves of `noise`, normalized to about [-1, 1]. No period: the lattice never wraps. */
export function fbm(t: number, seed: number): number {
  return (noise(t, seed) + 0.5 * noise(t * 2.03, seed + 17) + 0.25 * noise(t * 4.11, seed + 31)) / 1.75;
}

/** A deterministic sign-and-size in [-1, 1] for shot `n` of a recoil pattern (learnable: the same every time). */
export function patternValue(n: number, seed: number): number {
  return hash(n, seed);
}

export function wrap180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}
