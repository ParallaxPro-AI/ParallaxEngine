/**
 * The models plugin's services (`function/plugins/models`, in every game, headless and on
 * servers too: model documents are project text; glTF files when the run has them).
 *
 * The `model_rig` service: what a loaded model offers game code — its document's joints,
 * options, parts and materials, and its sockets posed now. The visuals plugin's Model methods check names through it and the api's
 * `attach(child, socket=...)` places children with it.
 *
 * Model references are written as `Model.model` holds them (a path, `models/<name>` or a
 * bare name). Results follow the model geometry service's convention: undefined while a
 * file is still loading, null when this run has no file for it (data-only runs).
 */

import type { Diagnostic, EntityId, Quat, Vec3 } from '../../core/index.js';
import type { ModelAsset, ModelDocument } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface ModelRig {
  readonly path: string;
  /** The model document (joints, options, sockets…); null for a glTF model. */
  readonly document: ModelDocument | null;
  /** Names `attach(socket=...)` takes: declared sockets first, then parts, bones and (glTF) nodes. */
  readonly sockets: readonly string[];
  /** Part names (glTF: named nodes), for `Model.parts`. */
  readonly parts: readonly string[];
  /** Material names, for `Model.colors`. */
  readonly materials: readonly string[];
  /** The model's own animation clips by name (glTF animations; a model document has none). */
  readonly clips: readonly string[];
}

export interface SocketFrame {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface ModelRigSource {
  rig(model: string): ModelRig | null | undefined;
  /**
   * A socket's frame on an entity's Model, posed now (animator, joints): `local` relative
   * to the entity (Model.offset included), `world` in world space. PP2122 for a socket the
   * model doesn't have.
   */
  socket(entity: EntityId, socket: string, space: 'local' | 'world'): SocketFrame | null | undefined;
  /** The project's authored clips as an Animator names them ("clips/walk_cycle"), sorted. */
  authoredClips?(): readonly string[];
}

export const MODEL_RIG_SERVICE: ServiceKey<ModelRigSource> = serviceKey<ModelRigSource>(
  'model_rig', 'Model joints, options and sockets come from the models plugin, which every runtime installs.',
);

/** An entity's Model this frame: the loaded model and its node matrices (model space: animator, joints, IK). */
export interface PosedModel {
  readonly asset: ModelAsset;
  readonly worlds: Float32Array;
}

/**
 * The `model_poses` service: models as a renderer draws them — loaded by reference, posed
 * per entity once a frame (the animator's playback, the document's joints, IK), with
 * their morph target weights. Loading problems are raised by the models plugin itself.
 */
export interface ModelPoseSource {
  /** The model file a reference names (PP2063 when none), loading it if it isn't yet. */
  resolve(ref: string, where: string): string;
  /** A loaded model; undefined while it loads, after it failed, or when the run has no file. */
  get(path: string): ModelAsset | undefined;
  /** The entity's Model posed this frame (cached until the next); undefined while its file loads (or has none). */
  posed(entity: EntityId): PosedModel | undefined;
  /** Another model's node matrices as the entity's animator would pose it (level-of-detail models). */
  poseAs(asset: ModelAsset, entity: EntityId): Float32Array;
  /** Morph target weights by node of a model on the entity (its node defaults, clips and `set_morph`); null: no targets. */
  morphs(asset: ModelAsset, entity: EntityId): ReadonlyMap<number, Float32Array> | null;
  /** Queue every model the project's data names (prefabs, scenes, animators' clip models). */
  preload(): void;
  /** Resolves when every model requested so far has loaded or failed. */
  whenLoaded(): Promise<void>;
  /** Parts of models not read, since the last call (warnings; errors are raised on the next frame). */
  takeWarnings(): readonly Diagnostic[];
  /** Seconds in a clip; with the playing entity a bare clip name is a clip of its own model. */
  clipLength(clip: string, entity?: EntityId): number;
  /**
   * Animation level of detail (models/animation_lod.ts): the eyes the renderer draws from and
   * its quality's LOD scale; far animated models are then re-posed every 2nd or 4th frame.
   * Never called (headless runs, servers): every pose is exact.
   */
  animationLod?(eyes: readonly (readonly [number, number, number])[], lodScale: number): void;
}

export const MODEL_POSE_SERVICE: ServiceKey<ModelPoseSource> = serviceKey<ModelPoseSource>(
  'model_poses', 'Models come from the models plugin, which every runtime installs (createRuntime).',
);
