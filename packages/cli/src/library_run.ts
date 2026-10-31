/**
 * `parallax library test`: every piece is proven on its own demo. A scratch project is the
 * piece's files (and its requirements', exactly as `library add` copies them) with the
 * piece's `demo/` laid over them — the demo is a small host game plus `tests/`, and may
 * override a copied data file (a config naming the demo's own scenes) — then
 * `parallax check` and the playtests run on it.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { checkProject } from '@parallax/check';
import { diagnostic, formatDiagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { formatResult, runProjectTests } from '@parallax/test';
import type { ProjectTestReport } from '@parallax/test';
import { applyAdd, planAdd } from './library.js';
import type { Library, Piece } from './library.js';

export interface PieceRun {
  readonly piece: string;
  readonly projectDir: string;
  readonly check: { readonly errors: number; readonly warnings: number; readonly diagnostics: readonly Diagnostic[] };
  readonly tests?: ProjectTestReport;
  readonly ok: boolean;
}

function demoFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'build') continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...demoFiles(`${dir}/${entry.name}`, `${path}/`));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Build the scratch project for `piece` (default: in a new temporary folder). */
export function scratchProject(library: Library, piece: Piece, into?: string): { dir: string; diagnostics: readonly Diagnostic[] } {
  const dir = into ?? mkdtempSync(`${tmpdir()}/parallax-library-${piece.id}-`);
  const plan = planAdd(library, dir, [piece.id], { requireProject: false });
  if (plan.diagnostics.some((d) => d.severity === 'error')) return { dir, diagnostics: plan.diagnostics };
  applyAdd(dir, plan);
  const demo = `${piece.dir}/demo`;
  if (existsSync(demo)) {
    for (const path of demoFiles(demo)) {
      mkdirSync(dirname(`${dir}/${path}`), { recursive: true });
      writeFileSync(`${dir}/${path}`, readFileSync(`${demo}/${path}`));
    }
  }
  return { dir, diagnostics: plan.diagnostics };
}

/** Check and playtest one piece on its demo. The scratch folder is removed when everything passed. */
export async function runPiece(library: Library, piece: Piece, options: { filter?: string; keep?: boolean } = {}): Promise<PieceRun> {
  const scratch = scratchProject(library, piece);
  const stop = (diagnostics: readonly Diagnostic[]): PieceRun => ({
    piece: piece.id, projectDir: scratch.dir,
    check: { errors: diagnostics.filter((d) => d.severity === 'error').length, warnings: 0, diagnostics }, ok: false,
  });
  if (scratch.diagnostics.some((d) => d.severity === 'error')) return stop(scratch.diagnostics);
  if (!existsSync(`${piece.dir}/demo/tests`) || !existsSync(`${piece.dir}/demo/game/main.py`)) {
    return stop([diagnostic('PP9590', `${piece.id} has no demo (demo/game/main.py and demo/tests/) — every piece proves itself with a playtest`, {
      path: `${piece.category}/${piece.id}`, fix: 'Add demo/: a small host game and tests/test_<piece>.py.',
    })]);
  }
  const checked = checkProject(scratch.dir, { outDir: false, assetFiles: piece.asset_files });
  const check = { errors: checked.errors, warnings: checked.warnings, diagnostics: checked.diagnostics };
  if (checked.errors > 0 || checked.warnings > 0) return { piece: piece.id, projectDir: scratch.dir, check, ok: false };
  const tests = await runProjectTests(scratch.dir, options.filter !== undefined ? { filter: options.filter } : {});
  if (tests.ok && options.keep !== true) rmSync(scratch.dir, { recursive: true, force: true });
  return { piece: piece.id, projectDir: scratch.dir, check, tests, ok: tests.ok };
}

export function formatRun(run: PieceRun): string {
  const tests = run.tests;
  const counts = tests === undefined ? 'playtests not run' : `${tests.summary.passed}/${tests.summary.total} playtests passed`;
  const lines = [`${run.ok ? 'PASS' : 'FAIL'}  ${run.piece}  (check: ${run.check.errors} errors, ${run.check.warnings} warnings; ${counts})`];
  if (!run.ok) {
    const indent = (text: string): string => text.replace(/^/gm, '    ');
    for (const d of run.check.diagnostics) lines.push(indent(formatDiagnostic(d)));
    for (const d of tests?.diagnostics ?? []) lines.push(indent(formatDiagnostic(d)));
    for (const r of tests?.results ?? []) if (r.status !== 'passed') lines.push(indent(formatResult(r).join('\n')));
    lines.push(`    scratch project kept at ${run.projectDir}`);
  }
  return lines.join('\n');
}
