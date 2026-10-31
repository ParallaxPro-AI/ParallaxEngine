/**
 * Water shaders (written in WGSL, translated with `natureGlsl` like sky_shaders.ts):
 *
 *   copy        the lit scene and its depth into the water pass's own textures (the
 *               surface reads them while it draws into the scene)
 *   underwater  with the camera under a body: everything is seen through water — light
 *               absorbed by distance (red first), the water's own color scattered in, and
 *               caustics on what is under the surface
 *   surface     each body's mesh displaced by its Gerstner waves (the CPU's waves.ts, term
 *               for term); per pixel: wave normals plus moving detail (carried by the current
 *               in rivers), refraction of what is behind (offset by the normal, never
 *               picking up what is in front), absorption and in-scattering by the water's
 *               thickness, caustics on the bed, reflection of the sky (the environment
 *               cube) and of the scene (screen-space, high quality), the sun's glint, foam
 *               on crests, along shores and in splash and wake rings, soft shorelines, fog
 *               and aerial perspective. Seen from below: Snell's window, total internal
 *               reflection outside it, and underwater haze to the surface.
 *
 * Grid meshes: an ocean is a camera-centered grid stretched outward (|g|^2.2, 4 km; its edge
 * ring a flat skirt out to 100 km, past every far plane), a
 * lake or pool the same grid spread linearly over its rectangle (ellipses discard outside),
 * a river its ribbon. Vertex inputs: grid (vec2 in -1..1), or ribbon position and flow.
 */

import { GLSL_HEADER } from './shaders.js';
import { BODY_VEC4S } from './sky_plan.js';
import { GLSL_NATURE_DECL, GLSL_WATER_DECL, natureCommon, natureGlsl, WGSL_NATURE_DECL, WGSL_WATER_DECL } from './sky_shaders.js';

/**
 * Meters an ocean grid's fine part reaches, and its stretch exponent. The grid's outermost
 * ring of vertices goes on to OCEAN_HORIZON: one flat skirt (waves that long are far below its
 * spacing) that carries the sea past any far plane, as the old clipmap's coarsest rings did.
 */
export const OCEAN_REACH = 4000;
export const OCEAN_STRETCH = 2.2;
export const OCEAN_HORIZON = 100000;
/** Vertices per side of the shared grid. */
export const GRID_SIDE = 256;

// The water draws no clouds of its own (the sky's cube and composite do): the cheapest steps, either mode.
const STEPS = natureCommon(0, 'flat');

/** Water functions shared by the passes (WGSL, convertible). */
const WATER_COMMON = /* wgsl */ `
fn bodyVec(b: i32, k: i32) -> vec4<f32> {
  return wat.bodies[b * ${BODY_VEC4S} + k];
}

/**
 * Gerstner displacement (dx, dy, dz) of rest position (x, z) at time t. A wave shorter than
 * about three times the mesh's vertex spacing there is left out of the geometry (its normal
 * still shades the pixel): undersampled by the vertices it would alias into crawling moire.
 */
fn gerstner(b: i32, x: f32, z: f32, t: f32, spacing: f32) -> vec3<f32> {
  let range: vec4<f32> = bodyVec(b, 2);
  let first: i32 = i32(range.z + 0.5);
  let count: i32 = i32(range.w + 0.5);
  var d: vec3<f32> = vec3<f32>(0.0);
  for (var i = 0; i < count; i = i + 1) {
    let w0: vec4<f32> = wat.waves[(first + i) * 2];
    let w1: vec4<f32> = wat.waves[(first + i) * 2 + 1];
    let keep: f32 = 1.0 - smoothstep(0.28, 0.4, spacing * w0.z * 0.159155);
    let theta: f32 = w0.z * (w0.x * x + w0.y * z) - w0.w * t + w1.z;
    let a: f32 = w1.x * keep;
    let qa: f32 = w1.y * a * cos(theta);
    d = d + vec3<f32>(qa * w0.x, a * sin(theta), qa * w0.y);
  }
  return d;
}

/** How much one wave survives a pixel footprint meters wide (it fades before it aliases). */
fn waveKeep(k: f32, footprint: f32) -> f32 {
  return 1.0 - smoothstep(0.22, 0.5, footprint * k * 0.159155);
}

/** The waves' surface normal at rest position (x, z), and the sum of their amplitudes in w. */
fn gerstnerNormal(b: i32, x: f32, z: f32, t: f32, footprint: f32) -> vec4<f32> {
  let range: vec4<f32> = bodyVec(b, 2);
  let first: i32 = i32(range.z + 0.5);
  let count: i32 = i32(range.w + 0.5);
  var n: vec3<f32> = vec3<f32>(0.0, 1.0, 0.0);
  var amp: f32 = 0.0;
  for (var i = 0; i < count; i = i + 1) {
    let w0: vec4<f32> = wat.waves[(first + i) * 2];
    let w1: vec4<f32> = wat.waves[(first + i) * 2 + 1];
    let theta: f32 = w0.z * (w0.x * x + w0.y * z) - w0.w * t + w1.z;
    let ka: f32 = w0.z * w1.x * waveKeep(w0.z, footprint);
    n = n - vec3<f32>(w0.x * ka * cos(theta), w1.y * ka * sin(theta), w0.y * ka * cos(theta));
    amp = amp + w1.x;
  }
  return vec4<f32>(normalize(n), amp);
}

/**
 * More about the waves at a fragment: x where the crests pinch (0..1: the Gerstner surface's
 * horizontal compression, normalized by what the set can reach, so whitecaps sit on the
 * sharpest crests), y the slope variance the pixel filter took out (handed back as
 * roughness), z the set's choppiness (sum of Q·k·a).
 */
fn waveExtras(b: i32, x: f32, z: f32, t: f32, footprint: f32) -> vec4<f32> {
  let range: vec4<f32> = bodyVec(b, 2);
  let first: i32 = i32(range.z + 0.5);
  let count: i32 = i32(range.w + 0.5);
  var squeeze: f32 = 0.0;
  var reach: f32 = 0.0;
  var lost: f32 = 0.0;
  for (var i = 0; i < count; i = i + 1) {
    let w0: vec4<f32> = wat.waves[(first + i) * 2];
    let w1: vec4<f32> = wat.waves[(first + i) * 2 + 1];
    let theta: f32 = w0.z * (w0.x * x + w0.y * z) - w0.w * t + w1.z;
    let qka: f32 = w1.y * w0.z * w1.x;
    squeeze = squeeze + qka * sin(theta);
    reach = reach + qka;
    let ka: f32 = w0.z * w1.x;
    lost = lost + ka * ka * 0.5 * (1.0 - waveKeep(w0.z, footprint));
  }
  return vec4<f32>(clamp(squeeze / max(reach, 0.0001), -1.0, 1.0), lost, reach, 0.0);
}

/** The direction (x, z) the body's longest-running wave travels, or +z for still water. */
fn mainDirection(b: i32) -> vec2<f32> {
  let range: vec4<f32> = bodyVec(b, 2);
  if (range.w < 0.5) { return vec2<f32>(0.0, 1.0); }
  let w0: vec4<f32> = wat.waves[i32(range.z + 0.5) * 2];
  return w0.xy;
}

fn turned(v: vec2<f32>, a: f32) -> vec2<f32> {
  let c: f32 = cos(a);
  let s: f32 = sin(a);
  return vec2<f32>(v.x * c + v.y * s, -v.x * s + v.y * c);
}

/**
 * Wind chop and capillary ripples on top of the waves, as a normal tilt (x, z) and in z the
 * slope variance filtered out: six octaves of crossed deep-water wavelets (0.28 m to 6 m,
 * each moving at its own dispersion speed) in a slowly warped domain, so nothing tiles.
 * Each octave fades as the pixel footprint nears half its wavelength (no distant shimmer
 * or moire), and what it would have added goes to the roughness instead.
 */
fn chop(xz: vec2<f32>, t: f32, footprint: f32, dir: vec2<f32>) -> vec3<f32> {
  let warp: vec2<f32> = vec2<f32>(sin(xz.y * 0.13 + t * 0.21), sin(xz.x * 0.11 - t * 0.17)) * 2.4
    + vec2<f32>(sin(xz.y * 0.47 - t * 0.37 + xz.x * 0.21), sin(xz.x * 0.43 + t * 0.29 - xz.y * 0.17)) * 0.6;
  let p: vec2<f32> = xz + warp;
  // Gusts: the chop is patchy (two drifting fields, coarse octaves on one, fine on the other).
  let gustA: f32 = vnoise2(xz * 0.045 + vec2<f32>(t * 0.031, -t * 0.017));
  let gustB: f32 = vnoise2(xz * 0.13 + vec2<f32>(-t * 0.05, t * 0.04) + vec2<f32>(5.3, 1.9));
  var tilt: vec2<f32> = vec2<f32>(0.0);
  var lost: f32 = 0.0;
  var len: f32 = 6.0;
  var slope: f32 = 0.11;
  for (var i = 0; i < 6; i = i + 1) {
    let fi: f32 = f32(i);
    let k: f32 = 6.2832 / len;
    let w: f32 = sqrt(9.81 * k);
    let keep: f32 = 1.0 - smoothstep(0.25, 0.5, footprint / len);
    let d1: vec2<f32> = turned(dir, 0.55 * sin(fi * 2.4 + 0.7));
    let d2: vec2<f32> = turned(dir, -0.8 + 0.6 * cos(fi * 1.9));
    let c1: f32 = cos(dot(p, d1) * k - w * t + fi * 1.7);
    let c2: f32 = cos(dot(p, d2) * k * 1.13 - w * 1.06 * t + fi * 4.1);
    let gust: f32 = 0.3 + 1.4 * mix(gustA, gustB, fi / 5.0);
    tilt = tilt + (d1 * c1 + d2 * c2 * 0.8) * (slope * keep * gust);
    lost = lost + slope * slope * 0.82 * (1.0 - keep);
    len = len * 0.54;
    slope = slope * 0.82;
  }
  return vec3<f32>(tilt, lost);
}

/** Value noise faded to its mean once a pixel is wider than half its feature (no boiling far off). */
fn filteredNoise(p: vec2<f32>, feature: f32, footprint: f32) -> f32 {
  let resolvable: f32 = clamp(feature / max(2.0 * footprint, 0.0001) - 0.5, 0.0, 1.0);
  return mix(0.5, vnoise2(p), resolvable);
}

/** Bright lines of focused sunlight on the bed (two warped interference layers). */
fn caustic(p: vec2<f32>, t: f32) -> f32 {
  var q: vec2<f32> = p * 0.7;
  var c: f32 = 0.0;
  for (var i = 0; i < 3; i = i + 1) {
    let fi: f32 = f32(i);
    q = q + vec2<f32>(sin(q.y * 1.7 + t * (0.8 + fi * 0.3)), cos(q.x * 1.3 - t * (0.6 + fi * 0.2))) * 0.5;
    c = c + abs(sin(q.x + q.y));
  }
  return pow(1.0 - clamp(c / 3.0, 0.0, 1.0), 4.0) * 3.0;
}

fn absorbOf(b: i32) -> vec3<f32> {
  return vec3<f32>(2.2, 0.75, 0.45) / max(bodyVec(b, 3).w, 0.1);
}

fn lightOnWater() -> vec3<f32> {
  // Diffuse light units: the sun's radiance / PI (as the scene's surfaces; ambient is irradiance).
  return nat.ambientLight.xyz + nat.sunColor.xyz * (nat.toSun.w * max(nat.toSun.y, 0.0) * 0.31830989);
}

/** Light the water scatters toward an eye under it: bright shallows near the surface, the deep color below. */
fn underwaterGlow(b: i32, eyeDepth: f32) -> vec3<f32> {
  let k: f32 = clamp(eyeDepth / max(bodyVec(b, 3).w * 1.5, 0.1), 0.0, 1.0);
  return mix(bodyVec(b, 4).xyz, bodyVec(b, 3).xyz, k) * lightOnWater() * 0.8;
}

fn worldAt(pixel: vec2<f32>, depth: f32) -> vec3<f32> {
  let uv: vec2<f32> = (pixel - nat.viewport.xy) / nat.viewport.zw;
  let h: vec4<f32> = nat.inverseViewProjection * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return h.xyz / h.w;
}

/** Meters of water straight under a surface pixel down to what the scene drew there (400: nothing). */
fn depthUnder(pixel: vec2<f32>, world: vec3<f32>) -> f32 {
  let d: f32 = loadDepthCopy(pixel);
  if (d >= 1.0) { return 400.0; }
  return max(world.y - worldAt(pixel, d).y, 0.0);
}

/**
 * The scene's fog over dist meters along dir (unit), exactly as the scene's surfaces take it
 * (shaders.ts fogAmount): linear, or exponential with the height falloff integrated along the
 * ray, so the water and the ground beside it fog alike.
 */
fn applyFog(color: vec3<f32>, dir: vec3<f32>, dist: f32) -> vec3<f32> {
  let kind: f32 = nat.fogColor.w;
  var f: f32 = 0.0;
  if (kind > 0.5 && kind < 1.5) {
    var optical: f32 = nat.fogParams.x * dist;
    let falloff: f32 = nat.fogHeight.x;
    if (falloff > 0.0) {
      optical = optical * exp(-falloff * (nat.cameraPos.y - nat.fogHeight.y));
      let rise: f32 = falloff * dir.y * dist;
      if (abs(rise) > 1e-4) { optical = optical * (1.0 - exp(-rise)) / rise; }
    }
    f = 1.0 - exp(-max(optical, 0.0));
  }
  if (kind > 1.5) { f = clamp((dist - nat.fogParams.y) / max(nat.fogParams.z - nat.fogParams.y, 0.001), 0.0, 1.0); }
  return mix(color, nat.fogColor.xyz, f);
}

/** The underwater view: absorption by distance, the water's color in-scattered, caustics on the bed. */
fn underwater(pixel: vec2<f32>) -> vec4<f32> {
  let b: i32 = i32(nat.waterAt.x + 0.5);
  let depth: f32 = loadDepthCopy(pixel);
  let eye: vec3<f32> = nat.cameraPos.xyz;
  var color: vec3<f32> = loadScene(pixel);
  var dist: f32 = 300.0;
  if (depth < 1.0) {
    let p: vec3<f32> = worldAt(pixel, depth);
    dist = min(distance(p, eye), 300.0);
    let below: f32 = nat.waterAt.y - p.y;
    if (below > 0.0) {
      let sunUp: f32 = nat.toSun.w * max(nat.toSun.y, 0.0);
      color = color * (1.0 + caustic(p.xz, nat.misc.y) * exp(-below * 0.3) * bodyVec(b, 5).y * sunUp * 0.8);
    }
  }
  let scatter: vec3<f32> = underwaterGlow(b, max(nat.waterAt.y - eye.y, 0.0));
  let tr: vec3<f32> = exp(-absorbOf(b) * dist);
  return vec4<f32>(color * tr + scatter * (vec3<f32>(1.0) - tr), 1.0);
}

/**
 * The lit surface. normal is the filtered wave + chop normal, amp the set's summed
 * amplitude, extra: waveExtras (crest pinch, lost slope variance, choppiness),
 * variance: all slope variance the filters took out, footprint: meters per pixel.
 */
fn shade(pixel: vec2<f32>, b: i32, world: vec3<f32>, normal: vec3<f32>, amp: f32, extra: vec4<f32>, variance: f32, footprint: f32, toEye: vec3<f32>, eye: vec3<f32>) -> vec4<f32> {
  let t: f32 = nat.misc.y;
  let head: vec4<f32> = bodyVec(b, 0);
  let deep: vec3<f32> = bodyVec(b, 3).xyz;
  let shallow: vec3<f32> = bodyVec(b, 4).xyz;
  let foam: f32 = bodyVec(b, 4).w;
  let clarity: f32 = bodyVec(b, 3).w;
  let dist: f32 = distance(world, eye);
  var n: vec3<f32> = normal;
  let fromBelow: bool = dot(toEye, n) < 0.0 && eye.y < world.y;
  if (fromBelow) { n = -n; }
  let lit: vec3<f32> = lightOnWater();
  let absorb: vec3<f32> = absorbOf(b);

  // What is straight behind this pixel: how deep the water is here (shore foam, soft edge).
  let depth0: f32 = loadDepthCopy(pixel);
  let below0: f32 = depthUnder(pixel, world);

  // What is behind. Straight behind first, then the refracted sample, blended in by a soft
  // weight: how surely it lies behind the surface (never what's in front of the water), how
  // deep the water is (no bend at the waterline) and how far from the screen's edge. No
  // hard switch between the two, so the shallows never break into patches.
  var thick: f32 = 400.0;
  var bed: vec2<f32> = world.xz;
  if (depth0 < 1.0) {
    let p0: vec3<f32> = worldAt(pixel, depth0);
    thick = min(max(distance(p0, eye) - dist, 0.0), 400.0);
    bed = p0.xz;
  }
  var below: f32 = below0;
  var behind: vec3<f32> = loadScene(pixel);
  let uv: vec2<f32> = (pixel - nat.viewport.xy) / nat.viewport.zw;
  let screenEdge: f32 = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  let strength: f32 = 0.035 * smoothstep(0.0, 1.5, below0) * screenEdge;
  let pr: vec2<f32> = pixel + n.xz * (strength * nat.viewport.w);
  let depthR: f32 = loadDepthCopy(pr);
  var thickR: f32 = 400.0;
  var belowR: f32 = 400.0;
  var bedR: vec2<f32> = bed;
  var behindWeight: f32 = 1.0;
  if (depthR < 1.0) {
    let behindR: vec3<f32> = worldAt(pr, depthR);
    let past: f32 = distance(behindR, eye) - dist;
    behindWeight = smoothstep(0.0, 0.6, past);
    thickR = min(max(past, 0.0), 400.0);
    belowR = max(world.y - behindR.y, 0.0);
    bedR = behindR.xz;
  }
  let bend: f32 = behindWeight * smoothstep(0.0, 0.002, strength);
  behind = mix(behind, loadScene(pr), bend);
  thick = mix(thick, thickR, bend);
  below = mix(below, min(belowR, 400.0), bend);
  bed = mix(bed, bedR, bend);

  var color: vec3<f32> = vec3<f32>(0.0);
  if (fromBelow) {
    // Snell's window: beyond ~48.6° from the normal the surface is a mirror of the deep. Far
    // off, the window is judged on the calm surface (grazing waves would only sparkle).
    let calm: vec3<f32> = normalize(mix(n, vec3<f32>(0.0, -1.0, 0.0), clamp(dist / 40.0, 0.0, 1.0)));
    let cosI: f32 = dot(toEye, -calm);
    let sinT: f32 = sqrt(max(0.0, 1.0 - cosI * cosI)) * 1.333;
    let inside: f32 = 1.0 - smoothstep(0.85, 1.0, sinT);
    let glow: vec3<f32> = underwaterGlow(b, max(world.y - eye.y, 0.0));
    color = mix(glow, behind * 0.9, inside);
    let tr: vec3<f32> = exp(-absorb * dist);
    color = color * tr + glow * (vec3<f32>(1.0) - tr);
    return vec4<f32>(color, 1.0);
  }

  let sunUp: f32 = nat.toSun.w * max(nat.toSun.y, 0.0);
  if (below < 300.0 && below > 0.0) {
    behind = behind * (1.0 + caustic(bed, t) * exp(-below * 0.3) * bodyVec(b, 5).y * sunUp * 0.8 * clamp(below * 2.0, 0.0, 1.0));
  }
  // Color by absorption: red dies first along the path through the water, so what is under
  // thin water reads clear, then turquoise, then deep blue, with the water's own color
  // scattered in; light bounced off a shallow bed lifts it toward the shallow color.
  let tr: vec3<f32> = exp(-absorb * thick);
  let bedGlow: f32 = exp(-below / max(clarity * 0.5, 0.1)) * 0.6;
  var scattered: vec3<f32> = mix(deep, shallow, bedGlow) * lit * 0.9;
  // Light through the thin top of a wave toward the eye: crests glow the shallow color.
  let crestUp: f32 = clamp((world.y - head.y) / max(amp, 0.001) * 0.5 + 0.5, 0.0, 1.0);
  let backlit: f32 = pow(max(dot(-toEye.xz, nat.toSun.xz), 0.0), 2.0) * 0.6 + 0.4;
  scattered = scattered + shallow * lit * (0.35 * crestUp * crestUp * crestUp * backlit);
  let refracted: vec3<f32> = behind * tr + scattered * (vec3<f32>(1.0) - tr);

  // Roughness: the body's own plus every bit of slope the filters smoothed out, so a far
  // field of small waves reads as the broad sheen it is instead of glass or sparkle.
  let r0: f32 = bodyVec(b, 5).x;
  let alpha2: f32 = clamp(r0 * r0 * r0 * r0 + 2.0 * variance, 0.0001, 0.35);

  // Reflection: the sky (environment cube, blurrier as the surface roughens), then the scene
  // where a short screen-space march finds it (on a partly flattened normal: a stable image).
  var r: vec3<f32> = reflect(-toEye, n);
  if (r.y < 0.0) { r = normalize(vec3<f32>(r.x, -r.y * 0.3, r.z)); }
  var reflected: vec3<f32> = sampleCube(r, 0.5 + clamp(sqrt(alpha2) * 9.0, 0.0, 5.0)) * nat.misc.w;
  if (nat.ambientLight.w > 1.5) {
    // On a mostly flattened normal: a coherent mirror image that ripples, not a mosaic of
    // pixels that each found something different.
    let rs: vec3<f32> = reflect(-toEye, normalize(mix(vec3<f32>(0.0, 1.0, 0.0), n, 0.12)));
    if (rs.y > 0.002) {
      // March out with growing steps; at the first step behind the scene, bisect to the
      // surface and accept it only if the ray really met it there (not passed behind it).
      var stepLen: f32 = 0.5 + dist * 0.01;
      var prev: vec3<f32> = world;
      var q: vec3<f32> = world;
      var found: bool = false;
      for (var i = 0; i < 24; i = i + 1) {
        prev = q;
        q = q + rs * stepLen;
        stepLen = stepLen * 1.3;
        let clip: vec4<f32> = nat.viewProjection * vec4<f32>(q, 1.0);
        if (clip.w <= 0.0) { break; }
        let ndc: vec3<f32> = clip.xyz / clip.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { break; }
        let px: vec2<f32> = nat.viewport.xy + vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * nat.viewport.zw;
        let d: f32 = loadDepthCopy(px);
        if (d < 1.0 && d < ndc.z) {
          found = true;
          break;
        }
      }
      if (found) {
        var lo: vec3<f32> = prev;
        var hi: vec3<f32> = q;
        for (var k = 0; k < 6; k = k + 1) {
          let mid: vec3<f32> = (lo + hi) * 0.5;
          let clipM: vec4<f32> = nat.viewProjection * vec4<f32>(mid, 1.0);
          let ndcM: vec3<f32> = clipM.xyz / max(clipM.w, 0.0001);
          let pxM: vec2<f32> = nat.viewport.xy + vec2<f32>(ndcM.x * 0.5 + 0.5, 0.5 - ndcM.y * 0.5) * nat.viewport.zw;
          let dM: f32 = loadDepthCopy(pxM);
          if (dM < 1.0 && dM < ndcM.z) { hi = mid; } else { lo = mid; }
        }
        let clipH: vec4<f32> = nat.viewProjection * vec4<f32>(hi, 1.0);
        let ndcH: vec3<f32> = clipH.xyz / max(clipH.w, 0.0001);
        let pxH: vec2<f32> = nat.viewport.xy + vec2<f32>(ndcH.x * 0.5 + 0.5, 0.5 - ndcH.y * 0.5) * nat.viewport.zw;
        let dH: f32 = loadDepthCopy(pxH);
        let hit: vec3<f32> = worldAt(pxH, dH);
        let gap: f32 = distance(eye, hi) - distance(eye, hit);
        if (dH < 1.0 && hit.y > world.y - 0.3) {
          // Confidence, not a yes/no: how surely the ray met the surface it landed on.
          let span: f32 = distance(lo, hi);
          let met: f32 = 1.0 - smoothstep(span * 0.5 + 0.1, span * 2.0 + 0.4, gap);
          let edgeFade: f32 = clamp((1.0 - max(abs(ndcH.x), abs(ndcH.y))) * 5.0, 0.0, 1.0) * met;
          let sharp: f32 = 1.0 - smoothstep(0.05, 0.3, alpha2);
          // A short vertical smear: moving water stretches what it mirrors into streaks.
          let sy: f32 = 4.0;
          let img: vec3<f32> = loadScene(pxH) * 0.4 + (loadScene(pxH + vec2<f32>(0.0, sy)) + loadScene(pxH - vec2<f32>(0.0, sy))) * 0.2
            + (loadScene(pxH + vec2<f32>(0.0, sy * 2.0)) + loadScene(pxH - vec2<f32>(0.0, sy * 2.0))) * 0.1;
          reflected = mix(reflected, img * 0.9, edgeFade * sharp);
        }
      }
    }
  }
  let fres: f32 = 0.02 + 0.98 * pow(1.0 - max(dot(n, toEye), 0.0), 5.0);
  color = mix(refracted, reflected, fres);

  // The sun's glint: a GGX lobe as wide as the filtered roughness (plus the sun's own disc),
  // energy kept, so far off it spreads into a glitter path rather than aliasing to dots.
  let h: vec3<f32> = normalize(toEye + nat.toSun.xyz);
  let nh: f32 = max(dot(n, h), 0.0);
  let a2: f32 = alpha2 + 0.0004;
  let dd: f32 = nh * nh * (a2 - 1.0) + 1.0;
  let ggx: f32 = a2 / (3.14159 * dd * dd);
  let fh: f32 = 0.02 + 0.98 * pow(1.0 - max(dot(h, toEye), 0.0), 5.0);
  let nl: f32 = max(dot(n, nat.toSun.xyz), 0.0);
  let glint: f32 = min(ggx * fh * nl / (4.0 * max(dot(n, toEye), 0.08)), 60.0);
  color = color + nat.sunColor.xyz * (nat.toSun.w * glint * (1.0 - nat.cloudsA.x * 0.8));

  // Foam. Whitecaps where the crests pinch (only on water choppy enough to break), the
  // shore's surf in a band as wide as the foam setting (with lines of it washing in), splash
  // and wake rings; all broken up by noise that fades to its mean before it can alias.
  let breakup: f32 = filteredNoise(world.xz * 0.9 + vec2<f32>(t * 0.21, t * 0.13), 1.1, footprint) * 0.6
    + filteredNoise(world.xz * 2.6 + vec2<f32>(-t * 0.31, t * 0.24) + vec2<f32>(19.1, -7.7), 0.4, footprint) * 0.4;
  // Whitecaps come in groups (a slow field decides where crests may break at all), and far
  // off, where single caps are below a pixel, they average to a faint sheen.
  let breaking: f32 = smoothstep(0.45, 0.85, extra.z);
  let group: f32 = smoothstep(0.52, 0.72, filteredNoise(world.xz * 0.021 + vec2<f32>(t * 0.012, -t * 0.008), 45.0, footprint));
  let capCore: f32 = smoothstep(0.6, 0.95, extra.x + (breakup - 0.5) * 0.5);
  let capFar: f32 = smoothstep(0.4, 2.0, footprint);
  let crest: f32 = mix(capCore, 0.12, capFar) * group * breaking * foam * 1.4;
  // Surf. Along the shore a slow field sets how wide the surf zone is and where it gaps; in
  // it, foam lines wash in (a bright front with a fading trail) and dissolve near the
  // waterline into swash, all cut out of a lace texture by a coverage that is highest at
  // the shore and where waves break, so the edge is torn and soft, never a painted band.
  // Every noise fades to its mean before it can alias, which leaves a soft band far off.
  let along: f32 = filteredNoise(world.xz * 0.06 + vec2<f32>(t * 0.008, -t * 0.005), 16.0, footprint);
  let gaps: f32 = filteredNoise(world.xz * 0.17 + vec2<f32>(-t * 0.03, t * 0.02) + vec2<f32>(11.0, 3.0), 6.0, footprint);
  let band: f32 = (1.0 + 4.0 * along) * (0.4 + 1.2 * foam);
  let x: f32 = below0 / max(band, 0.05);
  let near: f32 = 1.0 - smoothstep(0.0, 1.0, x);
  let phase: f32 = fract(x * 1.7 + t * 0.16 + gaps * 0.8);
  let front: f32 = smoothstep(0.0, 0.07, phase) * (1.0 - smoothstep(0.07, 0.5, phase));
  let line: f32 = front * smoothstep(0.08, 0.35, x) * near * smoothstep(0.3, 0.6, gaps + 0.15);
  let lace: f32 = filteredNoise(world.xz * 1.7 + vec2<f32>(t * 0.09, t * 0.05), 0.55, footprint) * 0.55
    + filteredNoise(world.xz * 0.55 + vec2<f32>(-t * 0.04, t * 0.06) + vec2<f32>(5.0, 9.0), 1.8, footprint) * 0.45;
  let breakers: f32 = smoothstep(0.3, 0.9, extra.x) * near * smoothstep(0.2, 0.6, extra.z);
  let coverage: f32 = pow(near, 2.0) * (0.25 + 0.7 * gaps) + line * 1.0 + breakers * 0.4;
  let surf: f32 = smoothstep(0.0, 0.35, lace + coverage - 0.85) * (0.5 + 0.5 * near);
  // Swash: the last of each wave at the waterline, its width wandering along the shore.
  let swashWidth: f32 = (0.08 + 0.5 * along * gaps) * (0.5 + foam);
  let swash: f32 = (1.0 - smoothstep(0.0, swashWidth, below0)) * smoothstep(0.25, 0.6, lace * 0.6 + gaps * 0.7);
  let shore: f32 = max(swash * 0.85, surf) * min(foam * 1.8, 1.0);
  var rings: f32 = 0.0;
  let count: i32 = i32(nat.waterAt.w + 0.5);
  for (var i = 0; i < count; i = i + 1) {
    let rp: vec4<f32> = wat.ripples[i];
    let dd2: f32 = distance(world.xz, rp.xy);
    let ring: f32 = (dd2 - rp.z) / 0.3;
    rings = rings + (exp(-ring * ring) + 0.35 * exp(-dd2 * dd2 / max(rp.z * rp.z, 0.01))) * rp.w * (0.4 + 1.2 * breakup);
  }
  // A soft shoreline: the thinnest water shows what's under it, darkened where it is wet.
  let wet: f32 = 1.0 - smoothstep(0.0, 0.35, below0);
  let soft: f32 = smoothstep(0.0, 0.2, below0);
  color = mix(loadScene(pixel) * (1.0 - 0.4 * wet), color, soft);

  let white: f32 = clamp(max(max(crest, shore), rings), 0.0, 1.0);
  let foamLight: vec3<f32> = vec3<f32>(0.9, 0.94, 0.96) * (nat.ambientLight.xyz + nat.sunColor.xyz * sunUp * 0.85 * 0.31830989);
  // Thin foam is translucent, thick foam opaque.
  color = mix(color, foamLight, white * (0.55 + 0.4 * white));
  color = applyFog(color, -toEye, dist);
  let haze: vec4<f32> = aerial(-toEye, dist, (world.y + eye.y) * 0.5);
  return vec4<f32>(color * haze.w + haze.xyz, 1.0);
}

/** The lit surface at a fragment: world (displaced), rest (x, z), flow (dir x, dir z, speed, river), meters per pixel; x < 0: not drawn. */
fn surface(pixel: vec2<f32>, b: i32, world: vec3<f32>, rest: vec2<f32>, flow: vec4<f32>, footprint: f32) -> vec4<f32> {
  let head: vec4<f32> = bodyVec(b, 0);
  let t: f32 = nat.misc.y;
  if (head.x > 0.5 && head.x < 2.5 && head.w > 0.5) {
    // An ellipse: outside it, nothing.
    let c: f32 = cos(head.z);
    let s: f32 = sin(head.z);
    let off: vec2<f32> = rest - bodyVec(b, 1).xz;
    let extent: vec4<f32> = bodyVec(b, 2);
    let lx: f32 = (off.x * c - off.y * s) / extent.x;
    let lz: f32 = (off.x * s + off.y * c) / extent.y;
    if (lx * lx + lz * lz > 1.0) { return vec4<f32>(-1.0); }
  }
  let eye: vec3<f32> = nat.cameraPos.xyz;
  let toEye: vec3<f32> = normalize(eye - world);
  let waves: vec4<f32> = gerstnerNormal(b, rest.x, rest.y, t, footprint);
  let extra: vec4<f32> = waveExtras(b, rest.x, rest.y, t, footprint);
  // Chop as strong as the water is rough (a pool barely stirs), plus rain on it.
  var strength: f32 = (0.35 + clamp(waves.w * 2.5, 0.0, 1.1)) * (1.0 + 0.8 * nat.weatherOn.z);
  var dir: vec2<f32> = mainDirection(b);
  var detail: vec3<f32> = chop(world.xz, t, footprint, dir);
  if (flow.w > 0.5) {
    // Rivers: chop carried downstream (two phases crossfaded, so it never stretches out).
    dir = flow.xy;
    let phase: f32 = fract(t * 0.25);
    let along: vec2<f32> = flow.xy * (flow.z * 4.0);
    let first: vec3<f32> = chop(world.xz - along * phase, t, footprint, dir);
    let second: vec3<f32> = chop(world.xz - along * fract(phase + 0.5) + vec2<f32>(7.3, 2.1), t, footprint, dir);
    detail = mix(first, second, abs(phase * 2.0 - 1.0));
    strength = strength + 0.3 * flow.z;
  }
  // The body's ripple strength, and its calm distance: farther off the surface settles to a
  // mirror of the sky, as a hazy sea reads (0: never).
  let calmAt: f32 = bodyVec(b, 5).w;
  var calm: f32 = 1.0;
  if (calmAt > 0.0) { calm = 1.0 - smoothstep(calmAt * 0.15, calmAt, distance(world, eye)); }
  strength = strength * bodyVec(b, 5).z * calm;
  let n: vec3<f32> = normalize(mix(vec3<f32>(0.0, 1.0, 0.0), waves.xyz, calm) + vec3<f32>(detail.x, 0.0, detail.y) * strength);
  let variance: f32 = (extra.y + detail.z * strength * strength) * calm;
  return shade(pixel, b, world, n, waves.w, extra, variance, footprint, toEye, eye);
}

/** A grid vertex's rest position (x, z) for a body. */
fn restOf(b: i32, g: vec2<f32>) -> vec2<f32> {
  let head: vec4<f32> = bodyVec(b, 0);
  if (head.x < 0.5) {
    let snap: vec2<f32> = floor(nat.cameraPos.xz);
    let stretched: vec2<f32> = sign(g) * pow(abs(g), vec2<f32>(${OCEAN_STRETCH.toFixed(2)})) * ${OCEAN_REACH.toFixed(1)};
    // The edge vertices (|g| = 1) go out to the horizon skirt.
    let edge: vec2<f32> = step(vec2<f32>(0.9999), abs(g));
    return snap + mix(stretched, sign(g) * ${OCEAN_HORIZON.toFixed(1)}, edge);
  }
  let center: vec4<f32> = bodyVec(b, 1);
  let extent: vec4<f32> = bodyVec(b, 2);
  let c: f32 = cos(head.z);
  let s: f32 = sin(head.z);
  let lx: f32 = g.x * extent.x;
  let lz: f32 = g.y * extent.y;
  // The body's x axis is (cos, -sin), its z axis (sin, cos) on the ground.
  return center.xz + vec2<f32>(lx * c + lz * s, -lx * s + lz * c);
}

/** Meters between the mesh's vertices around a rest position (the grid is stretched for an ocean). */
fn spacingAt(b: i32, rest: vec2<f32>) -> f32 {
  let head: vec4<f32> = bodyVec(b, 0);
  if (head.x < 0.5) {
    let r: f32 = max(distance(rest, nat.cameraPos.xz), 0.5);
    return ${OCEAN_STRETCH.toFixed(2)} * pow(${OCEAN_REACH.toFixed(1)}, 1.0 / ${OCEAN_STRETCH.toFixed(2)}) * pow(r, 1.0 - 1.0 / ${OCEAN_STRETCH.toFixed(2)}) * ${(2 / (GRID_SIDE - 1)).toFixed(6)};
  }
  if (head.x > 2.5) { return 1.0; }
  let extent: vec4<f32> = bodyVec(b, 2);
  return max(extent.x, extent.y) * ${(2 / (GRID_SIDE - 1)).toFixed(6)};
}
`;

const WGSL_BINDINGS = `${WGSL_NATURE_DECL}${WGSL_WATER_DECL}
@group(0) @binding(1) var<uniform> wat: Water;
@group(0) @binding(2) var sceneCopy: texture_2d<f32>;
@group(0) @binding(3) var depthCopy: texture_2d<f32>;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var linearSampler: sampler;

fn clampPixel(pixel: vec2<f32>) -> vec2<i32> {
  let size: vec2<i32> = vec2<i32>(textureDimensions(depthCopy));
  return clamp(vec2<i32>(floor(pixel)), vec2<i32>(0), size - vec2<i32>(1));
}
fn loadDepthCopy(pixel: vec2<f32>) -> f32 {
  return textureLoad(depthCopy, clampPixel(pixel), 0).r;
}
fn loadScene(pixel: vec2<f32>) -> vec3<f32> {
  return textureLoad(sceneCopy, clampPixel(pixel), 0).rgb;
}
fn sampleCube(dir: vec3<f32>, lod: f32) -> vec3<f32> {
  return textureSampleLevel(envCube, linearSampler, dir, lod).rgb;
}
`;

/** WGSL: the copy pass (its own bindings). */
export const WGSL_WATER_COPY = `
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
struct CopyOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: vec4<f32>,
};
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(corners[index], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) at: vec4<f32>) -> CopyOut {
  let p: vec2<i32> = vec2<i32>(floor(at.xy));
  var out: CopyOut;
  out.color = textureLoad(color, p, 0);
  out.depth = vec4<f32>(textureLoad(depth, p, 0), 0.0, 0.0, 1.0);
  return out;
}
`;

/** WGSL: the underwater pass and the surfaces (grid and ribbon vertex entries). */
export function wgslWater(): string {
  return `${WGSL_BINDINGS}${STEPS}${WATER_COMMON}
@vertex fn under_vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(corners[index], 0.0, 1.0);
}
@fragment fn under_fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
  return underwater(at.xy);
}

struct SurfaceOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) rest: vec2<f32>,
  @location(2) flow: vec4<f32>,
  @location(3) @interpolate(flat) body: i32,
};

fn place(b: i32, rest: vec2<f32>, level: f32, flow: vec4<f32>) -> SurfaceOut {
  let d: vec3<f32> = gerstner(b, rest.x, rest.y, nat.misc.y, spacingAt(b, rest));
  var out: SurfaceOut;
  out.world = vec3<f32>(rest.x + d.x, level + d.y, rest.y + d.z);
  out.rest = rest;
  out.flow = flow;
  out.body = b;
  out.clip = nat.viewProjection * vec4<f32>(out.world, 1.0);
  return out;
}

@vertex fn grid_vs(@location(0) g: vec2<f32>, @builtin(instance_index) body: u32) -> SurfaceOut {
  let b: i32 = i32(body);
  return place(b, restOf(b, g), bodyVec(b, 0).y, vec4<f32>(0.0));
}

@vertex fn ribbon_vs(@location(0) position: vec3<f32>, @location(1) flow: vec4<f32>, @builtin(instance_index) body: u32) -> SurfaceOut {
  return place(i32(body), position.xz, position.y, vec4<f32>(flow.xyz, 1.0));
}

@fragment fn surface_fs(in: SurfaceOut) -> @location(0) vec4<f32> {
  let footprint: f32 = max(length(fwidth(in.world.xz)), 0.001);
  let c: vec4<f32> = surface(in.clip.xy, in.body, in.world, in.rest, in.flow, footprint);
  if (c.x < 0.0) { discard; }
  return c;
}
`;
}

const GLSL_HELPERS = `
uniform sampler2D sceneCopy;
uniform sampler2D depthCopy;
uniform samplerCube envCube;
ivec2 clampPixel(vec2 pixel) {
  ivec2 size = textureSize(depthCopy, 0);
  return clamp(ivec2(floor(vec2(pixel.x, targetSize.y - 1.0 - pixel.y))), ivec2(0), size - ivec2(1));
}
float loadDepthCopy(vec2 pixel) {
  // RGBA8 packed (any WebGL2 can render it): 24 bits of depth, alpha flags the sky.
  vec4 e = texelFetch(depthCopy, clampPixel(pixel), 0);
  if (e.a > 0.5) { return 1.0; }
  return dot(e.xyz, vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0));
}
vec3 loadScene(vec2 pixel) {
  return texelFetch(sceneCopy, clampPixel(pixel), 0).rgb;
}
vec3 sampleCube(vec3 dir, float lod) {
  return textureLod(envCube, dir, lod).rgb;
}
`;

const GLSL_FULLSCREEN = `${GLSL_HEADER}
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}
`;

/** GLSL: the copy pass (depth packed into RGBA8: float targets aren't renderable everywhere). */
export const GLSL_WATER_COPY = {
  vertex: GLSL_FULLSCREEN,
  fragment: `${GLSL_HEADER}
uniform sampler2D color;
uniform sampler2D depth;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;
void main() {
  ivec2 p = ivec2(floor(gl_FragCoord.xy));
  outColor = texelFetch(color, p, 0);
  float d = texelFetch(depth, p, 0).r;
  if (d >= 1.0) {
    outDepth = vec4(1.0);
  } else {
    vec3 e = fract(d * vec3(1.0, 255.0, 65025.0));
    e.xy -= e.yz / 255.0;
    outDepth = vec4(e, 0.0);
  }
}
`,
};

const GLSL_COMMON_WATER = (): string => `${GLSL_NATURE_DECL}${GLSL_WATER_DECL}${GLSL_HELPERS}${natureGlsl(STEPS + WATER_COMMON)}`;

/** GLSL: the underwater pass. */
export function glslUnderwater(): { vertex: string; fragment: string } {
  return {
    vertex: GLSL_FULLSCREEN,
    fragment: `${GLSL_HEADER}${GLSL_COMMON_WATER()}
out vec4 fragColor;
void main() {
  fragColor = underwater(vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y));
}
`,
  };
}

/** GLSL: a surface program for the grid or for ribbons (uniform `uBody` names the body). */
export function glslSurface(ribbon: boolean): { vertex: string; fragment: string } {
  const inputs = ribbon
    ? 'layout(location = 0) in vec3 position;\nlayout(location = 1) in vec4 flowIn;\n'
    : 'layout(location = 0) in vec2 g;\n';
  const place = ribbon
    ? 'vec2 rest = position.xz; float level = position.y; vFlow = vec4(flowIn.xyz, 1.0);'
    : 'vec2 rest = restOf(uBody, g); float level = bodyVec(uBody, 0).y; vFlow = vec4(0.0);';
  return {
    vertex: `${GLSL_HEADER}${GLSL_COMMON_WATER()}
uniform int uBody;
${inputs}out vec3 vWorld;
out vec2 vRest;
out vec4 vFlow;
void main() {
  ${place}
  vec3 d = gerstner(uBody, rest.x, rest.y, misc.y, spacingAt(uBody, rest));
  vWorld = vec3(rest.x + d.x, level + d.y, rest.y + d.z);
  vRest = rest;
  gl_Position = viewProjection * vec4(vWorld, 1.0);
  gl_Position.z = gl_Position.z * 2.0 - gl_Position.w;
}
`,
    fragment: `${GLSL_HEADER}${GLSL_COMMON_WATER()}
uniform int uBody;
in vec3 vWorld;
in vec2 vRest;
in vec4 vFlow;
out vec4 fragColor;
void main() {
  float footprint = max(length(fwidth(vWorld.xz)), 0.001);
  vec2 pixel = vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y);
  vec4 c = surface(pixel, uBody, vWorld, vRest, vFlow, footprint);
  if (c.x < 0.0) { discard; }
  fragColor = c;
}
`,
  };
}
