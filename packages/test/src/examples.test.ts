/**
 * The examples' playtests — the acceptance suite. Opt-in, since most
 * examples wait on plugins that are not built yet: `PP_EXAMPLES=1 npx vitest run
 * src/examples.test.ts` (narrow with PP_EXAMPLES=paddle_duel,typing_game). Each example becomes
 * one Vitest test per playtest (`describePlaytests`), and a summary table is printed.
 */

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import type { ProjectTestReport } from './runner.js';
import { describePlaytests } from './vitest.js';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const wanted = process.env['PP_EXAMPLES'];
const names = wanted === undefined || wanted === ''
  ? []
  : readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${EXAMPLES}${e.name}/tests`))
    .map((e) => e.name)
    .filter((n) => wanted === '1' || wanted.split(',').includes(n))
    .sort();

/** Why an example's tests did not pass, in one line: the commonest first diagnostic. */
function cause(report: ProjectTestReport): string {
  const failing = report.results.filter((r) => r.status !== 'passed');
  const first = [...report.diagnostics.filter((d) => d.severity === 'error'), ...failing.flatMap((r) => r.diagnostics.slice(0, 1))];
  const counts = new Map<string, number>();
  for (const d of first) {
    const key = `${d.code} ${d.message.split('\n')[0]!.slice(0, 90)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n}× ${k}`).join(' | ');
}

describe.skipIf(names.length === 0)('examples', async () => {
  const rows: string[] = [];
  for (const name of names) {
    const r = await describePlaytests(`${EXAMPLES}${name}`, { timeout: 30 });
    const s = r.summary;
    rows.push(`${name.padEnd(24)} ${r.built ? 'built' : 'BUILD'}  ${String(s.passed).padStart(3)}/${String(s.total).padEnd(3)} ${r.ok ? 'ok' : cause(r)}`);
  }
  it('summary', () => { console.log(`\n${rows.join('\n')}\n`); });
});
