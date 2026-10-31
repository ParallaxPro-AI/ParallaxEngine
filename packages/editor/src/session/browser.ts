/**
 * @parallax/editor/session/browser — the page side, for a game booted with `bootBrowser`:
 *
 *   observePage      observe() plus every panel control found in the DOM, with its rectangle,
 *                    whether a click at its center reaches it (real hit testing), and why not
 *   capturePixels    the canvas as drawn (WebGPU or WebGL2 or 2D): RGBA and PNG bytes, read in
 *                    the same task as the frame's draw, so it works without preserveDrawingBuffer
 *   exposeAutomation `globalThis.parallaxAutomation` for headless Chrome (observe, capture, the
 *                    session), which a harness injects this module into the page to get
 *   browserHost      an EditorSession's hot-reload host over `BrowserGame.rebuild` / `replace`
 *
 * Coordinates: entity boxes are surface (canvas backing) pixels; controls are CSS page
 * pixels; `page.canvas` and `page.pixelRatio` convert one into the other.
 */

import type { BrowserGame } from '@parallax/runtime/boot';
import type { ProjectFiles } from '@parallax/runtime/core';
import { encodePng } from '@parallax/runtime/plugins/render3d';
import { observe } from './observe.js';
import type { Observation, ObservedControl, ObserveOptions } from './observe.js';
import type { EditorSession, SessionHost } from './session.js';
import type { PixelRect } from './view_math.js';

export interface PageObservation extends Observation {
  /** Where the game's canvas is in the page (CSS pixels) and surface pixels per CSS pixel. */
  readonly page: { readonly canvas: PixelRect; readonly pixelRatio: number };
}

function describe(el: Element): string {
  const action = el.getAttribute('data-action');
  return `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}${action === null ? '' : `[data-action="${action}"]`}`;
}

/** The element's own and its ancestors' styles (across the shadow boundary): why it can't be seen, or null. */
function hiddenBy(el: Element): string | null {
  let at: Element | null = el;
  for (let depth = 0; at !== null && depth < 64; depth++) {
    const view = at.ownerDocument.defaultView;
    if (view === null) return 'detached';
    const style = view.getComputedStyle(at);
    if (style.display === 'none') return `${at === el ? 'it' : describe(at)} has display:none`;
    if (style.opacity === '0') return `${at === el ? 'it' : describe(at)} has opacity:0`;
    if (at === el && (style.visibility === 'hidden' || style.visibility === 'collapse')) return 'it has visibility:hidden';
    const parent: Element | null = at.parentElement;
    at = parent ?? ((at.getRootNode() as ShadowRoot).host ?? null);
  }
  return null;
}

/** Every `data-action` control of every drawn panel, by panel id. Scripted panels (sandboxed frames) can't be looked into. */
export function inspectControls(ui: Element): Map<string, ObservedControl[]> {
  const out = new Map<string, ObservedControl[]>();
  const doc = ui.ownerDocument;
  for (const host of ui.querySelectorAll<HTMLElement>('.parallax-panel[data-panel]')) {
    const panel = host.dataset['panel']!;
    const root = host.shadowRoot;
    const controls = out.get(panel) ?? [];
    out.set(panel, controls);
    if (root === null) continue;
    for (const el of root.querySelectorAll<HTMLElement>('[data-action]')) {
      const r = el.getBoundingClientRect();
      const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim() || (el.getAttribute('aria-label') ?? '');
      const action = el.getAttribute('data-action')!;
      const point: [number, number] = [r.x + r.width / 2, r.y + r.height / 2];
      let reason: string | null = null;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') reason = 'disabled';
      else if (r.width === 0 || r.height === 0) reason = 'zero area';
      else reason = hiddenBy(el);
      if (reason === null) {
        const top = doc.elementFromPoint(point[0], point[1]);
        if (top === null) reason = 'its center is outside the page';
        else if (top !== host && !host.contains(top)) reason = `covered by ${describe(top)}`;
        else {
          const inner = root.elementFromPoint(point[0], point[1]);
          if (inner === null || (inner !== el && !el.contains(inner))) reason = `covered by ${inner === null ? 'nothing it can hit' : describe(inner)}`;
        }
      }
      controls.push({ action, text, rect, clickable: reason === null, point: reason === null ? point : null, reason });
    }
  }
  return out;
}

function canvasOf(game: BrowserGame): HTMLCanvasElement {
  const canvas = game.stage.surface.querySelector('canvas');
  if (canvas === null) throw new Error('The game has no canvas yet');
  return canvas;
}

/** observe() plus the page: panel controls and where the canvas is. */
export function observePage(game: BrowserGame, options: ObserveOptions & { readonly session?: EditorSession } = {}): PageObservation {
  const base = options.session !== undefined ? options.session.observe(options) : observe(game.runtime, options);
  const controls = inspectControls(game.stage.ui);
  const canvas = canvasOf(game);
  const r = canvas.getBoundingClientRect();
  return {
    ...base,
    panels: base.panels.map((p) => ({ ...p, controls: controls.get(p.id) ?? [] })),
    page: { canvas: { x: r.x, y: r.y, width: r.width, height: r.height }, pixelRatio: r.width === 0 ? 1 : canvas.width / r.width },
  };
}

export interface Capture {
  readonly width: number;
  readonly height: number;
  /** RGBA8, rows top to bottom. */
  readonly pixels: Uint8Array;
  readonly png: Uint8Array;
}

/**
 * The next frame's pixels as drawn on the canvas: read right after the renderer draws it,
 * in the same task, from whichever context the canvas has. Rejects after `timeoutMs` when no
 * frame is drawn (a hidden page doesn't draw).
 */
export function capturePixels(game: BrowserGame, options: { readonly timeoutMs?: number } = {}): Promise<Capture> {
  const canvas = canvasOf(game);
  const kernel = game.runtime.kernel;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      remove();
      clearTimeout(timer);
      fn();
    };
    const remove = kernel.addHook('render', () => {
      finish(() => {
        try {
          const copy = canvas.ownerDocument.createElement('canvas');
          copy.width = canvas.width;
          copy.height = canvas.height;
          const ctx = copy.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(canvas, 0, 0);
          const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
          const pixels = new Uint8Array(data.buffer.slice(0));
          resolve({ width: copy.width, height: copy.height, pixels, png: encodePng(copy.width, copy.height, pixels) });
        } catch (error) {
          reject(error);
        }
      });
    }, { last: true, owner: 'editor-capture' });
    const timer = setTimeout(() => finish(() => reject(new Error(`No frame was drawn within ${options.timeoutMs ?? 2000} ms`))), options.timeoutMs ?? 2000);
  });
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface Automation {
  readonly game: BrowserGame;
  readonly session: EditorSession | undefined;
  observe(options?: ObserveOptions): PageObservation;
  /** The next frame as a PNG, base64 (crosses page.evaluate as text). */
  capture(): Promise<{ width: number; height: number; png: string }>;
}

/** Install `globalThis.parallaxAutomation` for a headless browser harness. */
export function exposeAutomation(game: BrowserGame, session?: EditorSession): Automation {
  const automation: Automation = {
    game,
    session,
    observe: (options = {}) => observePage(game, { ...options, ...(session !== undefined && { session }) }),
    capture: async () => {
      const shot = await capturePixels(game);
      return { width: shot.width, height: shot.height, png: base64(shot.png) };
    },
  };
  (globalThis as { parallaxAutomation?: Automation }).parallaxAutomation = automation;
  return automation;
}

/**
 * An EditorSession's host in a page: hot reload rebuilds from `build()` (the URL of the new
 * build; a different URL per build, so its modules are imported afresh) and the page loop
 * steps the new runtime.
 */
export function browserHost(game: BrowserGame, build: () => string): SessionHost {
  return {
    rebuild: (files: ProjectFiles) => game.rebuild(build(), { editing: true, files }),
    replace: (next) => game.replace(next),
  };
}
