/**
 * `parallax build`: compile the project's Python to ES modules (the transpiler, in Python),
 * run `parallax check` (validation + the generated `project` module), then link-check the
 * output. One list of coded diagnostics comes back; the build is usable when it has no errors.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkProject } from '@parallax/check';
import { diagnostic } from '@parallax/runtime/core';
import type { Diagnostic, DiagnosticCode, Severity } from '@parallax/runtime/core';
import type { BuildManifest } from '@parallax/runtime/boot';
import { checkLinks } from './link.js';
import { packProject } from './pack.js';
import type { PackResult } from './pack.js';
import { TRANSPILER_DIR } from './paths.js';

export interface BuildOptions {
  /** Default `<project>/build`. */
  readonly outDir?: string;
  /** Check that every asset handle has a file (default true). */
  readonly assetFiles?: boolean;
  readonly python?: string;
  /** Also pack the served files into content-addressed bundles in `<build>/bundles/` (`--bundle`). */
  readonly bundle?: boolean;
}

export interface BuildResult {
  readonly projectDir: string;
  readonly buildDir: string;
  /** Absent when the transpiler could not run at all. */
  readonly manifest?: BuildManifest;
  readonly diagnostics: readonly Diagnostic[];
  readonly errors: number;
  readonly warnings: number;
  /** With `bundle`: what was packed (absent when the transpiler could not run). */
  readonly bundles?: PackResult;
}

/** The transpiler's diagnostic JSON (`Diagnostic.to_json` in parallax_transpiler). */
interface TranspilerDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;
  readonly path: string;
  readonly line: number;
  readonly fix: string | null;
}

interface TranspilerManifest extends BuildManifest {
  readonly diagnostics: readonly TranspilerDiagnostic[];
}

/** Delete the previous build's modules, so a deleted .py leaves no stale .js behind. */
function removeStale(buildDir: string): void {
  const path = `${buildDir}/manifest.json`;
  if (!existsSync(path)) return;
  const previous = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildManifest>;
  for (const m of previous.modules ?? []) {
    if (typeof m.output === 'string' && m.output.endsWith('.js') && !m.output.split('/').includes('..')) {
      rmSync(`${buildDir}/${m.output}`, { force: true });
      rmSync(`${buildDir}/${m.output}.map`, { force: true }); // its source map (transpiler build.py)
    }
  }
}

function compile(projectDir: string, buildDir: string, python: string): { manifest?: TranspilerManifest; diagnostics: Diagnostic[] } {
  const result = spawnSync(python, ['-m', 'parallax_transpiler', 'build', projectDir, buildDir, '--json'], {
    cwd: TRANSPILER_DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return { diagnostics: [diagnostic('PP9510', `Could not run the transpiler: ${result.error.message}`, {
      fix: `Install Python 3.12+ as "${python}" (the transpiler needs only the standard library).`,
    })] };
  }
  const manifestPath = `${buildDir}/manifest.json`;
  // Exit 1 = the build has diagnostics; anything else, or no manifest, is a crash.
  if ((result.status !== 0 && result.status !== 1) || !existsSync(manifestPath)) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' | ');
    return { diagnostics: [diagnostic('PP9511', `The transpiler crashed (exit ${String(result.status)}): ${detail}`, {
      fix: 'This is a transpiler bug; report it with the project that triggers it.',
    })] };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TranspilerManifest;
  return {
    manifest,
    diagnostics: manifest.diagnostics.map((d) => diagnostic(d.code, d.message, {
      severity: d.severity, path: d.path, line: d.line, ...(d.fix !== null && { fix: d.fix }),
    })),
  };
}

function key(d: Diagnostic): string {
  return [d.code, d.path ?? '', d.line ?? '', d.pointer ?? '', d.message].join('\u0000');
}

export function buildProject(project: string, options: BuildOptions = {}): BuildResult {
  const projectDir = resolve(project);
  const buildDir = resolve(options.outDir ?? `${projectDir}/build`);
  if (!existsSync(projectDir)) {
    const d = diagnostic('PP9512', `There is no project at ${projectDir}`, { fix: 'Pass the folder that holds game/main.py.' });
    return { projectDir, buildDir, diagnostics: [d], errors: 1, warnings: 0 };
  }
  removeStale(buildDir);
  const compiled = compile(projectDir, buildDir, options.python ?? 'python3');
  const all: Diagnostic[] = [...compiled.diagnostics];
  if (compiled.manifest !== undefined) {
    if (compiled.manifest.entry === null) {
      all.push(diagnostic('PP9502', 'The project has no game/main.py', { fix: 'Create game/main.py with `game = Game(...)`.' }));
    }
    const checked = checkProject(projectDir, { outDir: buildDir, assetFiles: options.assetFiles ?? true });
    all.push(...checked.diagnostics);
    all.push(...checkLinks(buildDir, compiled.manifest));
  }
  const seen = new Set<string>();
  const diagnostics = all.filter((d) => !seen.has(key(d)) && seen.add(key(d)) !== undefined);
  const bundles = options.bundle === true && compiled.manifest !== undefined ? packProject(projectDir, `${buildDir}/bundles`) : undefined;
  return {
    projectDir,
    buildDir,
    ...(bundles !== undefined && { bundles }),
    ...(compiled.manifest !== undefined && { manifest: { entry: compiled.manifest.entry, modules: compiled.manifest.modules } }),
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
  };
}

export interface CheckCommandOptions {
  /** Where check writes declarations/project.js and the transpiler its modules; false = a temp dir. Default `<project>/build`. */
  readonly outDir?: string | false;
  readonly assetFiles?: boolean;
  /** Run the transpiler too (default true); `--no-compile` is the fast data-only check. */
  readonly compile?: boolean;
  readonly python?: string;
}

/**
 * `parallax check`: the checker plus (by default) the transpiler, so one command reports every
 * diagnostic a build would — compile errors included — without the link pass or bundles.
 */
export function checkCommand(project: string, options: CheckCommandOptions = {}): { diagnostics: readonly Diagnostic[]; errors: number; warnings: number } {
  const projectDir = resolve(project);
  const all: Diagnostic[] = [];
  if (options.compile !== false && existsSync(projectDir)) {
    const temp = options.outDir === false ? mkdtempSync(`${tmpdir()}/parallax-check-`) : undefined;
    const buildDir = temp ?? resolve(typeof options.outDir === 'string' ? options.outDir : `${projectDir}/build`);
    try {
      if (temp === undefined) removeStale(buildDir);
      all.push(...compile(projectDir, buildDir, options.python ?? 'python3').diagnostics);
    } finally {
      if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
    }
  }
  const checked = checkProject(projectDir, { assetFiles: options.assetFiles ?? true, ...(options.outDir !== undefined && { outDir: options.outDir }) });
  all.push(...checked.diagnostics);
  const seen = new Set<string>();
  const diagnostics = all.filter((d) => !seen.has(key(d)) && seen.add(key(d)) !== undefined);
  return {
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
  };
}
