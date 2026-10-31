/**
 * `parallax test <project> [--filter TEXT] [--timeout SECONDS] [--out DIR] [--json] [--observe]`:
 * build the project, run its playtests, print the report. Exit 0 when every test passed.
 * `--observe` adds each playtest's final observation to the JSON report (agents).
 */

import process from 'node:process';
import { formatReport, reportJson } from './report.js';
import { runProjectTests } from './runner.js';
import type { RunOptions } from './runner.js';

const USAGE = 'Usage: parallax test <project> [--filter TEXT] [--timeout SECONDS] [--out DIR] [--json] [--observe]\n';

export async function main(argv: readonly string[]): Promise<number> {
  let project: string | undefined;
  let json = false;
  const options: { -readonly [K in keyof RunOptions]: RunOptions[K] } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string | undefined => argv[++i];
    if (arg === '--json') json = true;
    else if (arg === '--observe') options.observe = true;
    else if (arg === '--filter') options.filter = value();
    else if (arg === '--out') options.outDir = value();
    else if (arg === '--timeout') {
      const seconds = Number(value());
      if (!(seconds > 0)) { process.stderr.write(`--timeout needs a positive number of seconds\n${USAGE}`); return 2; }
      options.timeout = seconds;
    } else if (arg.startsWith('--') || project !== undefined) {
      process.stderr.write(`Unknown argument "${arg}"\n${USAGE}`);
      return 2;
    } else project = arg;
  }
  if (project === undefined || Object.values(options).some((v) => v === undefined)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const report = await runProjectTests(project, options);
  process.stdout.write(json ? reportJson(report) : formatReport(report));
  return report.ok ? 0 : 1;
}
