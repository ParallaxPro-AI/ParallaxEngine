/**
 * The `parallax` command.
 *
 *   parallax new   <dir> [--template NAME | --example NAME] [--name TITLE] | --list
 *   parallax build <project> [--out DIR] [--no-asset-files] [--bundle] [--json]
 *   parallax check <project> [--json] [--out DIR | --no-write] [--no-asset-files] [--no-compile]
 *   parallax edit  <project> [--port N] [--host H] [--no-open] [--out DIR] [--no-asset-files]
 *   parallax serve <project> [--host H] [--port N] [--ticket-secret-env NAME --match ID]
 *   parallax serve-relay [--host H] [--port N]
 *   parallax test  <project> [args for @parallax/test]
 *   parallax screenshot <project> [--out FILE.png] [--seconds N] [--shots N] [--keys STEPS] [--json] …
 *   parallax library list | search <words>... | add <piece>... <project> | test [<piece>...]
 *
 * Exit codes: 0 ok, 1 the project has errors (`new`: the folder is in use), 2 bad usage.
 */

import process from 'node:process';
import { formatResult, resultJson } from '@parallax/check';
import { main as testMain } from '@parallax/test';
import { buildProject, checkCommand } from './build.js';
import type { BuildOptions } from './build.js';
import { edit, summary } from './edit.js';
import { libraryMain } from './library_cli.js';
import { relayMain, serveMain } from './serve_cli.js';
import { screenshotMain } from './screenshot.js';
import { newMain } from './new.js';
import { packSummary } from './pack.js';

const USAGE = `Usage:
  parallax new   <dir> [--template NAME | --example NAME] [--name TITLE] | --list
                 start a project from a template (blank-2d, blank-3d, arcade-2d)
                 or from a copy of a complete example game (--list shows them)
  parallax build <project> [--out DIR] [--no-asset-files] [--bundle] [--json]
  parallax check <project> [--json] [--out DIR | --no-write] [--no-asset-files] [--no-compile]
  parallax edit  <project> [--port N] [--host H] [--no-open] [--out DIR] [--no-asset-files]
                 the editor: scenes in a viewport, inspector, assets; Play runs the game in place
  parallax serve <project> [--host H] [--port N] [--seed N] [--drain-seconds N]
                 [--ticket-secret-env NAME --match ID]
                 the game's authoritative match server; GET /healthz on the same port
  parallax serve-relay [--host H] [--port N]
                 the signalling relay for browser-hosted matches (?net=host&signal=ws://…)
  parallax test  <project> [options for @parallax/test]
  parallax screenshot <project> [--out FILE.png] [--seconds N] [--shots N] [--every S]
                 [--width W] [--height H] [--keys STEPS] [--seed N] [--timeout S] [--gl auto|gpu|software] [--json]
                 run the game in headless Chrome and write PNGs; --keys "KeyW:2,Space,wait:1,click"
  parallax library list | search <words>... | add <piece>... <project> | test [<piece>...]
`;

interface Parsed {
  project?: string;
  json: boolean;
  open: boolean;
  outDir?: string;
  assetFiles: boolean;
  port?: number;
  host?: string;
  bundle: boolean;
}

function parse(argv: readonly string[], allowed: readonly string[]): Parsed | string {
  const out: Parsed = { json: false, open: true, assetFiles: true, bundle: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--') && !allowed.includes(arg)) return `Unknown option ${arg}`;
    const value = (): string | undefined => argv[++i];
    if (arg === '--json') out.json = true;
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--no-asset-files') out.assetFiles = false;
    else if (arg === '--bundle') out.bundle = true;
    else if (arg === '--out') { const v = value(); if (v === undefined) return '--out needs a folder'; out.outDir = v; }
    else if (arg === '--host') { const v = value(); if (v === undefined) return '--host needs a value'; out.host = v; }
    else if (arg === '--port') {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 0 || v > 65535) return '--port needs a port number';
      out.port = v;
    } else if (arg.startsWith('-')) return `Unknown option ${arg}`;
    else if (out.project === undefined) out.project = arg;
    else return `Unexpected argument ${arg}`;
  }
  return out;
}

function buildOptions(p: Parsed): BuildOptions {
  return { assetFiles: p.assetFiles, bundle: p.bundle, ...(p.outDir !== undefined && { outDir: p.outDir }) };
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const usage = (message?: string): number => {
    process.stderr.write(`${message !== undefined ? `${message}\n\n` : ''}${USAGE}`);
    return 2;
  };
  switch (command) {
    case 'build': {
      const p = parse(rest, ['--out', '--no-asset-files', '--json', '--bundle']);
      if (typeof p === 'string') return usage(p);
      const result = buildProject(p.project ?? process.cwd(), buildOptions(p));
      process.stdout.write(`${p.json
        ? JSON.stringify({
          errors: result.errors, warnings: result.warnings, buildDir: result.buildDir, diagnostics: result.diagnostics,
          ...(result.bundles !== undefined && { bundles: result.bundles.groups, loose: result.bundles.loose }),
        }, null, 2)
        : [summary(result), ...(result.bundles !== undefined ? [packSummary(result.bundles)] : [])].join('\n')}\n`);
      return result.errors > 0 ? 1 : 0;
    }
    case 'check': {
      const noWrite = rest.includes('--no-write');
      const noCompile = rest.includes('--no-compile');
      const p = parse(rest.filter((a) => a !== '--no-write' && a !== '--no-compile'), ['--out', '--no-asset-files', '--json']);
      if (typeof p === 'string') return usage(p);
      if (noWrite && p.outDir !== undefined) return usage('--out and --no-write are exclusive');
      const result = checkCommand(p.project ?? process.cwd(), {
        assetFiles: p.assetFiles, compile: !noCompile,
        ...(noWrite ? { outDir: false } : p.outDir !== undefined && { outDir: p.outDir }),
      });
      process.stdout.write(`${p.json ? resultJson(result) : formatResult(result)}\n`);
      return result.errors > 0 ? 1 : 0;
    }
    case 'edit': {
      const p = parse(rest, ['--out', '--no-asset-files', '--port', '--host', '--no-open']);
      if (typeof p === 'string') return usage(p);
      const session = await edit(p.project ?? process.cwd(), {
        ...buildOptions(p), open: p.open,
        ...(p.port !== undefined && { port: p.port }),
        ...(p.host !== undefined && { host: p.host }),
      });
      await new Promise<void>((done) => {
        const stop = (): void => { void session.close().then(done); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      return 0;
    }
    case 'serve':
      return serveMain(rest);
    case 'serve-relay':
      return relayMain(rest);
    case 'test':
      return testMain(rest);
    case 'screenshot':
      return screenshotMain(rest);
    case 'library':
      return libraryMain(rest);
    case 'new':
      return newMain(rest);
    case undefined:
    case '--help':
    case 'help':
      return usage();
    default:
      return usage(`Unknown command ${command}`);
  }
}
