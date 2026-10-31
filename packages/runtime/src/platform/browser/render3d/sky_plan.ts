/**
 * Planning the outdoors (`Frame3d.nature` → `NaturePlan`), API-neutral: one uniform slot per
 * view (`NATURE_FIELDS`: camera, sun, sky model, clouds, fog, weather, the water the camera
 * is in), six more for the environment cube's faces, and the water block (`WATER_FIELDS`:
 * bodies, their Gerstner waves, splash rings). Both backends draw from it: sky_webgpu.ts /
 * sky_webgl2.ts (sky, aerial perspective, wet and snowy surfaces, cloud shadows) and
 * water_webgpu.ts / water_webgl2.ts (the surfaces, refraction, caustics, underwater).
 *
 * The environment cube is rebuilt when `environmentKey` changes: the sun quantized to about
 * half a degree, cloud cover and darkness to 0.02, the clouds' drift to 250 m, or the cloud
 * mode (flat below high quality, volumetric at high) changes.
 */

import { EARTH_ATMOSPHERE, RIPPLE_FLOATS, WAVE_FLOATS } from '../../../core/index.js';
import type { CoverMap3d, Fog3d, Frame3d, Nature3d, View3d, WaterBody3d } from '../../../core/index.js';
import { skyLighting } from './ibl.js';
import { floatsOf, linearRgb, luminance, offsetOf, slotFloats } from './layout.js';
import type { UniformField } from './layout.js';

const vec4 = (name: string, count?: number): UniformField => (count === undefined ? { name, kind: 'vec4' } : { name, kind: 'vec4', count });
const mat4 = (name: string): UniformField => ({ name, kind: 'mat4' });

/**
 * How much fog covers the sky at the horizon: the fog of something at the far plane (`far`
 * meters), so the sky meets fogged ground without a seam. Height fog is integrated per
 * pixel instead (the shaders' `skyFog`).
 */
export function skyFogAmount(fog: Fog3d, far: number): number {
  if (fog.kind === 'linear') return Math.min(1, Math.max(0, (far - fog.near) / Math.max(fog.far - fog.near, 1e-4)));
  if (fog.kind === 'exponential') return 1 - Math.exp(-fog.density * far);
  return 0;
}

/**
 * Where a view's surfaces fade into the sky beyond its far plane (meters from the eye): from
 * just past half the far plane to full just short of it, measured along the ray, so every
 * pixel is all sky before the far plane can clip it. Terrain, meshes and water end in the
 * sky's own color there, and the sky below the horizon is that same color, so there is no
 * edge and no band at any quality (the quality only moves the far plane).
 */
export function viewFadeOf(view: Pick<View3d, 'far'>): { start: number; end: number } {
  if (!(view.far > 0) || !Number.isFinite(view.far)) return { start: 0, end: 0 };
  return { start: view.far * 0.55, end: view.far * 0.97 };
}

/** Per view (and per environment cube face). */
export const NATURE_FIELDS: readonly UniformField[] = [
  mat4('viewProjection'),
  mat4('inverseViewProjection'),
  /** xyz, near. */
  vec4('cameraPos'),
  /** Pixels: x, y, width, height. */
  vec4('viewport'),
  /** Target width, height, 1/width, 1/height. */
  vec4('targetSize'),
  /** Toward the sun (xyz), sun intensity. */
  vec4('toSun'),
  /** Sun color (linear), sun disc radius (radians). */
  vec4('sunColor'),
  /** Zenith (linear), model (0 gradient, 1 atmosphere). */
  vec4('zenith'),
  /** Horizon (linear), stars 0..1. */
  vec4('horizon'),
  /** Rayleigh per meter (rgb), its scale height. */
  vec4('rayleigh'),
  /** Ozone per meter (rgb), Mie scale height. */
  vec4('ozone'),
  /** Mie per meter, Mie g, planet radius, atmosphere radius. */
  vec4('mieParams'),
  /** Exposure, game time, lightning flash, specular scale of the environment cube. */
  vec4('misc'),
  /** Clouds: coverage (0: none), density, base (world y), thickness. */
  vec4('cloudsA'),
  /** Clouds: drift x, drift z, scale (m), darkness. */
  vec4('cloudsB'),
  /** Fog color (linear), kind (0 none, 1 exponential, 2 linear). */
  vec4('fogColor'),
  /** Fog density, near, far, 0. */
  vec4('fogParams'),
  /** Fog height falloff (1/m), its base height, the fog at the far plane (0..1), the view's far distance. */
  vec4('fogHeight'),
  /** Weather: wetness, snow, rain, cover map on (0/1). */
  vec4('weatherOn'),
  /** Cover map: origin x, origin z, meters per cell, cells per side. */
  vec4('coverMap'),
  /** Ambient (linear), quality (0 low, 1 medium, 2 high). */
  vec4('ambientLight'),
  /** Water: body the camera is under (-1: none), its surface height there, bodies, ripples. */
  vec4('waterAt'),
  /** Environment cube faces: face, face size, 1 when rendering a face; w: 1 when the sky pass drew the sky (a skybox panorama, or the view's camera background). */
  vec4('cubeFace'),
  /** The far fade (`viewFadeOf`): start, end (0: none, the scene pass fades instead), 0, 0. */
  vec4('viewFade'),
];

export const NATURE_SLOT = slotFloats(NATURE_FIELDS);

/** Most bodies, waves and ripples a frame draws. */
export const MAX_BODIES = 8;
export const MAX_WAVES = 64;
export const MAX_RIPPLES = 32;
/** vec4s per body in `WATER_FIELDS.bodies`. */
export const BODY_VEC4S = 6;

/**
 * The water block. Per body (`BODY_VEC4S` vec4s): [kind (0 ocean, 1 lake, 2 pool, 3 river),
 * level, yaw, shape (0 rect, 1 ellipse)], [center xyz, depth], [half x, half z, first wave,
 * wave count], [deep (linear), clarity], [shallow (linear), foam], [roughness, caustics, ripple, calm distance].
 * Per wave two vec4s (`Water3d.waves`' 8 floats); per ripple one (x, z, radius, strength).
 */
export const WATER_FIELDS: readonly UniformField[] = [
  vec4('bodies', MAX_BODIES * BODY_VEC4S),
  vec4('waves', MAX_WAVES * 2),
  vec4('ripples', MAX_RIPPLES),
];

export const WATER_BLOCK_FLOATS = floatsOf(WATER_FIELDS);

const KINDS: Readonly<Record<WaterBody3d['kind'], number>> = { ocean: 0, lake: 1, pool: 2, river: 3 };
const QUALITY = { low: 0, medium: 1, high: 2 } as const;

/** How the sky draws clouds (`Quality3d.volumetricClouds`): raymarched through the layer, or one flat noise layer on the dome. */
export type CloudMode = 'volumetric' | 'flat';

export interface NaturePlan {
  /** Appended to the environment cube's key. */
  readonly environmentKey: string;
  readonly nature: Nature3d;
  readonly sky: Nature3d['sky'];
  /** `NATURE_SLOT` floats per view, then six environment cube faces. */
  readonly uniforms: Float32Array;
  readonly views: number;
  readonly waterBlock: Float32Array;
  /** The bodies drawn (at most MAX_BODIES), in `waterBlock` order. */
  readonly bodies: readonly WaterBody3d[];
  readonly cover: CoverMap3d | null;
  readonly quality: 0 | 1 | 2;
  /** How the sky draws the clouds (`Quality3d.volumetricClouds`). */
  readonly clouds: CloudMode;
}

/** The water body the camera is under, and the surface above it (CPU Gerstner, the shader's formula). */
function underwater(bodies: readonly WaterBody3d[], waves: Float32Array, time: number, p: readonly number[]): [number, number] {
  let best: [number, number] = [-1, 0];
  bodies.forEach((b, i) => {
    if (b.kind === 'river') return;
    const dx = p[0]! - b.center[0]; const dz = p[2]! - b.center[2];
    if (b.kind !== 'ocean') {
      const c = Math.cos(b.yaw); const s = Math.sin(b.yaw);
      const lx = (dx * c - dz * s) / b.halfSize[0]; const lz = (dx * s + dz * c) / b.halfSize[1];
      if (b.shape === 'ellipse' ? lx * lx + lz * lz > 1 : Math.abs(lx) > 1 || Math.abs(lz) > 1) return;
    }
    let x0 = p[0]!; let z0 = p[2]!; let y = 0;
    for (let it = 0; it < 5; it++) {
      let dxw = 0; let dzw = 0; y = 0;
      for (let w = b.firstWave; w < b.firstWave + b.waveCount; w++) {
        const o = w * WAVE_FLOATS;
        const theta = waves[o + 2]! * (waves[o]! * x0 + waves[o + 1]! * z0) - waves[o + 3]! * time + waves[o + 6]!;
        const qa = waves[o + 5]! * waves[o + 4]! * Math.cos(theta);
        dxw += qa * waves[o]!; dzw += qa * waves[o + 1]!; y += waves[o + 4]! * Math.sin(theta);
      }
      x0 += p[0]! - (x0 + dxw); z0 += p[2]! - (z0 + dzw);
    }
    const surface = b.level + y;
    if (p[1]! < surface && p[1]! > b.level - b.depth && (best[0] < 0 || surface > best[1])) best = [i, surface];
  });
  return best;
}

/**
 * Whether the outdoor passes fade a view's surfaces into the sky (`viewFade`): they draw its
 * sky (an atmosphere or gradient model, or weather), not a skybox panorama or the camera's
 * background, which the scene's sky pass draws and its surfaces fade toward themselves.
 */
export function natureFades(frame: Frame3d, view: View3d): boolean {
  const nature = frame.nature;
  if (nature === undefined || nature === null || (nature.sky === null && nature.weather === null)) return false;
  return (frame.environment.skybox === undefined || frame.environment.skybox === null) && view.clear === null;
}

export function planNature(frame: Frame3d, views: readonly View3d[], width: number, height: number): NaturePlan | null {
  const nature = frame.nature;
  if (nature === undefined || nature === null) return null;
  const env = frame.environment;
  const sky = nature.sky;
  const water = nature.water;
  const weather = nature.weather;
  const bodies = water === null ? [] : water.bodies.slice(0, MAX_BODIES);
  const quality = QUALITY[frame.quality.level];
  const cloudMode: CloudMode = frame.quality.volumetricClouds ? 'volumetric' : 'flat';

  // ── The water block ─────────────────────────────────────────────────────────
  const waterBlock = new Float32Array(WATER_BLOCK_FLOATS);
  const bodiesAt = offsetOf(WATER_FIELDS, 'bodies');
  const wavesAt = offsetOf(WATER_FIELDS, 'waves');
  const ripplesAt = offsetOf(WATER_FIELDS, 'ripples');
  let waveCount = 0;
  bodies.forEach((b, i) => {
    const first = waveCount;
    const count = Math.min(b.waveCount, MAX_WAVES - waveCount);
    waterBlock.set(water!.waves.subarray(b.firstWave * WAVE_FLOATS, (b.firstWave + count) * WAVE_FLOATS), wavesAt + first * WAVE_FLOATS);
    waveCount += count;
    const o = bodiesAt + i * BODY_VEC4S * 4;
    waterBlock.set([
      KINDS[b.kind], b.level, b.yaw, b.shape === 'ellipse' ? 1 : 0,
      ...b.center, b.depth,
      b.halfSize[0], b.halfSize[1], first, count,
      ...linearRgb(b.deep), b.clarity,
      ...linearRgb(b.shallow), b.foam,
      b.roughness, b.caustics, b.ripple, b.calmDistance,
    ], o);
  });
  const ripples = water === null ? 0 : Math.min(MAX_RIPPLES, water.rippleCount);
  if (water !== null) waterBlock.set(water.ripples.subarray(0, ripples * RIPPLE_FLOATS), ripplesAt);
  // The camera's water test reads the waves as packed (first wave renumbered).
  const packed = bodies.map((b, i) => ({ ...b, firstWave: waterBlock[bodiesAt + i * BODY_VEC4S * 4 + 10]!, waveCount: waterBlock[bodiesAt + i * BODY_VEC4S * 4 + 11]! }));
  const packedWaves = waterBlock.subarray(wavesAt, wavesAt + MAX_WAVES * WAVE_FLOATS);

  // ── Per view and per cube face ──────────────────────────────────────────────
  const zenith = sky === null ? linearRgb(env.sky.zenith) : linearRgb(sky.zenith);
  const horizon = sky === null ? linearRgb(env.sky.horizon) : linearRgb(sky.horizon);
  const lighting = skyLighting(zenith, horizon);
  const ambient = linearRgb(env.ambient);
  const specularScale = lighting.meanLuminance > 1e-6 ? luminance(ambient) / lighting.meanLuminance : 0;
  const fog = env.fog;
  const uniforms = new Float32Array((views.length + 6) * NATURE_SLOT);
  const fill = (slot: number, view: View3d, face: number, faceSize: number): void => {
    const o = slot * NATURE_SLOT;
    const at = (name: string): number => o + offsetOf(NATURE_FIELDS, name);
    const set = (name: string, ...values: number[]): void => uniforms.set(values, at(name));
    if (face < 0) {
      uniforms.set(view.viewProjection, at('viewProjection'));
      uniforms.set(view.inverseViewProjection, at('inverseViewProjection'));
    }
    set('cameraPos', ...view.position, view.near);
    set('viewport', view.viewport.x, view.viewport.y, view.viewport.width, view.viewport.height);
    set('targetSize', width, height, 1 / width, 1 / height);
    const a = sky?.atmosphere ?? EARTH_ATMOSPHERE;
    set('rayleigh', ...a.rayleigh, a.rayleighHeight);
    set('ozone', ...a.ozone, a.mieHeight);
    set('mieParams', a.mie, a.mieG, a.planetRadius, a.atmosphereRadius);
    if (sky !== null) {
      set('toSun', ...sky.toSun, sky.sunIntensity);
      set('sunColor', ...linearRgb(sky.sunColor), a.sunRadius);
      set('misc', a.exposure, sky.time, sky.flash, specularScale);
      const c = sky.clouds;
      if (c !== null) {
        set('cloudsA', c.coverage, c.density, c.base, c.thickness);
        set('cloudsB', c.offset[0], c.offset[1], c.scale, c.darkness);
      }
    } else {
      set('misc', a.exposure, water?.time ?? 0, 0, specularScale);
      if (env.sun !== null) {
        set('toSun', -env.sun.direction[0], -env.sun.direction[1], -env.sun.direction[2], env.sun.intensity);
        set('sunColor', ...linearRgb(env.sun.color), a.sunRadius);
      }
    }
    set('zenith', ...zenith, sky !== null && sky.model === 'atmosphere' ? 1 : 0);
    set('horizon', ...horizon, sky?.stars ?? 0);
    set('fogColor', ...linearRgb(fog.color), fog.kind === 'none' ? 0 : fog.kind === 'exponential' ? 1 : 2);
    set('fogParams', fog.density, fog.near, fog.far, 0);
    set('fogHeight', fog.heightFalloff ?? 0, fog.height ?? 0, face >= 0 ? 0 : skyFogAmount(fog, view.far), view.far);
    if (weather !== null) {
      set('weatherOn', weather.wetness, weather.snow, weather.rain, weather.cover === null ? 0 : 1);
      if (weather.cover !== null) set('coverMap', weather.cover.originX, weather.cover.originZ, weather.cover.cell, weather.cover.size);
    }
    set('ambientLight', ...ambient, quality);
    const under = water === null || face >= 0 ? [-1, 0] : underwater(packed, packedWaves, water.time, view.position);
    set('waterAt', under[0]!, under[1]!, bodies.length, ripples);
    // w: the scene's sky pass already drew this view's sky, so the composite leaves it: a skybox panorama, or (views
    // only) a camera `background`, which replaces the sky as it does in the sky pass (packFrame's flat sky).
    const panorama = env.skybox !== undefined && env.skybox !== null;
    set('cubeFace', face, faceSize, face >= 0 ? 1 : 0, panorama || (face < 0 && view.clear !== null) ? 1 : 0);
    // The far fade runs after the water (it fades the water too) toward this pass's sky; where the sky pass drew the sky, the scene pass fades.
    if (face < 0 && natureFades(frame, view)) {
      const fade = viewFadeOf(view);
      set('viewFade', fade.start, fade.end, 0, 0);
    }
  };
  views.forEach((view, i) => fill(i, view, -1, 0));
  const size = frame.quality.environmentSize;
  const origin = views[0];
  if (origin !== undefined) for (let f = 0; f < 6; f++) fill(views.length + f, origin, f, size);

  const q = (n: number, step: number): number => Math.round(n / step);
  const c = sky?.clouds ?? null;
  const environmentKey = sky === null
    ? ''
    : `|nature:${sky.model}:${q(sky.toSun[0], 0.01)},${q(sky.toSun[1], 0.01)},${q(sky.toSun[2], 0.01)}:${q(sky.stars, 0.05)}:${q(sky.flash, 0.25)}`
      + (c === null ? '' : `:${cloudMode}:${q(c.coverage, 0.02)},${q(c.darkness, 0.02)},${q(c.offset[0], 250)},${q(c.offset[1], 250)}`);

  return {
    environmentKey, nature, sky, uniforms, views: views.length, waterBlock, bodies, cover: weather?.cover ?? null, quality, clouds: cloudMode,
  };
}

/** The slot of an environment cube face in `NaturePlan.uniforms`. */
export function faceSlot(plan: NaturePlan, face: number): number {
  return plan.views + face;
}
