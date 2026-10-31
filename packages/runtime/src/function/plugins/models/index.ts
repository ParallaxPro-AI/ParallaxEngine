/**
 * models — model data in a running game, with or without a renderer (headless playtests,
 * dedicated servers, the browser alike). It loads every model the game names (glTF files
 * and model documents, resource/models; through the jobs service when boot provides one),
 * plays animators' clips into poses (layers, masks, additive, retargeting, root motion,
 * IK, morph target weights, ragdoll bones blended over the animation), applies model
 * documents' joints, and keeps socketed entities on their sockets each frame.
 *
 * Services it provides (function/services/):
 *   model_poses      the posed models a renderer draws (`MODEL_POSE_SERVICE`)
 *   model_rig        joints, options, parts and posed sockets for game code
 *   model_geometry   models' triangles for mesh/convex colliders and nav
 *   animation_clips  clip lengths, markers and root tracks for the visuals animators
 *   skeleton         a skinned model's animated bones (model space) for ragdolls
 *
 * Data-only runs (no asset files) and runs without binary files (servers): a model with no
 * file draws nothing, has no collision shape, and its clips have no frames.
 *
 * Boot contract: one `models(...)` per kernel, installed before the renderer; call
 * `preload()` and await `whenLoaded()` before the first frame.
 */

import { fail, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { BinaryFiles, Diagnostic, EntityId, ProjectFiles } from '../../../core/index.js';
import { AssetCatalog } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';
import type { EntityRecord, Kernel, KernelPlugin } from '../../kernel/index.js';
import {
  ANIMATION_CLIPS_SERVICE, JOBS_SERVICE, MODEL_GEOMETRY_SERVICE, MODEL_POSE_SERVICE, MODEL_RIG_SERVICE, RENDER_POSE_SERVICE, SKELETON_SERVICE,
} from '../../services/index.js';
import type { ModelPoseSource, SkeletonBone, SkeletonPose } from '../../services/index.js';
import { animatorClipModels, ClipLibrary, clipService } from './animation_clips.js';
import { Poses, rotationOf } from './animation_pose.js';
import { ANIMATOR, LOD, MODEL, modelPath, nameOf, WorldMatrices } from './fields.js';
import { ModelLibrary } from './library.js';
import { modelRigService, ModelPoser } from './poser.js';

export { animatorClipModels, authoredClipPath, ClipLibrary, clipService, isAuthoredClip, rootBoneOf } from './animation_clips.js';
export { solveAim, solveTwoBone } from './animation_ik.js';
export type { LimbNodes } from './animation_ik.js';
export { sampleMorphChannel } from './animation_morph.js';
export { applyRagdoll, modelToWorld, orientEnd, Poses, rotationOf } from './animation_pose.js';
export type { PlaybackView } from './animation_pose.js';
export { ease, kneeBend, readClipFile, RIGS } from './animation_procedural.js';
export type { AuthoredClip, ClipProblem, RigName } from './animation_procedural.js';
export { canonicalBone, findBone, sampleRetargeted } from './animation_retarget.js';
export { MODEL, SOCKET } from './fields.js';
export { modelGeometry } from './geometry.js';
export { GLTF_BUILD, MODEL_PARSE, ModelLibrary } from './library.js';
export type { GltfBuildInput } from './library.js';
export { frameOf, modelRigService, ModelPoser } from './poser.js';

export interface ModelsOptions {
  /** The project's text files: model references resolve against `list()`; documents and clip files are read with `read()`. */
  readonly files: ProjectFiles;
  /** Binary files (glTF models and buffers); absent: none in this run (a server), so glTF models are absent. */
  readonly binary?: BinaryFiles;
  /** False when the asset files aren't available (data-only playtests). Default true. */
  readonly assetFiles?: boolean;
  /** Whether hosted asset URLs (core/remote_assets.ts) are fetched (a browser); default false: they load nothing, like missing files. */
  readonly remoteAssets?: boolean;
}

export interface ModelsPlugin extends KernelPlugin {
  /** The `model_poses` service (also what boot preloads through). Usable once installed. */
  readonly source: ModelPoseSource;
}

export function models(options: ModelsOptions): ModelsPlugin {
  const assets = new AssetCatalog(options.files, options.assetFiles ?? true, options.remoteAssets ?? false);
  let installed: Kernel | undefined;
  const library = new ModelLibrary(options.binary, assets, () => installed?.tryService(JOBS_SERVICE));
  const clips = new ClipLibrary(library, assets);
  let source: ModelPoseSource | undefined;
  return {
    id: 'models',
    get source(): ModelPoseSource {
      if (source === undefined) fail('PP9802', 'The models plugin is used before its kernel was built');
      return source;
    },
    install(kernel: Kernel) {
      if (installed !== undefined) fail('PP9802', 'This models plugin is already installed in another kernel', { fix: 'Call models(...) once per kernel.' });
      installed = kernel;
      const world = kernel.world;
      const poses = new Poses(clips, kernel);
      const placed = new WorldMatrices(world, () => kernel.tryService(RENDER_POSE_SERVICE));
      const poser = new ModelPoser(world, library, poses, placed, () => kernel.time.now);
      const record = (entity: EntityId, what: string) => {
        const r = world.peek(entity);
        if (r === undefined) fail('PP3002', `${what} was asked of an entity that no longer exists`);
        return r;
      };
      let warnings: Diagnostic[] = [];
      const take = (): void => {
        for (const problem of library.takeProblems()) {
          if (problem.severity === 'error') throw new ParallaxError(problem);
          warnings.push(problem);
        }
      };
      source = {
        resolve: (ref, where) => library.resolve(ref, where),
        get: (path) => library.get(path),
        posed: (entity) => poser.posed(record(entity, 'A model pose')),
        poseAs: (asset: ModelAsset, entity) => poser.poseAs(asset, record(entity, 'A model pose')),
        morphs: (asset: ModelAsset, entity) => {
          const r = record(entity, 'Morph weights');
          return poses.morphs(asset, r.components.get(ANIMATOR), nameOf(r));
        },
        preload: () => {
          const visit = (components: Readonly<Record<string, Readonly<Record<string, unknown>>>>, where: string): void => {
            const model = components[MODEL]?.['model'];
            if (typeof model === 'string') library.resolve(model, `${where} model.model`);
            const animator = components[ANIMATOR];
            if (animator !== undefined) for (const ref of animatorClipModels(animator)) library.resolve(ref, `${where} animator`);
            for (const ref of lodModels(components[LOD])) library.resolve(ref, `${where} lod`);
          };
          for (const prefab of kernel.project.prefabs.values()) {
            visit(prefab.components, `prefab "${prefab.id}"`);
            prefab.children.forEach((child, i) => visit(child.components, `prefab "${prefab.id}" child ${i}`));
          }
          for (const scene of kernel.project.scenes.values()) {
            scene.entities.forEach((placed, i) => visit(placed.components, `scene "${scene.id}" entity ${i}`));
          }
        },
        whenLoaded: () => library.whenLoaded(),
        animationLod: (eyes, lodScale) => poser.hold.setEyes(eyes, lodScale),
        takeWarnings: () => {
          take();
          const out = warnings;
          warnings = [];
          return out;
        },
        clipLength: (clip, entity) => {
          if (entity === undefined) return clips.length(clip);
          const r = world.peek(entity);
          if (r === undefined) fail('PP3002', `The length of clip "${clip}" was asked for an entity that no longer exists`);
          const model = r.components.get(MODEL);
          if (model === undefined) {
            if (clip.includes('#') || clip.startsWith('clips/') || clip.startsWith('assets/clips/')) return clips.length(clip);
            return fail('PP3805', `${nameOf(r)} plays the clip "${clip}" but has no Model to take it from`, {
              fix: 'Give the entity a model component, or name the model: "models/<model>#<clip>".',
            });
          }
          return clips.length(clip, modelPath(library, r, model));
        },
      };
      const request = (r: EntityRecord): void => {
        const model = r.components.get(MODEL);
        if (model !== undefined) modelPath(library, r, model);
        for (const ref of lodModels(r.components.get(LOD))) library.resolve(ref, `${nameOf(r)} lod`);
      };
      kernel.observeEntities({ added: (records) => records.forEach(request), changed: request });
      kernel.provide(MODEL_POSE_SERVICE, source);
      kernel.provide(MODEL_GEOMETRY_SERVICE, { geometry: (model) => library.geometry(model) });
      let authored: readonly string[] | undefined;
      const authoredClips = (): readonly string[] => (authored ??= options.files.list()
        .flatMap((path) => { const m = /^assets\/clips\/([^/]+)\.clip\.json$/.exec(path); return m === null ? [] : [`clips/${m[1]}`]; }).sort());
      kernel.provide(MODEL_RIG_SERVICE, modelRigService(world, library, () => poser, authoredClips));
      kernel.provide(ANIMATION_CLIPS_SERVICE, clipService(kernel, library, clips));
      kernel.provide(SKELETON_SERVICE, {
        pose: (entity): SkeletonPose | null | undefined => {
          const r = record(entity, 'A skeleton');
          const fields = r.components.get(MODEL);
          if (fields === undefined) return null;
          const asset = library.get(modelPath(library, r, fields));
          if (asset === undefined) return library.rig(modelPath(library, r, fields)) === null ? null : undefined;
          if (asset.skins.length === 0) return null;
          const posed = poser.posed(r);
          return posed === undefined ? undefined : { bones: skeletonBones(asset, posed.worlds) };
        },
      });
      // Every frame, before anything is drawn: last frame's poses go, load failures are
      // raised, and socketed entities move onto their (newly posed) sockets.
      kernel.addHook('render', () => {
        take();
        poser.frame();
        poser.followSockets();
      });
    },
  };
}

/** The models a `lod` component's levels name (they load with the entity's own). */
function lodModels(lod: Readonly<Record<string, unknown>> | undefined): string[] {
  const levels = lod?.['levels'];
  if (!Array.isArray(levels)) return [];
  return levels.flatMap((level: { model?: unknown }) => {
    const model = level?.model;
    if (typeof model === 'string') return [model];
    const path = (model as { path?: unknown } | null | undefined)?.path;
    return typeof path === 'string' ? [path] : [];
  });
}

/** The first skin's joints as skeleton bones (parents first), from node matrices in model space. */
function skeletonBones(asset: ModelAsset, worlds: Float32Array): SkeletonBone[] {
  const joints = asset.skins[0]!.joints;
  const set = new Set(joints);
  const order = asset.order.filter((n) => set.has(n));
  const index = new Map(order.map((n, i) => [n, i]));
  return order.map((n) => {
    let parent = asset.nodes[n]!.parent;
    while (parent !== -1 && !set.has(parent)) parent = asset.nodes[parent]!.parent;
    const m = worlds.subarray(n * 16, n * 16 + 16);
    const r = rotationOf(m);
    return {
      name: asset.nodes[n]!.name,
      parent: parent === -1 ? -1 : index.get(parent)!,
      position: new Vec3(m[12]!, m[13]!, m[14]!),
      rotation: new Quat(r[0], r[1], r[2], r[3]),
    };
  });
}
