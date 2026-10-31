/**
 * render2d — the 2D renderer. Each frame, in the
 * kernel's 'render' hook, it draws every visible entity's shape, sprite, text and world bar
 * plus particles and one-shot effects through the active camera, as one `Frame2d` handed
 * to a `RenderSurface2d` (core port; Canvas2D in the browser, a recorder headless).
 *
 * It contributes no components: the rendering components (sprite, shape, text_mesh,
 * particles, camera, world_bar) are the visuals plugin's, read here by id with the SDK's
 * field names. Its world-level service is `ctx.vfx` (one-shot effects, beams, trails),
 * mounted through `namespace` by the api layer (`api/render2d.ts`).
 *
 * Boot contract: one `render2d(...)` per kernel, given the surface, the project's files
 * (asset references resolve against them; `.vfx.json` effects are read from them) and,
 * when the visuals plugin runs the camera rigs, its `rig`.
 */

import { fail } from '../../../core/index.js';
import type { ProjectFiles, RenderSurface2d } from '../../../core/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { AssetCatalog } from './assets.js';
import { Render2dEngine } from './engine.js';
import type { CameraRig2d } from './view.js';

export { AssetCatalog as AssetCatalog2d, assetHandle } from './assets.js';
export { BAR_SIZE, SHAPE, SHAPES_2D, SPRITE, SPRITE_ANIMATION, TEXT_MESH, TILEMAP, WORLD_BAR } from './draw.js';
export { parseEffect } from './effects.js';
export type { EffectDef } from './effects.js';
export { PARTICLES, Render2dEngine, TRAIL_SECONDS } from './engine.js';
export type { BeamOptions, EffectAt, PlayOptions, TrailOptions } from './engine.js';
export { DEFAULT_AMBIENT_2D, LIGHT, lightAt, lightFalloff, lighting2d } from './lighting.js';
export { parseMarkup } from './text.js';
export { CAMERA, GRID, firstCameraRig } from './view.js';
export type { CameraRig2d } from './view.js';

export interface Render2dOptions {
  readonly surface: RenderSurface2d;
  /** The project's files: images and effects are looked up under `assets/`. */
  readonly files: ProjectFiles;
  /**
   * Whether the asset files are available. False for data-only runs (playtests over a
   * project whose art doesn't exist yet): references are checked for form and folder
   * only, images without a file load by handle, and effects without a file emit nothing.
   */
  readonly assetFiles: boolean;
  /** Whether hosted asset URLs (core/remote_assets.ts) are fetched (a browser); default false: they load nothing, like missing files. */
  readonly remoteAssets?: boolean;
  /** The camera rig (the visuals plugin's): which camera is active, and its shake offset. Default: the first camera, still. */
  readonly rig?: (kernel: Kernel) => CameraRig2d;
  /** Builds `ctx.vfx` over the engine (the api layer supplies the Python-facing one). */
  readonly namespace?: (engine: Render2dEngine) => object;
}

export interface Render2dPlugin extends KernelPlugin {
  /** The engine, once the plugin is installed. */
  readonly engine: Render2dEngine;
}

export function render2d(options: Render2dOptions): Render2dPlugin {
  const assets = new AssetCatalog(options.files, options.assetFiles, options.remoteAssets ?? false);
  let engine: Render2dEngine | undefined;
  const current = (): Render2dEngine => {
    if (engine === undefined) fail('PP9601', 'render2d is used before its kernel was built');
    return engine;
  };
  const namespace = options.namespace;
  return {
    id: 'render2d',
    get engine() {
      return current();
    },
    install(kernel) {
      if (engine !== undefined) {
        fail('PP9601', 'This render2d plugin is already installed in another kernel', { fix: 'Call render2d(...) once per kernel.' });
      }
      const created = new Render2dEngine(kernel, {
        surface: options.surface, assets, ...(options.rig !== undefined && { rig: options.rig }),
      });
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
