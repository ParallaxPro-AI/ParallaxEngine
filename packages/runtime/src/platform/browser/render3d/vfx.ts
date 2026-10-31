/**
 * Effect particles and ribbons on the GPU (the frame's `ParticleBatch3d`s and `Ribbon3d`s):
 * drawn per view after the scene's blended surfaces, into the HDR target (so additive
 * ones bloom), with no depth attachment — each fragment reads the scene's depth itself,
 * is dropped behind it, and fades out over the batch's `soft` meters in front of it (soft
 * particles: no hard line where smoke meets the ground). Alpha-blended batches first (in
 * the frame's order: far to near), then additive ones; ribbons after the particles of
 * their blend. Both blends write premultiplied color.
 *
 * A particle is one instanced quad: camera-facing and turned by its angle, stretched along
 * its velocity (sparks) or lying flat (rings on the ground). Its look: a shape (circle,
 * square, glow, ring) or an image, which may be a flipbook sheet (two neighbouring frames
 * blended by the particle's progress); lit particles are shaded as a rounded puff by the
 * sun and ambient light. Fog fades additive light out and covers blended color.
 *
 * A ribbon is six vertices per segment, each widened toward the camera around its point's
 * tangent (so segments meet without gaps), with a soft profile across its width and an
 * optional white-hot core.
 */

import { PARTICLE3D_STRIDE, RIBBON_STRIDE } from '../../../core/index.js';
import type { Frame3d, Texture3d } from '../../../core/index.js';
import { srgbToLinear } from './layout.js';
import { GLSL_COMMON, GLSL_DEPTH_REMAP, GLSL_FRAME, GLSL_HEADER, WGSL_COMMON, WGSL_FRAME } from './shaders.js';
import type { GlslProgram } from './shaders.js';

/** Floats per particle instance: [center, angle (radians)], [stretch, soft], [w, h, progress, flags], [linear rgb × intensity, a], [columns, rows, 0, 0]. */
export const VFX_INSTANCE_FLOATS = 20;
/** Floats per ribbon vertex: [point, side], [tangent, width], [linear rgb × intensity, a], [core, 0, 0, 0]. */
export const RIBBON_VERTEX_FLOATS = 16;

/** Flag bits: shape (0 circle, 1 square, 2 glow, 3 ring) + 4 × facing (0 camera, 1 velocity, 2 up) + 16 lit + 32 image. */
const SHAPES = { circle: 0, square: 1, glow: 2, ring: 3 } as const;
const FACINGS = { camera: 0, velocity: 1, up: 2 } as const;

export interface VfxItem {
  readonly texture: Texture3d | null;
  readonly blend: 'alpha' | 'additive';
  readonly first: number;
  readonly count: number;
}

export interface VfxRange {
  readonly first: number;
  readonly count: number;
}

export interface VfxPlan {
  readonly instances: Float32Array;
  readonly particles: readonly VfxItem[];
  readonly ribbonVertices: Float32Array;
  /** Vertex ranges in `ribbonVertices`, by blend. */
  readonly ribbons: { readonly alpha: VfxRange; readonly additive: VfxRange };
}

/** The frame's effects packed for the GPU; null when there are none (or none ready to draw). */
export function planVfx(frame: Frame3d, ready: (texture: Texture3d) => boolean): VfxPlan | null {
  const batches = (frame.particles ?? []).filter((b) => b.count > 0 && (b.image === null || ready(b.image)));
  const ribbons = frame.ribbons ?? [];
  if (batches.length === 0 && ribbons.length === 0) return null;

  const total = batches.reduce((n, b) => n + b.count, 0);
  const instances = new Float32Array(Math.max(1, total) * VFX_INSTANCE_FLOATS);
  const particles: VfxItem[] = [];
  let at = 0;
  for (const batch of batches) {
    const flags = SHAPES[batch.shape] + 4 * FACINGS[batch.facing] + (batch.lit ? 16 : 0) + (batch.image !== null ? 32 : 0);
    const k = batch.intensity;
    const d = batch.data;
    for (let i = 0; i < batch.count; i++) {
      const s = i * PARTICLE3D_STRIDE;
      const o = (at + i) * VFX_INSTANCE_FLOATS;
      instances[o] = d[s]!; instances[o + 1] = d[s + 1]!; instances[o + 2] = d[s + 2]!; instances[o + 3] = (d[s + 5]! * Math.PI) / 180;
      instances[o + 4] = d[s + 10]!; instances[o + 5] = d[s + 11]!; instances[o + 6] = d[s + 12]!; instances[o + 7] = batch.soft;
      instances[o + 8] = d[s + 3]!; instances[o + 9] = d[s + 4]!; instances[o + 10] = d[s + 13]!; instances[o + 11] = flags;
      instances[o + 12] = srgbToLinear(d[s + 6]!) * k; instances[o + 13] = srgbToLinear(d[s + 7]!) * k; instances[o + 14] = srgbToLinear(d[s + 8]!) * k;
      instances[o + 15] = d[s + 9]!;
      instances[o + 16] = batch.frames[0]; instances[o + 17] = batch.frames[1];
    }
    particles.push({ texture: batch.image, blend: batch.blend, first: at, count: batch.count });
    at += batch.count;
  }

  const segments = ribbons.reduce((n, r) => n + Math.max(0, r.points.length / RIBBON_STRIDE - 1), 0);
  const ribbonVertices = new Float32Array(Math.max(1, segments * 6) * RIBBON_VERTEX_FLOATS);
  let v = 0;
  const pack = (blend: 'alpha' | 'additive'): VfxRange => {
    const first = v;
    for (const ribbon of ribbons) {
      if (ribbon.blend !== blend) continue;
      const p = ribbon.points;
      const n = p.length / RIBBON_STRIDE;
      const vertex = (i: number, side: number): void => {
        const o = v * RIBBON_VERTEX_FLOATS;
        const s = i * RIBBON_STRIDE;
        const prev = Math.max(0, i - 1) * RIBBON_STRIDE;
        const next = Math.min(n - 1, i + 1) * RIBBON_STRIDE;
        ribbonVertices[o] = p[s]!; ribbonVertices[o + 1] = p[s + 1]!; ribbonVertices[o + 2] = p[s + 2]!; ribbonVertices[o + 3] = side;
        ribbonVertices[o + 4] = p[next]! - p[prev]!; ribbonVertices[o + 5] = p[next + 1]! - p[prev + 1]!; ribbonVertices[o + 6] = p[next + 2]! - p[prev + 2]!;
        ribbonVertices[o + 7] = p[s + 3]!;
        const k = ribbon.intensity;
        ribbonVertices[o + 8] = srgbToLinear(p[s + 4]!) * k; ribbonVertices[o + 9] = srgbToLinear(p[s + 5]!) * k; ribbonVertices[o + 10] = srgbToLinear(p[s + 6]!) * k;
        ribbonVertices[o + 11] = p[s + 7]!;
        ribbonVertices[o + 12] = ribbon.core;
        v++;
      };
      for (let i = 0; i + 1 < n; i++) {
        vertex(i, -1); vertex(i + 1, -1); vertex(i + 1, 1);
        vertex(i, -1); vertex(i + 1, 1); vertex(i, 1);
      }
    }
    return { first, count: v - first };
  };
  const alpha = pack('alpha');
  const additive = pack('additive');
  return { instances, particles, ribbonVertices, ribbons: { alpha, additive } };
}

// ── WGSL ──────────────────────────────────────────────────────────────────────

/** Shared by both passes: the scene's depth along the view axis at a pixel, the fog over a point. */
const WGSL_SCENE = `
@group(2) @binding(0) var sceneDepth: texture_depth_2d;

/** View depth (meters along the camera's forward) of the opaque scene at this pixel; a huge number where there is none (sky). */
fn sceneViewDepth(pixel: vec4<f32>) -> f32 {
  let d = textureLoad(sceneDepth, vec2<i32>(pixel.xy), 0);
  if (d >= 1.0) { return 1e9; }
  let p = frame.inverseViewProjection * vec4<f32>(0.0, 0.0, d, 1.0);
  return dot(p.xyz / p.w - frame.cameraPosition.xyz, frame.cameraForward.xyz);
}

/** How much of a point is hidden by fog and the view-distance fade (0..1). */
fn fogCover(world: vec3<f32>) -> f32 {
  let dist = distance(world, frame.cameraPosition.xyz);
  var f = 0.0;
  if (frame.fogColor.w > 0.5) {
    f = fogAmount((world - frame.cameraPosition.xyz) / max(dist, 1e-4), dist);
  }
  if (frame.viewFade.y > 0.0) {
    f = max(f, clamp((dist - frame.viewFade.x) / max(frame.viewFade.y - frame.viewFade.x, 1e-4), 0.0, 1.0));
  }
  return f;
}

/** Premultiplied output: additive light fades into fog; blended color is covered by it. */
fn finish(rgb: vec3<f32>, a: f32, world: vec3<f32>, additive: bool) -> vec4<f32> {
  if (additive) { return vec4<f32>(rgb * a * (1.0 - fogCover(world)), a); }
  return vec4<f32>(applyFog(rgb, world) * a, a);
}
`;

export function wgslParticles(additive: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}${WGSL_SCENE}
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var imageSampler: sampler;

struct InstanceIn {
  @location(0) centerAngle: vec4<f32>,
  @location(1) stretchSoft: vec4<f32>,
  @location(2) sizeFlags: vec4<f32>,
  @location(3) color: vec4<f32>,
  @location(4) sheet: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) corner: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) @interpolate(flat) look: vec4<f32>,
  @location(4) @interpolate(flat) sheet: vec2<f32>,
  @location(5) @interpolate(flat) right: vec3<f32>,
  @location(6) @interpolate(flat) up: vec3<f32>,
};

@vertex fn vs(@builtin(vertex_index) index: u32, b: InstanceIn) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
  let corner = corners[index];
  let flags = u32(b.sizeFlags.w + 0.5);
  let facing = (flags >> 2u) & 3u;
  var center = b.centerAngle.xyz;
  var size = b.sizeFlags.xy;
  var right = frame.cameraRight.xyz;
  var up = frame.cameraUp.xyz;
  var angle = b.centerAngle.w;
  if (facing == 1u) {
    // Along the velocity as the camera sees it, the streak trailing behind the particle.
    let toCamera = normalize(frame.cameraPosition.xyz - center);
    let along = b.stretchSoft.xyz - toCamera * dot(b.stretchSoft.xyz, toCamera);
    let len = length(along);
    if (len > 1e-5) {
      up = along / len;
      right = normalize(cross(up, toCamera));
      size.y += len;
      center -= up * len * 0.5;
    }
    angle = 0.0;
  } else if (facing == 2u) {
    right = vec3<f32>(1.0, 0.0, 0.0);
    up = vec3<f32>(0.0, 0.0, 1.0);
  }
  let c = cos(angle);
  let s = sin(angle);
  let r = vec3<f32>(right * c + up * s);
  let u = vec3<f32>(up * c - right * s);
  let q = corner * size;
  let world = center + r * q.x + u * q.y;
  var out: VertexOut;
  out.clip = frame.viewProjection * vec4<f32>(world, 1.0);
  out.world = world;
  out.corner = corner;
  out.color = b.color;
  out.look = vec4<f32>(f32(flags), b.sizeFlags.z, b.stretchSoft.w, 0.0);
  out.sheet = b.sheet.xy;
  out.right = r;
  out.up = u;
  return out;
}

fn cell(uv: vec2<f32>, frameIndex: f32, sheet: vec2<f32>) -> vec2<f32> {
  let col = frameIndex - floor(frameIndex / sheet.x) * sheet.x;
  let row = floor(frameIndex / sheet.x);
  return (vec2<f32>(col, row) + clamp(uv, vec2<f32>(0.01), vec2<f32>(0.99))) / sheet;
}

@fragment fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let flags = u32(in.look.x + 0.5);
  let uv = vec2<f32>(in.corner.x + 0.5, 0.5 - in.corner.y);
  // Flipbook: the two frames around the particle's progress, blended (both sampled, in uniform control flow).
  let frames = in.sheet.x * in.sheet.y;
  let f = clamp(in.look.y, 0.0, 1.0) * (frames - 1.0);
  let fa = floor(f);
  let a = textureSample(image, imageSampler, cell(uv, fa, in.sheet));
  let b = textureSample(image, imageSampler, cell(uv, min(fa + 1.0, frames - 1.0), in.sheet));
  var c = in.color * mix(a, b, f - fa);
  let p = in.corner * 2.0;
  let r = length(p);
  if ((flags & 32u) == 0u) {
    let shape = flags & 3u;
    if (shape == 0u) { c.a *= clamp((1.0 - r) * 8.0, 0.0, 1.0); }
    else if (shape == 2u) { let g = clamp(1.0 - r, 0.0, 1.0); c.a *= g * g; }
    else if (shape == 3u) { c.a *= smoothstep(0.45, 0.8, r) * (1.0 - smoothstep(0.8, 1.0, r)); }
  }
  if ((flags & 16u) != 0u) {
    // A rounded puff facing the camera, lit by the sun (wrapped, so the far side isn't black) and the ambient light.
    let toCamera = normalize(frame.cameraPosition.xyz - in.world);
    let n = normalize(in.right * p.x + in.up * p.y + toCamera * sqrt(max(0.0, 1.0 - min(dot(p, p), 1.0))));
    let wrap = dot(n, -frame.sunDirection.xyz) * 0.5 + 0.5;
    c = vec4<f32>(c.rgb * (frame.ambient.rgb + frame.sunColor.rgb * frame.sunDirection.w * (0.2 + 0.8 * wrap) / PI), c.a);
  }
  let gap = sceneViewDepth(in.clip) - dot(in.world - frame.cameraPosition.xyz, frame.cameraForward.xyz);
  if (gap <= 0.0) { discard; }
  if (in.look.z > 0.0) { c.a *= clamp(gap / in.look.z, 0.0, 1.0); }
  if (c.a <= 0.002) { discard; }
  return finish(c.rgb, c.a, in.world, ${additive});
}
`;
}

export function wgslRibbons(additive: boolean): string {
  return `${WGSL_FRAME}${WGSL_COMMON}${WGSL_SCENE}
struct VertexIn {
  @location(0) pointSide: vec4<f32>,
  @location(1) tangentWidth: vec4<f32>,
  @location(2) color: vec4<f32>,
  @location(3) core: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) across: f32,
  @location(2) color: vec4<f32>,
  @location(3) core: f32,
};

@vertex fn vs(v: VertexIn) -> VertexOut {
  let p = v.pointSide.xyz;
  var side = cross(v.tangentWidth.xyz, frame.cameraPosition.xyz - p);
  if (length(side) < 1e-6) { side = frame.cameraUp.xyz; }
  let world = p + normalize(side) * v.tangentWidth.w * 0.5 * v.pointSide.w;
  var out: VertexOut;
  out.clip = frame.viewProjection * vec4<f32>(world, 1.0);
  out.world = world;
  out.across = v.pointSide.w;
  out.color = v.color;
  out.core = v.core.x;
  return out;
}

@fragment fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let x = abs(in.across);
  var rgb = in.color.rgb;
  var a = in.color.a;
  if (in.core > 0.0) {
    // A glow falling off from the center, and a white-hot core.
    let glow = (1.0 - x) * (1.0 - x);
    let hot = 1.0 - smoothstep(in.core * 0.6, in.core, x);
    rgb = mix(rgb, vec3<f32>(max(max(rgb.r, rgb.g), rgb.b)) * 1.2, hot * 0.85);
    a *= max(glow, hot);
  } else {
    a *= 1.0 - smoothstep(0.55, 1.0, x);
  }
  if (sceneViewDepth(in.clip) <= dot(in.world - frame.cameraPosition.xyz, frame.cameraForward.xyz)) { discard; }
  if (a <= 0.002) { discard; }
  return finish(rgb, a, in.world, ${additive});
}
`;
}

// ── GLSL (WebGL2) ─────────────────────────────────────────────────────────────

const GLSL_SCENE = `
uniform sampler2D depthTexture;

float sceneViewDepth() {
  float d = texelFetch(depthTexture, ivec2(gl_FragCoord.xy), 0).r;
  if (d >= 1.0) return 1e9;
  vec4 p = inverseViewProjection * vec4(0.0, 0.0, d, 1.0);
  return dot(p.xyz / p.w - cameraPosition.xyz, cameraForward.xyz);
}

float fogCover(vec3 world) {
  float dist = distance(world, cameraPosition.xyz);
  float f = 0.0;
  if (fogColor.w > 0.5) f = fogAmount((world - cameraPosition.xyz) / max(dist, 1e-4), dist);
  if (viewFade.y > 0.0) f = max(f, clamp((dist - viewFade.x) / max(viewFade.y - viewFade.x, 1e-4), 0.0, 1.0));
  return f;
}

vec4 finish(vec3 rgb, float a, vec3 world, bool additive) {
  if (additive) return vec4(rgb * a * (1.0 - fogCover(world)), a);
  return vec4(applyFog(rgb, world) * a, a);
}
`;

export function glslParticles(additive: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
layout(location = 0) in vec4 centerAngle;
layout(location = 1) in vec4 stretchSoft;
layout(location = 2) in vec4 sizeFlags;
layout(location = 3) in vec4 color;
layout(location = 4) in vec4 sheet;
out vec3 vWorld;
out vec2 vCorner;
out vec4 vColor;
flat out vec4 vLook;
flat out vec2 vSheet;
flat out vec3 vRight;
flat out vec3 vUp;
void main() {
  vec2 corners[6] = vec2[6](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5));
  vec2 corner = corners[gl_VertexID];
  int flags = int(sizeFlags.w + 0.5);
  int facing = (flags >> 2) & 3;
  vec3 center = centerAngle.xyz;
  vec2 size = sizeFlags.xy;
  vec3 right = cameraRight.xyz;
  vec3 up = cameraUp.xyz;
  float angle = centerAngle.w;
  if (facing == 1) {
    vec3 toCamera = normalize(cameraPosition.xyz - center);
    vec3 along = stretchSoft.xyz - toCamera * dot(stretchSoft.xyz, toCamera);
    float len = length(along);
    if (len > 1e-5) {
      up = along / len;
      right = normalize(cross(up, toCamera));
      size.y += len;
      center -= up * len * 0.5;
    }
    angle = 0.0;
  } else if (facing == 2) {
    right = vec3(1.0, 0.0, 0.0);
    up = vec3(0.0, 0.0, 1.0);
  }
  float c = cos(angle);
  float s = sin(angle);
  vec3 r = right * c + up * s;
  vec3 u = up * c - right * s;
  vec2 q = corner * size;
  vec3 world = center + r * q.x + u * q.y;
  vWorld = world;
  vCorner = corner;
  vColor = color;
  vLook = vec4(float(flags), sizeFlags.z, stretchSoft.w, 0.0);
  vSheet = sheet.xy;
  vRight = r;
  vUp = u;
  gl_Position = viewProjection * vec4(world, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${GLSL_COMMON}${GLSL_SCENE}
uniform sampler2D image;
in vec3 vWorld;
in vec2 vCorner;
in vec4 vColor;
flat in vec4 vLook;
flat in vec2 vSheet;
flat in vec3 vRight;
flat in vec3 vUp;
out vec4 fragColor;

vec2 cell(vec2 uv, float frameIndex, vec2 sheet) {
  float col = frameIndex - floor(frameIndex / sheet.x) * sheet.x;
  float row = floor(frameIndex / sheet.x);
  return (vec2(col, row) + clamp(uv, vec2(0.01), vec2(0.99))) / sheet;
}

void main() {
  int flags = int(vLook.x + 0.5);
  vec2 uv = vec2(vCorner.x + 0.5, 0.5 - vCorner.y);
  float frames = vSheet.x * vSheet.y;
  float f = clamp(vLook.y, 0.0, 1.0) * (frames - 1.0);
  float fa = floor(f);
  vec4 c = vColor * mix(texture(image, cell(uv, fa, vSheet)), texture(image, cell(uv, min(fa + 1.0, frames - 1.0), vSheet)), f - fa);
  vec2 p = vCorner * 2.0;
  float r = length(p);
  if ((flags & 32) == 0) {
    int shape = flags & 3;
    if (shape == 0) c.a *= clamp((1.0 - r) * 8.0, 0.0, 1.0);
    else if (shape == 2) { float g = clamp(1.0 - r, 0.0, 1.0); c.a *= g * g; }
    else if (shape == 3) c.a *= smoothstep(0.45, 0.8, r) * (1.0 - smoothstep(0.8, 1.0, r));
  }
  if ((flags & 16) != 0) {
    vec3 toCamera = normalize(cameraPosition.xyz - vWorld);
    vec3 n = normalize(vRight * p.x + vUp * p.y + toCamera * sqrt(max(0.0, 1.0 - min(dot(p, p), 1.0))));
    float wrap = dot(n, -sunDirection.xyz) * 0.5 + 0.5;
    c.rgb *= ambient.rgb + sunColor.rgb * sunDirection.w * (0.2 + 0.8 * wrap) / PI;
  }
  float gap = sceneViewDepth() - dot(vWorld - cameraPosition.xyz, cameraForward.xyz);
  if (gap <= 0.0) discard;
  if (vLook.z > 0.0) c.a *= clamp(gap / vLook.z, 0.0, 1.0);
  if (c.a <= 0.002) discard;
  fragColor = finish(c.rgb, c.a, vWorld, ${additive});
}
`,
  };
}

export function glslRibbons(additive: boolean): GlslProgram {
  return {
    vertex: `${GLSL_HEADER}${GLSL_FRAME}
layout(location = 0) in vec4 pointSide;
layout(location = 1) in vec4 tangentWidth;
layout(location = 2) in vec4 color;
layout(location = 3) in vec4 core;
out vec3 vWorld;
out float vAcross;
out vec4 vColor;
flat out float vCore;
void main() {
  vec3 p = pointSide.xyz;
  vec3 side = cross(tangentWidth.xyz, cameraPosition.xyz - p);
  if (length(side) < 1e-6) side = cameraUp.xyz;
  vec3 world = p + normalize(side) * tangentWidth.w * 0.5 * pointSide.w;
  vWorld = world;
  vAcross = pointSide.w;
  vColor = color;
  vCore = core.x;
  gl_Position = viewProjection * vec4(world, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`,
    fragment: `${GLSL_HEADER}${GLSL_FRAME}${GLSL_COMMON}${GLSL_SCENE}
in vec3 vWorld;
in float vAcross;
in vec4 vColor;
flat in float vCore;
out vec4 fragColor;
void main() {
  float x = abs(vAcross);
  vec3 rgb = vColor.rgb;
  float a = vColor.a;
  if (vCore > 0.0) {
    float glow = (1.0 - x) * (1.0 - x);
    float hot = 1.0 - smoothstep(vCore * 0.6, vCore, x);
    rgb = mix(rgb, vec3(max(max(rgb.r, rgb.g), rgb.b)) * 1.2, hot * 0.85);
    a *= max(glow, hot);
  } else {
    a *= 1.0 - smoothstep(0.55, 1.0, x);
  }
  if (sceneViewDepth() <= dot(vWorld - cameraPosition.xyz, cameraForward.xyz)) discard;
  if (a <= 0.002) discard;
  fragColor = finish(rgb, a, vWorld, ${additive});
}
`,
  };
}
