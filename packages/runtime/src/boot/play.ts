/**
 * The production play boot (`/play` pages, store exports): a
 * published game from its build — compiled modules + `manifest.json` under `build`, data
 * and assets as bundles (`bundles.json`, `parallax build --bundle`) or as loose files
 * (`project` + `fileIndex`) — with what a play page needs around `bootBrowser`:
 *
 *   fullscreen   a corner button (and `toggle()` for the host's own), the Fullscreen API
 *                with the WebKit prefix; refused requests are reported, never thrown
 *   focus        the stage takes keyboard focus at the first frame, again on every press on
 *                it and when fullscreen changes, so keys reach the game without a first click
 *   errors       the engine's error overlay (coded diagnostics, a Python traceback); each
 *                failure is also an analytics event
 *   analytics    a port (`PlayAnalytics`): boot stages, the first frame with its timings,
 *                scene loads, failures, fullscreen, and the session's end (frames, seconds)
 *
 * What the boot can fetch, for packaging a game offline, is `playFiles(manifest, index)`:
 * a static list, so an export copies files instead of recording a session.
 */

import { fail } from '../core/index.js';
import type { Diagnostic } from '../core/index.js';
import type { Json } from '../resource/index.js';
import { BUNDLE_INDEX, isPacked } from '../resource/index.js';
import type { BundleIndex } from '../resource/index.js';
import { bootBrowser } from './browser.js';
import type { BrowserBootOptions, BrowserGame } from './browser.js';
import { PROJECT_MODULE_FILE } from './modules.js';
import type { BuildManifest } from './modules.js';

/** What a play page reports. Names are stable; data is plain JSON. */
export type PlayEventName =
  | 'boot_started' | 'boot_stage' | 'first_frame' | 'boot_failed' | 'game_error' | 'scene_loaded' | 'fullscreen' | 'session_end';

/** The host's analytics (an events endpoint, a store SDK); calls must not throw. */
export interface PlayAnalytics {
  event(name: PlayEventName, data: Readonly<Record<string, Json>>): void;
}

export interface PlayBootOptions extends Pick<BrowserBootOptions,
  'mount' | 'build' | 'project' | 'fileIndex' | 'seed' | 'renderer' | 'assetFiles' | 'panelFrame' | 'jobWorker' | 'saves' | 'net'
  | 'payments' | 'splash' | 'branding' | 'iceServers'> {
  /** URL of the packed build's `bundles.json`; without it, the loose files at `project` + `fileIndex`. */
  readonly bundles?: string;
  readonly analytics?: PlayAnalytics;
  /** Show the fullscreen button (default true; a host with its own button passes false and calls `fullscreen.toggle()`). */
  readonly fullscreenButton?: boolean;
}

export interface FullscreenControl {
  readonly active: boolean;
  /** Enter or leave fullscreen; resolves to whether the page is fullscreen afterwards. */
  toggle(): Promise<boolean>;
  dispose(): void;
}

export interface PlayGame {
  readonly game: BrowserGame;
  readonly fullscreen: FullscreenControl;
  stop(): void;
}

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

function fullscreenElement(doc: FullscreenDocument): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Fullscreen for `target`: the standard API, else WebKit's (older iOS iPads, Safari).
 * `onChange` hears every change, including the player pressing Escape.
 */
export function fullscreenControl(target: HTMLElement, onChange: (active: boolean) => void, onRefused: (reason: string) => void): FullscreenControl {
  const doc = target.ownerDocument as FullscreenDocument;
  const el = target as FullscreenElement;
  const changed = (): void => onChange(fullscreenElement(doc) === target);
  doc.addEventListener('fullscreenchange', changed);
  doc.addEventListener('webkitfullscreenchange', changed);
  return {
    get active() { return fullscreenElement(doc) === target; },
    toggle: async () => {
      try {
        if (fullscreenElement(doc) === target) {
          await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
        } else if (el.requestFullscreen !== undefined) {
          await el.requestFullscreen({ navigationUI: 'hide' });
        } else if (el.webkitRequestFullscreen !== undefined) {
          await el.webkitRequestFullscreen();
        } else {
          onRefused('this browser has no fullscreen');
        }
      } catch (error) {
        onRefused((error as Error).message);
      }
      return fullscreenElement(doc) === target;
    },
    dispose: () => {
      doc.removeEventListener('fullscreenchange', changed);
      doc.removeEventListener('webkitfullscreenchange', changed);
    },
  };
}

function fullscreenButton(stage: HTMLElement, toggle: () => void): HTMLButtonElement {
  const button = stage.ownerDocument.createElement('button');
  button.className = 'parallax-fullscreen';
  button.type = 'button';
  button.setAttribute('aria-label', 'Fullscreen');
  button.textContent = '⛶';
  Object.assign(button.style, {
    position: 'absolute', top: '8px', right: '8px', zIndex: '20', width: '36px', height: '36px', border: '0', borderRadius: '6px',
    background: 'rgba(0,0,0,0.45)', color: '#fff', font: '20px/36px system-ui, sans-serif', cursor: 'pointer', padding: '0',
  });
  // A press on the button is not a press on the game.
  button.addEventListener('pointerdown', (e) => e.stopPropagation());
  button.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  stage.append(button);
  return button;
}

function codes(diagnostics: readonly Diagnostic[]): Json {
  return diagnostics.map((d) => d.code);
}

/** Boot a published game for play. Resolves to undefined when it didn't start (the overlay says why). */
export async function bootPlay(options: PlayBootOptions): Promise<PlayGame | undefined> {
  const analytics = options.analytics;
  const report = (name: PlayEventName, data: Readonly<Record<string, Json>>): void => {
    try {
      analytics?.event(name, data);
    } catch (error) {
      console.warn('Parallax: the analytics port threw', error);
    }
  };
  report('boot_started', { renderer: options.renderer ?? null });
  let started = false;
  let stageReached: string | undefined;
  const game = await bootBrowser({
    mount: options.mount,
    build: options.build,
    ...(options.bundles !== undefined && { bundles: options.bundles }),
    ...(options.project !== undefined && { project: options.project }),
    ...(options.fileIndex !== undefined && { fileIndex: options.fileIndex }),
    ...(options.seed !== undefined && { seed: options.seed }),
    ...(options.renderer !== undefined && { renderer: options.renderer }),
    ...(options.assetFiles !== undefined && { assetFiles: options.assetFiles }),
    ...(options.panelFrame !== undefined && { panelFrame: options.panelFrame }),
    ...(options.jobWorker !== undefined && { jobWorker: options.jobWorker }),
    ...(options.saves !== undefined && { saves: options.saves }),
    ...(options.net !== undefined && { net: options.net }),
    ...(options.payments !== undefined && { payments: options.payments }),
    ...(options.splash !== undefined && { splash: options.splash }),
    ...(options.branding !== undefined && { branding: options.branding }),
    ...(options.iceServers !== undefined && { iceServers: options.iceServers }),
    onProgress: (event) => {
      if (event.stage === stageReached) return;
      stageReached = event.stage;
      report('boot_stage', { stage: event.stage, seconds: event.seconds });
    },
    onError: (title, diagnostics) => report(started ? 'game_error' : 'boot_failed', { title, codes: codes(diagnostics) }),
  });
  if (game === undefined) return undefined;
  started = true;
  const stage = game.stage.stage;
  report('first_frame', {
    timings: game.timings.map((t) => ({ stage: t.stage, seconds: t.seconds })), renderer: game.device.renderer ?? null,
    tier: game.device.tier, sources: game.sources.kind, scene: game.runtime.kernel.scene?.id ?? null,
  });

  const focus = (): void => {
    const active = stage.ownerDocument.activeElement;
    // Typing into the game's text field (or a panel's input) keeps its focus.
    if (active !== null && active !== stage && stage.contains(active) && active.tagName !== 'BUTTON') return;
    stage.focus({ preventScroll: true });
  };
  const fullscreen = fullscreenControl(stage, (active) => { report('fullscreen', { active }); focus(); }, (reason) => {
    report('fullscreen', { active: false, refused: reason });
  });
  const button = options.fullscreenButton === false ? undefined : fullscreenButton(stage, () => { void fullscreen.toggle(); });
  stage.addEventListener('pointerdown', focus);
  focus();

  const unobserve = game.runtime.kernel.observeScenes({ loading: (scene) => report('scene_loaded', { scene: scene.id }) });
  const begun = performance.now();
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    report('session_end', { seconds: Math.round((performance.now() - begun) / 100) / 10, frames: game.runtime.kernel.time.frame });
  };
  globalThis.addEventListener('pagehide', end);
  return {
    game,
    fullscreen,
    stop: () => {
      end();
      globalThis.removeEventListener('pagehide', end);
      stage.removeEventListener('pointerdown', focus);
      unobserve();
      button?.remove();
      fullscreen.dispose();
      game.stop();
    },
  };
}

export interface PlayFiles {
  /** Paths under the build URL: the manifest, the generated project module and every module the boot imports. */
  readonly build: readonly string[];
  /** Paths (or absolute URLs, for library assets) relative to the bundles index: the index, every bundle and every loose file. */
  readonly bundles: readonly string[];
}

/**
 * Every file the play boot can fetch for this build, beyond the engine bundle (`boot.js`,
 * `job_worker.js`, `panel_frame.js` and their chunks): what an offline export packages. Lazy
 * bundles (models, sounds) are read by ranges at play time, so they are listed whole.
 */
export function playFiles(manifest: BuildManifest, index: BundleIndex): PlayFiles {
  if (manifest.entry === null) fail('PP9502', 'The build has no game/main.py', { fix: 'Create game/main.py with `game = Game(...)`, then rebuild.' });
  const build = new Set<string>(['manifest.json', PROJECT_MODULE_FILE]);
  for (const m of manifest.modules) {
    // Tests never run in a play page.
    if (m.output === null || m.source.startsWith('tests/') || m.source.includes('/tests/')) continue;
    build.add(m.output);
  }
  const bundles = new Set<string>([BUNDLE_INDEX]);
  for (const info of Object.values(index.bundles)) bundles.add(info.file);
  for (const entry of Object.values(index.files)) if (!isPacked(entry)) bundles.add(entry.url);
  return { build: [...build].sort(), bundles: [...bundles].sort() };
}
