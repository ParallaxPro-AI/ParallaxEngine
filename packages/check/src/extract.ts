/** Running the transpiler's extract pass (Python, standard library only) over a project. */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import type { Declarations } from './declarations.js';

/** packages/transpiler, next to this package. */
export const TRANSPILER_DIR = fileURLToPath(new URL('../../transpiler/', import.meta.url));

export type ExtractResult =
  | { readonly ok: true; readonly declarations: Declarations; readonly text: string }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

export function runExtract(projectDir: string, python = 'python3'): ExtractResult {
  // The pass runs from the transpiler's directory, so a relative project path is resolved here.
  const result = spawnSync(python, ['-m', 'parallax_transpiler.extract', resolve(projectDir), '--out', '-'], {
    cwd: TRANSPILER_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return {
      ok: false,
      diagnostic: diagnostic('PP9001', `Could not run the declarations pass: ${result.error.message}`, {
        fix: `Install Python 3.12+ as "${python}" (the transpiler needs only the standard library).`,
      }),
    };
  }
  // Exit 1 means "the document has error diagnostics"; anything else without output is a crash.
  if (result.stdout.trim() === '') {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' | ');
    return {
      ok: false,
      diagnostic: diagnostic('PP9001', `The declarations pass crashed (exit ${String(result.status)}): ${detail}`, {
        fix: 'This is a transpiler bug; report it with the project that triggers it.',
      }),
    };
  }
  return { ok: true, declarations: JSON.parse(result.stdout) as Declarations, text: result.stdout };
}

/** Extract diagnostics in the shared shape (line kept; the column is in the JSON document). */
export function extractDiagnostics(declarations: Declarations): Diagnostic[] {
  return declarations.diagnostics.map((d) => diagnostic(d.code, d.message, {
    severity: d.severity,
    path: d.path,
    line: d.line,
    ...(d.fix !== null && { fix: d.fix }),
  }));
}
