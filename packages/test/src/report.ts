/** Text and JSON forms of a test report (`parallax test`, `parallax test --json`). */

import type { Diagnostic } from '@parallax/runtime/core';
import type { TestResult } from './results.js';
import type { ProjectTestReport } from './runner.js';
import { formatFrames } from './traceback.js';

const MARK = { passed: 'PASS ', failed: 'FAIL ', error: 'ERROR' } as const;

function formatDiagnostic(d: Diagnostic, indent: string): string[] {
  const where = d.path === undefined ? '' : `  (${d.path}${d.line === undefined ? '' : `:${d.line}`})`;
  const [first, ...rest] = d.message.split('\n');
  const lines = [`${indent}${d.code}  ${first ?? ''}${where}`, ...rest.map((l) => `${indent}  ${l}`)];
  if (d.fix !== undefined) lines.push(`${indent}  Fix: ${d.fix}`);
  return lines;
}

export function formatResult(r: TestResult): string[] {
  const title = r.kind === 'playtest' ? `  "${r.title}"` : '';
  const lines = [`${MARK[r.status]}  ${r.id}${title}  (${r.ms} ms)`];
  if (r.status === 'passed') return lines;
  for (const d of r.diagnostics) lines.push(...formatDiagnostic(d, '       '));
  if (r.traceback.length > 0) {
    lines.push('       Traceback (most recent call last):');
    lines.push(...formatFrames(r.traceback, '         '));
  }
  if (r.output !== '') {
    lines.push('       Output:');
    for (const l of r.output.replace(/\n$/, '').split('\n')) lines.push(`         ${l}`);
  }
  return lines;
}

export function formatReport(report: ProjectTestReport): string {
  const lines: string[] = [];
  for (const d of report.diagnostics) lines.push(...formatDiagnostic(d, ''));
  for (const r of report.results) lines.push(...formatResult(r));
  const s = report.summary;
  lines.push(report.built
    ? `${s.passed} passed, ${s.failed} failed, ${s.errors} errors (${s.total} tests)`
    : 'The project did not build; no tests ran.');
  return `${lines.join('\n')}\n`;
}

export function reportJson(report: ProjectTestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
