/**
 * The scene's surroundings, from the terrain and environment services (both optional,
 * looked up at render time with `kernel.tryService`):
 *
 *   environment   sky gradient, fog, ambient and sun from `resolve()`. Without the
 *                 service: `DEFAULT_ENVIRONMENT` (a daytime sky, no fog, no sun).
 *   terrain       a translucent water plane at the field's `waterLevel` (the ground itself
 *                 is drawn by terrain.ts as CDLOD tiles).
 *
 * Post-processing. The environment service resolves `post` (preset expanded, scene and
 * runtime fields applied); `postOf` maps it onto the port's `Post3d`. Which costly effects
 * are drawn is the quality's call (quality.ts), not this module's.
 *
 * The sun. A directional `light` entity in the scene with `shadows` on is authored lighting and
 * wins: the brightest one is the sun. Without one, the environment's resolved sun is the sun and
 * casts shadows. Every other directional light (shadowless ones) is a fill beside it.
 */

import { PLAIN_POST } from '../../../core/index.js';
import type { Environment3d, Material3d, MeshBatch, Post3d, Rgb, Skybox3d, Texture3d } from '../../../core/index.js';
import type { Color } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { PostSettings, ResolvedEnvironment, TerrainField } from '../../services/index.js';
import { unitShape } from '../../../resource/index.js';

/** What a scene looks like without an environment provider. */
export const DEFAULT_ENVIRONMENT: Environment3d = {
  sky: { zenith: [0.32, 0.52, 0.85], horizon: [0.78, 0.86, 0.94] },
  fog: { kind: 'none', color: [0.78, 0.86, 0.94], density: 0, near: 0, far: 0, volumetric: 0 },
  ambient: [0.42, 0.44, 0.48],
  sun: null,
  post: { ...PLAIN_POST, ambientOcclusion: 1, reflections: true },
};

/**
 * Where 3D bloom starts when a scene leaves `bloom_threshold` at its default (1, which in 2D keeps
 * bloom off): light above half brightness glows, so the sun and bright highlights do.
 */
export const BLOOM_THRESHOLD_3D = 0.5;

/** The environment's resolved post settings as the port's `Post3d`. */
export function postOf(p: PostSettings): Post3d {
  return {
    exposure: p.exposure,
    bloom: p.bloom,
    bloomThreshold: p.bloomThreshold === 1 ? BLOOM_THRESHOLD_3D : p.bloomThreshold,
    grade: { tint: rgb(p.tint), saturation: p.saturation, contrast: p.contrast, temperature: p.temperature },
    grain: p.grain,
    vignette: p.vignette,
    chromaticAberration: p.chromaticAberration,
    pixelate: p.pixelate,
    posterize: p.posterize,
    toon: p.toon,
    edges: p.edges,
    edgeColor: rgb(p.edgeColor),
    ambientOcclusion: p.ambientOcclusion,
    reflections: p.reflections,
    godRays: p.godRays,
    mode: p.mode,
    wireColor: p.wireColor === null ? null : rgb(p.wireColor),
    wireBackground: p.wireBackground === null ? null : rgb(p.wireBackground),
    antialias: p.antialias,
  };
}

function rgb(c: Color): Rgb {
  return [c.r, c.g, c.b];
}

/** The environment service's look as the port's `Environment3d` (sun before light entities are considered). */
export function fromResolved(r: ResolvedEnvironment, image: (ref: string) => string = (ref) => ref): Environment3d {
  const fog = r.fog;
  const linear = fog.near !== null && fog.far !== null;
  return {
    sky: { zenith: rgb(r.zenith), horizon: rgb(r.horizon) },
    fog: {
      kind: linear ? 'linear' : fog.density > 0 ? 'exponential' : 'none',
      color: rgb(fog.color),
      density: fog.density,
      near: fog.near ?? 0,
      far: fog.far ?? 0,
      volumetric: fog.volumetric,
      heightFalloff: linear ? 0 : fog.heightFalloff ?? 0,
      height: fog.height ?? 0,
    },
    ambient: rgb(r.ambient),
    sun: r.sunIntensity > 0
      ? { direction: [r.sunDirection.x, r.sunDirection.y, r.sunDirection.z], color: rgb(r.sunColor), intensity: r.sunIntensity, shadows: true }
      : null,
    post: postOf(r.post),
    ...(r.shadowDistance !== undefined && r.shadowDistance !== null && { shadowDistance: r.shadowDistance }),
    skybox: r.skybox === undefined || r.skybox === null ? null : skyboxOf({ ...r.skybox, texture: image(r.skybox.texture) }),
  };
}

const SKYBOX_TEXTURES = new Map<string, Texture3d>();

/** The environment's panorama as the port's `Skybox3d` (one Texture3d per image, so the surface uploads it once). */
function skyboxOf(s: { readonly texture: string; readonly rotation: number; readonly intensity: number }): Skybox3d {
  let texture = SKYBOX_TEXTURES.get(s.texture);
  if (texture === undefined) {
    texture = { id: `skybox:${s.texture}`, source: { kind: 'file', path: s.texture }, colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'clamp', filter: 'linear' };
    SKYBOX_TEXTURES.set(s.texture, texture);
  }
  return { texture, rotation: (s.rotation * Math.PI) / 180, intensity: s.intensity };
}

/** The scene's look; `image` turns the skybox's image handle ("images/sky") into its file. */
export function sceneEnvironment(kernel: Kernel, image?: (ref: string) => string): Environment3d {
  const service = kernel.tryService(ENVIRONMENT_SERVICE);
  return service === undefined ? DEFAULT_ENVIRONMENT : fromResolved(service.resolve(), image);
}

export function terrainField(kernel: Kernel): TerrainField | null {
  return kernel.tryService(TERRAIN_SERVICE)?.current() ?? null;
}

const WATER = {
  id: 'render3d:water',
  baseColor: [0.16, 0.38, 0.5, 0.72],
  baseColorTexture: null,
  metallic: 0,
  roughness: 0.15,
  metallicRoughnessTexture: null,
  emissive: [0, 0, 0],
  emissiveTexture: null,
  alphaMode: 'blend',
  alphaCutoff: 0.5,
  doubleSided: true,
  unlit: false,
} as const satisfies Material3d;

/** The water plane over the whole terrain at `waterLevel`, or null when the scene has none. */
export function waterDraw(field: TerrainField): MeshBatch | null {
  if (field.waterLevel === null) return null;
  const instances = new Float32Array(20);
  instances[0] = field.width;
  instances[5] = 1;
  instances[10] = field.depth;
  instances[12] = field.minX + field.width / 2;
  instances[13] = field.waterLevel;
  instances[14] = field.minZ + field.depth / 2;
  instances[15] = 1;
  instances.set([1, 1, 1, 1], 16);
  return { geometry: unitShape('plane'), material: WATER, count: 1, instances, entities: [null], castShadows: false };
}
