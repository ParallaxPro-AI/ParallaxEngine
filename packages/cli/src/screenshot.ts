/**
 * `parallax screenshot <project>`: look at the running game. Build the project (into a
 * temporary folder: the project is not touched), serve the game page on a free localhost
 * port, open it in headless Chrome (driven over the DevTools protocol, no extra
 * dependency), wait until the game is running, optionally press keys, and write PNGs.
 *
 * "Running" means the page's `bootBrowser` resolved (`globalThis.parallaxGame` is set) and
 * the kernel has stepped at least one frame; the first shot also waits for the page's
 * downloads (models, textures, sounds) to go quiet, so it never shows the loading bar.
 * The game failing to start (a build error, an exception while starting) or stopping
 * (an uncaught error while running) is reported with the page's console errors, and the
 * command exits 1. Every child process (Chrome) and temporary folder is removed on exit,
 * on failure and on SIGINT/SIGTERM.
 *
 * Keys (`--keys`) are a sequence of steps, run one after another from the moment the game
 * is running, while the shots are taken on their own schedule (`--seconds`, then every
 * `--every` seconds): `"KeyW:2,Space,wait:0.5,ArrowLeft+KeyW:1,click,click@640x400"`.
 * Both count seconds of play on the game's own clock (`time.realNow`), not the wall clock,
 * so a machine drawing slowly (SwiftShader) still shows what N seconds of play look like.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import process from 'node:process';
import { formatDiagnostic } from '@parallax/runtime/core';
import { buildProject } from './build.js';
import { bundleEngine } from './bundle.js';
import { startDevServer } from './dev_server.js';
import type { DevServer } from './dev_server.js';

export const SCREENSHOT_USAGE = `Usage:
  parallax screenshot <project> [--out FILE.png] [--seconds N] [--shots N] [--every S]
                      [--width W] [--height H] [--keys STEPS] [--seed N] [--timeout S] [--gl auto|gpu|software]
                      [--json]
                 run the game in headless Chrome and write PNGs once it has played N seconds;
                 --keys "KeyW:2,Space,wait:1,click@640x360" holds/presses keys and clicks meanwhile;
                 --json prints a report (shots, boot outcome, console, game errors) instead of text
`;

export interface ScreenshotArgs {
  readonly dir: string;
  /** The first shot's file; more shots are numbered next to it (`shot-2.png`). Default `<project>/build/screenshot.png`. */
  readonly out?: string;
  /** Seconds of play before the first shot (default 2). */
  readonly seconds: number;
  readonly shots: number;
  /** Seconds between shots (default 1). */
  readonly every: number;
  readonly width: number;
  readonly height: number;
  readonly keys: readonly KeyStep[];
  readonly seed?: number;
  /** Seconds to wait for the game to start (default 90). */
  readonly timeout: number;
  /**
   * How Chrome draws WebGL: the machine's GPU, or SwiftShader (software: slow, but works on
   * any CI machine). `auto` (default): the GPU on macOS and Windows, SwiftShader on Linux.
   */
  readonly gl: 'auto' | 'gpu' | 'software';
  /** Print a JSON report on stdout (`screenshotJson`) instead of text. */
  readonly json?: boolean;
}

/** One `--keys` step: hold keys for a while, click (the middle of the game, or `at` in pixels), or wait. */
export type KeyStep =
  | { readonly kind: 'keys'; readonly codes: readonly string[]; readonly seconds: number }
  | { readonly kind: 'click'; readonly seconds: number; readonly at?: { readonly x: number; readonly y: number } }
  | { readonly kind: 'wait'; readonly seconds: number };

/** How long a key without `:seconds` is held: a tap the game sees for a few frames. */
export const TAP_SECONDS = 0.1;

const ALIASES: Readonly<Record<string, string>> = {
  space: 'Space', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  shift: 'ShiftLeft', ctrl: 'ControlLeft', control: 'ControlLeft', alt: 'AltLeft',
};

const NAMED: Readonly<Record<string, readonly [key: string, keyCode: number]>> = {
  Space: [' ', 32], Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  ShiftLeft: ['Shift', 16], ShiftRight: ['Shift', 16], ControlLeft: ['Control', 17], ControlRight: ['Control', 17],
  AltLeft: ['Alt', 18], AltRight: ['Alt', 18], Minus: ['-', 189], Equal: ['=', 187], Comma: [',', 188], Period: ['.', 190],
  Slash: ['/', 191], Semicolon: [';', 186], Quote: ['\'', 222], BracketLeft: ['[', 219], BracketRight: [']', 221],
  Backslash: ['\\', 220], Backquote: ['`', 192],
};

/** What a `KeyboardEvent.code` sends: its `key` and legacy `keyCode`; undefined: not a key this knows. */
export function keyEvent(code: string): { key: string; keyCode: number; text?: string } | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return { key: letter[1]!.toLowerCase(), keyCode: letter[1]!.charCodeAt(0), text: letter[1]!.toLowerCase() };
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return { key: digit[1]!, keyCode: 48 + Number(digit[1]), text: digit[1]! };
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn !== null) return { key: code, keyCode: 111 + Number(fn[1]) };
  const named = NAMED[code];
  if (named === undefined) return undefined;
  return { key: named[0], keyCode: named[1], ...(named[0].length === 1 && { text: named[0] }) };
}

/** A key name as written (`KeyW`, `w`, `1`, `space`, `up`, `shift`) as a `KeyboardEvent.code`. */
export function keyCode(name: string): string | undefined {
  if (/^[a-z]$/i.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  const code = ALIASES[name.toLowerCase()] ?? name;
  return keyEvent(code) === undefined ? undefined : code;
}

/** `--keys`: `step,step,…`, a step `KeyW[+KeyD…][:seconds]`, `wait:seconds` or `click[@XxY][:seconds]`. */
export function parseKeys(text: string): KeyStep[] | string {
  const steps: KeyStep[] = [];
  for (const raw of text.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const [name, time, extra] = raw.split(':');
    if (extra !== undefined) return `--keys: bad step "${raw}" (write KEY:SECONDS)`;
    const seconds = time === undefined ? undefined : Number(time);
    if (seconds !== undefined && (time!.trim() === '' || !Number.isFinite(seconds) || seconds < 0)) return `--keys: "${raw}" needs a number of seconds after the colon`;
    const lower = name!.trim().toLowerCase();
    if (lower === 'wait') {
      if (seconds === undefined) return '--keys: wait needs seconds (wait:1)';
      steps.push({ kind: 'wait', seconds });
    } else if (lower === 'click' || lower.startsWith('click@')) {
      const at = /^click@(\d+)x(\d+)$/.exec(lower);
      if (lower !== 'click' && at === null) return `--keys: "${raw}" clicks at pixels: click@640x360`;
      steps.push({ kind: 'click', seconds: seconds ?? TAP_SECONDS, ...(at !== null && { at: { x: Number(at[1]), y: Number(at[2]) } }) });
    } else {
      const codes: string[] = [];
      for (const part of name!.split('+').map((s) => s.trim())) {
        const code = keyCode(part);
        if (code === undefined) return `--keys: unknown key "${part}" (use KeyboardEvent.code names: KeyW, Space, ArrowUp, ShiftLeft, Digit1, Enter…)`;
        codes.push(code);
      }
      steps.push({ kind: 'keys', codes, seconds: seconds ?? TAP_SECONDS });
    }
  }
  return steps.length > 0 ? steps : '--keys needs at least one step';
}

/** One thing at a moment of play: a key or mouse button going down or up, or a shot. */
export type Action =
  | { readonly at: number; readonly kind: 'down' | 'up'; readonly code: string }
  | { readonly at: number; readonly kind: 'press' | 'release'; readonly point?: { readonly x: number; readonly y: number } }
  | { readonly at: number; readonly kind: 'shot' };

/** The `--keys` steps (one after another from 0) and the shots, by seconds of play, in order. */
export function timeline(args: Pick<ScreenshotArgs, 'keys' | 'seconds' | 'shots' | 'every'>): Action[] {
  const out: Action[] = [];
  let t = 0;
  for (const step of args.keys) {
    if (step.kind === 'keys') {
      for (const code of step.codes) out.push({ at: t, kind: 'down', code });
      for (const code of [...step.codes].reverse()) out.push({ at: t + step.seconds, kind: 'up', code });
    } else if (step.kind === 'click') {
      out.push({ at: t, kind: 'press', ...(step.at !== undefined && { point: step.at }) }, { at: t + step.seconds, kind: 'release', ...(step.at !== undefined && { point: step.at }) });
    }
    t += step.seconds;
  }
  for (let i = 0; i < args.shots; i++) out.push({ at: args.seconds + i * args.every, kind: 'shot' });
  // Stable: at the same moment, keys go down before the shot and in the order written.
  return out.map((a, i) => ({ a, i })).sort((x, y) => x.a.at - y.a.at || x.i - y.i).map((x) => x.a);
}

export function screenshotArgs(argv: readonly string[]): ScreenshotArgs | string {
  const valued = ['--out', '--seconds', '--shots', '--every', '--width', '--height', '--keys', '--seed', '--timeout', '--gl'];
  const values: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (arg === '--json') { json = true; continue; }
    if (!valued.includes(arg)) return `Unknown option ${arg}`;
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
    values[arg] = value;
  }
  if (positional.length > 1) return `Unexpected argument ${positional[1]!}`;
  const number = (name: string, fallback: number, ok: (n: number) => boolean, what: string): number | string => {
    const text = values[name];
    if (text === undefined) return fallback;
    const n = Number(text);
    return text.trim() !== '' && ok(n) ? n : `${name} needs ${what}`;
  };
  const seconds = number('--seconds', 2, (n) => Number.isFinite(n) && n >= 0, 'a number of seconds');
  const shots = number('--shots', 1, (n) => Number.isInteger(n) && n >= 1 && n <= 100, 'a whole number from 1 to 100');
  const every = number('--every', 1, (n) => Number.isFinite(n) && n > 0, 'a number of seconds above 0');
  const width = number('--width', 1280, (n) => Number.isInteger(n) && n >= 16 && n <= 7680, 'a width in pixels (16–7680)');
  const height = number('--height', 720, (n) => Number.isInteger(n) && n >= 16 && n <= 4320, 'a height in pixels (16–4320)');
  const timeout = number('--timeout', 90, (n) => Number.isFinite(n) && n > 0, 'a number of seconds above 0');
  const seed = number('--seed', Number.NaN, Number.isInteger, 'a whole number');
  for (const v of [seconds, shots, every, width, height, timeout, seed]) if (typeof v === 'string') return v;
  const keys = values['--keys'] === undefined ? [] : parseKeys(values['--keys']);
  if (typeof keys === 'string') return keys;
  const gl = values['--gl'] ?? 'auto';
  if (gl !== 'auto' && gl !== 'gpu' && gl !== 'software') return '--gl needs auto, gpu or software';
  const out = values['--out'];
  if (out !== undefined && extname(out).toLowerCase() !== '.png') return '--out needs a .png file name';
  return {
    dir: positional[0] ?? process.cwd(), seconds: seconds as number, shots: shots as number, every: every as number,
    width: width as number, height: height as number, keys, timeout: timeout as number, gl,
    ...(out !== undefined && { out }), ...(!Number.isNaN(seed) && { seed: seed as number }), ...(json && { json }),
  };
}

/** The files `shots` shots go to: `out` itself for one, else `name-1.png`, `name-2.png`, …. */
export function shotPaths(out: string, shots: number): string[] {
  if (shots === 1) return [out];
  const ext = extname(out);
  const stem = out.slice(0, out.length - ext.length);
  return Array.from({ length: shots }, (_, i) => `${stem}-${i + 1}${ext}`);
}

/** Where Chrome usually is, by platform. */
const CHROME_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/opt/google/chrome/chrome',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** Chrome's executable: `$PARALLAX_CHROME`, `$CHROME_PATH`, then the usual install paths; or why there is none. */
export function findChrome(
  env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform, exists: (path: string) => boolean = existsSync,
): { path: string } | { error: string } {
  for (const name of ['PARALLAX_CHROME', 'CHROME_PATH']) {
    const path = env[name];
    if (path === undefined || path === '') continue;
    return exists(path) ? { path } : { error: `${name} is set to ${path}, which does not exist. Point it at a Chrome or Chromium executable.` };
  }
  const found = (CHROME_PATHS[platform] ?? []).find(exists);
  if (found !== undefined) return { path: found };
  return {
    error: 'parallax screenshot needs Google Chrome or Chromium, and none was found.\n'
      + 'Install Chrome (Linux: `apt-get install chromium` or google-chrome-stable), or set PARALLAX_CHROME '
      + '(or CHROME_PATH) to the browser\'s executable, e.g. PARALLAX_CHROME=/usr/bin/chromium.',
  };
}

/** Whether `gl` draws with the GPU on `platform` (`auto`: not on Linux, where CI machines rarely have one). */
export function useGpu(gl: ScreenshotArgs['gl'], platform: string = process.platform): boolean {
  return gl === 'gpu' || (gl === 'auto' && platform !== 'linux');
}

/** Chrome's command line: headless, an isolated profile, WebGL on the GPU or SwiftShader. */
export function chromeArgs(profile: string, args: Pick<ScreenshotArgs, 'width' | 'height'>, gpu: boolean, root = process.getuid?.() === 0): string[] {
  return [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${args.width},${args.height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--mute-audio', '--hide-scrollbars', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    // A headless page is never "hidden", but keep its timers and frames at full speed anyway.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    // SwiftShader stays allowed with the GPU, as the fallback when there is none.
    ...(gpu ? ['--ignore-gpu-blocklist'] : ['--use-angle=swiftshader']), '--enable-unsafe-swiftshader',
    // Chrome refuses to sandbox as root (CI containers).
    ...(root ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/** A DevTools protocol connection (one WebSocket; pages through flattened sessions). */
class Cdp {
  #next = 1;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #listeners: ((m: Message) => void)[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as Message;
      if (m.id !== undefined) {
        const waiting = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.error !== undefined) waiting?.reject(new Error(m.error.message));
        else waiting?.resolve(m.result);
      } else {
        for (const listen of this.#listeners) listen(m);
      }
    });
    ws.addEventListener('close', () => {
      for (const waiting of this.#pending.values()) waiting.reject(new Error('Chrome closed the DevTools connection'));
      this.#pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((done, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => done(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => fail(new Error(`Could not connect to Chrome at ${url}`)), { once: true });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.#next++;
    return new Promise((done, fail) => {
      this.#pending.set(id, { resolve: done as (v: unknown) => void, reject: fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    });
  }

  on(listen: (m: Message) => void): void { this.#listeners.push(listen); }

  close(): void { this.ws.close(); }
}

/** Start Chrome and wait for its DevTools address (printed on stderr). */
function launchChrome(path: string, args: readonly string[], timeoutMs: number): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((done, fail) => {
    let log = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`Chrome did not start within ${timeoutMs / 1000} s.\n${log.trim()}`)); }, timeoutMs);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      log += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (m !== null) { clearTimeout(timer); done({ child, url: m[1]! }); }
    });
    child.on('error', (error) => { clearTimeout(timer); fail(new Error(`Could not run Chrome (${path}): ${error.message}`)); });
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`Chrome exited (code ${code}) before it was ready.\n${log.trim()}`)); });
  });
}

/** What the page says about the game, polled (`STATE_PROBE`). */
interface GameState {
  readonly state: 'loading' | 'running' | 'failed';
  /** While loading: the loading screen's text ("Downloading game data"). */
  readonly stage?: string;
  readonly frame?: number;
  /** The game's real seconds since it started (unscaled). */
  readonly seconds?: number;
  /** Errors the page announced (`parallax-game-error`): a build error, a failed start, a stop. */
  readonly errors: readonly { title: string; diagnostics: readonly unknown[] }[];
  /** The error screen's Python traceback, once shown. */
  readonly traceback?: string;
}

/** Installed before the page's scripts: keeps every `parallax-game-error` the page announces. */
const ERROR_HOOK = `globalThis.__parallaxScreenshot = { errors: [] };
addEventListener('parallax-game-error', (e) => {
  try { globalThis.__parallaxScreenshot.errors.push(JSON.parse(JSON.stringify(e.detail))); } catch { globalThis.__parallaxScreenshot.errors.push({ title: String(e.detail && e.detail.title), diagnostics: [] }); }
});`;

const STATE_PROBE = `(() => {
  const found = document.querySelector('.parallax-traceback');
  const errors = (globalThis.__parallaxScreenshot || { errors: [] }).errors;
  const traceback = found ? found.innerText : undefined;
  if (!('parallaxGame' in globalThis)) {
    const text = document.querySelector('.parallax-loading-text');
    return { state: errors.length > 0 ? 'failed' : 'loading', stage: text ? text.textContent : undefined, errors, traceback };
  }
  const game = globalThis.parallaxGame;
  if (game === undefined || game === null) return { state: 'failed', errors, traceback };
  const time = game.runtime.kernel.time;
  return { state: time.frame > 0 ? 'running' : 'loading', stage: 'first frame', frame: time.frame, seconds: time.realNow, errors, traceback };
})()`;

/** A console message or uncaught exception, as one line. */
export interface PageMessage { readonly level: 'error' | 'warning'; readonly text: string }

function remoteText(arg: Record<string, unknown>): string {
  if (typeof arg['value'] === 'string') return arg['value'];
  if (arg['value'] !== undefined) return JSON.stringify(arg['value']);
  return String(arg['description'] ?? arg['unserializableValue'] ?? arg['type']);
}

/** Show a diagnostic the page announced (it crossed JSON, so it may be partial). */
function diagnosticText(d: unknown): string {
  try {
    return formatDiagnostic(d as Parameters<typeof formatDiagnostic>[0]);
  } catch {
    return JSON.stringify(d);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** One shot written: its file, and the moment of play it shows. */
export interface ShotInfo {
  readonly path: string;
  /** Seconds of play (the game's clock) since the game started running. */
  readonly seconds: number;
  /** The game's frame number, when known. */
  readonly frame?: number;
  /** Keys held as it was taken (`KeyboardEvent.code` names). */
  readonly held: readonly string[];
}

/**
 * How the game's start went: `running` (it started; it may still have stopped later:
 * `stopped`), `build_failed` (the project has build errors), `timeout` (it never finished
 * loading), `failed_to_start` (an error while starting), or `error` (the tooling itself
 * could not run: no Chrome, not a project).
 */
export type BootOutcome = 'running' | 'stopped' | 'build_failed' | 'timeout' | 'failed_to_start' | 'error';

/** An error the game announced: the error screen's title and the diagnostics under it. */
export interface GameError {
  readonly title: string;
  readonly diagnostics: readonly unknown[];
}

export interface ScreenshotResult {
  readonly files: readonly string[];
  readonly messages: readonly PageMessage[];
  /** Errors the game announced (the overlay's titles and diagnostics), as text. */
  readonly gameErrors: readonly string[];
  /** Why there are no shots (the game never started), if so. */
  readonly failure?: string;
  readonly boot: BootOutcome;
  /** Wall-clock seconds from opening the page to the game's first frame (when it started). */
  readonly bootSeconds?: number;
  /** While stuck loading (`timeout`): the loading screen's text. */
  readonly stage?: string;
  /** The shots, in order, with the moment of play each shows. */
  readonly shots: readonly ShotInfo[];
  /** The same errors as `gameErrors`, as data: titles and diagnostics. */
  readonly errors: readonly GameError[];
  /** The error screen's Python traceback, when it showed one. */
  readonly traceback?: string;
}

/**
 * Run the game in headless Chrome and write the shots. Resolves even when the game fails
 * (`failure`, `gameErrors`); throws only when the tooling itself can't run (no Chrome,
 * the project doesn't build).
 */
export async function screenshot(args: ScreenshotArgs, log: (line: string) => void): Promise<ScreenshotResult> {
  const projectDir = resolve(args.dir);
  if (!existsSync(`${projectDir}/game/main.py`)) throw new Error(`${projectDir} is not a project (no game/main.py). Pass the project folder.`);
  const chrome = findChrome();
  if ('error' in chrome) throw new Error(chrome.error);
  const out = resolve(args.out ?? `${projectDir}/build/screenshot.png`);
  const files = shotPaths(out, args.shots);
  const gpu = useGpu(args.gl);

  const scratch = mkdtempSync(`${tmpdir()}/parallax-screenshot-`);
  let server: DevServer | undefined;
  let child: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const cleanup = (): void => {
    cdp?.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    void server?.close();
    // Chrome may still be writing its profile for a moment after the kill.
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* left in the temp folder */ }
  };
  const onSignal = (): void => { cleanup(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', cleanup);
  try {
    const build = buildProject(projectDir, { outDir: `${scratch}/build` });
    const errors = build.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      return {
        files: [], messages: [], gameErrors: errors.map(formatDiagnostic), boot: 'build_failed', shots: [],
        errors: [{ title: 'Build errors', diagnostics: errors }],
        failure: `The project has ${errors.length} build error${errors.length === 1 ? '' : 's'}; fix them (\`parallax check\` lists them).`,
      };
    }
    const engine = await bundleEngine();
    server = await startDevServer({
      projectDir, buildDir: build.buildDir, port: 0,
      state: () => ({ title: basename(projectDir), manifest: build.manifest, diagnostics: build.diagnostics, engine, assetFiles: true }),
    });
    const launched = await launchChrome(chrome.path, chromeArgs(`${scratch}/profile`, args, gpu), 30_000);
    child = launched.child;
    cdp = await Cdp.connect(launched.url);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => cdp!.send<T>(method, params, sessionId);

    const messages: PageMessage[] = [];
    const inflight = new Map<string, string>();
    let lastNetwork = Date.now();
    cdp.on((m) => {
      if (m.sessionId !== sessionId || m.params === undefined) return;
      const p = m.params;
      if (m.method === 'Runtime.consoleAPICalled' && (p['type'] === 'error' || p['type'] === 'warning' || p['type'] === 'assert')) {
        messages.push({ level: p['type'] === 'warning' ? 'warning' : 'error', text: (p['args'] as Record<string, unknown>[]).map(remoteText).join(' ') });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = p['exceptionDetails'] as { text?: string; exception?: { description?: string } };
        messages.push({ level: 'error', text: `Uncaught ${d.exception?.description ?? d.text ?? 'exception'}` });
      } else if (m.method === 'Log.entryAdded') {
        const e = p['entry'] as { level: string; text: string; url?: string };
        if (e.level === 'error' || e.level === 'warning') messages.push({ level: e.level === 'error' ? 'error' : 'warning', text: `${e.text}${e.url !== undefined ? ` (${e.url})` : ''}` });
      } else if (m.method === 'Network.requestWillBeSent') {
        // The game's downloads: not the live-reload stream (it never finishes), nor the engine's
        // own scripts (loaded before the game runs; a worker's script finishes in the worker's session).
        const url = (p['request'] as { url: string }).url;
        if (p['type'] !== 'EventSource' && !url.startsWith(`${server!.url}engine/`)) inflight.set(p['requestId'] as string, url);
        lastNetwork = Date.now();
      } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
        inflight.delete(p['requestId'] as string);
        lastNetwork = Date.now();
      }
    });
    await page('Runtime.enable');
    await page('Log.enable');
    await page('Network.enable');
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride', { width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false });
    await page('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_HOOK });
    const url = `${server.url}${args.seed !== undefined ? `?seed=${args.seed}` : ''}`;
    log(`Running ${basename(projectDir)} at ${url} in headless Chrome (${args.width}x${args.height}${gpu ? ', GPU' : ', SwiftShader'})`);
    await page('Page.navigate', { url });

    const probe = async (): Promise<GameState> => {
      const r = await page<{ result: { value?: GameState }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: STATE_PROBE, returnByValue: true });
      return r.result.value ?? { state: 'loading', errors: [] };
    };
    const gameErrors = (s: GameState): string[] => [
      ...s.errors.map((e) => [e.title, ...e.diagnostics.map(diagnosticText)].join('\n')),
      ...(s.traceback !== undefined ? [s.traceback.trim()] : []),
    ];
    const reported = (s: GameState): Pick<ScreenshotResult, 'gameErrors' | 'errors' | 'traceback'> => ({
      gameErrors: gameErrors(s), errors: s.errors, ...(s.traceback !== undefined && { traceback: s.traceback.trim() }),
    });

    // 1. Until the game is running.
    const startedAt = Date.now();
    let state = await probe();
    while (state.state === 'loading') {
      if (Date.now() - startedAt > args.timeout * 1000) {
        return {
          files: [], messages, ...reported(state), boot: 'timeout', shots: [], ...(state.stage !== undefined && { stage: state.stage }),
          failure: `The game did not start within ${args.timeout} s (stuck at: ${state.stage ?? 'the page loading'}). Raise --timeout for a large game.`,
        };
      }
      await sleep(100);
      state = await probe();
    }
    if (state.state === 'failed') return { files: [], messages, ...reported(state), boot: 'failed_to_start', shots: [], failure: 'The game could not start.' };
    const running = Date.now();
    const bootSeconds = Math.round((running - startedAt) / 100) / 10;
    log(`The game started after ${((running - startedAt) / 1000).toFixed(1)} s`);

    // 2. Keys and shots on the game's clock (its real seconds of play), which a slow
    //    machine (SwiftShader) runs behind the wall clock: a shot "after 2 s" shows 2 s of play.
    const t0 = state.seconds ?? 0;
    const actions = timeline(args);
    const held = new Set<string>();
    const center = { x: Math.round(args.width / 2), y: Math.round(args.height / 2) };
    const run = async (a: Action): Promise<void> => {
      if (a.kind === 'down' || a.kind === 'up') {
        const k = keyEvent(a.code)!;
        if (a.kind === 'down') held.add(a.code); else held.delete(a.code);
        await page('Input.dispatchKeyEvent', {
          type: a.kind === 'down' ? 'keyDown' : 'keyUp', code: a.code, key: k.key, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
          ...(a.kind === 'down' && k.text !== undefined && { text: k.text }),
        });
      } else if (a.kind === 'press' || a.kind === 'release') {
        const at = { ...(a.point ?? center), button: 'left', clickCount: 1 };
        if (a.kind === 'press') await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none' });
        await page('Input.dispatchMouseEvent', { type: a.kind === 'press' ? 'mousePressed' : 'mouseReleased', ...at });
      }
    };
    const written: string[] = [];
    const shots: ShotInfo[] = [];
    const shoot = async (): Promise<void> => {
      const i = written.length;
      const shot = await page<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      mkdirSync(dirname(files[i]!), { recursive: true });
      writeFileSync(files[i]!, Buffer.from(shot.data, 'base64'));
      written.push(files[i]!);
      shots.push({
        path: files[i]!, seconds: Math.round(((state.seconds ?? t0) - t0) * 1000) / 1000,
        ...(state.frame !== undefined && { frame: state.frame }), held: [...held],
      });
      const fps = state.seconds !== undefined && state.seconds > 0 && state.frame !== undefined ? ` ${(state.frame / state.seconds).toFixed(0)} fps,` : '';
      log(`Shot ${i + 1}/${files.length}: game frame ${state.frame ?? '?'} at ${((state.seconds ?? t0) - t0).toFixed(1)} s of play,${fps} held: ${held.size > 0 ? [...held].join('+') : 'nothing'}`);
    };
    // A game too slow to reach the last shot in this much wall time gets its shots anyway.
    const wallLimit = running + Math.max(args.timeout, 10 * (actions.at(-1)?.at ?? 0)) * 1000;
    let quietSince: number | undefined;
    let failure: string | undefined;
    let next = 0;
    while (next < actions.length) {
      state = await probe();
      if (state.errors.length > 0) {
        // The game stopped: give the error screen a moment for its Python traceback, then show it.
        await sleep(500);
        state = await probe();
        await shoot();
        failure = 'The game stopped with an error (the shot shows its error screen).';
        break;
      }
      const late = Date.now() > wallLimit;
      if (late && next === 0) log(`Warning: the game runs too slowly to reach ${actions.at(-1)!.at.toFixed(1)} s of play; shooting now`);
      const now = late ? Number.POSITIVE_INFINITY : (state.seconds ?? t0) - t0;
      while (next < actions.length && actions[next]!.at <= now) {
        const a = actions[next]!;
        if (a.kind === 'shot' && written.length === 0 && !late) {
          // The first shot waits (up to 5 s) for the game's downloads to finish: no half-loaded scene.
          const quiet = inflight.size === 0 && Date.now() - lastNetwork >= 300;
          quietSince ??= Date.now();
          if (!quiet && Date.now() - quietSince < 5000) break;
          if (!quiet) log(`Warning: ${inflight.size} download${inflight.size === 1 ? '' : 's'} still pending at the first shot: ${[...inflight.values()].join(', ')}`);
        }
        if (a.kind === 'shot') await shoot(); else await run(a);
        next++;
      }
      if (next < actions.length) await sleep(20);
    }
    return {
      files: written, messages, ...reported(state), boot: failure !== undefined ? 'stopped' : 'running', bootSeconds, shots,
      ...(failure !== undefined && { failure }),
    };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', cleanup);
    // Let Chrome (and its helpers) exit before its profile is removed, or they write it back.
    cdp?.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child!.once('exit', done));
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(3000)]);
      await sleep(200);
    }
    cleanup();
  }
}

/** Repeated messages once, with a count; a warning by its first line (`parallax check` has the rest). */
export function collapse(messages: readonly PageMessage[]): string[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const line = m.level === 'error' ? `error: ${m.text}` : `warning: ${m.text.split('\n')[0]!}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line));
}

/**
 * The `--json` report: `ok` (the exit code is 0), the boot outcome, each shot's file and
 * moment of play, the page console (errors and warnings, in order), and what the game
 * reported (error titles with their diagnostics, the Python traceback). Paths are absolute.
 */
export function screenshotJson(result: ScreenshotResult): Record<string, unknown> {
  const count = (level: PageMessage['level']): number => result.messages.filter((m) => m.level === level).length;
  return {
    ok: result.failure === undefined,
    boot: { outcome: result.boot, ...(result.bootSeconds !== undefined && { seconds: result.bootSeconds }), ...(result.stage !== undefined && { stage: result.stage }) },
    ...(result.failure !== undefined && { failure: result.failure }),
    shots: result.shots,
    console: { errors: count('error'), warnings: count('warning'), messages: result.messages },
    game: { errors: result.errors, ...(result.traceback !== undefined && { traceback: result.traceback }), text: result.gameErrors },
  };
}

/** A tooling failure (no Chrome, not a project) as a `--json` report. */
export function toolingFailure(message: string): ScreenshotResult {
  return { files: [], messages: [], gameErrors: [], errors: [], shots: [], boot: 'error', failure: message };
}

export async function screenshotMain(argv: readonly string[]): Promise<number> {
  const args = screenshotArgs(argv);
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n\n${SCREENSHOT_USAGE}`);
    return 2;
  }
  let result: ScreenshotResult;
  try {
    result = await screenshot(args, (line) => process.stderr.write(`${line}\n`));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    if (args.json === true) process.stdout.write(`${JSON.stringify(screenshotJson(toolingFailure((error as Error).message)), null, 2)}\n`);
    return 1;
  }
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(screenshotJson(result), null, 2)}\n`);
    if (result.failure !== undefined) process.stderr.write(`${result.failure}\n`);
    return result.failure !== undefined ? 1 : 0;
  }
  const lines = collapse(result.messages);
  if (lines.length > 0) process.stdout.write(`Page console (${result.messages.filter((m) => m.level === 'error').length} errors, ${result.messages.filter((m) => m.level === 'warning').length} warnings):\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
  if (result.gameErrors.length > 0) process.stdout.write(`Game errors:\n${result.gameErrors.map((e) => e.split('\n').map((l) => `  ${l}`).join('\n')).join('\n')}\n`);
  for (const file of result.files) process.stdout.write(`${file}\n`);
  if (result.failure !== undefined) {
    process.stderr.write(`${result.failure}\n`);
    return 1;
  }
  return 0;
}
