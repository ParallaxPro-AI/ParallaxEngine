/**
 * Every clip an animator can name, and the `animation_clips` service built on them:
 *
 *   "run"                           a clip of the entity's own model
 *   "models/anims#run"              a clip of another model (retargeted)
 *   "clips/wave"                    an authored clip, assets/clips/wave.clip.json (retargeted)
 *
 * Models and authored clips are named by handle, as every asset is ("assets/…" paths are
 * PP2063 naming the handle).
 *
 * Authored clips are text: they are read from the project files in every run, data-only
 * playtests included. Model clips need the model's binary file.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import type { AnimationClipSource, ClipInfo, RootSample } from '../../services/index.js';
import { clipTime, nodeMatrices, requireHandleForm, restPose, sampleClip } from '../../../resource/index.js';
import { qyaw, worldRotations } from '../../../resource/index.js';
import { readClipFile, RIGS } from './animation_procedural.js';
import type { AuthoredClip } from './animation_procedural.js';
import { canonicalBone, findBone, sampleRetargeted } from './animation_retarget.js';
import type { AssetCatalog } from '../../../resource/index.js';
import { MODEL, modelPath, nameOf } from './fields.js';
import type { Clip, ModelAsset } from '../../../resource/index.js';
import type { ModelLibrary } from './library.js';

/** A clip ready to sample onto `target`: from the target itself, another model, or an authored rig. */
export interface PlayableClip {
  /** The model the clip's channels address. */
  readonly source: ModelAsset;
  readonly clip: Clip;
  readonly authored: AuthoredClip | null;
}

export function isAuthoredClip(ref: string): boolean {
  return ref.startsWith('clips/') || ref.startsWith('assets/clips/');
}

/**
 * "clips/wave" → the file path, `assets/clips/wave.clip.json`. The handle is the one
 * spelling: the file path written out is PP2063 naming it.
 */
export function authoredClipPath(ref: string): string {
  requireHandleForm(ref, 'clips', `The clip "${ref}"`);
  return `assets/${ref}.clip.json`;
}

export class ClipLibrary {
  readonly #models: ModelLibrary;
  readonly #assets: AssetCatalog;
  readonly #authored = new Map<string, AuthoredClip>();

  constructor(models: ModelLibrary, assets: AssetCatalog) {
    this.#models = models;
    this.#assets = assets;
  }

  /** An authored clip, read and compiled once (PP2063 when there is no file, PP378x when it is wrong). */
  authored(ref: string, where: string): AuthoredClip {
    const path = authoredClipPath(ref);
    const known = this.#authored.get(path);
    if (known !== undefined) return known;
    if (!/^assets\/clips\/[^/]+\.clip\.json$/.test(path) || !this.#assets.has(path)) {
      fail('PP2063', `${where} names the clip "${ref}", but there is no ${path}`, { fix: 'Add the clip file to assets/clips/, or check its name.' });
    }
    const { clip, problems } = readClipFile(path, this.#assets.read(path));
    if (clip === undefined) {
      const p = problems[0]!;
      fail(p.code, `${p.message}${p.pointer === '' ? '' : ` (at ${p.pointer})`}`, { path, ...(p.fix !== undefined && { fix: p.fix }) });
    }
    this.#authored.set(path, clip);
    return clip;
  }

  /** The clip `ref` names, played by a model `own`; undefined while its model loads. */
  playable(ref: string, own: ModelAsset, where: string): PlayableClip | undefined {
    if (isAuthoredClip(ref)) {
      const authored = this.authored(ref, where);
      return { source: RIGS[authored.rig], clip: authored.clip, authored };
    }
    const resolved = this.#models.clip(ref, own, where);
    return resolved === undefined ? undefined : { source: resolved.model, clip: resolved.clip, authored: null };
  }

  /** Clip facts for a clip played by the model at `ownPath` (a resolved model path; undefined: no model). */
  info(ref: string, ownPath: string | undefined, where: string): ClipInfo | null | undefined {
    if (isAuthoredClip(ref)) {
      const a = this.authored(ref, where);
      return { duration: a.duration, loop: a.loop, markers: a.markers };
    }
    const hash = ref.lastIndexOf('#');
    const path = hash === -1 ? ownPath : this.#models.resolve(ref.slice(0, hash), where);
    if (path === undefined) {
      return fail('PP3805', `${where} plays the clip "${ref}" but has no Model to take it from`, {
        fix: 'Give the entity a model component, or name the model: "models/<model>#<clip>".',
      });
    }
    const model = this.#models.get(path);
    if (model === undefined) return this.absent(path) ? null : undefined;
    const clip = this.#models.clip(ref, model, where)!.clip;
    return { duration: clip.duration, loop: null, markers: [] };
  }

  /** A data-only run has no file for this model: it never loads, and its clips have no frames. */
  absent(path: string): boolean {
    return !this.#assets.has(path);
  }

  /** Seconds in a clip (Render3dPlugin.clipLength): an authored clip, or ModelLibrary's rules. */
  length(ref: string, ownPath?: string): number {
    return isAuthoredClip(ref) ? this.authored(ref, `clip "${ref}"`).duration : this.#models.clipLength(ref, ownPath);
  }
}

/** The default root bone: Hips / pelvis by name, else the first skin's first joint. */
export function rootBoneOf(model: ModelAsset, name: string | null, where: string): number {
  if (name !== null) {
    const node = findBone(model, name);
    if (node < 0) {
      fail('PP3780', `${where}: ${model.path} has no bone "${name}" (root_bone)`, {
        path: model.path, fix: `Its bones: ${model.nodes.map((n) => n.name).filter((n) => n !== '').slice(0, 40).join(', ')}.`,
      });
    }
    return node;
  }
  const hips = model.nodes.findIndex((n) => n.name !== '' && canonicalBone(n.name) === 'hips');
  if (hips >= 0) return hips;
  return model.skins[0]?.joints[0] ?? -1;
}

/** Where `node` sits in model space with `clip` posed at `time` (authored and foreign clips retargeted). */
function rootAt(model: ModelAsset, playable: PlayableClip, time: number, node: number): RootSample {
  const pose = restPose(model);
  const t = clipTime(playable.clip, time, false);
  if (playable.source === model) sampleClip(playable.clip, t, pose, null);
  else sampleRetargeted(model, playable.source, playable.clip, t, pose);
  const worlds = nodeMatrices(model, pose);
  return { x: worlds[node * 16 + 12]!, y: worlds[node * 16 + 13]!, z: worlds[node * 16 + 14]!, yaw: qyaw(worldRotations(model, pose)[node]!) };
}

/** The `animation_clips` service over a kernel's entities and the libraries render3d loads. */
export function clipService(kernel: Kernel, models: ModelLibrary, clips: ClipLibrary): AnimationClipSource {
  const ownModel = (entity: EntityId): { path: string | undefined; where: string } => {
    const record = kernel.world.peek(entity);
    if (record === undefined) fail('PP3002', 'Clip facts were asked for an entity that no longer exists');
    const fields = record.components.get(MODEL);
    const where = `${nameOf(record)} animator`;
    return { path: fields === undefined ? undefined : modelPath(models, record, fields), where };
  };
  return {
    clip(entity, ref) {
      const { path, where } = ownModel(entity);
      return clips.info(ref, path, where);
    },
    root(entity, ref, time, rootBone) {
      const { path, where } = ownModel(entity);
      if (path === undefined) return null;
      const model = models.get(path);
      if (model === undefined) return clips.absent(path) ? null : undefined;
      const node = rootBoneOf(model, rootBone, where);
      if (node < 0) return null;
      const playable = clips.playable(ref, model, where);
      if (playable === undefined) return undefined;
      return rootAt(model, playable, time, node);
    },
  };
}

/**
 * The other models an animator's data plays clips from ("models/anims#run"),
 * for preloading: `default_clip`, every `"clip"` in its layers, and its `events` keys.
 */
export function animatorClipModels(animator: Readonly<Record<string, unknown>>): string[] {
  const refs: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.includes('#') && !isAuthoredClip(value)) refs.push(value.slice(0, value.lastIndexOf('#')));
  };
  add(animator['default_clip']);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'clip') add(inner);
        else walk(inner);
      }
    }
  };
  walk(animator['layers']);
  const events = animator['events'];
  if (typeof events === 'object' && events !== null) Object.keys(events).forEach(add);
  return [...new Set(refs)];
}
