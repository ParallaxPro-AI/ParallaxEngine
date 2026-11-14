/**
 * Surface mask layers (`Material3d.paint`) in the mesh pass, written side by side in WGSL
 * and GLSL like `material_fx_shaders.ts` (whose `fxNoise` they use, so they come after it).
 * The mesh fragment shader calls `paintShade` with its base color, metalness, roughness and
 * transmission before lighting; a material without paint (`paintGrid.x` 0) is untouched.
 *
 * The mask is a volume of cells stored as slices in one 2D texture (`paintGrid.w` slices
 * per row, `paintGrid.xy` texels each). A fragment's cell comes from its world position
 * through `paintVolume`; two slices are blended for the third axis, and texel lookups are
 * clamped half a texel inside a slice so the filter never reads the next one. Each layer's
 * amount is broken up by noise at its edge and varied in tone, then laid over what is under
 * it, first layer to last.
 */

/** WGSL helpers; needs `material: Material` (layout.ts MATERIAL_FIELDS) and `paintTexture` / `paintSampler`. */
export const WGSL_PAINT = `
fn paintTexel(cell: vec2<f32>, slice: f32) -> vec4<f32> {
  let tiles = material.paintGrid.w;
  let row = floor(slice / tiles);
  let tile = vec2<f32>(slice - tiles * row, row);
  let p = tile * material.paintGrid.xy + clamp(cell, vec2<f32>(0.5), material.paintGrid.xy - vec2<f32>(0.5));
  return textureSampleLevel(paintTexture, paintSampler, p * material.paintAtlas.xy, 0.0);
}

fn paintAmounts(q: vec3<f32>) -> vec4<f32> {
  let low = min(min(q.x, q.y), q.z);
  let high = max(max(q.x, q.y), q.z);
  if (low < 0.0) { return vec4<f32>(0.0); }
  if (high > 1.0) { return vec4<f32>(0.0); }
  let c = q * material.paintGrid.xyz;
  let z = clamp(c.z - 0.5, 0.0, material.paintGrid.z - 1.0);
  let z0 = floor(z);
  let z1 = min(z0 + 1.0, material.paintGrid.z - 1.0);
  return mix(paintTexel(c.xy, z0), paintTexel(c.xy, z1), z - z0);
}

struct Painted {
  albedo: vec3<f32>,
  metallic: f32,
  roughness: f32,
  transmission: f32,
  /** The most any layer covers here (0..1): a clear coat lies under the layers, so it fades with this. */
  covered: f32,
};

fn paintShade(world: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32, transmission: f32) -> Painted {
  var out = Painted(albedo, metallic, roughness, transmission, 0.0);
  let q = (material.paintVolume * vec4<f32>(world, 1.0)).xyz;
  let a = paintAmounts(q);
  let meters = q * material.paintGrid.xyz * material.paintAtlas.z;
  for (var k = 0; k < 4; k++) {
    if (f32(k) >= material.paintAtlas.w) { break; }
    let amount = a[k];
    if (amount <= 0.002) { continue; }
    let look = material.paintColor[k];
    let finish = material.paintSurface[k];
    let p = meters * look.w + vec3<f32>(f32(k) * 17.0);
    let n = 0.6 * fxNoise(p) + 0.4 * fxNoise(p * 3.1 + vec3<f32>(5.0, 1.0, 9.0));
    let cover = max(smoothstep(0.38, 0.62, amount + (n - 0.5) * finish.z), smoothstep(0.93, 1.0, amount));
    let tone = 0.72 + 0.56 * fxNoise(p * 4.7 + vec3<f32>(3.0, 3.0, 3.0));
    out.albedo = mix(out.albedo, look.rgb * tone, cover);
    out.roughness = mix(out.roughness, finish.x, cover);
    out.metallic = mix(out.metallic, finish.y, cover);
    out.transmission = out.transmission * (1.0 - cover);
    out.covered = max(out.covered, cover);
  }
  return out;
}
`;

/** GLSL ES 3.00 helpers; needs the Material block (bare field names) and `paintTexture`. */
export const GLSL_PAINT = `
vec4 paintTexel(vec2 cell, float slice) {
  float tiles = paintGrid.w;
  float row = floor(slice / tiles);
  vec2 tile = vec2(slice - tiles * row, row);
  vec2 p = tile * paintGrid.xy + clamp(cell, vec2(0.5), paintGrid.xy - vec2(0.5));
  return textureLod(paintTexture, p * paintAtlas.xy, 0.0);
}

vec4 paintAmounts(vec3 q) {
  if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(1.0)))) return vec4(0.0);
  vec3 c = q * paintGrid.xyz;
  float z = clamp(c.z - 0.5, 0.0, paintGrid.z - 1.0);
  float z0 = floor(z);
  float z1 = min(z0 + 1.0, paintGrid.z - 1.0);
  return mix(paintTexel(c.xy, z0), paintTexel(c.xy, z1), z - z0);
}

void paintShade(vec3 world, inout vec3 albedo, inout float metallic, inout float roughness, inout float transmission, out float covered) {
  covered = 0.0;
  vec3 q = (paintVolume * vec4(world, 1.0)).xyz;
  vec4 a = paintAmounts(q);
  vec3 meters = q * paintGrid.xyz * paintAtlas.z;
  for (int k = 0; k < 4; k++) {
    if (float(k) >= paintAtlas.w) break;
    float amount = a[k];
    if (amount <= 0.002) continue;
    vec4 look = paintColor[k];
    vec4 finish = paintSurface[k];
    vec3 p = meters * look.w + vec3(float(k) * 17.0);
    float n = 0.6 * fxNoise(p) + 0.4 * fxNoise(p * 3.1 + vec3(5.0, 1.0, 9.0));
    float cover = max(smoothstep(0.38, 0.62, amount + (n - 0.5) * finish.z), smoothstep(0.93, 1.0, amount));
    float tone = 0.72 + 0.56 * fxNoise(p * 4.7 + vec3(3.0));
    albedo = mix(albedo, look.rgb * tone, cover);
    roughness = mix(roughness, finish.x, cover);
    metallic = mix(metallic, finish.y, cover);
    transmission *= 1.0 - cover;
    covered = max(covered, cover);
  }
}
`;
