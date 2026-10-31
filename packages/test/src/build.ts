/**
 * Building a project for a test run: the transpiler (Python, standard library only) turns
 * every .py — the game and its tests — into ES modules, and `parallax check` validates
 * the data and generates the `project` module next to them. Asset files are not required:
 * playtests run headless and never load them.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkProject } from '@parallax/check';
import type { BuildManifest } from '@parallax/runtime/boot';
import { diagnostic } from '@parallax/runtime/core';
import type { Diagnostic, DiagnosticCode, Severity } from '@parallax/runtime/core';

const TRANSPILER_DIR = new URL('../../transpiler/', import.meta.url);

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

export interface TestBuild {
  readonly manifest?: BuildManifest;
  readonly diagnostics: readonly Diagnostic[];
}

export function buildForTests(projectDir: string, buildDir: string, python: string): TestBuild {
  const run = spawnSync(python, ['-m', 'parallax_transpiler', 'build', projectDir, buildDir, '--json'], {
    cwd: fileURLToPath(TRANSPILER_DIR), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error !== undefined) {
    return { diagnostics: [diagnostic('PP9510', `Could not run the transpiler: ${run.error.message}`, {
      fix: `Install Python 3.12+ as "${python}" (the transpiler needs only the standard library).`,
    })] };
  }
  const manifestPath = `${buildDir}/manifest.json`;
  // Exit 1 = the build has diagnostics; anything else, or no manifest, is a crash.
  if ((run.status !== 0 && run.status !== 1) || !existsSync(manifestPath)) {
    const detail = run.stderr.trim().split('\n').slice(-3).join(' | ');
    return { diagnostics: [diagnostic('PP9511', `The transpiler crashed (exit ${String(run.status)}): ${detail}`, {
      fix: 'This is a transpiler bug; report it with the project that triggers it.',
    })] };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TranspilerManifest;
  const diagnostics: Diagnostic[] = manifest.diagnostics.map((d) => diagnostic(d.code, d.message, {
    severity: d.severity, path: d.path, line: d.line, ...(d.fix !== null && { fix: d.fix }),
  }));
  diagnostics.push(...checkProject(projectDir, { outDir: buildDir, assetFiles: false }).diagnostics);
  return { manifest: { entry: manifest.entry, modules: manifest.modules }, diagnostics };
}
