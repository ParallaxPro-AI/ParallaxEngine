/**
 * esbuild over the engine. Two products:
 *
 *   engine bundle  for the browser: one ES module per engine module (`parallax`,
 *                  `parallax/physics`, …) plus `boot`, sharing chunks so every module sees
 *                  one runtime; the page's import map points the bare names at them, and
 *                  the compiled game is served as-is next to it. With `editor`, the
 *                  editor page (`editor.js` + `editor.css`) joins the same chunks, so the
 *                  editor and the game it edits share that one runtime too. With
 * `release`: minified, no source maps, and every
 *                  file named by its content (`boot-3FQK2X7A.js`), so it can be cached forever.
 *   game bundle    for Node: the compiled entry and `bootHeadless` in one module, the bare
 *                  names resolved to runtime sources (playtests, headless runs).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import {
  BOOT_ENTRY, gameModules, JOB_WORKER_ENTRY, migrationModules, PANEL_FRAME_ENTRY, PROJECT_MODULE, PROJECT_MODULE_FILE,
} from '@parallax/runtime/boot';
import type { BuildManifest, HeadlessBootOptions, HeadlessGame } from '@parallax/runtime/boot';
import { fail } from '@parallax/runtime/core';
import { availableEngineModules } from './link.js';
import { EDITOR_ENTRY, RUNTIME_SRC } from './paths.js';

/** URL prefix of the engine bundle on the dev server. */
export const ENGINE_PREFIX = '/engine/';
export const BOOT_MODULE = 'boot.js';
/**
 * The script scripted panels' sandboxed frames load (`PANEL_FRAME_ENTRY`): one classic
 * script with no imports, so an opaque-origin frame loads it from any server, CORS or not.
 */
export const PANEL_FRAME_MODULE = 'panel_frame.js';
/** The module worker that runs engine jobs off the main thread (`JOB_WORKER_ENTRY`). */
export const JOB_WORKER_MODULE = 'job_worker.js';
/** The editor page's module and stylesheet (`bundleEngine(…, { editor: true })`). */
export const EDITOR_MODULE = 'editor.js';
export const EDITOR_STYLES = 'editor.css';

export interface EngineBundle {
  /** Files by path under `/engine/` (`parallax.js`, `parallax/physics.js`, `chunks/…`, `.map`s). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Bare specifier → URL, for the import map (without `project`, which belongs to the build). */
  readonly imports: Readonly<Record<string, string>>;
  /**
   * Each entry's file under the engine folder: the bare specifiers (`parallax`,
   * `parallax/physics`, …), `boot`, `panel_frame`, `job_worker` (and `editor`).
   */
  readonly entries: Readonly<Record<string, string>>;
}

export interface EngineBundleOptions {
  /** Add the editor page (`editor.js` + `editor.css`) to the same chunks. */
  readonly editor?: boolean;
  /** A release build: minified, no source maps, content-hashed file names. */
  readonly release?: boolean;
}

function esbuildFailure(error: unknown): never {
  const errors = (error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors ?? [];
  const first = errors[0];
  return fail('PP9513', `Bundling the engine failed: ${first?.text ?? (error as Error).message}`, {
    ...(first?.location !== undefined && first.location !== null && { path: first.location.file, line: first.location.line }),
    fix: 'This is an engine build error; run `npx tsc --noEmit` in packages/runtime for the full list.',
  });
}

export async function bundleEngine(runtimeSrc = RUNTIME_SRC, options: EngineBundleOptions = {}): Promise<EngineBundle> {
  const release = options.release === true;
  const modules = availableEngineModules(runtimeSrc);
  const entryPoints: Record<string, string> = {
    boot: runtimeSrc + BOOT_ENTRY, job_worker: runtimeSrc + JOB_WORKER_ENTRY,
    ...(options.editor === true && { editor: EDITOR_ENTRY }),
  };
  for (const [specifier, path] of modules) entryPoints[specifier] = path;
  // Never written (write: false); only names the output paths.
  const outdir = resolve(runtimeSrc, '..', '.engine-bundle');
  // Release: names stay readable in stacks and `constructor.name` keeps working.
  const shared = {
    outdir, write: false, bundle: true, platform: 'browser', target: 'es2022', logLevel: 'silent',
    ...(release ? { minify: true, keepNames: true, entryNames: '[dir]/[name]-[hash]' } : { sourcemap: 'linked' as const }),
  } as const;
  let results: esbuild.BuildResult<{ write: false; outdir: string }>[];
  try {
    results = await Promise.all([
      esbuild.build({ ...shared, entryPoints, splitting: true, format: 'esm', chunkNames: 'chunks/[name]-[hash]' }),
      // A sandboxed frame's origin is opaque: a module script (and its chunks) would load only
      // from a server that sends CORS headers; a classic script loads from any.
      esbuild.build({ ...shared, entryPoints: { panel_frame: runtimeSrc + PANEL_FRAME_ENTRY }, format: 'iife' }),
    ]);
  } catch (error) {
    esbuildFailure(error);
  }
  const files = new Map<string, Uint8Array>();
  for (const result of results) for (const file of result.outputFiles) files.set(file.path.slice(outdir.length + 1), file.contents);
  const entries: Record<string, string> = {};
  for (const name of [...Object.keys(entryPoints), 'panel_frame']) {
    // A release entry is `<name>-<HASH>.js` (`parallax-…` is not `parallax/physics-…`: the hash has no slash).
    const file = !release ? `${name}.js`
      : [...files.keys()].find((path) => path.startsWith(`${name}-`) && /^[A-Z0-9]+\.js$/.test(path.slice(name.length + 1)));
    if (file === undefined || !files.has(file)) fail('PP9513', `Bundling the engine wrote no file for its entry "${name}"`, { fix: 'This is an engine build error; report it.' });
    entries[name] = file;
  }
  const imports = Object.fromEntries([...modules.keys()].map((specifier) => [specifier, `${ENGINE_PREFIX}${entries[specifier]!}`]));
  return { files, imports, entries };
}

/** Resolves `parallax*` to runtime sources and `project` to the build's generated module. */
function enginePlugin(buildDir: string, runtimeSrc: string): esbuild.Plugin {
  const modules = availableEngineModules(runtimeSrc);
  return {
    name: 'parallax-modules',
    setup(build) {
      build.onResolve({ filter: /^(parallax(\/.*)?|project)$/ }, (args) => {
        if (args.path === PROJECT_MODULE) return { path: `${buildDir}/${PROJECT_MODULE_FILE}` };
        const path = modules.get(args.path);
        return path === undefined
          ? { errors: [{ text: `"${args.path}" is not an engine module this runtime provides (PP9501)` }] }
          : { path };
      });
    },
  };
}

/** What the game bundle exports: the entry's exports and the boot that shares its runtime. */
export interface LoadedGame {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly bootHeadless: (options: HeadlessBootOptions) => Promise<HeadlessGame>;
}

/**
 * Bundle a build's entry with the engine for Node and import it. Written to
 * `<build>/headless.mjs` (never served: the dev server serves only the manifest's modules).
 */
export async function loadGame(buildDir: string, runtimeSrc = RUNTIME_SRC): Promise<LoadedGame> {
  return importForNode<LoadedGame>(buildDir, [`export { bootHeadless } from ${JSON.stringify(`${runtimeSrc}${BOOT_ENTRY}`)};`], `${buildDir}/headless.mjs`, runtimeSrc);
}

/**
 * The compiled game and `extra` statements (more exports that must share the game's
 * runtime, e.g. the match server) as one Node module, written to `outfile` and imported.
 */
export async function importForNode<T>(buildDir: string, extra: readonly string[], outfile: string, runtimeSrc = RUNTIME_SRC): Promise<T> {
  const manifest = JSON.parse(readFileSync(`${buildDir}/manifest.json`, 'utf8')) as BuildManifest;
  if (manifest.entry === null) fail('PP9502', 'The build has no game/main.py', { fix: 'Create game/main.py, then rebuild.' });
  let result: esbuild.BuildResult<{ write: false }>;
  try {
    result = await esbuild.build({
      stdin: {
        contents: [
          ...[...migrationModules(manifest), ...gameModules(manifest)].map((module) => `import ${JSON.stringify(`${buildDir}/${module}`)};`),
          `export * as entry from ${JSON.stringify(`${buildDir}/${manifest.entry}`)};`,
          ...extra,
        ].join('\n'),
        resolveDir: buildDir,
        loader: 'js',
      },
      outfile, write: false, bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent',
      plugins: [enginePlugin(buildDir, runtimeSrc)],
    });
  } catch (error) {
    esbuildFailure(error);
  }
  writeFileSync(outfile, result.outputFiles[0]!.contents);
  return (await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)) as T;
}
