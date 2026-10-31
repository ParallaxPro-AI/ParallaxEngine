/**
 * A project's playtests as Vitest tests: one `it` per collected test, failing with the
 * harness's report. The whole project runs once, up front (top-level await):
 *
 *     await describePlaytests(new URL('../../../examples/paddle_duel', import.meta.url).pathname);
 */

import { describe, it } from 'vitest';
import { formatReport, formatResult } from './report.js';
import { runProjectTests } from './runner.js';
import type { ProjectTestReport, RunOptions } from './runner.js';

export async function describePlaytests(dir: string, options: RunOptions = {}): Promise<ProjectTestReport> {
  const report = await runProjectTests(dir, options);
  describe(`playtests: ${report.projectDir}`, () => {
    it('builds', () => {
      if (!report.built || report.diagnostics.some((d) => d.severity === 'error')) throw new Error(formatReport(report));
    });
    for (const result of report.results) {
      it(`${result.id}${result.kind === 'playtest' ? ` "${result.title}"` : ''}`, () => {
        if (result.status !== 'passed') throw new Error(formatResult(result).join('\n'));
      });
    }
  });
  return report;
}
