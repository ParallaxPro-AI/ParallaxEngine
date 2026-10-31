/**
 * The scene passes' shaders, in WGSL (WebGPU) and GLSL ES 3.00 (WebGL2), written side by
 * side so a change to one is a change to both. Uniform blocks come from `layout.ts`'s field
 * lists; vertex inputs use `LOCATION`; texture units (GLSL) come from `GLSL_UNITS`. The
 * deliberate differences between the languages:
 *
 *   - Clip depth: matrices map depth to 0..1; GLSL vertex shaders remap to -1..1
 *     (`gl_Position.z = gl_Position.z * 2.0 - gl_Position.w`).
 *   - Texture rows: WebGPU textures and framebuffers have row 0 at the top, WebGL2's at the
 *     bottom. Shadow-map lookups map light-space NDC y to `0.5 - y / 2` in WGSL and
 *     `0.5 + y / 2` in GLSL; a fragment's top-left pixel is `position.xy` in WGSL and
 *     `(gl_FragCoord.x, height - gl_FragCoord.y)` in GLSL.
 *   - Bone palettes: a storage buffer in WGSL, an RGBA32F texture in GLSL.
 *   - Mip generation: a WGSL blit pass (`mipmap`); WebGL2 calls `generateMipmap`.
 *
 * Every scene shader writes linear HDR light (the final pass tone-maps it), except the
 * overlay variants (world bars, text, debug lines), drawn after tone mapping with exact
 * display colors.
 */

import { GLSL_FOLIAGE_SWAY, WGSL_FOLIAGE_SWAY } from './foliage_wind_shaders.js';
import {
  CASTER_FIELDS, FRAME_FIELDS, glslBlock, LIGHTS_PER_ROW, LOCATION as L, MATERIAL_FIELDS, OUTLINE_FIELDS, PALETTE_ROW_JOINTS, SHADOW_FIELDS,
  TERRAIN_FIELDS, DATA_ROW, wgslStruct,
} from './layout.js';
import { glslTerrain as glslTerrainPass, wgslTerrain as wgslTerrainPass } from './terrain_shaders.js';
import { GLSL_INSTANCE_SCALE, GLSL_MATERIAL_FX, WGSL_INSTANCE_SCALE, WGSL_MATERIAL_FX } from './material_fx_shaders.js';

/** The scene passes both backends draw. */
/** The drawn sun's angular radius (radians, ~0.9°): wider than the real 0.27° so it reads as a disc on screen, as the old renderer's did. */
export const SUN_DISC_RADIUS = 0.016;

export const SCENE_PASSES = ['caster', 'sky', 'terrain', 'mesh', 'billboard', 'line', 'outline'] as const;
export type ScenePass = (typeof SCENE_PASSES)[number];

/** Passes that have a skinned variant. */
export const SKINNED_PASSES: readonly ScenePass[] = ['caster', 'mesh', 'outline'];
/** Passes that write the normal/roughness target too when the frame has one (`mrt`). */
export const MRT_PASSES: readonly ScenePass[] = ['sky', 'terrain', 'mesh'];
/** Passes with an overlay variant (drawn after tone mapping, exact colors). */
export const OVERLAY_PASSES: readonly ScenePass[] = ['billboard', 'line'];

export interface SceneVariant {
  readonly skinned?: boolean;
  /** Also write normals, roughness and reflectivity to a second target. */
  readonly mrt?: boolean;
  readonly overlay?: boolean;
}

/**
 * Texture units every WebGL2 program uses for each sampler name (one table: a name is on
 * the same unit in every program, and no program samples two names on one unit).
 */
export const GLSL_UNITS = {
  sunAtlas: 0, localAtlas: 1, paletteTexture: 2, lightData: 3, clusterGrid: 4, clusterItems: 5, envCube: 6,
  baseTexture: 7, surfaceTexture: 8, emissiveTexture: 9, normalTexture: 10, occlusionTexture: 11,
  terrainAlbedo: 7, terrainNormal: 8, splatMap: 9, detail0: 11, detail1: 12, detail2: 13, detail3: 14, image: 7,
  hdrTexture: 7, aoTexture: 8, ssrTexture: 9, gbufTexture: 10, depthTexture: 11, bloomTexture: 12, maskTexture: 13,
  sourceTexture: 14, skyCube: 15, albedoAtlas: 8, normalAtlas: 9, decalImages: 12, fogTexture: 12, skyImage: 13,
} as const;

/** WebGPU group 0 of every scene and per-view post pass: the frame bind group. */
export const FRAME_BINDINGS = {
  frame: 0, shadowTiles: 1, sunAtlas: 2, localAtlas: 3, shadowSampler: 4, palette: 5, lightData: 6, clusterGrid: 7, clusterItems: 8,
  envCube: 9, envSampler: 10,
} as const;

// ── Shared chunks (both languages) ────────────────────────────────────────────

/** AgX tone curve constants (Sobotka's AgX, minimal polynomial fit): inset/outset matrices, column-major. */
const AGX_INSET = '0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104';
const AGX_OUTSET = '1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116';
const AGX_CURVE = '15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232';

const B = {
  frame: FRAME_BINDINGS.frame,
  shadowTiles: FRAME_BINDINGS.shadowTiles,
  sunAtlas: FRAME_BINDINGS.sunAtlas,
  localAtlas: FRAME_BINDINGS.localAtlas,
  shadowSampler: FRAME_BINDINGS.shadowSampler,
  palette: FRAME_BINDINGS.palette,
  lightData: FRAME_BINDINGS.lightData,
  clusterGrid: FRAME_BINDINGS.clusterGrid,
  clusterItems: FRAME_BINDINGS.clusterItems,
  envCube: FRAME_BINDINGS.envCube,
  envSampler: FRAME_BINDINGS.envSampler,
};

// ── WGSL ──────────────────────────────────────────────────────────────────────

export const WGSL_FRAME = `${wgslStruct('Frame', FRAME_FIELDS)}${wgslStruct('Shadows', SHADOW_FIELDS)}
@group(0) @binding(${B.frame}) var<uniform> frame: Frame;
@group(0) @binding(${B.shadowTiles}) var<uniform> shadowTiles: Shadows;
@group(0) @binding(${B.sunAtlas}) var sunAtlas: texture_depth_2d;
@group(0) @binding(${B.localAtlas}) var localAtlas: texture_depth_2d;
@group(0) @binding(${B.shadowSampler}) var shadowSampler: sampler_comparison;
@group(0) @binding(${B.palette}) var<storage, read> palette: array<mat4x4<f32>>;
@group(0) @binding(${B.lightData}) var lightData: texture_2d<f32>;
@group(0) @binding(${B.clusterGrid}) var clusterGrid: texture_2d<u32>;
@group(0) @binding(${B.clusterItems}) var clusterItems: texture_2d<u32>;
@group(0) @binding(${B.envCube}) var envCube: texture_cube<f32>;
@group(0) @binding(${B.envSampler}) var envSampler: sampler;
`;

export const WGSL_COMMON = `
const PI = 3.14159265;

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn toDisplay(c: vec3<f32>) -> vec3<f32> {
  let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055), x * 12.92, x <= vec3<f32>(0.0031308));
}

fn octEncode(n: vec3<f32>) -> vec2<f32> {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z >= 0.0) { return p; }
  return (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
}

fn octDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

/** Level-of-detail cross-fade (MeshBatch.fades): f in (0, 1) keeps that fraction of pixels, f in (-1, 0) exactly the rest of the 1 + f fade-in's. */
fn lodDiscard(f: f32, pixel: vec2<f32>) -> bool {
  if (f >= 0.999) { return false; }
  let n = fract(52.9829189 * fract(dot(floor(pixel), vec2<f32>(0.06711056, 0.00583715))));
  return select((n < 1.0 + f), (n >= f), f >= 0.0);
}

fn skyColor(dir: vec3<f32>) -> vec3<f32> {
  return mix(frame.skyHorizon.rgb, frame.skyZenith.rgb, sqrt(clamp(dir.y, 0.0, 1.0)));
}

/**
 * The sun as seen through the air, per unit of sun light: a limb-darkened disc of angular
 * radius r (soft-edged so it never aliases), the bright corona hugging it, the aureole a
 * few degrees out and the broad forward glow across that side of the sky. mu: cosine of
 * the angle to the sun's center.
 */
fn sunGlare(mu: f32, r: f32) -> vec3<f32> {
  let theta = sqrt(max(2.0 * (1.0 - mu), 0.0));
  let x = clamp(theta / r, 0.0, 1.0);
  let limb = 1.0 - 0.55 * (1.0 - sqrt(1.0 - x * x));
  let disc = (1.0 - smoothstep(0.82, 1.15, theta / r)) * limb * 48.0;
  let corona = exp(-theta / (r * 0.9)) * 3.5 + exp(-theta / (r * 3.5)) * 0.9;
  let aureole = exp(-theta / 0.09) * 0.35 + pow(max(mu, 0.0), 8.0) * 0.12;
  return vec3<f32>(disc, corona, aureole);
}

/**
 * How much of the fog color covers a point dist meters away along dir (unit). Exponential
 * fog with a height falloff (frame.fogHeight.x) integrates its density along the ray in
 * closed form: density at the eye's height, thinning by e^(-falloff · rise).
 */
fn fogAmount(dir: vec3<f32>, dist: f32) -> f32 {
  let mode = frame.fogColor.w;
  if (mode < 0.5) { return 0.0; }
  if (mode > 1.5) {
    return clamp((dist - frame.fogParams.y) / max(frame.fogParams.z - frame.fogParams.y, 1e-4), 0.0, 1.0);
  }
  let falloff = frame.fogHeight.x;
  var optical = frame.fogParams.x * dist;
  if (falloff > 0.0) {
    optical *= exp(-falloff * (frame.cameraPosition.y - frame.fogHeight.y));
    let rise = falloff * dir.y * dist;
    if (abs(rise) > 1e-4) { optical *= (1.0 - exp(-rise)) / rise; }
  }
  return 1.0 - exp(-max(optical, 0.0));
}

/** The fog over the sky toward dir: the far plane's fog, thinning above the horizon (height fog: integrated to its top). */
fn skyFog(dir: vec3<f32>, c: vec3<f32>) -> vec3<f32> {
  if (frame.fogColor.w < 0.5) { return c; }
  var f = frame.fogHeight.z * (1.0 - smoothstep(-0.02, 0.3, dir.y));
  if (frame.fogColor.w < 1.5 && frame.fogHeight.x > 0.0) {
    f = fogAmount(dir, frame.cameraForward.w);
  }
  return mix(c, frame.fogColor.rgb, f);
}

/** The sky pass's color toward dir: a flat background, or the gradient and the sun's glare, fogged (a panorama: its fade color). */
fn skyBeyond(dir: vec3<f32>) -> vec3<f32> {
  if (frame.skybox.z > 0.5) { return skyFog(dir, frame.viewFadeColor.rgb); }
  if (frame.skyZenith.w < 0.5) { return frame.skyZenith.rgb; }
  var c = skyColor(dir);
  if (frame.sunDirection.w > 0.5) {
    let glare = sunGlare(dot(dir, -frame.sunDirection.xyz), ${SUN_DISC_RADIUS.toFixed(4)});
    // The disc sinks behind the horizon; its glow still lights the sky above.
    let up = smoothstep(-0.01, 0.01, dir.y);
    c += frame.sunColor.rgb * (glare.x * up + glare.y + glare.z);
  }
  return skyFog(dir, c);
}

/**
 * The far fade: a surface dist meters away along dir fades into the sky the sky pass draws
 * toward dir, full just short of the far plane, so the drawn world ends in its own sky (the
 * outdoor passes fade instead when they draw the sky: frame.viewFade.z).
 */
fn viewFadeTo(color: vec3<f32>, dir: vec3<f32>, dist: f32) -> vec3<f32> {
  if (frame.viewFade.y <= 0.0 || frame.viewFade.z > 0.5) { return color; }
  let t = clamp((dist - frame.viewFade.x) / max(frame.viewFade.y - frame.viewFade.x, 1e-4), 0.0, 1.0);
  if (t <= 0.0) { return color; }
  return mix(color, skyBeyond(dir), t);
}

fn applyFog(color: vec3<f32>, world: vec3<f32>) -> vec3<f32> {
  let dist = distance(world, frame.cameraPosition.xyz);
  let dir = (world - frame.cameraPosition.xyz) / max(dist, 1e-4);
  if (frame.fogColor.w < 0.5) { return viewFadeTo(color, dir, dist); }
  return viewFadeTo(mix(color, frame.fogColor.rgb, fogAmount(dir, dist)), dir, dist);
}
`;

export const WGSL_SHADOWS = `
fn shadowTap(atlas: texture_depth_2d, uv: vec2<f32>, depth: f32, texel: f32, filtered: bool) -> f32 {
  if (!filtered) { return textureSampleCompareLevel(atlas, shadowSampler, uv, depth); }
  var sum = 0.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      sum += textureSampleCompareLevel(atlas, shadowSampler, uv + vec2<f32>(f32(x), f32(y)) * texel, depth);
    }
  }
  return sum / 9.0;
}

fn cascadeShadow(i: i32, world: vec3<f32>, n: vec3<f32>, filtered: bool) -> f32 {
  let p = frame.cascades[i] * vec4<f32>(world + n * frame.cascadeTexel[i] * 1.5, 1.0);
  let ndc = p.xyz / p.w;
  let local = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0 || ndc.z > 1.0) { return 1.0; }
  let cols = frame.shadowParams.x;
  let texel = frame.shadowParams.y;
  let margin = 1.5 * texel * cols;
  let cell = vec2<f32>(f32(i % i32(cols)), f32(i / i32(cols)));
  let uv = (cell + clamp(local, vec2<f32>(margin), vec2<f32>(1.0 - margin))) / cols;
  return shadowTap(sunAtlas, uv, ndc.z - 0.0003, texel, filtered);
}

fn sunShadow(world: vec3<f32>, n: vec3<f32>, filtered: bool) -> f32 {
  let count = i32(frame.sunColor.w);
  let depth = dot(world - frame.cameraPosition.xyz, frame.cameraForward.xyz);
  var start = frame.cameraPosition.w;
  for (var i = 0; i < count; i++) {
    let end = frame.cascadeSplits[i];
    if (depth < end) {
      let s = cascadeShadow(i, world, n, filtered);
      let band = (end - start) * 0.1;
      if (depth > end - band) {
        let t = (depth - (end - band)) / band;
        if (i + 1 < count) { return mix(s, cascadeShadow(i + 1, world, n, filtered), t); }
        return mix(s, 1.0, t);
      }
      return s;
    }
    start = end;
  }
  return 1.0;
}
`;

export const WGSL_LIGHTING = `
struct Layers {
  coat: f32,
  coatRoughness: f32,
  scatter: f32,
  scatterColor: vec3<f32>,
  specular: vec3<f32>,
};

fn noLayers(n: vec3<f32>) -> Layers {
  return Layers(0.0, 0.0, 0.0, vec3<f32>(0.0), n);
}

// Light units (as the old renderer's): a light's colour × intensity is radiance; Lambert diffuse is albedo / PI, so a
// white surface facing an intensity-1 light reflects 1/PI. Ambient light is irradiance already (albedo × ambient, no PI).
fn brdf(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, radiance: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32, layers: Layers) -> vec3<f32> {
  let facing = dot(n, l);
  var nl = max(facing, 0.0);
  var scattered = vec3<f32>(0.0);
  if (layers.scatter > 0.0) {
    let wrap = clamp((facing + 0.5) / 1.5, 0.0, 1.0);
    scattered = layers.scatterColor * layers.scatter * max(wrap - nl, 0.0) * (1.0 - metallic) * radiance / PI;
  }
  if (nl <= 0.0) { return scattered; }
  if (frame.style.x > 0.5) { nl = floor(nl * frame.style.x + 0.5) / frame.style.x; }
  let h = normalize(v + l);
  let nv = max(dot(layers.specular, v), 1e-4);
  let nh = max(dot(layers.specular, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let a = max(roughness * roughness, 0.002);
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let d = a2 / (PI * dd * dd);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let g = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
  let f0 = mix(vec3<f32>(0.04), albedo, metallic);
  let f = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vh, 5.0);
  let spec = d * g * f / max(4.0 * nv * nl, 1e-4);
  let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);
  var color = (kd * albedo / PI + spec) * radiance * nl;
  if (layers.coat > 0.0) {
    let ca = max(layers.coatRoughness * layers.coatRoughness, 0.002);
    let cdd = nh * nh * (ca * ca - 1.0) + 1.0;
    let fc = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
    let coatSpec = ca * ca / (PI * cdd * cdd) * fc / max(4.0 * vh * vh, 1e-4);
    color = color * (1.0 - layers.coat * fc) + vec3<f32>(coatSpec * layers.coat) * radiance * nl;
  }
  return color + scattered;
}

fn localShadow(tile: i32, kind: f32, lightPos: vec3<f32>, world: vec3<f32>, n: vec3<f32>) -> f32 {
  let d = world - lightPos;
  var face = 0;
  if (kind < 1.5) {
    let a = abs(d);
    if (a.x >= a.y && a.x >= a.z) {
      face = select(1, 0, d.x > 0.0);
    } else if (a.y >= a.z) {
      face = select(3, 2, d.y > 0.0);
    } else {
      face = select(5, 4, d.z > 0.0);
    }
  }
  let t = tile + face;
  let cols = frame.shadowParams.z;
  let texel = frame.shadowParams.w;
  let offset = length(d) * 3.0 * texel * cols;
  let p = shadowTiles.tiles[t] * vec4<f32>(world + n * offset, 1.0);
  if (p.w <= 0.0) { return 1.0; }
  let ndc = p.xyz / p.w;
  let local = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0 || ndc.z > 1.0 || ndc.z < 0.0) { return 1.0; }
  let margin = 1.5 * texel * cols;
  let cell = vec2<f32>(f32(t % i32(cols)), f32(t / i32(cols)));
  let uv = (cell + clamp(local, vec2<f32>(margin), vec2<f32>(1.0 - margin))) / cols;
  return shadowTap(localAtlas, uv, ndc.z - 0.0005, texel, frame.style.w > 1.5);
}

fn lightTexel(i: i32, k: i32) -> vec4<f32> {
  return textureLoad(lightData, vec2<i32>((i % ${LIGHTS_PER_ROW}) * 4 + k, i / ${LIGHTS_PER_ROW}), 0);
}

fn shadeLight(i: i32, world: vec3<f32>, n: vec3<f32>, v: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32, layers: Layers) -> vec3<f32> {
  let pr = lightTexel(i, 0);
  let reach = pr.xyz - world;
  if (i >= i32(frame.clusterDepth.z) && dot(reach, reach) >= pr.w * pr.w) { return vec3<f32>(0.0); }
  let ck = lightTexel(i, 1);
  let dc = lightTexel(i, 2);
  let st = lightTexel(i, 3);
  var l = -dc.xyz;
  var atten = 1.0;
  if (ck.w > 0.5) {
    let toLight = pr.xyz - world;
    let dist = length(toLight);
    l = toLight / max(dist, 1e-4);
    let ratio = dist / max(pr.w, 1e-4);
    let fade = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
    atten = fade * fade / (dist * dist + 1.0);
    if (ck.w > 1.5) {
      atten *= smoothstep(dc.w, st.y, dot(-l, dc.xyz));
    }
    if (atten <= 0.0) { return vec3<f32>(0.0); }
    if (st.x >= 0.0) {
      atten *= localShadow(i32(st.x), ck.w, pr.xyz, world, n);
    }
  }
  return brdf(n, v, l, ck.rgb * atten, albedo, metallic, roughness, layers);
}

fn clusterOf(pixel: vec2<f32>, depth: f32) -> vec2<u32> {
  let dims = frame.clusterParams.xyz;
  let local = (pixel - frame.viewport.xy) / frame.viewport.zw;
  let cx = clamp(i32(local.x * dims.x), 0, i32(dims.x) - 1);
  let cy = clamp(i32(local.y * dims.y), 0, i32(dims.y) - 1);
  let cz = clamp(i32(floor(log(max(depth, 1e-4)) * frame.clusterDepth.x + frame.clusterDepth.y)), 0, i32(dims.z) - 1);
  let index = i32(frame.clusterParams.w) + (cz * i32(dims.y) + cy) * i32(dims.x) + cx;
  return textureLoad(clusterGrid, vec2<i32>(index % ${DATA_ROW}, index / ${DATA_ROW}), 0).xy;
}

fn shIrradiance(n: vec3<f32>) -> f32 {
  let x = n.x;
  let y = n.y;
  let z = n.z;
  return frame.sh0.x * 0.282095
    + frame.sh0.y * 0.488603 * y + frame.sh0.z * 0.488603 * z + frame.sh0.w * 0.488603 * x
    + frame.sh1.x * 1.092548 * x * y + frame.sh1.y * 1.092548 * y * z + frame.sh1.z * 0.315392 * (3.0 * z * z - 1.0)
    + frame.sh1.w * 1.092548 * x * z + frame.sh2.x * 0.546274 * (x * x - y * y);
}

fn envBrdf(f0: vec3<f32>, roughness: f32, nv: f32) -> vec3<f32> {
  let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  let ab = vec2<f32>(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

fn lighting(world: vec3<f32>, n: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32, occlusion: f32, pixel: vec2<f32>, layers: Layers) -> vec4<f32> {
  let v = normalize(frame.cameraPosition.xyz - world);
  let nv = max(dot(layers.specular, v), 1e-4);
  let f0 = mix(vec3<f32>(0.04), albedo, metallic);
  let diffuse = frame.ambient.rgb * max(shIrradiance(n), 0.0) * (albedo * (1.0 - metallic) + layers.scatterColor * layers.scatter * 0.25);
  let env = textureSampleLevel(envCube, envSampler, reflect(-v, layers.specular), roughness * frame.sh2.y).rgb * frame.ambient.w;
  var ambientLight = diffuse + env * envBrdf(f0, roughness, nv);
  if (layers.coat > 0.0) {
    let fc = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 1e-4), 5.0);
    let coatEnv = textureSampleLevel(envCube, envSampler, reflect(-v, n), layers.coatRoughness * frame.sh2.y).rgb * frame.ambient.w;
    ambientLight = ambientLight * (1.0 - layers.coat * fc) + coatEnv * fc * layers.coat;
  }
  ambientLight *= occlusion;
  var direct = vec3<f32>(0.0);
  if (frame.sunDirection.w > 0.5) {
    direct += brdf(n, v, -frame.sunDirection.xyz, frame.sunColor.rgb, albedo, metallic, roughness, layers) * sunShadow(world, n, frame.style.w > 1.5);
  }
  let directional = i32(frame.clusterDepth.z);
  for (var i = 0; i < directional; i++) {
    direct += shadeLight(i, world, n, v, albedo, metallic, roughness, layers);
  }
  let cell = clusterOf(pixel, dot(world - frame.cameraPosition.xyz, frame.cameraForward.xyz));
  for (var k = 0u; k < cell.y; k++) {
    let item = cell.x + k;
    let index = i32(textureLoad(clusterItems, vec2<i32>(i32(item % ${DATA_ROW}u), i32(item / ${DATA_ROW}u)), 0).x);
    direct += shadeLight(index, world, n, v, albedo, metallic, roughness, layers);
  }
  let total = ambientLight + direct;
  return vec4<f32>(total, luminance(ambientLight) / max(luminance(total), 1e-4));
}

fn perturb(n: vec3<f32>, dpx: vec3<f32>, dpy: vec3<f32>, duvx: vec2<f32>, duvy: vec2<f32>, m: vec3<f32>) -> vec3<f32> {
  let dpyPerp = cross(dpy, n);
  let dpxPerp = cross(n, dpx);
  let t = dpyPerp * duvx.x + dpxPerp * duvy.x;
  let b = dpyPerp * duvx.y + dpxPerp * duvy.y;
  let s = select(-1.0, 1.0, dot(cross(dpx, dpy), n) >= 0.0) * inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
  return normalize(t * (m.x * s) - b * (m.y * s) + n * m.z);
}

fn anisotropic(n: vec3<f32>, v: vec3<f32>, dpx: vec3<f32>, dpy: vec3<f32>, duvx: vec2<f32>, duvy: vec2<f32>, amount: f32, rotation: f32, roughness: f32) -> vec3<f32> {
  let dpyPerp = cross(dpy, n);
  let dpxPerp = cross(n, dpx);
  let tu = dpyPerp * duvx.x + dpxPerp * duvy.x;
  let tv = dpyPerp * duvx.y + dpxPerp * duvy.y;
  let grain = tu * cos(rotation) - tv * sin(rotation);
  if (dot(grain, grain) < 1e-20) { return n; }
  let t = normalize(grain - n * dot(grain, n));
  let along = select(t, cross(n, t), amount < 0.0);
  let bent = cross(cross(along, v), along);
  return normalize(mix(n, bent, abs(amount) * clamp(roughness * 4.0, 0.0, 1.0)));
}
`;

const wgslInstanceInputs = `  @location(${L.model0}) m0: vec4<f32>,
  @location(${L.model1}) m1: vec4<f32>,
  @location(${L.model2}) m2: vec4<f32>,
  @location(${L.model3}) m3: vec4<f32>,
  @location(${L.normal0}) n0: vec4<f32>,
  @location(${L.normal1}) n1: vec4<f32>,
  @location(${L.normal2}) n2: vec4<f32>,
  @location(${L.tint}) tint: vec4<f32>,`;

const wgslSkinInputs = `  @location(${L.joints}) joints: vec4<u32>,
  @location(${L.weights}) weights: vec4<f32>,`;

const WGSL_SKIN = `
fn skinMatrix(base: u32, joints: vec4<u32>, weights: vec4<f32>) -> mat4x4<f32> {
  return palette[base + joints.x] * weights.x + palette[base + joints.y] * weights.y
    + palette[base + joints.z] * weights.z + palette[base + joints.w] * weights.w;
}
`;

const wgslOutputs = (mrt: boolean): string => `
struct FragOut {
  @location(0) color: vec4<f32>,
${mrt ? '  @location(1) surface: vec4<f32>,' : ''}
};
`;

/** Shadow casters: depth only, through the tile's light view-projection. */
function wgslCaster(skinned: boolean): string {
  return `${wgslStruct('Caster', CASTER_FIELDS)}
@group(0) @binding(0) var<uniform> caster: Caster;
@group(0) @binding(1) var<storage, read> palette: array<mat4x4<f32>>;
${skinned ? WGSL_SKIN : ''}
struct VertexIn {
  @location(${L.position}) position: vec3<f32>,
${skinned ? wgslSkinInputs : ''}
${wgslInstanceInputs}
};

@vertex fn vs(v: VertexIn) -> @builtin(position) vec4<f32> {
  let model = mat4x4<f32>(v.m0, v.m1, v.m2, v.m3);
  var local = vec4<f32>(v.position, 1.0);
${skinned ? '  local = skinMatrix(u32(v.n0.w), v.joints, v.weights) * local;' : ''}
  return caster.lightViewProjection * (model * local);
}
`;
}

/** Outlined entities' silhouettes into the outline mask: rgb color, a = width + fill. */
function wgslOutline(skinned: boolean): string {
  return `${WGSL_FRAME}${skinned ? WGSL_SKIN : ''}
${wgslStruct('Outline', OUTLINE_FIELDS)}
@group(1) @binding(0) var<uniform> outlineData: Outline;

struct VertexIn {
  @location(${L.position}) position: vec3<f32>,
${skinned ? wgslSkinInputs : ''}
${wgslInstanceInputs}
};

@vertex fn vs(v: VertexIn) -> @builtin(position) vec4<f32> {
  let model = mat4x4<f32>(v.m0, v.m1, v.m2, v.m3);
  var local = vec4<f32>(v.position, 1.0);
${skinned ? '  local = skinMatrix(u32(v.n0.w), v.joints, v.weights) * local;' : ''}
  return frame.viewProjection * (model * local);
}

@fragment fn fs() -> @location(0) vec4<f32> {
  return outlineData.outline;
}
`;
}

function wgslSky(mrt: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}${wgslOutputs(mrt)}
@group(1) @binding(0) var skyImage: texture_2d<f32>;
@group(1) @binding(1) var skyImageSampler: sampler;

/** The skybox panorama's light toward dir (equirectangular; frame.skybox: turn, intensity). Level 0: no seam where u wraps. */
fn skyboxToward(dir: vec3<f32>) -> vec3<f32> {
  let u = fract(atan2(dir.x, dir.z) * 0.15915494 + 0.5 - frame.skybox.x);
  let v = acos(clamp(dir.y, -1.0, 1.0)) * 0.31830989;
  return textureSampleLevel(skyImage, skyImageSampler, vec2<f32>(u, v), 0.0).rgb * frame.skybox.y;
}

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VertexOut;
  out.clip = vec4<f32>(corners[index], 1.0, 1.0);
  out.ndc = corners[index];
  return out;
}

@fragment fn fs(in: VertexOut) -> FragOut {
  var out: FragOut;
${mrt ? '  out.surface = vec4<f32>(0.0, 0.0, 1.0, 0.0);' : ''}
  let far = frame.inverseViewProjection * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - frame.cameraPosition.xyz);
  if (frame.skybox.z > 0.5) {
    out.color = vec4<f32>(skyFog(dir, skyboxToward(dir)), 0.0);
    return out;
  }
  // The same color the surfaces fade into at the far plane (applyFog's viewFadeTo).
  out.color = vec4<f32>(skyBeyond(dir), 0.0);
  return out;
}
`;
}

function wgslMesh(skinned: boolean, mrt: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}${WGSL_SHADOWS}${WGSL_LIGHTING}${skinned ? WGSL_SKIN : ''}${wgslOutputs(mrt)}
${wgslStruct('Material', MATERIAL_FIELDS)}
@group(1) @binding(0) var<uniform> material: Material;
${WGSL_FOLIAGE_SWAY}
@group(1) @binding(1) var baseTexture: texture_2d<f32>;
@group(1) @binding(2) var baseSampler: sampler;
@group(1) @binding(3) var surfaceTexture: texture_2d<f32>;
@group(1) @binding(4) var surfaceSampler: sampler;
@group(1) @binding(5) var emissiveTexture: texture_2d<f32>;
@group(1) @binding(6) var emissiveSampler: sampler;
@group(1) @binding(7) var normalTexture: texture_2d<f32>;
@group(1) @binding(8) var normalSampler: sampler;
@group(1) @binding(9) var occlusionTexture: texture_2d<f32>;
@group(1) @binding(10) var occlusionSampler: sampler;
${WGSL_MATERIAL_FX}

struct VertexIn {
  @location(${L.position}) position: vec3<f32>,
  @location(${L.normal}) normal: vec3<f32>,
  @location(${L.uv}) uv: vec2<f32>,
  @location(${L.color}) color: vec4<f32>,
${skinned ? wgslSkinInputs : ''}
${wgslInstanceInputs}
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(4) @interpolate(flat) fade: f32,
  @location(5) local: vec3<f32>,
};

@vertex fn vs(v: VertexIn) -> VertexOut {
  let model = mat4x4<f32>(v.m0, v.m1, v.m2, v.m3);
  let normalMatrix = mat3x3<f32>(v.n0.xyz, v.n1.xyz, v.n2.xyz);
  var local = vec4<f32>(v.position, 1.0);
  var n = v.normal;
${skinned ? `  let skin = skinMatrix(u32(v.n0.w), v.joints, v.weights);
  local = skin * local;
  n = (skin * vec4<f32>(n, 0.0)).xyz;` : ''}
  var world = model * local;
  world = vec4<f32>(world.xyz + foliageSway(model, local.xyz, world.xyz), 1.0);
  var out: VertexOut;
  out.clip = frame.viewProjection * world;
  out.world = world.xyz;
  out.normal = normalMatrix * n;
  out.uv = v.uv;
  out.color = v.color * v.tint;
  out.fade = v.n1.w;
  out.local = local.xyz * ${WGSL_INSTANCE_SCALE};
  return out;
}

@fragment fn fs(in: VertexOut, @builtin(front_facing) front: bool) -> FragOut {
  if (lodDiscard(in.fade, in.clip.xy)) { discard; }
  let dpx = dpdx(in.world);
  let dpy = dpdy(in.world);
  let tiled = in.uv * material.grain.yz;
  let duvx = dpdx(tiled);
  let duvy = dpdy(tiled);
  let uv = fxUvOf(tiled);
  var baseUv = uv;
  if (material.extra.x > 0.5) { baseUv = (in.clip.xy - frame.viewport.xy) / frame.viewport.zw; }
  var base = material.baseColor * in.color * textureSample(baseTexture, baseSampler, baseUv);
  if (material.fxUv.z > 0.0) { base = material.baseColor * in.color * fxTriplanar(baseTexture, baseSampler, in.world, normalize(in.normal), dpx, dpy); }
  let surface = textureSample(surfaceTexture, surfaceSampler, uv);
  let emissive = material.emissive.rgb * textureSample(emissiveTexture, emissiveSampler, uv).rgb;
  let mapped = textureSample(normalTexture, normalSampler, uv).xyz * 2.0 - vec3<f32>(1.0);
  let occlusionMap = textureSample(occlusionTexture, occlusionSampler, uv).r;
  if (material.surface.z > 0.5 && material.surface.z < 1.5 && base.a < material.emissive.w) { discard; }
  let cut = fxDissolveCut(in.local);
  if (cut < 0.0) { discard; }
  var out: FragOut;
  if (frame.style.y > 0.5) {
    out.color = vec4<f32>(mix(base.rgb, frame.wireColor.rgb, frame.wireColor.w), select(0.0, base.a, material.surface.z > 1.5));
${mrt ? '    out.surface = vec4<f32>(0.0, 0.0, 1.0, 0.0);' : ''}
    return out;
  }
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  if (material.maps.z > 0.5) {
    n = perturb(n, dpx, dpy, duvx, duvy, vec3<f32>(mapped.xy * material.maps.x, mapped.z));
  }
  let metallic = material.surface.x * surface.b;
  let roughness = clamp(material.surface.y * surface.g, 0.04, 1.0);
  let occlusion = mix(1.0, occlusionMap, material.maps.y * material.maps.w);
  let v = normalize(frame.cameraPosition.xyz - in.world);
  var layers = noLayers(n);
  layers.coat = material.coat.x;
  layers.coatRoughness = clamp(material.coat.y, 0.04, 1.0);
  layers.scatter = material.coat.w;
  layers.scatterColor = material.scatter.rgb;
  if (material.scatter.w != 0.0) {
    layers.specular = anisotropic(n, v, dpx, dpy, duvx, duvy, material.scatter.w, material.grain.x, roughness);
  }
  let transmission = material.coat.z;
  var lit = vec4<f32>(base.rgb, 0.0);
  if (material.surface.w < 0.5) {
    lit = lighting(in.world, n, base.rgb * (1.0 - transmission), metallic, roughness, occlusion, in.clip.xy, layers);
  }
  var alpha = select(lit.a, base.a, material.surface.z > 1.5);
  if (transmission > 0.0) {
    alpha = 1.0 - transmission * (1.0 - (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)));
  }
  let shaded = fxShade(lit.rgb + emissive, alpha, n, v, in.world, cut);
  out.color = vec4<f32>(applyFog(shaded.rgb, in.world), shaded.a);
${mrt ? '  out.surface = vec4<f32>(octEncode(n), roughness, select(luminance(mix(vec3<f32>(0.04), base.rgb, metallic)), 0.0, material.surface.w > 0.5));' : ''}
  return out;
}
`;
}

function wgslTerrain(mrt: boolean): string {
  return wgslTerrainPass(mrt, {
    frame: WGSL_FRAME, common: WGSL_COMMON, shadows: WGSL_SHADOWS, lighting: WGSL_LIGHTING, outputs: wgslOutputs(mrt), block: wgslStruct('Terrain', TERRAIN_FIELDS),
  });
}

function wgslBillboard(overlay: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var imageSampler: sampler;

struct InstanceIn {
  @location(0) centerAngle: vec4<f32>,
  @location(1) rightOffset: vec4<f32>,
  @location(2) upOffset: vec4<f32>,
  @location(3) sizeShape: vec4<f32>,
  @location(4) color: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) corner: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(4) shape: f32,
};

@vertex fn vs(@builtin(vertex_index) index: u32, b: InstanceIn) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
  let corner = corners[index];
  var right = frame.cameraRight.xyz;
  var up = frame.cameraUp.xyz;
  if (b.sizeShape.w > 0.5) {
    right = b.rightOffset.xyz;
    up = b.upOffset.xyz;
  }
  let a = radians(b.centerAngle.w);
  let q = corner * b.sizeShape.xy;
  let r = vec2<f32>(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a)) + vec2<f32>(b.rightOffset.w, b.upOffset.w);
  let world = b.centerAngle.xyz + right * r.x + up * r.y;
  var out: VertexOut;
  out.clip = frame.viewProjection * vec4<f32>(world, 1.0);
  out.world = world;
  out.uv = vec2<f32>(corner.x + 0.5, 0.5 - corner.y);
  out.corner = corner;
  out.color = b.color;
  out.shape = b.sizeShape.z;
  return out;
}

@fragment fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  var c = in.color * textureSample(image, imageSampler, in.uv);
  if (in.shape > 0.5) {
    c.a *= clamp((0.5 - length(in.corner)) * 16.0, 0.0, 1.0);
  }
  if (c.a <= 0.003) { discard; }
  return vec4<f32>(${overlay ? 'toDisplay(c.rgb)' : 'applyFog(c.rgb, in.world)'}, c.a);
}
`;
}

function wgslLine(overlay: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}
struct VertexIn {
  @location(0) startT: vec4<f32>,
  @location(1) endSide: vec4<f32>,
  @location(2) width: vec4<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex fn vs(v: VertexIn) -> VertexOut {
  let p = mix(v.startT.xyz, v.endSide.xyz, v.startT.w);
  var side = cross(v.endSide.xyz - v.startT.xyz, frame.cameraPosition.xyz - p);
  if (length(side) < 1e-6) { side = frame.cameraUp.xyz; }
  let world = p + normalize(side) * v.width.x * 0.5 * v.endSide.w;
  var out: VertexOut;
  out.clip = frame.viewProjection * vec4<f32>(world, 1.0);
  out.color = v.color;
  return out;
}

@fragment fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  return vec4<f32>(${overlay ? 'toDisplay(in.color.rgb)' : 'in.color.rgb'}, in.color.a);
}
`;
}

export function wgsl(pass: ScenePass, variant: SceneVariant = {}): string {
  const skinned = variant.skinned === true;
  const mrt = variant.mrt === true;
  const overlay = variant.overlay === true;
  switch (pass) {
    case 'caster': return wgslCaster(skinned);
    case 'sky': return wgslSky(mrt);
    case 'terrain': return wgslTerrain(mrt);
    case 'mesh': return wgslMesh(skinned, mrt);
    case 'billboard': return wgslBillboard(overlay);
    case 'line': return wgslLine(overlay);
    case 'outline': return wgslOutline(skinned);
  }
}

// ── GLSL ES 3.00 ──────────────────────────────────────────────────────────────

export interface GlslProgram {
  readonly vertex: string;
  readonly fragment: string;
}

export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp usampler2D;
precision highp samplerCube;
`;

export const GLSL_FRAME = `${glslBlock('Frame', FRAME_FIELDS)}${glslBlock('Shadows', SHADOW_FIELDS)}`;

/** Every GLSL vertex shader ends with this: clip depth 0..1 → -1..1. */
export const GLSL_DEPTH_REMAP = 'gl_Position.z = gl_Position.z * 2.0 - gl_Position.w;';

export const GLSL_COMMON = `
const float PI = 3.14159265;

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 toDisplay(vec3 c) {
  vec3 x = clamp(c, vec3(0.0), vec3(1.0));
  return mix(1.055 * pow(x, vec3(1.0 / 2.4)) - vec3(0.055), x * 12.92, vec3(lessThanEqual(x, vec3(0.0031308))));
}

vec2 octEncode(vec3 n) {
  vec2 p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z >= 0.0) return p;
  return (vec2(1.0) - abs(p.yx)) * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
}

vec3 octDecode(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

bool lodDiscard(float f, vec2 pixel) {
  if (f >= 0.999) return false;
  float n = fract(52.9829189 * fract(dot(floor(pixel), vec2(0.06711056, 0.00583715))));
  return f >= 0.0 ? n >= f : n < 1.0 + f;
}

vec3 skyColor(vec3 dir) {
  return mix(skyHorizon.rgb, skyZenith.rgb, sqrt(clamp(dir.y, 0.0, 1.0)));
}

vec3 sunGlare(float mu, float r) {
  float theta = sqrt(max(2.0 * (1.0 - mu), 0.0));
  float x = clamp(theta / r, 0.0, 1.0);
  float limb = 1.0 - 0.55 * (1.0 - sqrt(1.0 - x * x));
  float disc = (1.0 - smoothstep(0.82, 1.15, theta / r)) * limb * 48.0;
  float corona = exp(-theta / (r * 0.9)) * 3.5 + exp(-theta / (r * 3.5)) * 0.9;
  float aureole = exp(-theta / 0.09) * 0.35 + pow(max(mu, 0.0), 8.0) * 0.12;
  return vec3(disc, corona, aureole);
}

float fogAmount(vec3 dir, float dist) {
  float mode = fogColor.w;
  if (mode < 0.5) return 0.0;
  if (mode > 1.5) return clamp((dist - fogParams.y) / max(fogParams.z - fogParams.y, 1e-4), 0.0, 1.0);
  float falloff = fogHeight.x;
  float optical = fogParams.x * dist;
  if (falloff > 0.0) {
    optical *= exp(-falloff * (cameraPosition.y - fogHeight.y));
    float rise = falloff * dir.y * dist;
    if (abs(rise) > 1e-4) optical *= (1.0 - exp(-rise)) / rise;
  }
  return 1.0 - exp(-max(optical, 0.0));
}

vec3 skyFog(vec3 dir, vec3 c) {
  if (fogColor.w < 0.5) return c;
  float f = fogHeight.z * (1.0 - smoothstep(-0.02, 0.3, dir.y));
  if (fogColor.w < 1.5 && fogHeight.x > 0.0) f = fogAmount(dir, cameraForward.w);
  return mix(c, fogColor.rgb, f);
}

vec3 skyBeyond(vec3 dir) {
  if (skybox.z > 0.5) return skyFog(dir, viewFadeColor.rgb);
  if (skyZenith.w < 0.5) return skyZenith.rgb;
  vec3 c = skyColor(dir);
  if (sunDirection.w > 0.5) {
    vec3 glare = sunGlare(dot(dir, -sunDirection.xyz), ${SUN_DISC_RADIUS.toFixed(4)});
    float up = smoothstep(-0.01, 0.01, dir.y);
    c += sunColor.rgb * (glare.x * up + glare.y + glare.z);
  }
  return skyFog(dir, c);
}

vec3 viewFadeTo(vec3 color, vec3 dir, float dist) {
  if (viewFade.y <= 0.0 || viewFade.z > 0.5) return color;
  float t = clamp((dist - viewFade.x) / max(viewFade.y - viewFade.x, 1e-4), 0.0, 1.0);
  if (t <= 0.0) return color;
  return mix(color, skyBeyond(dir), t);
}

vec3 applyFog(vec3 color, vec3 world) {
  float dist = distance(world, cameraPosition.xyz);
  vec3 dir = (world - cameraPosition.xyz) / max(dist, 1e-4);
  if (fogColor.w < 0.5) return viewFadeTo(color, dir, dist);
  return viewFadeTo(mix(color, fogColor.rgb, fogAmount(dir, dist)), dir, dist);
}
`;

export const GLSL_SHADOWS = `
uniform sampler2DShadow sunAtlas;
uniform sampler2DShadow localAtlas;

float shadowTap(sampler2DShadow atlas, vec2 uv, float depth, float texel, bool filtered) {
  if (!filtered) return texture(atlas, vec3(uv, depth));
  float sum = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      sum += texture(atlas, vec3(uv + vec2(float(x), float(y)) * texel, depth));
    }
  }
  return sum / 9.0;
}

float cascadeShadow(int i, vec3 world, vec3 n, bool filtered) {
  vec4 p = cascades[i] * vec4(world + n * cascadeTexel[i] * 1.5, 1.0);
  vec3 ndc = p.xyz / p.w;
  vec2 local = vec2(ndc.x * 0.5 + 0.5, 0.5 + ndc.y * 0.5);
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0 || ndc.z > 1.0) return 1.0;
  float cols = shadowParams.x;
  float texel = shadowParams.y;
  float margin = 1.5 * texel * cols;
  vec2 cell = vec2(float(i % int(cols)), float(i / int(cols)));
  vec2 uv = (cell + clamp(local, vec2(margin), vec2(1.0 - margin))) / cols;
  return shadowTap(sunAtlas, uv, ndc.z - 0.0003, texel, filtered);
}

float sunShadow(vec3 world, vec3 n, bool filtered) {
  int count = int(sunColor.w);
  float depth = dot(world - cameraPosition.xyz, cameraForward.xyz);
  float start = cameraPosition.w;
  for (int i = 0; i < count; i++) {
    float end = cascadeSplits[i];
    if (depth < end) {
      float s = cascadeShadow(i, world, n, filtered);
      float band = (end - start) * 0.1;
      if (depth > end - band) {
        float t = (depth - (end - band)) / band;
        if (i + 1 < count) return mix(s, cascadeShadow(i + 1, world, n, filtered), t);
        return mix(s, 1.0, t);
      }
      return s;
    }
    start = end;
  }
  return 1.0;
}
`;

export const GLSL_LIGHTING = `
uniform sampler2D lightData;
uniform usampler2D clusterGrid;
uniform usampler2D clusterItems;
uniform samplerCube envCube;

struct Layers {
  float coat;
  float coatRoughness;
  float scatter;
  vec3 scatterColor;
  vec3 specular;
};

Layers noLayers(vec3 n) {
  return Layers(0.0, 0.0, 0.0, vec3(0.0), n);
}

// Light units (as the old renderer's): a light's colour × intensity is radiance; Lambert diffuse is albedo / PI, so a
// white surface facing an intensity-1 light reflects 1/PI. Ambient light is irradiance already (albedo × ambient, no PI).
vec3 brdf(vec3 n, vec3 v, vec3 l, vec3 radiance, vec3 albedo, float metallic, float roughness, Layers layers) {
  float facing = dot(n, l);
  float nl = max(facing, 0.0);
  vec3 scattered = vec3(0.0);
  if (layers.scatter > 0.0) {
    float wrap = clamp((facing + 0.5) / 1.5, 0.0, 1.0);
    scattered = layers.scatterColor * layers.scatter * max(wrap - nl, 0.0) * (1.0 - metallic) * radiance / PI;
  }
  if (nl <= 0.0) return scattered;
  if (style.x > 0.5) nl = floor(nl * style.x + 0.5) / style.x;
  vec3 h = normalize(v + l);
  float nv = max(dot(layers.specular, v), 1e-4);
  float nh = max(dot(layers.specular, h), 0.0);
  float vh = max(dot(v, h), 0.0);
  float a = max(roughness * roughness, 0.002);
  float a2 = a * a;
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float d = a2 / (PI * dd * dd);
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  float g = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 f = f0 + (vec3(1.0) - f0) * pow(1.0 - vh, 5.0);
  vec3 spec = d * g * f / max(4.0 * nv * nl, 1e-4);
  vec3 kd = (vec3(1.0) - f) * (1.0 - metallic);
  vec3 color = (kd * albedo / PI + spec) * radiance * nl;
  if (layers.coat > 0.0) {
    float ca = max(layers.coatRoughness * layers.coatRoughness, 0.002);
    float cdd = nh * nh * (ca * ca - 1.0) + 1.0;
    float fc = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
    float coatSpec = ca * ca / (PI * cdd * cdd) * fc / max(4.0 * vh * vh, 1e-4);
    color = color * (1.0 - layers.coat * fc) + vec3(coatSpec * layers.coat) * radiance * nl;
  }
  return color + scattered;
}

float localShadow(int tile, float kind, vec3 lightPos, vec3 world, vec3 n) {
  vec3 d = world - lightPos;
  int face = 0;
  if (kind < 1.5) {
    vec3 a = abs(d);
    if (a.x >= a.y && a.x >= a.z) {
      face = d.x > 0.0 ? 0 : 1;
    } else if (a.y >= a.z) {
      face = d.y > 0.0 ? 2 : 3;
    } else {
      face = d.z > 0.0 ? 4 : 5;
    }
  }
  int t = tile + face;
  float cols = shadowParams.z;
  float texel = shadowParams.w;
  float offset = length(d) * 3.0 * texel * cols;
  vec4 p = tiles[t] * vec4(world + n * offset, 1.0);
  if (p.w <= 0.0) return 1.0;
  vec3 ndc = p.xyz / p.w;
  vec2 local = vec2(ndc.x * 0.5 + 0.5, 0.5 + ndc.y * 0.5);
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0 || ndc.z > 1.0 || ndc.z < 0.0) return 1.0;
  float margin = 1.5 * texel * cols;
  vec2 cell = vec2(float(t % int(cols)), float(t / int(cols)));
  vec2 uv = (cell + clamp(local, vec2(margin), vec2(1.0 - margin))) / cols;
  return shadowTap(localAtlas, uv, ndc.z - 0.0005, texel, style.w > 1.5);
}

vec4 lightTexel(int i, int k) {
  return texelFetch(lightData, ivec2((i % ${LIGHTS_PER_ROW}) * 4 + k, i / ${LIGHTS_PER_ROW}), 0);
}

vec3 shadeLight(int i, vec3 world, vec3 n, vec3 v, vec3 albedo, float metallic, float roughness, Layers layers) {
  vec4 pr = lightTexel(i, 0);
  vec3 reach = pr.xyz - world;
  if (i >= int(clusterDepth.z) && dot(reach, reach) >= pr.w * pr.w) return vec3(0.0);
  vec4 ck = lightTexel(i, 1);
  vec4 dc = lightTexel(i, 2);
  vec4 st = lightTexel(i, 3);
  vec3 l = -dc.xyz;
  float atten = 1.0;
  if (ck.w > 0.5) {
    vec3 toLight = pr.xyz - world;
    float dist = length(toLight);
    l = toLight / max(dist, 1e-4);
    float ratio = dist / max(pr.w, 1e-4);
    float fade = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
    atten = fade * fade / (dist * dist + 1.0);
    if (ck.w > 1.5) {
      atten *= smoothstep(dc.w, st.y, dot(-l, dc.xyz));
    }
    if (atten <= 0.0) return vec3(0.0);
    if (st.x >= 0.0) {
      atten *= localShadow(int(st.x), ck.w, pr.xyz, world, n);
    }
  }
  return brdf(n, v, l, ck.rgb * atten, albedo, metallic, roughness, layers);
}

uvec2 clusterOf(vec2 pixel, float depth) {
  vec3 dims = clusterParams.xyz;
  vec2 local = (pixel - viewport.xy) / viewport.zw;
  int cx = clamp(int(local.x * dims.x), 0, int(dims.x) - 1);
  int cy = clamp(int(local.y * dims.y), 0, int(dims.y) - 1);
  int cz = clamp(int(floor(log(max(depth, 1e-4)) * clusterDepth.x + clusterDepth.y)), 0, int(dims.z) - 1);
  int index = int(clusterParams.w) + (cz * int(dims.y) + cy) * int(dims.x) + cx;
  return texelFetch(clusterGrid, ivec2(index % ${DATA_ROW}, index / ${DATA_ROW}), 0).xy;
}

float shIrradiance(vec3 n) {
  float x = n.x;
  float y = n.y;
  float z = n.z;
  return sh0.x * 0.282095
    + sh0.y * 0.488603 * y + sh0.z * 0.488603 * z + sh0.w * 0.488603 * x
    + sh1.x * 1.092548 * x * y + sh1.y * 1.092548 * y * z + sh1.z * 0.315392 * (3.0 * z * z - 1.0)
    + sh1.w * 1.092548 * x * z + sh2.x * 0.546274 * (x * x - y * y);
}

vec3 envBrdf(vec3 f0, float roughness, float nv) {
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

vec4 lighting(vec3 world, vec3 n, vec3 albedo, float metallic, float roughness, float occlusion, vec2 pixel, Layers layers) {
  vec3 v = normalize(cameraPosition.xyz - world);
  float nv = max(dot(layers.specular, v), 1e-4);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 diffuse = ambient.rgb * max(shIrradiance(n), 0.0) * (albedo * (1.0 - metallic) + layers.scatterColor * layers.scatter * 0.25);
  vec3 env = textureLod(envCube, reflect(-v, layers.specular), roughness * sh2.y).rgb * ambient.w;
  vec3 ambientLight = diffuse + env * envBrdf(f0, roughness, nv);
  if (layers.coat > 0.0) {
    float fc = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 1e-4), 5.0);
    vec3 coatEnv = textureLod(envCube, reflect(-v, n), layers.coatRoughness * sh2.y).rgb * ambient.w;
    ambientLight = ambientLight * (1.0 - layers.coat * fc) + coatEnv * fc * layers.coat;
  }
  ambientLight *= occlusion;
  vec3 direct = vec3(0.0);
  if (sunDirection.w > 0.5) {
    direct += brdf(n, v, -sunDirection.xyz, sunColor.rgb, albedo, metallic, roughness, layers) * sunShadow(world, n, style.w > 1.5);
  }
  int directional = int(clusterDepth.z);
  for (int i = 0; i < directional; i++) {
    direct += shadeLight(i, world, n, v, albedo, metallic, roughness, layers);
  }
  uvec2 cell = clusterOf(pixel, dot(world - cameraPosition.xyz, cameraForward.xyz));
  for (uint k = 0u; k < cell.y; k++) {
    uint item = cell.x + k;
    int index = int(texelFetch(clusterItems, ivec2(int(item % ${DATA_ROW}u), int(item / ${DATA_ROW}u)), 0).x);
    direct += shadeLight(index, world, n, v, albedo, metallic, roughness, layers);
  }
  vec3 total = ambientLight + direct;
  return vec4(total, luminance(ambientLight) / max(luminance(total), 1e-4));
}

vec3 perturb(vec3 n, vec3 dpx, vec3 dpy, vec2 duvx, vec2 duvy, vec3 m) {
  vec3 dpyPerp = cross(dpy, n);
  vec3 dpxPerp = cross(n, dpx);
  vec3 t = dpyPerp * duvx.x + dpxPerp * duvy.x;
  vec3 b = dpyPerp * duvx.y + dpxPerp * duvy.y;
  float s = (dot(cross(dpx, dpy), n) >= 0.0 ? 1.0 : -1.0) * inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
  return normalize(t * (m.x * s) - b * (m.y * s) + n * m.z);
}

vec3 anisotropic(vec3 n, vec3 v, vec3 dpx, vec3 dpy, vec2 duvx, vec2 duvy, float amount, float rotation, float roughness) {
  vec3 dpyPerp = cross(dpy, n);
  vec3 dpxPerp = cross(n, dpx);
  vec3 tu = dpyPerp * duvx.x + dpxPerp * duvy.x;
  vec3 tv = dpyPerp * duvx.y + dpxPerp * duvy.y;
  vec3 grain = tu * cos(rotation) - tv * sin(rotation);
  if (dot(grain, grain) < 1e-20) return n;
  vec3 t = normalize(grain - n * dot(grain, n));
  vec3 along = amount < 0.0 ? cross(n, t) : t;
  vec3 bent = cross(cross(along, v), along);
  return normalize(mix(n, bent, abs(amount) * clamp(roughness * 4.0, 0.0, 1.0)));
}
`;

/** The top-left pixel of the fragment (WGSL's `position.xy`). */
export const GLSL_PIXEL = 'vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y)';

const glslInstanceInputs = `layout(location = ${L.model0}) in vec4 m0;
layout(location = ${L.model1}) in vec4 m1;
layout(location = ${L.model2}) in vec4 m2;
layout(location = ${L.model3}) in vec4 m3;
layout(location = ${L.normal0}) in vec4 n0;
layout(location = ${L.normal1}) in vec4 n1;
layout(location = ${L.normal2}) in vec4 n2;
layout(location = ${L.tint}) in vec4 tint;
`;

const GLSL_SKIN = `layout(location = ${L.joints}) in uvec4 joints;
layout(location = ${L.weights}) in vec4 weights;
uniform sampler2D paletteTexture;

mat4 joint(int index) {
  int t = index * 4;
  int w = ${PALETTE_ROW_JOINTS * 4};
  return mat4(
    texelFetch(paletteTexture, ivec2(t % w, t / w), 0),
    texelFetch(paletteTexture, ivec2((t + 1) % w, (t + 1) / w), 0),
    texelFetch(paletteTexture, ivec2((t + 2) % w, (t + 2) / w), 0),
    texelFetch(paletteTexture, ivec2((t + 3) % w, (t + 3) / w), 0));
}

mat4 skinMatrix(int base) {
  return joint(base + int(joints.x)) * weights.x + joint(base + int(joints.y)) * weights.y
    + joint(base + int(joints.z)) * weights.z + joint(base + int(joints.w)) * weights.w;
}
`;

const glslOutputs = (mrt: boolean): string => `layout(location = 0) out vec4 fragColor;
${mrt ? 'layout(location = 1) out vec4 fragSurface;\n' : ''}`;

function glslCaster(skinned: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${glslBlock('Caster', CASTER_FIELDS)}
layout(location = ${L.position}) in vec3 position;
${glslInstanceInputs}${skinned ? GLSL_SKIN : ''}
void main() {
  mat4 model = mat4(m0, m1, m2, m3);
  vec4 local = vec4(position, 1.0);
${skinned ? '  local = skinMatrix(int(n0.w)) * local;' : ''}
  gl_Position = lightViewProjection * (model * local);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}
void main() {}
`,
  };
}

function glslOutline(skinned: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
layout(location = ${L.position}) in vec3 position;
${glslInstanceInputs}${skinned ? GLSL_SKIN : ''}
void main() {
  mat4 model = mat4(m0, m1, m2, m3);
  vec4 local = vec4(position, 1.0);
${skinned ? '  local = skinMatrix(int(n0.w)) * local;' : ''}
  gl_Position = viewProjection * (model * local);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${glslBlock('Outline', OUTLINE_FIELDS)}
out vec4 fragColor;
void main() {
  fragColor = outline;
}
`,
  };
}

function glslSky(mrt: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
out vec2 vNdc;
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vNdc = corners[gl_VertexID];
  gl_Position = vec4(vNdc, 1.0, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${GLSL_COMMON}
uniform sampler2D skyImage;

vec3 skyboxToward(vec3 dir) {
  float u = fract(atan(dir.x, dir.z) * 0.15915494 + 0.5 - skybox.x);
  float v = acos(clamp(dir.y, -1.0, 1.0)) * 0.31830989;
  return textureLod(skyImage, vec2(u, v), 0.0).rgb * skybox.y;
}

in vec2 vNdc;
${glslOutputs(mrt)}
void main() {
${mrt ? '  fragSurface = vec4(0.0, 0.0, 1.0, 0.0);' : ''}
  vec4 far = inverseViewProjection * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - cameraPosition.xyz);
  if (skybox.z > 0.5) {
    fragColor = vec4(skyFog(dir, skyboxToward(dir)), 0.0);
    return;
  }
  fragColor = vec4(skyBeyond(dir), 0.0);
}
`,
  };
}

function glslMesh(skinned: boolean, mrt: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}${glslBlock('Material', MATERIAL_FIELDS)}${GLSL_FOLIAGE_SWAY}
layout(location = ${L.position}) in vec3 position;
layout(location = ${L.normal}) in vec3 normal;
layout(location = ${L.uv}) in vec2 uv;
layout(location = ${L.color}) in vec4 color;
${glslInstanceInputs}${skinned ? GLSL_SKIN : ''}
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec4 vColor;
flat out float vFade;
out vec3 vLocal;
void main() {
  mat4 model = mat4(m0, m1, m2, m3);
  mat3 normalMatrix = mat3(n0.xyz, n1.xyz, n2.xyz);
  vec4 local = vec4(position, 1.0);
  vec3 n = normal;
${skinned ? `  mat4 skin = skinMatrix(int(n0.w));
  local = skin * local;
  n = (skin * vec4(n, 0.0)).xyz;` : ''}
  vec4 world = model * local;
  world.xyz += foliageSway(model, local.xyz, world.xyz);
  vWorld = world.xyz;
  vNormal = normalMatrix * n;
  vUv = uv;
  vColor = color * tint;
  vFade = n1.w;
  vLocal = local.xyz * ${GLSL_INSTANCE_SCALE};
  gl_Position = viewProjection * world;
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${glslBlock('Material', MATERIAL_FIELDS)}${GLSL_COMMON}${GLSL_SHADOWS}${GLSL_LIGHTING}
uniform sampler2D baseTexture;
uniform sampler2D surfaceTexture;
uniform sampler2D emissiveTexture;
uniform sampler2D normalTexture;
uniform sampler2D occlusionTexture;
${GLSL_MATERIAL_FX}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec4 vColor;
flat in float vFade;
in vec3 vLocal;
${glslOutputs(mrt)}
void main() {
  if (lodDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 dpx = dFdx(vWorld);
  vec3 dpy = dFdy(vWorld);
  vec2 tiled = vUv * grain.yz;
  vec2 duvx = dFdx(tiled);
  vec2 duvy = dFdy(tiled);
  vec2 uv = fxUvOf(tiled);
  vec2 baseUv = extra.x > 0.5 ? (${GLSL_PIXEL} - viewport.xy) / viewport.zw : uv;
  vec4 base = baseColor * vColor * texture(baseTexture, baseUv);
  if (fxUv.z > 0.0) base = baseColor * vColor * fxTriplanar(baseTexture, vWorld, normalize(vNormal), dpx, dpy);
  vec4 surfaceMap = texture(surfaceTexture, uv);
  vec3 glow = emissive.rgb * texture(emissiveTexture, uv).rgb;
  vec3 mapped = texture(normalTexture, uv).xyz * 2.0 - vec3(1.0);
  float occlusionMap = texture(occlusionTexture, uv).r;
  if (surface.z > 0.5 && surface.z < 1.5 && base.a < emissive.w) discard;
  float cut = fxDissolveCut(vLocal);
  if (cut < 0.0) discard;
  if (style.y > 0.5) {
    fragColor = vec4(mix(base.rgb, wireColor.rgb, wireColor.w), surface.z > 1.5 ? base.a : 0.0);
${mrt ? '    fragSurface = vec4(0.0, 0.0, 1.0, 0.0);' : ''}
    return;
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  if (maps.z > 0.5) {
    n = perturb(n, dpx, dpy, duvx, duvy, vec3(mapped.xy * maps.x, mapped.z));
  }
  float metallic = surface.x * surfaceMap.b;
  float roughness = clamp(surface.y * surfaceMap.g, 0.04, 1.0);
  float occlusion = mix(1.0, occlusionMap, maps.y * maps.w);
  vec3 v = normalize(cameraPosition.xyz - vWorld);
  Layers layers = noLayers(n);
  layers.coat = coat.x;
  layers.coatRoughness = clamp(coat.y, 0.04, 1.0);
  layers.scatter = coat.w;
  layers.scatterColor = scatter.rgb;
  if (scatter.w != 0.0) {
    layers.specular = anisotropic(n, v, dpx, dpy, duvx, duvy, scatter.w, grain.x, roughness);
  }
  float transmission = coat.z;
  vec4 lit = vec4(base.rgb, 0.0);
  if (surface.w < 0.5) {
    lit = lighting(vWorld, n, base.rgb * (1.0 - transmission), metallic, roughness, occlusion, ${GLSL_PIXEL}, layers);
  }
  float alpha = surface.z > 1.5 ? base.a : lit.a;
  if (transmission > 0.0) {
    alpha = 1.0 - transmission * (1.0 - (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0)));
  }
  vec4 shaded = fxShade(lit.rgb + glow, alpha, n, v, vWorld, cut);
  fragColor = vec4(applyFog(shaded.rgb, vWorld), shaded.a);
${mrt ? '  fragSurface = vec4(octEncode(n), roughness, surface.w > 0.5 ? 0.0 : luminance(mix(vec3(0.04), base.rgb, metallic)));' : ''}
}
`,
  };
}

function glslTerrain(mrt: boolean): GlslProgram {
  return glslTerrainPass(mrt, {
    header: GLSL_HEADER, frame: GLSL_FRAME, common: GLSL_COMMON, shadows: GLSL_SHADOWS, lighting: GLSL_LIGHTING, outputs: glslOutputs(mrt),
    block: glslBlock('Terrain', TERRAIN_FIELDS), depthRemap: GLSL_DEPTH_REMAP, pixel: GLSL_PIXEL,
  });
}

function glslBillboard(overlay: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
layout(location = 0) in vec4 centerAngle;
layout(location = 1) in vec4 rightOffset;
layout(location = 2) in vec4 upOffset;
layout(location = 3) in vec4 sizeShape;
layout(location = 4) in vec4 color;
out vec3 vWorld;
out vec2 vUv;
out vec2 vCorner;
out vec4 vColor;
out float vShape;
void main() {
  vec2 corners[6] = vec2[6](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5));
  vec2 corner = corners[gl_VertexID];
  vec3 right = cameraRight.xyz;
  vec3 up = cameraUp.xyz;
  if (sizeShape.w > 0.5) {
    right = rightOffset.xyz;
    up = upOffset.xyz;
  }
  float a = radians(centerAngle.w);
  vec2 q = corner * sizeShape.xy;
  vec2 r = vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a)) + vec2(rightOffset.w, upOffset.w);
  vec3 world = centerAngle.xyz + right * r.x + up * r.y;
  vWorld = world;
  vUv = vec2(corner.x + 0.5, 0.5 - corner.y);
  vCorner = corner;
  vColor = color;
  vShape = sizeShape.z;
  gl_Position = viewProjection * vec4(world, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${GLSL_COMMON}
uniform sampler2D image;
in vec3 vWorld;
in vec2 vUv;
in vec2 vCorner;
in vec4 vColor;
in float vShape;
out vec4 fragColor;
void main() {
  vec4 c = vColor * texture(image, vUv);
  if (vShape > 0.5) {
    c.a *= clamp((0.5 - length(vCorner)) * 16.0, 0.0, 1.0);
  }
  if (c.a <= 0.003) discard;
  fragColor = vec4(${overlay ? 'toDisplay(c.rgb)' : 'applyFog(c.rgb, vWorld)'}, c.a);
}
`,
  };
}

function glslLine(overlay: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
layout(location = 0) in vec4 startT;
layout(location = 1) in vec4 endSide;
layout(location = 2) in vec4 width;
layout(location = 3) in vec4 color;
out vec4 vColor;
void main() {
  vec3 p = mix(startT.xyz, endSide.xyz, startT.w);
  vec3 side = cross(endSide.xyz - startT.xyz, cameraPosition.xyz - p);
  if (length(side) < 1e-6) side = cameraUp.xyz;
  vec3 world = p + normalize(side) * width.x * 0.5 * endSide.w;
  vColor = color;
  gl_Position = viewProjection * vec4(world, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${GLSL_COMMON}
in vec4 vColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(${overlay ? 'toDisplay(vColor.rgb)' : 'vColor.rgb'}, vColor.a);
}
`,
  };
}

export function glsl(pass: ScenePass, variant: SceneVariant = {}): GlslProgram {
  const skinned = variant.skinned === true;
  const mrt = variant.mrt === true;
  const overlay = variant.overlay === true;
  switch (pass) {
    case 'caster': return glslCaster(skinned);
    case 'sky': return glslSky(mrt);
    case 'terrain': return glslTerrain(mrt);
    case 'mesh': return glslMesh(skinned, mrt);
    case 'billboard': return glslBillboard(overlay);
    case 'line': return glslLine(overlay);
    case 'outline': return glslOutline(skinned);
  }
}

/** Every variant of every scene pass (for tests and warm-up). */
export function sceneVariants(): { readonly pass: ScenePass; readonly variant: SceneVariant }[] {
  const out: { pass: ScenePass; variant: SceneVariant }[] = [];
  for (const pass of SCENE_PASSES) {
    for (const skinned of SKINNED_PASSES.includes(pass) ? [false, true] : [false]) {
      for (const mrt of MRT_PASSES.includes(pass) ? [false, true] : [false]) {
        for (const overlay of OVERLAY_PASSES.includes(pass) ? [false, true] : [false]) out.push({ pass, variant: { skinned, mrt, overlay } });
      }
    }
  }
  return out;
}

export { AGX_CURVE, AGX_INSET, AGX_OUTSET };
