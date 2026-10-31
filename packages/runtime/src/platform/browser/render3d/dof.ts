/**
 * Depth of field: its own per-view pass, after the scene's transparent surfaces and screen
 * light (so particles and fog blur too) and before outlines, bloom and the final grade. It
 * runs only for views whose camera has a DepthOfField (`View3d.depthOfField`).
 *
 *   copy   the view's rectangle of the HDR color into the pass's own copy
 *   blur   per pixel, a golden-angle disc of `samples` taps over the copy, each weighted by
 *          its own circle of confusion (a scatter-as-gather blur): a tap spreads onto this
 *          pixel when its blur radius reaches this far; taps behind the pixel spread at most
 *          twice the pixel's own radius, so sharp subjects don't take in the background
 *          while blurred foreground still spreads over them. Written back into the HDR color.
 *
 * Circle of confusion: clamp(|viewDepth - focusDistance| / focusRange, 0, 1) × maxBlur, in
 * pixels (maxBlur is given at 1080p and scaled by the view's height). View depth is the
 * world position (rebuilt from the depth buffer through the inverse view-projection)
 * along the camera's forward axis, so orthographic views work too.
 *
 * WGSL and GLSL side by side; both read top-left pixel coordinates (see post_shaders.ts).
 * The uniform block (`DOF_FLOATS`): inverseViewProjection, eye (xyz, focusDistance),
 * forward (xyz, focusRange), viewport (x, y, w, h), targetSize (w, h, 1/w, 1/h), params
 * (maxBlur px, 0, 0, 0).
 */

import type { DepthOfField3d, Quality3d, View3d } from '../../../core/index.js';

export const DOF_FLOATS = 36;
/** The blur's largest radius in pixels, whatever the screen. */
export const DOF_MAX_RADIUS = 48;
/** Taps per pixel by quality level. */
export const DOF_SAMPLES: Readonly<Record<Quality3d['level'], number>> = { low: 12, medium: 20, high: 32 };

/** One view's depth-of-field pass, packed for either backend. */
export interface DofPlan {
  readonly uniforms: Float32Array;
  readonly samples: number;
}

/** The view's pass, or null when it blurs nothing (no DepthOfField, a mirror, wireframe). */
export function planDepthOfField(view: View3d, quality: Quality3d, wireframe: boolean, width: number, height: number): DofPlan | null {
  const dof: DepthOfField3d | null | undefined = view.depthOfField;
  if (dof === null || dof === undefined || wireframe || view.mirrored === true) return null;
  const blur = Math.min(DOF_MAX_RADIUS, dof.maxBlur * (view.viewport.height / 1080));
  if (!(blur >= 0.5)) return null;
  const u = new Float32Array(DOF_FLOATS);
  u.set(view.inverseViewProjection, 0);
  u.set([...view.position, Math.max(0, dof.focusDistance)], 16);
  u.set([...view.forward, Math.max(0.01, dof.focusRange)], 20);
  u.set([view.viewport.x, view.viewport.y, view.viewport.width, view.viewport.height], 24);
  u.set([width, height, 1 / width, 1 / height], 28);
  u.set([blur, 0, 0, 0], 32);
  return { uniforms: u, samples: DOF_SAMPLES[quality.level] };
}

const WGSL_BLOCK = `
struct Dof {
  inverseViewProjection: mat4x4<f32>,
  eye: vec4<f32>,
  forward: vec4<f32>,
  viewport: vec4<f32>,
  targetSize: vec4<f32>,
  params: vec4<f32>,
};
`;

const WGSL_VS = `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(corners[index], 0.0, 1.0);
}
`;

/** Copy the HDR color (the view's rectangle, by scissor) into the pass's copy. */
export const WGSL_DOF_COPY = `${WGSL_VS}
@group(0) @binding(0) var source: texture_2d<f32>;

@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(source, vec2<i32>(floor(position.xy)), 0);
}
`;

/** The blur, with `samples` taps. */
export function wgslDof(samples: number): string {
  return `${WGSL_BLOCK}${WGSL_VS}
const SAMPLES: i32 = ${samples};
const GOLDEN: f32 = 2.39996323;

@group(0) @binding(0) var<uniform> dof: Dof;
@group(0) @binding(1) var colorTexture: texture_2d<f32>;
@group(0) @binding(2) var depthTexture: texture_depth_2d;
@group(0) @binding(3) var linearSampler: sampler;

fn texelOf(p: vec2<f32>) -> vec2<i32> {
  return clamp(vec2<i32>(floor(p)), vec2<i32>(0), vec2<i32>(dof.targetSize.xy) - vec2<i32>(1));
}

fn viewDepthAt(p: vec2<f32>) -> f32 {
  let d: f32 = textureLoad(depthTexture, texelOf(p), 0);
  let l: vec2<f32> = (p - dof.viewport.xy) / dof.viewport.zw;
  let h: vec4<f32> = dof.inverseViewProjection * vec4<f32>(l.x * 2.0 - 1.0, 1.0 - l.y * 2.0, d, 1.0);
  return dot(h.xyz / h.w - dof.eye.xyz, dof.forward.xyz);
}

fn cocOf(depth: f32) -> f32 {
  return clamp(abs(depth - dof.eye.w) / dof.forward.w, 0.0, 1.0) * dof.params.x;
}

@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let p: vec2<f32> = position.xy;
  let center: vec4<f32> = textureSampleLevel(colorTexture, linearSampler, p * dof.targetSize.zw, 0.0);
  let centerDepth: f32 = viewDepthAt(p);
  let centerCoc: f32 = cocOf(centerDepth);
  let lo: vec2<f32> = dof.viewport.xy + vec2<f32>(0.5);
  let hi: vec2<f32> = dof.viewport.xy + dof.viewport.zw - vec2<f32>(0.5);
  var color: vec3<f32> = center.rgb;
  var total: f32 = 1.0;
  for (var i: i32 = 1; i < SAMPLES; i = i + 1) {
    let f: f32 = f32(i);
    let r: f32 = sqrt(f / f32(SAMPLES)) * dof.params.x;
    let a: f32 = f * GOLDEN;
    let q: vec2<f32> = clamp(p + vec2<f32>(cos(a), sin(a)) * r, lo, hi);
    let depth: f32 = viewDepthAt(q);
    var size: f32 = cocOf(depth);
    if (depth > centerDepth) { size = min(size, centerCoc * 2.0); }
    let m: f32 = smoothstep(r - 0.5, r + 0.5, size);
    let tap: vec3<f32> = textureSampleLevel(colorTexture, linearSampler, q * dof.targetSize.zw, 0.0).rgb;
    color = color + mix(color / total, tap, m);
    total = total + 1.0;
  }
  return vec4<f32>(color / total, center.a);
}
`;
}

const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const GLSL_VS = `${GLSL_HEADER}
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`;

/** The copy, GLSL. */
export const GLSL_DOF_COPY = {
  vertex: GLSL_VS,
  fragment: `${GLSL_HEADER}
uniform sampler2D source;
out vec4 outColor;
void main() {
  outColor = texelFetch(source, ivec2(gl_FragCoord.xy), 0);
}
`,
};

/** The blur, GLSL (the same text as `wgslDof`, in WebGL2's row order). */
export function glslDof(samples: number): { vertex: string; fragment: string } {
  return {
    vertex: GLSL_VS,
    fragment: `${GLSL_HEADER}
const int SAMPLES = ${samples};
const float GOLDEN = 2.39996323;
uniform mat4 inverseViewProjection;
uniform vec4 eye;
uniform vec4 forward;
uniform vec4 viewport;
uniform vec4 targetSize;
uniform vec4 params;
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
out vec4 outColor;

// p: top-left pixel coordinates; textures have row 0 at the bottom.
vec2 uvOf(vec2 p) {
  return vec2(p.x, targetSize.y - p.y) * targetSize.zw;
}

float viewDepthAt(vec2 p) {
  ivec2 texel = clamp(ivec2(floor(vec2(p.x, targetSize.y - p.y))), ivec2(0), ivec2(targetSize.xy) - ivec2(1));
  float d = texelFetch(depthTexture, texel, 0).r;
  vec2 l = (p - viewport.xy) / viewport.zw;
  vec4 h = inverseViewProjection * vec4(l.x * 2.0 - 1.0, 1.0 - l.y * 2.0, d, 1.0);
  return dot(h.xyz / h.w - eye.xyz, forward.xyz);
}

float cocOf(float depth) {
  return clamp(abs(depth - eye.w) / forward.w, 0.0, 1.0) * params.x;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y);
  vec4 center = textureLod(colorTexture, uvOf(p), 0.0);
  float centerDepth = viewDepthAt(p);
  float centerCoc = cocOf(centerDepth);
  vec2 lo = viewport.xy + vec2(0.5);
  vec2 hi = viewport.xy + viewport.zw - vec2(0.5);
  vec3 color = center.rgb;
  float total = 1.0;
  for (int i = 1; i < SAMPLES; i++) {
    float f = float(i);
    float r = sqrt(f / float(SAMPLES)) * params.x;
    float a = f * GOLDEN;
    vec2 q = clamp(p + vec2(cos(a), sin(a)) * r, lo, hi);
    float depth = viewDepthAt(q);
    float size = cocOf(depth);
    if (depth > centerDepth) size = min(size, centerCoc * 2.0);
    float m = smoothstep(r - 0.5, r + 0.5, size);
    vec3 tap = textureLod(colorTexture, uvOf(q), 0.0).rgb;
    color += mix(color / total, tap, m);
    total += 1.0;
  }
  outColor = vec4(color / total, center.a);
}
`,
  };
}
