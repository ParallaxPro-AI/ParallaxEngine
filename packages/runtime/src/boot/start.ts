/**
 * Starting a game, the same on every platform: take the loaded entry module and the
 * project's files, finish the async work plugins need (Rapier's WASM), build the runtime
 * with the platform's devices and load the start scene.
 */

import { diagnostic, fail, ParallaxError } from '../core/index.js';
import type {
  AudioOutput, BinaryFiles, Diagnostic, InputDevices, JobRunner, KeyValueStore, ProjectFiles, RenderSurface2d, RenderSurface3d,
  UiSurface,
} from '../core/index.js';
import { InlineJobs } from '../platform/index.js';
import { JOBS_SERVICE, TERRAIN_SERVICE } from '../function/services/index.js';
import { PROFILE_KEY } from '../function/plugins/save/index.js';
import { ENGINE_JOBS } from './jobs.js';
import { loadProject } from '../resource/index.js';
import { attachNet, createRuntime, Game, netPluginOf, prepareNet } from '../api/index.js';
import type { NetSession } from '../api/index.js';
import type { GameRuntime } from '../api/index.js';
import { initPhysics2d } from '../function/plugins/physics2d/index.js';
import { initPhysics3d } from '../function/plugins/physics3d/index.js';
import { GAME_EXPORT } from './modules.js';

/** Async setup a plugin needs before a kernel with it is built, by plugin id. */
const PLUGIN_SETUP: Readonly<Record<string, () => Promise<void>>> = {
  physics2d: initPhysics2d,
  physics3d: initPhysics3d,
};

/** A boot step failed with one or more diagnostics. */
export class BootFailure extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(`${message}:\n${diagnostics.map((d) => `${d.code}  ${d.message}`).join('\n')}`);
    this.name = 'BootFailure';
    this.diagnostics = diagnostics;
  }
}

/** What a compiled `x.attr` / `x.method()` on None throws in each browser engine's wording (group 1: the attribute). */
const NONE_ATTRIBUTE = [
  /^Cannot read properties of null \(reading '([^']+)'\)$/, // V8: Chrome, Edge, Node
  /^can't access property "([^"]+)", .+ is null$/, // SpiderMonkey: Firefox
  /^null is not an object \(evaluating '.*\.([A-Za-z_$][\w$]*)'\)$/, // JavaScriptCore: Safari
];

/**
 * Any thrown value as diagnostics: engine errors keep theirs; an attribute read on None
 * is Python's AttributeError (PP9508); anything else is PP9500.
 */
export function diagnosticsOf(error: unknown): Diagnostic[] {
  if (error instanceof BootFailure) return [...error.diagnostics];
  if (error instanceof ParallaxError) return [error.diagnostic];
  const none = error instanceof TypeError ? NONE_ATTRIBUTE.map((re) => re.exec(error.message)).find((m) => m !== null) ?? null : null;
  if (none !== null) {
    return [diagnostic('PP9508', `AttributeError: 'NoneType' object has no attribute '${none[1]!}'`, {
      fix: 'The value was None (an empty optional field, a missing parent, a lookup that found nothing): check for None first; the traceback shows where.',
    })];
  }
  const e = error instanceof Error ? error : new Error(String(error));
  return [diagnostic('PP9500', `${e.name}: ${e.message}`, {
    fix: 'The traceback shows where in the game\'s Python it happened (in a browser, on the error screen; the JavaScript stack is in the console).',
  })];
}

export interface StartOptions {
  /** The loaded entry module (`game/main.py` compiled): its exports. */
  readonly entry: Readonly<Record<string, unknown>>;
  readonly files: ProjectFiles;
  readonly devices: InputDevices;
  readonly audio: AudioOutput;
  /** Every asset file the project has (project paths), or null where the platform can't list them. */
  readonly assets: readonly string[] | null;
  /** Whether hosted asset URLs are fetched (a browser); default false (headless: they load nothing). */
  readonly remoteAssets?: boolean;
  /** Where a 2D game draws (the canvas surface, or `RecordingSurface2d` headless). */
  readonly surface?: RenderSurface2d;
  /** Where a 3D game draws (the browser's WebGPU/WebGL2 surface, or `RecordingSurface3d` headless). */
  readonly surface3d?: RenderSurface3d;
  /** A 3D game's binary files (models): `HttpBinaryFiles`, or `MemoryBinaryFiles` headless. */
  readonly binary?: BinaryFiles;
  /** Where `print()` output goes; default: kept in `runtime.printed`. */
  readonly print?: (text: string) => void;
  readonly seed: number;
  /** The device store (profile, save slots): `LocalStore` in a browser; default: memory (nothing outlives the run). */
  readonly store?: KeyValueStore;
  /** The platform's wall clock, Unix seconds (save slot times); none headless. */
  readonly wallClock?: () => number;
  readonly fixedStep?: number;
  readonly maxFixedSteps?: number;
  /** Where panels are drawn (the browser's DOM surface); none: undrawn, as in playtests. */
  readonly ui?: UiSurface;
  /** Who this process is in a networked game (default: a host with one local player). */
  readonly net?: NetSession;
  /** Where pure work runs (`JOBS_SERVICE`): workers in a browser; default inline (deterministic). */
  readonly jobs?: JobRunner;
  /** `Settings.quality` on a first run (no saved profile yet): the device's tier. */
  readonly defaultQuality?: 'low' | 'medium' | 'high';
  /** Boot reached a stage: preparing models and sounds, then starting the scene. */
  readonly onStage?: (stage: 'assets' | 'start') => void;
  /**
   * Edit mode (an editor's viewport): the start scene loads with the kernel's logic off
   * (`Kernel.setLogic`) — drawn every frame, nothing of the game started or run.
   */
  readonly editing?: boolean;
}

export interface StartedGame {
  readonly runtime: GameRuntime;
  /** Warnings from loading the project data and, in 3D, its models (errors stop the boot). */
  readonly warnings: readonly Diagnostic[];
}

export async function startGame(options: StartOptions): Promise<StartedGame> {
  const game = options.entry[GAME_EXPORT];
  if (!(game instanceof Game)) {
    fail('PP9503', `game/main.py does not define \`${GAME_EXPORT} = Game(...)\``, {
      path: 'game/main.py',
      fix: `Assign the game at module level: ${GAME_EXPORT} = Game(id=..., title=..., sdk="1.0", mode=..., start_scene=Scenes.<id>).`,
    });
  }
  const project = loadProject(options.files);
  const errors = project.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new BootFailure('The project data has errors', errors);
  for (const plugin of game.plugins) await PLUGIN_SETUP[plugin.id]?.();
  if (netPluginOf(game) !== undefined) prepareNet(game, options.net);
  const runtime = createRuntime(game, project, {
    devices: options.devices,
    audio: options.audio,
    assets: options.assets,
    ...(options.remoteAssets !== undefined && { remoteAssets: options.remoteAssets }),
    files: options.files,
    ...(options.surface !== undefined && { surface: options.surface }),
    ...(options.surface3d !== undefined && { surface3d: options.surface3d }),
    ...(options.binary !== undefined && { binary: options.binary }),
    ...(options.print !== undefined && { print: options.print }),
    seed: options.seed,
    ...(options.store !== undefined && { store: options.store }),
    ...(options.wallClock !== undefined && { wallClock: options.wallClock }),
    ...(options.ui !== undefined && { ui: options.ui }),
    ...(options.fixedStep !== undefined && { fixedStep: options.fixedStep }),
    ...(options.maxFixedSteps !== undefined && { maxFixedSteps: options.maxFixedSteps }),
  });
  runtime.kernel.provide(JOBS_SERVICE, options.jobs ?? new InlineJobs(ENGINE_JOBS));
  if (options.defaultQuality !== undefined && (options.store?.get(PROFILE_KEY) ?? undefined) === undefined) {
    runtime.kernel.resource('settings')['quality'] = options.defaultQuality;
  }
  const warnings = project.diagnostics.filter((d) => d.severity === 'warning');
  options.onStage?.('assets');
  // Every model the data names loads before the first frame (a failed load is raised then), renderer or not.
  runtime.models.preload();
  await runtime.models.whenLoaded();
  warnings.push(...(runtime.render3d?.takeWarnings() ?? runtime.models.takeWarnings()));
  // Every scene's terrain bakes in the job runner (workers in a browser) before the first frame.
  await runtime.kernel.tryService(TERRAIN_SERVICE)?.prebake();
  options.onStage?.('start');
  if (options.editing === true) runtime.kernel.setLogic(false);
  runtime.start();
  attachNet(runtime);
  return { runtime, warnings };
}
