/**
 * Frame planning: a `Frame3d` → a `FramePlan`, everything a backend needs to draw it with
 * no further decisions — which passes run (the quality and the post settings decide),
 * packed uniform slots, instance/billboard/line arrays, the bone palette, the light and
 * cluster textures, shadow tiles with their casters, and per view the ordered draw lists.
 * Both backends execute a plan through `visitPasses`, so the pass order is defined once:
 *
 *   environment   the sky's environment cube + prefiltered mips (only when its key changes)
 *   shadows       sun cascades, then point/spot faces, each a tile of its atlas
 *   per view:     scene        sky, terrain, opaque meshes → HDR color (+ normals/roughness
 *                              when a screen-space pass needs them) and depth
 *                 ao           screen-space ambient occlusion (+ blur)
 *                 reflections  screen-space reflections
 *                 resolve      HDR color × AO + reflections → the second HDR target
 *                 transparent  blended meshes (far to near), particles, beams and trails
 *                 volumetric   sunlight scattered by the fog, through the sun's shadows
 *                 god rays     light shafts streaming from the sun on screen
 *                 dof          depth of field, for a camera with one (dof.ts)
 *                 outlines     outlined entities' silhouettes into the outline mask
 *   bloom         bright light, blurred down a mip chain and back up (whole target)
 *   per view:     final        bloom, exposure, AgX tone curve, grade, ink edges, posterize,
 *                              outlines, chromatic aberration, vignette, pixelate → LDR
 *                 overlay      world bars, text and debug lines, depth-tested, exact colors
 *   present       FXAA (or a copy) into the canvas
 *
 * Draws whose textures haven't finished loading are left out of the frame (they appear
 * when decoded), as are views with no area.
 */

import { BILLBOARD_STRIDE, colorVisionMatrix } from '../../../core/index.js';
import type {
  Fog3d, Frame3d, Geometry3d, Haze3d, Light3d, Material3d, Post3d, Quality3d, TerrainMaterial3d, Text3d, Texture3d, View3d,
} from '../../../core/index.js';
import { buildClusters } from './clusters.js';
import type { CullStats } from './cull.js';
import { Growing, MeshPlan } from './plan_meshes.js';
import type { MeshItem } from './plan_meshes.js';
import { packTerrainBlock } from './terrain_plan.js';
import { natureFades, planNature, skyFogAmount, viewFadeOf } from './sky_plan.js';
import { planImpostors } from './impostors.js';
import { hizSize } from './occlusion.js';
import { planDecals } from './decals.js';
import { planVfx } from './vfx.js';
import type { VfxPlan } from './vfx.js';
import { planDepthOfField } from './dof.js';
import type { DofPlan } from './dof.js';
import type { DecalFrame } from './decals.js';
import type { ImpostorFrame } from './impostors.js';
import type { NaturePlan } from './sky_plan.js';
import type { ClusterPlan } from './clusters.js';
import { environmentKey, environmentMips, reflectionSky, skyLighting } from './ibl.js';
import {
  BILLBOARD_INSTANCE_FLOATS, CASTER_SLOT, DATA_ROW, FRAME_FIELDS, FRAME_SLOT, LINE_VERTEX_FLOATS, linearRgb, luminance,
  MATERIAL_SLOT, MAX_CASCADES, MAX_HAZES_DRAWN, MAX_SHADOW_TILES, MESH_INSTANCE_FLOATS, offsetOf, packInstance, packLights, packMaterial, SHADOW_FIELDS,
  slotFloats, srgbToLinear,
} from './layout.js';

/** A texture rasterized from world text by the surface. */
export interface TextTexture {
  readonly id: string;
  readonly text: Text3d;
}

export type TextureRef = Texture3d | TextTexture;

export function isTextTexture(t: TextureRef): t is TextTexture {
  return 'text' in t;
}

export type { MeshItem } from './plan_meshes.js';
export { materialTextures } from './plan_meshes.js';

/** One terrain tile draw. */
export interface TerrainDraw {
  readonly geometry: Geometry3d;
  /** Slot in `FramePlan.materials` holding the terrain block for its palette and level. */
  readonly uniformSlot: number;
  /** The palette's four detail textures (null: none); base colors and normal maps come from the terrain arrays. */
  readonly textures: readonly (Texture3d | null)[];
}

export interface TerrainItem {
  /** Tiles that can be seen (from the view, or from a shadow tile). */
  readonly tiles: readonly TerrainDraw[];
  /** An identity instance record (shadow passes draw the terrain like a mesh). */
  readonly instance: number;
}

export interface BillboardItem {
  readonly texture: TextureRef | null;
  readonly first: number;
  readonly count: number;
}

export interface OutlineItem {
  readonly item: MeshItem;
  /** Slot in `FramePlan.materials` holding the outline's color, width and fill. */
  readonly slot: number;
  readonly throughWalls: boolean;
}

export interface ViewPlan {
  /** Pixels, origin top-left. */
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Slot in `FramePlan.frames`. */
  readonly frameSlot: number;
  /** The render target this view draws into (null: the screen). */
  readonly target: string | null;
  /** Fog of war over this view's ground: the cell texture's key, size and texels (0 seen, 128 explored, 255 unexplored); null: none. */
  readonly fog: { readonly key: string; readonly width: number; readonly height: number; readonly texels: Uint8Array } | null;
  readonly terrain: TerrainItem | null;
  /** The view's camera entity. */
  readonly camera: number;
  /** Inside its frustum (and not occluded): opaque, then far to near the alpha-blended and transmissive (glass) surfaces. */
  readonly opaque: readonly MeshItem[];
  readonly transparent: readonly MeshItem[];
  /** The viewmodel layer (opaque, then blended far to near), drawn with `overlaySlot`. */
  readonly viewmodel: readonly MeshItem[];
  readonly viewmodelTransparent: readonly MeshItem[];
  /** Slot in `FramePlan.frames` with the view's overlay projection (null: no overlay). */
  readonly overlaySlot: number | null;
  /** A mirror's view: front faces wind the other way. */
  readonly mirrored: boolean;
  /** Scene-layer billboards (particles). */
  readonly billboards: readonly BillboardItem[];
  readonly lines: { readonly first: number; readonly count: number };
  /** Overlay-layer billboards (world bars, text). */
  readonly overlayBillboards: readonly BillboardItem[];
  readonly overlayLines: { readonly first: number; readonly count: number };
  readonly outlines: readonly OutlineItem[];
  /** The camera's depth-of-field pass (dof.ts); absent or null: none. */
  readonly depthOfField?: DofPlan | null;
}

export interface ShadowTile {
  readonly atlas: 'sun' | 'local';
  /** Slot in `FramePlan.casters` holding the tile's light view-projection. */
  readonly slot: number;
  /** Texels in the atlas: x, y from the atlas's first row, side. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly casters: readonly MeshItem[];
  readonly terrain: TerrainItem | null;
}

export interface EnvironmentPlan {
  /** Rebuild the cube when this differs from the last one drawn. */
  readonly key: string;
  readonly size: number;
  /** Prefiltered mips (level 0 is the sky itself, the last is the roughest). */
  readonly mips: number;
  /** Linear sky colors. */
  readonly zenith: readonly number[];
  readonly horizon: readonly number[];
  /** The panorama the cube is drawn from instead (loaded), its turn (fraction of a circle) and light multiplier; null: the sky. */
  readonly skybox: { readonly texture: Texture3d; readonly turn: number; readonly intensity: number } | null;
}

/** Which passes run this frame (frame-wide: every view draws the same passes). */
export interface PassFlags {
  /** The scene pass also writes normals, roughness and reflectivity. */
  readonly gbuffer: boolean;
  readonly ao: 'off' | 'half' | 'full';
  readonly reflections: boolean;
  /** AO or reflections ran: the resolve pass writes the second HDR target. */
  readonly resolve: boolean;
  readonly volumetric: boolean;
  readonly godRays: boolean;
  /** Bloom mip levels (0: no bloom). */
  readonly bloomLevels: number;
  readonly outlines: boolean;
  readonly fxaa: boolean;
  readonly wireframe: boolean;
}

export interface FramePlan {
  readonly width: number;
  readonly height: number;
  readonly quality: Quality3d;
  readonly flags: PassFlags;
  /** `FRAME_SLOT` floats per view. */
  readonly frames: Float32Array;
  /** One `SHADOW_FIELDS` block (local shadow tile matrices), shared by every view. */
  readonly shadowBlock: Float32Array;
  /** `CASTER_SLOT` floats per shadow tile. */
  readonly casters: Float32Array;
  readonly materials: Float32Array;
  readonly instances: Float32Array;
  readonly billboards: Float32Array;
  readonly lines: Float32Array;
  /** 16 floats per joint, every skinned draw's palette end to end. */
  readonly palette: Float32Array;
  /** RGBA32F light texture data (`DATA_ROW` texels per row). */
  readonly lights: Float32Array;
  readonly clusters: ClusterPlan;
  readonly environment: EnvironmentPlan;
  readonly sunAtlas: number;
  readonly localAtlas: number;
  readonly shadowTiles: readonly ShadowTile[];
  readonly views: readonly ViewPlan[];
  /** Instances tested, inside a view's frustum, and hidden by occlusion, summed over the views. */
  readonly stats: CullStats;
  /** Sky, clouds, water, weather on surfaces (sky_plan.ts); null when the frame has none. */
  readonly nature: NaturePlan | null;
  /** Far instances drawn as impostors, per view, and the sources to bake (impostors.ts); null: none. */
  readonly impostors: ImpostorFrame | null;
  /** Projected decals per view (decals.ts); null: none. */
  readonly decals: DecalFrame | null;
  /** The views by destination: each offscreen target's, then the screen's (`views` is all of them, in this order). */
  readonly groups: readonly ViewGroup[];
  /** The canvas's size (the present pass's output; `width` × `height` is the render size). */
  readonly output: { readonly width: number; readonly height: number };
  /** The Hi-Z depth read-back this frame (null: none). */
  readonly occlusion: OcclusionPlan | null;
  /** Effect particles and ribbons (vfx.ts), drawn per view after its blended surfaces; null: none. */
  readonly vfx: VfxPlan | null;
}

export { EXPOSURE_CALIBRATION } from './layout.js';

export interface PlanOptions {
  readonly width: number;
  readonly height: number;
  /** Whether a texture has decoded and can be bound. */
  readonly ready: (texture: Texture3d) => boolean;
  /** A text's quad size in meters (from its rasterized aspect) and its texture. */
  readonly text: (text: Text3d) => { readonly width: number; readonly height: number; readonly texture: TextTexture };
  /** Hi-Z occlusion (`MeshPlanOptions.occluded`). Absent: nothing is occluded. */
  readonly occluded?: (camera: number, x: number, y: number, z: number, r: number) => boolean;
  /**
   * Dynamic resolution: the scene is drawn at `width` × `height` (the render size), which is
   * the canvas (`output`) scaled by this; views' viewports (in canvas pixels) scale with it,
   * and the present pass upscales with sharpening. Default 1.
   */
  readonly renderScale?: number;
  /** The canvas's size (default: `width` × `height`). */
  readonly output?: { readonly width: number; readonly height: number };
  /** A decal image's layer in the surface's decal array, or null until it is in (decals.ts). Absent: no decals drawn. */
  readonly decalLayer?: (texture: Texture3d) => number | null;
  /** A textured terrain material's layer in the surface's terrain arrays (terrain_arrays.ts), or null until it is in. Absent: its index among the textured materials, once its texture is ready. */
  readonly terrainLayer?: (material: TerrainMaterial3d) => number | null;
  /** The surface binds the terrain's splat map (`Terrain3d.splat`): blend by it. Absent: by the vertex weights. */
  readonly terrainSplat?: boolean;
  /** Reduce and read back the first screen view's depth this frame (Hi-Z, occlusion.ts). */
  readonly readDepth?: boolean;
}

/** The depth read-back a frame asks for: which view, and what the depth is drawn with. */
export interface OcclusionPlan {
  /** The view's frame slot (its depth is reduced right after its opaque scene). */
  readonly slot: number;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Grid cells across and down, and texels per cell side. */
  readonly width: number;
  readonly height: number;
  readonly block: number;
  readonly camera: number;
  readonly viewProjection: Float32Array;
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
}

/** An offscreen view's render target (a camera feed or a mirror), drawn this frame. */
export interface OffscreenPlan {
  readonly id: string;
  /** Texels (at most the render size). */
  readonly width: number;
  readonly height: number;
}

/** Views drawn into one destination: a render target, or (null) the screen. */
export interface ViewGroup {
  readonly target: OffscreenPlan | null;
  readonly views: readonly ViewPlan[];
}

/** A view's fog-of-war cells as one-byte texels: 0 seen now, 128 explored, 255 unexplored. */
export function fogTexels(view: View3d): ViewPlan['fog'] {
  const fog = view.fogOfWar ?? null;
  if (fog === null || fog.cols === 0 || fog.rows === 0) return null;
  const texels = new Uint8Array(fog.cols * fog.rows);
  for (let i = 0; i < texels.length; i++) {
    const c = fog.cells[i]!;
    texels[i] = (c & 1) !== 0 ? 0 : (c & 2) !== 0 ? 128 : 255;
  }
  return { key: fog.key, width: fog.cols, height: fog.rows, texels };
}

function occlusionPlan(view: ViewPlan, source: View3d): OcclusionPlan {
  const vp = view.viewport;
  const size = hizSize(Math.round(vp.width), Math.round(vp.height));
  return {
    slot: view.frameSlot, viewport: vp, ...size, camera: source.camera, viewProjection: Float32Array.from(source.viewProjection),
    position: [...source.position], forward: [...source.forward],
  };
}

/** Upscale sharpening strength for a render scale: none at 1, 2 × the shortfall, at most 0.45. */
export function sharpenFor(scale: number): number {
  return scale >= 0.999 ? 0 : Math.min(0.45, Math.max(0, (1 - scale) * 2));
}

/** Whether a world box can be inside a clip space (all eight corners outside one plane: no). */
export function boxVisible(vp: ArrayLike<number>, min: readonly number[], max: readonly number[]): boolean {
  let left = 0; let right = 0; let bottom = 0; let top = 0; let near = 0; let far = 0;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? max[0]! : min[0]!;
    const y = i & 2 ? max[1]! : min[1]!;
    const z = i & 4 ? max[2]! : min[2]!;
    const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
    const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
    const cz = vp[2]! * x + vp[6]! * y + vp[10]! * z + vp[14]!;
    const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
    if (cx < -cw) left++;
    if (cx > cw) right++;
    if (cy < -cw) bottom++;
    if (cy > cw) top++;
    if (cz < 0) near++;
    if (cz > cw) far++;
  }
  return left < 8 && right < 8 && bottom < 8 && top < 8 && near < 8 && far < 8;
}

function distanceSq(view: View3d, x: number, y: number, z: number): number {
  const dx = x - view.position[0];
  const dy = y - view.position[1];
  const dz = z - view.position[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * The lights the frame shades: every directional light, then the shadowed local lights,
 * then the rest by how close their reach comes to the first view — at most `max` in all.
 * Directional lights come first (the shaders loop over them separately).
 */
export function selectLights(lights: readonly Light3d[], shadowed: ReadonlySet<Light3d>, view: View3d | undefined, max: number): Light3d[] {
  const reach = (l: Light3d): number => (view === undefined ? 0 : Math.sqrt(distanceSq(view, l.position[0], l.position[1], l.position[2])) - l.range);
  const lit = lights.filter((l) => l.intensity > 0);
  const directional = lit.filter((l) => l.kind === 'directional');
  const local = lit.filter((l) => l.kind !== 'directional').sort((a, b) => Number(shadowed.has(b)) - Number(shadowed.has(a)) || reach(a) - reach(b));
  return [...directional, ...local].slice(0, max);
}

/** The atlas grid: tiles per side for `count` tiles. */
export function atlasColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

/** Which passes this frame runs, from the quality and the scene's post settings. */
export function passFlags(quality: Quality3d, post: Post3d, fog: Fog3d, outlines: boolean, sun: boolean, sunShadows: boolean): PassFlags {
  const wireframe = post.mode === 'wireframe';
  const ao = wireframe || post.ambientOcclusion <= 0 ? 'off' : quality.ambientOcclusion;
  const reflections = !wireframe && post.reflections && quality.reflections;
  const edges = !wireframe && post.edges > 0;
  return {
    gbuffer: ao !== 'off' || reflections || edges,
    ao,
    reflections,
    resolve: ao !== 'off' || reflections,
    volumetric: !wireframe && sunShadows && quality.volumetricFog && fog.kind !== 'none' && fog.volumetric > 0,
    godRays: !wireframe && sun && quality.godRays && post.godRays > 0,
    bloomLevels: post.bloom > 0 ? quality.bloomLevels : 0,
    outlines,
    fxaa: post.antialias && post.pixelate <= 1,
    wireframe,
  };
}

/** Where the sun sits on a view's screen (uv, y down) and how much it faces the camera (0..1). */
export function sunOnScreen(view: View3d, sunDirection: readonly number[]): [number, number, number] {
  const toSun = [-sunDirection[0]!, -sunDirection[1]!, -sunDirection[2]!];
  const facing = toSun[0]! * view.forward[0] + toSun[1]! * view.forward[1] + toSun[2]! * view.forward[2];
  if (facing <= 0) return [0.5, 0.5, 0];
  const d = view.far * 0.5;
  const x = view.position[0] + toSun[0]! * d;
  const y = view.position[1] + toSun[1]! * d;
  const z = view.position[2] + toSun[2]! * d;
  const m = view.viewProjection;
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (cw <= 0) return [0.5, 0.5, 0];
  return [(cx / cw + 1) / 2, (1 - cy / cw) / 2, facing];
}

interface FrameLighting {
  readonly directional: number;
  readonly count: number;
  readonly sh: readonly number[];
  readonly specularScale: number;
  readonly envMips: number;
}

function packFrame(frame: Frame3d, view: View3d, out: Float32Array, slot: number, lighting: FrameLighting, clusters: ClusterPlan, plan: {
  width: number; height: number; flags: PassFlags; sunCols: number; sunAtlas: number; localCols: number; localAtlas: number; outlineWidth: number;
  /** An offscreen view: no bloom (the bloom chain is the screen's). */
  offscreen: boolean; sharpen: number; output: { readonly width: number; readonly height: number };
  /** The loaded skybox panorama (null: none, or still loading). */
  skybox: EnvironmentPlan['skybox'];
}): void {
  const o = slot * FRAME_SLOT;
  const at = (name: string): number => o + offsetOf(FRAME_FIELDS, name);
  const set = (name: string, ...values: number[]): void => out.set(values, at(name));
  const env = frame.environment;
  const post = env.post;
  out.set(view.viewProjection, at('viewProjection'));
  out.set(view.inverseViewProjection, at('inverseViewProjection'));
  set('cameraPosition', ...view.position, view.near);
  set('cameraForward', ...view.forward, view.far);
  set('cameraRight', ...view.right, 0);
  set('cameraUp', ...view.up, 0);
  set('viewport', view.viewport.x, view.viewport.y, view.viewport.width, view.viewport.height);
  set('targetSize', plan.width, plan.height, 1 / plan.width, 1 / plan.height);
  const sun = frame.sunShadow;
  if (env.sun !== null) {
    set('sunDirection', ...env.sun.direction, 1);
    set('sunColor', ...linearRgb(env.sun.color, env.sun.intensity), sun === null ? 0 : Math.min(MAX_CASCADES, sun.cascades.length));
  }
  if (sun !== null) {
    sun.cascades.slice(0, MAX_CASCADES).forEach((c, i) => {
      out.set(c.viewProjection, at('cascades') + i * 16);
      out[at('cascadeSplits') + i] = c.far;
      out[at('cascadeTexel') + i] = c.texelWorld;
    });
  }
  set('ambient', ...linearRgb(env.ambient), lighting.specularScale);
  set('fogColor', ...linearRgb(env.fog.color), env.fog.kind === 'none' ? 0 : env.fog.kind === 'exponential' ? 1 : 2);
  set('fogParams', env.fog.density, env.fog.near, env.fog.far, env.fog.volumetric);
  set('fogHeight', env.fog.heightFalloff ?? 0, env.fog.height ?? 0, skyFogAmount(env.fog, view.far), 0);
  // The panorama replaces an opaque camera background too (as the sky model does); a transparent one (portraits) stays.
  const panorama = plan.skybox !== null && (view.clear === null || view.clear[3] >= 1);
  set('skybox', plan.skybox?.turn ?? 0, plan.skybox?.intensity ?? 1, panorama ? 1 : 0, 0);
  const flat = view.clear !== null
    ? linearRgb([view.clear[0], view.clear[1], view.clear[2]])
    : plan.flags.wireframe && post.wireBackground !== null ? linearRgb(post.wireBackground) : null;
  set('skyZenith', ...(flat ?? linearRgb(env.sky.zenith)), flat === null ? 1 : 0);
  set('skyHorizon', ...(flat ?? linearRgb(env.sky.horizon)), flat === null ? 1 : 0);
  const sh = lighting.sh;
  set('sh0', sh[0]!, sh[1]!, sh[2]!, sh[3]!);
  set('sh1', sh[4]!, sh[5]!, sh[6]!, sh[7]!);
  set('sh2', sh[8]!, lighting.envMips - 1, 0, 0);
  set('shadowParams', plan.sunCols, 1 / plan.sunAtlas, plan.localCols, 1 / plan.localAtlas);
  const viewPlan = clusters.views[slot]!;
  set('clusterParams', clusters.dims.x, clusters.dims.y, clusters.dims.z, viewPlan.base);
  set('clusterDepth', viewPlan.mapping.scale, viewPlan.mapping.bias, lighting.directional, lighting.count);
  set('style', post.toon, plan.flags.wireframe ? 1 : 0, plan.outlineWidth, frame.quality.shadowTaps);
  set('wireColor', ...(post.wireColor === null ? [1, 1, 1] : linearRgb(post.wireColor)), post.wireColor === null ? 0 : 1);
  set('postA', post.exposure, plan.flags.bloomLevels > 0 && !plan.offscreen ? post.bloom : 0, post.bloomThreshold, post.vignette);
  // w: the image's alpha where nothing was drawn (a portrait's transparent background; 1 otherwise).
  set('present', plan.sharpen, plan.output.width, plan.output.height, view.clear === null ? 1 : view.clear[3]);
  const fog = view.fogOfWar ?? null;
  if (fog !== null) {
    set('fogRect', fog.minX, fog.minZ, 1 / (fog.cols * fog.cell), 1 / (fog.rows * fog.cell));
    set('fogExplored', ...linearRgb([fog.explored[0], fog.explored[1], fog.explored[2]]), fog.explored[3]);
    set('fogUnexplored', ...linearRgb([fog.unexplored[0], fog.unexplored[1], fog.unexplored[2]]), fog.unexplored[3]);
  }
  set('postB', post.chromaticAberration, Math.max(1, Math.round(post.pixelate)), post.posterize, plan.flags.gbuffer ? post.edges : 0);
  set('postC', post.grade.saturation, post.grade.contrast, plan.flags.ao === 'off' ? 0 : post.ambientOcclusion, plan.flags.godRays ? post.godRays : 0);
  set('gradeTint', ...post.grade.tint, 1);
  set('gradeBalance', ...temperatureShift(post.grade.temperature ?? 0), post.grain ?? 0);
  set('gradeNoise', frame.frame % 4096, 1, 0, 0);
  set('edgeColor', ...linearRgb(post.edgeColor), 1);
  set('sunScreen', ...(env.sun === null ? [0.5, 0.5, 0] : sunOnScreen(view, env.sun.direction)), 0);
  const cv = colorVisionMatrix(view.colorVision);
  set('colorVision0', cv[0]!, cv[1]!, cv[2]!, view.colorVision === 'none' ? 0 : 1);
  set('colorVision1', cv[3]!, cv[4]!, cv[5]!, 0);
  set('colorVision2', cv[6]!, cv[7]!, cv[8]!, 0);
  // z: the outdoor passes fade this view's surfaces (after the water), so the scene's shaders don't.
  const fade = viewFadeOf(view);
  set('viewFade', fade.start, fade.end, natureFades(frame, view) ? 1 : 0, 0);
  set('viewFadeColor', ...linearRgb(env.fog.kind === 'none' ? env.sky.horizon : env.fog.color), 0);
  packHazes(frame, view, out, at);
}

/**
 * Heat haze (Frame3d.hazes): the strongest `MAX_HAZES_DRAWN` in front of the view, into the
 * frame block's haze fields; the final pass bends the image around each.
 */
export function packHazes(frame: Frame3d, view: View3d, out: Float32Array, at: (name: string) => number): void {
  const hazes = (frame.hazes ?? []).filter((h) => h.strength > 0 && h.radius > 0 && hazeInFront(h, view))
    .sort((a, b) => b.strength - a.strength).slice(0, MAX_HAZES_DRAWN);
  out.set([hazes.length, (frame.time ?? 0) % 3600, 0, 0], at('haze'));
  hazes.forEach((h, i) => {
    out.set([...h.position, h.radius], at('hazeAt') + i * 4);
    out.set([Math.min(1, h.strength), Math.max(0, h.ring), 0, 0], at('hazeShape') + i * 4);
  });
}

/** Whether any of a haze's sphere is in front of the camera. */
function hazeInFront(h: Haze3d, view: View3d): boolean {
  const d = (h.position[0] - view.position[0]) * view.forward[0] + (h.position[1] - view.position[1]) * view.forward[1]
    + (h.position[2] - view.position[2]) * view.forward[2];
  return d + h.radius > view.near;
}

/** The old renderer's temperature: added to the graded image, +0.1·t red and -0.1·t blue (display values). */
export function temperatureShift(t: number): [number, number, number] {
  return [t * 0.1, 0, -t * 0.1];
}

/**
 * Linear-light multipliers that shift white toward a warmer (t > 0) or cooler (t < 0)
 * illuminant: the ratio of a black body at 6500 K · 2^(-t) to one at 6500 K (Tanner Helland's
 * fit, linearized), luminance kept. t = 1 is about 3250 K, t = -1 about 13000 K.
 */
export function whiteBalance(t: number): [number, number, number] {
  if (t === 0) return [1, 1, 1];
  const target = kelvinRgb(6500 * 2 ** -t);
  const white = kelvinRgb(6500);
  const ratio = [target[0] / white[0], target[1] / white[1], target[2] / white[2]] as const;
  const lum = 0.2126 * ratio[0] + 0.7152 * ratio[1] + 0.0722 * ratio[2];
  return [ratio[0] / lum, ratio[1] / lum, ratio[2] / lum];
}

/** A black body's color at `kelvin`, linear rgb (Tanner Helland's fit of the sRGB values, decoded). */
function kelvinRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const decode = (v: number): number => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [decode(r), decode(g), Math.max(decode(b), 1e-3)];
}

export function planFrame(frame: Frame3d, options: PlanOptions): FramePlan {
  const quality = frame.quality;
  const post = frame.environment.post;
  const scale = options.renderScale ?? 1;
  const output = options.output ?? { width: options.width, height: options.height };
  const screen = frame.views.filter((v) => v.viewport.width >= 1 && v.viewport.height >= 1).map((v): View3d => (scale === 1 ? v : {
    ...v, viewport: { x: v.viewport.x * scale, y: v.viewport.y * scale, width: v.viewport.width * scale, height: v.viewport.height * scale },
  }));
  // Offscreen views due this frame, first: the screen's materials sample what they draw. A target
  // larger than the render size draws at the largest size that fits, keeping its aspect.
  const offscreenTargets: OffscreenPlan[] = [];
  const offscreenViews: View3d[] = [];
  for (const o of frame.offscreen ?? []) {
    if (!o.due || !(o.width >= 1 && o.height >= 1)) continue;
    const fit = Math.min(1, options.width / o.width, options.height / o.height);
    const width = Math.max(1, Math.floor(o.width * fit));
    const height = Math.max(1, Math.floor(o.height * fit));
    offscreenTargets.push({ id: o.target, width, height });
    offscreenViews.push({ ...o.view, viewport: { x: 0, y: 0, width, height } });
  }
  const views = [...offscreenViews, ...screen];
  const first = screen[0];

  // ── Lights and clusters ─────────────────────────────────────────────────────
  const localShadows = first === undefined ? [] : frame.localShadows;
  const shadowedLights = new Set(localShadows.map((s) => frame.lights[s.light]!));
  const lights = selectLights(frame.lights, shadowedLights, first, quality.maxLights);
  const directional = lights.filter((l) => l.kind === 'directional').length;
  const localCols = atlasColumns(quality.localShadowTiles);
  const tiles = new Map<Light3d, number>();
  const shadowBlock = new Float32Array(slotFloats(SHADOW_FIELDS));
  const tilesAt = offsetOf(SHADOW_FIELDS, 'tiles');
  for (const s of localShadows) {
    const light = frame.lights[s.light]!;
    if (!lights.includes(light) || s.tile + s.faces.length > Math.min(MAX_SHADOW_TILES, quality.localShadowTiles)) continue;
    tiles.set(light, s.tile);
    s.faces.forEach((m, f) => shadowBlock.set(m, tilesAt + (s.tile + f) * 16));
  }
  const clusters = buildClusters(lights, directional, views, { x: quality.clusters[0], y: quality.clusters[1], z: quality.clusters[2] }, DATA_ROW);

  // ── Materials and mesh draws ────────────────────────────────────────────────
  const materialSlots = new Map<Material3d, number>();
  const materialList: Material3d[] = [];
  const slotOf = (m: Material3d): number => {
    let slot = materialSlots.get(m);
    if (slot === undefined) {
      slot = materialList.length;
      materialSlots.set(m, slot);
      materialList.push(m);
    }
    return slot;
  };

  const meshes = new MeshPlan(frame, { ready: options.ready, slotOf, ...(options.occluded !== undefined && { occluded: options.occluded }) });
  const instances = meshes.instances;
  const palette = meshes.palette;
  const byEntity = meshes.byEntity;

  // Material slots, then the terrain blocks (one per palette and level), then one slot per outline.
  const terrainBase = materialList.length;
  const t = frame.terrain;
  const textured = t?.materials.filter((m) => m.texture !== null) ?? [];
  const terrainLayers = t?.materials.map((m) => (m.texture === null ? 0
    : options.terrainLayer !== undefined ? options.terrainLayer(m) : options.ready(m.texture) ? textured.indexOf(m) : null)) ?? [];
  const terrainReady = t !== null && terrainLayers.every((l) => l !== null) && t.materials.every((m) => m.detail === null || options.ready(m.detail));
  const terrainBlocks = new Map<string, { slot: number; palette: readonly number[]; morphStart: number; morphEnd: number }>();
  if (t !== null && terrainReady) {
    for (const tile of t.tiles) {
      const key = `${tile.palette.join(',')}|${tile.morphStart}|${tile.morphEnd}`;
      if (!terrainBlocks.has(key)) terrainBlocks.set(key, { slot: terrainBase + terrainBlocks.size, palette: tile.palette, morphStart: tile.morphStart, morphEnd: tile.morphEnd });
    }
  }
  const outlineBase = terrainBase + terrainBlocks.size;
  const materials = new Float32Array((outlineBase + frame.outlines.length + 1) * MATERIAL_SLOT);
  materialList.forEach((m, slot) => packMaterial(m, materials, slot, frame.time ?? 0));

  let terrain: TerrainItem | null = null;
  if (t !== null && terrainReady) {
    for (const block of terrainBlocks.values()) packTerrainBlock(t.materials, block.palette, block.morphStart, block.morphEnd, materials, block.slot * MATERIAL_SLOT, {
      layers: terrainLayers as number[], waterLevel: t.waterLevel ?? null, splat: options.terrainSplat === true ? t.splat ?? null : null,
    });
    const instance = instances.reserve(MESH_INSTANCE_FLOATS) / MESH_INSTANCE_FLOATS;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    packInstance(identity, 0, [1, 1, 1, 1], 0, 0, instances.data, instance * MESH_INSTANCE_FLOATS);
    terrain = {
      instance,
      tiles: t.tiles.map((tile): TerrainDraw => ({
        geometry: tile.geometry,
        uniformSlot: terrainBlocks.get(`${tile.palette.join(',')}|${tile.morphStart}|${tile.morphEnd}`)!.slot,
        textures: [0, 1, 2, 3].map((k) => (tile.palette[k] === undefined ? null : t.materials[tile.palette[k]!]!.detail)),
      })),
    };
  }
  const terrainSeen = (vp: ArrayLike<number>): TerrainItem | null => {
    if (terrain === null) return null;
    const tiles = terrain.tiles.filter((d) => boxVisible(vp, d.geometry.min, d.geometry.max));
    return tiles.length === 0 ? null : { ...terrain, tiles };
  };

  // ── Outlines ────────────────────────────────────────────────────────────────
  const outlineItems: OutlineItem[] = [];
  let outlineWidth = 0;
  frame.outlines.forEach((outline, i) => {
    const items = byEntity.get(outline.entity);
    if (items === undefined) return;
    const slot = outlineBase + i;
    const o = slot * MATERIAL_SLOT;
    const width = outline.width > 0 ? Math.max(1, Math.round(outline.width)) : 0;
    materials.set(linearRgb(outline.color), o);
    materials[o + 3] = width + Math.min(0.99, outline.fill);
    outlineWidth = Math.max(outlineWidth, width);
    for (const item of items) outlineItems.push({ item, slot, throughWalls: outline.throughWalls });
  });

  // ── Billboards: particles (scene), bars and text (overlay) ──────────────────
  const billboards = new Growing(256 * BILLBOARD_INSTANCE_FLOATS);
  const sceneBillboards: BillboardItem[] = [];
  const overlayBillboards: BillboardItem[] = [];
  for (const batch of frame.billboards) {
    if (batch.count === 0 || (batch.image !== null && !options.ready(batch.image))) continue;
    const firstBillboard = billboards.reserve(batch.count * BILLBOARD_INSTANCE_FLOATS) / BILLBOARD_INSTANCE_FLOATS;
    const shape = batch.image === null && batch.shape === 'circle' ? 1 : 0;
    for (let i = 0; i < batch.count; i++) {
      const s = i * BILLBOARD_STRIDE;
      const o = (firstBillboard + i) * BILLBOARD_INSTANCE_FLOATS;
      const d = batch.data;
      const out = billboards.data;
      out[o] = d[s]!; out[o + 1] = d[s + 1]!; out[o + 2] = d[s + 2]!; out[o + 3] = d[s + 7]!;
      out[o + 4] = 0; out[o + 5] = 0; out[o + 6] = 0; out[o + 7] = d[s + 3]!;
      out[o + 8] = 0; out[o + 9] = 0; out[o + 10] = 0; out[o + 11] = d[s + 4]!;
      out[o + 12] = d[s + 5]!; out[o + 13] = d[s + 6]!; out[o + 14] = shape; out[o + 15] = 0;
      out[o + 16] = srgbToLinear(d[s + 8]!); out[o + 17] = srgbToLinear(d[s + 9]!); out[o + 18] = srgbToLinear(d[s + 10]!); out[o + 19] = d[s + 11]!;
    }
    (batch.layer === 'scene' ? sceneBillboards : overlayBillboards).push({ texture: batch.image, first: firstBillboard, count: batch.count });
  }
  for (const text of frame.texts) {
    const { width, height, texture } = options.text(text);
    const firstBillboard = billboards.reserve(BILLBOARD_INSTANCE_FLOATS) / BILLBOARD_INSTANCE_FLOATS;
    const o = firstBillboard * BILLBOARD_INSTANCE_FLOATS;
    const out = billboards.data;
    out.set([text.position[0], text.position[1], text.position[2], 0], o);
    out.set([text.right[0], text.right[1], text.right[2], 0], o + 4);
    out.set([text.up[0], text.up[1], text.up[2], 0], o + 8);
    out.set([width, height, 0, text.faceCamera ? 0 : 1], o + 12);
    out.set([1, 1, 1, 1], o + 16);
    overlayBillboards.push({ texture, first: firstBillboard, count: 1 });
  }

  // ── Lines: six vertices per segment, expanded toward the camera in the vertex shader ──
  const lines = new Growing(64 * LINE_VERTEX_FLOATS);
  const pushLines = (layer: 'scene' | 'overlay'): { first: number; count: number } => {
    const firstVertex = lines.length / LINE_VERTEX_FLOATS;
    for (const line of frame.lines) {
      if (line.layer !== layer) continue;
      const p = line.points;
      const k = line.intensity ?? 1;
      const color = [srgbToLinear(line.color[0]) * k, srgbToLinear(line.color[1]) * k, srgbToLinear(line.color[2]) * k, line.color[3]];
      for (let i = 0; i + 5 < p.length; i += 3) {
        for (const [tt, side] of [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]] as const) {
          const o = lines.reserve(LINE_VERTEX_FLOATS);
          const out = lines.data;
          out.set([p[i]!, p[i + 1]!, p[i + 2]!, tt, p[i + 3]!, p[i + 4]!, p[i + 5]!, side, line.width, 0, 0, 0], o);
          out.set(color, o + 12);
        }
      }
    }
    return { first: firstVertex, count: lines.length / LINE_VERTEX_FLOATS - firstVertex };
  };
  const sceneLines = pushLines('scene');
  const overlayLines = pushLines('overlay');

  // ── Shadow tiles ────────────────────────────────────────────────────────────
  const sun = first === undefined ? null : frame.sunShadow;
  const sunCascades = sun === null ? [] : sun.cascades.slice(0, MAX_CASCADES);
  const sunCols = sunCascades.length > 1 ? 2 : 1;
  const sunAtlas = sun === null ? 1 : sun.mapSize * sunCols;
  const localTiles = localShadows.filter((s) => tiles.has(frame.lights[s.light]!));
  const localAtlas = localTiles.length === 0 ? 1 : quality.localShadowSize * localCols;
  const tileCount = sunCascades.length + localTiles.reduce((n, s) => n + s.faces.length, 0);
  const casterBlock = new Float32Array(Math.max(1, tileCount) * CASTER_SLOT);
  const shadowTiles: ShadowTile[] = [];
  const tileFor = (atlas: 'sun' | 'local', vp: ArrayLike<number>, index: number, cols: number, size: number, light?: Light3d): void => {
    const slot = shadowTiles.length;
    casterBlock.set(vp as ArrayLike<number>, slot * CASTER_SLOT);
    shadowTiles.push({
      atlas, slot, x: (index % cols) * size, y: Math.floor(index / cols) * size, size,
      casters: meshes.forTile(vp, size, light),
      terrain: terrainSeen(vp),
    });
  };
  if (sun !== null) sunCascades.forEach((c, i) => tileFor('sun', c.viewProjection, i, sunCols, sun.mapSize));
  for (const s of localTiles) s.faces.forEach((m, f) => tileFor('local', m, s.tile + f, localCols, quality.localShadowSize, frame.lights[s.light]));

  // ── Environment lighting ────────────────────────────────────────────────────
  const env = frame.environment;
  const zenith = linearRgb(env.sky.zenith);
  const horizon = linearRgb(env.sky.horizon);
  const sky = skyLighting(zenith, horizon);
  // The reflection cube: the sky's gradient in the ambient light's hue (ibl.ts reflectionSky).
  const reflected = reflectionSky(zenith, horizon, linearRgb(env.ambient));
  const envMips = environmentMips(quality.environmentSize);
  const lighting: FrameLighting = {
    directional,
    count: lights.length,
    sh: sky.sh,
    specularScale: sky.meanLuminance > 1e-6 ? luminance(linearRgb(env.ambient)) / sky.meanLuminance : 0,
    envMips,
  };

  const flags = passFlags(quality, post, env.fog, outlineItems.length > 0, env.sun !== null, sunCascades.length > 0);
  // Frame slots: every view's, then an overlay copy of each view that has one (its own projection).
  const overlays = views.flatMap((view, i) => (view.overlay === undefined || view.overlay === null ? [] : [i]));
  const frames = new Float32Array(Math.max(1, views.length + overlays.length) * FRAME_SLOT);
  const box = env.skybox ?? null;
  const skybox = box !== null && options.ready(box.texture) ? { texture: box.texture, turn: box.rotation / (2 * Math.PI), intensity: box.intensity } : null;
  const packing = {
    width: options.width, height: options.height, flags, sunCols, sunAtlas, localCols, localAtlas, outlineWidth, sharpen: sharpenFor(scale), output, skybox,
  };
  views.forEach((view, i) => packFrame(frame, view, frames, i, lighting, clusters, { ...packing, offscreen: i < offscreenViews.length }));
  const overlaySlots = new Map<number, number>();
  overlays.forEach((i, k) => {
    const slot = views.length + k;
    overlaySlots.set(i, slot);
    frames.copyWithin(slot * FRAME_SLOT, i * FRAME_SLOT, (i + 1) * FRAME_SLOT);
    const overlay = views[i]!.overlay!;
    frames.set(overlay.viewProjection, slot * FRAME_SLOT + offsetOf(FRAME_FIELDS, 'viewProjection'));
    frames.set(overlay.inverseViewProjection, slot * FRAME_SLOT + offsetOf(FRAME_FIELDS, 'inverseViewProjection'));
  });

  const viewPlans: ViewPlan[] = views.map((view, i) => ({
    viewport: view.viewport,
    frameSlot: i,
    target: i < offscreenViews.length ? offscreenTargets[i]!.id : null,
    fog: fogTexels(view),
    camera: view.camera,
    terrain: terrainSeen(view.viewProjection),
    ...meshes.forView(view),
    overlaySlot: overlaySlots.get(i) ?? null,
    mirrored: view.mirrored === true,
    billboards: sceneBillboards,
    lines: sceneLines,
    overlayBillboards,
    overlayLines,
    outlines: outlineItems,
    depthOfField: planDepthOfField(view, quality, flags.wireframe, options.width, options.height),
  }));

  const nature = planNature(frame, views, options.width, options.height);
  const impostors = planImpostors(frame.impostors ?? [], views, options.ready);
  const decals = options.decalLayer === undefined ? null : planDecals(frame.decals ?? [], views, options.decalLayer);
  const groups: ViewGroup[] = [
    ...offscreenTargets.map((target, i) => ({ target, views: [viewPlans[i]!] })),
    ...(screen.length > 0 ? [{ target: null, views: viewPlans.slice(offscreenViews.length) }] : []),
  ];

  return {
    width: options.width,
    height: options.height,
    quality,
    flags,
    frames,
    shadowBlock,
    casters: casterBlock,
    materials,
    instances: instances.done(),
    billboards: billboards.done(),
    lines: lines.done(),
    palette: palette.length === 0 ? new Float32Array(16) : palette.done(),
    lights: packLights(lights, tiles),
    clusters,
    environment: {
      key: environmentKey(reflected.zenith, reflected.horizon, quality.environmentSize)
        + (skybox === null ? nature?.environmentKey ?? '' : `|skybox:${skybox.texture.id}:${skybox.turn.toFixed(4)}:${skybox.intensity}`),
      size: quality.environmentSize, mips: envMips, zenith: reflected.zenith, horizon: reflected.horizon, skybox,
    },
    sunAtlas,
    localAtlas,
    shadowTiles,
    views: viewPlans,
    stats: { ...meshes.stats },
    nature,
    impostors,
    decals,
    groups,
    output,
    occlusion: options.readDepth === true && first !== undefined ? occlusionPlan(viewPlans[offscreenViews.length]!, first) : null,
    vfx: planVfx(frame, options.ready),
  };
}

/** What a backend does for each pass, in the order `visitPasses` calls it. */
export interface PassVisitor {
  environment(environment: EnvironmentPlan): void;
  shadows(tiles: readonly ShadowTile[]): void;
  scene(view: ViewPlan, first: boolean): void;
  ao(view: ViewPlan): void;
  reflections(view: ViewPlan): void;
  resolve(view: ViewPlan): void;
  /** Sky model, aerial perspective, wet/snowy surfaces, water (sky_webgpu.ts / sky_webgl2.ts). */
  nature(view: ViewPlan): void;
  /** Projected decals over the opaque scene (decals.ts). */
  decals(view: ViewPlan): void;
  /** Fog of war laid over the ground. */
  fogOfWar(view: ViewPlan): void;
  /** An offscreen view's finished image into its render target. */
  target(target: OffscreenPlan, view: ViewPlan): void;
  transparent(view: ViewPlan): void;
  volumetric(view: ViewPlan): void;
  godRays(view: ViewPlan): void;
  outlines(view: ViewPlan, first: boolean): void;
  /** Depth of field (dof.ts), for views whose camera has one. */
  depthOfField?(view: ViewPlan): void;
  bloom(levels: number): void;
  final(view: ViewPlan, first: boolean): void;
  overlay(view: ViewPlan): void;
  present(): void;
}

/**
 * The one pass order both backends draw in. Each offscreen target's view is drawn whole
 * (scene to final, no bloom) and copied into its target before the screen's views, so
 * materials showing a feed or a mirror sample this frame's image.
 */
export function visitPasses(plan: FramePlan, visitor: PassVisitor): void {
  const f = plan.flags;
  visitor.environment(plan.environment);
  if (plan.shadowTiles.length > 0) visitor.shadows(plan.shadowTiles);
  for (const group of plan.groups) {
    group.views.forEach((view, i) => {
      visitor.scene(view, i === 0);
      if (f.ao !== 'off') visitor.ao(view);
      if (f.reflections) visitor.reflections(view);
      if (f.resolve) visitor.resolve(view);
      if (plan.nature !== null) visitor.nature(view);
      if ((plan.decals?.views[view.frameSlot]?.count ?? 0) > 0) visitor.decals(view);
      if (view.transparent.length > 0 || view.billboards.length > 0 || view.lines.count > 0 || view.viewmodel.length > 0 || view.viewmodelTransparent.length > 0
        || plan.vfx !== null) {
        visitor.transparent(view);
      }
      if (view.fog !== null) visitor.fogOfWar(view);
      if (f.volumetric) visitor.volumetric(view);
      if (f.godRays) visitor.godRays(view);
      if (view.depthOfField != null) visitor.depthOfField?.(view);
      if (f.outlines) visitor.outlines(view, i === 0);
    });
    if (group.target === null && f.bloomLevels > 0) visitor.bloom(f.bloomLevels);
    group.views.forEach((view, i) => {
      visitor.final(view, i === 0);
      if (view.overlayBillboards.length > 0 || view.overlayLines.count > 0) visitor.overlay(view);
    });
    if (group.target !== null) visitor.target(group.target, group.views[0]!);
  }
  visitor.present();
}
