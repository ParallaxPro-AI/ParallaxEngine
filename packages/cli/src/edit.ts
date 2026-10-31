/**
 * `parallax edit <project>`: the editor. Build, bundle the engine with the editor page,
 * serve it on localhost and open the browser. The page edits the project's scenes and
 * prefabs; Play on its top bar runs the game in place.
 *
 * A change never reloads the page (that would lose the editor's
 * state): every rebuild is announced as a "build" event with its number, diagnostics and
 * the files that changed, and the page hot-reloads new code into the session. Files the
 * editor saved itself are left out of "changed".
 *
 * Saving writes only JSON data files the server would serve (never Python, build/,
 * tests/ or dot folders): see `savePaths`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { formatDiagnostic } from '@parallax/runtime/core';
import { buildProject } from './build.js';
import type { BuildOptions, BuildResult } from './build.js';
import { bundleEngine, EDITOR_MODULE, EDITOR_STYLES, ENGINE_PREFIX, JOB_WORKER_MODULE, PANEL_FRAME_MODULE } from './bundle.js';
import { Refusal, servableProjectFile, startDevServer } from './dev_server.js';
import type { DevServer, DevState } from './dev_server.js';
import { applyAdd, loadLibrary, planAdd, readLibraryRecord } from './library.js';
import type { Library } from './library.js';
import { PROJECT_MODULE, PROJECT_MODULE_FILE } from '@parallax/runtime/boot';

export function summary(result: BuildResult): string {
  const blocks = result.diagnostics.map(formatDiagnostic);
  blocks.push(`${result.errors} error${result.errors === 1 ? '' : 's'}, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}`);
  return blocks.join('\n\n');
}

export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => process.stderr.write(`Open ${url} in your browser.\n`));
  child.unref();
}

export interface EditOptions extends BuildOptions {
  readonly port?: number;
  readonly host?: string;
  /** Open the default browser (default true). */
  readonly open?: boolean;
  /** Where progress goes (default stderr). */
  readonly log?: (line: string) => void;
  /** The asset library's roots (default `libraryRoots()`: shared_library/ and PARALLAX_LIBRARY_PATH). */
  readonly libraryRoots?: readonly string[];
}

export interface EditSession {
  readonly server: DevServer;
  /** The current build's number (`/build/v<N>/`). */
  readonly version: number;
  /** Rebuild now and announce it to open editors. */
  rebuild(changed?: readonly string[]): void;
  close(): Promise<void>;
}

interface SaveBody {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly removed: readonly string[];
}

/** A project-relative path the editor may write: well-formed, JSON, and one /project/ serves. */
export function savablePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return false;
  return path.toLowerCase().endsWith('.json') && servableProjectFile(path);
}

/** The save request's shape, checked; every path savable, or a Refusal naming the first that isn't. */
export function savePaths(body: unknown): SaveBody {
  const b = body as Partial<SaveBody> | null;
  if (typeof b !== 'object' || b === null || !Array.isArray(b.files) || !(b.removed === undefined || Array.isArray(b.removed))) {
    throw new Refusal(400, 'A save is {"files": [{"path", "text"}], "removed": [path]}');
  }
  for (const file of b.files) {
    if (typeof file !== 'object' || file === null || typeof file.text !== 'string') throw new Refusal(400, 'Each saved file needs a path and its text');
    if (!savablePath(file.path)) throw new Refusal(403, `The editor can't write ${JSON.stringify(file.path)}: only JSON data files in the project (not build/, tests/ or dot folders)`);
    try {
      JSON.parse(file.text);
    } catch {
      throw new Refusal(400, `${file.path} is not valid JSON`);
    }
  }
  for (const path of b.removed ?? []) {
    if (!savablePath(path)) throw new Refusal(403, `The editor can't remove ${JSON.stringify(path)}`);
  }
  return { files: b.files, removed: b.removed ?? [] };
}

/**
 * The model document a library piece draws (`GET /__parallax__/library-model/<id>.json`, the
 * Asset Library's thumbnails): `assets/models/<id>.model.json`, else its only model document.
 */
export function libraryModelFile(id: string, files: readonly string[]): string | undefined {
  const models = files.filter((f) => /^assets\/models\/[^/]+\.model\.json$/.test(f));
  return models.find((f) => f === `assets/models/${id}.model.json`) ?? (models.length === 1 ? models[0] : undefined);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function editorPageHtml(state: DevState, version: number): string {
  const imports = { ...state.engine.imports, [PROJECT_MODULE]: `/build/${PROJECT_MODULE_FILE}` };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(state.title)} — Parallax Editor</title>
<link rel="stylesheet" href="${ENGINE_PREFIX}${EDITOR_STYLES}">
<script type="importmap">${scriptJson({ imports })}</script>
</head>
<body>
<div id="editor"></div>
<script type="application/json" id="parallax-build">${scriptJson(state.diagnostics)}</script>
<script type="module">
import { bootEditor } from '${ENGINE_PREFIX}${EDITOR_MODULE}';
await bootEditor({
  root: document.getElementById('editor'),
  title: ${scriptJson(state.title)},
  version: ${version},
  diagnostics: JSON.parse(document.getElementById('parallax-build').textContent),
  assetFiles: ${state.assetFiles},
  panelFrame: '${ENGINE_PREFIX}${PANEL_FRAME_MODULE}',
  jobWorker: '${ENGINE_PREFIX}${JOB_WORKER_MODULE}',
});
</script>
</body>
</html>
`;
}

/** Write `text` to `file` through a temporary sibling, so a crash never leaves half a file. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.parallax-save-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/** The projects next to `projectDir` (folders with game/main.py), the editor's project switcher. */
/** Catalog names learned this run, by hosted asset URL (null: the catalog doesn't know it). */
const knownNames = new Map<string, string | null>();

/**
 * The catalog names of hosted assets (`https://r2.parallaxpro.ai/assets/...`), asked of the
 * target's public catalog (`POST {target}/api/assets/resolve {paths: ["/assets/..."]}` →
 * `{assets: [{fileUrl, name}]}`) and remembered. Best effort: offline, or an asset the
 * catalog doesn't list, answers no name and the editor keeps its own.
 */
/** Where hosted assets' catalog names are looked up. */
const ASSET_CATALOG = 'https://parallaxpro.ai';

export async function assetNames(target: string, urls: readonly string[], fetcher: typeof fetch = fetch): Promise<{ names: Record<string, string> }> {
  const keyOf = (url: string): string | undefined => /^https:\/\/(?:r2\.|www\.)?[^/]+(\/assets\/[^?#]+)$/.exec(url)?.[1];
  const wanted = [...new Set(urls)].filter((u) => keyOf(u) !== undefined && !knownNames.has(u)).slice(0, 500);
  if (wanted.length > 0) {
    try {
      const response = await fetcher(new URL('/api/assets/resolve', target), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: wanted.map(keyOf) }),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const body = await response.json() as { assets?: { fileUrl?: unknown; name?: unknown }[] };
        const byKey = new Map((body.assets ?? []).filter((a) => typeof a.fileUrl === 'string' && typeof a.name === 'string').map((a) => [a.fileUrl as string, a.name as string]));
        for (const url of wanted) knownNames.set(url, byKey.get(keyOf(url)!) ?? null);
      }
    } catch {
      // Offline: no names this time (asked again next time).
    }
  }
  const names: Record<string, string> = {};
  for (const url of urls) {
    const name = knownNames.get(url);
    if (name !== undefined && name !== null) names[url] = name;
  }
  return { names };
}

export function siblingProjects(projectDir: string): string[] {
  const parent = dirname(projectDir);
  const names = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(`${parent}/${e.name}/game/main.py`))
    .map((e) => e.name);
  if (!names.includes(basename(projectDir))) names.push(basename(projectDir));
  return names.sort();
}

export async function edit(project: string, options: EditOptions = {}): Promise<EditSession> {
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  let projectDir = resolve(project);
  let result: BuildResult = buildProject(projectDir, options);
  let version = 1;
  log(summary(result));
  const engine = await bundleEngine(undefined, { editor: true });
  const state = (): DevState => ({
    title: basename(projectDir), manifest: result.manifest, diagnostics: result.diagnostics, engine,
    assetFiles: options.assetFiles ?? true,
  });

  // What the editor wrote, by path: the watcher leaves these out of "changed" while the file still holds it.
  const written = new Map<string, string | null>();
  const save = (body: unknown): { saved: string[] } => {
    const request = savePaths(body);
    const saved: string[] = [];
    for (const file of request.files) {
      writeAtomic(`${projectDir}/${file.path}`, file.text);
      written.set(file.path, file.text);
      saved.push(file.path);
    }
    for (const path of request.removed) {
      const target = `${projectDir}/${path}`;
      if (existsSync(target)) unlinkSync(target);
      written.set(path, null);
      saved.push(path);
    }
    if (saved.length > 0) log(`Saved: ${saved.join(', ')}`);
    return { saved };
  };

  // Hosted assets' catalog names come from parallaxpro.ai's public catalog.
  const target = ASSET_CATALOG;

  let library: Library | undefined;
  const pieces = (): Library => (library ??= loadLibrary(options.libraryRoots));
  const data = (name: string): unknown => {
    if (name === 'projects') return { current: basename(projectDir), projects: siblingProjects(projectDir) };
    if (name === 'library') {
      const added = readLibraryRecord(projectDir).record.pieces;
      return { pieces: [...pieces().pieces.values()].map((p) => ({ id: p.id, category: p.category, summary: p.summary, added: added[p.id] !== undefined })) };
    }
    if (name.startsWith('library-model/')) {
      // A model piece's model document, for the Asset Library's thumbnails (before any add).
      const piece = pieces().pieces.get(name.slice('library-model/'.length));
      const file = piece === undefined ? undefined : libraryModelFile(piece.id, piece.files);
      return file === undefined ? undefined : JSON.parse(readFileSync(`${piece!.dir}/files/${file}`, 'utf8')) as unknown;
    }
    return undefined;
  };
  const api = (name: string, body: unknown): unknown => {
    const field = (key: string): string => {
      const value = (body as Record<string, unknown> | null)?.[key];
      if (typeof value !== 'string' || value === '') throw new Refusal(400, `"${key}" must be a name`);
      return value;
    };
    if (name === 'switch') {
      const to = field('project');
      if (!siblingProjects(projectDir).includes(to)) throw new Refusal(404, `No project "${to}" next to ${basename(projectDir)}`);
      switchTo(resolve(dirname(projectDir), to));
      return { project: to };
    }
    if (name === 'asset-names') {
      // Hosted assets' catalog names ("sci fi sounds: explosion crunch 001"), from the
      // public asset catalog: the editor's Project Files shows them instead of hashes.
      const paths = (body as { paths?: unknown } | null)?.paths;
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new Refusal(400, '"paths" must be a list of asset URLs');
      return assetNames(target, paths as string[]);
    }
    if (name === 'library-add') {
      const id = field('piece');
      if (!pieces().pieces.has(id)) throw new Refusal(404, `No library piece "${id}"`);
      const plan = planAdd(pieces(), projectDir, [id]);
      const errors = plan.diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) throw new Refusal(400, errors.map((d) => d.message).join('; '));
      applyAdd(projectDir, plan);
      const added = [...plan.writes.keys()].sort();
      log(`Added ${id}: ${added.join(', ')}`);
      const prefab = plan.pieces.find((p) => p.id === id)?.files.find((f) => f === `prefabs/${id}.prefab.json`) !== undefined ? id : null;
      return { added, prefab };
    }
    return undefined;
  };

  const server = await startDevServer({
    get projectDir() { return projectDir; },
    get buildDir() { return result.buildDir; },
    state, save, api, data,
    page: (s) => editorPageHtml(s, version),
    ...(options.port !== undefined && { port: options.port }),
    ...(options.host !== undefined && { host: options.host }),
  });
  log(`Editing ${projectDir} at ${server.url}`);

  const rebuild = (changed: readonly string[] = []): void => {
    result = buildProject(projectDir, options);
    version++;
    log(summary(result));
    server.broadcast('build', { version, diagnostics: result.diagnostics, changed });
  };

  /** Whether the file now holds exactly what the editor last wrote there. */
  const ownWrite = (rel: string): boolean => {
    if (!written.has(rel)) return false;
    const mine = written.get(rel)!;
    const target = `${projectDir}/${rel}`;
    const now = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (now === mine) return true;
    written.delete(rel);
    return false;
  };

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startWatch = (): ReturnType<typeof watch> => {
  // The build folder may sit inside the project: its own writes are not changes.
  const buildRel = relative(projectDir, result.buildDir);
  return watch(projectDir, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const rel = filename.split('\\').join('/');
    if (rel.split('/').some((s) => s.startsWith('.') || s === '__pycache__' || s === 'node_modules')) return;
    if (buildRel !== '' && !buildRel.startsWith('..') && (rel === buildRel || rel.startsWith(`${buildRel}/`))) return;
    if (rel.includes('.parallax-save-')) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...pending].filter((p) => !ownWrite(p)).sort();
      const any = pending.size > 0;
      pending.clear();
      if (!any) return;
      if (changed.length > 0) log(`Changed: ${changed.join(', ')}`);
      rebuild(changed);
    }, 150);
  });
  };
  let watcher = startWatch();

  /** Edit another project on the same server: rebuild, rewatch, and reload every open page. */
  function switchTo(dir: string): void {
    clearTimeout(timer);
    watcher.close();
    pending.clear();
    written.clear();
    projectDir = dir;
    result = buildProject(projectDir, options);
    version++;
    log(summary(result));
    log(`Editing ${projectDir}`);
    watcher = startWatch();
    server.reload();
  }

  if (options.open ?? true) openBrowser(server.url);
  return {
    server,
    get version() { return version; },
    rebuild,
    close: async () => {
      clearTimeout(timer);
      watcher.close();
      await server.close();
    },
  };
}
