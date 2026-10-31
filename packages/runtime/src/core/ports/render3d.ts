/**
 * The 3D render port: a retained scene description the render3d plugin builds once per
 * frame from the world, and the surface that draws it — WebGPU or WebGL2 in the browser
 * (`platform/browser/render3d/`), a recorder in headless tests (`platform/headless/render3d.ts`).
 *
 * Retained means the heavy data is shared, immutable and identity-stable across frames:
 * a `Geometry3d`, `Material3d` or `Texture3d` object is built once (a primitive, a glTF
 * primitive) and every frame that draws it hands over the same object, so a surface
 * uploads it once and keys its GPU copy on the object (or its `id`). Per-frame data —
 * instance matrices, bone palettes, lights, particles — is fresh each frame.
 *
 * Conventions:
 *   - World space is y-up, +x right, +z forward (left-handed), meters. glTF assets are
 *     converted on load (mirrored across x, winding reversed) so they face +z.
 *   - Matrices are column-major 4×4, 16 numbers (`m[col * 4 + row]`).
 *   - Projections map view depth to clip z in 0..1 (WebGPU's convention); a WebGL2
 *     surface remaps it to -1..1 in its vertex shaders.
 *   - Front faces: a triangle's `cross(b - a, c - a)` points out of the surface.
 *   - Colors are straight-alpha sRGB as authored (`Color`), each channel 0..1; surfaces
 *     convert to linear for shading.
 */

import type { Diagnostic } from '../diagnostics.js';
import type { Nature3d } from './nature3d.js';
import type { Rgba, TextSpan } from './render.js';

export type Mat4 = readonly number[] | Float32Array;
export type Rgb = readonly [r: number, g: number, b: number];
export type Xyz = readonly [x: number, y: number, z: number];

// ── Retained resources ─────────────────────────────────────────────────────────

/** Triangle-list geometry. Every attribute array has one entry per vertex. */
export interface Geometry3d {
  /** Stable key: `shape:box`, `assets/models/knight.glb#mesh0.1`, `terrain:3`. */
  readonly id: string;
  /** x, y, z per vertex. */
  readonly positions: Float32Array;
  /** Unit normals, x, y, z per vertex. */
  readonly normals: Float32Array;
  /** u, v per vertex (v down, glTF's convention). */
  readonly uvs: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  /** Skinned geometry: four joint indices per vertex (into the skin's joints). */
  readonly joints: Uint16Array | null;
  /** Skinned geometry: four weights per vertex, summing to 1. */
  readonly weights: Float32Array | null;
  /** Vertex colors, sRGB RGBA per vertex, multiplied into the material; null = white. (Terrain: palette weights, see `TerrainTile3d`.) */
  readonly colors: Float32Array | null;
  /** Local-space bounding box. */
  readonly min: Xyz;
  readonly max: Xyz;
  /**
   * Dynamic geometry (morphed meshes): `positions` and `normals` are rewritten in place and
   * this number grows each time; a surface re-uploads them when it differs from what it has.
   * Absent: the geometry never changes.
   */
  readonly version?: number;
}

export type TextureSource =
  /** A project file (`assets/images/bricks.png`), fetched and decoded by the surface. */
  | {
    readonly kind: 'file';
    readonly path: string;
    /**
     * Precompressed copies of the same image (`<name>.bc.ktx2`, `<name>.etc2.ktx2`, written
     * by `parallax build`), best first: a surface uploads the first whose block format the
     * GPU samples natively, else decodes `path`. Absent: none.
     */
    readonly variants?: readonly string[];
  }
  /** Encoded image bytes (a .glb's embedded PNG/JPEG). */
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly mimeType: string }
  /**
   * What an offscreen view (`Frame3d.offscreen`) drew this frame or earlier: a camera feed
   * or a mirror. Sampled like any image (display colors); black until first drawn.
   */
  | { readonly kind: 'target'; readonly target: string };

export type Wrap = 'repeat' | 'clamp' | 'mirror';

export interface Texture3d {
  /** Stable key (the file path, or `<model>#image<i>`). */
  readonly id: string;
  readonly source: TextureSource;
  /** Base color and emissive maps hold sRGB; metallic-roughness maps hold linear data. */
  readonly colorSpace: 'srgb' | 'linear';
  readonly wrapU: Wrap;
  readonly wrapV: Wrap;
  readonly filter: 'linear' | 'nearest';
}

export type AlphaMode = 'opaque' | 'mask' | 'blend';

/** Metallic-roughness material: glTF 2.0's core model (base color, metal/rough, normal, occlusion, emissive). */
export interface Material3d {
  /** Stable key. */
  readonly id: string;
  readonly baseColor: Rgba;
  readonly baseColorTexture: Texture3d | null;
  readonly metallic: number;
  readonly roughness: number;
  /** glTF packing: roughness in G, metallic in B; multiplies the factors. */
  readonly metallicRoughnessTexture: Texture3d | null;
  readonly emissive: Rgb;
  readonly emissiveTexture: Texture3d | null;
  /**
   * Multiplies `emissive` in linear light, with no upper bound (glTF's
   * KHR_materials_emissive_strength, `Shape.emissive_strength`): above 1 the surface is
   * brighter than white and blooms. Absent: 1.
   */
  readonly emissiveStrength?: number;
  /**
   * Tangent-space normal map (glTF convention: +x along increasing u, +y toward decreasing
   * v, linear data). Absent or null: the geometry's normals. Tangents are derived per pixel
   * from the surface's screen-space derivatives, so geometry needs no tangent attribute.
   */
  readonly normalTexture?: Texture3d | null;
  /** Scales the normal map's x and y (glTF `normalTexture.scale`); default 1. */
  readonly normalScale?: number;
  /** Ambient occlusion in R (linear data). Absent or null: none. Darkens ambient and reflected light only. */
  readonly occlusionTexture?: Texture3d | null;
  /** 0 ignores the occlusion map, 1 applies it fully (glTF `occlusionTexture.strength`); default 1. */
  readonly occlusionStrength?: number;
  readonly alphaMode: AlphaMode;
  /** `mask`: fragments with alpha below this are discarded. */
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  /** Shading ignores lights (KHR_materials_unlit; text and debug). */
  readonly unlit: boolean;
  /** Layers beyond the core model (model documents, glTF KHR_materials_*). Absent: none. */
  readonly layers?: MaterialLayers3d;
  /**
   * Planar mirrors: the base color texture is sampled where the fragment lands in its view
   * (screen space) instead of at its uv — the mirror's target was drawn from the reflected
   * camera, so that is the reflection. Absent: false.
   */
  readonly projected?: boolean;
  /**
   * Texture repeats along u and v (tiling): every map is sampled at uv × uvScale. Absent:
   * [1, 1]. Shapes set it from `Shape.uv_scale`.
   */
  readonly uvScale?: readonly [u: number, v: number];
  /** Stylized effects drawn over the shading (rim light, hit flash, dissolve, hologram, scrolling, triplanar). Absent: none. */
  readonly effects?: MaterialEffects3d;
  /**
   * Vertex wind (grass blades, leaves): vertices sway with the instance's wind lean, by
   * `amount`, weighted by (local y ÷ `height`)². Absent: none. (Render3d foliage and grass.)
   */
  readonly wind?: { readonly amount: number; readonly height: number };
}

/**
 * Stylized surface effects over a material's shading (the visuals plugin's `surface_fx`
 * component builds them). Each amount is 0 when unused; colors are sRGB like `baseColor`.
 * Animated ones (scroll, hologram flicker) run on `Frame3d.time`.
 */
export interface MaterialEffects3d {
  /** Fresnel rim light added at grazing angles: strength (0..4) and falloff power (higher: a thinner rim). */
  readonly rim: number;
  readonly rimColor: Rgb;
  readonly rimPower: number;
  /** Hit flash: 0..1 of the shaded color replaced by `flashColor` (a damage pop, a selection blink). */
  readonly flash: number;
  readonly flashColor: Rgb;
  /**
   * Dissolve: 0 whole .. 1 gone. Pixels whose world-space noise (`dissolveScale` cells per
   * meter) is below the amount are cut away; a band `dissolveEdge` (0..1 of the noise range)
   * wide at the cut glows `dissolveColor` × `dissolveGlow`.
   */
  readonly dissolve: number;
  readonly dissolveScale: number;
  readonly dissolveEdge: number;
  readonly dissolveColor: Rgb;
  readonly dissolveGlow: number;
  /**
   * Hologram: 0..1 of the surface turned into a see-through projection in `hologramColor` —
   * a glowing fresnel edge, scanlines (`hologramLines` per meter of world height) scrolling
   * up, and `hologramFlicker` (0..1) brightness flicker. Drawn blended; casts no shadow.
   */
  readonly hologram: number;
  readonly hologramColor: Rgb;
  readonly hologramLines: number;
  readonly hologramFlicker: number;
  /** Texture coordinates scroll this many repeats per second along u and v (conveyors, lava, screens). */
  readonly scroll: readonly [u: number, v: number];
  /**
   * Triplanar mapping: the base color texture is projected along the world axes, repeating
   * every `triplanar` meters, and blended by the surface's facing (0: the mesh's own uvs).
   * Rocks, cliffs and generated meshes with stretched or no uvs.
   */
  readonly triplanar: number;
}

/** No surface effects (every amount 0). */
export const NO_EFFECTS: MaterialEffects3d = {
  rim: 0, rimColor: [1, 1, 1], rimPower: 3, flash: 0, flashColor: [1, 1, 1], dissolve: 0, dissolveScale: 4, dissolveEdge: 0.06,
  dissolveColor: [1, 0.55, 0.15], dissolveGlow: 3, hologram: 0, hologramColor: [0.4, 0.85, 1], hologramLines: 40, hologramFlicker: 0.3,
  scroll: [0, 0], triplanar: 0,
};

/** Whether a material's effects change how it is drawn at all. */
export function hasEffects(e: MaterialEffects3d | undefined): e is MaterialEffects3d {
  return e !== undefined && (e.rim > 0 || e.flash > 0 || e.dissolve > 0 || e.hologram > 0 || e.scroll[0] !== 0 || e.scroll[1] !== 0 || e.triplanar > 0);
}

/**
 * Physically based layers on top of a `Material3d`, each 0 when unused. A surface that
 * doesn't shade a layer yet draws the core material underneath (still correct, plainer).
 */
export interface MaterialLayers3d {
  /** A clear lacquer over the base (car paint, helmets): strength 0..1 and its own roughness (KHR_materials_clearcoat). */
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  /** 0..1 of the light passing through the surface (glass, visors: KHR_materials_transmission). */
  readonly transmission: number;
  /** 0..1 of light scattering under the surface (skin, wax), tinted `subsurfaceColor` (sRGB). */
  readonly subsurface: number;
  readonly subsurfaceColor: Rgb;
  /** -1..1 stretch of the highlight (brushed metal), turned `anisotropyRotation` degrees in UV space (KHR_materials_anisotropy). */
  readonly anisotropy: number;
  readonly anisotropyRotation: number;
}

// ── Per-frame description ──────────────────────────────────────────────────────

/** Numbers per mesh instance in `MeshBatch.instances`: model matrix (16), then tint RGBA (4). */
export const MESH_INSTANCE_STRIDE = 20;

/** Many copies of one geometry with one material: one instanced draw. */
export interface MeshBatch {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  readonly count: number;
  /** `MESH_INSTANCE_STRIDE` numbers per instance. Tint multiplies the material's base color. */
  readonly instances: Float32Array;
  /** The entity of each instance (picking, tests); null for scenery the engine adds (water, merged static chunks). */
  readonly entities: readonly (number | null)[];
  readonly castShadows: boolean;
  /** Absent: 'world'. */
  readonly layer?: DrawLayer3d;
  /** Which views draw it. Absent: every view. */
  readonly views?: ViewMask3d;
  /**
   * Per instance, a level-of-detail cross-fade: 1 drawn whole; 0 < f < 1 fading
   * in, keeping the fraction f of its pixels; -1 < f < 0 fading out, keeping exactly the
   * pixels the matching fade-in (1 + f) leaves out, so two levels never overlap or leave a
   * hole. Absent: all 1.
   */
  readonly fades?: Float32Array;
}

/**
 * Where a mesh is drawn:
 *   world      the scene, through the view's camera
 *   viewmodel  first-person arms and items: only in its camera's view (`views.only`), through
 *              that view's `overlay` projection, in front of the world (no wall clips them),
 *              lit like the world, casting no shadows
 */
export type DrawLayer3d = 'world' | 'viewmodel';

/** Which views draw something: only one camera's view, or every view but one camera's. */
export type ViewMask3d = { readonly only: number } | { readonly except: number };

/** Whether a mask lets a camera's view draw. */
export function viewDraws(mask: ViewMask3d | undefined, camera: number): boolean {
  if (mask === undefined) return true;
  return 'only' in mask ? mask.only === camera : mask.except !== camera;
}

/**
 * Clip depth a view's overlay projection maps its near..far to: 0..VIEWMODEL_DEPTH, so the
 * viewmodel layer is in front of everything farther than about its near plane without a
 * second depth buffer (the world is 0..1).
 */
export const VIEWMODEL_DEPTH = 0.02;

/** One skinned mesh: GPU-skinned with its bone palette. */
export interface SkinnedDraw {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  /** Model space → world. */
  readonly model: Mat4;
  readonly tint: Rgba;
  /** 16 numbers per joint: the joint's model-space matrix times its inverse bind matrix. */
  readonly palette: Float32Array;
  readonly jointCount: number;
  readonly entity: number;
  readonly castShadows: boolean;
  /** Absent: 'world'. */
  readonly layer?: DrawLayer3d;
  /** Absent: every view. */
  readonly views?: ViewMask3d;
  /** Level-of-detail cross-fade as `MeshBatch.fades`. Absent: 1. */
  readonly fade?: number;
}

export interface Light3d {
  readonly kind: 'directional' | 'point' | 'spot';
  readonly color: Rgb;
  readonly intensity: number;
  readonly position: Xyz;
  /** Unit direction the light travels (directional, spot). */
  readonly direction: Xyz;
  /** Meters; point and spot light falls to zero here. */
  readonly range: number;
  /** Spot: full cone angle in degrees. */
  readonly angle: number;
  /** Spot: full angle of the fully lit core (≤ angle); absent: the renderer's soft edge. */
  readonly innerAngle?: number;
  /** Asks for a shadow map. Point and spot lights get one within the quality's budget (`Frame3d.localShadows`). */
  readonly shadows: boolean;
  readonly entity: number | null;
}

/** The sun: the directional light that casts the shadow map. */
export interface Sun3d {
  /** Unit direction the light travels. */
  readonly direction: Xyz;
  readonly color: Rgb;
  readonly intensity: number;
  readonly shadows: boolean;
}

export interface Fog3d {
  readonly kind: 'none' | 'exponential' | 'linear';
  readonly color: Rgb;
  /** Exponential: 1 - e^(-density · distance) of the color is fog. */
  readonly density: number;
  /** Linear: meters where fog starts and where it is complete. */
  readonly near: number;
  readonly far: number;
  /**
   * 0..1: how strongly the fog scatters sunlight toward the camera (light shafts through the
   * sun's shadows). 0 is plain distance fog. Drawn when the quality has volumetric fog.
   */
  readonly volumetric: number;
  /**
   * Exponential fog only: 1/meters its density falls off with height above `height` (0 or
   * absent: uniform). Ground mist and fog filling valleys; the sky's haze band follows it.
   */
  readonly heightFalloff?: number;
  /** World y where the density is `density` (default 0). */
  readonly height?: number;
}

export interface Environment3d {
  /** A vertical gradient from straight up to the horizon; below the horizon is the horizon color. */
  readonly sky: { readonly zenith: Rgb; readonly horizon: Rgb };
  readonly fog: Fog3d;
  /**
   * Light reaching every surface from every direction. Surfaces also reflect the sky: the
   * renderer builds an environment map from the sky and scales its reflections so their
   * brightness follows this color.
   */
  readonly ambient: Rgb;
  readonly sun: Sun3d | null;
  /**
   * Meters from the camera the sun's shadow cascades reach (the scene's `sun.shadow_distance`,
   * also when a light entity is the sun); absent/null: the quality level's `shadowDistance`.
   */
  readonly shadowDistance?: number | null;
  /** Post-processing and the image's style (the environment's `post` block, its preset expanded). */
  readonly post: Post3d;
  /** A panorama drawn as the sky instead of the gradient (absent or null: none); it also lights reflections. */
  readonly skybox?: Skybox3d | null;
}

/**
 * An equirectangular (2:1) sky image: column u looks toward compass angle u · 360° (+z at
 * the center column, +x a quarter to its right) turned by `rotation`, row v from straight
 * up (top) to straight down (bottom).
 */
export interface Skybox3d {
  readonly texture: Texture3d;
  /** Radians the panorama is turned about +y (compass direction, clockwise seen from above). */
  readonly rotation: number;
  /** Multiplier on the image's (linear) light. */
  readonly intensity: number;
}

/** A color grade: out = mix(gray, (c - 0.5) · contrast + 0.5, saturation) · tint, on display colors. */
export interface Grade3d {
  readonly tint: Rgb;
  readonly saturation: number;
  readonly contrast: number;
  /** White balance on scene light before the tone curve: -1 cool (blue) .. 1 warm (orange); 0 or absent: neutral. */
  readonly temperature?: number;
}

/** The identity grade. */
export const NO_GRADE: Grade3d = { tint: [1, 1, 1], saturation: 1, contrast: 1 };

/**
 * Everything between the lit scene and the screen, as the scene asks for it. The quality
 * (`Frame3d.quality`) decides which of the costly effects are drawn; the rest always are.
 */
export interface Post3d {
  /** Linear multiplier on scene light before the tone curve (2 = one stop brighter). */
  readonly exposure: number;
  /** Bloom strength (0: none); light above `bloomThreshold` (linear luminance) glows. */
  readonly bloom: number;
  readonly bloomThreshold: number;
  readonly grade: Grade3d;
  /** 0..1: darkening toward the corners. */
  readonly vignette: number;
  /** Red/blue fringe offset at the corners, as a fraction of the image (0: none). */
  readonly chromaticAberration: number;
  /** Size of the image's pixels in screen pixels (1: none). */
  readonly pixelate: number;
  /** Levels per color channel (0: none). */
  readonly posterize: number;
  /** Cel shading: bands of direct light (0: smooth shading). */
  readonly toon: number;
  /** Ink lines where depth or facing changes sharply: thickness in pixels (0: none). */
  readonly edges: number;
  readonly edgeColor: Rgb;
  /** Screen-space ambient occlusion strength (0: none). */
  readonly ambientOcclusion: number;
  /** Screen-space reflections on smooth surfaces. */
  readonly reflections: boolean;
  /** Light shafts streaming from the sun (0: none). */
  readonly godRays: number;
  /** wireframe: every mesh and the terrain drawn as their triangle edges. */
  readonly mode: 'standard' | 'wireframe';
  /** Wireframe line color (null: each surface's own color). */
  readonly wireColor: Rgb | null;
  /** Wireframe background (null: the sky). */
  readonly wireBackground: Rgb | null;
  /** Smooth jagged edges (FXAA). Pixelated images are never smoothed. */
  readonly antialias: boolean;
  /** 0..1 animated film grain (absent: none). */
  readonly grain?: number;
}

/** No post-processing beyond the tone curve and antialiasing. */
export const PLAIN_POST: Post3d = {
  exposure: 1, bloom: 0, bloomThreshold: 1, grade: NO_GRADE, vignette: 0, chromaticAberration: 0, pixelate: 1, posterize: 0,
  toon: 0, edges: 0, edgeColor: [0, 0, 0], ambientOcclusion: 0, reflections: false, godRays: 0, mode: 'standard',
  wireColor: null, wireBackground: null, antialias: true,
};

/**
 * The render quality, resolved from `Settings.quality` by the render3d plugin
 * (`QUALITY_LADDER`). Phones keep `low` fast: one shadow cascade, no local shadows, no
 * screen-space passes.
 */
export interface Quality3d {
  readonly level: 'low' | 'medium' | 'high';
  /** Sun shadow cascades (1..4) and their map size in texels. */
  readonly cascades: number;
  readonly shadowMapSize: number;
  /** Meters of the first view's depth the sun's cascades cover. */
  readonly shadowDistance: number;
  /** Shadow filter taps per lookup: 1 (hardware 2×2) or 9 (3×3 PCF). */
  readonly shadowTaps: 1 | 9;
  /** Point/spot shadow atlas: tiles available (a spot light takes 1, a point light 6) and texels per tile. */
  readonly localShadowTiles: number;
  readonly localShadowSize: number;
  /** Most point, spot and extra directional lights per frame (nearest first). */
  readonly maxLights: number;
  /** Light clusters per view: columns, rows, depth slices. */
  readonly clusters: readonly [x: number, y: number, z: number];
  /** Screen-space ambient occlusion: off, at half resolution, or full. */
  readonly ambientOcclusion: 'off' | 'half' | 'full';
  readonly reflections: boolean;
  readonly volumetricFog: boolean;
  /**
   * Clouds raymarched through the layer's thickness (true), or drawn flat on the sky dome as
   * one 2D noise layer at the layer's height, lit by the sun (false: the cheaper look).
   */
  readonly volumetricClouds: boolean;
  readonly godRays: boolean;
  /** Bloom mip levels (each half the size of the one above). */
  readonly bloomLevels: number;
  /** Texels per side of the sky's environment cube. */
  readonly environmentSize: number;
  /** Multiplies `Lod` distances: levels switch sooner on lower qualities. */
  readonly lodScale: number;
  /**
   * Meters: nothing farther is drawn (a camera's far plane is clamped to it; Infinity: the
   * camera's own far plane). Whatever the far plane is, every surface (terrain, meshes, water)
   * fades into the sky seen beyond it over its last stretch, so the edge never shows.
   */
  readonly viewDistance: number;
  /** Most pixels the scene is drawn with; a larger surface renders smaller and is upscaled with sharpening. */
  readonly maxRenderPixels: number;
  /** Dynamic resolution: the smallest render scale (per axis) the frame-time governor may drop to (1: off). */
  readonly minRenderScale: number;
  /** Frames per second at most (0: every display refresh). Whole refreshes are skipped, so frames stay evenly spaced. */
  readonly frameCap: number;
  /** Bytes of textures kept on the GPU; the least recently drawn are evicted past it. */
  readonly textureBudget: number;
  /** Larger images are downscaled to this many texels per side on upload. */
  readonly maxTextureSize: number;
  /** Hi-Z occlusion culling against the last frame's depth (an adaptive governor turns it off where it doesn't pay). */
  readonly occlusion: boolean;
  /** Decals drawn per view at most (nearest first). */
  readonly maxDecals: number;
  /** Offscreen views (camera feeds, mirrors) redrawn per frame at most; the rest keep their last image. */
  readonly offscreenPerFrame: number;
  /**
   * Detail culling: a mesh instance whose bounding sphere projects to a radius under this
   * many pixels of its view is not drawn, and a shadow caster under this many texels of its
   * shadow map casts nothing (0: off). The viewmodel layer is never detail-culled.
   */
  readonly detailPixels: number;
}

/** A terrain surface material: up to `MAX_TERRAIN_MATERIALS` per terrain, each tile blending the four its `palette` names. */
export interface TerrainMaterial3d {
  /** Tiled every `tile` meters; null draws `color`. */
  readonly texture: Texture3d | null;
  /** The texture's tangent-space normal map (linear data, +y up the image), or null. */
  readonly normal: Texture3d | null;
  /** True: the texture is shifted so its average tone is `color` (× tint); false: drawn as is (× tint). */
  readonly recolor: boolean;
  readonly tile: number;
  /** sRGB flat color (untextured layers), multiplied by `tint` like the texture is. */
  readonly color: Rgb;
  /** Linear multiplier on the layer's color. */
  readonly tint: Rgb;
  readonly roughness: number;
  /** A finer texture multiplied in, fading out with distance (null: none). */
  readonly detail: Texture3d | null;
  readonly detailTile: number;
  /** 0..1: how strongly the detail darkens and lightens. */
  readonly detailStrength: number;
  /** The procedural surface drawn when `texture` is null (mottling, patches, relief). */
  readonly pattern: TerrainPattern3d;
  /** 0..1: how much the surface varies (procedural mottling and large-scale tone); 0.5 is the default look. */
  readonly variation: number;
  /** 0..2: bump strength of the surface relief (from the texture's luminance, or the pattern). */
  readonly relief: number;
}

/** Procedural terrain surfaces, in the terrain shader's index order. */
export const TERRAIN_PATTERNS = ['soil', 'grass', 'rock', 'sand', 'paved', 'snow'] as const;
export type TerrainPattern3d = (typeof TERRAIN_PATTERNS)[number];

/** Most materials a CDLOD terrain declares. */
export const MAX_TERRAIN_MATERIALS = 8;

/**
 * One CDLOD terrain tile: a grid patch at some level of detail. `geometry` is world-space;
 * its `colors` are the weights of the tile's `palette` (r = palette[0] … a = palette[3],
 * summing to 1), and its `uvs` hold (geomorph target height, 0): the height the vertex has
 * on the next coarser level. A surface blends each vertex's height toward that target by
 * k = clamp((distance to the camera − morphStart) / (morphEnd − morphStart), 0, 1), which
 * is what joins rings of different levels without cracks. Texture coordinates are world
 * x and z in meters.
 */
export interface TerrainTile3d {
  readonly geometry: Geometry3d;
  /** Indices into `Terrain3d.materials`, at most 4. */
  readonly palette: readonly number[];
  readonly morphStart: number;
  readonly morphEnd: number;
  /** Level of detail (0 finest), for stats and debugging. */
  readonly level: number;
}

/** The scene's terrain: the CDLOD tiles chosen around this frame's cameras, and its materials. */
export interface Terrain3d {
  readonly tiles: readonly TerrainTile3d[];
  readonly materials: readonly TerrainMaterial3d[];
  /** The terrain's water level (a damp band is drawn just above it), or null/absent: no water. */
  readonly waterLevel?: number | null;
  /** The material weights on a fine grid (blended per pixel instead of per vertex), or null/absent: not baked yet. */
  readonly splat?: TerrainSplat3d | null;
}

/** A terrain's splat map: material weights on a grid over its whole footprint (centered on the origin). */
export interface TerrainSplat3d {
  /** Changes when the data does (field and revision). */
  readonly key: string;
  readonly width: number;
  readonly depth: number;
  readonly columns: number;
  readonly rows: number;
  /** Planes of three materials (RGB, alpha 255), stacked: plane p's rows follow plane p − 1's. */
  readonly planes: number;
  /** RGBA8, columns × rows × planes. */
  readonly data: Uint8Array;
}

/**
 * Heat haze: the image behind a region shimmers as if seen through hot air (fires, exhausts),
 * or an expanding shockwave ring bends it (explosions). Applied to the lit scene before the
 * tone curve, at most `MAX_HAZES` per frame (the strongest).
 */
export interface Haze3d {
  /** World-space center. */
  readonly position: Xyz;
  /** Meters: the shimmer's radius, or the ring's current radius. */
  readonly radius: number;
  /** 0..1: how far the image bends (1 ≈ 3% of the view height at the strongest). */
  readonly strength: number;
  /** 0: a steady shimmer filling the radius; above 0: a shockwave ring this fraction of the radius wide. */
  readonly ring: number;
}

/** Hazes drawn per frame at most. */
export const MAX_HAZES = 4;

/** A camera's view, resolved for the surface's pixels. */
export interface View3d {
  readonly camera: number;
  /** Pixels, origin at the top-left of the surface. */
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly position: Xyz;
  /** Unit axes of the camera in world space. */
  readonly right: Xyz;
  readonly up: Xyz;
  readonly forward: Xyz;
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly viewProjection: Mat4;
  readonly inverseViewProjection: Mat4;
  readonly near: number;
  readonly far: number;
  /** Clear color; null draws the environment's sky. */
  readonly clear: Rgba | null;
  /** Colour-vision correction applied after tone mapping (`Settings.colorblind`). */
  readonly colorVision: ColorVision;
  /** The first-person overlay this view draws its `viewmodel` layer with. Absent or null: none. */
  readonly overlay?: ViewOverlay3d | null;
  /** Fog of war over the ground in this view. Absent or null: none. */
  readonly fogOfWar?: FogOfWar3d | null;
  /** A reflected view (a mirror's): its front faces wind the other way. Absent: false. */
  readonly mirrored?: boolean;
  /** Depth of field (the camera's DepthOfField). Absent or null: everything sharp. */
  readonly depthOfField?: DepthOfField3d | null;
}

/**
 * Depth of field: blur grows with a pixel's distance (along the view) from `focusDistance`,
 * reaching `maxBlur` `focusRange` meters away. Meters; `maxBlur` is a radius in pixels at
 * 1080p (the renderer scales it to the view's height).
 */
export interface DepthOfField3d {
  readonly focusDistance: number;
  readonly focusRange: number;
  readonly maxBlur: number;
}

/** A view's first-person overlay (the viewmodel layer): its own field of view and near plane, same eye. */
export interface ViewOverlay3d {
  readonly projection: Mat4;
  /** World → clip; depth spans 0..`VIEWMODEL_DEPTH`. */
  readonly viewProjection: Mat4;
  readonly inverseViewProjection: Mat4;
  readonly near: number;
  readonly far: number;
}

/**
 * Fog of war on the ground plane (a camera's `FogOverlay`, from the ai plugin's
 * `fog_of_war` service): cells a team sees now are clear, cells it has seen are dimmed by
 * `explored`, the rest covered by `unexplored`.
 */
export interface FogOfWar3d {
  /** Differs whenever the cells, the team or the rectangle do. */
  readonly key: string;
  /** Cell edge (meters) and the first cell's corner. */
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major from (minX, minZ): bit 1 visible now, bit 2 explored. */
  readonly cells: Uint8Array;
  /** Straight-alpha sRGB colors laid over unexplored and explored-but-unseen ground. */
  readonly unexplored: Rgba;
  readonly explored: Rgba;
}

export const COLOR_VISION_MODES = ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
export type ColorVision = (typeof COLOR_VISION_MODES)[number];

type M3 = readonly [number, number, number, number, number, number, number, number, number];

/** Dichromat simulation (Machado, Oliveira & Fernandes 2009, severity 1), linear RGB, row-major. */
const SIMULATION: Readonly<Record<Exclude<ColorVision, 'none'>, M3>> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

/** Where the information a dichromat loses is moved (the channels they still see). */
const ERROR_SHIFT: Readonly<Record<Exclude<ColorVision, 'none'>, M3>> = {
  protanopia: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  deuteranopia: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  tritanopia: [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0],
};

/**
 * The colour-vision correction (daltonization) for a mode, as a row-major 3×3 matrix on
 * linear RGB: c' = c + E·(c − S·c). Renderers apply it after tone mapping; the UI can apply
 * the same matrix to panels (an SVG `feColorMatrix`, which works in linear RGB by default).
 */
export function colorVisionMatrix(mode: ColorVision): number[] {
  if (mode === 'none') return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const S = SIMULATION[mode];
  const E = ERROR_SHIFT[mode];
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let shifted = 0;
      for (let k = 0; k < 3; k++) shifted += E[r * 3 + k]! * ((k === c ? 1 : 0) - S[k * 3 + c]!);
      out.push((r === c ? 1 : 0) + shifted);
    }
  }
  return out;
}

/** The correction as an SVG `feColorMatrix type="matrix"` values string (4×5, alpha unchanged). */
export function colorVisionFilterValues(mode: ColorVision): string {
  const m = colorVisionMatrix(mode).map((v) => +v.toFixed(6));
  return [...m.slice(0, 3), 0, 0, ...m.slice(3, 6), 0, 0, ...m.slice(6, 9), 0, 0, 0, 0, 0, 1, 0].join(' ');
}

/**
 * A projected decal: an image stamped onto whatever surfaces lie inside a box (scorch
 * marks, blood, posters, road paint). The box is the unit cube (-0.5..0.5 on each axis)
 * under `matrix`; the image lies on its x (u, left to right) and z (v, top to bottom) axes
 * and is projected along -y (downward for an unrotated decal).
 */
export interface Decal3d {
  /** Unit box → world, and its inverse. */
  readonly matrix: Mat4;
  readonly inverse: Mat4;
  readonly texture: Texture3d;
  /** Straight-alpha sRGB, multiplied with the image. */
  readonly color: Rgba;
  /**
   * Cosine of the angle between a surface's normal and the projection's (up, +y) past which
   * the decal starts fading; it is gone at 90°, so it never smears down walls.
   */
  readonly angleFade: number;
  /** Later decals draw over earlier ones; equal orders keep frame order. */
  readonly order: number;
  readonly entity: number | null;
}

/**
 * What an impostor shows: a model baked into a hemi-octahedral atlas of `frames` × `frames`
 * views (each `frameSize` texels; albedo with coverage, and normals), drawn far away as one
 * camera-facing quad that blends the frames nearest the view direction. Keyed by `id`.
 */
export interface ImpostorSource3d {
  readonly id: string;
  /** The meshes baked, in the source's own space (a model's rest pose). */
  readonly parts: readonly { readonly geometry: Geometry3d; readonly material: Material3d; readonly matrix: Mat4 }[];
  /** Bounding sphere in the source's space. */
  readonly center: Xyz;
  readonly radius: number;
  readonly frames: number;
  readonly frameSize: number;
}

/** Numbers per impostor instance: x, y, z (the source's origin in world space), uniform scale, yaw (radians about +y), fade (as `MeshBatch.fades`), 0, 0. */
export const IMPOSTOR_STRIDE = 8;

export interface ImpostorBatch3d {
  readonly source: ImpostorSource3d;
  readonly count: number;
  /** `IMPOSTOR_STRIDE` numbers per instance: x, y, z, scale, yaw, fade, 0, 0. */
  readonly instances: Float32Array;
  readonly entities: readonly (number | null)[];
}

/**
 * A view drawn into a render target instead of the screen (a camera feed on an in-world
 * monitor, a planar mirror): the whole pipeline, tone-mapped, into `target`, which a material
 * samples through a `TextureSource` of kind 'target'.
 */
export interface OffscreenView3d {
  readonly target: string;
  /** Texels. */
  readonly width: number;
  readonly height: number;
  /** Its viewport is the whole target. */
  readonly view: View3d;
  /** Redraw it this frame; false keeps the last image (feeds update at their own rate, a few per frame). */
  readonly due: boolean;
}

/** One slice of the first view's depth, shadowed by its own orthographic map. */
export interface Cascade3d {
  /** World → light clip space (x, y in -1..1, z in 0..1). */
  readonly viewProjection: Mat4;
  /** View depth (meters along the camera's forward axis) where this cascade ends. */
  readonly far: number;
  /** World meters per shadow-map texel (for normal-offset biasing). */
  readonly texelWorld: number;
}

/** The sun's cascaded shadow maps, fitted to the first view, nearest cascade first. */
export interface SunShadow3d {
  readonly cascades: readonly Cascade3d[];
  /** Texels per side of each cascade's map. */
  readonly mapSize: number;
}

/** A point or spot light's shadow: 1 face (spot) or 6 cube faces (+x, -x, +y, -y, +z, -z; point). */
export interface LocalShadow3d {
  /** Index of the light in `Frame3d.lights`. */
  readonly light: number;
  /** First tile in the local shadow atlas; the faces take consecutive tiles. */
  readonly tile: number;
  /** World → each face's clip space (z in 0..1). */
  readonly faces: readonly Mat4[];
}

/** A selection outline around an entity's drawn meshes (the `outline` component). */
export interface Outline3d {
  readonly entity: number;
  readonly color: Rgb;
  /** Pixels. */
  readonly width: number;
  /** Drawn where the entity is hidden behind other surfaces too (x-ray). */
  readonly throughWalls: boolean;
  /** 0..1: the silhouette filled with the color (0: outline only). */
  readonly fill: number;
}

/**
 * Numbers per billboard in `BillboardBatch.data`: x, y, z (anchor), ox, oy (the quad's
 * center relative to the anchor, meters along the camera's right and up), width, height,
 * angle (degrees, counter-clockwise on screen), r, g, b, a.
 */
export const BILLBOARD_STRIDE = 12;

/**
 * Where a world-space overlay-or-scene element is composited:
 *   scene    lit-independent but part of the HDR scene: tonemapped, blooms, fogged (particles, beams, trails)
 *   overlay  drawn after tonemapping, colors exact, still depth-tested against the scene (world bars, text, debug lines)
 */
export type Layer3d = 'scene' | 'overlay';

/** Camera-facing quads sharing one image (particles, world bars). */
export interface BillboardBatch {
  readonly layer: Layer3d;
  readonly shape: 'circle' | 'square';
  /** Drawn instead of `shape`, tinted by each billboard's color. */
  readonly image: Texture3d | null;
  readonly count: number;
  readonly data: Float32Array;
  /** The emitting or owning entity; null for effects that outlive any entity. */
  readonly entity: number | null;
}

/** World-space text, one quad. */
export interface Text3d {
  readonly entity: number;
  /** World position of the text's center. */
  readonly position: Xyz;
  /** Line height in meters. */
  readonly size: number;
  readonly spans: readonly TextSpan[];
  /** True: turned toward the camera. False: laid out on the entity's right/up axes. */
  readonly faceCamera: boolean;
  readonly right: Xyz;
  readonly up: Xyz;
}

/** A polyline drawn as a camera-facing ribbon (beams, trails, debug lines). */
export interface Line3d {
  readonly layer: Layer3d;
  /** x, y, z per point. */
  readonly points: Float32Array;
  /** Meters. */
  readonly width: number;
  readonly color: Rgba;
  readonly entity: number | null;
  /** Scene lines: a linear multiplier on the color, so a line can be brighter than white (lightning blooms). Absent: 1. */
  readonly intensity?: number;
}

/**
 * Numbers per particle in `ParticleBatch3d.data`: x, y, z (center), width, height (meters),
 * angle (degrees, counter-clockwise), r, g, b, a (straight-alpha sRGB), sx, sy, sz (the
 * stretch: the world-space vector the quad extends back along, meters — velocity-facing
 * particles), frame (0..1 through the flipbook), then two unused.
 */
export const PARTICLE3D_STRIDE = 16;

/**
 * VFX particles sharing an image and a look (effects' particles). Drawn after the scene's
 * blended surfaces, each faded where it meets the opaque scene (`soft`).
 */
export interface ParticleBatch3d {
  /** alpha: blended over the scene; additive: light added to it (fire, sparks, glows — blooms). */
  readonly blend: 'alpha' | 'additive';
  /** Without an image: circle (hard edge), square, glow (soft radial falloff), ring (a soft band). */
  readonly shape: 'circle' | 'square' | 'glow' | 'ring';
  /** Drawn instead of the shape, tinted by each particle's color; a flipbook sheet when `frames` is more than 1 × 1. */
  readonly image: Texture3d | null;
  /** The image's frames: columns and rows, left to right then top to bottom ([1, 1]: a plain image). */
  readonly frames: readonly [number, number];
  /** camera: billboards; velocity: stretched along the stretch vector, turned to the camera; up: lying flat (normal +y). */
  readonly facing: 'camera' | 'velocity' | 'up';
  /** Meters over which a particle fades out where it meets the opaque scene (0: a hard intersection). */
  readonly soft: number;
  /** Shaded by the sun and ambient light as a rounded puff (smoke, dust); else unlit (emissive). */
  readonly lit: boolean;
  /** A linear multiplier on the color (above 1: brighter than white, so additive particles bloom). */
  readonly intensity: number;
  readonly count: number;
  readonly data: Float32Array;
  /** The emitting entity; null for effects that outlive any entity. */
  readonly entity: number | null;
}

/**
 * Effects every 3D game has without a file, referenced as `effect/<name>` (Python:
 * `Effect.<name>`), the way built-in sounds are `synth/<name>` (`Synth.<name>`);
 * render3d's effect_presets.ts defines them.
 */
export const BUILTIN_EFFECTS = [
  'explosion', 'fire', 'smoke', 'sparks', 'embers', 'magic', 'muzzle_flash', 'impact', 'dust', 'sparkle',
] as const;

/** The prefix of a built-in effect's reference: `effect/explosion`. */
export const BUILTIN_EFFECT_PREFIX = 'effect/';

/**
 * The keys of a `.vfx.json` file — one schema for 2D and 3D games. Both renderers accept
 * every key; render2d ignores `VFX_3D_ONLY_KEYS`. Problems with a file are PP3808 in
 * either.
 */
export const VFX_KEYS = [
  'burst', 'rate', 'duration', 'lifetime', 'speed', 'direction', 'spread', 'radius', 'gravity', 'drag', 'size',
  'size_end', 'color', 'color_end', 'spin', 'shape', 'image', 'max', 'blend', 'haze', 'extends',
  'flipbook', 'frames', 'facing', 'stretch', 'soft', 'lit', 'intensity', 'angle', 'fade_in', 'turbulence', 'delay',
  'light', 'sound', 'shake', 'children', 'on_death',
] as const;

/** `.vfx.json` keys only a 3D game draws (a 2D game accepts and ignores them). */
export const VFX_3D_ONLY_KEYS = [
  'flipbook', 'frames', 'facing', 'stretch', 'soft', 'lit', 'intensity', 'angle', 'fade_in', 'turbulence', 'delay',
  'light', 'sound', 'shake', 'children', 'on_death',
] as const;

/** `.vfx.json` "blend": "alpha" paints over, "additive" adds up and glows where particles overlap. */
export const VFX_BLENDS = ['alpha', 'additive'] as const;

/** `.vfx.json` "shape": 2D draws "glow" and "ring" as circles. */
export const VFX_SHAPES = ['circle', 'square', 'glow', 'ring'] as const;

/** Numbers per point in `Ribbon3d.points`: x, y, z, width (meters), r, g, b, a (straight-alpha sRGB). */
export const RIBBON_STRIDE = 8;

/**
 * A camera-facing strip through points (trails, beams, lightning bolts), with a width and
 * color per point, soft across its width (a bright core fading to its edges).
 */
export interface Ribbon3d {
  readonly blend: 'alpha' | 'additive';
  readonly points: Float32Array;
  /** A linear multiplier on the color (lightning and lasers bloom above 1). */
  readonly intensity: number;
  /** 0..1: the fraction of the width that is a white-hot core (beams, lightning); 0: a plain soft-edged strip (trails). */
  readonly core: number;
  readonly entity: number | null;
}

export interface Frame3d {
  readonly frame: number;
  /** Every active camera's view (more than one in split screen), in seat order. */
  readonly views: readonly View3d[];
  readonly environment: Environment3d;
  readonly quality: Quality3d;
  /** The sun's shadows (null: no sun, or its shadows are off). */
  readonly sunShadow: SunShadow3d | null;
  /** Point and spot lights drawn with shadows this frame (the quality's tile budget, nearest first). */
  readonly localShadows: readonly LocalShadow3d[];
  readonly terrain: Terrain3d | null;
  readonly meshes: readonly MeshBatch[];
  readonly skinned: readonly SkinnedDraw[];
  /** Point, spot and extra directional lights (the sun is in `environment`); any number, nearest `quality.maxLights` drawn. */
  readonly lights: readonly Light3d[];
  readonly billboards: readonly BillboardBatch[];
  readonly texts: readonly Text3d[];
  readonly lines: readonly Line3d[];
  readonly outlines: readonly Outline3d[];
  /** Sky model, clouds, water and weather on surfaces (nature3d.ts); absent or null: the gradient sky only. */
  readonly nature?: Nature3d | null;
  /** Projected decals, in drawing order. Absent: none. */
  readonly decals?: readonly Decal3d[];
  /** Far instances drawn as baked impostors. Absent: none. */
  readonly impostors?: readonly ImpostorBatch3d[];
  /** Views drawn into render targets before the screen's. Absent: none. */
  readonly offscreen?: readonly OffscreenView3d[];
  /** Seconds of game time (material scrolling, hologram flicker, haze shimmer). Absent: 0. */
  readonly time?: number;
  /** Heat haze and shockwave distortion. Absent: none. */
  readonly hazes?: readonly Haze3d[];
  /** Effect particles (render3d's particle system). Absent: none. */
  readonly particles?: readonly ParticleBatch3d[];
  /** Trails, beams and lightning. Absent: none. */
  readonly ribbons?: readonly Ribbon3d[];
}

/** An image read back from a surface: RGBA8, rows top to bottom, straight alpha. */
export interface Capture3d {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** A surface that draws 3D frames. Implemented in `platform/`. */
export interface RenderSurface3d {
  /** Drawing area in pixels. */
  size(): { readonly width: number; readonly height: number };
  /** Draw a frame. Textures load on first sight; a draw whose textures aren't decoded yet waits for them. */
  draw(frame: Frame3d): void;
  /** Load failures since the last call (an undecodable texture), as diagnostics. */
  takeProblems(): readonly Diagnostic[];
  /** What the device can afford, for `Settings.quality = "auto"` (absent: high). */
  readonly deviceTier?: Quality3d['level'];
  /**
   * Whether to build a frame for this display refresh under a frame cap (frames per second,
   * 0: none). False skips it; the game still steps. Absent: always.
   */
  wantsFrame?(cap: number): boolean;
  /**
   * Draw a frame offscreen at a size and read its image back (photos, model portraits). A
   * view whose `clear` has alpha below 1 leaves its background that transparent.
   */
  capture?(frame: Frame3d, width: number, height: number): Promise<Capture3d>;
}

/** Binary project files (models, buffers), read asynchronously. */
export interface BinaryFiles {
  read(path: string): Promise<Uint8Array>;
}
