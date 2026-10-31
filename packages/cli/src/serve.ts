/**
 * `parallax serve`: a game's authoritative match server (`@parallax/server`'s `serveGame`)
 * from a project folder (built first). One process is one match.
 *
 * The game's compiled modules and the server are bundled into one Node module (written to a
 * temp folder), so the game and the server share one engine runtime. Players connect with a
 * WebSocket to the port; plain HTTP on it answers `GET /healthz` and `GET /status`. With a
 * ticket secret, only players holding a valid, unspent ticket for this match get in
 * (`ticketGate`): `ws://host:port/match/<id>?ticket=…`.
 *
 * A host's own match container calls `serveProject(dir, { port, host: '0.0.0.0',
 * ticketSecret, match })`, then `server.drain()` on SIGTERM: no new players, the match
 * runs until the last one leaves (or the timeout), then the port closes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { directoryFiles } from '@parallax/check';
import { fail, formatDiagnostic } from '@parallax/runtime/core';
import type { BinaryFiles, Diagnostic, ProjectFiles } from '@parallax/runtime/core';
import type { GameServer, ServeOptions, TicketGateOptions } from '@parallax/server';
import { buildProject } from './build.js';
import { importForNode } from './bundle.js';
import { SERVER_ENTRY } from './paths.js';

export interface MatchServerOptions {
  /** Default 0 (any free port). */
  readonly port?: number;
  /** Default 127.0.0.1 (this machine only); 0.0.0.0 to accept players from other machines. */
  readonly host?: string;
  /** Admit only players with a ticket signed with this secret (`signTicket`) for `match`. */
  readonly ticketSecret?: string;
  /** This match's id: tickets name it. Needed with `ticketSecret`. */
  readonly match?: string;
  readonly seed?: number;
  /** Where the game's print() output goes (default: stdout). */
  readonly print?: (text: string) => void;
  /** Python for building a project folder (default python3). */
  readonly python?: string;
}

export interface MatchServer extends GameServer {
  /** `ws://host:port/`. */
  readonly url: string;
  /** The build's warnings. */
  readonly diagnostics: readonly Diagnostic[];
}

/** What the match server bundle exports: the game's entry and the server, on one runtime. */
interface ServerBundle {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly serveGame: (options: ServeOptions) => Promise<GameServer>;
  readonly ticketGate: (options: TicketGateOptions) => NonNullable<ServeOptions['gate']>;
}

/** A game's files as the match server reads them: data as text, models as bytes. */
interface GameFiles {
  readonly files: ProjectFiles;
  readonly binary: BinaryFiles;
}

/** A missing binary file rejects, as a missing file does in the browser. */
const missing = (path: string): Promise<Uint8Array> => Promise.reject(new Error(`no file ${path}`));

/** A project tree on disk. */
function treeBinary(tree: { exists(path: string): boolean; bytes(path: string): Uint8Array }): BinaryFiles {
  return { read: (path) => (tree.exists(path) ? Promise.resolve(new Uint8Array(tree.bytes(path))) : missing(path)) };
}


/** The compiled build and the project's files, after building it. */
function gameOf(dir: string, scratch: string, python: string | undefined): GameFiles & { buildDir: string; assets: readonly string[]; diagnostics: readonly Diagnostic[] } {
  if (!existsSync(`${dir}/game/main.py`)) {
    fail('PP9570', `${dir} is not a project (no game/main.py)`, {
      fix: 'Pass the project folder.',
    });
  }
  const build = buildProject(dir, { outDir: scratch, ...(python !== undefined && { python }) });
  if (build.errors > 0) {
    const errors = build.diagnostics.filter((d) => d.severity === 'error');
    fail('PP9571', `The project has ${errors.length} build error${errors.length === 1 ? '' : 's'}:\n${errors.map(formatDiagnostic).join('\n')}`, {
      fix: 'Fix them (`parallax check` lists them), then serve again.',
    });
  }
  const tree = directoryFiles(dir);
  return { buildDir: scratch, files: tree, binary: treeBinary(tree), assets: tree.all(), diagnostics: build.diagnostics };
}

/** Start the match server for a project or export folder (see the file comment). */
export async function serveProject(dir: string, options: MatchServerOptions = {}): Promise<MatchServer> {
  const root = resolve(dir);
  if (options.ticketSecret !== undefined && (options.match === undefined || options.match === '')) {
    fail('PP9572', 'A ticket secret needs the match id the tickets name', { fix: 'Pass the match id (`--match ID`) with the ticket secret.' });
  }
  if (options.ticketSecret === '') fail('PP9572', 'The ticket secret is empty', { fix: 'Set the secret, or serve without tickets.' });
  const scratch = mkdtempSync(`${tmpdir()}/parallax-serve-`);
  try {
    const game = gameOf(root, `${scratch}/build`, options.python);
    const bundle = await importForNode<ServerBundle>(game.buildDir, [
      `export { serveGame, ticketGate } from ${JSON.stringify(SERVER_ENTRY)};`,
    ], `${scratch}/server.mjs`);
    const host = options.host ?? '127.0.0.1';
    const server = await bundle.serveGame({
      entry: bundle.entry, files: game.files, binary: game.binary, assets: game.assets, host,
      ...(options.port !== undefined && { port: options.port }),
      ...(options.seed !== undefined && { seed: options.seed }),
      ...(options.print !== undefined && { print: options.print }),
      ...(options.ticketSecret !== undefined && { gate: bundle.ticketGate({ secret: options.ticketSecret, match: options.match! }) }),
    });
    const shown = host.includes(':') ? `[${host}]` : host;
    return Object.assign(Object.create(server) as GameServer, { url: `ws://${shown}:${server.port}/`, diagnostics: game.diagnostics }) as MatchServer;
  } finally {
    // The bundle is imported; the build was read. Nothing in the folder is needed any more.
    rmSync(scratch, { recursive: true, force: true });
  }
}
