/**
 * Surface effects (`Material3d.effects`) in the mesh pass: rim light, hit flash, dissolve,
 * hologram, uv scrolling and triplanar mapping, written side by side in WGSL and GLSL like
 * `shaders.ts`. The mesh fragment shader calls these after declaring its material block
 * (WGSL reads `material.fx*`, GLSL the block's bare field names); every effect is a no-op
 * when its amount is 0, so a material without effects shades exactly as before.
 *
 * Inputs the mesh shaders pass:
 *   - `world`: the fragment's world position; `local`: its position relative to the
 *     instance's origin in meters along the instance's own axes (dissolve noise follows the
 *     object as it moves and turns).
 *   - `dpx`, `dpy`: screen derivatives of `world`, taken in uniform control flow, so the
 *     triplanar lookups can use explicit gradients anywhere.
 */

/** WGSL helpers; needs `material: Material` (layout.ts MATERIAL_FIELDS). */
export const WGSL_MATERIAL_FX = `
fn fxHash(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn fxNoise(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (vec3<f32>(3.0) - 2.0 * f);
  let a = mix(mix(fxHash(i), fxHash(i + vec3<f32>(1.0, 0.0, 0.0)), u.x), mix(fxHash(i + vec3<f32>(0.0, 1.0, 0.0)), fxHash(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(fxHash(i + vec3<f32>(0.0, 0.0, 1.0)), fxHash(i + vec3<f32>(1.0, 0.0, 1.0)), u.x), mix(fxHash(i + vec3<f32>(0.0, 1.0, 1.0)), fxHash(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}

/** Texture coordinates after scrolling (fxUv.xy: this frame's phase; the texture moves toward +u, +v). */
fn fxUvOf(uv: vec2<f32>) -> vec2<f32> {
  return uv - material.fxUv.xy;
}

/** The base texture projected along the world axes every fxUv.z meters, blended by facing. */
fn fxTriplanar(t: texture_2d<f32>, s: sampler, world: vec3<f32>, n: vec3<f32>, dpx: vec3<f32>, dpy: vec3<f32>) -> vec4<f32> {
  let k = 1.0 / material.fxUv.z;
  var w = pow(abs(n), vec3<f32>(4.0));
  w = w / max(w.x + w.y + w.z, 1e-5);
  let p = world * k;
  let x = textureSampleGrad(t, s, p.zy, dpx.zy * k, dpy.zy * k);
  let y = textureSampleGrad(t, s, p.xz, dpx.xz * k, dpy.xz * k);
  let z = textureSampleGrad(t, s, p.xy, dpx.xy * k, dpy.xy * k);
  return x * w.x + y * w.y + z * w.z;
}

/** Dissolve: how far above the cut this fragment is (below 0: cut away; 1 when there is no dissolve). */
fn fxDissolveCut(local: vec3<f32>) -> f32 {
  let amount = material.fxDissolve.x;
  if (amount <= 0.0) { return 1.0; }
  let q = local * material.fxDissolve.z;
  let noise = 0.65 * fxNoise(q) + 0.35 * fxNoise(q * 2.7 + vec3<f32>(17.0, 5.0, 11.0));
  return noise - amount * (1.0 + material.fxDissolve.y);
}

/** Rim, dissolve edge, flash and hologram over the shaded color: rgb linear light, a alpha. */
fn fxShade(c: vec3<f32>, alpha: f32, n: vec3<f32>, v: vec3<f32>, world: vec3<f32>, cut: f32) -> vec4<f32> {
  if (material.fxDissolve.w < 0.5) { return vec4<f32>(c, alpha); }
  var color = c;
  var a = alpha;
  let facing = 1.0 - max(dot(n, v), 0.0);
  if (material.fxRim.w > 0.0) {
    color += material.fxRim.rgb * pow(facing, material.fxRim.w);
  }
  if (material.fxDissolve.x > 0.0) {
    let edge = max(material.fxDissolve.y, 1e-4);
    color += material.fxEdge.rgb * (1.0 - smoothstep(0.0, edge, cut));
  }
  let holo = material.fxHolo.w;
  if (holo > 0.0) {
    let t = material.fxUv.w;
    let scan = 0.5 + 0.5 * sin((world.y * material.fxLines.x - t * 1.5) * 6.2831853);
    let blink = step(0.82, fxHash(vec3<f32>(floor(t * 14.0), 3.0, 7.0)));
    let flicker = 1.0 - material.fxEdge.w * (0.25 * (0.5 + 0.5 * sin(t * 41.0)) + 0.5 * blink);
    let fresnel = facing * facing;
    let glow = material.fxHolo.rgb * (0.35 + 1.8 * fresnel + 0.45 * scan) * flicker;
    color = mix(color, glow + color * 0.12, holo);
    a = mix(a, clamp(0.18 + 0.7 * fresnel + 0.2 * scan, 0.0, 1.0) * flicker, holo);
  }
  color = mix(color, material.fxFlash.rgb * 1.6, material.fxFlash.w);
  return vec4<f32>(color, a);
}
`;

/** GLSL ES 3.00 helpers; needs the Material block (bare field names). */
export const GLSL_MATERIAL_FX = `
float fxHash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float fxNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (vec3(3.0) - 2.0 * f);
  float a = mix(mix(fxHash(i), fxHash(i + vec3(1.0, 0.0, 0.0)), u.x), mix(fxHash(i + vec3(0.0, 1.0, 0.0)), fxHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y);
  float b = mix(mix(fxHash(i + vec3(0.0, 0.0, 1.0)), fxHash(i + vec3(1.0, 0.0, 1.0)), u.x), mix(fxHash(i + vec3(0.0, 1.0, 1.0)), fxHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}

vec2 fxUvOf(vec2 uv) {
  return uv - fxUv.xy;
}

vec4 fxTriplanar(sampler2D t, vec3 world, vec3 n, vec3 dpx, vec3 dpy) {
  float k = 1.0 / fxUv.z;
  vec3 w = pow(abs(n), vec3(4.0));
  w = w / max(w.x + w.y + w.z, 1e-5);
  vec3 p = world * k;
  vec4 x = textureGrad(t, p.zy, dpx.zy * k, dpy.zy * k);
  vec4 y = textureGrad(t, p.xz, dpx.xz * k, dpy.xz * k);
  vec4 z = textureGrad(t, p.xy, dpx.xy * k, dpy.xy * k);
  return x * w.x + y * w.y + z * w.z;
}

float fxDissolveCut(vec3 local) {
  float amount = fxDissolve.x;
  if (amount <= 0.0) return 1.0;
  vec3 q = local * fxDissolve.z;
  float noise = 0.65 * fxNoise(q) + 0.35 * fxNoise(q * 2.7 + vec3(17.0, 5.0, 11.0));
  return noise - amount * (1.0 + fxDissolve.y);
}

vec4 fxShade(vec3 c, float alpha, vec3 n, vec3 v, vec3 world, float cut) {
  if (fxDissolve.w < 0.5) return vec4(c, alpha);
  vec3 color = c;
  float a = alpha;
  float facing = 1.0 - max(dot(n, v), 0.0);
  if (fxRim.w > 0.0) {
    color += fxRim.rgb * pow(facing, fxRim.w);
  }
  if (fxDissolve.x > 0.0) {
    float edge = max(fxDissolve.y, 1e-4);
    color += fxEdge.rgb * (1.0 - smoothstep(0.0, edge, cut));
  }
  float holo = fxHolo.w;
  if (holo > 0.0) {
    float t = fxUv.w;
    float scan = 0.5 + 0.5 * sin((world.y * fxLines.x - t * 1.5) * 6.2831853);
    float blink = step(0.82, fxHash(vec3(floor(t * 14.0), 3.0, 7.0)));
    float flicker = 1.0 - fxEdge.w * (0.25 * (0.5 + 0.5 * sin(t * 41.0)) + 0.5 * blink);
    float fresnel = facing * facing;
    vec3 glow = fxHolo.rgb * (0.35 + 1.8 * fresnel + 0.45 * scan) * flicker;
    color = mix(color, glow + color * 0.12, holo);
    a = mix(a, clamp(0.18 + 0.7 * fresnel + 0.2 * scan, 0.0, 1.0) * flicker, holo);
  }
  color = mix(color, fxFlash.rgb * 1.6, fxFlash.w);
  return vec4(color, a);
}
`;

/** The instance's axis scales (meters per model unit along each axis), for `local` positions. WGSL/GLSL expression over m0..m2. */
export const WGSL_INSTANCE_SCALE = 'vec3<f32>(length(v.m0.xyz), length(v.m1.xyz), length(v.m2.xyz))';
export const GLSL_INSTANCE_SCALE = 'vec3(length(m0.xyz), length(m1.xyz), length(m2.xyz))';
