/**
 * The physically based sky: single scattering through a spherical atmosphere (Rayleigh
 * molecules, Mie haze, an ozone layer that absorbs), seen from the ground. The "atmosphere"
 * sky preset takes its palette from it — zenith, horizon, ambient and the sun's color all
 * follow the sun's height — and render3d draws the same model per pixel (the numbers travel
 * in `Atmosphere3d`), so the sky a surface draws matches the light the scene is lit by.
 *
 * Units: meters; radiance is for a sun of irradiance 1, times `exposure` (the calibration
 * that puts a clear noon horizon near 0.75 of display white). Rendering values: nothing in
 * the simulation reads them, so they may use transcendental math.
 */

import type { Atmosphere3d } from '../../../core/index.js';
import { EARTH_ATMOSPHERE } from '../../../core/index.js';

export { EARTH_ATMOSPHERE };

export type Rgb3 = [number, number, number];
type V3 = readonly [number, number, number];

/** Meters above the ground the sky is seen from. */
const EYE_HEIGHT = 2;
const OZONE_CENTER = 25_000;
const OZONE_WIDTH = 15_000;

/** The model with more or less haze: 0 is a crisp mountain sky, 1 the default, 4 a hazy summer day. */
export function withHaze(base: Atmosphere3d, haze: number): Atmosphere3d {
  return { ...base, mie: base.mie * haze };
}

/** Distance from height `r` along a direction (by its vertical component `dy`) to the sphere of `radius` around the planet's center. */
function toTop(r: number, dy: number, radius: number): number {
  const b = r * dy;
  return -b + Math.sqrt(Math.max(0, b * b - (r * r - radius * radius)));
}

/** Distance along a direction (by its vertical component) from height `r` until the ground, or -1 when it misses. */
function toGround(r: number, dy: number, planet: number): number {
  const b = r * dy;
  const c = r * r - planet * planet;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const near = -b - Math.sqrt(disc);
  return near > 0 ? near : -1;
}

function density(a: Atmosphere3d, h: number): [number, number, number] {
  return [Math.exp(-h / a.rayleighHeight), Math.exp(-h / a.mieHeight), Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_WIDTH)];
}

/** Optical depth (Rayleigh, Mie, ozone densities integrated, meters) from height `r` toward the top along `dy`. */
function opticalDepthToTop(a: Atmosphere3d, r: number, dy: number, steps: number, out: [number, number, number]): boolean {
  if (toGround(r, dy, a.planetRadius) > 0) return false;
  const length = toTop(r, dy, a.atmosphereRadius);
  const ds = length / steps;
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    // Height of the sample: |origin + t·dir| - planet, origin at (0, r), dir (sqrt(1-dy²), dy).
    const h = Math.sqrt(r * r + t * t + 2 * r * t * dy) - a.planetRadius;
    const d = density(a, h);
    out[0] += d[0] * ds; out[1] += d[1] * ds; out[2] += d[2] * ds;
  }
  return true;
}

function extinction(a: Atmosphere3d, depth: readonly number[], channel: number): number {
  return a.rayleigh[channel]! * depth[0]! + (a.mie / 0.9) * depth[1]! + a.ozone[channel]! * depth[2]!;
}

export function rayleighPhase(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

/** Cornette–Shanks phase for haze. */
export function miePhase(mu: number, g: number): number {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * (1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

/**
 * Light reaching the eye from direction `view` (unit, from the eye) with the sun toward
 * `toSun`: in-scattered sunlight, times `exposure`, linear rgb. Rays that meet the ground
 * stop there (the ground itself is not drawn: that is the scene's).
 */
export function skyRadiance(a: Atmosphere3d, view: V3, toSun: V3, steps = 16, lightSteps = 8): Rgb3 {
  const v = normalize(view);
  const s = normalize(toSun);
  const r0 = a.planetRadius + EYE_HEIGHT;
  const ground = toGround(r0, v[1], a.planetRadius);
  const length = ground > 0 ? ground : toTop(r0, v[1], a.atmosphereRadius);
  const ds = length / steps;
  const mu = v[0] * s[0] + v[1] * s[1] + v[2] * s[2];
  const pr = rayleighPhase(mu);
  const pm = miePhase(mu, a.mieG);
  const eye: [number, number, number] = [0, 0, 0];
  const sun: [number, number, number] = [0, 0, 0];
  const out: Rgb3 = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    // The sample point, with the eye at (0, r0, 0) above the planet's center.
    const px = v[0] * t;
    const py = r0 + v[1] * t;
    const pz = v[2] * t;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const h = r - a.planetRadius;
    const d = density(a, h);
    eye[0] += d[0] * ds * 0.5; eye[1] += d[1] * ds * 0.5; eye[2] += d[2] * ds * 0.5;
    // The sun's height as seen from the sample: the angle between `s` and the local up.
    const sunUp = (px * s[0] + py * s[1] + pz * s[2]) / r;
    if (opticalDepthToTop(a, r, sunUp, lightSteps, sun)) {
      for (let c = 0; c < 3; c++) {
        const tau = extinction(a, eye, c) + extinction(a, sun, c);
        const transmittance = Math.exp(-tau);
        out[c] = out[c]! + transmittance * (a.rayleigh[c]! * d[0] * pr + a.mie * d[1] * pm) * ds;
      }
    }
    eye[0] += d[0] * ds * 0.5; eye[1] += d[1] * ds * 0.5; eye[2] += d[2] * ds * 0.5;
  }
  return [out[0] * a.exposure, out[1] * a.exposure, out[2] * a.exposure];
}

/** The fraction of sunlight, per channel, that reaches the ground with the sun toward `toSun` (0 below the horizon). */
export function sunTransmittance(a: Atmosphere3d, toSun: V3, steps = 16): Rgb3 {
  const s = normalize(toSun);
  const depth: [number, number, number] = [0, 0, 0];
  if (!opticalDepthToTop(a, a.planetRadius + EYE_HEIGHT, s[1], steps, depth)) return [0, 0, 0];
  return [Math.exp(-extinction(a, depth, 0)), Math.exp(-extinction(a, depth, 1)), Math.exp(-extinction(a, depth, 2))];
}

export function luminance(c: readonly number[]): number {
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** The sky's light, linear rgb: straight up, around the horizon (3° up, averaged over the compass), and over the whole upper hemisphere. */
export interface AtmosphereLight {
  readonly zenith: Rgb3;
  readonly horizon: Rgb3;
  readonly ambient: Rgb3;
  /** Sunlight through the air, per channel (1: none lost). */
  readonly sun: Rgb3;
}

export function atmosphereLight(a: Atmosphere3d, toSun: V3): AtmosphereLight {
  const zenith = skyRadiance(a, [0, 1, 0], toSun);
  const horizon: Rgb3 = [0, 0, 0];
  const ambient: Rgb3 = [0, 0, 0];
  const around = 8;
  const lift = Math.sin((3 * Math.PI) / 180);
  for (let i = 0; i < around; i++) {
    const angle = (i / around) * Math.PI * 2;
    const c = Math.cos(angle) * Math.sqrt(1 - lift * lift);
    const s = Math.sin(angle) * Math.sqrt(1 - lift * lift);
    const h = skyRadiance(a, [c, lift, s], toSun, 12, 6);
    for (let k = 0; k < 3; k++) horizon[k] = horizon[k]! + h[k]! / around;
  }
  // Cosine-weighted hemisphere: three rings and the zenith.
  let weight = 0;
  for (const elevation of [12, 40, 68]) {
    const y = Math.sin((elevation * Math.PI) / 180);
    const xz = Math.cos((elevation * Math.PI) / 180);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + elevation;
      const l = skyRadiance(a, [Math.cos(angle) * xz, y, Math.sin(angle) * xz], toSun, 10, 5);
      for (let k = 0; k < 3; k++) ambient[k] = ambient[k]! + l[k]! * y * xz;
      weight += y * xz;
    }
  }
  for (let k = 0; k < 3; k++) {
    ambient[k] = (ambient[k]! + zenith[k]! * 0.5) / (weight + 0.5);
  }
  return { zenith, horizon, ambient, sun: sunTransmittance(a, toSun) };
}
