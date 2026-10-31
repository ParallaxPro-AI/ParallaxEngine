/**
 * The browser adapters against stand-ins for the page (vitest runs in Node: events are real
 * `EventTarget`s, elements are minimal fakes). What a real browser adds — layout, focus,
 * pointer lock — is behind the same few calls these fakes record.
 */

import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../core/index.js';
import { PerformanceClock } from './clock.js';
import { BrowserDisplay } from './display.js';
import type { DisplayHost } from './display.js';
import { fetchProjectFiles } from './http_files.js';
import { BrowserInput, vibrationPattern } from './input.js';
import type { InputHost } from './input.js';
import { LocalStore } from './local_store.js';
import type { WebStorage } from './local_store.js';
import { ErrorOverlay } from './overlay.js';
import { createStage } from './stage.js';

// ── A minimal DOM ──────────────────────────────────────────────────────────────

class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = '';
  className = '';
  value = '';
  focused = false;
  locks = 0;

  constructor(doc: FakeDocument, tag: string) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }

  append(...nodes: FakeElement[]): void {
    for (const n of nodes) { n.parent = this; this.children.push(n); }
  }

  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  contains(node: unknown): boolean {
    for (let n = node as FakeElement | null; n !== null && n !== undefined; n = n.parent) if (n === this) return true;
    return false;
  }

  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 10, top: 20, width: 800, height: 600 };
  }
  requestPointerLock(): void { this.locks++; }
  focus(): void { this.ownerDocument.activeElement = this as unknown as Element; }
  blur(): void { this.ownerDocument.activeElement = null; }

  /** All text below this element, depth first. */
  text(): string[] {
    return [this.textContent, ...this.children.flatMap((c) => c.text())].filter((t) => t !== '');
  }
}

class FakeDocument extends EventTarget {
  activeElement: Element | null = null;
  pointerLockElement: Element | null = null;
  visibilityState = 'visible';
  exits = 0;
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  exitPointerLock(): void { this.exits++; this.pointerLockElement = null; }
}

function event(type: string, props: Record<string, unknown>, target?: unknown): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  if (target !== undefined) Object.defineProperty(e, 'target', { value: target });
  return e;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PerformanceClock', () => {
  it('reads performance.now() in seconds', () => {
    let ms = 1500;
    const clock = new PerformanceClock({ now: () => ms });
    expect(clock.now()).toBe(1.5);
    ms = 2000;
    expect(clock.now()).toBe(2);
  });
});

describe('LocalStore', () => {
  function storage(): WebStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get length() { return data.size; },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); },
    };
  }

  it('scopes keys to the game', () => {
    const s = storage();
    s.setItem('other', 'x');
    const store = new LocalStore('paddle_duel', { storage: () => s, onProblem: () => {} });
    store.set('best', '12');
    store.set('volume', '0.5');
    expect(s.data.get('parallax:paddle_duel:best')).toBe('12');
    expect(store.get('best')).toBe('12');
    expect(store.keys()).toEqual(['best', 'volume']);
    store.delete('best');
    expect(store.get('best')).toBeUndefined();
  });

  it('keeps running without storage and reports it once (PP9520)', () => {
    const problems: Diagnostic[] = [];
    const store = new LocalStore('paddle_duel', {
      storage: () => { throw new Error('SecurityError'); },
      onProblem: (d) => problems.push(d),
    });
    store.set('best', '1');
    expect(store.get('best')).toBeUndefined();
    expect(store.keys()).toEqual([]);
    expect(problems.map((d) => [d.code, d.severity])).toEqual([['PP9520', 'warning']]);
    expect(problems[0]!.message).toMatch(/SecurityError/);
  });

  it('reports a full quota on write', () => {
    const problems: Diagnostic[] = [];
    const s = storage();
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    new LocalStore('g', { storage: () => s, onProblem: (d) => problems.push(d) }).set('k', 'v');
    expect(problems[0]!.message).toMatch(/could not be written: QuotaExceededError/);
  });
});

describe('fetchProjectFiles', () => {
  const served: Record<string, string> = {
    'http://x/project-files.json': JSON.stringify({ files: ['config/rules.json', 'ui/hud.html', 'assets/a b.png', 'scenes/main/scene.json'] }),
    'http://x/project/config/rules.json': '{"lives":3}',
    'http://x/project/ui/hud.html': '<div></div>',
    'http://x/project/scenes/main/scene.json': '{"entities":[]}',
  };
  const fetchFn = async (url: string): Promise<Response> =>
    served[url] === undefined ? new Response('', { status: 404 }) : new Response(served[url]);

  it('fetches the text files the index lists, not binary assets', async () => {
    const { files, paths } = await fetchProjectFiles({ index: 'http://x/project-files.json', base: 'http://x/project/', fetch: fetchFn });
    expect(paths).toEqual(['assets/a b.png', 'config/rules.json', 'scenes/main/scene.json', 'ui/hud.html']);
    // Every served path is listed (renderers find assets by listing); binary ones aren't readable.
    expect(files.list()).toEqual(paths);
    expect(files.read('config/rules.json')).toBe('{"lives":3}');
    expect(() => files.read('assets/a b.png')).toThrow(/PP9526/);
  });

  it('fails with PP9505 on a missing file or a bad index', async () => {
    const missing = async (url: string): Promise<Response> =>
      url.endsWith('rules.json') ? new Response('', { status: 404 }) : fetchFn(url);
    await expect(fetchProjectFiles({ index: 'http://x/project-files.json', base: 'http://x/project/', fetch: missing }))
      .rejects.toThrow(/PP9505.*config\/rules\.json.*HTTP 404/);
    const bad = async (): Promise<Response> => new Response('{"nope":1}');
    await expect(fetchProjectFiles({ index: 'http://x/i', base: 'http://x/', fetch: bad })).rejects.toThrow(/PP9505.*no "files" list/);
    const down = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };
    await expect(fetchProjectFiles({ index: 'http://x/i', base: 'http://x/', fetch: down })).rejects.toThrow(/PP9505.*Failed to fetch/);
  });
});

describe('BrowserInput', () => {
  function setup(pads: (Gamepad | null)[] = [], screenScale?: () => number) {
    const doc = new FakeDocument();
    const window = new EventTarget();
    const stage = doc.createElement('div');
    const ui = doc.createElement('div');
    const panel = doc.createElement('button');
    ui.append(panel);
    stage.append(ui);
    const text = doc.createElement('input');
    const vibrations: (number | number[])[] = [];
    const problems: Diagnostic[] = [];
    const host: InputHost = {
      window,
      document: doc as unknown as InputHost['document'],
      navigator: { getGamepads: () => pads, vibrate: (ms) => { vibrations.push(ms); return true; } },
    };
    const input = new BrowserInput({
      stage: stage as unknown as HTMLElement, ui: ui as unknown as Element, textInput: text as unknown as HTMLInputElement,
      host, onProblem: (d) => problems.push(d), ...(screenScale !== undefined && { screenScale }),
    });
    return { input, doc, window, stage, ui, panel, text, vibrations, problems };
  }

  const NO_OUTPUT = { cursor: 'free', textEntry: false, rumble: [], touch: [] } as const;

  it('reports held keys, taps between polls, and typed text', () => {
    const t = setup();
    const down = event('keydown', { code: 'KeyA', key: 'a', repeat: false });
    t.window.dispatchEvent(down);
    t.window.dispatchEvent(event('keydown', { code: 'Space', key: ' ', repeat: false }));
    t.window.dispatchEvent(event('keyup', { code: 'Space', key: ' ' }));
    t.window.dispatchEvent(event('keydown', { code: 'ArrowUp', key: 'ArrowUp', repeat: false }));
    expect(down.defaultPrevented).toBe(true);
    const s = t.input.poll();
    expect([...s.keys].sort()).toEqual(['ArrowUp', 'KeyA']);
    expect(s.keysPressed).toEqual(['KeyA', 'Space', 'ArrowUp']);
    expect(s.text).toBe('a ');
    t.window.dispatchEvent(event('keydown', { code: 'KeyA', key: 'a', repeat: true }));
    const next = t.input.poll();
    expect(next.keysPressed).toEqual([]);
    expect(next.keys.has('KeyA')).toBe(true);
  });

  it('leaves browser shortcuts and form fields alone, and releases everything on blur', () => {
    const t = setup();
    const reload = event('keydown', { code: 'KeyR', key: 'r', metaKey: true, repeat: false });
    t.window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(false);
    const field = t.doc.createElement('textarea');
    t.window.dispatchEvent(event('keydown', { code: 'KeyB', key: 'b', repeat: false }, field));
    expect(t.input.poll().keysPressed).toEqual(['KeyR']);
    t.window.dispatchEvent(event('blur', {}));
    expect(t.input.poll().keys.size).toBe(0);
  });

  it('reads the pointer in stage pixels, chorded buttons, wheel notches and UI presses', () => {
    const t = setup();
    const p = (type: string, x: number, y: number, buttons: number, target: unknown = t.stage): void => {
      t.stage.dispatchEvent(event(type, {
        clientX: x + 10, clientY: y + 20, buttons, pointerType: 'mouse', isPrimary: true, pointerId: 1, movementX: 0, movementY: 0,
      }, target));
    };
    p('pointermove', 100, 50, 0);
    t.input.poll();
    p('pointerdown', 110, 60, 1);
    p('pointermove', 110, 60, 3);
    t.stage.dispatchEvent(event('wheel', { deltaY: -200, deltaMode: 0 }));
    let s = t.input.poll();
    expect([s.pointer.x, s.pointer.y, s.pointer.dx, s.pointer.dy]).toEqual([110, 60, 10, 10]);
    expect(s.pointer.pressed).toEqual(['left', 'right']);
    expect([...s.pointer.buttons]).toEqual(['left', 'right']);
    expect(s.pointer.wheel).toBe(2);
    expect(s.pointer.pressedOverUi).toBe(false);
    p('pointerup', 110, 60, 0);
    s = t.input.poll();
    expect(s.pointer.buttons.size).toBe(0);
    expect(s.pointer.dx).toBe(0);
    p('pointerdown', 5, 5, 1, t.panel);
    expect(t.input.poll().pointer.pressedOverUi).toBe(true);
  });

  it('reports the pointer in screen (canvas backing) pixels on a high-DPI display; movement stays in CSS pixels', () => {
    let scale = 2;
    const t = setup([], () => scale);
    const p = (type: string, x: number, y: number, buttons: number): void => {
      t.stage.dispatchEvent(event(type, {
        clientX: x + 10, clientY: y + 20, buttons, pointerType: 'mouse', isPrimary: true, pointerId: 1, movementX: 0, movementY: 0,
      }, t.stage));
    };
    p('pointermove', 100, 50, 0);
    t.input.poll();
    p('pointerdown', 110, 60, 1);
    const s = t.input.poll();
    // Cameras resolve the screen in backing pixels: CSS (110, 60) at a pixel ratio of 2.
    expect([s.pointer.x, s.pointer.y, s.pointer.dx, s.pointer.dy]).toEqual([220, 120, 10, 10]);
    expect(s.pointer.pressed).toEqual(['left']);
    scale = 1.5; // the canvas was refit (another display)
    expect([t.input.poll().pointer.x]).toEqual([165]);
    scale = Number.NaN;
    expect([t.input.poll().pointer.x]).toEqual([110]);
  });

  it('uses only the primary touch as the pointer', () => {
    const t = setup();
    const touch = (id: number, primary: boolean, buttons: number, type = 'pointerdown'): void => {
      t.stage.dispatchEvent(event(type, { clientX: 50, clientY: 50, buttons, pointerType: 'touch', isPrimary: primary, pointerId: id }));
    };
    touch(7, true, 1);
    touch(8, false, 1);
    touch(8, false, 0, 'pointerup');
    const s = t.input.poll();
    expect(s.pointer.pressed).toEqual(['left']);
    expect(s.pointer.buttons.has('left')).toBe(true);
    t.stage.dispatchEvent(event('pointercancel', { pointerId: 7 }));
    expect(t.input.poll().pointer.buttons.size).toBe(0);
  });

  it('locks the pointer on a press while the game wants mouse-look, and reads raw movement', () => {
    const t = setup();
    t.input.present({ ...NO_OUTPUT, cursor: 'locked' });
    t.stage.dispatchEvent(event('pointerdown', { clientX: 0, clientY: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1 }));
    expect(t.stage.locks).toBe(1);
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.stage.dispatchEvent(event('pointermove', { clientX: 0, clientY: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1, movementX: 4, movementY: -3 }));
    t.input.poll();
    const s = t.input.poll();
    expect([s.pointer.dx, s.pointer.dy]).toEqual([0, 0]);
    t.stage.dispatchEvent(event('pointermove', { clientX: 0, clientY: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1, movementX: 4, movementY: -3 }));
    expect([t.input.poll().pointer.dx]).toEqual([4]);
    t.input.present(NO_OUTPUT);
    expect(t.doc.exits).toBe(1);
  });

  it('lock() locks at once from a host gesture; a refusal is quiet', () => {
    const t = setup();
    t.input.lock();
    expect(t.stage.locks).toBe(1);
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.lock(); // already locked: no second request
    expect(t.stage.locks).toBe(1);
    t.doc.pointerLockElement = null;
    (t.stage as unknown as { requestPointerLock(): Promise<void> }).requestPointerLock = () => Promise.reject(new Error('no gesture'));
    expect(() => t.input.lock()).not.toThrow();
  });

  it('suspended (a host showing something else): reads nothing, leaves keys to the page, frees the lock', () => {
    const t = setup();
    t.window.dispatchEvent(event('keydown', { code: 'KeyW', key: 'w', repeat: false }));
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.setSuspended(true);
    expect(t.input.suspended).toBe(true);
    expect(t.doc.exits).toBe(1);
    t.doc.pointerLockElement = null;
    const key = event('keydown', { code: 'KeyD', key: 'd', repeat: false });
    t.window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    t.stage.dispatchEvent(event('pointerdown', { clientX: 5, clientY: 5, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1 }));
    let s = t.input.poll();
    expect(s.keys.size).toBe(0);
    expect(s.keysPressed).toEqual([]);
    expect(s.pointer.pressed).toEqual([]);
    expect(s.text).toBe('');
    // A locked cursor asked for while suspended neither locks nor exits anything.
    t.input.present({ ...NO_OUTPUT, cursor: 'locked' });
    t.input.lock();
    expect(t.stage.locks).toBe(0);
    t.input.setSuspended(false);
    t.window.dispatchEvent(event('keydown', { code: 'KeyA', key: 'a', repeat: false }));
    s = t.input.poll();
    expect([...s.keys]).toEqual(['KeyA']);
  });

  it('reads standard gamepads with y up and press edges, ignoring unmapped ones once-reported', () => {
    const button = (pressed: boolean, value = pressed ? 1 : 0) => ({ pressed, value, touched: pressed });
    const buttons = Array.from({ length: 17 }, () => button(false));
    const pad = { id: 'pad', index: 0, connected: true, mapping: 'standard', axes: [0.5, 0.25, 0, -1], buttons, timestamp: 0 } as unknown as Gamepad;
    const odd = { id: 'odd stick', index: 1, connected: true, mapping: '', axes: [], buttons: [], timestamp: 0 } as unknown as Gamepad;
    const t = setup([pad, odd, null]);
    buttons[0] = button(true);
    buttons[7] = button(false, 0.75);
    let s = t.input.poll();
    expect(s.gamepads[0]!.pressed).toEqual(['south']);
    expect(s.gamepads[0]!.axes).toMatchObject({ leftX: 0.5, leftY: -0.25, rightY: 1, rightTrigger: 0.75 });
    expect(s.gamepads.slice(1)).toEqual([null, null]);
    s = t.input.poll();
    expect(s.gamepads[0]!.pressed).toEqual([]);
    expect(s.gamepads[0]!.buttons.has('south')).toBe(true);
    expect(t.problems.map((d) => d.code)).toEqual(['PP9521']);
  });

  it('a rumble pattern: the phone gets merged on/off milliseconds, pads one effect per pulse', async () => {
    expect(vibrationPattern([[1, 0.05], [0, 0.05], [0.4, 0.1], [0.8, 0.1]])).toEqual([50, 50, 200]);
    expect(vibrationPattern([[0, 0.1], [1, 0.05]])).toEqual([0, 100, 50]);
    const effects: unknown[] = [];
    const pad = {
      id: 'pad', connected: true, mapping: 'standard', axes: [], buttons: [],
      vibrationActuator: { playEffect: (_type: string, effect: unknown) => { effects.push(effect); return Promise.resolve('complete'); } },
    } as unknown as Gamepad;
    const t = setup([pad]);
    t.input.present({ cursor: 'free', textEntry: false, rumble: [{ pad: null, strength: 1, seconds: 0.03, pattern: [[1, 0.01], [0, 0.01], [0.5, 0.01]] }], touch: [] });
    expect(t.vibrations).toEqual([[10, 10, 10]]);
    expect(effects).toEqual([{ duration: 10, strongMagnitude: 1, weakMagnitude: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(effects).toHaveLength(2);
    expect(effects[1]).toEqual({ duration: 10, strongMagnitude: 0.5, weakMagnitude: 0.5 });
  });

  it('rumbles pads and the phone, and focuses the text field while the game reads text', () => {
    const effects: unknown[] = [];
    const pad = {
      id: 'pad', connected: true, mapping: 'standard', axes: [], buttons: [],
      vibrationActuator: { playEffect: (_type: string, effect: unknown) => { effects.push(effect); return Promise.resolve('complete'); } },
    } as unknown as Gamepad;
    const t = setup([pad]);
    t.input.present({ cursor: 'free', textEntry: true, rumble: [{ pad: null, strength: 0.5, seconds: 0.2 }], touch: [] });
    expect(effects).toEqual([{ duration: 200, strongMagnitude: 0.5, weakMagnitude: 0.5 }]);
    expect(t.vibrations).toEqual([200]);
    expect(t.doc.activeElement).toBe(t.text);
    // The browser's order: keydown on the focused field (bubbling to the window), then, only
    // when keydown wasn't cancelled, the field's input event.
    const type = (code: string, key: string): KeyboardEvent => {
      const down = event('keydown', { code, key, repeat: false }, t.text) as KeyboardEvent;
      t.window.dispatchEvent(down);
      if (!down.defaultPrevented) {
        t.text.value += key;
        t.text.dispatchEvent(event('input', { data: key }));
      }
      return down;
    };
    expect(type('KeyH', 'h').defaultPrevented).toBe(false);
    type('KeyI', 'i');
    type('KeyE', 'é');
    expect(t.input.poll().text).toBe('hié');
    expect(t.text.value).toBe('');
    const tab = event('keydown', { code: 'Tab', key: 'Tab', repeat: false }, t.text);
    t.window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    const keys = t.input.poll();
    expect(keys.text).toBe('');
    expect(keys.keysPressed).toEqual(['Tab']);
    expect(t.text.value).toBe('');
    t.input.present(NO_OUTPUT);
    expect(t.doc.activeElement).toBeNull();
  });

  it('stops listening when disposed', () => {
    const t = setup();
    t.input.dispose();
    t.window.dispatchEvent(event('keydown', { code: 'KeyA', key: 'a', repeat: false }));
    expect(t.input.poll().keysPressed).toEqual([]);
  });
});

describe('BrowserDisplay', () => {
  it('sizes from the stage, follows visibility and resizes, and drives frames on rAF', () => {
    const doc = new FakeDocument();
    const callbacks = new Map<number, () => void>();
    let next = 0;
    let observed: (() => void) | undefined;
    const host: DisplayHost = {
      document: doc,
      devicePixelRatio: 2,
      requestAnimationFrame: (cb) => { callbacks.set(++next, () => cb(0)); return next; },
      cancelAnimationFrame: (h) => { callbacks.delete(h); },
      ResizeObserver: class { constructor(cb: () => void) { observed = cb; } observe(): void {} disconnect(): void {} },
    };
    const display = new BrowserDisplay(doc.createElement('div') as unknown as Element, host);
    expect(display.size()).toEqual({ width: 800, height: 600, pixelRatio: 2 });

    const changes: string[] = [];
    display.onChange((c) => changes.push(c));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    observed!();
    expect(changes).toEqual(['visibility', 'resize']);
    expect(display.visible()).toBe(false);

    let frames = 0;
    const stop = display.frames(() => { frames++; });
    const run = (): void => { const [h, cb] = [...callbacks][0]!; callbacks.delete(h); cb(); };
    run();
    run();
    expect(frames).toBe(2);
    stop();
    expect(callbacks.size).toBe(0);
    display.dispose();
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(changes).toHaveLength(2);
  });
});

describe('createStage and ErrorOverlay', () => {
  it('builds the stage layers and draws diagnostics as text', () => {
    const doc = new FakeDocument();
    const mount = doc.createElement('main');
    const stage = createStage(mount as unknown as HTMLElement);
    const root = mount.children[0]!;
    expect(root.className).toBe('parallax-stage');
    expect(root.children.map((c) => c.className || c.tagName)).toEqual(['parallax-surface', 'parallax-touch', 'parallax-ui', 'INPUT']);
    expect(root.style['touchAction']).toBe('none');

    const overlay = new ErrorOverlay(stage.stage);
    overlay.show('The game stopped', [{
      code: 'PP2001', severity: 'error', message: 'Unknown prefab "bal" <script>', path: 'scenes/main/scene.json',
      pointer: '/entities/0/prefab', fix: 'Did you mean "ball"?', docs: 'https://parallaxpro.ai/docs/engine/errors/PP2001',
    }]);
    const shown = root.children[4]!;
    expect(shown.attributes['role']).toBe('alert');
    expect(shown.text()).toEqual([
      'The game stopped',
      'PP2001  Unknown prefab "bal" <script>',
      'at scenes/main/scene.json  (/entities/0/prefab)',
      'Fix: Did you mean "ball"?',
      'https://parallaxpro.ai/docs/engine/errors/PP2001',
    ]);
    overlay.clear();
    expect(root.children).toHaveLength(4);
    expect(overlay.diagnostics).toEqual([]);
    stage.remove();
    expect(mount.children).toEqual([]);
  });
});
