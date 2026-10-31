/**
 * Browser boot: build the stage inside `mount`, fetch the build manifest and the project's
 * files (loose, or packed bundles), import the compiled entry (bare `parallax*` / `project`
 * specifiers resolve through the page's import map), start the game and run it on
 * `requestAnimationFrame`. Every failure — build diagnostics, a missing file, an error
 * thrown by game code — ends on the error overlay as coded diagnostics, never a blank page.
 *
 * Stages (the loading bar, `BootProgress`): engine (manifest + compiled modules), data
 * (the project's files; bundles report bytes), assets (models and sounds the data names),
 * start (the first scene). Timings go to the console.
 *
 * Around the game: a job runner on Web Workers (`JOBS_SERVICE`); the device probe (WebGL2
 * where WebGPU is unreliable, the default `Settings.quality` tier); cloud saves (a
 * `CloudStore` over localStorage, synced before the game reads its profile); networking
 * (`net`: host over WebRTC, or join a server or a host); and the page's lifecycle — audio
 * resumes on the first gesture and when the page is shown, suspends when it is hidden;
 * cloud saves flush when it is hidden or closed.
 *
 * Editors boot with `editing` (the start scene drawn with the kernel's logic off) and hot
 * reload through `rebuild` + `replace`: a new runtime from a new build on the same page.
 */

import { diagnostic, fail, formatDiagnostic } from '../core/index.js';
import type { ConflictResolver, Diagnostic, ProjectFiles, SaveRemote } from '../core/index.js';
import { connectPayments, connectScreens, connectVoice, Game, resetDeclarations } from '../api/index.js';
import type { GameRuntime } from '../api/index.js';
import {
  BootProgress, BrowserDisplay, BrowserInput, CanvasSurface2d, CloudStore, createBrowserSurface3d, createStage, DomScreenSurface,
  DomUiSurface, ErrorOverlay, formatTraceback, HostPagePayments, LocalStore, PerformanceClock, probeDevice, probeGpu, pythonTraceback,
  TouchControls, WebAudioOutput, WebRtcVoice, WorkerJobs,
} from '../platform/index.js';
import type { BootBranding, BootProgressEvent, DeviceProfile, TraceSources, WorkerLike } from '../platform/index.js';
import type { BrowserSurface3d, Stage } from '../platform/index.js';
import { GameLoop } from './loop.js';
import { FrameStats } from './frame_stats.js';
import type { RenderStats } from './frame_stats.js';
import type { BuildManifest } from './modules.js';
import { GAME_EXPORT, gameModules, migrationModules } from './modules.js';
import { diagnosticsOf, startGame } from './start.js';
import { ENGINE_JOBS } from './jobs.js';
import { bundleSources, looseSources } from './browser_sources.js';
import type { GameSources } from './browser_sources.js';
import { openNet, rejoinKey, writeRejoin } from './browser_net.js';
import type { BrowserNet, OpenedNet } from './browser_net.js';

export interface BrowserBootOptions {
  /** The element the game fills. */
  readonly mount: HTMLElement;
  /** The page hosting the game for purchases (`payments()` games): its origin, and whether purchases are simulated. */
  readonly payments?: { readonly origin: string; readonly test?: boolean };
  /** URL of the build output (compiled modules and manifest.json), ending in "/". */
  readonly build: string;
  /** Loose files: URL the project's data and assets are served under, ending in "/". */
  readonly project?: string;
  /** Loose files: URL of the project file index (`{"files": [...]}`). */
  readonly fileIndex?: string;
  /** Packed files: URL of `bundles.json` (`parallax build --bundle`). Takes the place of `project` + `fileIndex`. */
  readonly bundles?: string;
  /** Diagnostics from building the project; any error is shown instead of starting. */
  readonly diagnostics?: readonly Diagnostic[];
  /** Default: a fresh random seed, logged so a run can be replayed. */
  readonly seed?: number;
  /** A 3D game's GPU API: default WebGPU, falling back to WebGL2 (`?renderer=webgl2` forces it; so does the device probe on Android WebViews). */
  readonly renderer?: 'webgpu' | 'webgl2';
  /**
   * False: run data-only (`parallax edit --no-asset-files`): asset references are checked for
   * form only and missing art draws nothing, as in headless playtests. Default true.
   */
  readonly assetFiles?: boolean;
  /** URL of the engine's panel frame module (`panel_frame.js`): panels with `<script>` run in a sandboxed frame that loads it. */
  readonly panelFrame?: string;
  /** URL of the engine's job worker (`job_worker.js`); absent: jobs run on the main thread. */
  readonly jobWorker?: string;
  /** Cloud saves: the remote (e.g. an `HttpSaveRemote`), and how conflicts are settled (default: newer wins). */
  readonly saves?: { readonly remote: SaveRemote; readonly resolve?: ConflictResolver; readonly syncSeconds?: number };
  /** Networking (`netFromUrl()` reads it from the page URL); absent or null: a local game. */
  readonly net?: BrowserNet | null;
  /** Hear the loading progress (a host page's own loading UI). */
  readonly onProgress?: (event: BootProgressEvent) => void;
  /** The loading screen's brand splash: shown by default to players, never in `editing`. */
  readonly splash?: boolean;
  /** The loading screen's logo, wordmark and colors (default: the ParallaxPro look). */
  readonly branding?: BootBranding;
  /**
   * STUN/TURN servers for every WebRTC connection the page opens: voice chat between players
   * and browser-hosted matches (`net` host / join over a relay). Default: a public STUN
   * server for matches, none for voice (direct and local-network connections only).
   */
  readonly iceServers?: readonly RTCIceServer[];
  /** Edit mode (an editor's viewport): the start scene is drawn with the kernel's logic off; see `startGame`. */
  readonly editing?: boolean;
  /**
   * The project's data files to run instead of the served ones (an editor's unsaved
   * documents); assets still come from the sources.
   */
  readonly dataFiles?: ProjectFiles;
  /** Every failure the overlay shows (build errors, a failed start, the game stopping), for a host's reporting (also the `parallax-game-error` window event). */
  readonly onError?: (title: string, diagnostics: readonly Diagnostic[]) => void;
}

/** `?renderer=webgl2` / `?renderer=webgpu` on the page URL; anything else is a warning. */
function rendererParam(warn: (d: Diagnostic) => void): 'webgpu' | 'webgl2' | undefined {
  const value = new URL(location.href).searchParams.get('renderer');
  if (value === null) return undefined;
  if (value === 'webgpu' || value === 'webgl2') return value;
  warn(diagnostic('PP9525', `?renderer=${value} is not a renderer`, { severity: 'warning', fix: 'Use ?renderer=webgpu or ?renderer=webgl2.' }));
  return undefined;
}

export interface BrowserGame {
  readonly runtime: GameRuntime;
  readonly stage: Stage;
  readonly loop: GameLoop;
  readonly input: BrowserInput;
  readonly display: BrowserDisplay;
  readonly audio: WebAudioOutput;
  readonly overlay: ErrorOverlay;
  readonly ui: DomUiSurface;
  readonly jobs: WorkerJobs;
  readonly device: DeviceProfile;
  readonly sources: GameSources;
  /** Cloud saves, when `saves` was given. */
  readonly cloud: CloudStore | undefined;
  /** The match's links, when `net` was given. */
  readonly net: OpenedNet | undefined;
  /** Seconds from boot to the first frame, by stage. */
  readonly timings: readonly { readonly stage: string; readonly seconds: number }[];
  /**
   * Per-frame stats for a profiler (frame_stats.ts): `stats.enable('panel')` while it is
   * shown, `stats.snapshot()` a few times a second, `stats.disable('panel')` when hidden.
   * Off by default; follows the runtime across `replace`.
   */
  readonly stats: FrameStats;
  /**
   * Hot reload: a new runtime from another build of the game (`build`: its URL, ending in
   * "/", so its modules are imported afresh), on this page's devices, surfaces, panels and
   * saves; `files` replaces the project's data files. Declarations are forgotten first.
   * Started like the first (in edit mode with `editing`); the loop keeps stepping the
   * current runtime until `replace`.
   */
  rebuild(build: string, options?: { readonly editing?: boolean; readonly files?: ProjectFiles }): Promise<GameRuntime>;
  /** Step `next` from the next frame on; the runtime it replaces is disposed. */
  replace(next: GameRuntime): void;
  stop(): void;
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0]! & 0x7fffffff;
}

async function fetchManifest(url: string): Promise<BuildManifest> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return fail('PP9505', `Could not fetch the build manifest (${url}): ${(error as Error).message}`, {
      fix: 'Check that `parallax edit` is still running, then reload.',
    });
  }
  if (!response.ok) {
    fail('PP9502', `There is no build manifest at ${url} (HTTP ${response.status})`, {
      fix: 'Build the project first: `parallax build <project>`.',
    });
  }
  return (await response.json()) as BuildManifest;
}

/**
 * The page's lifecycle around audio and saves. Browsers start an AudioContext suspended
 * until a gesture: resume on the first press, key or touch, and whenever the page is shown
 * again (iOS's `interrupted` state after a call included). A hidden page suspends audio
 * (a phone would otherwise keep loops playing in the background) and flushes cloud saves;
 * so does `pagehide` (closing the tab, or entering the back/forward cache).
 */
function watchLifecycle(audio: WebAudioOutput, display: BrowserDisplay, cloud: CloudStore | undefined, warn: (d: Diagnostic) => void): () => void {
  const resume = (): void => {
    audio.resume().then(() => audio.retryMusic()).catch((error: unknown) => warn(diagnostic('PP9523', `Audio could not start: ${(error as Error).message}`, {
      severity: 'warning', fix: 'Click or press a key in the game to allow sound.',
    })));
  };
  const hide = (): void => {
    void audio.suspend().catch(() => {});
    void cloud?.flush();
  };
  const gestures = ['pointerdown', 'keydown', 'touchend'] as const;
  for (const type of gestures) globalThis.addEventListener(type, resume);
  const pagehide = (): void => { void cloud?.flush(); };
  globalThis.addEventListener('pagehide', pagehide);
  const unwatch = display.onChange((change) => {
    if (change !== 'visibility') return;
    if (display.visible()) resume(); else hide();
  });
  return () => {
    for (const type of gestures) globalThis.removeEventListener(type, resume);
    globalThis.removeEventListener('pagehide', pagehide);
    unwatch();
  };
}

/** A random id for this device, kept in localStorage (cloud save envelopes name it). */
export function deviceId(): string {
  const key = 'parallax:device';
  try {
    const known = globalThis.localStorage.getItem(key);
    if (known !== null) return known;
    const id = globalThis.crypto.randomUUID();
    globalThis.localStorage.setItem(key, id);
    return id;
  } catch {
    return 'unknown';
  }
}

/**
 * Every error the page shows (a build error, a game that stopped while starting or running) is
 * also a `parallax-game-error` window event, `detail: { title, diagnostics }`: a host page's
 * scripts hear it without owning the boot call (error reporting, a debugging overlay).
 */
function announceError(title: string, diagnostics: readonly Diagnostic[]): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent('parallax-game-error', { detail: { title, diagnostics } }));
  } catch (error) {
    console.warn('Parallax: a parallax-game-error listener failed', error);
  }
}

/** Start the game, or show why it can't start. Resolves to undefined when it didn't. */
export async function bootBrowser(options: BrowserBootOptions): Promise<BrowserGame | undefined> {
  const stage = createStage(options.mount);
  const overlay = new ErrorOverlay(stage.stage);
  // The brand splash is for players; an editor's viewport boots straight to the bar.
  const progress = new BootProgress(stage.stage, undefined, {
    splash: options.splash ?? options.editing !== true, ...(options.branding !== undefined && { branding: options.branding }),
  });
  if (options.onProgress !== undefined) progress.onProgress(options.onProgress);
  const warn = (d: Diagnostic): void => console.warn(formatDiagnostic(d));
  // Set once the manifest is read: what maps a stack to the game's .py files and lines.
  let trace: TraceSources | undefined;
  const show = (title: string, error: unknown): void => {
    progress.remove();
    const diagnostics = diagnosticsOf(error);
    overlay.show(title, diagnostics);
    options.onError?.(title, diagnostics);
    announceError(title, diagnostics);
    const stack = error instanceof Error ? error.stack : undefined;
    if (trace === undefined || stack === undefined) return;
    pythonTraceback(stack, trace)
      .then((frames) => { if (overlay.diagnostics.length > 0) overlay.showTraceback(formatTraceback(frames)); })
      .catch((failure: unknown) => console.warn('Parallax: the Python traceback could not be read', failure));
  };
  const stopped = (error: unknown): void => {
    console.error(error);
    show('The game stopped', error);
  };

  const buildErrors = (options.diagnostics ?? []).filter((d) => d.severity === 'error');
  (options.diagnostics ?? []).filter((d) => d.severity === 'warning').forEach(warn);
  if (buildErrors.length > 0) {
    progress.remove();
    const title = `The build has ${buildErrors.length} error${buildErrors.length === 1 ? '' : 's'}`;
    overlay.show(title, buildErrors);
    options.onError?.(title, buildErrors);
    announceError(title, buildErrors);
    return undefined;
  }

  const touch = new TouchControls({ stage: stage.stage, layer: stage.touch, ui: stage.ui });
  const display = new BrowserDisplay(stage.stage);
  // The pointer in the canvas's backing pixels (what cameras resolve): set by fitCanvas below.
  let screenScale = 1;
  const input = new BrowserInput({
    stage: stage.stage, ui: stage.ui, textInput: stage.textInput, touch, onProblem: warn, screenScale: () => screenScale,
  });
  const jobs = new WorkerJobs({
    create: options.jobWorker === undefined || typeof Worker === 'undefined' ? undefined
      : () => moduleWorker(new URL(options.jobWorker!, location.href)),
    table: ENGINE_JOBS,
    isolated: globalThis.crossOriginIsolated === true,
    onProblem: warn,
  });
  let unhookLifecycle = (): void => {};
  let ui: DomUiSurface | undefined;
  let sources: GameSources | undefined;
  let net: OpenedNet | undefined;
  let cloud: CloudStore | undefined;
  try {
    const buildUrl = new URL(options.build, location.href);
    const manifest = await fetchManifest(new URL('manifest.json', buildUrl).href);
    if (manifest.entry === null) {
      fail('PP9502', 'The build has no game/main.py', { fix: 'Create game/main.py with `game = Game(...)`, then rebuild.' });
    }
    trace = {
      build: buildUrl.href,
      sources: Object.fromEntries(manifest.modules.flatMap((m) => (m.output === null ? [] : [[m.output, m.source]]))),
      fetchText: async (url) => {
        const response = await fetch(url);
        return response.ok ? response.text() : undefined;
      },
    };
    const loadModules = (): Promise<Record<string, unknown>> => importBuild(buildUrl, manifest, (p) => progress.update('engine', p));
    const loadSources = (): Promise<GameSources> => {
      if (options.bundles !== undefined) {
        return bundleSources(new URL(options.bundles, location.href).href, (p) => progress.update('data', p.total === 0 ? 1 : p.loaded / p.total, p), () => {
          overlay.show('This game was updated', [diagnostic('PP9542', 'A newer version of this game was published while you played', {
            severity: 'warning', fix: 'Reload the page to play the new version.',
          })]);
        });
      }
      if (options.project === undefined || options.fileIndex === undefined) {
        fail('PP9502', 'bootBrowser needs `bundles`, or `project` and `fileIndex`', { fix: 'Pass the packed build\'s bundles.json, or the dev server\'s /project/ and /project-files.json.' });
      }
      return looseSources(new URL(options.project, location.href), new URL(options.fileIndex, location.href).href)
        .then((s) => { progress.update('data', 1); return s; });
    };
    const [entry, loaded] = await Promise.all([loadModules(), loadSources()]);
    sources = loaded;
    progress.update('data', 1);
    const game = entry[GAME_EXPORT];
    const gameId = game instanceof Game ? game.id : 'game';

    const seed = options.seed ?? randomSeed();
    console.info(`Parallax: seed ${seed} (add ?seed=${seed} to the URL to replay this run)`);
    let device = probeDevice();
    if (game instanceof Game && game.mode === '3d') device = await probeGpu(device);
    console.info(`Parallax: ${device.tier} quality tier${device.reasons.length > 0 ? ` (${device.reasons.join('; ')})` : ''}`);

    const store = new LocalStore(gameId, { onProblem: warn });
    if (options.saves !== undefined) {
      cloud = new CloudStore({ local: store, remote: options.saves.remote, onProblem: warn, ...(options.saves.resolve && { resolve: options.saves.resolve }) });
      // Local first: a slow cloud doesn't hold the game; the merge it misses happens next start.
      const limit = options.saves.syncSeconds ?? 3;
      const synced = await Promise.race([cloud.sync(), new Promise<'late'>((done) => setTimeout(() => done('late'), limit * 1000))]);
      if (synced === 'late') warn(diagnostic('PP9560', `Cloud saves: no answer within ${limit} s; playing on this device's saves`, { severity: 'warning', fix: 'Saves sync once the connection recovers.' }));
    }

    const audio = new WebAudioOutput({
      context: new AudioContext(),
      load: (file) => sources!.audio(file),
      stream: (file) => sources!.stream(file),
      onError: (file, error) => warn(diagnostic('PP9524', `Sound ${file} could not be loaded: ${(error as Error).message}`, {
        severity: 'warning', path: file, fix: 'Check that the file exists under assets/ and is an ogg, mp3 or wav the browser can decode.',
      })),
    });
    unhookLifecycle = watchLifecycle(audio, display, cloud, warn);
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
    stage.surface.append(canvas);
    const fitCanvas = (): void => {
      const { width, height, pixelRatio } = display.size();
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      screenScale = width > 0 ? canvas.width / width : pixelRatio;
    };
    fitCanvas();
    const fileUrl = (path: string): string => sources!.url(path);
    let target: { surface: CanvasSurface2d } | { surface3d: BrowserSurface3d; binary: GameSources['binary'] };
    let surface3d: BrowserSurface3d | undefined;
    if (game instanceof Game && game.mode === '3d') {
      const prefer = options.renderer ?? rendererParam(warn) ?? device.renderer;
      const created = await createBrowserSurface3d(canvas, { url: fileUrl, deviceTier: device.tier, ...(prefer !== undefined && { prefer }) });
      if (created.fallbackReason !== null) console.info(`Parallax: drawing with WebGL2 (${created.fallbackReason})`);
      target = { surface3d: created.surface, binary: sources.binary };
      surface3d = created.surface;
    } else {
      target = { surface: new CanvasSurface2d(canvas, { url: fileUrl }) };
    }
    const panels = new DomUiSurface({
      ui: stage.ui, files: sources.files, url: fileUrl, frameFiles: sources.frame,
      ...(options.panelFrame !== undefined && { frameModule: new URL(options.panelFrame, location.href).href }),
    });
    ui = panels;
    if (options.net != null) {
      if (!(game instanceof Game) || game.plugins.every((p) => p.id !== 'net')) {
        warn(diagnostic('PP9575', 'The page asks for a networked game, but this game has no net plugin; it runs locally', {
          severity: 'warning', fix: 'Add net(...) to Game(plugins=[...]), or drop ?net= from the URL.',
        }));
      } else {
        net = openNet(options.net, gameId, options.iceServers);
        if (net.rejoining) console.info('Parallax: rejoining the match with this tab\'s seat (a new tab joins as a new player)');
      }
    }
    const platform = {
      // Hosted asset URLs are fetched directly (open CORS), with or without the project's own asset files.
      devices: input, audio, assets: options.assetFiles === false ? null : sources.paths, remoteAssets: true, ...target, seed, ui: panels,
      store: cloud ?? store, wallClock: () => Date.now() / 1000, jobs, defaultQuality: device.tier,
      ...(net !== undefined && { net: net.session }),
      print: (text: string) => console.log(text.endsWith('\n') ? text.slice(0, -1) : text),
    };
    const { runtime, warnings } = await startGame({
      ...platform, entry, files: options.dataFiles ?? sources.files, onStage: (s) => progress.update(s, 0),
      ...(options.editing === true && { editing: true }),
    });
    let current = runtime;
    connectNiche(runtime, options, sources, fileUrl);
    sources.commit();
    cloud?.start();
    warnings.forEach(warn);
    const unhookResize = display.onChange((change) => {
      if (change !== 'resize') return;
      fitCanvas();
      current.resize(canvas.width, canvas.height);
    });
    if (net?.signaling !== undefined && options.net?.mode === 'host') announceRoom(net, options.net.signal);
    const keepSeat = net !== undefined && options.net != null && options.net.mode === 'join' ? rejoinKey(gameId, options.net) : undefined;
    let seat: string | undefined;

    const stats = new FrameStats();
    stats.connect({ kernel: () => current.kernel, render: () => renderStats(surface3d, current, canvas) });
    const loop = new GameLoop({
      target: {
        step: (dt: number) => {
          stats.tick();
          current.step(dt);
          // A 3D renderer's warnings (model parts it doesn't read, settings it doesn't draw) go to the console.
          current.render3d?.takeWarnings().forEach(warn);
          if (keepSeat !== undefined) {
            const token = netToken(current);
            if (token !== undefined && token !== seat) { seat = token; writeRejoin(keepSeat, token); }
          }
        },
      },
      clock: new PerformanceClock(),
      display,
      onError: stopped,
      // A browser hosting a match keeps serving its peers from a background tab (timers there run
      // throttled, so the host's game slows; peers stay connected instead of timing out).
      ...(options.net?.mode === 'host' && net !== undefined && {
        whileHidden: (tick: () => void) => { const id = setInterval(tick, 50); return () => clearInterval(id); },
      }),
    });
    const onError = (event: ErrorEvent): void => { loop.stop(); stopped(event.error ?? event.message); };
    const onRejection = (event: PromiseRejectionEvent): void => { loop.stop(); stopped(event.reason); };
    globalThis.addEventListener('error', onError);
    globalThis.addEventListener('unhandledrejection', onRejection);
    progress.finish();
    loop.start();
    stage.stage.focus({ preventScroll: true });
    const timings = progress.timings.map((t) => ({ stage: t.stage, seconds: Math.round(t.seconds * 1000) / 1000 }));
    console.info(`Parallax: first frame after ${timings.at(-1)!.seconds.toFixed(2)} s (${timings.map((t) => `${t.stage} ${t.seconds.toFixed(2)}`).join(', ')}); ${sources.kind}: ${sources.report()}; jobs: ${jobs.mode}${jobs.threads > 0 ? ` (${jobs.threads} threads)` : ''}`);
    const served = sources;
    return {
      get runtime() { return current; },
      stage, loop, input, display, audio, overlay, ui: panels, jobs, device, sources, cloud, net, timings, stats,
      rebuild: async (build, rebuildOptions = {}) => {
        const url = new URL(build, location.href);
        const next = await fetchManifest(new URL('manifest.json', url).href);
        if (next.entry === null) fail('PP9502', 'The build has no game/main.py', { fix: 'Create game/main.py with `game = Game(...)`, then rebuild.' });
        resetDeclarations();
        const nextEntry = await importBuild(url, next, () => {});
        const started = await startGame({
          ...platform, entry: nextEntry, files: rebuildOptions.files ?? options.dataFiles ?? served.files,
          ...(rebuildOptions.editing === true && { editing: true }),
        });
        started.warnings.forEach(warn);
        trace = { ...trace!, build: url.href, sources: Object.fromEntries(next.modules.flatMap((m) => (m.output === null ? [] : [[m.output, m.source]]))) };
        started.runtime.resize(canvas.width, canvas.height);
        return started.runtime;
      },
      replace: (next) => {
        if (next === current) return;
        const previous = current;
        current = next;
        connectNiche(next, options, sources!, fileUrl);
        previous.kernel.dispose();
      },
      stop: () => {
        loop.stop();
        panels.dispose();
        unhookLifecycle();
        unhookResize();
        input.dispose();
        touch.dispose();
        display.dispose();
        jobs.dispose();
        net?.close();
        void cloud?.flush().then(() => cloud?.dispose());
        sources?.dispose();
        globalThis.removeEventListener('error', onError);
        globalThis.removeEventListener('unhandledrejection', onRejection);
      },
    };
  } catch (error) {
    unhookLifecycle();
    ui?.dispose();
    input.dispose();
    touch.dispose();
    display.dispose();
    jobs.dispose();
    net?.close();
    cloud?.dispose();
    console.error(error);
    show('The game could not start', error);
    return undefined;
  }
}

/** What the last frame drew, for `FrameStats` (3D: the surface's plan counts; 2D: canvas draw commands). */
function renderStats(surface3d: BrowserSurface3d | undefined, runtime: GameRuntime, canvas: { readonly width: number; readonly height: number }): RenderStats | null {
  if (surface3d !== undefined) {
    const s = surface3d.stats;
    const counts = surface3d.drawCounts();
    if (s === null || counts === null) return null;
    return {
      backend: s.backend, drawCalls: counts.drawCalls, triangles: counts.triangles, drawCallsByPass: counts.drawCallsByPass,
      trianglesByPass: counts.trianglesByPass, instances: counts.instances, renderScale: s.renderScale,
      renderWidth: s.renderWidth, renderHeight: s.renderHeight, cpuMs: s.cpuMs,
    };
  }
  const frame = runtime.render2d?.lastFrame;
  if (frame === undefined) return null;
  const { width, height } = canvas;
  return {
    backend: 'canvas2d', drawCalls: frame.commands.length, triangles: null, drawCallsByPass: { sprites: frame.commands.length },
    trianglesByPass: {}, instances: frame.commands.length, renderScale: 1, renderWidth: width, renderHeight: height, cpuMs: 0,
  };
}

/**
 * A module worker for `url`. A worker script must be same-origin, so an engine served from
 * another origin starts through a
 * one-line same-origin shim that imports it (the engine's host must allow CORS).
 */
function moduleWorker(url: URL): WorkerLike {
  if (url.origin === location.origin) return new Worker(url, { type: 'module' }) as unknown as WorkerLike;
  const shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }));
  return new Worker(shim, { type: 'module' }) as unknown as WorkerLike;
}

/** Import a build's modules (save migrations first, then the game's, then the entry) and return the entry's exports. */
async function importBuild(buildUrl: URL, manifest: BuildManifest, progress: (fraction: number) => void): Promise<Record<string, unknown>> {
  // Save migrations register first, so a save from an older version loads.
  const modules = [...migrationModules(manifest), ...gameModules(manifest)];
  for (const [i, module] of modules.entries()) {
    await import(new URL(module, buildUrl).href);
    progress((i + 1) / (modules.length + 1));
  }
  return import(new URL(manifest.entry!, buildUrl).href) as Promise<Record<string, unknown>>;
}

/** Give the game's screens, voice and payments plugins (when it lists them) their browser devices. */
function connectNiche(runtime: GameRuntime, options: BrowserBootOptions, sources: GameSources, url: (path: string) => string): void {
  const plugins = runtime.game.plugins;
  const has = (id: string): boolean => plugins.some((p) => p.id === id);
  if (has('screens')) connectScreens(plugins, new DomScreenSurface({ files: sources.files, url }));
  if (has('voice')) connectVoice(plugins, new WebRtcVoice(options.iceServers !== undefined ? { iceServers: [...options.iceServers] } : {}));
  if (has('payments') && options.payments !== undefined) {
    connectPayments(plugins, new HostPagePayments({
      origin: options.payments.origin, ...(options.payments.test !== undefined && { test: options.payments.test }),
    }));
  }
}

/** The joined client's rejoin token, once the server gave one. */
function netToken(runtime: GameRuntime): string | undefined {
  const plugin = runtime.game.plugins.find((p) => p.id === 'net') as { readonly client?: { readonly rejoinToken?: string } } | undefined;
  return plugin?.client?.rejoinToken;
}

/** Print the join link once the relay gave the room its code. */
function announceRoom(net: OpenedNet, signal: string): void {
  const signaling = net.signaling!;
  const poll = (): void => {
    if (signaling.room === null) {
      if (signaling.state !== 'closed') setTimeout(poll, 200);
      return;
    }
    const link = new URL(location.href);
    link.searchParams.set('net', 'join');
    link.searchParams.set('signal', signal);
    link.searchParams.set('room', signaling.room);
    console.info(`Parallax: hosting room ${signaling.room} — players join at ${link.href}`);
  };
  poll();
}
