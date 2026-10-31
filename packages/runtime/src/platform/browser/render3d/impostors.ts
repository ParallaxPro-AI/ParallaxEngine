/**
 * Impostors on the GPU: the bake that turns an `ImpostorSource3d` into an atlas, and the
 * pass that draws far instances from it (WGSL and GLSL side by side).
 *
 * The atlas holds `frames` × `frames` views of the model, each looking at it from a
 * direction on the upper hemisphere laid out by the hemi-octahedral map (`hemiOctEncode`):
 * the diamond |x| + |z| ≤ 1 of the direction's octahedral projection, turned 45° to fill
 * the square. Frame (i, j) sees the model from `frameDirection(i, j)`, orthographically,
 * framed by its bounding sphere, with world up (+y) up. Two atlases: albedo with coverage
 * (sRGB) and normals in the model's space (0..1 encoded). The bake is a pure function of
 * the source (`bakeViews`), so it is deterministic.
 *
 * Drawing: each instance is one quad facing the camera, sized by the sphere. Its view
 * direction (camera → model, in the model's space: the instance's yaw undone) picks the
 * four nearest frames and their bilinear weights; the fragment blends them, alpha-tests the
 * coverage, turns the baked normal by the yaw, and is lit like any surface (sun, shadows,
 * clustered lights, sky) and fogged. Below the horizon the lowest ring of frames is used.
 *
 * Row order: WebGPU writes a frame's top row at its first texel row, WebGL2 at its last; the
 * GL bake flips its projection's y so both atlases read the same with v down.
 */

import { IMPOSTOR_STRIDE } from '../../../core/index.js';
import type { ImpostorBatch3d, ImpostorSource3d, Material3d, Texture3d, View3d } from '../../../core/index.js';
import { frustumPlanes, sphereVisible } from './cull.js';
import { glslBlock, linearRgb, LOCATION as L, slotFloats, wgslStruct } from './layout.js';
import type { UniformField } from './layout.js';
import {
  GLSL_COMMON, GLSL_FRAME, GLSL_HEADER, GLSL_LIGHTING, GLSL_PIXEL, GLSL_SHADOWS, GLSL_DEPTH_REMAP, WGSL_COMMON, WGSL_FRAME, WGSL_LIGHTING, WGSL_SHADOWS,
} from './shaders.js';
import type { GlslProgram } from './shaders.js';

// ── The hemi-octahedral map ──────────────────────────────────────────────────

/** A direction on the upper hemisphere (y ≥ 0; lower ones are clamped to the horizon) → the square -1..1². */
export function hemiOctEncode(x: number, y: number, z: number): [number, number] {
  const l = Math.abs(x) + Math.max(y, 0) + Math.abs(z) || 1;
  const px = x / l;
  const pz = z / l;
  return [px + pz, pz - px];
}

/** The square -1..1² → a unit direction on the upper hemisphere. */
export function hemiOctDecode(u: number, v: number): [number, number, number] {
  const px = (u - v) / 2;
  const pz = (u + v) / 2;
  const y = 1 - Math.abs(px) - Math.abs(pz);
  const l = Math.hypot(px, y, pz) || 1;
  return [px / l, y / l, pz / l];
}

/** The direction frame (i, j) of a `frames`-wide atlas sees the model from (model space). */
export function frameDirection(i: number, j: number, frames: number): [number, number, number] {
  return hemiOctDecode(((i + 0.5) / frames) * 2 - 1, ((j + 0.5) / frames) * 2 - 1);
}

/** The four frames nearest a view direction and their bilinear weights (sum 1). */
export function frameWeights(x: number, y: number, z: number, frames: number): { frames: [number, number][]; weights: number[] } {
  const [u, v] = hemiOctEncode(x, Math.max(y, 0), z);
  const clamp = (g: number): number => Math.min(frames - 1, Math.max(0, g));
  const gu = clamp(((u + 1) / 2) * frames - 0.5);
  const gv = clamp(((v + 1) / 2) * frames - 0.5);
  const i0 = Math.floor(gu);
  const j0 = Math.floor(gv);
  const i1 = Math.min(frames - 1, i0 + 1);
  const j1 = Math.min(frames - 1, j0 + 1);
  const fu = gu - i0;
  const fv = gv - j0;
  return {
    frames: [[i0, j0], [i1, j0], [i0, j1], [i1, j1]],
    weights: [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv],
  };
}

/**
 * The orthographic world (model) → clip matrix of each frame, row by row (frame index
 * j · frames + i): looking along -direction at the sphere's center, world up, the sphere
 * filling the frame, depth 0..1 over its diameter. `flipY` mirrors clip y (the WebGL2 bake).
 */
export function bakeViews(source: ImpostorSource3d, flipY = false): Float32Array[] {
  const out: Float32Array[] = [];
  const [cx, cy, cz] = source.center;
  const r = Math.max(source.radius, 1e-4);
  for (let j = 0; j < source.frames; j++) {
    for (let i = 0; i < source.frames; i++) {
      const d = frameDirection(i, j, source.frames);
      const f = [-d[0], -d[1], -d[2]];
      // right = up × forward (left-handed: +x right of +z forward with +y up); straight down, +z is "up".
      let right = [f[2]!, 0, -f[0]!];
      if (Math.hypot(right[0]!, right[2]!) < 1e-6) right = [1, 0, 0];
      const rl = Math.hypot(right[0]!, right[1]!, right[2]!);
      right = right.map((c) => c / rl);
      const up = [
        f[1]! * right[2]! - f[2]! * right[1]!,
        f[2]! * right[0]! - f[0]! * right[2]!,
        f[0]! * right[1]! - f[1]! * right[0]!,
      ];
      const eye = [cx + d[0] * r * 2, cy + d[1] * r * 2, cz + d[2] * r * 2];
      const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      const sy = flipY ? -1 : 1;
      // ortho: x, y in -r..r → -1..1; view depth r..3r → 0..1.
      const m = new Float32Array(16);
      for (let k = 0; k < 3; k++) {
        m[k * 4] = right[k]! / r;
        m[k * 4 + 1] = (sy * up[k]!) / r;
        m[k * 4 + 2] = f[k]! / (2 * r);
      }
      m[12] = -dot(right, eye) / r;
      m[13] = (sy * -dot(up, eye)) / r;
      m[14] = (-dot(f, eye) - r) / (2 * r);
      m[15] = 1;
      out.push(m);
    }
  }
  return out;
}

// ── Uniform blocks ───────────────────────────────────────────────────────────

const vec4 = (name: string): UniformField => ({ name, kind: 'vec4' });

/** One baked part in one frame. */
export const BAKE_FIELDS: readonly UniformField[] = [
  { name: 'bakeViewProjection', kind: 'mat4' },
  { name: 'bakeModel', kind: 'mat4' },
  /** rgb linear, a alpha. */
  vec4('bakeColor'),
  /** alpha mode (0 opaque, 1 mask), cutoff, has texture, double-sided (0/1). */
  vec4('bakeParams'),
];
export const BAKE_SLOT = slotFloats(BAKE_FIELDS);

/** One impostor source as drawn. */
export const IMPOSTOR_FIELDS: readonly UniformField[] = [
  /** Sphere center (model space) and radius. */
  vec4('impostorSphere'),
  /** Frames per side, 1 / frames, roughness, subsurface (the parts' strongest; foliage leaves). */
  vec4('impostorParams'),
];
export const IMPOSTOR_SLOT = slotFloats(IMPOSTOR_FIELDS);

/** Floats per impostor instance record on the GPU (the port's record as is). */
export const IMPOSTOR_INSTANCE_FLOATS = IMPOSTOR_STRIDE;

// ── Planning ─────────────────────────────────────────────────────────────────

/** An impostor draw: instances of one source in the frame's impostor records. */
export interface ImpostorItem {
  readonly source: ImpostorSource3d;
  /** Slot in `ImpostorFrame.blocks`. */
  readonly slot: number;
  readonly first: number;
  readonly count: number;
}

export interface ImpostorFrame {
  /** `IMPOSTOR_SLOT` floats per source. */
  readonly blocks: Float32Array;
  /** `IMPOSTOR_INSTANCE_FLOATS` per record; each view's visible instances contiguous. */
  readonly instances: Float32Array;
  /** Sources drawn this frame (each baked first, once). */
  readonly sources: readonly ImpostorSource3d[];
  /** Per view (in plan view order): what it draws. */
  readonly views: readonly (readonly ImpostorItem[])[];
}

/** Every texture an impostor's parts sample (the bake waits for them). */
export function impostorTextures(source: ImpostorSource3d): Texture3d[] {
  const out: Texture3d[] = [];
  for (const part of source.parts) if (part.material.baseColorTexture !== null) out.push(part.material.baseColorTexture);
  return out;
}

/** Impostor batches → per-view visible instance ranges (frustum culled by each quad's sphere). */
export function planImpostors(batches: readonly ImpostorBatch3d[], views: readonly View3d[], ready: (t: Texture3d) => boolean): ImpostorFrame | null {
  const usable = batches.filter((b) => b.count > 0 && b.source.parts.length > 0 && impostorTextures(b.source).every(ready));
  if (usable.length === 0) return null;
  const sources = [...new Set(usable.map((b) => b.source))];
  const slotOf = new Map(sources.map((s, i) => [s, i]));
  const blocks = new Float32Array(sources.length * IMPOSTOR_SLOT);
  sources.forEach((s, i) => {
    const roughness = s.parts.reduce((sum, p) => sum + p.material.roughness, 0) / s.parts.length;
    const subsurface = s.parts.reduce((most, p) => Math.max(most, p.material.layers?.subsurface ?? 0), 0);
    blocks.set([...s.center, s.radius, s.frames, 1 / s.frames, roughness, subsurface], i * IMPOSTOR_SLOT);
  });
  const records: number[] = [];
  const perView = views.map((view) => {
    const planes = frustumPlanes(view.viewProjection);
    const items: ImpostorItem[] = [];
    for (const batch of usable) {
      const first = records.length / IMPOSTOR_INSTANCE_FLOATS;
      const s = batch.source;
      for (let k = 0; k < batch.count; k++) {
        const o = k * IMPOSTOR_STRIDE;
        const d = batch.instances;
        const scale = d[o + 3]!;
        const yaw = d[o + 4]!;
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const x = d[o]! + (s.center[0] * c + s.center[2] * sn) * scale;
        const y = d[o + 1]! + s.center[1] * scale;
        const z = d[o + 2]! + (-s.center[0] * sn + s.center[2] * c) * scale;
        if (!sphereVisible(planes, x, y, z, s.radius * scale)) continue;
        for (let f = 0; f < IMPOSTOR_STRIDE; f++) records.push(d[o + f]!);
      }
      const count = records.length / IMPOSTOR_INSTANCE_FLOATS - first;
      if (count > 0) items.push({ source: s, slot: slotOf.get(s)!, first, count });
    }
    return items;
  });
  return { blocks, instances: new Float32Array(records), sources, views: perView };
}

/** One bake slot per frame and part: the frame's view-projection, the part's matrix and its material. */
export function packBake(source: ImpostorSource3d, flipY: boolean): Float32Array {
  const views = bakeViews(source, flipY);
  const out = new Float32Array(views.length * source.parts.length * BAKE_SLOT);
  views.forEach((vp, f) => {
    source.parts.forEach((part, p) => {
      const o = (f * source.parts.length + p) * BAKE_SLOT;
      out.set(vp, o);
      out.set(part.matrix, o + 16);
      const m: Material3d = part.material;
      out.set([...linearRgb([m.baseColor[0], m.baseColor[1], m.baseColor[2]]), m.baseColor[3]], o + 32);
      out.set([m.alphaMode === 'mask' ? 1 : 0, m.alphaCutoff, m.baseColorTexture === null ? 0 : 1, m.doubleSided ? 1 : 0], o + 36);
    });
  });
  return out;
}

// ── Shaders ──────────────────────────────────────────────────────────────────

const WGSL_BAKE = `${wgslStruct('Bake', BAKE_FIELDS)}
@group(0) @binding(0) var<uniform> bake: Bake;
@group(0) @binding(1) var baseTexture: texture_2d<f32>;
@group(0) @binding(2) var baseSampler: sampler;

struct VertexIn {
  @location(${L.position}) position: vec3<f32>,
  @location(${L.normal}) normal: vec3<f32>,
  @location(${L.uv}) uv: vec2<f32>,
  @location(${L.color}) color: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
};

struct FragOut {
  @location(0) albedo: vec4<f32>,
  @location(1) normal: vec4<f32>,
};

@vertex fn vs(v: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.clip = bake.bakeViewProjection * (bake.bakeModel * vec4<f32>(v.position, 1.0));
  out.normal = (bake.bakeModel * vec4<f32>(v.normal, 0.0)).xyz;
  out.uv = v.uv;
  out.color = v.color;
  return out;
}

@fragment fn fs(in: VertexOut, @builtin(front_facing) front: bool) -> FragOut {
  var base = bake.bakeColor * in.color;
  if (bake.bakeParams.z > 0.5) { base *= textureSample(baseTexture, baseSampler, in.uv); }
  if (bake.bakeParams.x > 0.5 && base.a < bake.bakeParams.y) { discard; }
  // A degenerate normal (a cone's apex) must not bake NaN into the atlas.
  var n = vec3<f32>(0.0, 1.0, 0.0);
  if (length(in.normal) > 1e-6) { n = normalize(in.normal); }
  // Back faces: a single-sided surface's are culled, as the mesh pass draws it; a double-sided one's face the other way.
  if (!front) {
    if (bake.bakeParams.w < 0.5) { discard; }
    n = -n;
  }
  var out: FragOut;
  out.albedo = vec4<f32>(base.rgb, 1.0);
  out.normal = vec4<f32>(n * 0.5 + vec3<f32>(0.5), 1.0);
  return out;
}
`;

export function wgslBake(): string {
  return WGSL_BAKE;
}

export function glslBake(): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${glslBlock('Bake', BAKE_FIELDS)}
layout(location = ${L.position}) in vec3 position;
layout(location = ${L.normal}) in vec3 normal;
layout(location = ${L.uv}) in vec2 uv;
layout(location = ${L.color}) in vec4 color;
out vec3 vNormal;
out vec2 vUv;
out vec4 vColor;
void main() {
  gl_Position = bakeViewProjection * (bakeModel * vec4(position, 1.0));
  vNormal = (bakeModel * vec4(normal, 0.0)).xyz;
  vUv = uv;
  vColor = color;
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${glslBlock('Bake', BAKE_FIELDS)}
uniform sampler2D baseTexture;
in vec3 vNormal;
in vec2 vUv;
in vec4 vColor;
layout(location = 0) out vec4 fragAlbedo;
layout(location = 1) out vec4 fragNormal;
void main() {
  vec4 base = bakeColor * vColor;
  if (bakeParams.z > 0.5) base *= texture(baseTexture, vUv);
  if (bakeParams.x > 0.5 && base.a < bakeParams.y) discard;
  vec3 n = length(vNormal) > 1e-6 ? normalize(vNormal) : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) {
    if (bakeParams.w < 0.5) discard;
    n = -n;
  }
  fragAlbedo = vec4(base.rgb, 1.0);
  fragNormal = vec4(n * 0.5 + vec3(0.5), 1.0);
}
`,
  };
}

/** The draw: shared vertex logic (frame selection), in each language. */
export function wgslImpostor(mrt: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}${WGSL_SHADOWS}${WGSL_LIGHTING}
${wgslStruct('Impostor', IMPOSTOR_FIELDS)}
@group(1) @binding(0) var<uniform> impostor: Impostor;
@group(1) @binding(1) var albedoAtlas: texture_2d<f32>;
@group(1) @binding(2) var normalAtlas: texture_2d<f32>;
@group(1) @binding(3) var atlasSampler: sampler;

struct InstanceIn {
  @location(0) placeScale: vec4<f32>,
  @location(1) yawFade: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) frames01: vec4<f32>,
  @location(3) @interpolate(flat) frames23: vec4<f32>,
  @location(4) @interpolate(flat) weights: vec4<f32>,
  @location(5) @interpolate(flat) yawFade: vec2<f32>,
};

struct FragOut {
  @location(0) color: vec4<f32>,
${mrt ? '  @location(1) surface: vec4<f32>,' : ''}
};

fn hemiOct(d: vec3<f32>) -> vec2<f32> {
  let l = abs(d.x) + max(d.y, 0.0) + abs(d.z);
  let p = vec2<f32>(d.x, d.z) / max(l, 1e-5);
  return vec2<f32>(p.x + p.y, p.y - p.x);
}

@vertex fn vs(@builtin(vertex_index) index: u32, b: InstanceIn) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
  let corner = corners[index];
  let yaw = b.yawFade.x;
  let c = cos(yaw);
  let s = sin(yaw);
  let scale = b.placeScale.w;
  let local = impostor.impostorSphere.xyz;
  let center = b.placeScale.xyz + vec3<f32>(local.x * c + local.z * s, local.y, -local.x * s + local.z * c) * scale;
  let toCam = normalize(frame.cameraPosition.xyz - center);
  var right = vec3<f32>(-toCam.z, 0.0, toCam.x);
  if (length(right) < 1e-4) { right = frame.cameraRight.xyz; }
  right = normalize(right);
  let up = cross(-toCam, right);
  let size = impostor.impostorSphere.w * scale * 2.0;
  let world = center + (right * corner.x + up * corner.y) * size;
  let toCamModel = vec3<f32>(toCam.x * c - toCam.z * s, toCam.y, toCam.x * s + toCam.z * c);
  let frames = impostor.impostorParams.x;
  let g = clamp((hemiOct(toCamModel) * 0.5 + vec2<f32>(0.5)) * frames - vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(frames - 1.0));
  let f0 = floor(g);
  let f1 = min(f0 + vec2<f32>(1.0), vec2<f32>(frames - 1.0));
  let w = g - f0;
  var out: VertexOut;
  out.clip = frame.viewProjection * vec4<f32>(world, 1.0);
  out.world = world;
  out.uv = vec2<f32>(corner.x + 0.5, 0.5 - corner.y);
  out.frames01 = vec4<f32>(f0.x, f0.y, f1.x, f0.y);
  out.frames23 = vec4<f32>(f0.x, f1.y, f1.x, f1.y);
  out.weights = vec4<f32>((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y);
  out.yawFade = b.yawFade.xy;
  return out;
}

fn atlasUv(f: vec2<f32>, uv: vec2<f32>) -> vec2<f32> {
  return (f + clamp(uv, vec2<f32>(0.01), vec2<f32>(0.99))) * impostor.impostorParams.y;
}

@fragment fn fs(in: VertexOut) -> FragOut {
  if (lodDiscard(in.yawFade.y, in.clip.xy)) { discard; }
  let u0 = atlasUv(in.frames01.xy, in.uv);
  let u1 = atlasUv(in.frames01.zw, in.uv);
  let u2 = atlasUv(in.frames23.xy, in.uv);
  let u3 = atlasUv(in.frames23.zw, in.uv);
  let albedo = textureSampleLevel(albedoAtlas, atlasSampler, u0, 0.0) * in.weights.x + textureSampleLevel(albedoAtlas, atlasSampler, u1, 0.0) * in.weights.y
    + textureSampleLevel(albedoAtlas, atlasSampler, u2, 0.0) * in.weights.z + textureSampleLevel(albedoAtlas, atlasSampler, u3, 0.0) * in.weights.w;
  if (albedo.a < 0.5) { discard; }
  // Uncovered texels are cleared to 0 (which unpacks to -1, -1, -1): weight by coverage (alpha), like the albedo.
  let packed4 = textureSampleLevel(normalAtlas, atlasSampler, u0, 0.0) * in.weights.x + textureSampleLevel(normalAtlas, atlasSampler, u1, 0.0) * in.weights.y
    + textureSampleLevel(normalAtlas, atlasSampler, u2, 0.0) * in.weights.z + textureSampleLevel(normalAtlas, atlasSampler, u3, 0.0) * in.weights.w;
  let packed = packed4.xyz / max(packed4.a, 1e-4);
  // Blended texels can cancel to zero: fall back to up rather than NaN (which bloom spreads over the screen).
  let unpacked = packed * 2.0 - vec3<f32>(1.0);
  var nm = vec3<f32>(0.0, 1.0, 0.0);
  if (length(unpacked) > 1e-4) { nm = normalize(unpacked); }
  let c = cos(in.yawFade.x);
  let s = sin(in.yawFade.x);
  let n = normalize(vec3<f32>(nm.x * c + nm.z * s, nm.y, -nm.x * s + nm.z * c));
  let base = albedo.rgb / max(albedo.a, 1e-4);
  let roughness = impostor.impostorParams.z;
  // Light through the surface (leaves) as the mesh pass shades it, tinted by the albedo.
  var layers = noLayers(n);
  layers.scatter = impostor.impostorParams.w;
  layers.scatterColor = min(base * 1.5, vec3<f32>(1.0));
  let lit = lighting(in.world, n, base, 0.0, roughness, 1.0, in.clip.xy, layers);
  var out: FragOut;
  out.color = vec4<f32>(applyFog(lit.rgb, in.world), lit.a);
${mrt ? '  out.surface = vec4<f32>(octEncode(n), roughness, 0.04);' : ''}
  return out;
}
`;
}

export function glslImpostor(mrt: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}${glslBlock('Impostor', IMPOSTOR_FIELDS)}
layout(location = 0) in vec4 placeScale;
layout(location = 1) in vec4 yawFade;
out vec3 vWorld;
out vec2 vUv;
flat out vec4 vFrames01;
flat out vec4 vFrames23;
flat out vec4 vWeights;
flat out vec2 vYawFade;
vec2 hemiOct(vec3 d) {
  float l = abs(d.x) + max(d.y, 0.0) + abs(d.z);
  vec2 p = vec2(d.x, d.z) / max(l, 1e-5);
  return vec2(p.x + p.y, p.y - p.x);
}
void main() {
  vec2 corners[6] = vec2[6](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5));
  vec2 corner = corners[gl_VertexID];
  float yaw = yawFade.x;
  float c = cos(yaw);
  float s = sin(yaw);
  float scale = placeScale.w;
  vec3 local = impostorSphere.xyz;
  vec3 center = placeScale.xyz + vec3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c) * scale;
  vec3 toCam = normalize(cameraPosition.xyz - center);
  vec3 right = vec3(-toCam.z, 0.0, toCam.x);
  if (length(right) < 1e-4) right = cameraRight.xyz;
  right = normalize(right);
  vec3 up = cross(-toCam, right);
  float size = impostorSphere.w * scale * 2.0;
  vec3 world = center + (right * corner.x + up * corner.y) * size;
  vec3 toCamModel = vec3(toCam.x * c - toCam.z * s, toCam.y, toCam.x * s + toCam.z * c);
  float frames = impostorParams.x;
  vec2 g = clamp((hemiOct(toCamModel) * 0.5 + vec2(0.5)) * frames - vec2(0.5), vec2(0.0), vec2(frames - 1.0));
  vec2 f0 = floor(g);
  vec2 f1 = min(f0 + vec2(1.0), vec2(frames - 1.0));
  vec2 w = g - f0;
  vWorld = world;
  vUv = vec2(corner.x + 0.5, 0.5 - corner.y);
  vFrames01 = vec4(f0.x, f0.y, f1.x, f0.y);
  vFrames23 = vec4(f0.x, f1.y, f1.x, f1.y);
  vWeights = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y);
  vYawFade = yawFade.xy;
  gl_Position = viewProjection * vec4(world, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${glslBlock('Impostor', IMPOSTOR_FIELDS)}${GLSL_COMMON}${GLSL_SHADOWS}${GLSL_LIGHTING}
uniform sampler2D albedoAtlas;
uniform sampler2D normalAtlas;
in vec3 vWorld;
in vec2 vUv;
flat in vec4 vFrames01;
flat in vec4 vFrames23;
flat in vec4 vWeights;
flat in vec2 vYawFade;
layout(location = 0) out vec4 fragColor;
${mrt ? 'layout(location = 1) out vec4 fragSurface;\n' : ''}
vec2 atlasUv(vec2 f, vec2 uv) {
  return (f + clamp(uv, vec2(0.01), vec2(0.99))) * impostorParams.y;
}
void main() {
  if (lodDiscard(vYawFade.y, gl_FragCoord.xy)) discard;
  vec2 u0 = atlasUv(vFrames01.xy, vUv);
  vec2 u1 = atlasUv(vFrames01.zw, vUv);
  vec2 u2 = atlasUv(vFrames23.xy, vUv);
  vec2 u3 = atlasUv(vFrames23.zw, vUv);
  vec4 albedo = textureLod(albedoAtlas, u0, 0.0) * vWeights.x + textureLod(albedoAtlas, u1, 0.0) * vWeights.y
    + textureLod(albedoAtlas, u2, 0.0) * vWeights.z + textureLod(albedoAtlas, u3, 0.0) * vWeights.w;
  if (albedo.a < 0.5) discard;
  vec4 packed4 = textureLod(normalAtlas, u0, 0.0) * vWeights.x + textureLod(normalAtlas, u1, 0.0) * vWeights.y
    + textureLod(normalAtlas, u2, 0.0) * vWeights.z + textureLod(normalAtlas, u3, 0.0) * vWeights.w;
  vec3 packed = packed4.xyz / max(packed4.a, 1e-4);
  vec3 unpacked = packed * 2.0 - vec3(1.0);
  vec3 nm = length(unpacked) > 1e-4 ? normalize(unpacked) : vec3(0.0, 1.0, 0.0);
  float c = cos(vYawFade.x);
  float s = sin(vYawFade.x);
  vec3 n = normalize(vec3(nm.x * c + nm.z * s, nm.y, -nm.x * s + nm.z * c));
  vec3 base = albedo.rgb / max(albedo.a, 1e-4);
  float roughness = impostorParams.z;
  Layers layers = noLayers(n);
  layers.scatter = impostorParams.w;
  layers.scatterColor = min(base * 1.5, vec3(1.0));
  vec4 lit = lighting(vWorld, n, base, 0.0, roughness, 1.0, ${GLSL_PIXEL}, layers);
  fragColor = vec4(applyFog(lit.rgb, vWorld), lit.a);
${mrt ? '  fragSurface = vec4(octEncode(n), roughness, 0.04);' : ''}
}
`,
  };
}

