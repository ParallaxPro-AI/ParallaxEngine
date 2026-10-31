/**
 * The editor page's link to `parallax edit`: saving documents to the project folder, and
 * hearing rebuilds (a changed .py file, or data changed outside the editor).
 *
 *   POST /__parallax__/save    {"files": [{"path", "text"}], "removed": [path]} → {"saved": [path]}
 *   GET  /__parallax__/events  server-sent events: "build" {version, diagnostics, changed}
 */

import type { Diagnostic } from '@parallax/runtime/core';
import type { ProjectDocuments } from './session/index.js';
import { formatJson, jsonStyle } from './format_json.js';
import { serverUrl } from './paths.js';

export const SAVE_URL = '/__parallax__/save';
export const EVENTS_URL = '/__parallax__/events';

export interface BuildEvent {
  /** The build's number: its modules are served under `/build/v<version>/`. */
  readonly version: number;
  readonly diagnostics: readonly Diagnostic[];
  /** Project files that changed on disk since the last build (the editor's own saves left out). */
  readonly changed: readonly string[];
  /** A host's server may send fields of its own; they reach `EditorHost`'s `build` event as sent. */
  readonly [field: string]: unknown;
}

export interface SaveRequest {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly removed: readonly string[];
}

/**
 * What `documents` has to send: its dirty files, written or removed. A JSON file keeps the
 * layout its text on disk had (`original`), so the diff stays on the lines that changed.
 */
export function saveRequest(documents: ProjectDocuments, original: (path: string) => string | undefined = () => undefined): SaveRequest {
  const files: { path: string; text: string }[] = [];
  const removed: string[] = [];
  for (const path of documents.dirty()) {
    if (!documents.has(path)) removed.push(path);
    else if (path.endsWith('.json')) files.push({ path, text: formatJson(documents.json(path), jsonStyle(original(path))) });
    else files.push({ path, text: documents.read(path) });
  }
  return { files, removed };
}

/** Write the dirty documents to the project folder; marks them saved. Resolves to the saved paths. */
export async function save(documents: ProjectDocuments, original?: (path: string) => string | undefined, post: typeof fetch = fetch): Promise<string[]> {
  const request = saveRequest(documents, original);
  if (request.files.length === 0 && request.removed.length === 0) return [];
  const response = await post(serverUrl(SAVE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({})) as { saved?: string[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Saving failed (HTTP ${response.status})`);
  const saved = body.saved ?? [];
  documents.markSaved(saved);
  return saved;
}

/** Whether a build's changes need new code in the page (vs. data or markup only). */
export function needsCode(changed: readonly string[]): boolean {
  return changed.some((path) => /\.py$/.test(path));
}

/** Hear rebuilds; returns a function that stops listening. */
export function onBuild(listener: (event: BuildEvent) => void): () => void {
  const source = new EventSource(serverUrl(EVENTS_URL));
  const handle = (event: MessageEvent<string>): void => {
    try {
      listener(JSON.parse(event.data) as BuildEvent);
    } catch (error) {
      console.warn('Parallax editor: a build event could not be read', error);
    }
  };
  source.addEventListener('build', handle as EventListener);
  return () => source.close();
}
