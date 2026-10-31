/**
 * GPU data layouts shared by the WebGPU and WebGL2 backends: uniform blocks, instance
 * records, vertex attribute slots, texture formats of the data textures, and packing.
 * Uniform blocks are declared once here as field lists, and both shading languages'
 * declarations are generated from them (`wgslStruct`, `glslBlock`), so the two backends
 * cannot disagree about a byte. Every field is a vec4 or mat4 (or an array of them), which
 * lays out identically under WGSL's uniform rules and GLSL's std140.
 */

import { hasEffects } from '../../../core/index.js';
import type { Light3d, Material3d, MaterialEffects3d, Rgb } from '../../../core/index.js';

export interface UniformField {
  readonly name: string;
  readonly kind: 'vec4' | 'mat4';
  /** An array of this many (absent: one). */
  readonly count?: number;
}

/** Byte stride of every uniform slot: WebGPU's dynamic-offset alignment (and WebGL2's common one). */
export const UNIFORM_ALIGN = 256;

/** Sun cascades the frame block holds. */
export const MAX_CASCADES = 4;
/** Hazes the frame block holds (core MAX_HAZES). */
export const MAX_HAZES_DRAWN = 4;
/** Local shadow atlas tiles the shadow block holds. */
export const MAX_SHADOW_TILES = 16;

const vec4 = (name: string): UniformField => ({ name, kind: 'vec4' });
const mat4 = (name: string, count?: number): UniformField => (count === undefined ? { name, kind: 'mat4' } : { name, kind: 'mat4', count });

/** Per view. */
export const FRAME_FIELDS: readonly UniformField[] = [
  mat4('viewProjection'),
  mat4('inverseViewProjection'),
  /** World → light clip space per sun cascade. */
  mat4('cascades', MAX_CASCADES),
  /** xyz; w: near. */
  vec4('cameraPosition'),
  /** xyz: unit forward; w: far. */
  vec4('cameraForward'),
  vec4('cameraRight'),
  vec4('cameraUp'),
  /** The view's pixels in the target: x, y (from the top-left), width, height. */
  vec4('viewport'),
  /** Target width, height, 1 / width, 1 / height. */
  vec4('targetSize'),
  /** xyz: direction sunlight travels; w: 1 when there is a sun. */
  vec4('sunDirection'),
  /** rgb: linear color × intensity; w: cascade count (0: no sun shadows). */
  vec4('sunColor'),
  /** rgb: linear ambient; w: specular IBL scale (ambient luminance / sky luminance). */
  vec4('ambient'),
  /** rgb: linear; w: 0 none, 1 exponential, 2 linear. */
  vec4('fogColor'),
  /** density, near, far, volumetric. */
  vec4('fogParams'),
  /** Fog height falloff (1/m, 0: uniform), height where the density is fogParams.x, the fog at the far plane (0..1, the sky's horizon), unused. */
  vec4('fogHeight'),
  /** Skybox panorama: turn (fraction of a circle), light multiplier, on (0/1), unused. */
  vec4('skybox'),
  /** rgb; w: 1 when the sky is drawn (0: a flat clear color, no sun disk). */
  vec4('skyZenith'),
  vec4('skyHorizon'),
  /** Normalized irradiance SH (luminance), coefficients 0–3, 4–7, and 8 then env max mip, unused, unused. */
  vec4('sh0'),
  vec4('sh1'),
  vec4('sh2'),
  /** View depth where each cascade ends. */
  vec4('cascadeSplits'),
  /** World meters per texel of each cascade. */
  vec4('cascadeTexel'),
  /** Sun atlas tiles per row, 1 / sun atlas size, local atlas tiles per row, 1 / local atlas size (plan.ts packFrame). */
  vec4('shadowParams'),
  /** Cluster columns, rows, slices, and this view's first cluster. */
  vec4('clusterParams'),
  /** Slice scale, slice bias (slice = log(depth) · scale + bias), directional light count, light count. */
  vec4('clusterDepth'),
  /** Toon bands, wireframe (0/1), outline max width (px), shadow taps (quality.shadowTaps). */
  vec4('style'),
  /** Wireframe: rgb line color, w: 1 overrides each surface's color. */
  vec4('wireColor'),
  /** Exposure, bloom strength, bloom threshold, vignette. */
  vec4('postA'),
  /** Chromatic aberration, pixelate, posterize, edge thickness. */
  vec4('postB'),
  /** Saturation, contrast, ambient occlusion strength, god ray strength. */
  vec4('postC'),
  /** rgb grade tint. */
  vec4('gradeTint'),
  /** rgb: white balance on scene light (linear multipliers, post temperature); w: film grain 0..1. */
  vec4('gradeBalance'),
  /** x: a per-frame noise seed (grain), y: dither amplitude in display levels, unused × 2. */
  vec4('gradeNoise'),
  /** rgb edge (ink) color. */
  vec4('edgeColor'),
  /** The sun's position on screen (view uv, y down), its strength toward the camera (0 behind), unused. */
  vec4('sunScreen'),
  /** Colour-vision correction rows (linear RGB); colorVision0.w: 1 when on. */
  vec4('colorVision0'),
  vec4('colorVision1'),
  vec4('colorVision2'),
  /** The far fade (sky_plan's viewFadeOf): surfaces fade into the sky beyond the far plane from x to full at y meters (y 0: none); z 1: the outdoor passes fade instead. */
  vec4('viewFade'),
  /** rgb: linear color a skybox panorama's view fades to (the fog's, else the sky's horizon). */
  vec4('viewFadeColor'),
  /** Present: upscale sharpening strength, canvas width, canvas height; w: the image's alpha where nothing was drawn (captures). */
  vec4('present'),
  /** Fog of war (View3d.fogOfWar): the grid's corner x, z and 1 / its width, 1 / its depth in meters (z 0: none). */
  vec4('fogRect'),
  /** Fog of war colors: explored and unexplored, rgb linear, a coverage. */
  vec4('fogExplored'),
  vec4('fogUnexplored'),
  /** Heat haze (Frame3d.hazes, plan.ts packHazes): count, seconds of game time, unused × 2. */
  vec4('haze'),
  /** Per haze: world xyz, w radius (m). */
  { name: 'hazeAt', kind: 'vec4', count: MAX_HAZES_DRAWN },
  /** Per haze: strength 0..1, ring width (fraction of the radius; 0: a steady shimmer), unused × 2. */
  { name: 'hazeShape', kind: 'vec4', count: MAX_HAZES_DRAWN },
];

export const MATERIAL_FIELDS: readonly UniformField[] = [
  /** rgb linear, a alpha. */
  vec4('baseColor'),
  /** rgb linear, w alpha cutoff. */
  vec4('emissive'),
  /** metallic, roughness, alpha mode (0 opaque, 1 mask, 2 blend), unlit (0/1). */
  vec4('surface'),
  /** normal scale, occlusion strength, has normal map (0/1), has occlusion map (0/1). */
  vec4('maps'),
  /** Layers: clearcoat, clearcoat roughness, transmission, subsurface. */
  vec4('coat'),
  /** Layers: rgb linear subsurface color, w anisotropy (-1..1). */
  vec4('scatter'),
  /** Layers: anisotropy rotation (radians, in uv space); uv repeats along u and v (Material3d.uvScale); unused. */
  vec4('grain'),
  /** 1 when the base texture is sampled at the fragment's view position (a mirror); wind amount, height and seconds of game time (Material3d.wind, foliage_wind_shaders.ts). */
  vec4('extra'),
  // ── Surface effects (Material3d.effects; material_fx_shaders.ts) ──
  /** rgb: linear rim color × strength; w: rim power (0: no rim). */
  vec4('fxRim'),
  /** rgb: linear flash color; w: flash amount 0..1. */
  vec4('fxFlash'),
  /** Dissolve amount 0..1, edge width, noise cells per meter, 1 when any effect is on. */
  vec4('fxDissolve'),
  /** rgb: linear dissolve edge color × glow; w: hologram flicker 0..1. */
  vec4('fxEdge'),
  /** rgb: linear hologram color; w: hologram amount 0..1. */
  vec4('fxHolo'),
  /** Scroll u, v (repeats per second), triplanar meters per repeat (0: off), seconds of game time. */
  vec4('fxUv'),
  /** Hologram scanlines per meter, unused × 3. */
  vec4('fxLines'),
];

/** The terrain pass's block (terrain_shaders.ts), one slot per tile palette and level. */
export const TERRAIN_FIELDS: readonly UniformField[] = [
  /**
   * Per palette slot: rgb linear flat color × tint (untextured) or average tone × tint
   * (recolored); w: mode (0 untextured, 1 textured, 2 recolored) + 4 when it has a normal
   * map + 8 × its material index (`packLayerMode`).
   */
  { name: 'layerColor', kind: 'vec4', count: 4 },
  /** Per slot: rgb tint, w meters per texture repeat. */
  { name: 'layerTint', kind: 'vec4', count: 4 },
  /** Per slot: roughness, detail meters per repeat, detail strength (0: no detail), layer in the terrain arrays. */
  { name: 'layerSurface', kind: 'vec4', count: 4 },
  /** Slot i's relief (0..2: normal-map strength, or bump from its texture's luminance or pattern) in component i. */
  vec4('layerRelief'),
  /** The terrain's splat map (terrain_arrays.ts): width and depth in meters, rows per plane, planes (0: none, use the vertex weights). */
  vec4('terrainSplat'),
  /** Slot i's pattern (index in TERRAIN_PATTERNS) + variation (0..1) × 0.5 in component i. */
  vec4('layerPattern'),
  /** Palette size, morph start, morph end, water level (NO_WATER when none). */
  vec4('terrainParams'),
];

/** An outline draw (in a material slot): rgb color, w: whole pixel width + fill (0..0.99). */
export const OUTLINE_FIELDS: readonly UniformField[] = [vec4('outline')];

/** One shadow tile (sun cascade or local face) as the shadow pass renders it. */
export const CASTER_FIELDS: readonly UniformField[] = [mat4('lightViewProjection')];

/** Shared by every view: the local shadow tiles' matrices. */
export const SHADOW_FIELDS: readonly UniformField[] = [mat4('tiles', MAX_SHADOW_TILES)];

const floatsOfField = (f: UniformField): number => (f.kind === 'mat4' ? 16 : 4) * (f.count ?? 1);

export function floatsOf(fields: readonly UniformField[]): number {
  return fields.reduce((n, f) => n + floatsOfField(f), 0);
}

/** Float offset of a field inside its block. */
export function offsetOf(fields: readonly UniformField[], name: string): number {
  let at = 0;
  for (const f of fields) {
    if (f.name === name) return at;
    at += floatsOfField(f);
  }
  throw new Error(`no uniform field ${name}`);
}

/** Floats per slot (the block's size rounded up to UNIFORM_ALIGN bytes). */
export function slotFloats(fields: readonly UniformField[]): number {
  return Math.ceil((floatsOf(fields) * 4) / UNIFORM_ALIGN) * (UNIFORM_ALIGN / 4);
}

export const FRAME_SLOT = slotFloats(FRAME_FIELDS);
export const MATERIAL_SLOT = slotFloats(MATERIAL_FIELDS);
/** Float offset of the surface-effect fields in a material slot. */
const FX_OFFSET = offsetOf(MATERIAL_FIELDS, 'fxRim');
export const CASTER_SLOT = slotFloats(CASTER_FIELDS);

export function wgslStruct(name: string, fields: readonly UniformField[]): string {
  const type = (f: UniformField): string => {
    const one = f.kind === 'mat4' ? 'mat4x4<f32>' : 'vec4<f32>';
    return f.count === undefined ? one : `array<${one}, ${f.count}>`;
  };
  return `struct ${name} {\n${fields.map((f) => `  ${f.name}: ${type(f)},`).join('\n')}\n};\n`;
}

export function glslBlock(name: string, fields: readonly UniformField[]): string {
  const decl = (f: UniformField): string => `${f.kind} ${f.name}${f.count === undefined ? '' : `[${f.count}]`};`;
  return `layout(std140) uniform ${name} {\n${fields.map((f) => `  ${decl(f)}`).join('\n')}\n};\n`;
}

// ── Instance records and vertex slots ─────────────────────────────────────────

/** Floats per mesh instance: model matrix (16), normal matrix columns (3 × vec4; column 0's w = palette offset in joints, column 1's w = LOD fade), tint (4). */
export const MESH_INSTANCE_FLOATS = 32;
/** Floats per billboard: [center, angle], [right, ox], [up, oy], [w, h, shape, own axes], [rgba]. */
export const BILLBOARD_INSTANCE_FLOATS = 20;
/** Floats per line vertex: [start, t], [end, side], [width, 0, 0, 0], [rgba]. */
export const LINE_VERTEX_FLOATS = 16;

/** Vertex attribute locations, the same in WGSL `@location` and GLSL `layout(location)`. */
export const LOCATION = {
  position: 0, normal: 1, uv: 2, color: 3, joints: 4, weights: 5,
  model0: 6, model1: 7, model2: 8, model3: 9, normal0: 10, normal1: 11, normal2: 12, tint: 13,
} as const;

/** Joints per row of the WebGL2 palette texture (4 RGBA32F texels per joint). */
export const PALETTE_ROW_JOINTS = 256;

// ── Data textures (both backends) ─────────────────────────────────────────────

/** Texels per row of every data texture (lights, clusters, cluster items). */
export const DATA_ROW = 1024;
/** RGBA32F texels per light: [position, range], [color, kind], [direction, cos outer], [shadow tile, cos inner, 0, 0]. */
export const LIGHT_TEXELS = 4;
/** Lights per row of the light texture. */
export const LIGHTS_PER_ROW = DATA_ROW / LIGHT_TEXELS;

// ── Packing ──────────────────────────────────────────────────────────────────

export function srgbToLinear(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearRgb(c: Rgb, scale = 1): [number, number, number] {
  return [srgbToLinear(c[0]) * scale, srgbToLinear(c[1]) * scale, srgbToLinear(c[2]) * scale];
}

/** Relative luminance of a linear color. */
export function luminance(c: readonly number[]): number {
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function packMaterial(m: Material3d, out: Float32Array, slot: number, time = 0): void {
  const o = slot * MATERIAL_SLOT;
  out.set(linearRgb([m.baseColor[0], m.baseColor[1], m.baseColor[2]]), o);
  out[o + 3] = m.baseColor[3];
  out.set(linearRgb(m.emissive, m.emissiveStrength ?? 1), o + 4);
  out[o + 7] = m.alphaCutoff;
  out[o + 8] = m.metallic;
  out[o + 9] = m.roughness;
  out[o + 10] = m.alphaMode === 'opaque' ? 0 : m.alphaMode === 'mask' ? 1 : 2;
  out[o + 11] = m.unlit ? 1 : 0;
  out[o + 12] = m.normalScale ?? 1;
  out[o + 13] = m.occlusionStrength ?? 1;
  out[o + 14] = (m.normalTexture ?? null) === null ? 0 : 1;
  out[o + 15] = (m.occlusionTexture ?? null) === null ? 0 : 1;
  const layers = m.layers;
  if (layers !== undefined) {
    out.set([layers.clearcoat, layers.clearcoatRoughness, layers.transmission, layers.subsurface], o + 16);
    out.set(linearRgb(layers.subsurfaceColor), o + 20);
    out[o + 23] = layers.anisotropy;
    out[o + 24] = (layers.anisotropyRotation * Math.PI) / 180;
  }
  out[o + 25] = m.uvScale?.[0] ?? 1;
  out[o + 26] = m.uvScale?.[1] ?? 1;
  out[o + 28] = m.projected === true ? 1 : 0;
  out[o + 29] = m.wind?.amount ?? 0;
  out[o + 30] = m.wind?.height ?? 0;
  out[o + 31] = m.wind === undefined ? 0 : time % 3600;
  packEffects(m.effects, out, o + FX_OFFSET, time);
}

/** A material's surface effects into its slot's fx fields (at `o`, the fxRim offset); all zero when it has none. */
export function packEffects(e: MaterialEffects3d | undefined, out: Float32Array, o: number, time: number): void {
  if (!hasEffects(e)) {
    out.fill(0, o, o + 28);
    return;
  }
  out.set(linearRgb(e.rimColor, e.rim), o);
  out[o + 3] = e.rim > 0 ? Math.max(0.1, e.rimPower) : 0;
  out.set(linearRgb(e.flashColor), o + 4);
  out[o + 7] = Math.min(1, Math.max(0, e.flash));
  out[o + 8] = Math.min(1, Math.max(0, e.dissolve));
  out[o + 9] = Math.max(0, e.dissolveEdge);
  out[o + 10] = Math.max(0.01, e.dissolveScale);
  out[o + 11] = 1;
  out.set(linearRgb(e.dissolveColor, e.dissolveGlow), o + 12);
  out[o + 15] = Math.min(1, Math.max(0, e.hologramFlicker));
  out.set(linearRgb(e.hologramColor), o + 16);
  out[o + 19] = Math.min(1, Math.max(0, e.hologram));
  // This frame's scroll phase (whole repeats are invisible, so f32 keeps its precision over long sessions).
  out[o + 20] = fract(e.scroll[0] * time);
  out[o + 21] = fract(e.scroll[1] * time);
  out[o + 22] = Math.max(0, e.triplanar);
  out[o + 23] = time % 3600;
  out[o + 24] = Math.max(0, e.hologramLines);
  out[o + 25] = 0; out[o + 26] = 0; out[o + 27] = 0;
}

const fract = (x: number): number => x - Math.floor(x);

/**
 * The id a material's texture bindings are cached under: an effect material (render3d's
 * surface_fx.ts names it `<base id>|fx:<values>`) binds exactly its base material's textures,
 * so its animated values never add bindings.
 */
export function bindingId(m: Material3d): string {
  if (m.effects === undefined) return m.id;
  const at = m.id.lastIndexOf('|fx:');
  return at < 0 ? m.id : m.id.slice(0, at);
}

/** A material light passes through (glass, visors): drawn after the opaque scene, blended premultiplied. */
export function transmissive(m: Material3d): boolean {
  return (m.layers?.transmission ?? 0) > 0;
}

/**
 * The inverse-transpose of a model matrix's upper 3×3 (normals stay perpendicular under
 * non-uniform scale), as three columns written at `out[o]`, `out[o + 4]`, `out[o + 8]`.
 */
export function normalMatrix(m: ArrayLike<number>, mo: number, out: Float32Array, o: number): void {
  const a = m[mo]!; const b = m[mo + 4]!; const c = m[mo + 8]!;
  const d = m[mo + 1]!; const e = m[mo + 5]!; const f = m[mo + 9]!;
  const g = m[mo + 2]!; const h = m[mo + 6]!; const i = m[mo + 10]!;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = Math.abs(det) < 1e-20 ? 0 : 1 / det;
  // inverse-transpose = cofactor matrix / det, written column by column (column j: C0j, C1j, C2j).
  out[o] = A * s; out[o + 1] = -(b * i - c * h) * s; out[o + 2] = (b * f - c * e) * s;
  out[o + 4] = B * s; out[o + 5] = (a * i - c * g) * s; out[o + 6] = -(a * f - c * d) * s;
  out[o + 8] = C * s; out[o + 9] = -(a * h - b * g) * s; out[o + 10] = (a * e - b * d) * s;
}

/** Where an instance record keeps its level-of-detail fade (normal column 1's w; `MeshBatch.fades`). */
export const FADE_FLOAT = 23;

/** One mesh instance record from a port instance (model matrix + tint), a palette offset and a level-of-detail fade. */
export function packInstance(
  model: ArrayLike<number>, mo: number, tint: ArrayLike<number>, to: number, paletteOffset: number, out: Float32Array, o: number, fade = 1,
): void {
  for (let k = 0; k < 16; k++) out[o + k] = model[mo + k]!;
  normalMatrix(model, mo, out, o + 16);
  out[o + 19] = paletteOffset;
  out[o + FADE_FLOAT] = fade;
  out[o + 27] = 0;
  out[o + 28] = srgbToLinear(tint[to]!);
  out[o + 29] = srgbToLinear(tint[to + 1]!);
  out[o + 30] = srgbToLinear(tint[to + 2]!);
  out[o + 31] = tint[to + 3]!;
}

/** Light kind as the shaders number it. */
export function lightKind(kind: Light3d['kind']): number {
  return kind === 'directional' ? 0 : kind === 'point' ? 1 : 2;
}

/** Cosine of a spot light's inner (full-strength) half angle, from its outer cosine. */
export function innerCone(outerCos: number): number {
  return outerCos + (1 - outerCos) * 0.2;
}

/**
 * Lights as the light texture holds them (`LIGHT_TEXELS` RGBA32F texels each), rows of
 * `LIGHTS_PER_ROW`. `tiles` gives each shadowed light's first shadow tile (absent: unshadowed, -1).
 */
export function packLights(lights: readonly Light3d[], tiles: ReadonlyMap<Light3d, number>): Float32Array {
  const rows = Math.max(1, Math.ceil(lights.length / LIGHTS_PER_ROW));
  const out = new Float32Array(rows * DATA_ROW * 4);
  lights.forEach((light, i) => {
    const o = i * LIGHT_TEXELS * 4;
    out.set(light.position, o);
    out[o + 3] = light.range;
    out.set(linearRgb(light.color, light.intensity), o + 4);
    out[o + 7] = lightKind(light.kind);
    out.set(light.direction, o + 8);
    const outer = Math.cos(((light.angle / 2) * Math.PI) / 180);
    out[o + 11] = outer;
    out[o + 12] = tiles.get(light) ?? -1;
    out[o + 13] = light.innerAngle === undefined ? innerCone(outer)
      // A core as wide as the cone would divide by zero in the smoothstep: keep a sliver of edge.
      : Math.max(outer + 1e-4, Math.cos(((Math.min(light.innerAngle, light.angle) / 2) * Math.PI) / 180));
  });
  return out;
}

/**
 * Light multiplier before the tone curve: 1, as the old renderer's (its `preExposure`), so scene
 * light means what templates were tuned against. `post.exposure` is applied after the curve
 * (post_shaders.ts).
 */
export const EXPOSURE_CALIBRATION = 1;
