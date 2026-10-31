/**
 * Headless boot: a game with scriptable input, a manual clock and a manual display, run
 * through the same loop as the browser — `frame()` advances the clock and refreshes the
 * display once. For playtests, the CLI and servers. Loading the compiled modules is the
 * caller's job (a bundle or an aliasing loader, see `ENGINE_MODULES`): pass the entry's exports.
 */

import { fail } from '../core/index.js';
import type { Diagnostic, ProjectFiles } from '../core/index.js';
import type { GameRuntime, NetSession } from '../api/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { Game } from '../api/index.js';
import { HeadlessAudio, ManualClock, ManualDisplay, MemoryBinaryFiles, RecordingSurface2d, RecordingSurface3d } from '../platform/index.js';
import { GameLoop } from './loop.js';
import { GAME_EXPORT } from './modules.js';
import { startGame } from './start.js';

export interface HeadlessBootOptions {
  readonly entry: Readonly<Record<string, unknown>>;
  readonly files: ProjectFiles;
  /** Default 1: headless runs are reproducible unless asked otherwise. */
  readonly seed?: number;
  /** The project's asset files (project paths); default null, unknown. */
  readonly assets?: readonly string[] | null;
  /** A 3D game's model files by project path; default none (a data-only run). */
  readonly binary?: ReadonlyMap<string, Uint8Array>;
  readonly fixedStep?: number;
  readonly maxFixedSteps?: number;
  /** Who this process is in a networked game (default: a host with one local player). */
  readonly net?: NetSession;
}

export interface HeadlessGame {
  readonly runtime: GameRuntime;
  readonly input: HeadlessInput;
  /** Every audio frame the game sent, recorded. */
  readonly audio: HeadlessAudio;
  /** Every 2D frame drawn, recorded (the last few; see RecordingSurface2d). Unused by a 3D game. */
  readonly surface: RecordingSurface2d;
  /** Every 3D frame drawn, recorded (the last one; see RecordingSurface3d). Unused by a 2D game. */
  readonly surface3d: RecordingSurface3d;
  readonly clock: ManualClock;
  readonly display: ManualDisplay;
  readonly warnings: readonly Diagnostic[];
  /** One display frame of `dt` seconds (default 1/60). Rethrows what the game threw. */
  frame(dt?: number): void;
  /** `count` frames of `dt` seconds. */
  frames(count: number, dt?: number): void;
  stop(): void;
}

export async function bootHeadless(options: HeadlessBootOptions): Promise<HeadlessGame> {
  const input = new HeadlessInput();
  const audio = new HeadlessAudio();
  const surface = new RecordingSurface2d();
  const surface3d = new RecordingSurface3d();
  const game = options.entry[GAME_EXPORT];
  const target = game instanceof Game && game.mode === '3d'
    ? { surface3d, binary: new MemoryBinaryFiles(options.binary ?? new Map()) }
    : { surface };
  const { runtime, warnings } = await startGame({
    entry: options.entry,
    files: options.files,
    devices: input,
    audio,
    assets: options.assets ?? null,
    ...target,
    seed: options.seed ?? 1,
    ...(options.fixedStep !== undefined && { fixedStep: options.fixedStep }),
    ...(options.maxFixedSteps !== undefined && { maxFixedSteps: options.maxFixedSteps }),
    ...(options.net !== undefined && { net: options.net }),
  });
  const clock = new ManualClock();
  const display = new ManualDisplay();
  const failures: unknown[] = [];
  const loop = new GameLoop({ target: runtime, clock, display, onError: (error) => { failures.push(error); } });
  loop.start();

  const frame = (dt = 1 / 60): void => {
    if (failures.length > 0) throw failures[0];
    if (!loop.running) fail('PP9506', 'frame() was called after stop()', { fix: 'Boot a new game with bootHeadless() to keep playing.' });
    clock.advance(dt);
    display.refresh();
    if (failures.length > 0) throw failures[0];
  };
  return {
    runtime, input, audio, surface, surface3d, clock, display, warnings, frame,
    frames: (count, dt) => { for (let i = 0; i < count; i++) frame(dt); },
    stop: () => loop.stop(),
  };
}
