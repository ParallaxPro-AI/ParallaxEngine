/**
 * Play the settled project while the editor shows unfinished work (`EditorHost.setPlaySource`).
 *
 * A host showing another tool's project mid-edit (BuildEvent.preview) knows where its last
 * finished version is served: a base URL with the same layout as the editor's own server
 * (`build/`, `project/`, `project-files.json`). Play swaps that version into the editor's own
 * runtime — its text documents and its build — and plays it; Stop swaps the editor's files back
 * (with whatever arrived meanwhile) and rebuilds on the newest build. One engine, one game.
 *
 * Binary assets (images, audio, packed models) still load from the editor's own project files.
 */

import { fetchProjectFiles, TEXT_FILE } from '@parallax/runtime/platform';
import type { Editor, PlaySwap } from './editor.js';
import { showEditorLoading } from './loading_screen.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

/** Where Play goes instead of the editor's files (`EditorHost.setPlaySource`). */
export interface PlaySource {
  /** A base URL serving `build/v<N>/`, `project/` and `project-files.json` (same origin). */
  readonly base: string;
  /** What Play says when it starts (default "Playing the last finished version of the project"). */
  readonly label?: string;
}

/** The text documents' contents (the files `replaceFiles` can carry; code comes with the build). */
export function documentTexts(documents: { list(): readonly string[]; read(path: string): string }): Map<string, string> {
  const texts = new Map<string, string>();
  for (const path of documents.list()) if (TEXT_FILE.test(path)) texts.set(path, documents.read(path));
  return texts;
}

/** The `replaceFiles` map that turns `from` into `to`: each path whose text differs, null where `to` has none. */
export function swapFiles(from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): Map<string, string | null> {
  const files = new Map<string, string | null>();
  for (const [path, text] of to) if (from.get(path) !== text) files.set(path, text);
  for (const path of from.keys()) if (!to.has(path)) files.set(path, null);
  return files;
}

export interface SettledIo {
  /** Point the runtime's rebuilds at this build. */
  setBuild(url: string): void;
  /** The editor's own server (its `build/` serves the newest build under any number). */
  readonly ownBase: string;
  /** The newest build the editor has heard of (it can move while a swap loads). */
  version(): number;
  /** The viewport, for the loading indicator. */
  readonly stage: HTMLElement;
  /** The loading indicator while a version loads, with what it says (tests pass their own). */
  readonly loading?: (label: string) => { done(): void };
  /** The settled project's text documents (tests pass their own). */
  readonly fetchTexts?: (base: URL) => Promise<Map<string, string>>;
}

async function fetchTexts(base: URL): Promise<Map<string, string>> {
  const fetched = await fetchProjectFiles({ index: new URL('project-files.json', base).href, base: new URL('project/', base).href });
  const texts = new Map<string, string>();
  for (const path of fetched.paths) if (TEXT_FILE.test(path)) texts.set(path, fetched.files.read(path));
  return texts;
}

// A build number not used before: the page caches a build's modules by URL, and a runtime
// rebuilt from modules an earlier runtime used fails (its plugins belong to that kernel).
let lastFresh = Date.now();
const fresh = (): number => ++lastFresh;

export function settledPlay(editor: Editor, source: PlaySource, io: SettledIo): PlaySwap {
  let own: Map<string, string> | null = null;
  const replace = (files: ReadonlyMap<string, string | null>): void => {
    if (files.size === 0) return;
    editor.documents.replaceFiles(files);
    editor.session.history.clear();
  };
  /** `label`: what the viewport says while it loads (Play: the finished version; Stop: back to the work in progress). */
  const reload = async (label: string): Promise<void> => {
    const loading = io.loading?.(label) ?? showEditorLoading(io.stage, { label, compact: true, delayMs: 150 });
    try {
      await editor.session.reload();
    } finally {
      loading.done();
    }
  };
  const label = source.label ?? t('editor.playingFinished');
  const own_ = (): string => new URL(`build/v${fresh()}/`, new URL(io.ownBase, globalThis.location?.href)).href;
  return {
    label,
    async enter() {
      const base = new URL(source.base, globalThis.location?.href);
      const settled = await (io.fetchTexts ?? fetchTexts)(base);
      own = documentTexts(editor.documents);
      replace(swapFiles(own, settled));
      io.setBuild(new URL(`build/v${fresh()}/`, base).href);
      try {
        await reload(t('editor.loadingFinished'));
      } catch (error) {
        io.setBuild(own_());
        replace(swapFiles(settled, own));
        own = null;
        await reload(t('editor.backToWork')).catch(() => {});
        throw error;
      }
      try { showToast(label, 'info'); } catch { /* no page */ }
    },
    async leave() {
      if (own !== null) replace(swapFiles(documentTexts(editor.documents), own));
      own = null;
      // A build that arrives while this one loads is taken too.
      let version: number;
      do {
        version = io.version();
        io.setBuild(own_());
        await reload(t('editor.backToWork'));
      } while (version !== io.version());
    },
  };
}
