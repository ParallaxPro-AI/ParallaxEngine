/**
 * Files changed outside the editor, as a `build` event lists them (another program, or a
 * host's tool writing the project), sorted by what the page can do with each:
 *
 *   documents  data files (JSON, `.yarn`, `.plan` outside tests/): taken into the documents
 *              and the edit world in place (`Editor.takeOutsideChanges`), no page reload
 *   conflicts  data files with unsaved edits here: left alone, the person decides (Save
 *              overwrites them; reloading the page takes them). While the host holds the
 *              read-only lock there are none: its files win
 *   reload     markup, styles and assets: the page shows them after a reload
 *
 * Asset documents (a model's `.model.json`) are documents, and the runtime is rebuilt to see
 * them (`needsRuntime`).
 *
 * `.py` files are code: the event's build carries them (hot reload), so they are not listed.
 */

import { serverUrl } from './paths.js';

export interface OutsidePlan {
  readonly documents: readonly string[];
  readonly conflicts: readonly string[];
  readonly reload: readonly string[];
}

/** A data document the editor holds (check's `isDataFile`). */
export function isDocument(path: string): boolean {
  return /\.(json|yarn|plan)$/.test(path) && !path.startsWith('tests/');
}

export function planOutsideChanges(changed: readonly string[], dirty: ReadonlySet<string>, readOnly: boolean): OutsidePlan {
  const documents: string[] = [];
  const conflicts: string[] = [];
  const reload: string[] = [];
  for (const path of changed) {
    if (/\.py$/.test(path)) continue;
    if (!isDocument(path)) reload.push(path);
    else if (dirty.has(path) && !readOnly) conflicts.push(path);
    else documents.push(path);
  }
  return { documents, conflicts, reload };
}

/**
 * Whether a build reloads the page now: markup or assets changed, nothing is unsaved and the
 * edit world is up. Never for a preview (`BuildEvent.preview`): its files may still change,
 * and the settled build after it lists them again, so the page reloads once, onto finished work.
 */
export function reloadsPage(plan: OutsidePlan, state: { readonly dirty: boolean; readonly editing: boolean; readonly preview: boolean }): boolean {
  return plan.reload.length > 0 && !state.dirty && state.editing && !state.preview;
}

/** What a preview's markup and asset changes become without a page reload (`planPreviewFiles`). */
export interface PreviewFiles {
  /** Asset files now served: listed in the documents, so a rebuilt runtime finds them. */
  readonly listed: readonly string[];
  /** Asset files no longer served. */
  readonly unlisted: readonly string[];
  /** Markup, styles and scripts the documents take as text (null: gone). */
  readonly text: readonly string[];
}

/** Markup, styles and scripts: text the runtime reads from the documents (the loader's TEXT_FILE kinds). */
const TEXT_ASSET = /\.(html|css|js)$/;

/**
 * A preview's `reload` paths (planOutsideChanges), taken in place instead: asset files go into
 * the documents' listing (`served`: what the server serves now, so a missing one was removed),
 * markup and styles as text. Tests are left alone (the game never reads them). The runtime is
 * then rebuilt, which is what a page reload would have done, without reloading the page.
 */
export function planPreviewFiles(reload: readonly string[], served: ReadonlySet<string>): PreviewFiles {
  const listed: string[] = [];
  const unlisted: string[] = [];
  const text: string[] = [];
  for (const path of reload) {
    if (path.startsWith('tests/')) continue;
    if (TEXT_ASSET.test(path)) text.push(path);
    else if (path.startsWith('assets/')) (served.has(path) ? listed : unlisted).push(path);
  }
  return { listed, unlisted, text };
}

/** Every path the server serves now (its project-files.json). */
export async function fetchServedPaths(get: typeof fetch = fetch): Promise<Set<string>> {
  const response = await get(serverUrl('project-files.json'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read the project's file list (HTTP ${response.status})`);
  const body = await response.json() as { files?: unknown };
  return new Set(Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === 'string') : []);
}

/**
 * Whether taking these changes needs the game's runtime rebuilt (a hot reload), besides the
 * documents: a model or other asset document under assets/. The runtime lists the project's
 * asset files once, when it is built, so a model added outside (an Asset Library add, a
 * model another program wrote) can't be drawn or placed until then, and one changed in place would
 * keep its old parse.
 */
export function needsRuntime(changed: readonly string[]): boolean {
  return changed.some((path) => path.startsWith('assets/') && isDocument(path));
}

/** The files' text as the server serves them now (null: gone). */
export async function fetchProjectFiles(paths: readonly string[], get: typeof fetch = fetch): Promise<Map<string, string | null>> {
  const texts = await Promise.all(paths.map(async (path) => {
    const response = await get(serverUrl(`project/${path.split('/').map(encodeURIComponent).join('/')}`), { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not read ${path} (HTTP ${response.status})`);
    return response.text();
  }));
  return new Map(paths.map((path, i) => [path, texts[i]!]));
}
