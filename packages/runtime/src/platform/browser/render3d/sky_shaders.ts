/**
 * Shaders for the outdoors (sky_plan.ts has the uniforms), written once in WGSL and
 * translated to GLSL ES 3.0 with the renderer's `toGlsl` (typed declarations throughout;
 * `nat.` / `wat.` prefixes name the uniform blocks in WGSL and are dropped in GLSL, where
 * block members are globals). Language-specific pieces — entry points, texture loads, the
 * pixel origin (WGSL top-left, GLSL bottom-left) — are written per language.
 *
 *   NATURE_COMMON   value noise, the scattering model (the CPU's atmosphere.ts, per pixel),
 *                   the gradient sky, clouds (volumetric: a short raymarch through the cloud
 *                   layer; flat: one 2D noise layer on the sky dome, `Quality3d.volumetricClouds`
 *                   picks), stars, cloud shadows on the ground, aerial perspective
 *   composite       a full-screen pass after the opaque scene: the sky where nothing was drawn
 *                   (scattering, sun disc, stars, clouds, lightning), and on every surface
 *                   aerial perspective, cloud shadows, wetness (darker, glossy, puddles with
 *                   rain ripples) and snow, all limited to what the cover map leaves exposed.
 *                   It writes (add, k) and blends as dst·k + add, so it needs no copy.
 *   far fade        the same blend after the water: past the view's fade start every surface
 *                   (terrain, meshes, water) fades into the sky toward it, all sky just short
 *                   of the far plane (`viewFadeOf`), so the world ends in its own sky
 *   environment     one face of the environment cube from the same sky (the reflections and
 *                   ambient light the scene is lit by)
 */

import { GLSL_HEADER } from './shaders.js';
import { toGlsl } from './post_shaders.js';
import { glslBlock, wgslStruct } from './layout.js';
import { NATURE_FIELDS, WATER_FIELDS } from './sky_plan.js';
import type { CloudMode } from './sky_plan.js';

/** The drawn sun disc's radius over the physical one (0.27°): ~0.9°, as the gradient sky's (shaders.ts SUN_DISC_RADIUS). */
export const SUN_DRAWN_SCALE = 3.4;

/** Ray-march steps by quality (0 low, 1 medium, 2 high): sky [view, light], clouds. */
export const SKY_STEPS = [[6, 3], [8, 4], [12, 6]] as const;
export const CLOUD_STEPS = [4, 10, 18] as const;

/** The cloud function each mode's sky calls (both take origin, dir, steps, max distance and return (light, transmittance)). */
const CLOUD_FN: Readonly<Record<CloudMode, string>> = { volumetric: 'cloudsAlong', flat: 'flatClouds' };

/** Shared WGSL (convertible to GLSL). */
export const NATURE_COMMON = /* wgsl */ `
fn hash13(p: vec3<f32>) -> f32 {
  var q: vec3<f32> = fract(p * 0.1031);
  q = q + vec3<f32>(dot(q, q.zyx + vec3<f32>(31.32)));
  return fract((q.x + q.y) * q.z);
}

fn vnoise3(p: vec3<f32>) -> f32 {
  let i: vec3<f32> = floor(p);
  let f: vec3<f32> = fract(p);
  let u: vec3<f32> = f * f * (vec3<f32>(3.0) - 2.0 * f);
  let a: f32 = mix(hash13(i), hash13(i + vec3<f32>(1.0, 0.0, 0.0)), u.x);
  let b: f32 = mix(hash13(i + vec3<f32>(0.0, 1.0, 0.0)), hash13(i + vec3<f32>(1.0, 1.0, 0.0)), u.x);
  let c: f32 = mix(hash13(i + vec3<f32>(0.0, 0.0, 1.0)), hash13(i + vec3<f32>(1.0, 0.0, 1.0)), u.x);
  let d: f32 = mix(hash13(i + vec3<f32>(0.0, 1.0, 1.0)), hash13(i + vec3<f32>(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

fn vnoise2(p: vec2<f32>) -> f32 {
  return vnoise3(vec3<f32>(p, 0.5));
}

fn fbm2(p: vec2<f32>) -> f32 {
  var q: vec2<f32> = p;
  var total: f32 = 0.0;
  var amp: f32 = 0.5;
  for (var i = 0; i < 4; i = i + 1) {
    total = total + vnoise2(q) * amp;
    q = q * 2.03 + vec2<f32>(17.1, 9.7);
    amp = amp * 0.5;
  }
  return total / 0.9375;
}

fn densityAt(h: f32) -> vec3<f32> {
  return vec3<f32>(exp(-h / nat.rayleigh.w), exp(-h / nat.ozone.w), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0));
}

fn extinctionOf(d: vec3<f32>) -> vec3<f32> {
  return nat.rayleigh.xyz * d.x + vec3<f32>(nat.mieParams.x / 0.9) * d.y + nat.ozone.xyz * d.z;
}

fn toTopOf(r: f32, mu: f32) -> f32 {
  let b: f32 = r * mu;
  let ra: f32 = nat.mieParams.w;
  return -b + sqrt(max(0.0, b * b - (r - ra) * (r + ra)));
}

fn toGroundOf(r: f32, mu: f32) -> f32 {
  let b: f32 = r * mu;
  let rp: f32 = nat.mieParams.z;
  let disc: f32 = b * b - (r - rp) * (r + rp);
  if (disc < 0.0) { return -1.0; }
  let near: f32 = -b - sqrt(disc);
  if (near > 0.0) { return near; }
  return -1.0;
}

fn depthToTop(r: f32, mu: f32, steps: i32) -> vec4<f32> {
  if (toGroundOf(r, mu) > 0.0) { return vec4<f32>(0.0); }
  let ds: f32 = toTopOf(r, mu) / f32(steps);
  var acc: vec3<f32> = vec3<f32>(0.0);
  for (var i = 0; i < steps; i = i + 1) {
    let t: f32 = (f32(i) + 0.5) * ds;
    let h: f32 = sqrt(r * r + t * t + 2.0 * r * t * mu) - nat.mieParams.z;
    acc = acc + densityAt(h) * ds;
  }
  return vec4<f32>(acc, 1.0);
}

fn rayleighPhaseOf(mu: f32) -> f32 {
  return 0.0596831 * (1.0 + mu * mu);
}

fn miePhaseOf(mu: f32, g: f32) -> f32 {
  let g2: f32 = g * g;
  return 0.1193662 * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 0.0001), 1.5));
}

fn scatterSky(dir: vec3<f32>, steps: i32, lightSteps: i32) -> vec3<f32> {
  let s: vec3<f32> = nat.toSun.xyz;
  let r0: f32 = nat.mieParams.z + 2.0;
  var len: f32 = toTopOf(r0, dir.y);
  let ground: f32 = toGroundOf(r0, dir.y);
  if (ground > 0.0) { len = ground; }
  let ds: f32 = len / f32(steps);
  let mu: f32 = dot(dir, s);
  let pr: f32 = rayleighPhaseOf(mu);
  let pm: f32 = miePhaseOf(mu, nat.mieParams.y);
  var eye: vec3<f32> = vec3<f32>(0.0);
  var sum: vec3<f32> = vec3<f32>(0.0);
  for (var i = 0; i < steps; i = i + 1) {
    let t: f32 = (f32(i) + 0.5) * ds;
    let p: vec3<f32> = vec3<f32>(0.0, r0, 0.0) + dir * t;
    let r: f32 = length(p);
    let d: vec3<f32> = densityAt(r - nat.mieParams.z);
    eye = eye + d * (ds * 0.5);
    let light: vec4<f32> = depthToTop(r, dot(p, s) / r, lightSteps);
    if (light.w > 0.5) {
      let tr: vec3<f32> = exp(-(extinctionOf(eye) + extinctionOf(light.xyz)));
      sum = sum + tr * (nat.rayleigh.xyz * (d.x * pr) + vec3<f32>(nat.mieParams.x * d.y * pm)) * ds;
    }
    eye = eye + d * (ds * 0.5);
  }
  return sum * nat.misc.x;
}

fn gradientSky(dir: vec3<f32>) -> vec3<f32> {
  return mix(nat.horizon.xyz, nat.zenith.xyz, sqrt(clamp(dir.y, 0.0, 1.0)));
}

/** The sky's own light toward dir (no sun disc, stars or clouds). */
fn skyLight(dir: vec3<f32>, steps: i32, lightSteps: i32) -> vec3<f32> {
  var c: vec3<f32> = gradientSky(dir);
  if (nat.zenith.w > 0.5) {
    let up: vec3<f32> = vec3<f32>(dir.x, max(dir.y, 0.0), dir.z);
    let air: vec3<f32> = scatterSky(normalize(up + vec3<f32>(0.0, 0.0005, 0.0)), steps, lightSteps);
    // Night keeps the night palette under the stars; heavy cloud greys the air out.
    let grey: f32 = nat.cloudsA.x * nat.cloudsA.x;
    c = mix(air + c * nat.horizon.w * 0.7, c, grey);
  }
  return c + vec3<f32>(0.8, 0.85, 1.0) * (nat.misc.z * 0.35);
}

fn cloudCover(xz: vec2<f32>) -> f32 {
  let cov: f32 = nat.cloudsA.x;
  if (cov <= 0.0) { return 0.0; }
  let shape: f32 = fbm2((xz + nat.cloudsB.xy) / nat.cloudsB.z);
  return clamp((shape - (1.0 - cov)) / max(cov, 0.05) * 1.6, 0.0, 1.0);
}

fn cloudDensity(p: vec3<f32>) -> f32 {
  let h: f32 = (p.y - nat.cloudsA.z) / nat.cloudsA.w;
  if (h < 0.0 || h > 1.0) { return 0.0; }
  let base: f32 = cloudCover(p.xz);
  if (base <= 0.0) { return 0.0; }
  let profile: f32 = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.35 + 0.6 * base, 1.0, h));
  let detail: f32 = vnoise3(p / (nat.cloudsB.z * 0.12) + vec3<f32>(0.0, nat.misc.y * 0.01, 0.0));
  return clamp(base * profile - detail * 0.3 * (1.0 - base), 0.0, 1.0) * nat.cloudsA.y;
}

/** Clouds along a ray from the eye: rgb light scattered toward it, a = what's left of the sky behind. */
fn cloudsAlong(origin: vec3<f32>, dir: vec3<f32>, steps: i32, maxDist: f32) -> vec4<f32> {
  if (nat.cloudsA.x <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let bottom: f32 = nat.cloudsA.z;
  let top: f32 = nat.cloudsA.z + nat.cloudsA.w;
  var t0: f32 = 0.0;
  var t1: f32 = 0.0;
  if (origin.y < bottom) {
    if (dir.y <= 0.01) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    t0 = (bottom - origin.y) / dir.y;
    t1 = (top - origin.y) / dir.y;
  } else if (origin.y > top) {
    if (dir.y >= -0.01) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    t0 = (top - origin.y) / dir.y;
    t1 = (bottom - origin.y) / dir.y;
  } else {
    t1 = (top - origin.y) / max(dir.y, 0.05);
    if (dir.y < 0.0) { t1 = (bottom - origin.y) / min(dir.y, -0.05); }
  }
  t1 = min(t1, t0 + nat.cloudsA.w * 4.0);
  if (t0 > maxDist) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  t1 = min(t1, maxDist);
  let dt: f32 = (t1 - t0) / f32(steps);
  let s: vec3<f32> = nat.toSun.xyz;
  let mu: f32 = dot(dir, s);
  let g: f32 = 0.6;
  let phase: f32 = 0.0796 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  // Clouds stand high: they keep full (already reddened) sunlight until the sun is well down, so low suns light their undersides.
  let sun: vec3<f32> = nat.sunColor.xyz * (nat.toSun.w * 1.1 * smoothstep(-0.08, 0.06, s.y));
  let dark: f32 = 1.0 - 0.75 * nat.cloudsB.w;
  let fill: vec3<f32> = (nat.zenith.xyz * 0.5 + nat.ambientLight.xyz * 0.6) * dark;
  var light: vec3<f32> = vec3<f32>(0.0);
  var trans: f32 = 1.0;
  for (var i = 0; i < steps; i = i + 1) {
    let p: vec3<f32> = origin + dir * (t0 + (f32(i) + 0.5) * dt);
    let d: f32 = cloudDensity(p);
    if (d > 0.005) {
      let shade: f32 = exp(-cloudDensity(p + s * (nat.cloudsA.w * 0.3)) * 4.0);
      let powder: f32 = 1.0 - exp(-d * 6.0);
      let lum: vec3<f32> = sun * (shade * powder * (0.6 + phase * 3.0) * dark) + fill + vec3<f32>(0.8, 0.85, 1.0) * (nat.misc.z * 1.5);
      let a: f32 = exp(-d * dt * 0.012);
      light = light + lum * ((1.0 - a) * trans);
      trans = trans * a;
      if (trans < 0.02) { break; }
    }
  }
  // Far clouds fade into the horizon haze.
  let fade: f32 = exp(-t0 / 45000.0);
  return vec4<f32>(light * fade, mix(1.0, trans, fade));
}

/**
 * Clouds as one flat layer on the sky dome (the lower tiers' look): the ray meets the plane at
 * the layer's middle (where cloud shadows sample too, so shadows fall under the clouds drawn),
 * and the same drifting 2D coverage field is read there once. Lit simply: a sunward sample of
 * the field gives the clouds' shaded side, thin edges toward the sun take a silver lining, and
 * the ambient sky fills the rest. At grazing angles the field is averaged toward its coverage
 * so the horizon carries no noise; far clouds fade into the haze as the volumetric ones do.
 * rgb: light toward the eye, a: what's left of the sky behind.
 */
fn flatClouds(origin: vec3<f32>, dir: vec3<f32>, steps: i32, maxDist: f32) -> vec4<f32> {
  let cov: f32 = nat.cloudsA.x;
  if (cov <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let plane: f32 = nat.cloudsA.z + nat.cloudsA.w * 0.4;
  let rise: f32 = plane - origin.y;
  if (abs(dir.y) < 0.001 || rise * dir.y <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let t: f32 = rise / dir.y;
  if (t > maxDist) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let xz: vec2<f32> = origin.xz + dir.xz * t;
  // A pixel's footprint on the layer, in cloud cells: past about one, the noise would only alias.
  let foot: f32 = t * 2.0 * nat.targetSize.w / max(abs(dir.y), 0.02) / nat.cloudsB.z;
  let blur: f32 = smoothstep(0.15, 0.6, foot);
  let cover: f32 = mix(cloudCover(xz), cov, blur);
  if (cover <= 0.001) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let s: vec3<f32> = nat.toSun.xyz;
  let toward: vec2<f32> = normalize(s.xz + vec2<f32>(1.0e-4, 0.0)) * (nat.cloudsB.z * 0.12);
  let sunward: f32 = mix(cloudCover(xz + toward), cov, blur);
  let lit: f32 = clamp(1.0 - (sunward - cover) * 1.6 - cover * 0.35 * nat.cloudsA.y, 0.25, 1.0);
  let mu: f32 = dot(dir, s);
  let g: f32 = 0.6;
  let phase: f32 = 0.0796 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  let sun: vec3<f32> = nat.sunColor.xyz * (nat.toSun.w * 1.1 * smoothstep(-0.08, 0.06, s.y));
  let dark: f32 = 1.0 - 0.75 * nat.cloudsB.w;
  let fill: vec3<f32> = (nat.zenith.xyz * 0.5 + nat.ambientLight.xyz * 0.6) * dark;
  let silver: f32 = pow(max(mu, 0.0), 6.0) * (1.0 - cover) * 1.5;
  let lum: vec3<f32> = sun * ((lit * (0.6 + phase * 3.0) * 0.8 + silver) * dark) + fill + vec3<f32>(0.8, 0.85, 1.0) * (nat.misc.z * 1.5);
  // Opaque cores with soft edges, as the volumetric clouds read; thin clouds (low density) stay sheer.
  let alpha: f32 = smoothstep(0.0, 0.55, cover) * mix(0.6, 1.0, clamp(nat.cloudsA.y, 0.0, 1.0))
    * smoothstep(0.0, 0.03, abs(dir.y));
  let fade: f32 = exp(-t / 45000.0);
  return vec4<f32>(lum * (alpha * fade), 1.0 - alpha * fade);
}

fn starsToward(dir: vec3<f32>) -> vec3<f32> {
  if (nat.horizon.w <= 0.0 || dir.y <= 0.0) { return vec3<f32>(0.0); }
  let cell: vec3<f32> = floor(dir * 420.0);
  let h: f32 = hash13(cell);
  if (h < 0.9975) { return vec3<f32>(0.0); }
  let twinkle: f32 = 0.7 + 0.3 * sin(nat.misc.y * (2.0 + h * 9.0) + h * 80.0);
  return vec3<f32>(0.9, 0.95, 1.0) * ((h - 0.9975) * 900.0 * twinkle * nat.horizon.w * smoothstep(0.0, 0.2, dir.y));
}

/**
 * The sun through the air: a limb-darkened disc (drawn SUN_DRAWN_SCALE times its physical
 * radius so it reads as a disc on screen; soft-edged so it never aliases) with the corona
 * hugging it, and the aureole around (on top of the scattering model's own Mie lobe). Ground hides the disc.
 */
fn sunDisc(dir: vec3<f32>) -> vec3<f32> {
  let mu: f32 = dot(dir, nat.toSun.xyz);
  let r: f32 = nat.sunColor.w * SUN_DRAWN_SCALE;
  let theta: f32 = sqrt(max(2.0 * (1.0 - mu), 0.0));
  let x: f32 = clamp(theta / r, 0.0, 1.0);
  let limb: f32 = 1.0 - 0.55 * (1.0 - sqrt(1.0 - x * x));
  let disc: f32 = (1.0 - smoothstep(0.82, 1.15, theta / r)) * limb * 60.0;
  let corona: f32 = exp(-theta / (r * 0.9)) * 4.0 + exp(-theta / (r * 3.5)) * 1.0;
  // The aureole: glare a few degrees out and a broad warm glow on the sun's side of the sky.
  let aureole: f32 = exp(-theta / 0.09) * 0.3 + pow(max(mu, 0.0), 8.0) * 0.08;
  let ground: f32 = smoothstep(-0.012, 0.004, dir.y);
  // The sun stays blinding low in the sky (its light is already reddened in sunColor); it fades once it sets.
  let strength: f32 = max(nat.toSun.w, 0.9) * smoothstep(-0.06, 0.01, nat.toSun.y);
  return nat.sunColor.xyz * (strength * ((disc + corona) * ground + aureole * smoothstep(-0.12, 0.02, dir.y)));
}

/** The whole sky toward dir as the eye at origin sees it. */
fn fullSky(origin: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
  var c: vec3<f32> = skyLight(dir, SKY_VIEW_STEPS, SKY_LIGHT_STEPS);
  c = c + starsToward(dir) + sunDisc(dir);
  let clouds: vec4<f32> = CLOUDS_TOWARD(origin, dir, CLOUD_STEPS_HERE, 80000.0);
  return c * clouds.w + clouds.xyz;
}

/** How much the clouds shade sunlight at a point (0 none .. 1 full). */
fn cloudShadow(p: vec3<f32>) -> f32 {
  if (nat.cloudsA.x <= 0.0 || nat.toSun.y <= 0.02) { return 0.0; }
  let mid: f32 = nat.cloudsA.z + nat.cloudsA.w * 0.4;
  let q: vec3<f32> = p + nat.toSun.xyz * ((mid - p.y) / nat.toSun.y);
  return clamp(cloudCover(q.xz) * nat.cloudsA.y * 1.4, 0.0, 1.0);
}

/** Aerial perspective over dist meters along dir: rgb in-scattered light, a = transmittance (luminance). */
fn aerial(dir: vec3<f32>, dist: f32, height: f32) -> vec4<f32> {
  let dens: vec3<f32> = densityAt(max(height, 0.0));
  let beta: vec3<f32> = nat.rayleigh.xyz * dens.x + vec3<f32>(nat.mieParams.x / 0.9 * dens.y);
  let tr: vec3<f32> = exp(-beta * dist);
  let mu: f32 = dot(dir, nat.toSun.xyz);
  let scatter: vec3<f32> = nat.rayleigh.xyz * (dens.x * rayleighPhaseOf(mu)) + vec3<f32>(nat.mieParams.x * dens.y * miePhaseOf(mu, nat.mieParams.y));
  let sun: vec3<f32> = nat.sunColor.xyz * nat.toSun.w * nat.misc.x;
  var add: vec3<f32> = sun * scatter / max(beta, vec3<f32>(1e-9)) * (vec3<f32>(1.0) - tr);
  add = add + nat.horizon.xyz * (vec3<f32>(1.0) - tr) * 0.5;
  return vec4<f32>(add, dot(tr, vec3<f32>(0.2126, 0.7152, 0.0722)));
}
`;

/** WGSL: the nature uniform at group 0 binding 0 (dynamic offset), then the pass's own bindings. */
export const WGSL_NATURE_DECL = `${wgslStruct('Nature', NATURE_FIELDS)}@group(0) @binding(0) var<uniform> nat: Nature;\n`;
export const WGSL_WATER_DECL = wgslStruct('Water', WATER_FIELDS);
export const GLSL_NATURE_DECL = glslBlock('Nature', NATURE_FIELDS);
export const GLSL_WATER_DECL = glslBlock('Water', WATER_FIELDS);

/** The shared code (and the composite pass's, which calls the clouds too) with a quality's step counts and cloud mode baked in. */
export function natureCommon(q: number, clouds: CloudMode, code: string = NATURE_COMMON): string {
  return code
    .replace(/SUN_DRAWN_SCALE/g, SUN_DRAWN_SCALE.toFixed(2))
    .replace(/SKY_VIEW_STEPS/g, String(SKY_STEPS[q]![0]))
    .replace(/SKY_LIGHT_STEPS/g, String(SKY_STEPS[q]![1]))
    .replace(/CLOUD_STEPS_HERE/g, String(CLOUD_STEPS[q]!))
    .replace(/CLOUDS_TOWARD/g, CLOUD_FN[clouds]);
}

/** WGSL → GLSL for nature code (`nat.`/`wat.` prefixes dropped: block members are globals in GLSL). */
export function natureGlsl(wgsl: string): string {
  return toGlsl(wgsl.replace(/\bnat\./g, '').replace(/\bwat\./g, ''));
}

// ── The composite pass ─────────────────────────────────────────────────────────

const COMPOSITE_BODY = /* wgsl */ `
fn worldAt(pixel: vec2<f32>, depth: f32) -> vec3<f32> {
  let uv: vec2<f32> = (pixel - nat.viewport.xy) / nat.viewport.zw;
  let ndc: vec4<f32> = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let h: vec4<f32> = nat.inverseViewProjection * ndc;
  return h.xyz / h.w;
}

fn exposedAt(p: vec3<f32>) -> f32 {
  if (nat.weatherOn.w < 0.5) { return 1.0; }
  let cell: vec2<f32> = floor((p.xz - nat.coverMap.xy) / nat.coverMap.z);
  let size: f32 = nat.coverMap.w;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= size || cell.y >= size) { return 1.0; }
  let top: f32 = loadCover(vec2<i32>(i32(cell.x), i32(cell.y)));
  if (top < -1.0e8) { return 1.0; }
  return clamp((p.y - (top - 0.3)) * 4.0, 0.0, 1.0);
}

/** A surface normal from the depth of the neighbours (the smaller step on each axis, so silhouettes stay clean). */
fn normalAt(pixel: vec2<f32>, p: vec3<f32>) -> vec3<f32> {
  let pl: vec3<f32> = worldAt(pixel - vec2<f32>(1.0, 0.0), loadDepth(pixel - vec2<f32>(1.0, 0.0)));
  let pr: vec3<f32> = worldAt(pixel + vec2<f32>(1.0, 0.0), loadDepth(pixel + vec2<f32>(1.0, 0.0)));
  let pu: vec3<f32> = worldAt(pixel - vec2<f32>(0.0, 1.0), loadDepth(pixel - vec2<f32>(0.0, 1.0)));
  let pd: vec3<f32> = worldAt(pixel + vec2<f32>(0.0, 1.0), loadDepth(pixel + vec2<f32>(0.0, 1.0)));
  var dx: vec3<f32> = pr - p;
  if (length(p - pl) < length(dx)) { dx = p - pl; }
  var dy: vec3<f32> = pd - p;
  if (length(p - pu) < length(dy)) { dy = p - pu; }
  var n: vec3<f32> = normalize(cross(dy, dx));
  if (dot(n, nat.cameraPos.xyz - p) < 0.0) { n = -n; }
  return n;
}

/** The scene's fog over the sky toward dir (matches the surfaces' fog at the far plane; height fog integrated). */
fn fogOverSky(dir: vec3<f32>, c: vec3<f32>) -> vec3<f32> {
  let kind: f32 = nat.fogColor.w;
  if (kind < 0.5) { return c; }
  var f: f32 = nat.fogHeight.z * (1.0 - smoothstep(-0.02, 0.3, dir.y));
  let falloff: f32 = nat.fogHeight.x;
  if (kind < 1.5 && falloff > 0.0) {
    let dist: f32 = nat.fogHeight.w;
    var optical: f32 = nat.fogParams.x * dist * exp(-falloff * (nat.cameraPos.y - nat.fogHeight.y));
    let rise: f32 = falloff * dir.y * dist;
    if (abs(rise) > 1e-4) { optical = optical * (1.0 - exp(-rise)) / rise; }
    f = 1.0 - exp(-max(optical, 0.0));
  }
  return mix(c, nat.fogColor.xyz, f);
}

/** (add, k): the pixel becomes dst·k + add. */
fn composite(pixel: vec2<f32>) -> vec4<f32> {
  let depth: f32 = loadDepth(pixel);
  let eye: vec3<f32> = nat.cameraPos.xyz;
  let far: vec3<f32> = worldAt(pixel, 1.0);
  let dir: vec3<f32> = normalize(far - eye);
  if (depth >= 1.0) {
    // A skybox panorama or a camera background is the sky: leave what the scene's sky pass drew.
    if (nat.cubeFace.w > 0.5) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    return vec4<f32>(fogOverSky(dir, fullSky(eye, dir)), 0.0);
  }
  let p: vec3<f32> = worldAt(pixel, depth);
  var k: f32 = 1.0;
  var add: vec3<f32> = vec3<f32>(0.0);
  let wet: f32 = nat.weatherOn.x;
  let snow: f32 = nat.weatherOn.y;
  if (wet > 0.01 || snow > 0.01) {
    let n: vec3<f32> = normalAt(pixel, p);
    let open: f32 = exposedAt(p);
    let upward: f32 = smoothstep(0.2, 0.8, n.y);
    let w: f32 = wet * open * mix(0.35, 1.0, upward);
    let puddle: f32 = smoothstep(0.93, 0.985, n.y) * smoothstep(0.52, 0.68, fbm2(p.xz * 0.35)) * smoothstep(0.4, 0.9, wet) * open;
    var rn: vec3<f32> = n;
    if (puddle > 0.0 && nat.weatherOn.z > 0.0) {
      let t: f32 = nat.misc.y;
      let e: f32 = 0.08;
      let a: f32 = vnoise3(vec3<f32>(p.xz * 6.0, t * 3.0));
      let bx: f32 = vnoise3(vec3<f32>(p.xz * 6.0 + vec2<f32>(e, 0.0), t * 3.0));
      let bz: f32 = vnoise3(vec3<f32>(p.xz * 6.0 + vec2<f32>(0.0, e), t * 3.0));
      rn = normalize(n + vec3<f32>(a - bx, 0.0, a - bz) * (nat.weatherOn.z * 3.0));
    }
    let r: vec3<f32> = reflect(dir, rn);
    let fres: f32 = 0.04 + 0.96 * pow(1.0 - max(dot(-dir, rn), 0.0), 5.0);
    let env: vec3<f32> = sampleCube(r, mix(3.0, 0.0, puddle)) * nat.misc.w;
    k = 1.0 - 0.45 * w * (1.0 - puddle) - 0.25 * puddle;
    add = env * (fres * (w * 0.5 + puddle * 1.5));
    let s: f32 = snow * open * smoothstep(0.45, 0.8, n.y) * (0.8 + 0.2 * vnoise2(p.xz * 3.0));
    let lit: vec3<f32> = nat.ambientLight.xyz + nat.sunColor.xyz * (nat.toSun.w * max(dot(n, nat.toSun.xyz), 0.0) * 0.9 * 0.31830989);
    k = k * (1.0 - s);
    add = add * (1.0 - s) + vec3<f32>(0.92, 0.95, 1.0) * lit * (0.9 * s);
  }
  let shadow: f32 = cloudShadow(p);
  if (shadow > 0.0) {
    let sunLum: f32 = nat.toSun.w * dot(nat.sunColor.xyz, vec3<f32>(0.2126, 0.7152, 0.0722));
    let share: f32 = sunLum / max(sunLum + dot(nat.ambientLight.xyz, vec3<f32>(0.2126, 0.7152, 0.0722)) * 2.0, 1e-4);
    let shade: f32 = 1.0 - 0.6 * shadow * share;
    k = k * shade;
    add = add * shade;
  }
  let dist: f32 = distance(p, eye);
  let haze: vec4<f32> = aerial(dir, dist, (p.y + eye.y) * 0.5);
  return vec4<f32>(add * haze.w + haze.xyz, k * haze.w);
}

/**
 * The far fade, after the water (whose surfaces wrote depth): every drawn pixel past
 * nat.viewFade.x meters fades into this pass's sky toward it (the composite's sky, fog over
 * it included), all sky by nat.viewFade.y, just short of the far plane. Terrain, meshes and
 * water end in the sky seen past them, and the sky below the horizon is that same color, so
 * the drawn world has no edge. (add, k) as composite.
 */
fn farFade(pixel: vec2<f32>) -> vec4<f32> {
  let depth: f32 = loadDepth(pixel);
  if (depth >= 1.0 || nat.viewFade.y <= 0.0 || nat.waterAt.x >= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let eye: vec3<f32> = nat.cameraPos.xyz;
  let dist: f32 = distance(worldAt(pixel, depth), eye);
  let t: f32 = clamp((dist - nat.viewFade.x) / max(nat.viewFade.y - nat.viewFade.x, 1e-4), 0.0, 1.0);
  if (t <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let dir: vec3<f32> = normalize(worldAt(pixel, 1.0) - eye);
  return vec4<f32>(fogOverSky(dir, fullSky(eye, dir)) * t, 1.0 - t);
}

/** A face of the environment cube: the sky without the sun disc (the sun lights directly). */
fn environmentFace(pixel: vec2<f32>) -> vec4<f32> {
  let s: vec2<f32> = pixel / nat.cubeFace.y;
  let u: f32 = s.x * 2.0 - 1.0;
  let v: f32 = s.y * 2.0 - 1.0;
  let face: i32 = i32(nat.cubeFace.x + 0.5);
  var d: vec3<f32> = vec3<f32>(-u, -v, -1.0);
  if (face == 0) { d = vec3<f32>(1.0, -v, -u); }
  if (face == 1) { d = vec3<f32>(-1.0, -v, u); }
  if (face == 2) { d = vec3<f32>(u, 1.0, v); }
  if (face == 3) { d = vec3<f32>(u, -1.0, -v); }
  if (face == 4) { d = vec3<f32>(u, -v, 1.0); }
  let dir: vec3<f32> = normalize(d);
  var c: vec3<f32> = skyLight(dir, 6, 3);
  let clouds: vec4<f32> = CLOUDS_TOWARD(nat.cameraPos.xyz, dir, 6, 80000.0);
  c = c * clouds.w + clouds.xyz;
  c = mix(c, nat.horizon.xyz * 0.5, smoothstep(0.0, -0.15, dir.y));
  return vec4<f32>(c, 1.0);
}
`;

const WGSL_FULLSCREEN_VS = `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(corners[index], 0.0, 1.0);
}
`;

/** WGSL composite, environment-face and far-fade programs (one module, three fragment entries). */
export function wgslSky(q: number, clouds: CloudMode): string {
  return `${WGSL_NATURE_DECL}
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var envCube: texture_cube<f32>;
@group(0) @binding(3) var envSampler: sampler;
@group(0) @binding(4) var coverTexture: texture_2d<f32>;

fn loadDepth(pixel: vec2<f32>) -> f32 {
  let size: vec2<i32> = vec2<i32>(textureDimensions(depthTexture));
  return textureLoad(depthTexture, clamp(vec2<i32>(floor(pixel)), vec2<i32>(0), size - vec2<i32>(1)), 0);
}
fn loadCover(cell: vec2<i32>) -> f32 {
  return textureLoad(coverTexture, cell, 0).r;
}
fn sampleCube(dir: vec3<f32>, lod: f32) -> vec3<f32> {
  return textureSampleLevel(envCube, envSampler, dir, lod).rgb;
}
${natureCommon(q, clouds, NATURE_COMMON + COMPOSITE_BODY)}${WGSL_FULLSCREEN_VS}
@fragment fn composite_fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  return composite(at.xy);
}
@fragment fn face_fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  return environmentFace(at.xy);
}
@fragment fn fade_fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  return farFade(at.xy);
}
`;
}

export const GLSL_FULLSCREEN_VS = `${GLSL_HEADER}
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`;

/** GLSL composite (`face` false), environment-face (`face` true) or far-fade (`'fade'`, the composite's blend) fragment shader. */
export function glslSky(q: number, face: boolean | 'fade', clouds: CloudMode): { vertex: string; fragment: string } {
  const helpers = `
uniform sampler2D depthTexture;
uniform samplerCube envCube;
uniform sampler2D coverTexture;
float loadDepth(vec2 pixel) {
  ivec2 size = textureSize(depthTexture, 0);
  ivec2 p = clamp(ivec2(floor(vec2(pixel.x, targetSize.y - 1.0 - pixel.y))), ivec2(0), size - ivec2(1));
  return texelFetch(depthTexture, p, 0).r;
}
float loadCover(ivec2 cell) {
  return texelFetch(coverTexture, cell, 0).r;
}
vec3 sampleCube(vec3 dir, float lod) {
  return textureLod(envCube, dir, lod).rgb;
}
`;
  // GL's pixel origin is the bottom-left; the composite works top-left (the cube face draws in GL's own face orientation).
  const entry = face === 'fade'
    ? 'fragColor = farFade(vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y));'
    : face
      ? 'fragColor = environmentFace(gl_FragCoord.xy);'
      : 'fragColor = composite(vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y));';
  return {
    vertex: GLSL_FULLSCREEN_VS,
    fragment: `${GLSL_HEADER}${GLSL_NATURE_DECL}${helpers}${natureGlsl(natureCommon(q, clouds, NATURE_COMMON + COMPOSITE_BODY))}
out vec4 fragColor;
void main() {
  ${entry}
}
`,
  };
}
