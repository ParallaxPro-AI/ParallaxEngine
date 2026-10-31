/**
 * Deterministic ground math: integer-hash value noise, easing, a trig-free cosine, and
 * footprints (circles, rotated rectangles, polygons) and Catmull-Rom polylines as signed
 * distances in meters (negative inside). Bit-identical on every platform: Math.imul, +, −,
 * ×, ÷, floor and sqrt only — never Math.sin/cos/pow/exp, whose last bits differ between JS
 * engines. Terrain relief and splats, foliage scatter and the wind field are built on it,
 * so they are the same everywhere (replays, multiplayer, server checks).
 */


/** A 32-bit hash of an integer lattice point and seed, as a number in [0, 1). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A seed mixed with a small integer (octave, layer index) into a new seed. */
export function mixSeed(seed: number, salt: number): number {
  return (seed + Math.imul(salt + 1, 0x632be5ab)) | 0;
}

/** Quintic smootherstep on [0, 1] (clamped). */
export function smootherstep(t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/** GLSL smoothstep. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = (value - edge0) / (edge1 - edge0);
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Value noise in [0, 1], smootherstep-interpolated between lattice hashes. */
export function valueNoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smootherstep(x - ix);
  const fz = smootherstep(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fz;
}

export type FractalKind = 'fbm' | 'ridged' | 'billow';

export interface FractalNoise {
  readonly kind: FractalKind;
  /** Meters between the lowest and highest point the layer adds (its output is 0..1 × amplitude). */
  readonly amplitude: number;
  /** Meters per cycle of the first octave. */
  readonly wavelength: number;
  readonly octaves: number;
  /** Amplitude ratio between octaves. */
  readonly gain: number;
  /** Frequency ratio between octaves. */
  readonly lacunarity: number;
  readonly seed: number;
}

/**
 * One noise layer at (x, z), in [0, 1] before `amplitude`:
 *   fbm     the octaves' value noise summed (rolling hills)
 *   ridged  1 − |2n − 1| per octave, squared, each octave weighted by the last (sharp crests)
 *   billow  |2n − 1| per octave (puffy mounds, dunes)
 */
export function fractalNoise2(layer: FractalNoise, x: number, z: number): number {
  let sum = 0;
  let total = 0;
  let amplitude = 1;
  let frequency = 1 / layer.wavelength;
  let weight = 1;
  for (let octave = 0; octave < layer.octaves; octave++) {
    const n = valueNoise2(x * frequency, z * frequency, mixSeed(layer.seed, octave - 1));
    let v: number;
    if (layer.kind === 'fbm') {
      v = n;
    } else if (layer.kind === 'billow') {
      v = Math.abs(2 * n - 1);
    } else {
      const r = 1 - Math.abs(2 * n - 1);
      v = r * r * weight;
      weight = v * 2 >= 1 ? 1 : v * 2;
    }
    sum += amplitude * v;
    total += amplitude;
    amplitude *= layer.gain;
    frequency *= layer.lacunarity;
  }
  return sum / total;
}

/**
 * cos(degrees) from +, −, × and ÷ alone (range-reduced Taylor series, exact to 1e-15), so
 * slope thresholds authored in degrees are the same bits everywhere.
 */
export function cosDegrees(degrees: number): number {
  let d = degrees % 360;
  if (d < 0) d += 360;
  if (d > 180) d = 360 - d;
  let sign = 1;
  if (d > 90) {
    d = 180 - d;
    sign = -1;
  }
  const x = (d * 3.141592653589793) / 180;
  const x2 = x * x;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 12; n++) {
    term *= -x2 / ((2 * n - 1) * (2 * n));
    sum += term;
  }
  return sign * sum;
}

export type Footprint =
  | { readonly kind: 'circle'; readonly x: number; readonly z: number; readonly radius: number }
  /** `cos`/`sin` of the rotation (counter-clockwise seen from above, degrees in data). */
  | { readonly kind: 'rect'; readonly x: number; readonly z: number; readonly hx: number; readonly hz: number; readonly cos: number; readonly sin: number }
  | { readonly kind: 'polygon'; readonly points: readonly (readonly [number, number])[] };

export interface Bounds2 {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export function rectFootprint(x: number, z: number, width: number, depth: number, degrees: number): Footprint {
  return { kind: 'rect', x, z, hx: width / 2, hz: depth / 2, cos: cosDegrees(degrees), sin: cosDegrees(90 - degrees) };
}

export function sdFootprint(shape: Footprint, px: number, pz: number): number {
  if (shape.kind === 'circle') {
    const dx = px - shape.x;
    const dz = pz - shape.z;
    return Math.sqrt(dx * dx + dz * dz) - shape.radius;
  }
  if (shape.kind === 'rect') {
    const dx = px - shape.x;
    const dz = pz - shape.z;
    // Into the rectangle's frame: rotate by −angle.
    const lx = Math.abs(dx * shape.cos + dz * shape.sin) - shape.hx;
    const lz = Math.abs(-dx * shape.sin + dz * shape.cos) - shape.hz;
    const ox = lx > 0 ? lx : 0;
    const oz = lz > 0 ? lz : 0;
    const outside = Math.sqrt(ox * ox + oz * oz);
    const inside = lx > lz ? lx : lz;
    return outside > 0 ? outside : inside;
  }
  const pts = shape.points;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j]!;
    const [bx, bz] = pts[i]!;
    const d = sdSegment(px, pz, ax, az, bx, bz);
    if (d < best) best = d;
    if ((bz > pz) !== (az > pz) && px < ((ax - bx) * (pz - bz)) / (az - bz) + bx) inside = !inside;
  }
  return inside ? -best : best;
}

export function footprintBounds(shape: Footprint, pad: number): Bounds2 {
  if (shape.kind === 'circle') {
    const r = shape.radius + pad;
    return { minX: shape.x - r, minZ: shape.z - r, maxX: shape.x + r, maxZ: shape.z + r };
  }
  if (shape.kind === 'rect') {
    const ex = Math.abs(shape.hx * shape.cos) + Math.abs(shape.hz * shape.sin) + pad;
    const ez = Math.abs(shape.hx * shape.sin) + Math.abs(shape.hz * shape.cos) + pad;
    return { minX: shape.x - ex, minZ: shape.z - ez, maxX: shape.x + ex, maxZ: shape.z + ez };
  }
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of shape.points) {
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (z > maxZ) maxZ = z;
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

export function footprintArea(shape: Footprint): number {
  if (shape.kind === 'circle') return 3.141592653589793 * shape.radius * shape.radius;
  if (shape.kind === 'rect') return 4 * shape.hx * shape.hz;
  let twice = 0;
  const pts = shape.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) twice += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
  return Math.abs(twice) / 2;
}

export function sdSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(segmentNearest2(px, pz, ax, az, bx, bz).d2);
}

/** Squared distance to segment ab and the parameter t of the nearest point. */
export function segmentNearest2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d2: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const length2 = dx * dx + dz * dz;
  let t = length2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + dx * t);
  const ez = pz - (az + dz * t);
  return { d2: ex * ex + ez * ez, t };
}

/** Points a spline span is sampled at (per control-point gap). */
export const SPLINE_SAMPLES = 8;

/**
 * A centripetal-free (uniform) Catmull-Rom spline through `points`, sampled into a
 * polyline: SPLINE_SAMPLES segments per gap. Closed splines wrap around.
 */
export function catmullRomPolyline(points: readonly (readonly [number, number])[], closed: boolean): Float64Array {
  const n = points.length;
  const at = (i: number): readonly [number, number] => {
    if (closed) return points[((i % n) + n) % n]!;
    return points[i < 0 ? 0 : i >= n ? n - 1 : i]!;
  };
  const gaps = closed ? n : n - 1;
  const out = new Float64Array((gaps * SPLINE_SAMPLES + 1) * 2);
  let k = 0;
  for (let g = 0; g < gaps; g++) {
    const p0 = at(g - 1);
    const p1 = at(g);
    const p2 = at(g + 1);
    const p3 = at(g + 2);
    for (let s = 0; s < SPLINE_SAMPLES; s++) {
      const t = s / SPLINE_SAMPLES;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let axis = 0; axis < 2; axis++) {
        const a = p0[axis]!;
        const b = p1[axis]!;
        const c = p2[axis]!;
        const d = p3[axis]!;
        out[k + axis] = 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      }
      k += 2;
    }
  }
  const last = closed ? at(0) : at(n - 1);
  out[k] = last[0];
  out[k + 1] = last[1];
  return out;
}

/** Nearest point on a polyline: distance and the (fractional) sample index of it. */
export function polylineNearest(line: Float64Array, px: number, pz: number): { distance: number; index: number } {
  let best = Infinity;
  let index = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const r = segmentNearest2(px, pz, line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!);
    if (r.d2 < best) {
      best = r.d2;
      index = i / 2 + r.t;
    }
  }
  return { distance: Math.sqrt(best), index };
}
