/**
 * The terrain pass's shaders (WGSL and GLSL ES 3.00, side by side), for CDLOD tiles
 * (`TerrainTile3d`). shaders.ts hands in the chunks every scene pass shares (frame block,
 * shadows, lighting, outputs), so the terrain is lit, shadowed, fogged and written to the
 * HDR and normal/roughness targets exactly as meshes are.
 *
 * Bindings: the terrain block, the terrain arrays (terrain_arrays.ts: every textured
 * material's base color and normal map, one layer each), the palette's four detail
 * textures, one repeating sampler, and the splat map (the material weights on a grid of
 * at most 1 m; when bound, the palette's weights come from it per pixel instead of from
 * the vertices, so narrow paths and paint edges stay sharp at every level of detail).
 *
 * Per tile draw (the terrain uniform block, one slot per palette and level):
 *   - geomorph: each vertex blends toward its coarser-level height (uv.x) by
 *     k = clamp((|vertex − camera| − morphStart) / (morphEnd − morphStart), 0, 1)
 *   - four palette layers blended by the vertex weights (colors). A textured layer is
 *     sampled (only where it has weight: explicit gradients) top-down, with a second
 *     rotated sample swapped in by low-frequency noise (anti-tiling), and from the side on
 *     steep ground (triplanar: no stretching on cliffs); its normal map is sampled the same
 *     ways and turned into world space per projection. A recolored layer is shifted so its
 *     average (the array's last mip) is the layer's color. An untextured layer is its flat
 *     color shaded by a procedural pattern (soil, grass, rock, sand, paved, snow: value
 *     noise, faded to its mean before it aliases). All get large-scale tone variation and
 *     the optional detail texture (×2 grayscale overlay, fading out by DETAIL_FADE meters).
 *   - height blending: each layer's height (texture luminance against its mean, or the
 *     pattern's) moves the boundary between layers, so a transition breaks up along
 *     the surfaces' own features instead of a smooth vertex ramp.
 *   - relief: normal maps, else the blended height bumps the normal (screen-space surface
 *     gradient), with a little crevice occlusion; a damp band darkens the ground just
 *     above water.
 */

import { LOCATION as L } from './layout.js';

export interface ShaderChunks {
  readonly frame: string;
  readonly common: string;
  readonly shadows: string;
  readonly lighting: string;
  readonly outputs: string;
  readonly block: string;
}

/** Meters over which detail textures fade out. */
export const DETAIL_FADE = 60;
/** How far a layer's height (0..1) moves its share of a blend. */
export const HEIGHT_BLEND = 0.6;
/** The blend band left after height blending: shares within this of the strongest mix. */
export const BLEND_DEPTH = 0.25;
/** How far a noise meander moves the boundary between layers (in weight). */
export const EDGE_MEANDER = 0.2;
/** Bump amplitude in meters: per meter of texture repeat (textured without a normal map), and for patterns. */
export const RELIEF_PER_TILE = 0.012;
export const PATTERN_RELIEF = 0.035;

const f = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// ── WGSL ─────────────────────────────────────────────────────────────────────────

const WGSL_SURFACE = /* wgsl */ `
fn tHash(p: vec2<f32>) -> f32 {
  let q = bitcast<vec2<u32>>(vec2<i32>(floor(p)));
  var h = (q.x * 374761393u) ^ (q.y * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) * (1.0 / 4294967296.0);
}

fn tNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let r = fract(p);
  let u = r * r * (3.0 - 2.0 * r);
  let a = tHash(i);
  let b = tHash(i + vec2<f32>(1.0, 0.0));
  let c = tHash(i + vec2<f32>(0.0, 1.0));
  let d = tHash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// How much of a feature at \`freq\` cycles per meter survives \`px\` meters per pixel: all of
// it at 4+ pixels per cycle, none at the Nyquist limit.
fn tKeep(freq: f32, px: f32) -> f32 {
  return clamp((0.5 - px * freq) * 4.0, 0.0, 1.0);
}

// One octave, faded to its mean before it aliases.
fn tOctave(q: vec2<f32>, freq: f32, px: f32, seed: f32) -> f32 {
  let keep = tKeep(freq, px);
  if (keep <= 0.0) { return 0.5; }
  return mix(0.5, tNoise(q * freq + vec2<f32>(seed, seed * 1.7)), keep);
}

// The noise every pattern is built from, on one projection plane.
struct Ground {
  det: f32,
  fine: f32,
  crack: f32,
  agg: f32,
};

fn groundAt(q: vec2<f32>, px: f32) -> Ground {
  var g: Ground;
  g.det = tOctave(q, 0.06, px, 0.0) * 0.5 + tOctave(q, 0.21, px, 3.1) * 0.3 + tOctave(q, 0.7, px, 7.7) * 0.2;
  g.fine = tOctave(q, 2.3, px, 11.3) * 0.6 + tOctave(q, 6.1, px, 5.9) * 0.4;
  let crackKeep = tKeep(7.0, px);
  g.crack = 0.0;
  if (crackKeep > 0.0) {
    // Thin seams along the crests of a noise field, only where a broad gate lets them: a
    // sparse network, not a contour map.
    let gate = smoothstep(0.5, 0.72, tNoise(q * 0.045 + vec2<f32>(61.0, 13.0)));
    let ridge = 1.0 - abs(2.0 * tNoise(q * 0.9 + vec2<f32>(17.0, 2.0)) - 1.0);
    g.crack = smoothstep(0.95, 0.995, ridge) * gate * crackKeep;
  }
  g.agg = tOctave(q, 4.0, px, 23.0) * 0.4 + tOctave(q, 11.0, px, 29.0) * 0.36 + tOctave(q, 31.0, px, 31.0) * 0.24;
  return g;
}

fn mixGround(a: Ground, b: Ground, t: f32) -> Ground {
  return Ground(mix(a.det, b.det, t), mix(a.fine, b.fine, t), mix(a.crack, b.crack, t), mix(a.agg, b.agg, t));
}

// A pattern's albedo multiplier (rgb) and height (w), at its full default strength.
fn patternOf(kind: f32, g: Ground, q: vec2<f32>, y: f32, lush: f32, px: f32) -> vec4<f32> {
  let k = i32(kind + 0.5);
  if (k == 1) {
    let m = (0.72 + 0.52 * g.det) * (1.0 + 0.3 * (g.fine - 0.5));
    let hue = mix(vec3<f32>(0.9, 1.06, 0.88), vec3<f32>(1.2, 1.02, 0.7), lush);
    return vec4<f32>(hue * m, g.fine * 0.6 + g.det * 0.4);
  }
  if (k == 2) {
    let strata = 0.86 + 0.22 * sin(y * 0.7 + g.det * 6.0) * tKeep(0.11, px);
    let m = (0.78 + 0.42 * g.det) * strata * (1.0 - 0.38 * g.crack) * (1.0 + 0.22 * (g.fine - 0.5));
    return vec4<f32>(vec3<f32>(m), g.det * 0.45 + g.fine * 0.35 + (1.0 - g.crack) * 0.2);
  }
  if (k == 3) {
    let keep = tKeep(0.42, px);
    let ripple = mix(0.5, 0.5 + 0.5 * sin(dot(q, vec2<f32>(2.2, 1.4)) + g.det * 9.0), keep);
    let m = (0.9 + 0.18 * g.det) * (1.0 + 0.12 * (ripple - 0.5)) * (1.0 + 0.12 * (g.agg - 0.5));
    return vec4<f32>(vec3<f32>(m), ripple * 0.6 + g.det * 0.4);
  }
  if (k == 4) {
    let m = (1.0 + 0.55 * (g.agg - 0.5)) * (1.0 - 0.16 * g.det) * (1.0 - 0.3 * g.crack);
    return vec4<f32>(vec3<f32>(m), g.agg * 0.7 + g.det * 0.3 - g.crack * 0.2);
  }
  if (k == 5) {
    let m = 0.93 + 0.1 * g.det + 0.04 * (g.fine - 0.5);
    let hue = mix(vec3<f32>(0.96, 0.98, 1.03), vec3<f32>(1.0, 1.0, 0.99), g.det);
    return vec4<f32>(hue * m, g.det * 0.7 + g.fine * 0.3);
  }
  let m = (0.8 + 0.4 * g.det) * (1.0 + 0.26 * (g.fine - 0.5)) * (1.0 + 0.14 * (g.agg - 0.5));
  let hue = mix(vec3<f32>(0.97, 1.0, 1.04), vec3<f32>(1.05, 0.99, 0.93), lush);
  return vec4<f32>(hue * m, g.det * 0.4 + g.fine * 0.4 + g.agg * 0.2);
}

// Texture coordinates (meters) for one pixel and their screen derivatives: top-down, the
// rotated anti-tiling twin, the two side planes, and how they mix.
struct Proj {
  top: vec2<f32>,
  alt: vec2<f32>,
  sx: vec2<f32>,
  sz: vec2<f32>,
  dTop: vec4<f32>,
  dAlt: vec4<f32>,
  dSx: vec4<f32>,
  dSz: vec4<f32>,
  altMix: f32,
  side: f32,
  wx: f32,
};

fn arrayTap(t: texture_2d_array<f32>, s: sampler, uv: vec2<f32>, d: vec4<f32>, layer: i32, inv: f32) -> vec3<f32> {
  return textureSampleGrad(t, s, uv * inv, layer, d.xy * inv, d.zw * inv).rgb;
}

// A layer's base color, its four projections mixed.
fn projectedColor(t: texture_2d_array<f32>, s: sampler, pr: Proj, layer: i32, inv: f32) -> vec3<f32> {
  let a = arrayTap(t, s, pr.top, pr.dTop, layer, inv);
  let b = arrayTap(t, s, pr.alt, pr.dAlt, layer, inv);
  let x = arrayTap(t, s, pr.sx, pr.dSx, layer, inv);
  let z = arrayTap(t, s, pr.sz, pr.dSz, layer, inv);
  return mix(mix(a, b, pr.altMix), mix(z, x, pr.wx), pr.side);
}

// A layer's normal map (OpenGL: +y up the image), each projection's sample turned into a
// world-space tilt, mixed.
fn projectedTilt(t: texture_2d_array<f32>, s: sampler, pr: Proj, layer: i32, inv: f32) -> vec3<f32> {
  let a = arrayTap(t, s, pr.top, pr.dTop, layer, inv) * 2.0 - 1.0;
  let b = arrayTap(t, s, pr.alt, pr.dAlt, layer, inv) * 2.0 - 1.0;
  let x = arrayTap(t, s, pr.sx, pr.dSx, layer, inv) * 2.0 - 1.0;
  let z = arrayTap(t, s, pr.sz, pr.dSz, layer, inv) * 2.0 - 1.0;
  let top = mix(vec3<f32>(a.x, 0.0, -a.y), vec3<f32>(0.8 * b.x - 0.6 * b.y, 0.0, -0.6 * b.x - 0.8 * b.y), pr.altMix);
  let side = mix(vec3<f32>(z.x, z.y, 0.0), vec3<f32>(0.0, x.y, x.x), pr.wx);
  return mix(top, side, pr.side);
}
`;

export function wgslTerrain(mrt: boolean, c: ShaderChunks): string {
  return `${c.frame}${c.common}${c.shadows}${c.lighting}${c.outputs}
${c.block}
@group(1) @binding(0) var<uniform> terrain: Terrain;
@group(1) @binding(1) var albedoArray: texture_2d_array<f32>;
@group(1) @binding(2) var normalArray: texture_2d_array<f32>;
@group(1) @binding(3) var detail0: texture_2d<f32>;
@group(1) @binding(4) var detail1: texture_2d<f32>;
@group(1) @binding(5) var detail2: texture_2d<f32>;
@group(1) @binding(6) var detail3: texture_2d<f32>;
@group(1) @binding(7) var layerSampler: sampler;
@group(1) @binding(8) var splatMap: texture_2d<f32>;
${WGSL_SURFACE}
struct VertexIn {
  @location(${L.position}) position: vec3<f32>,
  @location(${L.normal}) normal: vec3<f32>,
  @location(${L.uv}) morph: vec2<f32>,
  @location(${L.color}) weights: vec4<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) weights: vec4<f32>,
};

@vertex fn vs(v: VertexIn) -> VertexOut {
  var p = v.position;
  let span = max(terrain.terrainParams.z - terrain.terrainParams.y, 1e-3);
  let k = clamp((distance(p, frame.cameraPosition.xyz) - terrain.terrainParams.y) / span, 0.0, 1.0);
  p.y = mix(p.y, v.morph.x, k);
  var out: VertexOut;
  out.clip = frame.viewProjection * vec4<f32>(p, 1.0);
  out.world = p;
  out.normal = v.normal;
  out.weights = v.weights;
  return out;
}

// One palette slot's albedo, height (0..1) and world-space normal-map tilt.
struct Surf {
  albedo: vec3<f32>,
  h: f32,
  tilt: vec3<f32>,
};

// Slot i's mode word (terrain_plan.ts packLayerMode): x mode (0 untextured, 1 textured,
// 2 recolored), y 1 with a normal map, z the material's index.
fn modeOf(i: i32) -> vec3<f32> {
  let word = terrain.layerColor[i].w;
  let index = floor(word / 8.0 + 0.001);
  let rest = word - index * 8.0;
  let mapped = select(0.0, 1.0, rest > 3.5);
  return vec3<f32>(rest - mapped * 4.0, mapped, index);
}

// The palette's weights from the splat map (three materials per plane, planes stacked).
fn splatWeights(p: vec2<f32>) -> vec4<f32> {
  let s = terrain.terrainSplat;
  let dims = vec2<f32>(textureDimensions(splatMap, 0));
  let gx = clamp((p.x / s.x + 0.5) * (dims.x - 1.0), 0.0, dims.x - 1.0);
  let gz = clamp((p.y / s.y + 0.5) * (s.z - 1.0), 0.0, s.z - 1.0);
  var w = vec4<f32>(0.0);
  for (var i = 0; i < 4; i++) {
    if (f32(i) >= terrain.terrainParams.x) { break; }
    let index = modeOf(i).z;
    let plane = floor(index / 3.0 + 0.001);
    let texel = textureSampleLevel(splatMap, layerSampler, vec2<f32>((gx + 0.5) / dims.x, (gz + 0.5 + plane * s.z) / dims.y), 0.0);
    w[i] = texel[i32(index - plane * 3.0 + 0.5)];
  }
  return w;
}

fn surfaceOf(i: i32, w: f32, grain: vec3<f32>, fade: f32, g: Ground, q: vec2<f32>, y: f32, lush: f32, macroTint: vec3<f32>, px: f32, pr: Proj) -> Surf {
  var out: Surf;
  out.albedo = vec3<f32>(0.5);
  out.h = 0.5;
  out.tilt = vec3<f32>(0.0);
  if (w <= 0.0005) { return out; }
  let packed = terrain.layerPattern[i];
  let kind = floor(packed);
  let variation = clamp((packed - kind) * 2.0, 0.0, 1.0);
  let amp = variation * 2.0;
  let m = modeOf(i);
  let mode = m.x;
  if (mode < 0.5) {
    let pat = patternOf(kind, g, q, y, lush, px);
    out.albedo = terrain.layerColor[i].rgb * max(mix(vec3<f32>(1.0), pat.rgb, amp), vec3<f32>(0.0));
    out.h = mix(0.5, pat.w, min(amp, 1.0));
  } else {
    let layer = i32(terrain.layerSurface[i].w + 0.5);
    let inv = 1.0 / terrain.layerTint[i].w;
    let c = projectedColor(albedoArray, layerSampler, pr, layer, inv);
    let mean = max(textureSampleLevel(albedoArray, layerSampler, vec2<f32>(0.5, 0.5), layer, 14.0).rgb, vec3<f32>(0.02));
    out.albedo = select(c * terrain.layerTint[i].rgb, c / mean * terrain.layerColor[i].rgb, mode > 1.5);
    out.h = clamp(0.5 + (luminance(c) - luminance(mean)) * 2.0, 0.0, 1.0);
    if (m.y > 0.5) { out.tilt = projectedTilt(normalArray, layerSampler, pr, layer, inv) * terrain.layerRelief[i]; }
  }
  out.albedo *= mix(vec3<f32>(1.0), macroTint, min(variation * 1.6, 1.0));
  out.albedo *= mix(1.0, luminance(grain) * 2.0, terrain.layerSurface[i].z * fade);
  return out;
}

@fragment fn fs(in: VertexOut) -> FragOut {
  let p = in.world.xz;
  let fw = fwidth(in.world);
  let px = max(max(fw.x, fw.z), fw.y);
  let dWx = dpdx(in.world);
  let dWy = dpdy(in.world);
  let n0 = normalize(in.normal);
  let slope = 1.0 - clamp(n0.y, 0.0, 1.0);
  let ax = n0.x * n0.x * n0.x * n0.x;
  let az = n0.z * n0.z * n0.z * n0.z;
  let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
  var pr: Proj;
  pr.top = p;
  pr.alt = rot * p * 0.87 + vec2<f32>(13.7, 7.1);
  pr.sx = vec2<f32>(in.world.z, -in.world.y);
  pr.sz = vec2<f32>(in.world.x, -in.world.y);
  pr.dTop = vec4<f32>(dWx.xz, dWy.xz);
  pr.dAlt = vec4<f32>(rot * dWx.xz * 0.87, rot * dWy.xz * 0.87);
  pr.dSx = vec4<f32>(dWx.z, -dWx.y, dWy.z, -dWy.y);
  pr.dSz = vec4<f32>(dWx.x, -dWx.y, dWy.x, -dWy.y);
  pr.altMix = smoothstep(0.32, 0.68, tNoise(p * 0.083 + vec2<f32>(3.7, 1.3)));
  pr.side = smoothstep(0.3, 0.55, slope);
  pr.wx = ax / max(ax + az, 1e-5);
  let d0 = textureSample(detail0, layerSampler, p / terrain.layerSurface[0].y).rgb;
  let d1 = textureSample(detail1, layerSampler, p / terrain.layerSurface[1].y).rgb;
  let d2 = textureSample(detail2, layerSampler, p / terrain.layerSurface[2].y).rgb;
  let d3 = textureSample(detail3, layerSampler, p / terrain.layerSurface[3].y).rgb;
  let fade = 1.0 - smoothstep(${f(DETAIL_FADE * 0.5)}, ${f(DETAIL_FADE)}, distance(in.world, frame.cameraPosition.xyz));

  // Pattern noise: top-down, and from the side where the ground is steep.
  var g = groundAt(p, px);
  if (pr.side > 0.001) {
    var gs: Ground;
    if (pr.wx < 0.01) {
      gs = groundAt(pr.sz, px);
    } else if (pr.wx > 0.99) {
      gs = groundAt(pr.sx, px);
    } else {
      gs = mixGround(groundAt(pr.sz, px), groundAt(pr.sx, px), pr.wx);
    }
    g = mixGround(g, gs, pr.side);
  }
  let lush = smoothstep(0.25, 0.75, tNoise(p * 0.013 + vec2<f32>(5.3, 1.9))) * 0.75;
  let macroN = tNoise(p * 0.018 + vec2<f32>(4.1, 8.7)) * 0.55 + tNoise(p * 0.047) * 0.45;
  let macroTint = mix(vec3<f32>(0.9, 0.93, 0.97), vec3<f32>(1.1, 1.07, 1.01), macroN);
  let y = in.world.y;
  // Per-pixel weights from the splat map where there is one; the vertex weights otherwise.
  var w0 = in.weights;
  if (terrain.terrainSplat.w > 0.5) {
    let ws = splatWeights(p);
    let sum = ws.x + ws.y + ws.z + ws.w;
    if (sum > 0.01) { w0 = ws / sum; }
  }
  let s0 = surfaceOf(0, w0.x, d0, fade, g, p, y, lush, macroTint, px, pr);
  let s1 = surfaceOf(1, w0.y, d1, fade, g, p, y, lush, macroTint, px, pr);
  let s2 = surfaceOf(2, w0.z, d2, fade, g, p, y, lush, macroTint, px, pr);
  let s3 = surfaceOf(3, w0.w, d3, fade, g, p, y, lush, macroTint, px, pr);

  // Height blending: a layer's height pushes its share; shares within BLEND_DEPTH of the top
  // one mix. Plus a meander (two noise scales, pushing the slots apart) so even two flat
  // layers meet along a ragged line instead of the grid's straight interpolation.
  let hs = vec4<f32>(s0.h, s1.h, s2.h, s3.h);
  let meander = (tOctave(p, 0.23, px, 41.0) - 0.5) + 0.6 * (tOctave(p, 1.3, px, 47.0) - 0.5);
  let b = w0 + ((hs - 0.5) * ${f(HEIGHT_BLEND)} + meander * ${f(EDGE_MEANDER)} * vec4<f32>(1.0, -1.0, 0.7, -0.7)) * smoothstep(vec4<f32>(0.0), vec4<f32>(0.15), w0);
  let top = max(max(b.x, b.y), max(b.z, b.w));
  let wh = max(b - vec4<f32>(top - ${f(BLEND_DEPTH)}), vec4<f32>(0.0));
  let w = wh / max(wh.x + wh.y + wh.z + wh.w, 1e-5);
  var albedo = s0.albedo * w.x + s1.albedo * w.y + s2.albedo * w.z + s3.albedo * w.w;
  var roughness = clamp(dot(w, vec4<f32>(terrain.layerSurface[0].x, terrain.layerSurface[1].x, terrain.layerSurface[2].x, terrain.layerSurface[3].x)), 0.04, 1.0);

  // Relief: normal maps tilt the normal; layers without one bump it by their height (meters).
  let m0 = modeOf(0);
  let m1 = modeOf(1);
  let m2 = modeOf(2);
  let m3 = modeOf(3);
  let textured = step(vec4<f32>(0.5), vec4<f32>(m0.x, m1.x, m2.x, m3.x));
  let tiles = vec4<f32>(terrain.layerTint[0].w, terrain.layerTint[1].w, terrain.layerTint[2].w, terrain.layerTint[3].w);
  let mapped = vec4<f32>(m0.y, m1.y, m2.y, m3.y);
  let amps = terrain.layerRelief * mix(vec4<f32>(${f(PATTERN_RELIEF)}), tiles * ${f(RELIEF_PER_TILE)} * (1.0 - mapped), textured);
  let height = dot(w * amps, hs - 0.5);
  let dhx = dpdx(height);
  let dhy = dpdy(height);
  let r1 = cross(dWy, n0);
  let r2 = cross(n0, dWx);
  let det = dot(dWx, r1);
  let bumped = abs(det) * n0 - sign(det) * (dhx * r1 + dhy * r2);
  var nb = n0;
  if (abs(det) > 1e-12 && dot(bumped, bumped) > 1e-20) { nb = normalize(bumped); }
  let tilted = nb + s0.tilt * w.x + s1.tilt * w.y + s2.tilt * w.z + s3.tilt * w.w;
  let n = normalize(select(nb, tilted, dot(tilted, tilted) > 1e-8));
  let reliefW = min(dot(w, terrain.layerRelief), 1.0);
  let occlusion = 1.0 - 0.35 * clamp(0.5 - dot(w, hs), 0.0, 0.5) * 2.0 * reliefW;

  // Damp ground just above the water line.
  let wet = (1.0 - smoothstep(0.15, 1.1, y - terrain.terrainParams.w)) * (1.0 - 0.5 * pr.side);
  albedo *= mix(1.0, 0.62, wet);
  roughness = mix(roughness, 0.35, wet);

  var out: FragOut;
  if (frame.style.y > 0.5) {
    out.color = vec4<f32>(mix(albedo, frame.wireColor.rgb, frame.wireColor.w), 0.0);
${mrt ? '    out.surface = vec4<f32>(0.0, 0.0, 1.0, 0.0);' : ''}
    return out;
  }
  let lit = lighting(in.world, n, albedo, 0.0, roughness, occlusion, in.clip.xy, noLayers(n));
  out.color = vec4<f32>(applyFog(lit.rgb, in.world), lit.a);
${mrt ? '  out.surface = vec4<f32>(octEncode(n), roughness, 0.04);' : ''}
  return out;
}
`;
}

// ── GLSL ES 3.00 ─────────────────────────────────────────────────────────────────

const GLSL_SURFACE = /* glsl */ `
float tHash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)));
  uint h = (q.x * 374761393u) ^ (q.y * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) * (1.0 / 4294967296.0);
}

float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 r = fract(p);
  vec2 u = r * r * (3.0 - 2.0 * r);
  float a = tHash(i);
  float b = tHash(i + vec2(1.0, 0.0));
  float c = tHash(i + vec2(0.0, 1.0));
  float d = tHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float tKeep(float freq, float px) {
  return clamp((0.5 - px * freq) * 4.0, 0.0, 1.0);
}

float tOctave(vec2 q, float freq, float px, float seed) {
  float keep = tKeep(freq, px);
  if (keep <= 0.0) return 0.5;
  return mix(0.5, tNoise(q * freq + vec2(seed, seed * 1.7)), keep);
}

struct Ground {
  float det;
  float fine;
  float crack;
  float agg;
};

Ground groundAt(vec2 q, float px) {
  Ground g;
  g.det = tOctave(q, 0.06, px, 0.0) * 0.5 + tOctave(q, 0.21, px, 3.1) * 0.3 + tOctave(q, 0.7, px, 7.7) * 0.2;
  g.fine = tOctave(q, 2.3, px, 11.3) * 0.6 + tOctave(q, 6.1, px, 5.9) * 0.4;
  float crackKeep = tKeep(7.0, px);
  g.crack = 0.0;
  if (crackKeep > 0.0) {
    float gate = smoothstep(0.5, 0.72, tNoise(q * 0.045 + vec2(61.0, 13.0)));
    float ridge = 1.0 - abs(2.0 * tNoise(q * 0.9 + vec2(17.0, 2.0)) - 1.0);
    g.crack = smoothstep(0.95, 0.995, ridge) * gate * crackKeep;
  }
  g.agg = tOctave(q, 4.0, px, 23.0) * 0.4 + tOctave(q, 11.0, px, 29.0) * 0.36 + tOctave(q, 31.0, px, 31.0) * 0.24;
  return g;
}

Ground mixGround(Ground a, Ground b, float t) {
  return Ground(mix(a.det, b.det, t), mix(a.fine, b.fine, t), mix(a.crack, b.crack, t), mix(a.agg, b.agg, t));
}

vec4 patternOf(float kind, Ground g, vec2 q, float y, float lush, float px) {
  int k = int(kind + 0.5);
  if (k == 1) {
    float m = (0.72 + 0.52 * g.det) * (1.0 + 0.3 * (g.fine - 0.5));
    vec3 hue = mix(vec3(0.9, 1.06, 0.88), vec3(1.2, 1.02, 0.7), lush);
    return vec4(hue * m, g.fine * 0.6 + g.det * 0.4);
  }
  if (k == 2) {
    float strata = 0.86 + 0.22 * sin(y * 0.7 + g.det * 6.0) * tKeep(0.11, px);
    float m = (0.78 + 0.42 * g.det) * strata * (1.0 - 0.38 * g.crack) * (1.0 + 0.22 * (g.fine - 0.5));
    return vec4(vec3(m), g.det * 0.45 + g.fine * 0.35 + (1.0 - g.crack) * 0.2);
  }
  if (k == 3) {
    float keep = tKeep(0.42, px);
    float ripple = mix(0.5, 0.5 + 0.5 * sin(dot(q, vec2(2.2, 1.4)) + g.det * 9.0), keep);
    float m = (0.9 + 0.18 * g.det) * (1.0 + 0.12 * (ripple - 0.5)) * (1.0 + 0.12 * (g.agg - 0.5));
    return vec4(vec3(m), ripple * 0.6 + g.det * 0.4);
  }
  if (k == 4) {
    float m = (1.0 + 0.55 * (g.agg - 0.5)) * (1.0 - 0.16 * g.det) * (1.0 - 0.3 * g.crack);
    return vec4(vec3(m), g.agg * 0.7 + g.det * 0.3 - g.crack * 0.2);
  }
  if (k == 5) {
    float m = 0.93 + 0.1 * g.det + 0.04 * (g.fine - 0.5);
    vec3 hue = mix(vec3(0.96, 0.98, 1.03), vec3(1.0, 1.0, 0.99), g.det);
    return vec4(hue * m, g.det * 0.7 + g.fine * 0.3);
  }
  float m = (0.8 + 0.4 * g.det) * (1.0 + 0.26 * (g.fine - 0.5)) * (1.0 + 0.14 * (g.agg - 0.5));
  vec3 hue = mix(vec3(0.97, 1.0, 1.04), vec3(1.05, 0.99, 0.93), lush);
  return vec4(hue * m, g.det * 0.4 + g.fine * 0.4 + g.agg * 0.2);
}

struct Proj {
  vec2 top;
  vec2 alt;
  vec2 sx;
  vec2 sz;
  vec4 dTop;
  vec4 dAlt;
  vec4 dSx;
  vec4 dSz;
  float altMix;
  float side;
  float wx;
};

vec3 arrayTap(sampler2DArray t, vec2 uv, vec4 d, float layer, float inv) {
  return textureGrad(t, vec3(uv * inv, layer), d.xy * inv, d.zw * inv).rgb;
}

// A layer's base color, its four projections mixed.
vec3 projectedColor(sampler2DArray t, Proj pr, float layer, float inv) {
  vec3 a = arrayTap(t, pr.top, pr.dTop, layer, inv);
  vec3 b = arrayTap(t, pr.alt, pr.dAlt, layer, inv);
  vec3 x = arrayTap(t, pr.sx, pr.dSx, layer, inv);
  vec3 z = arrayTap(t, pr.sz, pr.dSz, layer, inv);
  return mix(mix(a, b, pr.altMix), mix(z, x, pr.wx), pr.side);
}

// A layer's normal map, each projection's sample turned into a world-space tilt, mixed.
vec3 projectedTilt(sampler2DArray t, Proj pr, float layer, float inv) {
  vec3 a = arrayTap(t, pr.top, pr.dTop, layer, inv) * 2.0 - 1.0;
  vec3 b = arrayTap(t, pr.alt, pr.dAlt, layer, inv) * 2.0 - 1.0;
  vec3 x = arrayTap(t, pr.sx, pr.dSx, layer, inv) * 2.0 - 1.0;
  vec3 z = arrayTap(t, pr.sz, pr.dSz, layer, inv) * 2.0 - 1.0;
  vec3 topTilt = mix(vec3(a.x, 0.0, -a.y), vec3(0.8 * b.x - 0.6 * b.y, 0.0, -0.6 * b.x - 0.8 * b.y), pr.altMix);
  vec3 sideTilt = mix(vec3(z.x, z.y, 0.0), vec3(0.0, x.y, x.x), pr.wx);
  return mix(topTilt, sideTilt, pr.side);
}
`;

export interface GlslTerrainChunks extends ShaderChunks {
  readonly header: string;
  readonly depthRemap: string;
  readonly pixel: string;
}

export function glslTerrain(mrt: boolean, c: GlslTerrainChunks): { vertex: string; fragment: string } {
  return {
    vertex: `${c.header}${c.frame}${c.block}
layout(location = ${L.position}) in vec3 position;
layout(location = ${L.normal}) in vec3 normal;
layout(location = ${L.uv}) in vec2 morph;
layout(location = ${L.color}) in vec4 weights;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vWeights;
void main() {
  vec3 p = position;
  float span = max(terrainParams.z - terrainParams.y, 1e-3);
  float k = clamp((distance(p, cameraPosition.xyz) - terrainParams.y) / span, 0.0, 1.0);
  p.y = mix(p.y, morph.x, k);
  vWorld = p;
  vNormal = normal;
  vWeights = weights;
  gl_Position = viewProjection * vec4(p, 1.0);
  ${c.depthRemap}
}
`,
    fragment: `${c.header}${c.frame}${c.block}${c.common}${c.shadows}${c.lighting}
precision highp sampler2DArray;
uniform sampler2DArray terrainAlbedo;
uniform sampler2DArray terrainNormal;
uniform sampler2D detail0;
uniform sampler2D detail1;
uniform sampler2D detail2;
uniform sampler2D detail3;
uniform sampler2D splatMap;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vWeights;
${c.outputs}
${GLSL_SURFACE}
struct Surf {
  vec3 albedo;
  float h;
  vec3 tilt;
};

vec3 modeOf(int i) {
  float word = layerColor[i].w;
  float index = floor(word / 8.0 + 0.001);
  float rest = word - index * 8.0;
  float mapped = rest > 3.5 ? 1.0 : 0.0;
  return vec3(rest - mapped * 4.0, mapped, index);
}

vec4 splatWeights(vec2 p) {
  vec4 s = terrainSplat;
  vec2 dims = vec2(textureSize(splatMap, 0));
  float gx = clamp((p.x / s.x + 0.5) * (dims.x - 1.0), 0.0, dims.x - 1.0);
  float gz = clamp((p.y / s.y + 0.5) * (s.z - 1.0), 0.0, s.z - 1.0);
  vec4 w = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= terrainParams.x) break;
    float index = modeOf(i).z;
    float plane = floor(index / 3.0 + 0.001);
    vec4 texel = textureLod(splatMap, vec2((gx + 0.5) / dims.x, (gz + 0.5 + plane * s.z) / dims.y), 0.0);
    w[i] = texel[int(index - plane * 3.0 + 0.5)];
  }
  return w;
}

Surf surfaceOf(int i, float w, vec3 grain, float fade, Ground g, vec2 q, float y, float lush, vec3 macroTint, float px, Proj pr) {
  Surf out_;
  out_.albedo = vec3(0.5);
  out_.h = 0.5;
  out_.tilt = vec3(0.0);
  if (w <= 0.0005) return out_;
  float packed = layerPattern[i];
  float kind = floor(packed);
  float variation = clamp((packed - kind) * 2.0, 0.0, 1.0);
  float amp = variation * 2.0;
  vec3 m = modeOf(i);
  float mode = m.x;
  if (mode < 0.5) {
    vec4 pat = patternOf(kind, g, q, y, lush, px);
    out_.albedo = layerColor[i].rgb * max(mix(vec3(1.0), pat.rgb, amp), vec3(0.0));
    out_.h = mix(0.5, pat.w, min(amp, 1.0));
  } else {
    float layer = floor(layerSurface[i].w + 0.5);
    float inv = 1.0 / layerTint[i].w;
    vec3 c = projectedColor(terrainAlbedo, pr, layer, inv);
    vec3 mean = max(textureLod(terrainAlbedo, vec3(0.5, 0.5, layer), 14.0).rgb, vec3(0.02));
    out_.albedo = mode > 1.5 ? c / mean * layerColor[i].rgb : c * layerTint[i].rgb;
    out_.h = clamp(0.5 + (luminance(c) - luminance(mean)) * 2.0, 0.0, 1.0);
    if (m.y > 0.5) out_.tilt = projectedTilt(terrainNormal, pr, layer, inv) * layerRelief[i];
  }
  out_.albedo *= mix(vec3(1.0), macroTint, min(variation * 1.6, 1.0));
  out_.albedo *= mix(1.0, luminance(grain) * 2.0, layerSurface[i].z * fade);
  return out_;
}
void main() {
  vec2 p = vWorld.xz;
  vec3 fw = fwidth(vWorld);
  float px = max(max(fw.x, fw.z), fw.y);
  vec3 dWx = dFdx(vWorld);
  vec3 dWy = dFdy(vWorld);
  vec3 n0 = normalize(vNormal);
  float slope = 1.0 - clamp(n0.y, 0.0, 1.0);
  float ax = n0.x * n0.x * n0.x * n0.x;
  float az = n0.z * n0.z * n0.z * n0.z;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  Proj pr;
  pr.top = p;
  pr.alt = rot * p * 0.87 + vec2(13.7, 7.1);
  pr.sx = vec2(vWorld.z, -vWorld.y);
  pr.sz = vec2(vWorld.x, -vWorld.y);
  pr.dTop = vec4(dWx.xz, dWy.xz);
  pr.dAlt = vec4(rot * dWx.xz * 0.87, rot * dWy.xz * 0.87);
  pr.dSx = vec4(dWx.z, -dWx.y, dWy.z, -dWy.y);
  pr.dSz = vec4(dWx.x, -dWx.y, dWy.x, -dWy.y);
  pr.altMix = smoothstep(0.32, 0.68, tNoise(p * 0.083 + vec2(3.7, 1.3)));
  pr.side = smoothstep(0.3, 0.55, slope);
  pr.wx = ax / max(ax + az, 1e-5);
  vec3 d0 = texture(detail0, p / layerSurface[0].y).rgb;
  vec3 d1 = texture(detail1, p / layerSurface[1].y).rgb;
  vec3 d2 = texture(detail2, p / layerSurface[2].y).rgb;
  vec3 d3 = texture(detail3, p / layerSurface[3].y).rgb;
  float fade = 1.0 - smoothstep(${f(DETAIL_FADE * 0.5)}, ${f(DETAIL_FADE)}, distance(vWorld, cameraPosition.xyz));

  Ground g = groundAt(p, px);
  if (pr.side > 0.001) {
    Ground gs;
    if (pr.wx < 0.01) {
      gs = groundAt(pr.sz, px);
    } else if (pr.wx > 0.99) {
      gs = groundAt(pr.sx, px);
    } else {
      gs = mixGround(groundAt(pr.sz, px), groundAt(pr.sx, px), pr.wx);
    }
    g = mixGround(g, gs, pr.side);
  }
  float lush = smoothstep(0.25, 0.75, tNoise(p * 0.013 + vec2(5.3, 1.9))) * 0.75;
  float macroN = tNoise(p * 0.018 + vec2(4.1, 8.7)) * 0.55 + tNoise(p * 0.047) * 0.45;
  vec3 macroTint = mix(vec3(0.9, 0.93, 0.97), vec3(1.1, 1.07, 1.01), macroN);
  float y = vWorld.y;
  vec4 w0 = vWeights;
  if (terrainSplat.w > 0.5) {
    vec4 ws = splatWeights(p);
    float sum = ws.x + ws.y + ws.z + ws.w;
    if (sum > 0.01) w0 = ws / sum;
  }
  Surf s0 = surfaceOf(0, w0.x, d0, fade, g, p, y, lush, macroTint, px, pr);
  Surf s1 = surfaceOf(1, w0.y, d1, fade, g, p, y, lush, macroTint, px, pr);
  Surf s2 = surfaceOf(2, w0.z, d2, fade, g, p, y, lush, macroTint, px, pr);
  Surf s3 = surfaceOf(3, w0.w, d3, fade, g, p, y, lush, macroTint, px, pr);

  vec4 hs = vec4(s0.h, s1.h, s2.h, s3.h);
  float meander = (tOctave(p, 0.23, px, 41.0) - 0.5) + 0.6 * (tOctave(p, 1.3, px, 47.0) - 0.5);
  vec4 b = w0 + ((hs - 0.5) * ${f(HEIGHT_BLEND)} + meander * ${f(EDGE_MEANDER)} * vec4(1.0, -1.0, 0.7, -0.7)) * smoothstep(vec4(0.0), vec4(0.15), w0);
  float top = max(max(b.x, b.y), max(b.z, b.w));
  vec4 wh = max(b - vec4(top - ${f(BLEND_DEPTH)}), vec4(0.0));
  vec4 w = wh / max(wh.x + wh.y + wh.z + wh.w, 1e-5);
  vec3 albedo = s0.albedo * w.x + s1.albedo * w.y + s2.albedo * w.z + s3.albedo * w.w;
  float roughness = clamp(dot(w, vec4(layerSurface[0].x, layerSurface[1].x, layerSurface[2].x, layerSurface[3].x)), 0.04, 1.0);

  vec3 m0 = modeOf(0);
  vec3 m1 = modeOf(1);
  vec3 m2 = modeOf(2);
  vec3 m3 = modeOf(3);
  vec4 textured = step(vec4(0.5), vec4(m0.x, m1.x, m2.x, m3.x));
  vec4 tiles = vec4(layerTint[0].w, layerTint[1].w, layerTint[2].w, layerTint[3].w);
  vec4 mapped = vec4(m0.y, m1.y, m2.y, m3.y);
  vec4 amps = layerRelief * mix(vec4(${f(PATTERN_RELIEF)}), tiles * ${f(RELIEF_PER_TILE)} * (1.0 - mapped), textured);
  float height = dot(w * amps, hs - 0.5);
  float dhx = dFdx(height);
  float dhy = dFdy(height);
  vec3 r1 = cross(dWy, n0);
  vec3 r2 = cross(n0, dWx);
  float det = dot(dWx, r1);
  vec3 bumped = abs(det) * n0 - sign(det) * (dhx * r1 + dhy * r2);
  vec3 nb = n0;
  if (abs(det) > 1e-12 && dot(bumped, bumped) > 1e-20) nb = normalize(bumped);
  vec3 tilted = nb + s0.tilt * w.x + s1.tilt * w.y + s2.tilt * w.z + s3.tilt * w.w;
  vec3 n = dot(tilted, tilted) > 1e-8 ? normalize(tilted) : nb;
  float reliefW = min(dot(w, layerRelief), 1.0);
  float occlusion = 1.0 - 0.35 * clamp(0.5 - dot(w, hs), 0.0, 0.5) * 2.0 * reliefW;

  float wet = (1.0 - smoothstep(0.15, 1.1, y - terrainParams.w)) * (1.0 - 0.5 * pr.side);
  albedo *= mix(1.0, 0.62, wet);
  roughness = mix(roughness, 0.35, wet);

  if (style.y > 0.5) {
    fragColor = vec4(mix(albedo, wireColor.rgb, wireColor.w), 0.0);
${mrt ? '    fragSurface = vec4(0.0, 0.0, 1.0, 0.0);' : ''}
    return;
  }
  vec4 lit = lighting(vWorld, n, albedo, 0.0, roughness, occlusion, ${c.pixel}, noLayers(n));
  fragColor = vec4(applyFog(lit.rgb, vWorld), lit.a);
${mrt ? '  fragSurface = vec4(octEncode(n), roughness, 0.04);' : ''}
}
`,
  };
}
