/**
 * One project's tests inside a playtest process (child.ts registers the module hooks
 * first). Every test runs in a fresh realm: the game's declarations are forgotten, its
 * modules are imported again (`?realm=N`, see hooks.ts), the random source is reseeded,
 * and a playtest gets a new `GameHarness` — so no state leaks from one test to the next,
 * and `Game(plugins=[...])` builds new plugin instances (they install into one kernel).
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directoryFiles } from '@parallax/check';
import { observe } from '@parallax/editor/session';
import type { Observation } from '@parallax/editor/session';
import { resetDeclarations } from '@parallax/runtime/api';
import { missingEngineModule } from '@parallax/runtime/boot';
import { diagnostic, fail, ParallaxError, SeededRandom } from '@parallax/runtime/core';
import type { BinaryFiles, ProjectFiles } from '@parallax/runtime/core';
import { collect } from './discover.js';
import type { Collected } from './discover.js';
import { outcomeOf, runPlainTest, runPlaytest } from './driver.js';
import type { Outcome } from './driver.js';
import { GameHarness } from './harness.js';
import { setActiveRandom, setPrintSink } from './internals.js';
import type { SessionJob, SessionMessage, TestResult } from './results.js';
import { traceback } from './traceback.js';
import type { TraceContext } from './traceback.js';

const MISSING_EXPORT = /The requested module '([^']+)' does not provide an export named '([^']+)'/;

/** An import that failed for a reason the engine or build can name, as a coded error; anything else unchanged. */
export function importFailure(error: unknown, build: string, sources: Readonly<Record<string, string>>): unknown {
  if (!(error instanceof Error)) return error;
  const sourceOf = (url: string | null | undefined): string | undefined => {
    if (typeof url !== 'string' || !url.startsWith(build)) return undefined;
    const output = decodeURIComponent(url.slice(build.length).replace(/\?.*$/, ''));
    return sources[output] ?? output;
  };
  if (error.message.startsWith('PP9501 ')) {
    const info = JSON.parse(error.message.slice('PP9501 '.length)) as { specifier: string; importer: string | null };
    return new ParallaxError(missingEngineModule(info.specifier, sourceOf(info.importer) ?? '(engine)'));
  }
  const missing = MISSING_EXPORT.exec(error.message);
  if (missing !== null) {
    const [, module, name] = missing as unknown as [string, string, string];
    const importer = sourceOf(/^(file:[^\s:]+(?::\d+)?)/.exec(error.stack ?? '')?.[1]?.replace(/:\d+$/, ''));
    const at = importer === undefined ? {} : { path: importer };
    if (module === 'parallax' || module.startsWith('parallax/')) {
      return new ParallaxError(diagnostic('PP9501', `"${module}" has no "${name}" in this engine build yet`, {
        ...at, fix: 'Run the game on an engine build that includes it, or remove the import until it lands.',
      }));
    }
    return new ParallaxError(diagnostic('PP3413', `"${module}" has no "${name}"`, {
      ...at,
      fix: module === 'project'
        ? 'The generated project module has no such handle: fix the name, or the data it is generated from.'
        : `Define ${name} in ${module}, or fix the import.`,
    }));
  }
  return error;
}

/** What the playtest's game showed at its end (null: it never started one, or observing failed). */
function finalObservation(harness: GameHarness | undefined): Observation | null {
  try {
    return harness === undefined ? null : observe(harness.runtime);
  } catch {
    return null;
  }
}

function matches(filter: string | null, id: string, title: string): boolean {
  return filter === null || id.includes(filter) || title.includes(filter);
}

/** The project's binary files (glTF models), read from disk; a path not in the project rejects (PP3804). */
export function projectBinaryFiles(tree: { exists(path: string): boolean; bytes(path: string): Uint8Array }): BinaryFiles {
  return {
    read: (path) => tree.exists(path)
      ? Promise.resolve(new Uint8Array(tree.bytes(path)))
      : Promise.reject(new Error(`no file ${path}`)),
  };
}

export async function runSession(job: SessionJob, send: (message: SessionMessage) => void): Promise<void> {
  const build = pathToFileURL(`${job.buildDir}/`).href;
  // Every file (render2d finds images among them); the sound files are unknown (null), as the
  // examples ship none yet and headless audio never plays them.
  const tree = directoryFiles(job.projectDir);
  const all = tree.all();
  const files: ProjectFiles = { list: () => all, read: (path) => tree.read(path) };
  const binary = projectBinaryFiles(tree);
  const compiled = new Map<string, string | undefined>();
  const trace: TraceContext = {
    build,
    sources: job.sources,
    // Source-mapped frames name the real path (the transpiler resolves symlinks when it writes maps).
    project: `${realpathSync(job.projectDir)}/`,
    read: (output) => {
      if (!compiled.has(output)) {
        try { compiled.set(output, readFileSync(join(job.buildDir, output), 'utf8')); } catch { compiled.set(output, undefined); }
      }
      return compiled.get(output);
    },
  };

  // Until a game starts, print() writes here; a started game writes to its harness (GameHarness.printed).
  let printed = '';
  const sink = (text: string): void => { printed += text; };
  let realms = 0;
  /** Forget the previous test's game; returns the new realm's number. */
  const freshRealm = (): number => {
    resetDeclarations();
    setActiveRandom(new SeededRandom(1));
    setPrintSink(sink);
    printed = '';
    return ++realms;
  };
  const load = async (output: string, realm: number): Promise<Readonly<Record<string, unknown>>> => {
    try {
      return await import(`${build}${output}?realm=${realm}`) as Record<string, unknown>;
    } catch (error) {
      throw importFailure(error, build, job.sources);
    }
  };
  const result = (
    base: Pick<TestResult, 'id' | 'file' | 'name' | 'title' | 'kind'>, outcome: Outcome, ms: number, harness?: GameHarness,
  ): TestResult => ({
    ...base,
    status: outcome.status,
    ms: Math.round(ms),
    diagnostics: outcome.diagnostics,
    traceback: outcome.stack === undefined ? [] : traceback(outcome.stack, outcome.site, trace),
    output: printed + (harness?.printed ?? ''),
    warnings: harness?.warnings ?? [],
    ...(job.observe && base.kind === 'playtest' && { observation: finalObservation(harness) }),
  });

  const skip = new Set(job.skip);
  for (const file of job.files) {
    const python = readFileSync(join(job.projectDir, file.source), 'utf8');
    let tests: Collected[];
    const started = performance.now();
    try {
      tests = collect(await load(file.output, freshRealm()), python);
    } catch (error) {
      if (!skip.has(file.source)) {
        const base = { id: file.source, file: file.source, name: '', title: file.source, kind: 'module' as const };
        send({ kind: 'result', result: result(base, outcomeOf(error), performance.now() - started) });
      }
      continue;
    }
    for (const test of tests) {
      const id = `${file.source}::${test.name}`;
      if (skip.has(id) || !matches(job.filter, id, test.title)) continue;
      const base = { id, file: file.source, name: test.name, title: test.title, kind: test.kind };
      send({ kind: 'begin', test: base });
      const begin = performance.now();
      const realm = freshRealm();
      let outcome: Outcome;
      let harness: GameHarness | undefined;
      try {
        const fn = (await load(file.output, realm))[test.name] as Function;
        if (test.kind === 'playtest') {
          harness = new GameHarness({
            loadEntry: async () => {
              const entry = job.entry;
              if (entry === null) fail('PP9502', 'The project has no game/main.py', { fix: 'Create game/main.py with `game = Game(...)`.' });
              for (const module of job.modules) await load(module, realm);
              return load(entry, realm);
            },
            files,
            assets: null,
            binary,
          });
          outcome = await runPlaytest(fn, test.name, harness);
        } else {
          outcome = await runPlainTest(fn);
        }
      } catch (error) {
        outcome = outcomeOf(error);
      }
      send({ kind: 'result', result: result(base, outcome, performance.now() - begin, harness) });
    }
  }
  send({ kind: 'end' });
}
