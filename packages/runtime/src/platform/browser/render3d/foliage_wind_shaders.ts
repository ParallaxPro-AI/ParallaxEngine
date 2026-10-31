/**
 * Per-blade and per-leaf wind in the mesh vertex shader (WGSL and GLSL side by side), for
 * materials with `Material3d.wind` (render3d's grass and foliage leaves).
 *
 * The CPU already leans each instance downwind: its model matrix shears +y by the local wind
 * (render3d foliage.ts / grass.ts), so the matrix's y column, divided by its height, is the
 * wind's direction and strength there. The shader adds motion on top: a gust wave travelling
 * downwind (phase from the vertex's world position along the wind) plus a faster flutter
 * across it, with a per-blade phase from the vertex's local position, weighted by the
 * square of its height (local y ÷ `wind.height`), so roots stay put and tips swing. No wind
 * (an unsheared matrix) means no motion.
 *
 * Material block: `extra.y` = wind amount, `extra.z` = wind height, `extra.w` = seconds of
 * game time (layout.ts packMaterial, repacked every frame).
 */

export const WGSL_FOLIAGE_SWAY = `
fn foliageSway(model: mat4x4<f32>, local: vec3<f32>, world: vec3<f32>) -> vec3<f32> {
  let amount = material.extra.y;
  if (amount <= 0.0) { return vec3<f32>(0.0); }
  let up = model[1].xyz;
  let lean = up.xz / max(up.y, 1e-4);
  let s = length(lean);
  if (s < 1e-4) { return vec3<f32>(0.0); }
  let dir = lean / s;
  let height = max(material.extra.z, 1e-4);
  let w = clamp(local.y / height, 0.0, 1.0);
  let t = material.extra.w;
  let phase = dot(world.xz, dir) * 0.35 + sin(local.x * 4.1 + local.z * 3.7) * 1.5;
  let gust = 0.6 * sin(t * 1.9 - phase) + 0.25 * sin(t * 4.3 - phase * 1.7);
  let flutter = 0.15 * sin(t * 6.1 + phase * 2.3);
  let reach = (0.25 + s * 2.0) * amount * w * w * up.y * height;
  return vec3<f32>(dir.x * gust - dir.y * flutter, -abs(gust) * 0.15, dir.y * gust + dir.x * flutter) * reach;
}
`;

export const GLSL_FOLIAGE_SWAY = `
vec3 foliageSway(mat4 model, vec3 localPos, vec3 worldPos) {
  float amount = extra.y;
  if (amount <= 0.0) return vec3(0.0);
  vec3 up = model[1].xyz;
  vec2 lean = up.xz / max(up.y, 1e-4);
  float s = length(lean);
  if (s < 1e-4) return vec3(0.0);
  vec2 dir = lean / s;
  float height = max(extra.z, 1e-4);
  float w = clamp(localPos.y / height, 0.0, 1.0);
  float t = extra.w;
  float phase = dot(worldPos.xz, dir) * 0.35 + sin(localPos.x * 4.1 + localPos.z * 3.7) * 1.5;
  float gust = 0.6 * sin(t * 1.9 - phase) + 0.25 * sin(t * 4.3 - phase * 1.7);
  float flutter = 0.15 * sin(t * 6.1 + phase * 2.3);
  float reach = (0.25 + s * 2.0) * amount * w * w * up.y * height;
  return vec3(dir.x * gust - dir.y * flutter, -abs(gust) * 0.15, dir.y * gust + dir.x * flutter) * reach;
}
`;
