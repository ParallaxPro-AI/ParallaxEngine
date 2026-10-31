/**
 * A dedicated game server: the game, headless, as the authority (`net` session role
 * "server"), with players connecting over WebSockets. The same kernel and game code as
 * the browser, minus devices and drawing.
 *
 * This is the smallest orchestrator over `SimAdapter`: a port, an optional admission gate
 * (match tickets), a loop that runs frames at a fixed 60 Hz on wall time, a health check
 * and a graceful drain. Fleets with more to do drive `createMatchSim` themselves.
 *
 * Plain HTTP on the same port (anything that isn't a WebSocket upgrade):
 *
 *   GET /healthz   200 `{"ok": true, …status}` while the match runs (draining included);
 *                  503 once it crashed or stopped
 *   GET /status    the match's `MatchStatus` as JSON, always 200
 *
 * The caller loads the game (its compiled entry module's exports) the way any host does —
 * the `parallax` CLI bundles it, the playtest harness uses module hooks — and hands it
 * here with the project's files.
 */

import type { GameRuntime } from '@parallax/runtime/api';
import type { BinaryFiles, Diagnostic, NetLink, ProjectFiles } from '@parallax/runtime/core';
import { Admission, createMatchSim } from './sim_adapter.js';
import type { AdmissionGate, MatchStatus, SimAdapter } from './sim_adapter.js';
import { WebSocketListener } from './websocket.js';
import type { WebSocketListenerOptions } from './websocket.js';

/** Seconds per server frame. */
export const SERVER_FRAME = 1 / 60;
/** Frames run at most per wake-up when the process fell behind (the rest is dropped). */
const MAX_CATCH_UP = 5;

export interface ServeOptions {
  /** The loaded entry module's exports (`game = Game(...)` among them). */
  readonly entry: Readonly<Record<string, unknown>>;
  readonly files: ProjectFiles;
  /** Every project file path, or null when unknown. */
  readonly assets?: readonly string[] | null;
  /** A 3D game's binary files (models), by project path (default none). */
  readonly binary?: BinaryFiles;
  /** Default 0 (any free port). */
  readonly port?: number;
  /** Default 127.0.0.1; 0.0.0.0 to accept other machines. */
  readonly host?: string;
  readonly seed?: number;
  /** Who may play (e.g. `ticketGate(...)`); without one, anyone, named as their hello says. */
  readonly gate?: AdmissionGate<NetLink & { readonly path: string }>;
  /** Where the game's print() output goes (default: stdout). */
  readonly print?: (text: string) => void;
}

export interface DrainOptions {
  /** Stop after this many seconds even if players remain (default 300). */
  readonly timeoutSeconds?: number;
}

export interface GameServer {
  readonly port: number;
  readonly runtime: GameRuntime;
  readonly sim: SimAdapter;
  readonly warnings: readonly Diagnostic[];
  /** The error that stopped the frame loop, if one did. */
  readonly crashed: string | null;
  status(): MatchStatus;
  /**
   * Take no new players (a dropped player may still come back to a held seat), keep running
   * until the last player has left (or the timeout), then stop. Resolves once stopped.
   */
  drain(options?: DrainOptions): Promise<void>;
  /** Resolves once the server has stopped (a stop, a finished drain or a crash). */
  readonly stopped: Promise<void>;
  /** Stop the loop, tell clients, close the port. */
  stop(): void;
}

/** The `/healthz` and `/status` answers (503 before the match has started); false for any other request (the listener's 426). */
function healthRoutes(status: () => MatchStatus | undefined, running: () => boolean): NonNullable<WebSocketListenerOptions['onRequest']> {
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || (path !== '/healthz' && path !== '/status')) return false;
    const now = status();
    const ok = now !== undefined && (path === '/status' || running());
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(now === undefined ? { ok: false, starting: true } : path === '/healthz' ? { ok, ...now } : now));
    return true;
  };
}

export async function serveGame(options: ServeOptions): Promise<GameServer> {
  let sim: SimAdapter | undefined;
  let running = true;
  const listener = await WebSocketListener.listen({
    ...(options.port !== undefined && { port: options.port }),
    ...(options.host !== undefined && { host: options.host }),
    onRequest: healthRoutes(() => sim?.status(), () => running && sim?.status().crashed === null),
  });
  try {
    sim = await createMatchSim({
      entry: options.entry,
      files: options.files,
      ...(options.assets !== undefined && { assets: options.assets }),
      ...(options.binary !== undefined && { binary: options.binary }),
      seed: options.seed ?? 1,
      fixedStep: SERVER_FRAME,
      print: options.print ?? ((text) => { process.stdout.write(text); }),
    });
  } catch (error) {
    listener.close();
    throw error;
  }
  const match = sim;
  let markStopped = (): void => {};
  const stopped = new Promise<void>((done) => { markStopped = done; });
  const pump = options.gate === undefined
    ? () => { for (const link of listener.accept()) match.admit(link); }
    : (() => { const admission = new Admission(listener, options.gate, match); return () => admission.pump(); })();

  let last = performance.now();
  let behind = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    behind += (now - last) / 1000;
    last = now;
    pump();
    let frames = 0;
    while (behind >= SERVER_FRAME && frames < MAX_CATCH_UP) {
      match.step(SERVER_FRAME);
      behind -= SERVER_FRAME;
      frames++;
    }
    if (frames === MAX_CATCH_UP) behind = Math.min(behind, SERVER_FRAME);
    if (match.status().crashed !== null) server.stop();
  }, 1000 * SERVER_FRAME);

  let draining: Promise<void> | undefined;
  const server: GameServer = {
    port: listener.port,
    runtime: match.runtime,
    sim: match,
    warnings: match.warnings,
    get crashed() { return match.status().crashed; },
    status: () => match.status(),
    stopped,
    drain(drainOptions = {}) {
      if (draining !== undefined) return draining;
      match.drain();
      const deadline = performance.now() + (drainOptions.timeoutSeconds ?? 300) * 1000;
      draining = new Promise<void>((done) => {
        const check = setInterval(() => {
          const now = match.status();
          if (!running || now.players + now.away === 0 || performance.now() >= deadline) {
            clearInterval(check);
            server.stop();
            done();
          }
        }, 250);
      });
      return draining;
    },
    stop() {
      if (!running) return;
      running = false;
      clearInterval(timer);
      // Players are told (bye PP3359), then the port closes.
      match.stop();
      listener.close();
      markStopped();
    },
  };
  return server;
}
