/**
 * The virtual cursor on a minimal DOM: a modal over a locked pointer keeps the lock, the
 * cursor appears centred, follows mouse movement (clamped to the stage), and a press under
 * it reaches the control in the panel's shadow root as a real click would (down, up, click;
 * hover attribute; the press counts as over the UI, once). A "system" look unlocks instead.
 * Sliders drag, and a scripted panel's frame gets the events by message.
 */

import { describe, expect, it } from 'vitest';
import type { UiCursor } from '../../../core/index.js';
import { BrowserInput } from '../input.js';
import type { InputHost } from '../input.js';
import { CursorDispatch, frameCursorMessage, HOVER_ATTRIBUTE, virtualCursorFor } from './virtual_cursor.js';

// ── A minimal DOM ──────────────────────────────────────────────────────────────

class FakeMouseEvent extends Event {
  clientX = 0;
  clientY = 0;
  button = 0;
  buttons = 0;
  movementX = 0;
  movementY = 0;
  pointerType = 'mouse';
  pointerId = 1;
  isPrimary = true;
  detail = 0;
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init as EventInit);
    for (const [k, v] of Object.entries(init)) if (!['bubbles', 'cancelable', 'composed'].includes(k)) (this as Record<string, unknown>)[k] = v;
  }
}

type Rect = { left: number; top: number; width: number; height: number };

class FakeShadow {
  hit: (x: number, y: number) => FakeEl | null = () => null;
  readonly parentNode = null;
  activeElement: FakeEl | null = null;
  constructor(readonly host: FakeEl) {}
  elementFromPoint(x: number, y: number): FakeEl | null { return this.hit(x, y); }
  append(...nodes: FakeEl[]): void { for (const n of nodes) n.parentNode = this as unknown as FakeEl; }
}

class FakeEl extends EventTarget {
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly events: string[] = [];
  parentNode: FakeEl | null = null;
  children: FakeEl[] = [];
  shadowRoot: FakeShadow | null = null;
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  className = '';
  type = '';
  value = '';
  min = '';
  max = '';
  step = '';
  disabled = false;
  locks = 0;
  contentWindow: { posted: unknown[]; postMessage(m: unknown): void } | null = null;

  constructor(readonly ownerDocument: FakeDoc, tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get parentElement(): FakeEl | null { return this.parentNode; }
  get isConnected(): boolean { return true; }
  append(...nodes: FakeEl[]): void { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
  replaceChildren(): void { this.children = []; }
  remove(): void {
    if (this.parentNode !== null) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(node: unknown): boolean {
    for (let n = node as FakeEl | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
  }
  querySelectorAll(): FakeEl[] { return []; }
  /** The controls the cursor treats as such, by tag or data-action (enough for these tests). */
  closest(selector: string): FakeEl | null {
    for (let n: FakeEl | null = this; n !== null && n instanceof FakeEl; n = n.parentNode) {
      if (selector.includes('button') && (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName) || n.attributes.has('data-action'))) return n;
      if (selector === '[data-parallax-select]' && n.attributes.has('data-parallax-select')) return n;
    }
    return null;
  }
  requestPointerLock(): void { this.locks++; }
  focus(): void { this.ownerDocument.activeElement = this as unknown as Element; }
  override dispatchEvent(e: Event): boolean {
    this.events.push(e.type);
    const result = super.dispatchEvent(e);
    // Bubble (enough of it): the stage hears what happens inside it.
    if (e.bubbles && this.parentNode instanceof FakeEl) this.parentNode.dispatchEvent(e);
    else if (e.bubbles && this.parentNode !== null) (this.parentNode as unknown as FakeShadow).host.dispatchEvent(e);
    return result;
  }
}

class FakeDoc extends EventTarget {
  activeElement: Element | null = null;
  pointerLockElement: Element | null = null;
  exits = 0;
  hit: (x: number, y: number) => FakeEl | null = () => null;
  readonly defaultView = {
    MouseEvent: FakeMouseEvent, Event, innerWidth: 1024, innerHeight: 768,
    getComputedStyle: () => ({ direction: 'ltr', overflowY: 'visible', fontSize: '16px', font: '16px sans-serif' }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  createElement(tag: string): FakeEl { return new FakeEl(this, tag); }
  elementFromPoint(x: number, y: number): FakeEl | null { return this.hit(x, y); }
  exitPointerLock(): void { this.exits++; this.pointerLockElement = null; }
}

function inside(el: FakeEl, x: number, y: number): boolean {
  const r = el.rect;
  return x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
}

function setup() {
  const doc = new FakeDoc();
  const stage = doc.createElement('div');
  stage.rect = { left: 10, top: 20, width: 800, height: 600 };
  const ui = doc.createElement('div');
  stage.append(ui);
  // A modal panel host covering the stage, with a button in its shadow root.
  const host = doc.createElement('div');
  host.className = 'parallax-panel';
  host.rect = stage.rect;
  ui.append(host);
  const shadow = new FakeShadow(host);
  host.shadowRoot = shadow;
  const button = doc.createElement('button');
  button.setAttribute('data-action', 'resume');
  button.rect = { left: 400, top: 300, width: 120, height: 40 };
  shadow.append(button);
  shadow.hit = (x, y) => (inside(button, x, y) ? button : host);
  doc.hit = (x, y) => (inside(host, x, y) ? host : stage);
  const host_: InputHost = {
    window: new EventTarget(), document: doc as unknown as InputHost['document'], navigator: { getGamepads: () => [] },
  };
  const input = new BrowserInput({ stage: stage as unknown as HTMLElement, ui: ui as unknown as Element, host: host_ });
  const cursor = virtualCursorFor(ui as unknown as HTMLElement);
  const pointer = (type: string, init: Record<string, unknown>): void => {
    stage.dispatchEvent(new FakeMouseEvent(type, { pointerType: 'mouse', pointerId: 1, isPrimary: true, ...init }));
  };
  return { doc, stage, ui, host, button, input, cursor, pointer };
}

const OUT = { textEntry: false, rumble: [], touch: [] } as const;

describe('the virtual cursor', () => {
  it('a lock the host took (an editor\'s Play) holds through a scene without mouse-look, with the virtual cursor, until Escape', () => {
    const t = setup();
    // A title menu of a mouse-look game: the engine asks for the OS cursor (no mouse-look in this scene).
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: false });
    t.input.lock();
    expect(t.stage.locks).toBe(1);
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: false });
    expect(t.doc.exits).toBe(0);
    expect(t.cursor.mode).toBe('virtual');
    // Gameplay: mouse-look on the same lock.
    t.input.present({ ...OUT, cursor: 'locked' });
    expect(t.cursor.mode).toBe('off');
    // Escape released it: the next menu is the OS cursor's again, and nothing re-locks by itself.
    t.doc.pointerLockElement = null;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: false });
    t.doc.pointerLockElement = t.stage as unknown as Element; // the game's own press re-locked for mouse-look
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: false });
    expect(t.doc.exits).toBe(1); // without a host lock, a scene without mouse-look frees the pointer
  });

  it('without a host lock, a scene without mouse-look frees the pointer, as before', () => {
    const t = setup();
    // Without lock(): a scene without mouse-look under a lock frees it, as before.
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: false });
    expect(t.doc.exits).toBe(1);
    expect(t.cursor.mode).not.toBe('virtual');
  });

  it('keeps the lock under a menu over mouse-look and presses the control under it', () => {
    const t = setup();
    t.input.present({ ...OUT, cursor: 'locked' });
    t.pointer('pointerdown', { clientX: 0, clientY: 0, buttons: 1 });
    t.pointer('pointerup', { clientX: 0, clientY: 0, buttons: 0 });
    expect(t.stage.locks).toBe(1);
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.poll();

    // A modal opens: the engine frees the cursor over a mouse-look scene.
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    expect(t.doc.exits).toBe(0);
    expect(t.cursor.mode).toBe('virtual');
    expect(t.cursor.position).toEqual({ x: 400, y: 300 }); // centred
    const drawn = t.stage.children.find((c) => c.className === 'parallax-cursor');
    expect(drawn).toBeDefined();

    // Mouse movement moves the cursor (and the pointer reads its position).
    t.pointer('pointermove', { movementX: 50, movementY: 10, buttons: 0 });
    expect(t.cursor.position).toEqual({ x: 450, y: 310 });
    expect(t.button.attributes.has(HOVER_ATTRIBUTE)).toBe(true);
    const moved = t.input.poll();
    expect([moved.pointer.x, moved.pointer.y]).toEqual([450, 310]);

    t.button.events.length = 0;
    t.pointer('pointerdown', { movementX: 0, movementY: 0, buttons: 1 });
    t.pointer('pointerup', { movementX: 0, movementY: 0, buttons: 0 });
    expect(t.button.events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    const pressed = t.input.poll();
    expect(pressed.pointer.pressed).toEqual(['left']); // once: the cursor's own events are not re-read
    expect(pressed.pointer.pressedOverUi).toBe(true);

    // Clamped to the stage.
    t.pointer('pointermove', { movementX: -5000, movementY: 5000, buttons: 0 });
    expect(t.cursor.position).toEqual({ x: 0, y: 600 });
    expect(t.button.attributes.has(HOVER_ATTRIBUTE)).toBe(false);

    // The modal closes: mouse-look resumes on the same lock, no click needed.
    t.input.present({ ...OUT, cursor: 'locked' });
    expect(t.doc.exits).toBe(0);
    expect(t.cursor.mode).toBe('off');
    expect(t.stage.children.some((c) => c.className === 'parallax-cursor')).toBe(false);
  });

  it('comes back where it was after a one-frame menu swap, centred after a real absence', () => {
    const t = setup();
    t.doc.pointerLockElement = t.stage as unknown as Element;
    const menu = (): void => t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    const look = (): void => t.input.present({ ...OUT, cursor: 'locked' });
    menu();
    t.pointer('pointermove', { movementX: 100, movementY: 0, buttons: 0 });
    look();
    menu();
    expect(t.cursor.position).toEqual({ x: 500, y: 300 });
    look(); look(); look();
    menu();
    expect(t.cursor.position).toEqual({ x: 400, y: 300 });
  });

  it('a press off the panels is not the UI\'s; without a lock the OS cursor is the cursor', () => {
    const t = setup();
    t.doc.hit = () => t.stage; // nothing but the play area under the cursor
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    t.pointer('pointerdown', { buttons: 1 });
    expect(t.input.poll().pointer.pressedOverUi).toBe(false);

    t.doc.pointerLockElement = null; // Escape released it
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    expect(t.cursor.mode).not.toBe('virtual');
  });

  it('a "system" cursor unlocks the menu instead of drawing one', () => {
    const t = setup();
    const system: UiCursor = { visual: 'system', size: 24, color: null, image: null, hotspot: [0.5, 0.5], showInMenus: false };
    t.cursor.setLook(system, (p) => p);
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    expect(t.doc.exits).toBe(1);
    expect(t.cursor.mode).not.toBe('virtual');
  });

  it('draws the game\'s look with its hotspot', () => {
    const t = setup();
    t.cursor.setLook({ visual: 'image', size: 32, color: null, image: 'assets/ui/quill.png', hotspot: [0, 0.25], showInMenus: false }, (p) => `/project/${p}`);
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    const drawn = t.stage.children.find((c) => c.className === 'parallax-cursor')!;
    expect(drawn.style['backgroundImage']).toBe('url("/project/assets/ui/quill.png")');
    expect([drawn.style['width'], drawn.style['marginLeft'], drawn.style['marginTop']]).toEqual(['32px', '0px', '-8px']);
    expect(drawn.style['transform']).toBe('translate(400px, 300px)');
  });

  it('sends a scripted panel\'s frame its events in frame pixels', () => {
    const t = setup();
    const frame = t.doc.createElement('iframe');
    frame.rect = { left: 210, top: 120, width: 400, height: 400 };
    const posted: unknown[] = [];
    frame.contentWindow = { posted, postMessage: (m) => posted.push(m) };
    t.host.shadowRoot!.append(frame);
    t.host.shadowRoot!.hit = () => frame;
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.present({ ...OUT, cursor: 'free', virtualCursor: true });
    t.pointer('pointerdown', { buttons: 1 });
    t.pointer('pointerup', { buttons: 0 });
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types.filter((x) => x !== 'move')).toEqual(['down', 'up']);
    const down = posted.find((m) => (m as { type: string }).type === 'down');
    expect(frameCursorMessage(down)).toMatchObject({ x: 200, y: 200, button: 0, buttons: 1 });
    // The frame got the press: the game hears nothing unless the frame hands it back.
    expect(t.input.poll().pointer.pressed).toEqual([]);
    expect(frameCursorMessage({ parallax: 1, t: 'cursor', type: 'eval', x: 0, y: 0, button: 0, buttons: 0, deltaY: 0 })).toBeUndefined();
  });
});

describe('a non-modal scripted panel under the virtual cursor', () => {
  it('a press off its controls comes back as the game\'s press at the cursor; on a control it stays the panel\'s', () => {
    const t = setup();
    const frame = t.doc.createElement('iframe');
    frame.rect = t.stage.rect;
    frame.contentWindow = { posted: [], postMessage: () => {} };
    t.host.shadowRoot!.append(frame);
    t.host.shadowRoot!.hit = () => frame;
    t.doc.pointerLockElement = t.stage as unknown as Element;
    t.input.lock();
    t.input.present({ ...OUT, cursor: 'free' }); // a board game under the host's lock: the virtual cursor
    expect(t.cursor.mode).toBe('virtual');
    t.pointer('pointermove', { movementX: 30, movementY: -20, buttons: 0 });
    t.pointer('pointerdown', { movementX: 0, movementY: 0, buttons: 1 });
    t.input.poll(); // a control took it (the frame sent nothing back): no press
    t.pointer('pointerup', { movementX: 0, movementY: 0, buttons: 0 });
    expect(t.input.poll().pointer.pressed).toEqual([]);
    // Off its controls: the frame replays the press on the panels layer (surface.ts onPointer).
    t.pointer('pointerdown', { movementX: 0, movementY: 0, buttons: 1 });
    const replay = (type: string, buttons: number): void => {
      const e = new FakeMouseEvent(type, { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 999, clientY: 999, buttons });
      Object.defineProperty(e, 'target', { value: t.ui }); // as the browser reports it at the stage
      t.ui.dispatchEvent(e);
    };
    replay('pointerdown', 1);
    const s = t.input.poll();
    expect(s.pointer.pressed).toEqual(['left']);
    expect(s.pointer.pressedOverUi).toBe(false);
    expect([s.pointer.x, s.pointer.y]).toEqual([430, 280]); // the cursor, not the replay's coordinates
    replay('pointerup', 0);
    t.pointer('pointerup', { movementX: 0, movementY: 0, buttons: 0 });
    expect(t.input.poll().pointer.buttons.size).toBe(0);
  });
});

describe('CursorDispatch', () => {
  it('drags a range input (input on every move, change on release, no click)', () => {
    const doc = new FakeDoc();
    const range = doc.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '10';
    range.step = '1';
    range.value = '5';
    range.rect = { left: 0, top: 0, width: 100, height: 20 };
    const dispatch = new CursorDispatch(doc as unknown as Document, { pick: () => range as unknown as Element });
    expect(dispatch.down(31, 5, 0, 1)).toBe(true);
    expect(range.value).toBe('3');
    dispatch.move(78, 5, 1);
    expect(range.value).toBe('8');
    dispatch.up(78, 5, 0, 0);
    expect(range.events).toEqual(['pointerdown', 'mousedown', 'input', 'pointermove', 'input', 'pointerup', 'mouseup', 'change']);
  });

  it('clicks only when released over what was pressed', () => {
    const doc = new FakeDoc();
    const a = doc.createElement('button');
    const b = doc.createElement('button');
    let under = a;
    const dispatch = new CursorDispatch(doc as unknown as Document, { pick: () => under as unknown as Element });
    dispatch.down(0, 0, 0, 1);
    under = b;
    dispatch.up(0, 0, 0, 0);
    expect(a.events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
    expect(b.events).toEqual([]);
  });
});
