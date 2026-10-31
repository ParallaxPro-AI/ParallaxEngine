/**
 * Full-screen passes, WGSL and GLSL side by side: the per-view screen-space passes (AO,
 * reflections, resolve, volumetric fog, god rays, final), the whole-target ones (bloom,
 * present) and the environment cube's (sky faces, GGX prefilter). Each pass's textures are
 * declared once in `POST_BINDINGS`; both languages' declarations are generated from it.
 *
 * Coordinates: every per-view pass works in top-left pixel coordinates of the full target
 * (`p`): WGSL's `position.xy`, GLSL's `(gl_FragCoord.x, height - gl_FragCoord.y)`. The
 * helpers `uvOf` (a sampling uv for a pixel) and `texelOf` (an integer texel) hide the row
 * order difference; everything else is the same text in both languages.
 *
 * WebGPU bind groups: per-view passes take the frame group (group 0, as the scene passes)
 * and their own textures in group 1; whole-target passes have one group of their own.
 */

import { EXPOSURE_CALIBRATION, FRAME_FIELDS, glslBlock, slotFloats, wgslStruct } from './layout.js';
import type { UniformField } from './layout.js';
import {
  AGX_CURVE, AGX_INSET, AGX_OUTSET, GLSL_COMMON, GLSL_DEPTH_REMAP, GLSL_FRAME, GLSL_HEADER, GLSL_SHADOWS, WGSL_COMMON, WGSL_FRAME, WGSL_SHADOWS,
} from './shaders.js';
import type { GlslProgram } from './shaders.js';


export const POST_PASSES = [
  'ao', 'aoBlur', 'reflections', 'resolve', 'volumetric', 'godRays', 'fogOfWar', 'final', 'bloomPrefilter', 'bloomDown', 'bloomUp', 'present', 'envSky',
  'envPrefilter',
] as const;
export type PostPass = (typeof POST_PASSES)[number];

/** Passes drawn per view, with the frame bind group (group 0). */
export const VIEW_PASSES: readonly PostPass[] = ['ao', 'aoBlur', 'reflections', 'resolve', 'volumetric', 'godRays', 'fogOfWar', 'final'];

export type PostBindingKind = 'depth' | 'float' | 'cube' | 'linear' | 'env';

export interface PostBinding {
  readonly name: string;
  readonly kind: PostBindingKind;
}

const tex = (name: string): PostBinding => ({ name, kind: 'float' });
const depth: PostBinding = { name: 'depthTexture', kind: 'depth' };
const linear: PostBinding = { name: 'linearSampler', kind: 'linear' };

/** Each pass's own bindings, in binding order (WebGPU group 1 for view passes, group 0 otherwise). */
export const POST_BINDINGS: Readonly<Record<PostPass, readonly PostBinding[]>> = {
  ao: [depth, tex('gbufTexture')],
  aoBlur: [tex('aoTexture'), depth, linear],
  reflections: [depth, tex('gbufTexture'), tex('hdrTexture'), linear],
  resolve: [tex('hdrTexture'), tex('aoTexture'), tex('ssrTexture'), tex('gbufTexture'), depth, linear],
  volumetric: [depth],
  godRays: [depth],
  fogOfWar: [depth, tex('fogTexture'), linear],
  final: [tex('hdrTexture'), tex('bloomTexture'), depth, tex('gbufTexture'), tex('maskTexture'), linear],
  bloomPrefilter: [tex('sourceTexture'), linear],
  bloomDown: [tex('sourceTexture'), linear],
  bloomUp: [tex('sourceTexture'), linear],
  present: [tex('sourceTexture'), linear],
  envSky: [{ name: 'env', kind: 'env' }, tex('skyImage'), linear],
  envPrefilter: [{ name: 'env', kind: 'env' }, { name: 'skyCube', kind: 'cube' }, linear],
};

/** The environment cube passes' uniform block (one slot per face and mip). */
export const ENV_FIELDS: readonly UniformField[] = [
  /** face (0..5: +x, -x, +y, -y, +z, -z), roughness, face size in texels, sample count. */
  { name: 'envParams', kind: 'vec4' },
  { name: 'envZenith', kind: 'vec4' },
  { name: 'envHorizon', kind: 'vec4' },
  /** Skybox panorama: on (0/1), turn (fraction of a circle), light multiplier, unused. */
  { name: 'envSkybox', kind: 'vec4' },
];
export const ENV_SLOT = slotFloats(ENV_FIELDS);

/** Hemisphere sample kernel for AO (z along the normal), lengths growing toward the edge. */
export function aoKernel(count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (i + 0.5) / count;
    const r = Math.sqrt(1 - z * z);
    const a = golden * i;
    const f = (i + 1) / count;
    const scale = 0.15 + 0.85 * f * f;
    out.push([Math.cos(a) * r * scale, Math.sin(a) * r * scale, Math.max(0.15, z) * scale]);
  }
  return out;
}

const num = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${+n.toFixed(6)}`);

// ── Pass bodies, written once over a tiny dialect, then specialized ──────────
//
// The bodies below are WGSL. GLSL is produced by `toGlsl`, which rewrites the few
// constructs that differ (types, declarations, texture calls). Keeping one source makes
// the two languages agree by construction; `toGlsl` refuses anything it doesn't know.

/**
 * WGSL → GLSL for the dialect the post bodies use: every `let`/`var` carries its type,
 * functions are declared before use, and only these builtins differ between the languages.
 * Anything it can't translate (an untyped declaration) throws, so a body that would compile
 * in one language only fails its test instead of a browser.
 */
export function toGlsl(source: string): string {
  let s = source;
  s = s.replace(/vec([234])<f32>/g, 'vec$1').replace(/vec([234])<i32>/g, 'ivec$1').replace(/vec([234])<u32>/g, 'uvec$1');
  s = s.replace(/mat3x3<f32>/g, 'mat3').replace(/mat4x4<f32>/g, 'mat4');
  s = s.replace(/\b(?:let|var) (\w+): array<(\w+), (\d+)> = array<\w+, \d+>\(/g, '$2 $1[$3] = $2[$3](');
  s = s.replace(/\bf32\b/g, 'float').replace(/\bi32\b/g, 'int').replace(/\bu32\b/g, 'uint');
  // fn name(a: T, b: U) -> R {   →   R name(T a, U b) {
  s = s.replace(/fn (\w+)\(([^)]*)\)(?: -> (\w+))? \{/g, (_m, name: string, params: string, ret: string | undefined) => {
    const list = params.trim() === '' ? '' : params.split(',').map((param) => {
      const [n, t] = param.split(':').map((x) => x.trim());
      return `${t} ${n}`;
    }).join(', ');
    return `${ret ?? 'void'} ${name}(${list}) {`;
  });
  s = s.replace(/\b(?:let|var) (\w+): (\w+) = /g, '$2 $1 = ');
  s = s.replace(/\bvar (\w+): (\w+);/g, '$2 $1;');
  s = s.replace(/for \(var (\w+) = (\d+); /g, 'for (int $1 = $2; ');
  s = s.replace(/textureSampleLevel\((\w+), \w+, /g, 'textureLod($1, ');
  s = s.replace(/textureLoad\((\w+), /g, 'texelFetch($1, ');
  s = s.replace(/textureDimensions\(/g, 'textureSize(');
  s = s.replace(/\bframe\./g, '').replace(/\benv\./g, '');
  s = s.replace(/inverseSqrt/g, 'inversesqrt');
  s = s.replace(/\batan2\(/g, 'atan(');
  const left = /.*\b(let|var) .*/.exec(s);
  if (left !== null) throw new Error(`toGlsl: untyped declaration: ${left[0].trim()}`);
  return s;
}

const WGSL_POST_VS = `
struct FullOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) index: u32) -> FullOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: FullOut;
  out.clip = vec4<f32>(corners[index], 0.0, 1.0);
  out.uv = vec2<f32>(corners[index].x * 0.5 + 0.5, 0.5 - corners[index].y * 0.5);
  return out;
}
`;

const GLSL_POST_VS = `${GLSL_HEADER}
out vec2 vUv;
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vUv = corners[gl_VertexID] * 0.5 + 0.5;
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
  ${GLSL_DEPTH_REMAP}
}
`;

/** Pixel helpers in each language (see the module doc). */
const WGSL_PIXELS = `
fn uvOf(p: vec2<f32>) -> vec2<f32> {
  return p * frame.targetSize.zw;
}

fn texelOf(p: vec2<f32>) -> vec2<i32> {
  return clamp(vec2<i32>(floor(p)), vec2<i32>(0), vec2<i32>(frame.targetSize.xy) - vec2<i32>(1));
}
`;

const GLSL_PIXELS = `
vec2 uvOf(vec2 p) {
  return vec2(p.x, targetSize.y - p.y) * targetSize.zw;
}

ivec2 texelOf(vec2 p) {
  return clamp(ivec2(floor(vec2(p.x, targetSize.y - p.y))), ivec2(0), ivec2(targetSize.xy) - ivec2(1));
}
`;

/** Shared post helpers, written in the WGSL dialect `toGlsl` translates. */
const POST_HELPERS = `
fn ndcOf(p: vec2<f32>) -> vec2<f32> {
  let l: vec2<f32> = (p - frame.viewport.xy) / frame.viewport.zw;
  return vec2<f32>(l.x * 2.0 - 1.0, 1.0 - l.y * 2.0);
}

fn worldAt(p: vec2<f32>, d: f32) -> vec3<f32> {
  let h: vec4<f32> = frame.inverseViewProjection * vec4<f32>(ndcOf(p), d, 1.0);
  return h.xyz / h.w;
}

fn viewDepthOf(world: vec3<f32>) -> f32 {
  return dot(world - frame.cameraPosition.xyz, frame.cameraForward.xyz);
}

fn pixelOfNdc(ndc: vec2<f32>) -> vec2<f32> {
  return frame.viewport.xy + vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * frame.viewport.zw;
}

fn noiseAt(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}
`;

const DEPTH_HELPERS = `
fn depthAt(p: vec2<f32>) -> f32 {
  return textureLoad(depthTexture, texelOf(p), 0)DEPTH_SWIZZLE;
}
`;

const ENV_BRDF = `
fn envBrdfScalar(f0: f32, roughness: f32, nv: f32) -> f32 {
  let c0: vec4<f32> = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
  let c1: vec4<f32> = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let r: vec4<f32> = roughness * c0 + c1;
  let a004: f32 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  let ab: vec2<f32> = vec2<f32>(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}
`;

/**
 * AgX, the minimal fit, exactly as the old renderer applied it (no "punchy" power or saturation on the
 * curve's output): its pale, open shadows and gentle saturation are what every template was tuned
 * against. (The punchy variant with 1.5× pre-exposure read darker, warmer and more saturated, with hot
 * light pools, for the same scene values.)
 */
const AGX = `
fn agx(c: vec3<f32>) -> vec3<f32> {
  let inset: mat3x3<f32> = mat3x3<f32>(${AGX_INSET});
  let outset: mat3x3<f32> = mat3x3<f32>(${AGX_OUTSET});
  var x: vec3<f32> = inset * max(c, vec3<f32>(0.0));
  x = clamp(log2(max(x, vec3<f32>(1e-10))), vec3<f32>(-12.47393), vec3<f32>(4.026069));
  x = (x + vec3<f32>(12.47393)) / 16.499999;
  let x2: vec3<f32> = x * x;
  let x4: vec3<f32> = x2 * x2;
  x = ${AGX_CURVE};
  return clamp(outset * x, vec3<f32>(0.0), vec3<f32>(1.0));
}
`;

function aoBody(scale: number, samples: number): string {
  const kernel = aoKernel(samples).map(([x, y, z]) => `vec3<f32>(${num(x)}, ${num(y)}, ${num(z)})`).join(', ');
  return `
fn fragment(pin: vec2<f32>) -> vec4<f32> {
  let p: vec2<f32> = pin * ${num(scale)};
  let d: f32 = depthAt(p);
  if (d >= 1.0) { return vec4<f32>(1.0); }
  let world: vec3<f32> = worldAt(p, d);
  let n: vec3<f32> = octDecode(textureLoad(gbufTexture, texelOf(p), 0).xy);
  let center: f32 = viewDepthOf(world);
  let radius: f32 = clamp(center * 0.04, 0.25, 1.5);
  var helper: vec3<f32> = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(n.y) > 0.9) { helper = vec3<f32>(1.0, 0.0, 0.0); }
  let a: f32 = noiseAt(pin) * 6.2831853;
  let t0: vec3<f32> = normalize(cross(helper, n));
  let b0: vec3<f32> = cross(n, t0);
  let t: vec3<f32> = t0 * cos(a) + b0 * sin(a);
  let b: vec3<f32> = cross(n, t);
  var kernel: array<vec3<f32>, ${samples}> = array<vec3<f32>, ${samples}>(${kernel});
  var occluded: f32 = 0.0;
  for (var i = 0; i < ${samples}; i++) {
    let k: vec3<f32> = kernel[i];
    let s: vec3<f32> = world + (t * k.x + b * k.y + n * k.z) * radius;
    let clip: vec4<f32> = frame.viewProjection * vec4<f32>(s, 1.0);
    if (clip.w > 0.0) {
      let sp: vec2<f32> = pixelOfNdc(clip.xy / clip.w);
      let scene: f32 = viewDepthOf(worldAt(sp, depthAt(sp)));
      if (scene < viewDepthOf(s) - 0.03) {
        occluded += smoothstep(0.0, 1.0, radius / max(abs(center - scene), 1e-3));
      }
    }
  }
  return vec4<f32>(1.0 - occluded / ${num(samples)}, 0.0, 0.0, 1.0);
}
`;
}

function aoBlurBody(scale: number): string {
  return `
fn fragment(pin: vec2<f32>) -> vec4<f32> {
  let p: vec2<f32> = pin * ${num(scale)};
  let center: f32 = viewDepthOf(worldAt(p, depthAt(p)));
  var total: f32 = 0.0;
  var weight: f32 = 0.0;
  for (var x = 0; x < 4; x++) {
    for (var y = 0; y < 4; y++) {
      let q: vec2<f32> = p + (vec2<f32>(f32(x), f32(y)) - vec2<f32>(1.5)) * ${num(scale)};
      let w: f32 = 1.0 / (1.0 + abs(viewDepthOf(worldAt(q, depthAt(q))) - center) * 8.0);
      total += textureSampleLevel(aoTexture, linearSampler, uvOf(q), 0.0).r * w;
      weight += w;
    }
  }
  return vec4<f32>(total / weight, 0.0, 0.0, 1.0);
}
`;
}

const REFLECTIONS_BODY = `
fn fragment(p: vec2<f32>) -> vec4<f32> {
  let d: f32 = depthAt(p);
  if (d >= 1.0) { return vec4<f32>(0.0); }
  let g: vec4<f32> = textureLoad(gbufTexture, texelOf(p), 0);
  let roughness: f32 = g.z;
  if (roughness > 0.6 || g.w < 0.02) { return vec4<f32>(0.0); }
  let world: vec3<f32> = worldAt(p, d);
  let n: vec3<f32> = octDecode(g.xy);
  let v: vec3<f32> = normalize(frame.cameraPosition.xyz - world);
  let r: vec3<f32> = reflect(-v, n);
  var stride: f32 = 0.08 + viewDepthOf(world) * 0.004;
  var t: f32 = stride;
  var hit: vec4<f32> = vec4<f32>(0.0);
  for (var i = 0; i < 32; i++) {
    let s: vec3<f32> = world + r * t;
    let clip: vec4<f32> = frame.viewProjection * vec4<f32>(s, 1.0);
    if (clip.w <= 0.0) { break; }
    let ndc: vec2<f32> = clip.xy / clip.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { break; }
    let sp: vec2<f32> = pixelOfNdc(ndc);
    let scene: f32 = viewDepthOf(worldAt(sp, depthAt(sp)));
    let ray: f32 = viewDepthOf(s);
    if (ray > scene + 0.01 && ray - scene < stride * 2.0 + 0.1) {
      var lo: f32 = t - stride;
      var hi: f32 = t;
      for (var j = 0; j < 5; j++) {
        let mid: f32 = (lo + hi) * 0.5;
        let ms: vec3<f32> = world + r * mid;
        let mc: vec4<f32> = frame.viewProjection * vec4<f32>(ms, 1.0);
        let mp: vec2<f32> = pixelOfNdc(mc.xy / mc.w);
        if (viewDepthOf(ms) > viewDepthOf(worldAt(mp, depthAt(mp)))) { hi = mid; } else { lo = mid; }
      }
      let fc: vec4<f32> = frame.viewProjection * vec4<f32>(world + r * hi, 1.0);
      let fndc: vec2<f32> = fc.xy / fc.w;
      let hp: vec2<f32> = pixelOfNdc(fndc);
      let facing: f32 = dot(octDecode(textureLoad(gbufTexture, texelOf(hp), 0).xy), r);
      if (facing < 0.0) {
        let edge: f32 = clamp((1.0 - max(abs(fndc.x), abs(fndc.y))) * 8.0, 0.0, 1.0);
        let confidence: f32 = edge * (1.0 - smoothstep(0.25, 0.6, roughness)) * (1.0 - f32(i) / 32.0);
        hit = vec4<f32>(textureSampleLevel(hdrTexture, linearSampler, uvOf(hp), 0.0).rgb, confidence);
      }
      break;
    }
    t += stride;
    stride *= 1.12;
  }
  return hit;
}
`;

const RESOLVE_BODY = `
fn fragment(p: vec2<f32>) -> vec4<f32> {
  let color: vec4<f32> = textureLoad(hdrTexture, texelOf(p), 0);
  let uv: vec2<f32> = uvOf(p);
  let ao: f32 = textureSampleLevel(aoTexture, linearSampler, uv, 0.0).r;
  var result: vec3<f32> = color.rgb * (1.0 - (1.0 - ao) * clamp(color.a, 0.0, 1.0) * frame.postC.z);
  let ssr: vec4<f32> = textureSampleLevel(ssrTexture, linearSampler, uv, 0.0);
  if (ssr.a > 0.0) {
    let g: vec4<f32> = textureLoad(gbufTexture, texelOf(p), 0);
    let world: vec3<f32> = worldAt(p, depthAt(p));
    let n: vec3<f32> = octDecode(g.xy);
    let v: vec3<f32> = normalize(frame.cameraPosition.xyz - world);
    let env: vec3<f32> = textureSampleLevel(envCube, envSampler, reflect(-v, n), g.z * frame.sh2.y).rgb * frame.ambient.w;
    result += (ssr.rgb - env) * envBrdfScalar(g.w, g.z, max(dot(n, v), 1e-4)) * ssr.a;
  }
  return vec4<f32>(max(result, vec3<f32>(0.0)), color.a);
}
`;

function volumetricBody(steps: number): string {
  return `
fn fragment(p: vec2<f32>) -> vec4<f32> {
  let end: vec3<f32> = worldAt(p, min(depthAt(p), 0.999999));
  let start: vec3<f32> = frame.cameraPosition.xyz;
  let dir: vec3<f32> = normalize(end - start);
  let dist: f32 = min(distance(end, start), 160.0);
  var sigma: f32 = frame.fogParams.x;
  if (frame.fogColor.w > 1.5) { sigma = 3.0 / max(frame.fogParams.z, 1.0); }
  let scatter: f32 = sigma * frame.fogParams.w * 0.5;
  let g: f32 = 0.6;
  let cosTheta: f32 = dot(dir, -frame.sunDirection.xyz);
  let phase: f32 = (1.0 - g * g) / (12.566371 * pow(1.0 + g * g - 2.0 * g * cosTheta, 1.5));
  let stride: f32 = dist / ${num(steps)};
  let jitter: f32 = noiseAt(p);
  var light: f32 = 0.0;
  var transmittance: f32 = 1.0;
  for (var i = 0; i < ${steps}; i++) {
    let s: vec3<f32> = start + dir * (f32(i) + jitter) * stride;
    light += transmittance * sunShadow(s, vec3<f32>(0.0), false) * scatter * stride;
    transmittance *= exp(-sigma * stride);
  }
  return vec4<f32>(frame.sunColor.rgb * phase * light, 0.0);
}
`;
}

function godRaysBody(samples: number): string {
  return `
fn fragment(p: vec2<f32>) -> vec4<f32> {
  let sun: vec4<f32> = frame.sunScreen;
  if (sun.z <= 0.0) { return vec4<f32>(0.0); }
  let local: vec2<f32> = (p - frame.viewport.xy) / frame.viewport.zw;
  let aspect: f32 = frame.viewport.z / frame.viewport.w;
  let delta: vec2<f32> = (sun.xy - local) / ${num(samples)};
  var coord: vec2<f32> = local + delta * noiseAt(p);
  var light: f32 = 0.0;
  var decay: f32 = 1.0;
  for (var i = 0; i < ${samples}; i++) {
    coord += delta;
    let sp: vec2<f32> = frame.viewport.xy + clamp(coord, vec2<f32>(0.0), vec2<f32>(1.0)) * frame.viewport.zw;
    let off: vec2<f32> = (coord - sun.xy) * vec2<f32>(aspect, 1.0);
    light += step(0.999999, depthAt(sp)) * decay * exp(-dot(off, off) * 6.0);
    decay *= 0.97;
  }
  return vec4<f32>(frame.sunColor.rgb * (light / ${num(samples)}) * frame.postC.w * sun.z, 0.0);
}
`;
}

/**
 * Fog of war over the ground: each pixel's world position (from depth; the sky gets none)
 * looks up its team's cell (0 seen now, 0.5 explored, 1 unexplored; filtered for soft
 * edges) and is covered by the explored or unexplored color by that much, premultiplied over
 * the scene. Outside the grid is unexplored.
 */
const FOG_OF_WAR_BODY = `
fn fragment(p: vec2<f32>) -> vec4<f32> {
  let d: f32 = depthAt(p);
  if (d >= 1.0) { return vec4<f32>(0.0); }
  let world: vec3<f32> = worldAt(p, d);
  let uv: vec2<f32> = vec2<f32>((world.x - frame.fogRect.x) * frame.fogRect.z, (world.z - frame.fogRect.y) * frame.fogRect.w);
  var f: f32 = 1.0;
  if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
    f = textureSampleLevel(fogTexture, linearSampler, uv, 0.0).r;
  }
  let e: vec4<f32> = frame.fogExplored;
  let u: vec4<f32> = frame.fogUnexplored;
  var color: vec3<f32> = e.rgb;
  var a: f32 = e.a * clamp(f * 2.0, 0.0, 1.0);
  if (f > 0.5) {
    let k: f32 = (f - 0.5) * 2.0;
    color = mix(e.rgb, u.rgb, k);
    a = mix(e.a, u.a, k);
  }
  return vec4<f32>(color * a, a);
}
`;

const FINAL_BODY = `
fn edgeAt(p: vec2<f32>, thickness: f32) -> f32 {
  let d0: f32 = viewDepthOf(worldAt(p, depthAt(p)));
  let n0: vec3<f32> = octDecode(textureLoad(gbufTexture, texelOf(p), 0).xy);
  var e: f32 = 0.0;
  for (var i = 0; i < 4; i++) {
    var o: vec2<f32> = vec2<f32>(thickness, 0.0);
    if (i == 1) { o = vec2<f32>(-thickness, 0.0); }
    if (i == 2) { o = vec2<f32>(0.0, thickness); }
    if (i == 3) { o = vec2<f32>(0.0, -thickness); }
    let q: vec2<f32> = p + o;
    let nq: vec3<f32> = octDecode(textureLoad(gbufTexture, texelOf(q), 0).xy);
    e = max(e, step(0.05 * d0, abs(viewDepthOf(worldAt(q, depthAt(q))) - d0)));
    e = max(e, step(0.5, 1.0 - dot(nq, n0)));
  }
  return e;
}

fn outlineAt(p: vec2<f32>, c: vec3<f32>) -> vec3<f32> {
  let here: vec4<f32> = textureLoad(maskTexture, texelOf(p), 0);
  if (here.a > 0.0) {
    return mix(c, toDisplay(here.rgb), fract(here.a));
  }
  let widest: i32 = i32(frame.style.z);
  for (var r = 1; r <= widest; r++) {
    for (var k = 0; k < 8; k++) {
      let a: f32 = f32(k) * 0.7853982;
      let m: vec4<f32> = textureLoad(maskTexture, texelOf(p + vec2<f32>(cos(a), sin(a)) * f32(r)), 0);
      if (m.a > 0.0 && floor(m.a) >= f32(r)) {
        return toDisplay(m.rgb);
      }
    }
  }
  return c;
}

/**
 * Film grain (gradeBalance.w: luminance noise, strongest in the mid-tones, new each frame)
 * and a triangular dither of about one display level, so 8-bit output shows no bands in
 * skies and fog.
 */
fn grainAndDither(c: vec3<f32>, p: vec2<f32>) -> vec3<f32> {
  let seed: f32 = frame.gradeNoise.x;
  let a: f32 = noiseAt(p + vec2<f32>(seed * 7.13, seed * 3.71));
  let b: f32 = noiseAt(p.yx + vec2<f32>(seed * 1.93 + 11.0, seed * 5.27 + 23.0));
  var graded: vec3<f32> = c;
  let grain: f32 = frame.gradeBalance.w;
  if (grain > 0.0) {
    let l: f32 = luminance(c);
    graded = graded + vec3<f32>((a + b - 1.0) * grain * 0.22 * (0.35 + 4.0 * l * (1.0 - l)));
  }
  return clamp(graded + vec3<f32>((a - b) * frame.gradeNoise.y / 255.0), vec3<f32>(0.0), vec3<f32>(1.0));
}

/**
 * Heat haze (Frame3d.hazes; frame.haze, hazeAt, hazeShape): pixels the scene is read from
 * shifted around each haze — a rising shimmer inside its radius, or a shockwave ring bending
 * the image outward. Zero when there are none.
 */
fn hazeOffset(p: vec2<f32>) -> vec2<f32> {
  var shift: vec2<f32> = vec2<f32>(0.0);
  let count: i32 = i32(frame.haze.x);
  let t: f32 = frame.haze.y;
  for (var i = 0; i < 4; i++) {
    if (i >= count) { break; }
    let spot: vec4<f32> = frame.hazeAt[i];
    let shape: vec4<f32> = frame.hazeShape[i];
    let clip: vec4<f32> = frame.viewProjection * vec4<f32>(spot.xyz, 1.0);
    if (clip.w <= 0.001) { continue; }
    let center: vec2<f32> = pixelOfNdc(clip.xy / clip.w);
    let rim: vec4<f32> = frame.viewProjection * vec4<f32>(spot.xyz + frame.cameraUp.xyz * spot.w, 1.0);
    let radius: f32 = length(pixelOfNdc(rim.xy / rim.w) - center);
    if (radius < 1.0) { continue; }
    let d: vec2<f32> = p - center;
    let r: f32 = length(d) / radius;
    let amp: f32 = shape.x * 0.03 * frame.viewport.w;
    if (shape.y > 0.0) {
      let band: f32 = 1.0 - smoothstep(0.0, shape.y, abs(r - 1.0));
      if (band > 0.0 && r > 0.001) { shift -= (d / length(d)) * amp * band; }
    } else {
      let fall: f32 = 1.0 - smoothstep(0.55, 1.0, r);
      if (fall > 0.0) {
        let q: vec2<f32> = d / radius;
        let wobble: vec2<f32> = vec2<f32>(sin(q.y * 23.0 + t * 7.0 + sin(q.x * 9.0 + t * 3.1)), cos(q.x * 19.0 + t * 5.3 + sin(q.y * 7.0 + t * 2.3)));
        shift += wobble * amp * 0.2 * fall;
      }
    }
  }
  return shift;
}

fn fragment(p0: vec2<f32>) -> vec4<f32> {
  let size: f32 = frame.postB.y;
  var p: vec2<f32> = p0;
  if (size > 1.5) {
    p = frame.viewport.xy + (floor((p0 - frame.viewport.xy) / size) + vec2<f32>(0.5)) * size;
  }
  let uv: vec2<f32> = uvOf(p + hazeOffset(p));
  let local: vec2<f32> = (p - frame.viewport.xy) / frame.viewport.zw;
  var hdr: vec3<f32> = textureSampleLevel(hdrTexture, linearSampler, uv, 0.0).rgb;
  let fringe: f32 = frame.postB.x;
  if (fringe > 0.0) {
    let shift: vec2<f32> = (local - vec2<f32>(0.5)) * 2.0 * fringe * frame.viewport.zw;
    hdr = vec3<f32>(
      textureSampleLevel(hdrTexture, linearSampler, uvOf(p + shift), 0.0).r,
      hdr.g,
      textureSampleLevel(hdrTexture, linearSampler, uvOf(p - shift), 0.0).b);
  }
  hdr += textureSampleLevel(bloomTexture, linearSampler, uv, 0.0).rgb * frame.postA.y;
  // The old renderer's grade, in its order, on the tone-mapped image: exposure (so a scene's 0.85 or 1.05
  // dims or lifts the picture by that factor), contrast about 0.5, saturation about its luma weights,
  // tint, then temperature as a small red/blue shift (gradeBalance.rgb: +0.1·t red, -0.1·t blue).
  var c: vec3<f32> = agx(hdr * ${num(EXPOSURE_CALIBRATION)}) * frame.postA.x;
  c = max((c - vec3<f32>(0.5)) * frame.postC.y + vec3<f32>(0.5), vec3<f32>(0.0));
  let gradeLuma: f32 = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  c = mix(vec3<f32>(gradeLuma), c, frame.postC.x) * frame.gradeTint.rgb + frame.gradeBalance.rgb;
  c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  let levels: f32 = frame.postB.z;
  if (levels > 1.5) {
    c = floor(c * (levels - 1.0) + vec3<f32>(0.5)) / (levels - 1.0);
  }
  if (frame.postB.w > 0.0) {
    c = mix(c, toDisplay(frame.edgeColor.rgb), edgeAt(p, frame.postB.w));
  }
  if (frame.style.z > 0.0) {
    c = outlineAt(p0, c);
  }
  let corner: f32 = length((local - vec2<f32>(0.5)) * 1.41421356);
  c *= 1.0 - frame.postA.w * smoothstep(0.35, 1.0, corner);
  c = grainAndDither(c, p0);
  var alpha: f32 = 1.0;
  if (depthAt(p) >= 1.0) { alpha = frame.present.w; }
  return vec4<f32>(c, alpha);
}
`;

const BLOOM_PREFILTER_BODY = `
fn fragment(uv: vec2<f32>) -> vec4<f32> {
  let texel: vec2<f32> = 1.0 / vec2<f32>(textureDimensions(sourceTexture, 0));
  var c: vec3<f32> = vec3<f32>(0.0);
  var w: f32 = 0.0;
  for (var i = 0; i < 4; i++) {
    var o: vec2<f32> = vec2<f32>(-0.5, -0.5);
    if (i == 1) { o = vec2<f32>(0.5, -0.5); }
    if (i == 2) { o = vec2<f32>(-0.5, 0.5); }
    if (i == 3) { o = vec2<f32>(0.5, 0.5); }
    let s: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv + o * texel * 2.0, 0.0).rgb;
    let k: f32 = 1.0 / (1.0 + luminance(s));
    c += s * k;
    w += k;
  }
  c /= w;
  let bright: f32 = max(c.r, max(c.g, c.b));
  let threshold: f32 = frame.postA.z;
  let knee: f32 = threshold * 0.5 + 1e-4;
  var soft: f32 = clamp(bright - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  let e: vec3<f32> = c * (max(soft, bright - threshold) / max(bright, 1e-4));
  // The old renderer's soft cap on the extracted peak (from 4 toward 12): a sun glint can't flood the frame.
  let peak: f32 = max(e.r, max(e.g, e.b));
  var cap: f32 = 1.0;
  if (peak > 4.0) { cap = (4.0 + 8.0 * (1.0 - exp(-(peak - 4.0) / 8.0))) / peak; }
  return vec4<f32>(e * cap, 1.0);
}
`;

const BLOOM_DOWN_BODY = `
fn fragment(uv: vec2<f32>) -> vec4<f32> {
  let t: vec2<f32> = 0.5 / vec2<f32>(textureDimensions(sourceTexture, 0));
  var c: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(sourceTexture, linearSampler, uv - t, 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + t, 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv - vec2<f32>(t.x, -t.y), 0.0).rgb;
  return vec4<f32>(c / 8.0, 1.0);
}
`;

const BLOOM_UP_BODY = `
fn fragment(uv: vec2<f32>) -> vec4<f32> {
  let t: vec2<f32> = 0.5 / vec2<f32>(textureDimensions(sourceTexture, 0));
  var c: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(-t.x * 2.0, 0.0), 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(-t.x, t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(0.0, t.y * 2.0), 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(t.x, t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(t.x * 2.0, 0.0), 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(0.0, -t.y * 2.0), 0.0).rgb;
  c += textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(-t.x, -t.y), 0.0).rgb * 2.0;
  return vec4<f32>(c / 12.0, 1.0);
}
`;

/** Colour-vision correction on a display color (frame slot 0: Settings are global). */
const COLOR_VISION = `
fn colorVision(c: vec3<f32>) -> vec3<f32> {
  if (frame.colorVision0.w < 0.5) { return c; }
  let lin: vec3<f32> = pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
  let corrected: vec3<f32> = vec3<f32>(dot(frame.colorVision0.xyz, lin), dot(frame.colorVision1.xyz, lin), dot(frame.colorVision2.xyz, lin));
  return pow(clamp(corrected, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
}
`;

/**
 * Upscale sharpening (dynamic resolution): an unsharp mask over the centre and its four
 * diagonals, clamped to their range so it steepens edges without halos (`frame.present.x`
 * strength: 0 at native resolution).
 */
const SHARPEN = `
fn sharpen(c: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let strength: f32 = frame.present.x;
  if (strength <= 0.0) { return c; }
  let t: vec2<f32> = 1.0 / vec2<f32>(textureDimensions(sourceTexture, 0));
  let nw: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(-t.x, -t.y), 0.0).rgb;
  let ne: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(t.x, -t.y), 0.0).rgb;
  let sw: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(-t.x, t.y), 0.0).rgb;
  let se: vec3<f32> = textureSampleLevel(sourceTexture, linearSampler, uv + vec2<f32>(t.x, t.y), 0.0).rgb;
  let blur: vec3<f32> = (nw + ne + sw + se) * 0.25;
  let lo: vec3<f32> = min(c, min(min(nw, ne), min(sw, se)));
  let hi: vec3<f32> = max(c, max(max(nw, ne), max(sw, se)));
  return clamp(c + (c - blur) * strength, lo, hi);
}
`;

function presentBody(fxaa: boolean): string {
  if (!fxaa) {
    return `${SHARPEN}
fn fragment(uv: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(colorVision(sharpen(textureSampleLevel(sourceTexture, linearSampler, uv, 0.0).rgb, uv)), 1.0);
}
`;
  }
  return `${SHARPEN}
fn lumaOf(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

fn tap(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(sourceTexture, linearSampler, uv, 0.0).rgb;
}

fn fragment(uv: vec2<f32>) -> vec4<f32> {
  let texel: vec2<f32> = 1.0 / vec2<f32>(textureDimensions(sourceTexture, 0));
  let rgbM: vec3<f32> = tap(uv);
  let lumaNW: f32 = lumaOf(tap(uv + vec2<f32>(-1.0, -1.0) * texel));
  let lumaNE: f32 = lumaOf(tap(uv + vec2<f32>(1.0, -1.0) * texel));
  let lumaSW: f32 = lumaOf(tap(uv + vec2<f32>(-1.0, 1.0) * texel));
  let lumaSE: f32 = lumaOf(tap(uv + vec2<f32>(1.0, 1.0) * texel));
  let lumaM: f32 = lumaOf(rgbM);
  let lumaMin: f32 = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  let lumaMax: f32 = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  if (lumaMax - lumaMin < max(0.0312, lumaMax * 0.125)) { return vec4<f32>(colorVision(sharpen(rgbM, uv)), 1.0); }
  var dir: vec2<f32> = vec2<f32>(-((lumaNW + lumaNE) - (lumaSW + lumaSE)), (lumaNW + lumaSW) - (lumaNE + lumaSE));
  let reduce: f32 = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2<f32>(-8.0), vec2<f32>(8.0)) * texel;
  let rgbA: vec3<f32> = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  let rgbB: vec3<f32> = rgbA * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
  let lumaB: f32 = lumaOf(rgbB);
  if (lumaB < lumaMin || lumaB > lumaMax) { return vec4<f32>(colorVision(rgbA), 1.0); }
  return vec4<f32>(colorVision(rgbB), 1.0);
}
`;
}

const ENV_DIRECTION = `
fn faceDirection(face: i32, s: vec2<f32>) -> vec3<f32> {
  let u: f32 = s.x * 2.0 - 1.0;
  let v: f32 = s.y * 2.0 - 1.0;
  var d: vec3<f32> = vec3<f32>(-u, -v, -1.0);
  if (face == 0) { d = vec3<f32>(1.0, -v, -u); }
  if (face == 1) { d = vec3<f32>(-1.0, -v, u); }
  if (face == 2) { d = vec3<f32>(u, 1.0, v); }
  if (face == 3) { d = vec3<f32>(u, -1.0, -v); }
  if (face == 4) { d = vec3<f32>(u, -v, 1.0); }
  return normalize(d);
}
`;

const ENV_SKY_BODY = `
fn fragment(pixel: vec2<f32>) -> vec4<f32> {
  let dir: vec3<f32> = faceDirection(i32(env.envParams.x), pixel / env.envParams.z);
  if (env.envSkybox.x > 0.5) {
    let u: f32 = fract(atan2(dir.x, dir.z) * 0.15915494 + 0.5 - env.envSkybox.y);
    let v: f32 = acos(clamp(dir.y, -1.0, 1.0)) * 0.31830989;
    // A mip that matches the cube face's texel size, so small faces don't sparkle.
    let lod: f32 = max(0.0, log2(f32(textureDimensions(skyImage, 0).x) / (4.0 * env.envParams.z)));
    return vec4<f32>(textureSampleLevel(skyImage, linearSampler, vec2<f32>(u, v), lod).rgb * env.envSkybox.z, 1.0);
  }
  let sky: vec3<f32> = mix(env.envHorizon.rgb, env.envZenith.rgb, sqrt(clamp(dir.y, 0.0, 1.0)));
  // Below the horizon the environment is ground, not more sky (the earlier engine's
  // procedural sky: horizon toward a dark warm brown, (0.25, 0.22, 0.18) beside its day horizon's
  // luminance 0.79). Without it a metal seen from above (a fridge's side reflects the floor) mirrors a
  // bright sky-blue horizon all the way down.
  let groundLight: f32 = dot(env.envHorizon.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let ground: vec3<f32> = vec3<f32>(0.317, 0.279, 0.228) * groundLight;
  let below: f32 = pow(max(-dir.y, 1e-6), 0.7) * step(0.0, -dir.y);
  return vec4<f32>(mix(sky, ground, below), 1.0);
}
`;

const ENV_PREFILTER_BODY = `
fn radicalInverse(index: u32) -> f32 {
  var bits: u32 = (index << 16u) | (index >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

fn fragment(pixel: vec2<f32>) -> vec4<f32> {
  let n: vec3<f32> = faceDirection(i32(env.envParams.x), pixel / env.envParams.z);
  let roughness: f32 = env.envParams.y;
  let count: i32 = i32(env.envParams.w);
  let a: f32 = max(roughness * roughness, 0.0001);
  var up: vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
  if (abs(n.z) > 0.999) { up = vec3<f32>(1.0, 0.0, 0.0); }
  let tx: vec3<f32> = normalize(cross(up, n));
  let ty: vec3<f32> = cross(n, tx);
  var total: vec3<f32> = vec3<f32>(0.0);
  var weight: f32 = 0.0;
  for (var i = 0; i < count; i++) {
    let xi: vec2<f32> = vec2<f32>((f32(i) + 0.5) / f32(count), radicalInverse(u32(i)));
    let phi: f32 = 6.2831853 * xi.x;
    let cosT: f32 = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
    let sinT: f32 = sqrt(1.0 - cosT * cosT);
    let h: vec3<f32> = tx * (cos(phi) * sinT) + ty * (sin(phi) * sinT) + n * cosT;
    let l: vec3<f32> = 2.0 * dot(n, h) * h - n;
    let nl: f32 = dot(n, l);
    if (nl > 0.0) {
      total += textureSampleLevel(skyCube, linearSampler, l, 0.0).rgb * nl;
      weight += nl;
    }
  }
  return vec4<f32>(total / max(weight, 1e-4), 1.0);
}
`;

export interface PostVariant {
  /** AO and AO blur: 2 at half resolution, 1 at full. */
  readonly scale?: number;
  /** AO samples, volumetric steps, god ray samples. */
  readonly samples?: number;
  /** Present: FXAA (true) or a plain copy. */
  readonly fxaa?: boolean;
}

function body(pass: PostPass, v: PostVariant): string {
  const scale = v.scale ?? 1;
  switch (pass) {
    case 'ao': return aoBody(scale, v.samples ?? 12);
    case 'aoBlur': return aoBlurBody(scale);
    case 'reflections': return REFLECTIONS_BODY;
    case 'resolve': return `${ENV_BRDF}${RESOLVE_BODY}`;
    case 'volumetric': return volumetricBody(v.samples ?? 24);
    case 'godRays': return godRaysBody(v.samples ?? 32);
    case 'fogOfWar': return FOG_OF_WAR_BODY;
    case 'final': return `${AGX}${FINAL_BODY}`;
    case 'bloomPrefilter': return BLOOM_PREFILTER_BODY;
    case 'bloomDown': return BLOOM_DOWN_BODY;
    case 'bloomUp': return BLOOM_UP_BODY;
    case 'present': return `${COLOR_VISION}${presentBody(v.fxaa ?? true)}`;
    case 'envSky': return `${ENV_DIRECTION}${ENV_SKY_BODY}`;
    case 'envPrefilter': return `${ENV_DIRECTION}${ENV_PREFILTER_BODY}`;
  }
}

/** Passes that read the scene depth through `depthAt`. */
const USES_DEPTH = (pass: PostPass): boolean => POST_BINDINGS[pass].some((b) => b.kind === 'depth');
/** Passes whose fragment takes the top-left pixel (per view, plus the env faces); the rest take the varying uv. */
const TAKES_PIXEL = (pass: PostPass): boolean => VIEW_PASSES.includes(pass) || pass === 'envSky' || pass === 'envPrefilter';

function wgslDeclarations(pass: PostPass): string {
  const group = VIEW_PASSES.includes(pass) ? 1 : 0;
  return POST_BINDINGS[pass].map((b, i) => {
    const at = `@group(${group}) @binding(${i})`;
    switch (b.kind) {
      case 'depth': return `${at} var ${b.name}: texture_depth_2d;`;
      case 'float': return `${at} var ${b.name}: texture_2d<f32>;`;
      case 'cube': return `${at} var ${b.name}: texture_cube<f32>;`;
      case 'linear': return `${at} var ${b.name}: sampler;`;
      case 'env': return `${wgslStruct('Env', ENV_FIELDS)}${at} var<uniform> env: Env;`;
    }
  }).join('\n');
}

function glslDeclarations(pass: PostPass): string {
  return POST_BINDINGS[pass].map((b) => {
    switch (b.kind) {
      case 'depth': case 'float': return `uniform sampler2D ${b.name};`;
      case 'cube': return `uniform samplerCube ${b.name};`;
      case 'linear': return '';
      case 'env': return glslBlock('Env', ENV_FIELDS);
    }
  }).filter((s) => s !== '').join('\n');
}

/** Whole-target passes still read `frame` (slot 0) for settings like the bloom threshold. */
const READS_FRAME = (pass: PostPass): boolean => pass !== 'envSky' && pass !== 'envPrefilter';

export function wgslPost(pass: PostPass, v: PostVariant = {}): string {
  const view = VIEW_PASSES.includes(pass);
  const frameDecl = view
    ? `${WGSL_FRAME}${WGSL_COMMON}${WGSL_SHADOWS}`
    : READS_FRAME(pass) ? `${wgslStruct('Frame', FRAME_FIELDS)}@group(1) @binding(0) var<uniform> frame: Frame;\n${WGSL_COMMON.replace(/fn skyColor[\s\S]*$/, '')}` : '';
  const helpers = view ? `${WGSL_PIXELS}${POST_HELPERS}${USES_DEPTH(pass) ? DEPTH_HELPERS.replace('DEPTH_SWIZZLE', '') : ''}` : '';
  const entry = TAKES_PIXEL(pass)
    ? `@fragment fn fs(in: FullOut) -> @location(0) vec4<f32> {\n  return fragment(in.clip.xy);\n}\n`
    : `@fragment fn fs(in: FullOut) -> @location(0) vec4<f32> {\n  return fragment(in.uv);\n}\n`;
  return `${frameDecl}\n${wgslDeclarations(pass)}\n${WGSL_POST_VS}${helpers}${body(pass, v)}\n${entry}`;
}

export function glslPost(pass: PostPass, v: PostVariant = {}): GlslProgram {
  const view = VIEW_PASSES.includes(pass);
  const frameDecl = view
    ? `${GLSL_FRAME}${GLSL_COMMON}${GLSL_SHADOWS}uniform samplerCube envCube;\n`
    : READS_FRAME(pass) ? `${glslBlock('Frame', FRAME_FIELDS)}${GLSL_COMMON.replace(/vec3 skyColor[\s\S]*$/, '')}` : '';
  const helpers = view ? `${GLSL_PIXELS}${toGlsl(POST_HELPERS)}${USES_DEPTH(pass) ? toGlsl(DEPTH_HELPERS.replace('DEPTH_SWIZZLE', '.r')) : ''}` : '';
  const pixel = pass === 'envSky' || pass === 'envPrefilter' ? 'gl_FragCoord.xy' : 'vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y)';
  const scale = pass === 'ao' || pass === 'aoBlur' ? v.scale ?? 1 : 1;
  const pixelExpr = scale === 1 ? pixel : `vec2(gl_FragCoord.x, targetSize.y / ${num(scale)} - gl_FragCoord.y)`;
  const entry = TAKES_PIXEL(pass) ? `fragColor = fragment(${pixelExpr});` : 'fragColor = fragment(vUv);';
  return {
    vertex: GLSL_POST_VS,
    fragment: `${GLSL_HEADER}${frameDecl}\n${glslDeclarations(pass)}\nin vec2 vUv;\nout vec4 fragColor;\n${helpers}${toGlsl(body(pass, v))}\nvoid main() {\n  ${entry}\n}\n`,
  };
}
