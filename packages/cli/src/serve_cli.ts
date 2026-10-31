/**
 * `parallax serve` (a game's match server) and `parallax serve-relay` (the WebRTC
 * signalling relay for browser-hosted matches and lobbies). Both bind 127.0.0.1 unless
 * `--host` says otherwise.
 *
 * `serve` stops gracefully on SIGTERM (no new players; it exits once the last player has
 * left, or after `--drain-seconds`); SIGINT, or a second signal, stops at once.
 */

import process from 'node:process';
import { formatDiagnostic } from '@parallax/runtime/core';
import { SignalingRelay } from '@parallax/server';
import { serveProject } from './serve.js';

export const DEFAULT_SERVE_PORT = 5190;
export const DEFAULT_RELAY_PORT = 5191;

export const SERVE_USAGE = `Usage:
  parallax serve <project> [--host H] [--port N] [--seed N] [--drain-seconds N]
                 [--ticket-secret-env NAME --match ID]
                 run the game's authoritative match server (players join with ?net=join&server=ws://…);
                 GET /healthz and /status on the same port; SIGTERM drains, SIGINT stops
  parallax serve-relay [--host H] [--port N]
                 the signalling relay browser-hosted matches use (?net=host&signal=ws://…)
`;

export interface ServeArgs {
  readonly dir: string;
  readonly host: string;
  readonly port: number;
  readonly seed?: number;
  readonly drainSeconds: number;
  /** The environment variable holding the ticket secret (never the secret itself: argv is visible to every user). */
  readonly ticketSecretEnv?: string;
  readonly match?: string;
}

export interface RelayArgs {
  readonly host: string;
  readonly port: number;
}

type Values = Record<string, string>;

/** `--name value` pairs (the names in `allowed`) and positionals, or what was wrong. */
function options(argv: readonly string[], allowed: readonly string[]): { values: Values; positional: string[] } | string {
  const values: Values = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!allowed.includes(arg)) return `Unknown option ${arg}`;
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
    values[arg] = value;
  }
  return { values, positional };
}

function port(value: string | undefined, fallback: number): number | string {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : '--port needs a port number';
}

export function serveArgs(argv: readonly string[]): ServeArgs | string {
  const parsed = options(argv, ['--host', '--port', '--seed', '--drain-seconds', '--ticket-secret-env', '--match']);
  if (typeof parsed === 'string') return parsed;
  const { values, positional } = parsed;
  if (positional.length > 1) return `Unexpected argument ${positional[1]!}`;
  const p = port(values['--port'], DEFAULT_SERVE_PORT);
  if (typeof p === 'string') return p;
  const seed = values['--seed'] === undefined ? undefined : Number(values['--seed']);
  if (seed !== undefined && !Number.isInteger(seed)) return '--seed needs a whole number';
  const drain = Number(values['--drain-seconds'] ?? 300);
  if (!Number.isFinite(drain) || drain < 0) return '--drain-seconds needs a number of seconds';
  const env = values['--ticket-secret-env'];
  const match = values['--match'];
  if (env !== undefined && match === undefined) return '--ticket-secret-env needs --match (the match id the tickets name)';
  if (match !== undefined && env === undefined) return '--match is for tickets: pass --ticket-secret-env too';
  return {
    dir: positional[0] ?? process.cwd(), host: values['--host'] ?? '127.0.0.1', port: p, drainSeconds: drain,
    ...(seed !== undefined && { seed }), ...(env !== undefined && { ticketSecretEnv: env }), ...(match !== undefined && { match }),
  };
}

export function relayArgs(argv: readonly string[]): RelayArgs | string {
  const parsed = options(argv, ['--host', '--port']);
  if (typeof parsed === 'string') return parsed;
  if (parsed.positional.length > 0) return `Unexpected argument ${parsed.positional[0]!}`;
  const p = port(parsed.values['--port'], DEFAULT_RELAY_PORT);
  if (typeof p === 'string') return p;
  return { host: parsed.values['--host'] ?? '127.0.0.1', port: p };
}

/** Calls `handle` on every SIGINT / SIGTERM until the returned remover runs. */
function onSignals(handle: (signal: 'SIGINT' | 'SIGTERM') => void): () => void {
  const int = (): void => handle('SIGINT');
  const term = (): void => handle('SIGTERM');
  process.on('SIGINT', int);
  process.on('SIGTERM', term);
  return () => { process.off('SIGINT', int); process.off('SIGTERM', term); };
}

const usage = (message: string): number => {
  process.stderr.write(`${message}\n\n${SERVE_USAGE}`);
  return 2;
};

export async function serveMain(argv: readonly string[]): Promise<number> {
  const args = serveArgs(argv);
  if (typeof args === 'string') return usage(args);
  let secret: string | undefined;
  if (args.ticketSecretEnv !== undefined) {
    secret = process.env[args.ticketSecretEnv];
    if (secret === undefined || secret === '') return usage(`The environment variable ${args.ticketSecretEnv} is not set`);
  }
  let server;
  try {
    server = await serveProject(args.dir, {
      host: args.host, port: args.port,
      ...(args.seed !== undefined && { seed: args.seed }),
      ...(secret !== undefined && { ticketSecret: secret, match: args.match! }),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  server.diagnostics.filter((d) => d.severity === 'warning').forEach((d) => process.stderr.write(`${formatDiagnostic(d)}\n`));
  server.warnings.forEach((d) => process.stderr.write(`${formatDiagnostic(d)}\n`));
  const http = server.url.replace(/^ws:/, 'http:');
  process.stdout.write(`Serving ${server.sim.info.gameId} on ${server.url}${secret !== undefined ? `match/${args.match!}?ticket=…` : ''}\n`
    + `Players join with ?net=join&server=${server.url}; health: ${http}healthz\n`);
  const stop = onSignals((signal) => {
    if (signal === 'SIGTERM' && server.status().accepting) {
      process.stderr.write(`Draining: no new players; stopping once the last one leaves (at most ${args.drainSeconds} s). Signal again to stop now.\n`);
      void server.drain({ timeoutSeconds: args.drainSeconds });
    } else {
      server.stop();
    }
  });
  await server.stopped;
  stop();
  if (server.crashed !== null) {
    process.stderr.write(`The match stopped: ${server.crashed}\n`);
    return 1;
  }
  return 0;
}

export async function relayMain(argv: readonly string[]): Promise<number> {
  const args = relayArgs(argv);
  if (typeof args === 'string') return usage(args);
  let relay: SignalingRelay;
  try {
    relay = await SignalingRelay.listen({ host: args.host, port: args.port });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const shown = args.host.includes(':') ? `[${args.host}]` : args.host;
  const url = `ws://${shown}:${relay.port}/`;
  process.stdout.write(`Signalling relay on ${url}\nHost a match with ?net=host&signal=${url} (or ?net=lobby&signal=${url})\n`);
  await new Promise<void>((done) => {
    const stop = onSignals(() => { stop(); relay.close(); done(); });
  });
  return 0;
}
