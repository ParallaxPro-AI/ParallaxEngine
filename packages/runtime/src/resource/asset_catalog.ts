/**
 * The project's asset files and how a reference names one — one spelling per file, the
 * same rules as `parallax check` (and render2d, audio):
 *
 *   "models/knight"              the handle `Assets.models.knight` holds: the folder under
 *                                assets/, then the file name up to its first dot
 *                                ("sfx/click", "images/dot", "clips/run", "vfx/sparks")
 *
 *   "https://r2.parallaxpro.ai/assets/model_static/ab/cd/<sha>.glb"
 *                                a hosted asset (core/remote_assets.ts): checked for form and
 *                                kind, fetched only where the run can (`remote`)
 *
 * The file path ("assets/models/knight.glb") and a bare name ("knight") are not references:
 * both are PP2063 with a fix naming the handle (`handleFormProblem`). A reference that names
 * no file is PP2063 too, the checker's code for the same mistake. Clip references add
 * `#clip` to a model reference (`models/knight#run`); a bare clip name (`run`) names a clip
 * of the entity's own model.
 */

import { closestMatch, fail, isAssetUrl, isRemoteAsset, remoteAssetProblem, remoteAssetUrl } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';

export type AssetFolder = 'models' | 'images' | 'vfx';

/** `assets/models/knight.glb` → `models/knight`. */
export function assetHandle(path: string): string {
  const relative = path.replace(/^assets\//, '');
  const slash = relative.lastIndexOf('/');
  const dot = relative.indexOf('.', slash + 1);
  return dot === -1 ? relative : relative.slice(0, dot);
}

/**
 * Why a local asset reference isn't written in the one form, `"<folder>/<name>"`, with the
 * handle to write instead — or undefined when it is. A file path (`assets/models/knight.glb`)
 * and a bare name (`knight`, with `folder` the field's folder) are the two wrong spellings.
 * URLs are never asked about.
 */
export function handleFormProblem(ref: string, folder?: string): { readonly message: string; readonly handle: string } | undefined {
  if (ref.startsWith('assets/')) {
    const bare = assetHandle(ref);
    const handle = !bare.includes('/') && folder !== undefined ? `${folder}/${bare}` : bare;
    return { message: `"${ref}" is a file path; an asset is referred to by its handle, "${handle}"`, handle };
  }
  if (!ref.includes('/') && folder !== undefined) {
    const handle = `${folder}/${ref}`;
    return { message: `"${ref}" is a bare name; an asset is referred to by its handle, "${handle}"`, handle };
  }
  return undefined;
}

/** PP2063 for a reference in the wrong form (`handleFormProblem`). */
export function requireHandleForm(ref: string, folder: string, where: string): void {
  const problem = handleFormProblem(ref, folder);
  if (problem !== undefined) {
    fail('PP2063', `${where}: ${problem.message}`, { fix: `Write "${problem.handle}" ("<folder>/<name>": no "assets/", no extension).` });
  }
}

/** An asset value as stored in a field or passed by game code: a string, or a ref (`path` / `name`). */
export function refString(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const path = (value as { path?: unknown }).path;
    if (typeof path === 'string') return path;
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return fail('PP3062', `${where} must be an asset reference, got ${value === null ? 'None' : typeof value}`, {
    fix: 'Pass an Assets.<folder>.<name> handle.',
  });
}

export class AssetCatalog {
  readonly #files: ProjectFiles;
  readonly #byHandle = new Map<string, string>();
  readonly #paths = new Set<string>();
  /**
   * False when the asset files aren't available (data-only playtests, as in render2d):
   * references are checked for form and folder only; models without a file are never
   * loaded and draw nothing, effects without a file emit nothing.
   */
  readonly checked: boolean;
  /**
   * Whether hosted asset URLs can be fetched in this run (a browser). False (headless,
   * servers): a URL reference is checked for form and loads nothing, like a missing file in
   * a data-only run.
   */
  readonly remote: boolean;

  constructor(files: ProjectFiles, checked = true, remote = false) {
    this.#files = files;
    this.checked = checked;
    this.remote = remote;
    for (const path of files.list()) {
      if (!path.startsWith('assets/') || path === 'assets/audio.json') continue;
      this.#paths.add(path);
      // Buffers and textures beside a .gltf share its handle; the model file wins.
      const handle = assetHandle(path);
      if (!this.#byHandle.has(handle) || /\.(glb|gltf|model\.json)$/i.test(path)) this.#byHandle.set(handle, path);
    }
  }

  /** Is this a file of the project? (Never true of a hosted asset URL: see `loadable`.) */
  has(path: string): boolean {
    return this.#paths.has(path);
  }

  /** Can a resolved path be loaded in this run: a project file, or a hosted asset where `remote`. */
  loadable(path: string): boolean {
    return isRemoteAsset(path) ? this.remote : this.#paths.has(path);
  }

  /** The file a reference names, in `folder`; PP2063 when there is none. A hosted asset URL resolves to its canonical form. */
  resolve(ref: string, folder: AssetFolder, where: string): string {
    if (isAssetUrl(ref)) return remoteRef(ref, folder, where);
    requireHandleForm(ref, folder, where);
    const handle = ref;
    if (!handle.startsWith(`${folder}/`)) {
      fail('PP2063', `${where} names "${ref}", which is not in assets/${folder}/`, {
        fix: `Refer to a file in assets/${folder}/, written "${folder}/<name>".`,
      });
    }
    const path = this.#byHandle.get(handle);
    if (path === undefined && !this.checked) return handle;
    if (path === undefined) {
      const known = [...this.#byHandle.keys()].filter((h) => h.startsWith(`${folder}/`));
      const guess = closestMatch(handle, known);
      fail('PP2063', `${where} names the asset "${ref}", but there is no such file under assets/${folder}/`, {
        fix: guess === undefined ? `Add the file to assets/${folder}/.` : `Did you mean "${guess}"?`,
      });
    }
    return path;
  }

  read(path: string): string {
    return this.#files.read(path);
  }
}

/** A URL asset reference, checked for form and kind (PP2063), as its canonical URL. */
export function remoteRef(ref: string, folder: string, where: string): string {
  const problem = remoteAssetProblem(ref, folder);
  if (problem !== undefined) {
    fail('PP2063', `${where}: ${problem}`, {
      fix: `Use a hosted asset URL (https://r2.parallaxpro.ai/assets/…) of a file ${folder} load, or a file in assets/${folder}/.`,
    });
  }
  return remoteAssetUrl(ref)!;
}

/** A clip reference split into its model (null: the entity's own) and clip name. */
export function splitClip(ref: string): { readonly model: string | null; readonly clip: string } {
  const hash = ref.lastIndexOf('#');
  return hash === -1 ? { model: null, clip: ref } : { model: ref.slice(0, hash), clip: ref.slice(hash + 1) };
}
