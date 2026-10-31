/**
 * Image-based lighting from the sky. The sky is the environment's vertical gradient
 * (`skyRadiance`, the same function the sky and environment-cube shaders evaluate; the
 * sun disk is left out, as the sun lights surfaces directly). From it:
 *
 *   diffuse    irradiance as 9 spherical-harmonic coefficients of luminance, computed
 *              here on the CPU from an even sky dome above the horizon and ground below it (the
 *              environment cube's `envSky`), normalized so an upward face gets exactly the
 *              authored ambient: a surface's ambient light is `ambient × E(n)`, E(up) = 1 as in
 *              the old renderer (whose ground and flat-lit meshes took the ambient as it is),
 *              less on walls, least facing the ground. (Normalized to a mean of 1 over a sky
 *              that is horizon-bright all the way down, the ground faced less light than the
 *              underside of a roof: up 0.6, down 1.3 under the clear-day sky.)
 *   specular   the GPU renders the sky into a cube map and prefilters its mips for rising
 *              roughness (GGX); reflections are scaled by `ambient luminance / sky
 *              luminance`, so a dark interior with a bright sky preset doesn't glow. The
 *              cube takes the ambient light's hue (`reflectionSky`), and below the horizon it
 *              holds ground (post_shaders.ts `envSky`), so metals seen from above reflect a
 *              dark floor rather than a bright sky-blue horizon.
 *
 * The cube is rebuilt only when `environmentKey` changes (the sky colors, or the quality's
 * cube size).
 */

import type { Rgb } from '../../../core/index.js';
import { luminance } from './layout.js';

/** Linear radiance of the sky gradient in a unit direction (no sun disk). */
export function skyRadiance(dir: readonly number[], zenith: readonly number[], horizon: readonly number[]): [number, number, number] {
  const t = Math.sqrt(Math.min(1, Math.max(0, dir[1]!)));
  return [horizon[0]! + (zenith[0]! - horizon[0]!) * t, horizon[1]! + (zenith[1]! - horizon[1]!) * t, horizon[2]! + (zenith[2]! - horizon[2]!) * t];
}

/** Real SH basis, bands 0–2, in a unit direction. */
export function shBasis(d: readonly number[]): number[] {
  const [x, y, z] = [d[0]!, d[1]!, d[2]!];
  return [
    0.282095,
    0.488603 * y, 0.488603 * z, 0.488603 * x,
    1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y),
  ];
}

/** Cosine-lobe convolution per band (irradiance from radiance). */
const BAND = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];

/** Evenly spread unit directions over the sphere (Fibonacci). */
export function sphereDirections(count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = golden * i;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

const DIRECTIONS = sphereDirections(512);

export interface SkyLighting {
  /** Irradiance SH of the environment's luminance, scaled so an upward face's is 1. */
  readonly sh: readonly number[];
  /** Mean luminance of the sky over the sphere. */
  readonly meanLuminance: number;
}

/** Irradiance at a normal from SH coefficients. */
export function irradiance(sh: readonly number[], n: readonly number[]): number {
  const basis = shBasis(n);
  let e = 0;
  for (let i = 0; i < 9; i++) e += sh[i]! * basis[i]!;
  return e;
}

/**
 * The sky colors the reflection cube is drawn from: the sky's own gradient (its brightness
 * pattern) recolored to the hue of the scene's ambient light. Reflections stand in for the
 * surroundings, and the authored ambient is the scene's word for what those are: a kitchen
 * with a neutral ambient under the default blue sky reflects grey in its steel (as the
 * earlier engine's world probe did), an outdoor scene with a sky-blue ambient still
 * reflects blue. Luminance is kept per color; a black ambient leaves the sky as it is.
 */
export function reflectionSky(zenith: Rgb, horizon: Rgb, ambient: Rgb): { readonly zenith: Rgb; readonly horizon: Rgb } {
  const a = luminance(ambient);
  const mean = [0, 1, 2].map((k) => horizon[k]! + (zenith[k]! - horizon[k]!) * 0.5);
  const m = luminance(mean);
  if (a <= 1e-6 || m <= 1e-6) return { zenith, horizon };
  const f = [0, 1, 2].map((k) => (ambient[k]! / a) / Math.max(mean[k]! / m, 1e-4));
  const tint = (c: Rgb): Rgb => {
    const t = [c[0]! * f[0]!, c[1]! * f[1]!, c[2]! * f[2]!];
    const keep = luminance(c) / Math.max(luminance(t), 1e-6);
    return [t[0]! * keep, t[1]! * keep, t[2]! * keep];
  };
  return { zenith: tint(zenith), horizon: tint(horizon) };
}

/** Ground's luminance below the horizon, per unit of the horizon's (post_shaders.ts `envSky`). */
const GROUND = luminance([0.317, 0.279, 0.228]);

/**
 * Relative light the environment sends from a unit direction for diffuse ambient: the open sky
 * (as one even dome: the old renderer lit ground and walls with the flat authored ambient, and
 * a sky preset's gradient, often brighter at the horizon than overhead, would otherwise light
 * walls brighter than the ground they stand on) above the horizon, ground (as `envSky`) below.
 */
export function environmentLuminance(d: readonly number[]): number {
  if (d[1]! >= 0) return 1;
  return 1 + (GROUND - 1) * Math.pow(-d[1]!, 0.7);
}

/** SH irradiance of the environment's light (sky dome over ground), E(up) = 1; and the sky gradient's mean luminance. */
export function skyLighting(zenith: Rgb, horizon: Rgb): SkyLighting {
  const radiance = new Array<number>(9).fill(0);
  let mean = 0;
  for (const d of DIRECTIONS) {
    mean += luminance(skyRadiance(d, zenith, horizon));
    const l = environmentLuminance(d);
    const basis = shBasis(d);
    for (let i = 0; i < 9; i++) radiance[i]! += l * basis[i]!;
  }
  const weight = (4 * Math.PI) / DIRECTIONS.length;
  mean /= DIRECTIONS.length;
  const sh = radiance.map((c, i) => c * weight * BAND[i]!);
  const up = irradiance(sh, [0, 1, 0]);
  return { sh: up > 1e-6 ? sh.map((c) => c / up) : [1 / 0.282095, 0, 0, 0, 0, 0, 0, 0, 0], meanLuminance: mean };
}

/** Changes whenever the environment cube must be rebuilt. */
export function environmentKey(zenith: readonly number[], horizon: readonly number[], size: number): string {
  const q = (v: number): number => Math.round(v * 4096);
  return `${size}|${zenith.map(q).join(',')}|${horizon.map(q).join(',')}`;
}

/** Prefiltered mip levels of an environment cube `size` texels wide (down to 4 texels). */
export function environmentMips(size: number): number {
  return Math.max(1, Math.floor(Math.log2(size)) - 1);
}
