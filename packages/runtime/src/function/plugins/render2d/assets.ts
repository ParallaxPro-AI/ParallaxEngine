/**
 * The project's asset files, and how an asset reference names one. A reference is written
 * the way `parallax check` accepts it (packages/check/src/context.ts `missingAsset`), one
 * spelling per file:
 *
 *   "images/ship"              the handle `Assets.images.ship` holds (`AssetRef.path`)
 *   "https://r2.parallaxpro.ai/assets/image_sprite/ab/cd/<sha>.png"
 *                              a hosted asset (core/remote_assets.ts), loaded where the run
 *                              can fetch it (`remote`), else drawn as a missing file is
 *
 * The file path ("assets/images/ship.png") and a bare name ("ship") are PP2063 with a fix
 * naming the handle (resource `requireHandleForm`).
 * A reference that names no file is PP2063, the checker's code for the same mistake —
 * unless the asset files aren't available (data-only playtests, `parallax check
 * --no-asset-files`): then, like audio, references are checked for form and folder only,
 * and one without a file resolves to its handle (`images/ship`), which the surface is asked
 * to load as it is (the headless recorder just records it).
 */

import { closestMatch, fail, isAssetUrl, isRemoteAsset } from '../../../core/index.js';
import { remoteRef, requireHandleForm } from '../../../resource/index.js';
import type { ProjectFiles } from '../../../core/index.js';

export type AssetFolder = 'images' | 'vfx';

/** `assets/vfx/sparks.vfx.json` → `vfx/sparks` (the folder, then the file name up to its first dot). */
export function assetHandle(path: string): string {
  const relative = path.replace(/^assets\//, '');
  const slash = relative.lastIndexOf('/');
  const dot = relative.indexOf('.', slash + 1);
  return dot === -1 ? relative : relative.slice(0, dot);
}

/** An asset value as stored in a field or passed by game code: a string, or a ref object (`toJSON` / `path`). */
export function refString(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const path = (value as { path?: unknown }).path;
    if (typeof path === 'string') return path;
  }
  return fail('PP3600', `${where} must be an asset reference, got ${value === null ? 'None' : typeof value}`, {
    fix: 'Pass an Assets.<folder>.<name> handle.',
  });
}

export class AssetCatalog {
  readonly #files: ProjectFiles;
  /** handle (`images/ship`) → file path. */
  readonly #byHandle = new Map<string, string>();
  readonly #paths = new Set<string>();
  /** False when the asset files aren't available: missing files are not errors. */
  readonly checked: boolean;
  /** Whether hosted asset URLs can be fetched in this run (a browser); headless they draw as missing files. */
  readonly remote: boolean;

  constructor(files: ProjectFiles, checked: boolean, remote = false) {
    this.#files = files;
    this.checked = checked;
    this.remote = remote;
    for (const path of files.list()) {
      if (!path.startsWith('assets/') || path === 'assets/audio.json') continue;
      this.#paths.add(path);
      this.#byHandle.set(assetHandle(path), path);
    }
  }

  /** The file a reference names, in `folder`; PP2063 when there is none. */
  resolve(ref: string, folder: AssetFolder, where: string): string {
    if (isAssetUrl(ref)) return remoteRef(ref, folder, where);
    requireHandleForm(ref, folder, where);
    const handle = ref;
    const known = [...this.#byHandle.keys()].filter((h) => h.startsWith(`${folder}/`));
    if (!handle.startsWith(`${folder}/`)) {
      fail('PP2063', `${where} names "${ref}", which is not in assets/${folder}/`, {
        fix: `Refer to a file in assets/${folder}/, written "${folder}/<name>".`,
      });
    }
    const path = this.#byHandle.get(handle);
    if (path === undefined && !this.checked) return handle;
    if (path === undefined) {
      const guess = closestMatch(handle, known);
      fail('PP2063', `${where} names the asset "${ref}", but there is no such file under assets/${folder}/`, {
        fix: guess === undefined ? `Add the file to assets/${folder}/.` : `Did you mean "${guess}"?`,
      });
    }
    return path;
  }

  /** Whether a resolved path is a file of the project (false only for unchecked references). */
  has(path: string): boolean {
    return this.#paths.has(path);
  }

  /** Whether a resolved path can be loaded in this run: a project file, or a hosted asset where `remote`. */
  loadable(path: string): boolean {
    return isRemoteAsset(path) ? this.remote : this.#paths.has(path);
  }

  /** A text asset's contents (vfx definitions). */
  read(path: string): string {
    return this.#files.read(path);
  }
}
