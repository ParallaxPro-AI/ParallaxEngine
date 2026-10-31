/**
 * `parallax screenshot`: argument parsing, the `--keys` language, the schedule of key
 * presses and shots, and finding Chrome. (Driving Chrome itself needs a browser; see
 * docs/cli.md for running it by hand.)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import {
  chromeArgs, collapse, findChrome, keyCode, keyEvent, parseKeys, screenshotArgs, screenshotJson, shotPaths, TAP_SECONDS, timeline,
  toolingFailure, useGpu,
} from './screenshot.js';
import type { ScreenshotResult } from './screenshot.js';

describe('parallax screenshot arguments', () => {
  it('has defaults for everything but the project', () => {
    expect(screenshotArgs(['game'])).toEqual({
      dir: 'game', seconds: 2, shots: 1, every: 1, width: 1280, height: 720, keys: [], timeout: 90, gl: 'auto',
    });
  });

  it('reads every option', () => {
    expect(screenshotArgs([
      'game', '--out', 'a/b.png', '--seconds', '0.5', '--shots', '3', '--every', '2', '--width', '640', '--height', '480',
      '--keys', 'KeyW:2', '--seed', '7', '--timeout', '30', '--gl', 'software',
    ])).toEqual({
      dir: 'game', out: 'a/b.png', seconds: 0.5, shots: 3, every: 2, width: 640, height: 480,
      keys: [{ kind: 'keys', codes: ['KeyW'], seconds: 2 }], seed: 7, timeout: 30, gl: 'software',
    });
    expect(screenshotArgs(['game', '--json'])).toMatchObject({ dir: 'game', json: true });
  });

  it('refuses bad usage', () => {
    expect(screenshotArgs(['game', '--fast'])).toBe('Unknown option --fast');
    expect(screenshotArgs(['game', '--out'])).toBe('--out needs a value');
    expect(screenshotArgs(['game', '--out', 'shot.jpg'])).toBe('--out needs a .png file name');
    expect(screenshotArgs(['game', '--seconds', '-1'])).toMatch(/--seconds needs/);
    expect(screenshotArgs(['game', '--seconds', ''])).toMatch(/--seconds needs/);
    expect(screenshotArgs(['game', '--shots', '0'])).toMatch(/--shots needs/);
    expect(screenshotArgs(['game', '--shots', '1.5'])).toMatch(/--shots needs/);
    expect(screenshotArgs(['game', '--every', '0'])).toMatch(/--every needs/);
    expect(screenshotArgs(['game', '--width', '10'])).toMatch(/--width needs/);
    expect(screenshotArgs(['game', '--seed', 'x'])).toBe('--seed needs a whole number');
    expect(screenshotArgs(['game', '--gl', 'metal'])).toBe('--gl needs auto, gpu or software');
    expect(screenshotArgs(['game', '--keys', 'Hyper'])).toMatch(/unknown key "Hyper"/);
    expect(screenshotArgs(['a', 'b'])).toBe('Unexpected argument b');
  });

  it('is a parallax command (bad usage exits 2)', async () => {
    expect(await main(['screenshot', '.', '--shots', 'many'])).toBe(2);
    expect(await main(['screenshot', '.', '--keys', 'KeyW:'])).toBe(2);
  });
});

describe('--keys', () => {
  it('holds keys, chords, clicks and waits, one step after another', () => {
    expect(parseKeys('KeyW:2, Space, wait:0.5, ArrowLeft+KeyW:1, click, click@100x200:0.3')).toEqual([
      { kind: 'keys', codes: ['KeyW'], seconds: 2 },
      { kind: 'keys', codes: ['Space'], seconds: TAP_SECONDS },
      { kind: 'wait', seconds: 0.5 },
      { kind: 'keys', codes: ['ArrowLeft', 'KeyW'], seconds: 1 },
      { kind: 'click', seconds: TAP_SECONDS },
      { kind: 'click', seconds: 0.3, at: { x: 100, y: 200 } },
    ]);
  });

  it('takes friendly names for keys', () => {
    expect(['w', 'W', '1', 'space', 'up', 'Shift', 'esc', 'Enter', 'F5'].map(keyCode))
      .toEqual(['KeyW', 'KeyW', 'Digit1', 'Space', 'ArrowUp', 'ShiftLeft', 'Escape', 'Enter', 'F5']);
    expect(keyCode('Hyper')).toBeUndefined();
  });

  it('sends each code with its key and keyCode (and text when it types)', () => {
    expect(keyEvent('KeyW')).toEqual({ key: 'w', keyCode: 87, text: 'w' });
    expect(keyEvent('Digit3')).toEqual({ key: '3', keyCode: 51, text: '3' });
    expect(keyEvent('Space')).toEqual({ key: ' ', keyCode: 32, text: ' ' });
    expect(keyEvent('ArrowUp')).toEqual({ key: 'ArrowUp', keyCode: 38 });
    expect(keyEvent('F1')).toEqual({ key: 'F1', keyCode: 112 });
  });

  it('refuses steps it cannot run', () => {
    expect(parseKeys('')).toBe('--keys needs at least one step');
    expect(parseKeys('wait')).toMatch(/wait needs seconds/);
    expect(parseKeys('KeyW:x')).toMatch(/needs a number of seconds/);
    expect(parseKeys('KeyW:1:2')).toMatch(/bad step/);
    expect(parseKeys('click@middle')).toMatch(/click@640x360/);
  });
});

describe('the schedule', () => {
  it('runs the keys from the start and the shots after --seconds, every --every, by seconds of play', () => {
    const keys = parseKeys('KeyW:3,click@10x20,wait:1,Space') as Exclude<ReturnType<typeof parseKeys>, string>;
    expect(timeline({ keys, seconds: 2, shots: 2, every: 2 })).toEqual([
      { at: 0, kind: 'down', code: 'KeyW' },
      { at: 2, kind: 'shot' },
      { at: 3, kind: 'up', code: 'KeyW' },
      { at: 3, kind: 'press', point: { x: 10, y: 20 } },
      { at: 3.1, kind: 'release', point: { x: 10, y: 20 } },
      { at: 4, kind: 'shot' },
      { at: 4.1, kind: 'down', code: 'Space' },
      { at: 4.1 + TAP_SECONDS, kind: 'up', code: 'Space' },
    ]);
  });

  it('presses a key due with a shot before the shot', () => {
    const keys = parseKeys('wait:1,KeyD:1') as Exclude<ReturnType<typeof parseKeys>, string>;
    expect(timeline({ keys, seconds: 1, shots: 1, every: 1 }).map((a) => a.kind)).toEqual(['down', 'shot', 'up']);
  });

  it('numbers the files of several shots', () => {
    expect(shotPaths('/x/shot.png', 1)).toEqual(['/x/shot.png']);
    expect(shotPaths('/x/shot.png', 3)).toEqual(['/x/shot-1.png', '/x/shot-2.png', '/x/shot-3.png']);
  });
});

describe('Chrome', () => {
  const only = (...paths: string[]) => (path: string): boolean => paths.includes(path);

  it('prefers $PARALLAX_CHROME, then $CHROME_PATH, then the usual install paths', () => {
    expect(findChrome({ PARALLAX_CHROME: '/a', CHROME_PATH: '/b' }, 'linux', only('/a', '/b'))).toEqual({ path: '/a' });
    expect(findChrome({ CHROME_PATH: '/b' }, 'linux', only('/b', '/usr/bin/chromium'))).toEqual({ path: '/b' });
    expect(findChrome({}, 'linux', only('/usr/bin/chromium'))).toEqual({ path: '/usr/bin/chromium' });
    expect(findChrome({}, 'darwin', only('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')))
      .toEqual({ path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  });

  it('says how to fix a missing or misnamed Chrome', () => {
    expect(findChrome({ PARALLAX_CHROME: '/nope' }, 'linux', only())).toEqual({ error: expect.stringMatching(/PARALLAX_CHROME is set to \/nope/) });
    expect(findChrome({}, 'linux', only())).toEqual({ error: expect.stringMatching(/set PARALLAX_CHROME/) });
  });

  it('runs headless on SwiftShader on Linux (CI) and on the GPU elsewhere, unless told', () => {
    expect([useGpu('auto', 'linux'), useGpu('auto', 'darwin'), useGpu('gpu', 'linux'), useGpu('software', 'darwin')]).toEqual([false, true, true, false]);
    const software = chromeArgs('/tmp/p', { width: 800, height: 600 }, false, true);
    expect(software).toEqual(expect.arrayContaining([
      '--headless=new', '--remote-debugging-port=0', '--user-data-dir=/tmp/p', '--window-size=800,600', '--use-angle=swiftshader', '--no-sandbox',
    ]));
    const gpu = chromeArgs('/tmp/p', { width: 800, height: 600 }, true, false);
    expect(gpu).not.toContain('--use-angle=swiftshader');
    expect(gpu).not.toContain('--no-sandbox');
  });
});

describe('the page console', () => {
  it('shows each message once with a count, warnings by their first line', () => {
    expect(collapse([
      { level: 'error', text: 'Uncaught boom\n  at x.py' },
      { level: 'warning', text: 'PP2201  a warning\n  Fix: …' },
      { level: 'warning', text: 'PP2201  a warning\n  Fix: …' },
    ])).toEqual(['error: Uncaught boom\n  at x.py', 'warning: PP2201  a warning (×2)']);
  });
});

describe('--json', () => {
  it('reports the boot outcome, each shot with its moment of play, the console and the game\'s errors', () => {
    const result: ScreenshotResult = {
      files: ['/x/shot-1.png', '/x/shot-2.png'],
      messages: [{ level: 'warning', text: 'PP2201  a warning' }, { level: 'error', text: 'Uncaught boom' }],
      gameErrors: ['The game stopped\nPP1000 x'], errors: [{ title: 'The game stopped', diagnostics: [{ code: 'PP1000', message: 'x' }] }],
      traceback: 'Traceback (most recent call last):\n  File "game/main.py", line 3',
      boot: 'stopped', bootSeconds: 1.4,
      shots: [{ path: '/x/shot-1.png', seconds: 2, frame: 120, held: ['KeyW'] }, { path: '/x/shot-2.png', seconds: 2.5, frame: 150, held: [] }],
      failure: 'The game stopped with an error (the shot shows its error screen).',
    };
    const json = JSON.parse(JSON.stringify(screenshotJson(result))) as Record<string, unknown>;
    expect(json).toEqual({
      ok: false,
      boot: { outcome: 'stopped', seconds: 1.4 },
      failure: 'The game stopped with an error (the shot shows its error screen).',
      shots: [{ path: '/x/shot-1.png', seconds: 2, frame: 120, held: ['KeyW'] }, { path: '/x/shot-2.png', seconds: 2.5, frame: 150, held: [] }],
      console: { errors: 1, warnings: 1, messages: result.messages },
      game: { errors: result.errors, traceback: result.traceback, text: result.gameErrors },
    });
  });

  it('a clean run is ok, with no failure or traceback keys', () => {
    const json = screenshotJson({ files: ['/x/s.png'], messages: [], gameErrors: [], errors: [], boot: 'running', bootSeconds: 0.8,
      shots: [{ path: '/x/s.png', seconds: 2, held: [] }] });
    expect(json).toEqual({ ok: true, boot: { outcome: 'running', seconds: 0.8 }, shots: [{ path: '/x/s.png', seconds: 2, held: [] }],
      console: { errors: 0, warnings: 0, messages: [] }, game: { errors: [], text: [] } });
  });

  it('prints a report on stdout, exit 1, when the tooling cannot run (no Chrome launched: not a project)', async () => {
    expect(screenshotJson(toolingFailure('no Chrome'))).toMatchObject({ ok: false, boot: { outcome: 'error' }, failure: 'no Chrome', shots: [] });
    const dir = mkdtempSync(`${tmpdir()}/parallax-shot-json-`);
    const out: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['screenshot', dir, '--json'])).toBe(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    const json = JSON.parse(out.join('')) as { ok: boolean; boot: { outcome: string }; failure: string };
    expect(json.ok).toBe(false);
    expect(json.boot.outcome).toBe('error');
    expect(json.failure).toMatch(/is not a project/);
  });
});
