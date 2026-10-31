/**
 * Sky presets and the sun's path. A preset is a palette — gradient, ambient light, and the
 * sun's colour and strength; "atmosphere" instead derives its palette from single scattering
 * through the air (atmosphere.ts) at the sun's position: blue by day, orange and red near the
 * horizon, dark at night.
 *
 * The sun rises in the east (+x) at 06:00, culminates at noon (tilted toward +z), and sets
 * in the west at 18:00; between 18:00 and 06:00 it is night and the light comes from the
 * opposite point of its path (the moon). These rendering values may use trig: nothing in
 * the simulation reads them.
 */

import { Color, Vec3 } from '../../../core/index.js';
import type { Atmosphere3d } from '../../../core/index.js';
import { atmosphereLight, luminance } from './atmosphere.js';

/**
 * The sky's base look by hour and mood of light. Grey, rainy and stormy skies are the
 * weather's ("weather": "overcast" | "rain" | "storm"), which greys whichever preset is
 * under it; WEATHER_SKY_NAMES are refused here with that fix.
 */
export const SKY_PRESETS = ['clear_day', 'atmosphere', 'sunset', 'dusk', 'night'] as const;
export type SkyPreset = (typeof SKY_PRESETS)[number];
/** Former sky presets that are weather now. */
export const WEATHER_SKY_NAMES = ['overcast', 'rain', 'storm'] as const;

export interface Palette {
  readonly zenith: Color;
  readonly horizon: Color;
  readonly ambient: Color;
  readonly sunColor: Color;
  readonly sunIntensity: number;
}

const p = (zenith: string, horizon: string, ambient: string, sun: string, sunIntensity: number): Palette => ({
  zenith: Color.hex(zenith), horizon: Color.hex(horizon), ambient: Color.hex(ambient), sunColor: Color.hex(sun), sunIntensity,
});

const PALETTES: Readonly<Record<Exclude<SkyPreset, 'atmosphere'>, Palette>> = {
  clear_day: p('#3a7bd5', '#a9d0f5', '#6b7a90', '#fff4e0', 1),
  sunset: p('#3b4a8a', '#ff9e5e', '#5a4a50', '#ffa060', 0.8),
  dusk: p('#2b2f5e', '#f08a5d', '#4a4058', '#ffb070', 0.6),
  night: p('#050812', '#1a2238', '#1c2030', '#8090c0', 0.15),
};

/** The weather's grey skies, light overcast to storm-dark (overcastPalette blends them). */
const WEATHER_PALETTES = {
  overcast: p('#8a939c', '#b8c0c6', '#7a8088', '#e0e4e8', 0.4),
  storm: p('#2c3138', '#4f565e', '#3a3f46', '#a0a8b0', 0.15),
} as const;

/** Hours when the sun rises and sets; `is_night` is outside [DAWN, DUSK). */
export const DAWN = 6;
export const DUSK = 18;

export function isNight(timeOfDay: number): boolean {
  return timeOfDay < DAWN || timeOfDay >= DUSK;
}

/** Sine of the sun's height over its path: 0 at dawn and dusk, 1 at noon, negative at night. */
export function sunHeight(timeOfDay: number): number {
  return Math.sin(((timeOfDay - DAWN) / (DUSK - DAWN)) * Math.PI);
}

/** 0 at night, 1 in full day, smooth around dawn and dusk. */
export function daylight(timeOfDay: number): number {
  return smooth(-0.1, 0.15, sunHeight(timeOfDay));
}

function smooth(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Unit vector toward the sun at this hour: up by day, below the horizon at night. */
export function toSunAt(timeOfDay: number): Vec3 {
  const angle = ((timeOfDay - DAWN) / (DUSK - DAWN)) * Math.PI;
  return new Vec3(Math.cos(angle), Math.sin(angle), 0.35).normalized();
}

/** The way the light travels at this hour: from the sun by day, from the moon by night. */
export function lightDirection(timeOfDay: number): Vec3 {
  const toSun = toSunAt(timeOfDay);
  const toLight = toSun.y >= 0 ? toSun : toSun.__neg__();
  return toLight.__neg__();
}

/** 0 at night, 1 in full day, from the sun's height (sine of its elevation). */
export function daylightAt(sunY: number): number {
  return smooth(-0.1, 0.15, sunY);
}

function encode(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgb(c: readonly number[]): Color {
  return new Color(encode(c[0]!), encode(c[1]!), encode(c[2]!));
}

/** Sunlight at noon through a clear atmosphere: what `sunIntensity` 1 means. */
const NOON_SUN = 0.88;

let lastAir: { readonly key: string; readonly palette: Palette } | null = null;

/**
 * The "atmosphere" palette for the sun toward `toSun`: the scattered sky's zenith, horizon
 * and hemisphere light, and the sunlight that gets through (reddened low down), fading to
 * the night palette as the sun sets. Cached on the sun's position (to ~0.06°).
 */
export function atmospherePalette(model: Atmosphere3d, toSun: Vec3): Palette {
  const key = `${Math.round(toSun.x * 1000)},${Math.round(toSun.y * 1000)},${Math.round(toSun.z * 1000)},${model.mie},${model.exposure}`;
  if (lastAir !== null && lastAir.key === key) return lastAir.palette;
  const light = atmosphereLight(model, [toSun.x, toSun.y, toSun.z]);
  const peak = Math.max(light.sun[0], light.sun[1], light.sun[2], 1e-6);
  const day: Palette = {
    zenith: srgb(light.zenith),
    horizon: srgb(light.horizon),
    ambient: srgb(light.ambient.map((c) => c * 0.8)),
    sunColor: srgb(light.sun.map((c) => c / peak)),
    sunIntensity: Math.min(1.2, luminance(light.sun) / NOON_SUN),
  };
  const palette = lerpPalette(PALETTES.night, day, daylightAt(toSun.y));
  lastAir = { key, palette };
  return palette;
}

export function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  return {
    zenith: a.zenith.lerp(b.zenith, t),
    horizon: a.horizon.lerp(b.horizon, t),
    ambient: a.ambient.lerp(b.ambient, t),
    sunColor: a.sunColor.lerp(b.sunColor, t),
    sunIntensity: a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t,
  };
}

/** The preset's palette ("atmosphere" follows the sun through the air model; the others are fixed). */
export function palette(preset: SkyPreset, air: { readonly model: Atmosphere3d; readonly toSun: Vec3 }): Palette {
  return preset === 'atmosphere' ? atmospherePalette(air.model, air.toSun) : PALETTES[preset];
}

/** A palette for weather: the overcast sky, darker as storms build (`darkness` 0..1). */
export function overcastPalette(darkness: number): Palette {
  return lerpPalette(WEATHER_PALETTES.overcast, WEATHER_PALETTES.storm, Math.min(1, Math.max(0, darkness)));
}

/** With a day cycle, every preset darkens toward night as the sun goes down. */
export function cycled(palette: Palette, timeOfDay: number): Palette {
  const light = daylight(timeOfDay);
  const night: Palette = {
    zenith: PALETTES.night.zenith,
    horizon: PALETTES.night.horizon,
    ambient: palette.ambient.lerp(Color.BLACK, 0.7),
    sunColor: PALETTES.night.sunColor,
    sunIntensity: palette.sunIntensity * 0.1,
  };
  return lerpPalette(night, palette, light);
}
