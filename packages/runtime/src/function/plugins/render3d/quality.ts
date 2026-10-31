/**
 * The quality ladder: what each `Settings.quality` level draws. One table, read once per
 * frame from the `settings` resource (the api layer declares it; without it — engine tests,
 * a bare kernel — the level is `high`).
 *
 *              low (phones)        medium               high
 *   sun        1 cascade, 50 m     3 cascades, 100 m    4 cascades, 150 m
 *   filter     hardware 2×2        3×3 PCF              3×3 PCF
 *   local      no point/spot       16 tiles × 512²      16 tiles × 1024²
 *   lights     64                  256                  1024
 *   SSAO       off                 half resolution      full resolution
 *   SSR, volumetric fog            off / off            on / on
 *   clouds     flat (2D layer)     flat (2D layer)      volumetric (raymarched)
 *   god rays   off                 on                   on
 *   bloom      4 levels            5 levels             6 levels
 *   LOD scale  0.5                 0.75                 1
 *   view dist  1.5 km              3 km                 the far plane (20 km)
 *   pixels     1.6 MP, DRS ≥ 0.6   3.7 MP, DRS ≥ 0.7    8.3 MP, DRS ≥ 0.8
 *   frame cap  60                  60                   none
 *   textures   256 MB, ≤ 1024²     768 MB, ≤ 2048²      1.5 GB, ≤ 4096²
 *   occlusion  off                 Hi-Z                 Hi-Z
 *   decals     64                  256                  512
 *   offscreen  1 view per frame    2                    4
 *   detail     < 1.5 px culled     < 1 px               < 0.5 px      (projected radius; shadow texels alike)
 *
 * `Settings.quality = "auto"` takes the surface's device tier (`RenderSurface3d.deviceTier`:
 * phones and weak GPUs are low), so a first run on a phone is never handed the desktop
 * ladder.
 *
 * Effects a scene asks for that its quality leaves out are simply not drawn: the ladder is
 * the contract, so it is not a warning.
 */

import { fail } from '../../../core/index.js';
import { COLOR_VISION_MODES } from '../../../core/index.js';
import type { ColorVision, Quality3d } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';

export type QualityLevel = Quality3d['level'];

/**
 * Bloom's mip chain at every quality: half, quarter and eighth resolution, a glow some 16 px wide,
 * as the old renderer's (a quarter-resolution bright pass under a 9-tap blur). A deeper chain spread
 * every bright floor into a screen-wide haze that washed out what stood near it.
 */
export const BLOOM_LEVELS = 3;

export const QUALITY_LADDER: Readonly<Record<QualityLevel, Quality3d>> = {
  low: {
    level: 'low', cascades: 1, shadowMapSize: 2048, shadowDistance: 50, shadowTaps: 1, localShadowTiles: 0, localShadowSize: 512,
    maxLights: 64, clusters: [16, 9, 16], ambientOcclusion: 'off', reflections: false, volumetricFog: false, volumetricClouds: false, godRays: false,
    bloomLevels: BLOOM_LEVELS, environmentSize: 32, lodScale: 0.5, viewDistance: 1500, maxRenderPixels: 1_600_000, minRenderScale: 0.6, frameCap: 60,
    textureBudget: 256 * 2 ** 20, maxTextureSize: 1024, occlusion: false, maxDecals: 64, offscreenPerFrame: 1, detailPixels: 1.5,
  },
  medium: {
    level: 'medium', cascades: 3, shadowMapSize: 2048, shadowDistance: 100, shadowTaps: 9, localShadowTiles: 16, localShadowSize: 512,
    maxLights: 256, clusters: [16, 9, 24], ambientOcclusion: 'half', reflections: false, volumetricFog: false, volumetricClouds: false, godRays: true,
    bloomLevels: BLOOM_LEVELS, environmentSize: 64, lodScale: 0.75, viewDistance: 3000, maxRenderPixels: 3_700_000, minRenderScale: 0.7, frameCap: 60,
    textureBudget: 768 * 2 ** 20, maxTextureSize: 2048, occlusion: true, maxDecals: 256, offscreenPerFrame: 2, detailPixels: 1,
  },
  high: {
    level: 'high', cascades: 4, shadowMapSize: 2048, shadowDistance: 150, shadowTaps: 9, localShadowTiles: 16, localShadowSize: 1024,
    maxLights: 1024, clusters: [16, 9, 24], ambientOcclusion: 'full', reflections: true, volumetricFog: true, volumetricClouds: true, godRays: true,
    bloomLevels: BLOOM_LEVELS, environmentSize: 128, lodScale: 1, viewDistance: Infinity, maxRenderPixels: 8_300_000, minRenderScale: 0.8, frameCap: 0,
    textureBudget: 1536 * 2 ** 20, maxTextureSize: 4096, occlusion: true, maxDecals: 512, offscreenPerFrame: 4, detailPixels: 0.5,
  },
};

/** The `settings` resource the api layer declares (`Settings.quality`). */
export const SETTINGS = 'settings';

/** `Settings.colorblind` (none without the settings resource). */
export function colorVisionOf(kernel: Kernel): ColorVision {
  if (kernel.registry.resources.get(SETTINGS)?.schema['colorblind'] === undefined) return 'none';
  const mode = kernel.resource(SETTINGS)['colorblind'];
  if (!(COLOR_VISION_MODES as readonly unknown[]).includes(mode)) {
    fail('PP3818', `Settings.colorblind is ${JSON.stringify(mode)}; render3d knows ${COLOR_VISION_MODES.join(', ')}`);
  }
  return mode as ColorVision;
}

/**
 * This frame's quality: `Settings.quality` when the game has the settings resource ("auto":
 * the device's tier), else the device's tier, else high.
 */
export function qualityOf(kernel: Kernel, deviceTier: QualityLevel = 'high'): Quality3d {
  if (kernel.registry.resources.get(SETTINGS)?.schema['quality'] === undefined) return QUALITY_LADDER[deviceTier];
  const level = kernel.resource(SETTINGS)['quality'];
  if (level === 'auto') return QUALITY_LADDER[deviceTier];
  const quality = QUALITY_LADDER[level as QualityLevel];
  if (quality === undefined) fail('PP3818', `Settings.quality is ${JSON.stringify(level)}; render3d knows auto, low, medium and high`);
  return quality;
}
