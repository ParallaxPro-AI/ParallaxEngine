/**
 * Model assets by path, parsed once and shared by every entity that shows them: glTF
 * files load asynchronously (binary files the platform fetches); model documents
 * (`<name>.model.json`, resource/models) are project text. An entity whose model is still
 * loading draws nothing that frame; boot awaits `whenLoaded()` (after `preload`) so a
 * scene's models are ready before its first frame. A model that fails to load raises its
 * diagnostic on the next frame.
 *
 * With the jobs service (boot provides it: workers in a browser) the heavy part runs off
 * the main thread: a glTF's accessors, skins and clips are built by the `gltf.build` job,
 * a document is parsed by `model.parse`. Both are the same pure functions the inline path
 * calls, so the result is identical. A document asked for before its job is back (game
 * code naming a model mid-frame) is parsed inline at that moment, so documents stay
 * synchronous to game code.
 */

import { closestMatch, diagnostic, fail, isRemoteAsset, ParallaxError } from '../../../core/index.js';
import type { BinaryFiles, Diagnostic } from '../../../core/index.js';
import { jobKey } from '../../../core/index.js';
import type { JobKey, JobRunner } from '../../../core/index.js';
import { BUILTIN_MODELS, BUILTIN_PREFIX, buildModel, MODEL_DOCUMENT, parseModelDocument } from '../../../resource/index.js';
import type { GltfJson, ParsedModel } from '../../../resource/index.js';
import type { ModelGeometry, ModelRig } from '../../services/index.js';
import type { AssetCatalog } from '../../../resource/index.js';
import { splitClip } from '../../../resource/index.js';
import { buildCodeModel } from '../../../resource/index.js';
import { ModelPoser } from './poser.js';
import { modelGeometry } from './geometry.js';
import { loadModel } from '../../../resource/index.js';
import type { Clip, ModelAsset } from '../../../resource/index.js';

/** A model document's text → its parse (the same `parseModelDocument`, off the main thread). */
export const MODEL_PARSE: JobKey<{ readonly path: string; readonly text: string }, ParsedModel> = jobKey('model.parse');

export interface GltfBuildInput {
  readonly path: string;
  readonly json: GltfJson;
  readonly buffers: readonly Uint8Array[];
}
/** A glTF's JSON and buffers → its `ModelAsset` (the same `buildModel`, off the main thread). */
export const GLTF_BUILD: JobKey<GltfBuildInput, ModelAsset> = jobKey('gltf.build');

/** Binary files for a run that has none (a server): never read, since glTF models are absent there. */
const NO_FILES: BinaryFiles = { read: (path) => Promise.reject(new Error(`no binary files in this run (${path})`)) };

type Slot =
  | { readonly state: 'loading'; readonly promise: Promise<void> }
  /** A model document whose parse job is out: `get` parses it inline if asked first. */
  | { readonly state: 'parsing'; readonly promise: Promise<void> }
  | { readonly state: 'ready'; readonly model: ModelAsset }
  | { readonly state: 'failed'; readonly problem: Diagnostic }
  /** No file in a data-only run: never loaded, draws nothing. */
  | { readonly state: 'absent' };

export interface ResolvedClip {
  readonly model: ModelAsset;
  readonly clip: Clip;
}

export class ModelLibrary {
  readonly #files: BinaryFiles;
  readonly #assets: AssetCatalog;
  readonly #slots = new Map<string, Slot>();
  readonly #geometry = new WeakMap<ModelAsset, ModelGeometry>();
  readonly #rigs = new WeakMap<ModelAsset, ModelRig>();
  readonly #jobs: () => JobRunner | undefined;
  #problems: Diagnostic[] = [];

  /** `files` absent: no binary files in this run (a server), so glTF models are absent, as in a data-only run. */
  constructor(files: BinaryFiles | undefined, assets: AssetCatalog, jobs: () => JobRunner | undefined = () => undefined) {
    this.#files = files ?? NO_FILES;
    this.#assets = assets;
    this.#jobs = jobs;
    this.#binary = files !== undefined;
  }

  readonly #binary: boolean;

  /** A load that threw: its diagnostic (or PP3804), raised on the next frame. */
  #fail(path: string, error: unknown): void {
    const problem = error instanceof ParallaxError
      ? error.diagnostic
      : diagnostic('PP3804', `The model ${path} could not be read (${String((error as Error)?.message ?? error)})`, {
        path, fix: 'Check that the file is deployed with the game.',
      });
    this.#slots.set(path, { state: 'failed', problem });
    this.#problems.push(problem);
  }

  /** A model document parsed and built now (inline), into its slot. */
  #document(path: string, parsed: ParsedModel): void {
    const problem = parsed.diagnostics.find((d) => d.severity === 'error');
    this.#problems.push(...parsed.diagnostics.filter((d) => d.severity !== 'error'));
    if (parsed.document === undefined || problem !== undefined) {
      this.#slots.set(path, { state: 'failed', problem: problem! });
      this.#problems.push(problem!);
    } else {
      this.#slots.set(path, { state: 'ready', model: buildCodeModel(parsed.document) });
    }
  }

  /**
   * The model file a reference names (PP2063 when none), loading it if it isn't yet. A
   * built-in model ("builtin:fp_arms", resource/models/procedural_arms.ts) is its own path:
   * generated in code, present in every run.
   */
  resolve(ref: string, where: string): string {
    if (ref.startsWith(BUILTIN_PREFIX)) {
      if (!(ref in BUILTIN_MODELS)) {
        fail('PP2063', `${where} names the built-in model "${ref}", which doesn't exist`, { fix: `Built-in models: ${Object.keys(BUILTIN_MODELS).join(', ')}.` });
      }
      this.request(ref);
      return ref;
    }
    const path = this.#assets.resolve(ref, 'models', where);
    this.request(path);
    return path;
  }

  request(path: string): void {
    if (this.#slots.has(path)) return;
    const builtin = BUILTIN_MODELS[path];
    if (builtin !== undefined) {
      this.#document(path, parseModelDocument(path, JSON.stringify(builtin())));
      return;
    }
    // A data-only run (asset files unavailable) has no file to read: the model draws nothing.
    const document = MODEL_DOCUMENT.test(path);
    const remote = isRemoteAsset(path);
    if (!this.#assets.loadable(path) || ((remote || !document) && !this.#binary)) {
      this.#slots.set(path, { state: 'absent' });
      return;
    }
    const jobs = this.#jobs();
    if (document && remote) {
      // A hosted model document is fetched like a glTF, then parsed as a project document is.
      const promise = this.#files.read(path).then(
        (bytes) => this.#document(path, parseModelDocument(path, new TextDecoder().decode(bytes))),
        (error: unknown) => this.#fail(path, error),
      );
      this.#slots.set(path, { state: 'loading', promise });
      return;
    }
    if (document) {
      const text = this.#assets.read(path);
      if (jobs === undefined) {
        this.#document(path, parseModelDocument(path, text));
        return;
      }
      const promise = jobs.run(MODEL_PARSE, { path, text }).then(
        (parsed) => {
          if (this.#slots.get(path)?.state === 'parsing') this.#document(path, parsed);
        },
        (error: unknown) => {
          if (this.#slots.get(path)?.state === 'parsing') this.#fail(path, error);
        },
      );
      this.#slots.set(path, { state: 'parsing', promise });
      return;
    }
    const build = jobs === undefined
      ? buildModel
      : (p: string, json: GltfJson, buffers: readonly Uint8Array[]): Promise<ModelAsset> => jobs.run(GLTF_BUILD, { path: p, json, buffers });
    const promise = loadModel(path, this.#files, build).then(
      (model) => {
        this.#slots.set(path, { state: 'ready', model });
        this.#problems.push(...model.warnings);
      },
      (error: unknown) => this.#fail(path, error),
    );
    this.#slots.set(path, { state: 'loading', promise });
  }

  /** The loaded model, or undefined while it loads (or after it failed: see `takeProblems`). */
  get(path: string): ModelAsset | undefined {
    let slot = this.#slots.get(path);
    if (slot?.state === 'parsing') {
      this.#document(path, parseModelDocument(path, this.#assets.read(path)));
      slot = this.#slots.get(path);
    }
    return slot?.state === 'ready' ? slot.model : undefined;
  }

  /**
   * The model geometry service (function/services/physics3d.ts): the triangles of the
   * model a reference names, loading it if it isn't yet. Undefined while it loads (or
   * after it failed: the next frame raises that); null when the run has no file for it
   * (data-only).
   */
  geometry(ref: string): ModelGeometry | null | undefined {
    const path = this.resolve(ref, `model "${ref}"`);
    const model = this.get(path);
    if (model === undefined) return this.#slots.get(path)!.state === 'absent' ? null : undefined;
    let geometry = this.#geometry.get(model);
    if (geometry === undefined) {
      geometry = modelGeometry(model);
      this.#geometry.set(model, geometry);
    }
    return geometry;
  }

  /**
   * The model rig service (function/services/models.ts): what the model a reference names
   * offers game code. Undefined while it loads (or after it failed); null when the run has
   * no file for it (data-only).
   */
  rig(ref: string): ModelRig | null | undefined {
    const path = this.resolve(ref, `model "${ref}"`);
    const model = this.get(path);
    if (model === undefined) return this.#slots.get(path)!.state === 'absent' ? null : undefined;
    let rig = this.#rigs.get(model);
    if (rig === undefined) {
      rig = ModelPoser.rigOf(model);
      this.#rigs.set(model, rig);
    }
    return rig;
  }

  /** Resolves when every model requested so far has loaded or failed. */
  async whenLoaded(): Promise<void> {
    for (;;) {
      const pending = [...this.#slots.values()].flatMap((s) => (s.state === 'loading' || s.state === 'parsing' ? [s.promise] : []));
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** Load failures (errors) and unread parts (warnings) since the last call. */
  takeProblems(): readonly Diagnostic[] {
    const problems = this.#problems;
    this.#problems = [];
    return problems;
  }

  /**
   * The clip a reference names. `own` is the entity's model (for bare names). Returns
   * undefined while the clip's model is loading.
   */
  clip(ref: string, own: ModelAsset, where: string): ResolvedClip | undefined {
    const { model: modelRef, clip: name } = splitClip(ref);
    const model = modelRef === null ? own : this.get(this.resolve(modelRef, where));
    if (model === undefined) return undefined;
    const clip = model.clips.get(name);
    if (clip === undefined) {
      const known = [...model.clips.keys()];
      const guess = closestMatch(name, known);
      fail('PP3805', `${where} plays the clip "${name}", which ${model.path} doesn't have`, {
        path: model.path,
        fix: guess !== undefined ? `Did you mean "${guess}"?` : known.length === 0 ? `${model.path} has no animations.` : `Its clips: ${known.join(', ')}.`,
      });
    }
    return { model, clip };
  }

  /**
   * Seconds in a clip (visuals' `clipLength`, for `play_once`). A `model#clip` reference
   * is exact. A bare name is a clip of `own`, the playing entity's model (its resolved
   * path); without one (no entity given) it must mean the same length in every loaded
   * model that has it.
   */
  clipLength(ref: string, own?: string): number {
    const { model: modelRef, clip: name } = splitClip(ref);
    if (modelRef !== null) return this.#length(this.resolve(modelRef, `clip "${ref}"`), name, ref);
    if (own !== undefined) return this.#length(own, name, ref);
    const lengths = new Set<number>();
    const owners: string[] = [];
    for (const [path, slot] of this.#slots) {
      if (slot.state !== 'ready') continue;
      const clip = slot.model.clips.get(name);
      if (clip !== undefined) {
        lengths.add(clip.duration);
        owners.push(path);
      }
    }
    // Data-only runs: a clip of a model that isn't in this run has no frames (see #length).
    if (lengths.size === 0 && [...this.#slots.values()].some((slot) => slot.state === 'absent')) return 0;
    if (lengths.size === 0) {
      return fail('PP3805', `No loaded model has a clip "${name}"`, { fix: 'Check the clip name, or write it as "models/<model>#<clip>".' });
    }
    if (lengths.size > 1) {
      return fail('PP3806', `The clip "${name}" has different lengths in ${owners.join(', ')}`, {
        fix: `Name the model: "${owners[0]}#${name}".`,
      });
    }
    return [...lengths][0]!;
  }

  #length(path: string, name: string, ref: string): number {
    this.request(path);
    const model = this.get(path);
    // Data-only runs (no asset files): the model draws nothing, has no collision shape, and
    // its clips have no frames — a play_once finishes on the next frame. With asset files a
    // missing model is PP2063 when it is first named.
    if (model === undefined && this.#slots.get(path)?.state === 'absent') return 0;
    if (model === undefined) {
      return fail('PP3807', `The clip "${ref}" is needed before its model ${path} has loaded`, {
        fix: 'Boot awaits render3d\'s whenLoaded() before starting; a model named only in code must be preloaded (preloadModels).',
      });
    }
    const clip = model.clips.get(name);
    if (clip === undefined) {
      const known = [...model.clips.keys()];
      const guess = closestMatch(name, known);
      fail('PP3805', `${path} has no clip "${name}"`, {
        path, fix: guess !== undefined ? `Did you mean "${guess}"?` : `Its clips: ${known.join(', ') || '(none)'}.`,
      });
    }
    return clip.duration;
  }
}
