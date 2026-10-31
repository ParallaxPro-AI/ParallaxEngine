/**
 * Projected decals on the GPU (the frame's `Decal3d`s): drawn per view after the opaque
 * scene (and its AO, reflections and sky), before blended surfaces, into the HDR target.
 *
 * Each decal is its box — the unit cube under its matrix — drawn with its back faces (so a
 * camera inside the box still sees it), no depth test, reading the scene's depth: a
 * fragment reconstructs the surface's world position, moves it into the box
 * (`inverse`), and is dropped outside it; inside, the image is sampled at the box's x/z
 * (u right, v top to bottom along -z), faded by how steeply the surface (its normal from
 * the depth's screen derivatives) turns away from the projection, lit like any surface and
 * fogged, and blended over the scene. `decalUv` is the same math on the CPU.
 *
 * Images are layers of one texture array (`DECAL_LAYER_SIZE`² each, mipmapped), so every
 * decal of a view is one instanced draw. The surface builds the array from the decoded
 * images (resized to the layer size) and rebuilds it when the set of images changes.
 */

import type { Decal3d, Texture3d, View3d } from '../../../core/index.js';
import { frustumPlanes, sphereVisible } from './cull.js';
import { linearRgb } from './layout.js';
import {
  GLSL_COMMON, GLSL_DEPTH_REMAP, GLSL_FRAME, GLSL_HEADER, GLSL_LIGHTING, GLSL_PIXEL, GLSL_SHADOWS, WGSL_COMMON, WGSL_FRAME, WGSL_LIGHTING, WGSL_SHADOWS,
} from './shaders.js';
import type { GlslProgram } from './shaders.js';

/** Floats per decal record: matrix (16), inverse (16), linear color (4), [layer, cos fade angle, 0, 0]. */
export const DECAL_FLOATS = 40;
/** Texels per side of every layer of the decal texture array. */
export const DECAL_LAYER_SIZE = 512;

export interface DecalFrame {
  readonly records: Float32Array;
  /** Per view (plan order): its decals' range in `records`. */
  readonly views: readonly { readonly first: number; readonly count: number }[];
}

/** The decal-space point (box -0.5..0.5) of a world point and its image uv, or null outside the box. */
export function decalUv(decal: Pick<Decal3d, 'inverse'>, x: number, y: number, z: number): { uv: [number, number]; local: [number, number, number] } | null {
  const m = decal.inverse;
  const l = [0, 1, 2].map((r) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!) as [number, number, number];
  if (l.some((c) => Math.abs(c) > 0.5)) return null;
  return { uv: [l[0] + 0.5, 0.5 - l[2]], local: l };
}

/** How much of a decal shows on a surface facing `normal` (world, unit): 1 facing the projection, 0 at 90° and beyond. */
export function decalFade(decal: Pick<Decal3d, 'matrix' | 'angleFade'>, normal: readonly number[]): number {
  const m = decal.matrix;
  const l = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const facing = (normal[0]! * m[4]! + normal[1]! * m[5]! + normal[2]! * m[6]!) / l;
  return Math.min(1, Math.max(0, facing / Math.max(decal.angleFade, 1e-3)));
}

/** Decals → per-view records (culled by each box's bounding sphere), with their image layers; decals whose image isn't in the array yet wait. */
export function planDecals(decals: readonly Decal3d[], views: readonly View3d[], layerOf: (texture: Texture3d) => number | null): DecalFrame | null {
  const usable = decals.flatMap((d) => {
    const layer = layerOf(d.texture);
    return layer === null ? [] : [{ d, layer }];
  });
  if (usable.length === 0) return null;
  const records: number[] = [];
  const perView = views.map((view) => {
    const planes = frustumPlanes(view.viewProjection);
    const first = records.length / DECAL_FLOATS;
    for (const { d, layer } of usable) {
      const m = d.matrix;
      const r = 0.5 * Math.hypot(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
      if (!sphereVisible(planes, m[12]!, m[13]!, m[14]!, r)) continue;
      records.push(...m, ...d.inverse, ...linearRgb([d.color[0], d.color[1], d.color[2]]), d.color[3], layer, d.angleFade, 0, 0);
    }
    return { first, count: records.length / DECAL_FLOATS - first };
  });
  return { records: new Float32Array(records), views: perView };
}

/** The distinct decal images of a frame, in a stable order (the array's layers). */
export function decalImages(decals: readonly Decal3d[]): Texture3d[] {
  const byId = new Map<string, Texture3d>();
  for (const d of decals) byId.set(d.texture.id, d.texture);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const CUBE = `
  var corners = array<vec3<f32>, 8>(
    vec3<f32>(-0.5, -0.5, -0.5), vec3<f32>(0.5, -0.5, -0.5), vec3<f32>(-0.5, 0.5, -0.5), vec3<f32>(0.5, 0.5, -0.5),
    vec3<f32>(-0.5, -0.5, 0.5), vec3<f32>(0.5, -0.5, 0.5), vec3<f32>(-0.5, 0.5, 0.5), vec3<f32>(0.5, 0.5, 0.5));
  var faces = array<u32, 36>(0u, 2u, 1u, 1u, 2u, 3u, 4u, 5u, 6u, 5u, 7u, 6u, 0u, 1u, 4u, 1u, 5u, 4u, 2u, 6u, 3u, 3u, 6u, 7u, 0u, 4u, 2u, 2u, 4u, 6u, 1u, 3u, 5u, 3u, 7u, 5u);`;

export function wgslDecal(): string {
  return `${WGSL_FRAME}${WGSL_COMMON}${WGSL_SHADOWS}${WGSL_LIGHTING}
@group(1) @binding(0) var depthTexture: texture_depth_2d;
@group(1) @binding(1) var images: texture_2d_array<f32>;
@group(1) @binding(2) var imageSampler: sampler;

struct DecalIn {
  @location(0) m0: vec4<f32>, @location(1) m1: vec4<f32>, @location(2) m2: vec4<f32>, @location(3) m3: vec4<f32>,
  @location(4) i0: vec4<f32>, @location(5) i1: vec4<f32>, @location(6) i2: vec4<f32>, @location(7) i3: vec4<f32>,
  @location(8) color: vec4<f32>, @location(9) params: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) @interpolate(flat) i0: vec4<f32>,
  @location(1) @interpolate(flat) i1: vec4<f32>,
  @location(2) @interpolate(flat) i2: vec4<f32>,
  @location(3) @interpolate(flat) i3: vec4<f32>,
  @location(4) @interpolate(flat) color: vec4<f32>,
  @location(5) @interpolate(flat) params: vec4<f32>,
  @location(6) @interpolate(flat) up: vec3<f32>,
};

@vertex fn vs(@builtin(vertex_index) index: u32, d: DecalIn) -> VertexOut {${CUBE}
  let model = mat4x4<f32>(d.m0, d.m1, d.m2, d.m3);
  var out: VertexOut;
  out.clip = frame.viewProjection * (model * vec4<f32>(corners[faces[index]], 1.0));
  out.i0 = d.i0; out.i1 = d.i1; out.i2 = d.i2; out.i3 = d.i3;
  out.color = d.color;
  out.params = d.params;
  out.up = normalize(d.m1.xyz);
  return out;
}

@fragment fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(depthTexture));
  let texel = clamp(vec2<i32>(floor(in.clip.xy)), vec2<i32>(0), size - vec2<i32>(1));
  let depth = textureLoad(depthTexture, texel, 0);
  let local0 = (in.clip.xy - frame.viewport.xy) / frame.viewport.zw;
  let ndc = vec2<f32>(local0.x * 2.0 - 1.0, 1.0 - local0.y * 2.0);
  let h = frame.inverseViewProjection * vec4<f32>(ndc, depth, 1.0);
  let world = h.xyz / h.w;
  // Derivatives before any discard (they need every pixel of the quad).
  var n = normalize(cross(dpdy(world), dpdx(world)));
  let local = (mat4x4<f32>(in.i0, in.i1, in.i2, in.i3) * vec4<f32>(world, 1.0)).xyz;
  if (depth >= 1.0 || any(abs(local) > vec3<f32>(0.5))) { discard; }
  if (dot(n, frame.cameraPosition.xyz - world) < 0.0) { n = -n; }
  let fade = clamp(dot(n, in.up) / max(in.params.y, 1e-3), 0.0, 1.0);
  let image = textureSampleLevel(images, imageSampler, vec2<f32>(local.x + 0.5, 0.5 - local.z), i32(in.params.x), 0.0);
  let alpha = image.a * in.color.a * fade;
  if (alpha <= 0.003) { discard; }
  let albedo = image.rgb * in.color.rgb;
  let lit = lighting(world, n, albedo, 0.0, 0.9, 1.0, in.clip.xy, noLayers(n));
  return vec4<f32>(applyFog(lit.rgb, world), alpha);
}
`;
}

export function glslDecal(): GlslProgram {
  const cube = `
  vec3 corners[8] = vec3[8](vec3(-0.5, -0.5, -0.5), vec3(0.5, -0.5, -0.5), vec3(-0.5, 0.5, -0.5), vec3(0.5, 0.5, -0.5),
    vec3(-0.5, -0.5, 0.5), vec3(0.5, -0.5, 0.5), vec3(-0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5));
  int faces[36] = int[36](0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5);`;
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
layout(location = 0) in vec4 m0;
layout(location = 1) in vec4 m1;
layout(location = 2) in vec4 m2;
layout(location = 3) in vec4 m3;
layout(location = 4) in vec4 i0;
layout(location = 5) in vec4 i1;
layout(location = 6) in vec4 i2;
layout(location = 7) in vec4 i3;
layout(location = 8) in vec4 color;
layout(location = 9) in vec4 params;
flat out mat4 vInverse;
flat out vec4 vColor;
flat out vec4 vParams;
flat out vec3 vUp;
void main() {${cube}
  mat4 model = mat4(m0, m1, m2, m3);
  gl_Position = viewProjection * (model * vec4(corners[faces[gl_VertexID]], 1.0));
  vInverse = mat4(i0, i1, i2, i3);
  vColor = color;
  vParams = params;
  vUp = normalize(m1.xyz);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${GLSL_COMMON}${GLSL_SHADOWS}${GLSL_LIGHTING}
precision highp sampler2DArray;
uniform sampler2D depthTexture;
uniform sampler2DArray decalImages;
flat in mat4 vInverse;
flat in vec4 vColor;
flat in vec4 vParams;
flat in vec3 vUp;
out vec4 fragColor;
void main() {
  vec2 p = ${GLSL_PIXEL};
  float depth = texelFetch(depthTexture, ivec2(gl_FragCoord.xy), 0).r;
  vec2 local0 = (p - viewport.xy) / viewport.zw;
  vec2 ndc = vec2(local0.x * 2.0 - 1.0, 1.0 - local0.y * 2.0);
  vec4 h = inverseViewProjection * vec4(ndc, depth, 1.0);
  vec3 world = h.xyz / h.w;
  vec3 n = normalize(cross(dFdy(world), dFdx(world)));
  vec3 local = (vInverse * vec4(world, 1.0)).xyz;
  if (depth >= 1.0 || any(greaterThan(abs(local), vec3(0.5)))) discard;
  if (dot(n, cameraPosition.xyz - world) < 0.0) n = -n;
  float fade = clamp(dot(n, vUp) / max(vParams.y, 1e-3), 0.0, 1.0);
  vec4 image = textureLod(decalImages, vec3(local.x + 0.5, 0.5 - local.z, vParams.x), 0.0);
  float alpha = image.a * vColor.a * fade;
  if (alpha <= 0.003) discard;
  vec3 albedo = image.rgb * vColor.rgb;
  vec4 lit = lighting(world, n, albedo, 0.0, 0.9, 1.0, p, noLayers(n));
  fragColor = vec4(applyFog(lit.rgb, world), alpha);
}
`,
  };
}
