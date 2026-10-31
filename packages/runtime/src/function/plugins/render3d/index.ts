/**
 * render3d — the 3D renderer. Each frame, in the
 * kernel's 'render' hook, it builds a retained scene description (`Frame3d`, core port
 * `core/ports/render3d.ts`) from the world — every active camera's view, the environment
 * and terrain (services), lights, instanced primitive and model meshes, GPU-skinned
 * meshes with their bone palettes, particles, world bars, text and lines — and hands it to
 * a `RenderSurface3d`: WebGPU or WebGL2 in the browser, a recorder headless. It draws the
 * scene's block world when the voxels service has one (`voxels.ts`).
 *
 * Models are the models plugin's (`function/plugins/models`, present in every game):
 * loaded, posed (animator, joints, IK, ragdolls) and socketed there, and read here through
 * the `model_poses` service; render3d draws them (`model_draw.ts`: looks, palettes, morph
 * targets) and skins them on the GPU.
 *
 * It contributes no components: the rendering components are the visuals plugin's, read
 * by id with the SDK's field names, plus the getters visuals exposes for renderers
 * (`camera.__view__`, `animator.__playback__`, `text_mesh.__spans__`,
 * `world_bar.__bands__`). Its world-level service is `ctx.vfx` (one-shot effects, beams,
 * trails), mounted through `namespace` by the api layer (`api/render3d.ts`).
 *
 * Boot contract: one `render3d(...)` per kernel, installed after the models plugin, given
 * the surface and the project's text files (image references resolve against them;
 * `.vfx.json` effects are read from them).
 */

import { fail } from '../../../core/index.js';
import type { EntityId, ProjectFiles, RenderSurface3d } from '../../../core/index.js';
import { AssetCatalog } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { Render3dEngine } from './engine.js';

export { BAR_SIZE, OUTLINE, WORLD_DRAW } from './draw.js';
export type { DrawStyle } from './draw.js';
export { parseEffect } from './effects.js';
export type { EffectDef } from './effects.js';
export { ModelDraws } from './model_draw.js';
export { MorphedGeometry, morphActive } from './morph.js';
export { DEFAULT_ENVIRONMENT, fromResolved, postOf } from './environment.js';
export { MORPH_FRACTION, NAMED_LAYER_COLORS, RANGE_SCALE, TerrainDraws, terrainMaterials, tileGeometry, UNTEXTURED_LAYER_COLORS } from './terrain.js';
export { boxInPlanes, frustumPlanes, NO_MORPH, selectTiles } from './terrain_cdlod.js';
export { DETAIL_FRACTION, FADE_FRACTION, FOLIAGE_DISTANCE, FoliageDraws, FrameGovernor, KIND_FAR, leanOf, levelsAt, MIN_SCALE, swayMatrix } from './foliage.js';
export { foliageImpostor, foliageLook, LOOK_VARIANTS, NOMINAL_HEIGHT } from './foliage_meshes.js';
export { barkTexture, encodePng, leafSprayTexture, stoneTexture } from './foliage_textures.js';
export { bladeRamp, GRASS_MIN_SCALE, GRASS_REACH, GrassDraws, NEAR_BOOST, PATCH, patchGeometry, VARIANTS, variantFor } from './grass.js';
export { windVisuals } from './wind_streaks.js';
export { Render3dEngine, TRAIL_SECONDS } from './engine.js';
export type { EffectAt3d, LineOptions, PlayOptions3d, Point3 } from './engine.js';
export { blockColor, UNTEXTURED_TRANSPARENT_ALPHA, VoxelDraws } from './voxels.js';
export { colorVisionOf, QUALITY_LADDER, qualityOf } from './quality.js';
export type { QualityLevel } from './quality.js';
export {
  CASTER_REACH, cascadeSplits, chooseLocalShadows, fitCascade, fitCascades, lightReach, lightRotation, localFaces, localNear, pointFaceFov,
  shadowTiles, sliceCorners,
} from './shadow.js';

export interface Render3dOptions {
  readonly surface: RenderSurface3d;
  /** The project's text files: asset references resolve against `list()`; effects are read with `read()`. */
  readonly files: ProjectFiles;
  /**
   * False when the asset files aren't available (data-only playtests): asset references
   * are checked for form and folder only, and images and effects without a file draw and
   * emit nothing. Default true.
   */
  readonly assetFiles?: boolean;
  /** Whether hosted asset URLs (core/remote_assets.ts) are fetched (a browser); default false: they load nothing, like missing files. */
  readonly remoteAssets?: boolean;
  /** Builds `ctx.vfx` over the engine (the api layer supplies the Python-facing one). */
  readonly namespace?: (engine: Render3dEngine) => object;
}

export interface Render3dPlugin extends KernelPlugin {
  /** The engine, once the plugin is installed. */
  readonly engine: Render3dEngine;
  /**
   * Seconds in a clip. Pass the playing entity so a bare clip name resolves against its
   * own model; that needs the plugin installed.
   */
  clipLength(clip: string, entity?: EntityId): number;
}

export function render3d(options: Render3dOptions): Render3dPlugin {
  const assets = new AssetCatalog(options.files, options.assetFiles ?? true, options.remoteAssets ?? false);
  let engine: Render3dEngine | undefined;
  const current = (): Render3dEngine => {
    if (engine === undefined) fail('PP9802', 'render3d is used before its kernel was built');
    return engine;
  };
  const namespace = options.namespace;
  return {
    id: 'render3d',
    get engine() {
      return current();
    },
    clipLength: (clip, entity) => current().clipLength(clip, entity),
    install(kernel: Kernel) {
      if (engine !== undefined) {
        fail('PP9802', 'This render3d plugin is already installed in another kernel', { fix: 'Call render3d(...) once per kernel.' });
      }
      const created = new Render3dEngine(kernel, { surface: options.surface, assets });
      engine = created;
      kernel.observeEntities({
        added: (records) => created.added(records),
        changed: (record) => created.changed(record),
        removed: (records) => created.removed(records),
      });
      kernel.observeScenes({ loading: (_scene, request) => created.sceneLoading(request.seed ?? 0) });
      kernel.addHook('render', () => created.render());
    },
    snapshot: () => current().snapshot(),
    restore: (_kernel, state) => current().restore(state),
    ...(namespace !== undefined && { namespace: { name: 'vfx', create: () => namespace(current()) } }),
  };
}
