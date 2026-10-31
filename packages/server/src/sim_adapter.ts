/**
 * The seam between match orchestration and a Parallax game: what a fleet (a platform's
 * match server — tickets, node agent, watchdogs, drain) needs to run a match of a
 * game built on this engine, without knowing anything about the game or its protocol.
 *
 * Who owns what:
 *   orchestrator  the process and its lifetime, the transport and admission (it verifies a
 *                 match ticket and hands over the link with the player's identity), the loop
 *                 clock (fixed steps on wall time), the status endpoint, idle reaping, drain,
 *                 crash reporting
 *   the sim       seats, the wire protocol, replication, prediction acknowledgements, lag
 *                 compensation, rejoin windows — all of it the net plugin, as in any session
 *
 * Lifecycle: `createMatchSim` boots the game headless as the authority (net role "server")
 * and loads its start scene → `admit(link)` for each admitted connection (any time) →
 * `step(dt)` from the orchestrator's loop → `status()` whenever asked → `drain()` to stop
 * taking new players (held seats may still come back) → `stop()`. A frame that throws marks
 * the sim crashed: `status().crashed` says why, and `step` does nothing more.
 */

import { Game, netPluginOf } from '@parallax/runtime/api';
import type { GameRuntime } from '@parallax/runtime/api';
import { GAME_EXPORT, startGame } from '@parallax/runtime/boot';
import { fail } from '@parallax/runtime/core';
import type { BinaryFiles, Diagnostic, NetIdentity, NetLink, NetListener, NetMessage, ProjectFiles } from '@parallax/runtime/core';
import { HeadlessInput } from '@parallax/runtime/plugins/input';
import { PROTOCOL } from '@parallax/runtime/plugins/net';
import type { NetPlugin } from '@parallax/runtime/plugins/net';
import { HeadlessAudio, MemoryBinaryFiles, RecordingSurface2d, RecordingSurface3d } from '@parallax/runtime/platform';

export interface MatchSimInfo {
  readonly gameId: string;
  readonly protocol: number;
  readonly tickRate: number;
  readonly maxPlayers: number;
}

export interface MatchStatus {
  /** Players connected now. */
  readonly players: number;
  /** Players whose link dropped, whose seats are held for their rejoin window. */
  readonly away: number;
  readonly maxPlayers: number;
  /** Frames run. */
  readonly frame: number;
  /** Seconds of simulated wall time. */
  readonly uptime: number;
  readonly scene: string | null;
  /** False once draining (or stopped). */
  readonly accepting: boolean;
  /** Why the sim stopped running, if a frame threw. */
  readonly crashed: string | null;
}

/** What an orchestrator drives. */
export interface SimAdapter {
  readonly info: MatchSimInfo;
  readonly runtime: GameRuntime;
  readonly warnings: readonly Diagnostic[];
  /**
   * Offer a connection the orchestrator admitted. Its `identity` (when set) is the verified
   * player: their name and seat, and how a dropped player's new link takes the seat back.
   * While draining, only links that take back a held seat are let in.
   */
  admit(link: NetLink): void;
  /** One frame of `dt` seconds. */
  step(dt: number): void;
  status(): MatchStatus;
  drain(): void;
  /** Tell every player (bye PP3359) and stop. */
  stop(): void;
}

export interface MatchSimOptions {
  /** The loaded entry module's exports (`game = Game(...)` among them). */
  readonly entry: Readonly<Record<string, unknown>>;
  readonly files: ProjectFiles;
  readonly assets?: readonly string[] | null;
  /**
   * A 3D game's binary files (models: colliders, sockets, clips), by project path. Default
   * none: a model the game loads then fails to load, as a missing file would.
   */
  readonly binary?: BinaryFiles;
  readonly seed?: number;
  /** Seconds per fixed step (default 1/60). */
  readonly fixedStep?: number;
  /** Where the game's print() output goes (default: dropped). */
  readonly print?: (text: string) => void;
}

/** The listener the sim's net plugin reads: links the orchestrator admitted. */
class AdmittedLinks implements NetListener {
  readonly #queue: NetLink[] = [];
  closed = false;

  push(link: NetLink): void {
    this.#queue.push(link);
  }

  accept(): NetLink[] {
    return this.#queue.splice(0);
  }

  close(): void {
    this.closed = true;
    for (const link of this.#queue.splice(0)) link.close('the match ended');
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createMatchSim(options: MatchSimOptions): Promise<SimAdapter> {
  const game = options.entry[GAME_EXPORT];
  if (typeof game !== 'object' || game === null) fail('PP9503', 'The entry module has no `game = Game(...)`');
  const links = new AdmittedLinks();
  if (netPluginOf(game as Parameters<typeof netPluginOf>[0]) === undefined) {
    fail('PP3352', 'This game has no net plugin, so it can\'t be served as a match', { fix: 'Add net(...) to Game(plugins=[...]).' });
  }
  const { runtime, warnings } = await startGame({
    net: { role: 'server', listener: links },
    entry: options.entry,
    files: options.files,
    devices: new HeadlessInput(),
    audio: new HeadlessAudio(),
    assets: options.assets ?? null,
    // A 3D game needs a 3D surface (never drawn: the server renders nothing) and its models;
    // a 2D game a 2D one (PP9507).
    ...(game instanceof Game && game.mode === '3d'
      ? { surface3d: new RecordingSurface3d(), binary: options.binary ?? new MemoryBinaryFiles(new Map()) }
      : { surface: new RecordingSurface2d() }),
    print: options.print ?? (() => {}),
    seed: options.seed ?? 1,
    ...(options.fixedStep !== undefined && { fixedStep: options.fixedStep }),
  });
  const plugin: NetPlugin = netPluginOf(runtime.game)!;
  const server = plugin.server!;
  let accepting = true;
  let stopped = false;
  let crashed: string | null = null;
  return {
    info: { gameId: runtime.game.id, protocol: PROTOCOL, tickRate: plugin.options.tickRate, maxPlayers: plugin.options.maxPlayers },
    runtime,
    warnings,
    admit(link) {
      if (stopped) { link.close('the match ended'); return; }
      if (!accepting && (link.identity === undefined || !server.holds(link.identity.id))) {
        link.close('PP3362 This match is not taking new players');
        return;
      }
      links.push(link);
    },
    step(dt) {
      if (stopped || crashed !== null) return;
      try {
        runtime.step(dt);
      } catch (error) {
        crashed = message(error);
      }
    },
    status() {
      const seats = server.seats.filter((s) => !s.local);
      const away = seats.filter((s) => s.away !== null).length;
      const time = runtime.kernel.time;
      return {
        players: seats.length - away, away, maxPlayers: plugin.options.maxPlayers, frame: time.frame, uptime: time.realNow,
        scene: runtime.kernel.scene?.id ?? null, accepting: accepting && !stopped, crashed,
      };
    },
    drain() {
      accepting = false;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      accepting = false;
      server.close();
      links.close();
    },
  };
}

// ── Admission ──────────────────────────────────────────────────────────────────

/** A link with the identity an admission gate verified. */
export class IdentifiedLink implements NetLink {
  readonly #inner: NetLink;
  readonly identity: NetIdentity;

  constructor(inner: NetLink, identity: NetIdentity) {
    this.#inner = inner;
    this.identity = identity;
  }

  get id(): string { return this.#inner.id; }
  get state(): NetLink['state'] { return this.#inner.state; }
  get closeReason(): string | null { return this.#inner.closeReason; }
  get unreliable(): boolean { return this.#inner.unreliable; }
  send(m: NetMessage, channel?: Parameters<NetLink['send']>[1]): void { this.#inner.send(m, channel); }
  receive(): NetMessage[] { return this.#inner.receive(); }
  close(reason?: string): void { this.#inner.close(reason); }
}

/**
 * Decides who may play: the player's identity, or why not (the link is closed with that
 * reason). Typically it reads a match ticket from the connection's request path.
 */
export type AdmissionGate<L extends NetLink> = (link: L) => NetIdentity | { readonly reject: string };

/** Admit each link a listener accepts through a gate, into a sim. Call `pump()` from the loop. */
export class Admission<L extends NetLink> {
  readonly #listener: { accept(): NetLink[] };
  readonly #gate: AdmissionGate<L>;
  readonly #sim: SimAdapter;
  /** Links turned away, with why (tests, logs). */
  readonly rejected: { readonly link: string; readonly reason: string }[] = [];

  constructor(listener: { accept(): NetLink[] }, gate: AdmissionGate<L>, sim: SimAdapter) {
    this.#listener = listener;
    this.#gate = gate;
    this.#sim = sim;
  }

  pump(): void {
    for (const link of this.#listener.accept()) {
      const verdict = this.#gate(link as L);
      if ('reject' in verdict) {
        this.rejected.push({ link: link.id, reason: verdict.reject });
        link.close(`PP3363 ${verdict.reject}`);
        continue;
      }
      this.#sim.admit(new IdentifiedLink(link, verdict));
    }
  }
}
