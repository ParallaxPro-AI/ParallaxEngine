/**
 * `parallax check [project-dir] [--json] [--out DIR | --no-write] [--no-asset-files]`
 *
 * Exits 1 when there are errors. `--json` prints `{errors, warnings, diagnostics}` for
 * agents; text output is one block per diagnostic (code, location, fix, docs).
 */

import process from 'node:process';
import { checkProject, formatResult, resultJson } from './check.js';

export function main(argv: readonly string[]): number {
  let dir: string | undefined;
  let json = false;
  let outDir: string | false | undefined;
  let assetFiles = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--no-write') outDir = false;
    else if (arg === '--no-asset-files') assetFiles = false;
    else if (arg === '--out') outDir = argv[++i];
    else if (arg.startsWith('-')) {
      process.stdout.write(`Unknown option ${arg}\n`);
      return 2;
    } else dir = arg;
  }
  const result = checkProject(dir ?? process.cwd(), { assetFiles, ...(outDir !== undefined && { outDir }) });
  process.stdout.write(`${json ? resultJson(result) : formatResult(result)}\n`);
  return result.errors > 0 ? 1 : 0;
}
