/**
 * The engine's virtual cursor (browser). A mouse-look game keeps the pointer locked through
 * its menus: when a modal panel opens over a locked pointer (`InputOutput.virtualCursor`),
 * the lock stays, and this draws a cursor over the stage, moved by mouse movement, that
 * presses what it is over. When the menu closes, mouse-look carries on with no click to
 * re-lock. Without a lock (the player pressed Escape, a touch screen) the OS cursor is the
 * cursor and none of this runs.
 *
 *   look      the engine ring (white ring + dot), or the game's `Cursor` (UiFrame.cursor):
 *             ring / dot / crosshair in a color, an image, or "system" (no drawn cursor: the
 *             menu unlocks the pointer instead). `show_in_menus` also draws it in place of
 *             the OS cursor whenever the cursor is free ("follow" mode).
 *   position  stage pixels; centred when it appears (unless it was gone for 2 frames or
 *             less), clamped to the stage
 *   presses   hit-tested through the panels' shadow roots: pointerdown / mousedown on press,
 *             pointermove while held (sliders drag), pointerup / mouseup and a click on
 *             release over the pressed element. Range inputs move, text fields take focus,
 *             a select opens an in-panel list (a native picker can't be opened by script),
 *             checkboxes toggle (a click's own behavior). A scripted panel's frame gets the
 *             same events by message (`frame.ts` replays them with `CursorDispatch`).
 *   hover     the control under the cursor carries `data-parallax-hover` (the panel CSS
 *             styles it like `:hover`, which script can't set)
 *   wheel     scrolls the nearest scrollable element under the cursor
 *
 * One cursor per stage, shared by the input adapter (mode, movement, presses) and the panel
 * surface (look): `virtualCursorFor(ui)`.
 */

import type { UiCursor } from '../../../core/index.js';

/** Where a virtual-cursor press landed (`VirtualCursor.button`). */
export type CursorHit = 'panel' | 'frame' | 'none';

/** off: nothing drawn. virtual: drawn over a locked pointer, moved by deltas. follow: drawn at the OS pointer. */
export type CursorMode = 'off' | 'virtual' | 'follow';

/** What a press must land on to count as a control (the PASS_THROUGH_CSS list). */
export const CURSOR_CONTROLS = '[data-action], button, input, select, textarea, label, a, summary, details';

/** The attribute the control under the virtual cursor carries. */
export const HOVER_ATTRIBUTE = 'data-parallax-hover';

/** A cursor hidden this many frames or fewer comes back where it was (a menu swapped for another). */
const CHURN_FRAMES = 2;

const DEFAULT_LOOK: UiCursor = { visual: 'ring', size: 24, color: null, image: null, hotspot: [0.5, 0.5], showInMenus: false };

type Win = Window & typeof globalThis;

function css(color: UiCursor['color']): string {
  if (color === null) return '#ffffff';
  const [r, g, b, a] = color;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

function signature(look: UiCursor): string {
  return JSON.stringify(look);
}

/** Paint `el` as the cursor `look` (its box sits with the hotspot at the element's origin). */
export function paintCursor(el: HTMLElement, look: UiCursor, url: (path: string) => string): void {
  const size = Math.max(4, Math.min(256, look.size));
  const doc = el.ownerDocument;
  el.replaceChildren();
  el.removeAttribute('style');
  Object.assign(el.style, {
    position: 'absolute', left: '0', top: '0', width: `${size}px`, height: `${size}px`, pointerEvents: 'none',
    zIndex: '2147483000', boxSizing: 'border-box', marginLeft: `${-look.hotspot[0] * size}px`, marginTop: `${-look.hotspot[1] * size}px`,
  });
  const color = css(look.color);
  const part = (style: Partial<CSSStyleDeclaration>): void => {
    const d = doc.createElement('div');
    Object.assign(d.style, { position: 'absolute', ...style });
    el.append(d);
  };
  switch (look.visual) {
    case 'image':
      Object.assign(el.style, {
        backgroundImage: `url("${url(look.image ?? '').replace(/["\\]/g, '\\$&')}")`, backgroundSize: 'contain',
        backgroundRepeat: 'no-repeat', backgroundPosition: 'center', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
      });
      return;
    case 'dot':
      Object.assign(el.style, { borderRadius: '50%', background: color, boxShadow: '0 0 4px rgba(0,0,0,0.9)' });
      return;
    case 'crosshair':
      part({ left: '50%', top: '0', width: '2px', height: '100%', background: color, transform: 'translateX(-50%)', boxShadow: '0 0 3px rgba(0,0,0,0.9)' });
      part({ top: '50%', left: '0', height: '2px', width: '100%', background: color, transform: 'translateY(-50%)', boxShadow: '0 0 3px rgba(0,0,0,0.9)' });
      return;
    default:
      Object.assign(el.style, {
        border: `2px solid ${color}`, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
        boxShadow: '0 0 6px rgba(0,0,0,0.9), 0 0 12px rgba(255,255,255,0.4)',
      });
      part({ left: '50%', top: '50%', width: '4px', height: '4px', background: color, borderRadius: '50%', transform: 'translate(-50%, -50%)' });
  }
}

/** The innermost element at a client point, through open shadow roots. */
export function deepElementAt(doc: Document, x: number, y: number): Element | null {
  let el = doc.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (inner === null || inner === el) break;
    el = inner;
  }
  return el;
}

/** The node's parent, crossing out of a shadow root to its host. */
function parentOf(node: Node): Node | null {
  return node.parentNode ?? (node as ShadowRoot).host ?? null;
}

function within(node: Node | null, ancestor: Node): boolean {
  for (let n: Node | null = node; n !== null; n = parentOf(n)) if (n === ancestor) return true;
  return false;
}

/** The nearest control at or above `el`, crossing nothing (controls never span a shadow root). */
function controlOf(el: Element | null): Element | null {
  return el?.closest?.(CURSOR_CONTROLS) ?? null;
}

type CursorEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'mousedown' | 'mouseup' | 'click';

/** Fire a mouse-like event on `el` at a client point, with the element's own window's constructors. */
function fire(el: Element, type: CursorEventType, x: number, y: number, button: number, buttons: number): void {
  const win = el.ownerDocument.defaultView as Win | null;
  const init = {
    clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, button, buttons,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: type === 'click' ? 1 : 0,
  };
  const Mouse = win?.MouseEvent ?? MouseEvent;
  const Pointer = win?.PointerEvent ?? (typeof PointerEvent === 'undefined' ? undefined : PointerEvent);
  el.dispatchEvent(type.startsWith('pointer') && Pointer !== undefined ? new Pointer(type, init) : new Mouse(type, init));
}

function fireSimple(el: Element, type: 'input' | 'change'): void {
  const win = el.ownerDocument.defaultView as Win | null;
  const Ctor = win?.Event ?? Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true }));
}

function isRange(el: Element | null): el is HTMLInputElement {
  return el !== null && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';
}

function isTextField(el: Element): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'file'].includes(type);
}

/**
 * A synthetic press moves no slider (untrusted events have no default action): map the
 * point onto the track, snap to `step`, clamp, and fire `input`. True when the value changed.
 */
export function slideRange(el: HTMLInputElement, x: number): boolean {
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0) || el.disabled) return false;
  const min = Number.isFinite(parseFloat(el.min)) ? parseFloat(el.min) : 0;
  const max = Number.isFinite(parseFloat(el.max)) ? parseFloat(el.max) : 100;
  if (max <= min) return false;
  let fraction = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  if (el.ownerDocument.defaultView?.getComputedStyle(el).direction === 'rtl') fraction = 1 - fraction;
  const step = parseFloat(el.step);
  let value = min + fraction * (max - min);
  if (Number.isFinite(step) && step > 0) value = min + Math.round((value - min) / step) * step;
  const next = String(Math.max(min, Math.min(max, value)));
  if (el.value === next) return false;
  el.value = next;
  fireSimple(el, 'input');
  return true;
}

function scrollable(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style === undefined) return false;
  return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
}

/**
 * A select under the virtual cursor: its options as a list of buttons in the panel (a native
 * picker can't be opened by script and sits outside hit-testing). Choosing one commits to the
 * real select and fires `input` + `change`.
 */
export class VirtualSelect {
  #select: HTMLSelectElement | null = null;
  #popup: HTMLElement | null = null;
  #cleanup: (() => void) | null = null;

  get open(): boolean {
    return this.#popup !== null;
  }

  /** A press outside the open list (and not on its select) closes it. */
  dismissOutside(target: Element | null): void {
    if (this.#popup === null) return;
    if (target !== this.#select && !within(target, this.#popup)) this.close();
  }

  close(restoreFocus = false): void {
    const select = this.#select;
    this.#cleanup?.();
    this.#cleanup = null;
    this.#popup?.remove();
    this.#popup = null;
    this.#select = null;
    if (restoreFocus && select?.isConnected === true) select.focus({ preventScroll: true });
  }

  toggle(select: HTMLSelectElement): void {
    if (this.#select === select) {
      this.close(true);
      return;
    }
    this.close();
    if (select.disabled || select.multiple || select.size > 1 || !select.isConnected) return;
    const doc = select.ownerDocument;
    const win = doc.defaultView as Win | null;
    if (win === null) return;
    const root = select.getRootNode() as ShadowRoot | Document;
    const parent: ParentNode = 'host' in root ? root : doc.body;
    const rect = select.getBoundingClientRect();
    const style = win.getComputedStyle(select);
    const fontSize = parseFloat(style.fontSize) || 16;
    const row = Math.max(32, fontSize * 1.6);
    const popup = doc.createElement('div');
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('data-parallax-select', '');
    const width = Math.max(rect.width, 160);
    const below = Math.max(0, win.innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const wanted = select.options.length * row + 8;
    const opensAbove = below < Math.min(wanted, row * 3) && above > below;
    const height = Math.min(wanted, opensAbove ? above : below);
    Object.assign(popup.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483646', boxSizing: 'border-box', pointerEvents: 'auto', overflow: 'auto',
      width: `${width}px`, maxHeight: `${height}px`, padding: '4px', border: '1px solid rgba(255,255,255,0.5)', borderRadius: '8px',
      background: 'rgba(14,16,24,0.97)', color: '#f4f4f6', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', font: style.font,
    });
    const buttons: HTMLButtonElement[] = [];
    for (const option of [...select.options]) {
      if (option.hidden) continue;
      const button = doc.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.selected));
      button.textContent = option.label || option.text;
      button.disabled = option.disabled;
      Object.assign(button.style, {
        display: 'block', width: '100%', minHeight: `${row}px`, padding: '6px 12px', margin: '0', border: '0', borderRadius: '6px',
        font: 'inherit', textAlign: 'start', color: 'inherit', cursor: 'pointer', pointerEvents: 'auto',
        background: option.selected ? 'rgba(255,255,255,0.18)' : 'transparent', opacity: option.disabled ? '0.45' : '1',
      });
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (button.disabled || select.disabled || !select.contains(option)) return;
        const changed = select.selectedIndex !== option.index;
        select.selectedIndex = option.index;
        this.close(true);
        if (changed) {
          fireSimple(select, 'input');
          fireSimple(select, 'change');
        }
      });
      popup.append(button);
      if (!button.disabled) buttons.push(button);
    }
    parent.append(popup);
    // `position: fixed` resolves against a contained panel host, not the page: correct by the measured offset.
    // ... and a scaled host (`@ui(scale=...)`) shrinks the offsets: divide them back out.
    const origin = popup.getBoundingClientRect();
    const k = popup.offsetWidth > 0 && origin.width > 0 ? origin.width / popup.offsetWidth : 1;
    popup.style.left = `${(Math.max(8, Math.min(rect.left, win.innerWidth - width - 8)) - origin.left) / k}px`;
    popup.style.top = `${((opensAbove ? rect.top - height : rect.bottom) - origin.top) / k}px`;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
      } else if (e.key === 'Tab') {
        this.close(true);
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && buttons.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const at = buttons.indexOf(root.activeElement as HTMLButtonElement);
        const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]!.focus({ preventScroll: true });
      }
    };
    const onResize = (): void => this.close();
    // Capture on the window: ahead of the page's key handling while the list is open.
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('resize', onResize);
    this.#cleanup = () => {
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', onResize);
    };
    this.#select = select;
    this.#popup = popup;
    (buttons.find((b) => b.getAttribute('aria-selected') === 'true') ?? buttons[0])?.focus({ preventScroll: true });
  }
}

/**
 * Presses, drags, hover and wheel at a client point, in one document: the page's panels
 * (shadow roots) or, inside a scripted panel's frame, its own document. `pick` finds what is
 * at a point; `accept` says whether that is part of the UI at all (a press elsewhere is not
 * the cursor's).
 */
export class CursorDispatch {
  readonly #doc: Document;
  readonly #pick: (x: number, y: number) => Element | null;
  readonly #accept: (el: Element) => boolean;
  readonly select = new VirtualSelect();
  #held: Element | null = null;
  #heldButton = 0;
  #rangeMoved = false;
  #hover: Element | null = null;

  constructor(doc: Document, options: { pick?: (x: number, y: number) => Element | null; accept?: (el: Element) => boolean } = {}) {
    this.#doc = doc;
    this.#pick = options.pick ?? ((x, y) => deepElementAt(doc, x, y));
    this.#accept = options.accept ?? (() => true);
  }

  get holding(): boolean {
    return this.#held !== null;
  }

  /** The cursor moved to a client point: hover follows; a held press drags. */
  move(x: number, y: number, buttons: number): void {
    const held = this.#held;
    if (held !== null) {
      if (!held.isConnected) {
        this.#held = null;
      } else {
        fire(held, 'pointermove', x, y, this.#heldButton, buttons);
        if (isRange(held) && slideRange(held, x)) this.#rangeMoved = true;
      }
    }
    const at = this.#pick(x, y);
    this.#setHover(at !== null && this.#accept(at) ? controlOf(at) : null);
  }

  /** A button went down at a client point. True when it landed on the UI (the cursor took it). */
  down(x: number, y: number, button: number, buttons: number): boolean {
    const at = this.#pick(x, y);
    this.select.dismissOutside(at);
    if (at === null || !this.#accept(at)) return false;
    if (this.#held !== null && this.#held.isConnected) return true; // a second button during a press
    this.#held = at;
    this.#heldButton = button;
    this.#rangeMoved = false;
    fire(at, 'pointerdown', x, y, button, buttons);
    fire(at, 'mousedown', x, y, button, buttons);
    const control = controlOf(at);
    if (button === 0 && control !== null) {
      if (isRange(control)) {
        this.#held = control;
        if (slideRange(control, x)) this.#rangeMoved = true;
      } else if (isTextField(control)) {
        (control as HTMLElement).focus({ preventScroll: true });
      }
    }
    return true;
  }

  /** A button came up at a client point: release, then a click when it is still over what was pressed. */
  up(x: number, y: number, button: number, buttons: number): void {
    const held = this.#held;
    if (held === null || button !== this.#heldButton) return;
    this.#held = null;
    if (!held.isConnected) return;
    fire(held, 'pointerup', x, y, button, buttons);
    fire(held, 'mouseup', x, y, button, buttons);
    if (isRange(held)) {
      if (this.#rangeMoved) fireSimple(held, 'change');
      return;
    }
    const at = this.#pick(x, y);
    if (button !== 0 || at === null || !within(at, held)) return;
    const control = controlOf(held);
    if (control !== null && control.tagName === 'SELECT') {
      this.select.toggle(control as HTMLSelectElement);
      return;
    }
    fire(held, 'click', x, y, button, buttons);
  }

  /** Wheel notches over a client point: scroll the nearest scrollable element (positive = down). */
  wheel(x: number, y: number, deltaY: number): void {
    const at = this.#pick(x, y);
    if (at === null || !this.#accept(at)) return;
    for (let n: Node | null = at; n !== null; n = parentOf(n)) {
      if (n.nodeType === 1 && scrollable(n as Element)) {
        (n as Element).scrollBy({ top: deltaY });
        return;
      }
    }
  }

  /** The cursor went away: end a press without a click, drop the hover, close an open list. */
  cancel(): void {
    const held = this.#held;
    this.#held = null;
    if (held?.isConnected === true) fire(held, 'pointercancel', 0, 0, this.#heldButton, 0);
    this.#setHover(null);
    this.select.close();
  }

  #setHover(el: Element | null): void {
    if (el === this.#hover) return;
    this.#hover?.removeAttribute(HOVER_ATTRIBUTE);
    this.#hover = el;
    el?.setAttribute(HOVER_ATTRIBUTE, '');
  }
}

/** A cursor event for a scripted panel's frame (page → frame), in frame-viewport pixels. */
export interface FrameCursorMessage {
  readonly parallax: 1;
  readonly t: 'cursor';
  readonly type: 'move' | 'down' | 'up' | 'wheel' | 'cancel';
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly buttons: number;
  /** Wheel: pixels to scroll (positive = down). */
  readonly deltaY: number;
}

/** A frame's reading of a page message: the cursor event, if it is one. */
export function frameCursorMessage(data: unknown): FrameCursorMessage | undefined {
  const m = data as Partial<FrameCursorMessage> | null;
  if (typeof m !== 'object' || m === null || m.parallax !== 1 || m.t !== 'cursor') return undefined;
  if (!['move', 'down', 'up', 'wheel', 'cancel'].includes(m.type as string)) return undefined;
  if (![m.x, m.y, m.button, m.buttons, m.deltaY].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return m as FrameCursorMessage;
}

/** Inside a frame: replay the page's cursor events on its document. */
export function playFrameCursor(dispatch: CursorDispatch, m: FrameCursorMessage): void {
  switch (m.type) {
    case 'move': dispatch.move(m.x, m.y, m.buttons); return;
    case 'down': dispatch.down(m.x, m.y, m.button, m.buttons); return;
    case 'up': dispatch.up(m.x, m.y, m.button, m.buttons); return;
    case 'wheel': dispatch.wheel(m.x, m.y, m.deltaY); return;
    case 'cancel': dispatch.cancel();
  }
}

const OS_CURSOR_HIDE = '*, *::before, *::after { cursor: none !important; }';

const cursors = new WeakMap<Element, VirtualCursor>();

/** The stage's one cursor, keyed by its panels layer (created on first ask). */
export function virtualCursorFor(ui: HTMLElement): VirtualCursor {
  let cursor = cursors.get(ui);
  if (cursor === undefined) cursors.set(ui, (cursor = new VirtualCursor(ui)));
  return cursor;
}

export class VirtualCursor {
  readonly #ui: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #doc: Document;
  readonly #dispatch: CursorDispatch;
  #element: HTMLElement | null = null;
  #mode: CursorMode = 'off';
  #look: UiCursor = DEFAULT_LOOK;
  #url: (path: string) => string = (path) => path;
  #painted = '';
  #x = 0;
  #y = 0;
  #everShown = false;
  #offFrames = 0;
  /** Where the current press (or the hover) went: the page, or a scripted panel's frame. */
  #pressFrame: HTMLIFrameElement | null = null;
  #hoverFrame: HTMLIFrameElement | null = null;
  #osHidden = false;
  /** True while the cursor dispatches its own events (the input adapter ignores them). */
  dispatching = false;

  constructor(ui: HTMLElement) {
    this.#ui = ui;
    this.#stage = ui.parentElement ?? ui;
    this.#doc = ui.ownerDocument;
    this.#dispatch = new CursorDispatch(this.#doc, {
      pick: (x, y) => deepElementAt(this.#doc, x, y),
      accept: (el) => el !== this.#ui && within(el, this.#ui),
    });
  }

  get mode(): CursorMode {
    return this.#mode;
  }

  /** The cursor's look (the game's `Cursor`, else the engine ring). */
  get look(): UiCursor {
    return this.#look;
  }

  /** Stage pixels from its top-left. */
  get position(): { readonly x: number; readonly y: number } {
    return { x: this.#x, y: this.#y };
  }

  /** The cursor's look from the panel surface's frame (`UiFrame.cursor`); null = the engine ring. */
  setLook(look: UiCursor | null | undefined, url: (path: string) => string): void {
    this.#look = look ?? DEFAULT_LOOK;
    this.#url = url;
    this.#paint();
  }

  /** Once per frame, from the input adapter. */
  setMode(mode: CursorMode): void {
    if (mode === 'virtual' && this.#mode !== 'virtual' && (!this.#everShown || this.#offFrames > CHURN_FRAMES)) this.#centre();
    if (mode !== 'virtual' && this.#mode === 'virtual') this.#cancel();
    if (mode === 'virtual') {
      this.#everShown = true;
      this.#offFrames = 0;
    } else {
      this.#offFrames++;
    }
    this.#mode = mode;
    this.#paint();
    this.#hideOsCursor(mode === 'follow');
    // Panels change under a still cursor: keep the hover current (a held press moves only with the mouse).
    if (mode === 'virtual' && !this.#dispatch.holding && this.#pressFrame === null) this.#route('move', 0, 0);
  }

  /** Mouse movement under the lock. */
  move(dx: number, dy: number, buttons: number): void {
    if (this.#mode !== 'virtual') return;
    const { width, height } = this.#size();
    this.#x = Math.max(0, Math.min(width, this.#x + dx));
    this.#y = Math.max(0, Math.min(height, this.#y + dy));
    this.#place();
    this.#route('move', 0, buttons);
  }

  /** The OS pointer's stage position (follow mode). */
  follow(x: number, y: number): void {
    this.#x = x;
    this.#y = y;
    if (this.#mode === 'follow') this.#place();
  }

  /**
   * A button under the lock. Down: where it landed — 'panel' (a page panel took it), 'frame'
   * (a scripted panel's frame got it: a non-modal one hands a press off its controls back to
   * the page as a play-area press, a modal one keeps it) or 'none' (the play area).
   */
  button(down: boolean, button: number, buttons: number): CursorHit {
    if (this.#mode !== 'virtual') return 'none';
    return this.#route(down ? 'down' : 'up', button, buttons);
  }

  /** Wheel under the lock, in pixels (positive = down). */
  wheel(deltaY: number): void {
    if (this.#mode === 'virtual') this.#route('wheel', 0, 0, deltaY);
  }

  dispose(): void {
    this.#cancel();
    this.#hideOsCursor(false);
    this.#element?.remove();
    this.#element = null;
    cursors.delete(this.#ui);
  }

  // ── Routing: the page's panels, or a scripted panel's frame ──────────────────

  #client(): { x: number; y: number } {
    const r = this.#stage.getBoundingClientRect();
    return { x: r.left + this.#x, y: r.top + this.#y };
  }

  #route(type: 'move' | 'down' | 'up' | 'wheel', button: number, buttons: number, deltaY = 0): CursorHit {
    const { x, y } = this.#client();
    const at = deepElementAt(this.#doc, x, y);
    const frame = at?.tagName === 'IFRAME' && within(at, this.#ui) ? at as HTMLIFrameElement : null;
    this.dispatching = true;
    try {
      // A press stays with where it began; hover leaves a frame the cursor left.
      const pressing = type === 'up' || (type === 'move' && (this.#pressFrame !== null || this.#dispatch.holding));
      const target = pressing ? this.#pressFrame : frame;
      if (this.#hoverFrame !== null && this.#hoverFrame !== target) {
        this.#post(this.#hoverFrame, 'cancel', x, y, 0, 0, 0);
        this.#hoverFrame = null;
      }
      if (target !== null) {
        this.#hoverFrame = target;
        if (type === 'down') {
          this.#dispatch.select.dismissOutside(at);
          this.#pressFrame = target;
        }
        if (type === 'up') this.#pressFrame = null;
        this.#post(target, type, x, y, button, buttons, deltaY);
        return 'frame';
      }
      switch (type) {
        case 'move': this.#dispatch.move(x, y, buttons); return 'none';
        case 'down': return this.#dispatch.down(x, y, button, buttons) ? 'panel' : 'none';
        case 'up': this.#dispatch.up(x, y, button, buttons); return 'none';
        case 'wheel': this.#dispatch.wheel(x, y, deltaY); return 'none';
      }
    } finally {
      this.dispatching = false;
    }
  }

  #post(frame: HTMLIFrameElement, type: FrameCursorMessage['type'], x: number, y: number, button: number, buttons: number, deltaY: number): void {
    const r = frame.getBoundingClientRect();
    // Page pixels → frame pixels: the panel host may be scaled (`@ui(scale=...)`).
    const k = frame.offsetWidth > 0 ? r.width / frame.offsetWidth : 1;
    const message: FrameCursorMessage = { parallax: 1, t: 'cursor', type, x: (x - r.left) / k, y: (y - r.top) / k, button, buttons, deltaY };
    // The frame's origin is opaque: '*' is the only target that reaches it.
    frame.contentWindow?.postMessage(message, '*');
  }

  #cancel(): void {
    this.dispatching = true;
    try {
      this.#dispatch.cancel();
      for (const frame of new Set([this.#pressFrame, this.#hoverFrame])) if (frame !== null) this.#post(frame, 'cancel', 0, 0, 0, 0, 0);
    } finally {
      this.dispatching = false;
    }
    this.#pressFrame = null;
    this.#hoverFrame = null;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  #size(): { width: number; height: number } {
    const r = this.#stage.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  #centre(): void {
    const { width, height } = this.#size();
    this.#x = width / 2;
    this.#y = height / 2;
  }

  /** Whether a cursor is drawn in the current mode with the current look. */
  #drawn(): boolean {
    if (this.#look.visual === 'system') return false;
    return this.#mode === 'virtual' || (this.#mode === 'follow' && this.#look.showInMenus);
  }

  #paint(): void {
    if (!this.#drawn()) {
      this.#element?.remove();
      this.#element = null;
      return;
    }
    if (this.#element === null) {
      this.#element = this.#doc.createElement('div');
      this.#element.className = 'parallax-cursor';
      this.#element.setAttribute('aria-hidden', 'true');
      this.#painted = '';
    }
    if (this.#element.parentNode !== this.#stage) this.#stage.append(this.#element);
    const sig = signature(this.#look);
    if (sig !== this.#painted) {
      this.#painted = sig;
      paintCursor(this.#element, this.#look, this.#url);
    }
    this.#place();
  }

  #place(): void {
    if (this.#element !== null) this.#element.style.transform = `translate(${this.#x}px, ${this.#y}px)`;
  }

  /** Follow mode draws the cursor itself: hide the OS one over the stage and inside every panel. */
  #hideOsCursor(hidden: boolean): void {
    const want = hidden && this.#drawn();
    if (want) {
      this.#stage.style.cursor = 'none';
      for (const host of this.#ui.querySelectorAll('.parallax-panel')) {
        const root = host.shadowRoot;
        if (root === null || root.querySelector('style[data-parallax-cursor]') !== null) continue;
        const style = this.#doc.createElement('style');
        style.setAttribute('data-parallax-cursor', '');
        style.textContent = OS_CURSOR_HIDE;
        root.append(style);
      }
    } else if (this.#osHidden) {
      this.#stage.style.cursor = '';
      for (const host of this.#ui.querySelectorAll('.parallax-panel')) host.shadowRoot?.querySelector('style[data-parallax-cursor]')?.remove();
    }
    this.#osHidden = want;
  }
}
