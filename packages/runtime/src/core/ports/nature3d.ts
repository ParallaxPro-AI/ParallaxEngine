/**
 * The outdoor part of a 3D frame (`Frame3d.nature`): the sky as a physical model (or the
 * preset's gradient), drifting clouds, water bodies with their wave sets, and what the
 * weather does to surfaces. The render3d plugin builds it from the environment, water and
 * weather services; a surface draws it after the opaque scene (the sky behind everything,
 * aerial perspective, wet and snowy surfaces, then the water). Rain, snow, splashes and
 * lightning bolts are ordinary billboards and lines in the frame.
 *
 * Conventions follow `render3d.ts`: world meters, y up, sRGB colors as authored.
 */

import type { Geometry3d, Rgb, Xyz } from './render3d.js';

// ── Sky ────────────────────────────────────────────────────────────────────────

/**
 * Single-scattering atmosphere (Rayleigh + Mie, ozone absorption) seen from the ground.
 * The same numbers drive the environment's palette on the CPU (`atmosphere.ts` in the
 * environment plugin), so the sky a surface draws matches the light the scene is lit with.
 */
export interface Atmosphere3d {
  /** Rayleigh scattering per meter at sea level, rgb. */
  readonly rayleigh: Xyz;
  readonly rayleighHeight: number;
  /** Mie scattering per meter at sea level (haze); extinction is `mie / 0.9`. */
  readonly mie: number;
  readonly mieHeight: number;
  /** Mie phase asymmetry (0.76: forward-scattering haze). */
  readonly mieG: number;
  /** Ozone absorption per meter at its peak (25 km), rgb. */
  readonly ozone: Xyz;
  readonly planetRadius: number;
  readonly atmosphereRadius: number;
  /** Radiance → display light: the calibration that makes a clear noon horizon ~0.75. */
  readonly exposure: number;
  /** Sun disc angular radius, radians. */
  readonly sunRadius: number;
}

/** Earth's sea-level coefficients (Bruneton & Neyret; ozone after Hillaire 2020). */
export const EARTH_ATMOSPHERE: Atmosphere3d = {
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighHeight: 8000,
  mie: 3.996e-6,
  mieHeight: 1200,
  mieG: 0.8,
  ozone: [0.65e-6, 1.881e-6, 0.085e-6],
  planetRadius: 6_360_000,
  atmosphereRadius: 6_460_000,
  exposure: 20,
  sunRadius: 0.0047,
};

export interface Clouds3d {
  /** 0..1 of the sky covered. */
  readonly coverage: number;
  /** 0..1 optical thickness. */
  readonly density: number;
  /** World y of the layer's base, and its thickness (meters). */
  readonly base: number;
  readonly thickness: number;
  /** Meters the cloud field has drifted (x, z) — wind × game time, so clouds move. */
  readonly offset: readonly [x: number, z: number];
  /** Meters across one cloud cell. */
  readonly scale: number;
  /** 0..1: how dark the undersides are (storm clouds). */
  readonly darkness: number;
}

export interface Sky3d {
  /** atmosphere: drawn by scattering; gradient: the environment's zenith → horizon colors. */
  readonly model: 'atmosphere' | 'gradient';
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  /** Unit direction toward the sun (it may be below the horizon). */
  readonly toSun: Xyz;
  /** The sun's color and strength as the scene is lit (the environment's). */
  readonly sunColor: Rgb;
  readonly sunIntensity: number;
  readonly atmosphere: Atmosphere3d;
  readonly clouds: Clouds3d | null;
  /** 0..1: stars showing (night). */
  readonly stars: number;
  /** Lightning lighting the clouds and sky, 0 (none) and up. */
  readonly flash: number;
  /** Seconds of game time (cloud evolution, star twinkle). */
  readonly time: number;
}

// ── Water ──────────────────────────────────────────────────────────────────────

/**
 * Floats per Gerstner wave in `Water3d.waves`: dirX, dirZ (unit, the way it travels),
 * k (rad/m), omega (rad/s), amplitude (m), steepness (0..1, Q/(k·A·count) already applied),
 * phase (rad), 0.
 */
export const WAVE_FLOATS = 8;

/** Floats per ripple (splash ring, wake foam) in `Water3d.ripples`: x, z, radius (m), strength (0..1). */
export const RIPPLE_FLOATS = 4;

export interface WaterBody3d {
  readonly kind: 'ocean' | 'lake' | 'river' | 'pool';
  /** Null for the terrain's own water (its `water_level`). */
  readonly entity: number | null;
  /** World y of the still surface (rivers: the ribbon's own heights). */
  readonly level: number;
  /** Lakes and pools: the area's center, half size along its own x/z, yaw (radians) and outline. Oceans have no edge. */
  readonly center: Xyz;
  readonly halfSize: readonly [x: number, z: number];
  readonly yaw: number;
  readonly shape: 'rect' | 'ellipse';
  /** Meters from the surface to the bed where the scene has nothing below. */
  readonly depth: number;
  /** This body's waves in `Water3d.waves` (by wave, not by float). */
  readonly firstWave: number;
  readonly waveCount: number;
  /** Seen from above in deep water, and in the shallows (sRGB). */
  readonly deep: Rgb;
  readonly shallow: Rgb;
  /** Meters of water light crosses before it is mostly absorbed. */
  readonly clarity: number;
  /** 0..1: whitecaps on crests and foam along shores. */
  readonly foam: number;
  readonly roughness: number;
  /** 0..1: caustics on what is under the surface. */
  readonly caustics: number;
  /** 0..2: small-ripple (chop) strength. */
  readonly ripple: number;
  /** Meters from the camera over which the surface calms to a mirror of the sky; 0: never. */
  readonly calmDistance: number;
  /** Rivers: the ribbon at the surface. `uvs` are (meters along, -1..1 across); `colors` hold (flow x, flow z, speed m/s, 1). */
  readonly ribbon: Geometry3d | null;
}

export interface Water3d {
  /** Seconds of game time the waves are at. */
  readonly time: number;
  readonly waves: Float32Array;
  readonly bodies: readonly WaterBody3d[];
  readonly ripples: Float32Array;
  readonly rippleCount: number;
}

// ── Weather on surfaces ────────────────────────────────────────────────────────

/**
 * Highest surface above each cell around the camera (what rain falls onto): a point is
 * sheltered when it is below its cell's height. Row-major, x fastest.
 */
export interface CoverMap3d {
  readonly originX: number;
  readonly originZ: number;
  /** Meters per cell. */
  readonly cell: number;
  /** Cells per side. */
  readonly size: number;
  readonly heights: Float32Array;
  /** Changes whenever `heights` does. */
  readonly version: number;
}

export interface Weather3d {
  /** 0..1: how wet exposed surfaces are (darker, glossier, puddles on flat ground). */
  readonly wetness: number;
  /** 0..1: snow lying on surfaces that face up. */
  readonly snow: number;
  /** 0..1: rain falling now (ripples in puddles). */
  readonly rain: number;
  /** Null: nothing is known to cover anything (everything is exposed). */
  readonly cover: CoverMap3d | null;
}

export interface Nature3d {
  readonly sky: Sky3d | null;
  readonly water: Water3d | null;
  readonly weather: Weather3d | null;
}
