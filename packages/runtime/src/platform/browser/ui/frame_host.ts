/**
 * Scripted panels (DESIGN §4.12, §7.3): a panel whose markup has `<script>` runs, markup
 * and scripts together, in a sandboxed frame — never in the page.
 *
 *   sandbox="allow-scripts", no allow-same-origin  an opaque origin: no cookies, no storage,
 *       no access to the page or its other frames; no forms, popups, dialogs or navigation
 *   a content security policy (in the frame document) that blocks every network request:
 *       scripts only inline or from the engine's own folder, images, fonts and media only
 *       from the project's files, nothing else (no fetch, XHR, WebSocket, beacons). A packed
 *       build's files have no URL the frame may load (the page's blob: URLs are bound to the
 *       page's origin), so there they are data: URLs: the ones the markup and CSS name are
 *       written into the panel, and the frame asks for the ones state names later (`file`)
 *   one channel out: `postMessage` with a fixed set of typed messages, checked here —
 *       `ready`, `action` (a declared action's name and a small JSON payload), `key` (a key
 *       the frame did not use, so a game's keys still work while it has focus) and
 *       `pointer` (a non-modal panel's press, move or release off its controls, which the
 *       page replays to the game as a press on the play area: what any non-modal panel
 *       lets through) and `press` (the player pressed somewhere in the frame, controls
 *       included: nothing about where, so a host page can take its pointer lock back; while
 *       the page asks for capture presses (`capture`), that press reaches nothing in the frame)
 *       and `file` (a project file's URL, when the frame has no folder to resolve it against)
 *
 * Inside, the frame module (`frame.ts`) builds the markup with the same binder as every
 * panel and gives scripts `parallax.on_state(fn)` and `parallax.action(name, payload)`.
 * State crosses as JSON (`frame_values.ts`).
 */

import { textDirectionOf } from '../../../core/index.js';
import type { UiValueRules } from '../../../core/index.js';
import type { MarkupNode, PanelScript } from './markup.js';
import { wireState } from './frame_values.js';
import { VIEW_CONTAINER_STYLE } from './viewport.js';
import type { Wire } from './frame_values.js';

/**
 * A project's files as a scripted panel's frame loads them. The frame's origin is opaque, so
 * a URL only the page may load (a packed build's blob: URLs) is no use there.
 */
export interface FrameFiles {
  /** The project folder's URL, when every file has a URL under it (loose files); null when not (a packed build). */
  readonly base: string | null;
  /** A file's URL the frame may load (a data: URL from a packed build), or undefined: no such image, font or style. */
  url(path: string): string | undefined;
}

/** What the frame module reads from its document: the panel, ready to build. */
export interface FrameInit {
  readonly nodes: readonly MarkupNode[];
  /** Script code in document order (`src` scripts already read from the project). */
  readonly scripts: readonly { readonly code: string; readonly module: boolean }[];
  /** The panel's folder, a project path (`ui/`; relative references resolve from it). */
  readonly folder: string;
  /**
   * URL of the project's files, or null when they have none the frame may load (a packed
   * build): it then asks the page for each file's URL (`file`).
   */
  readonly project: string | null;
  readonly modal: boolean;
}

export interface FrameDocumentOptions {
  readonly init: FrameInit;
  readonly css: string;
  /** URL of the frame script (`panel_frame.js` in the engine bundle: a classic script, so it loads without CORS). */
  readonly module: string;
  /** The player's language: the document's `lang`, and `dir="rtl"` when it reads right to left. */
  readonly language?: string;
}

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function folderUrl(url: string): string {
  return url.slice(0, url.lastIndexOf('/') + 1);
}

/** The frame's document: its security policy, styles, the panel as data, and the frame module. */
export function frameDocument(options: FrameDocumentOptions): string {
  const engine = folderUrl(options.module);
  const project = options.init.project === null ? '' : `${options.init.project} `;
  const csp = [
    "default-src 'none'", `script-src 'unsafe-inline' ${engine}`, "style-src 'unsafe-inline'",
    `img-src ${project}data:`, `font-src ${project}data:`, `media-src ${project}data:`, "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  // Panel CSS is written for a shadow root (`:host`); here the panel is the frame's whole document.
  // The document is the size container panel CSS's rewritten viewport units and queries measure (viewport.ts).
  const css = `:root { color-scheme: normal; container: ${VIEW_CONTAINER_STYLE}; }\nhtml, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }\n${options.css}`
    .replace(/:host\b/g, ':root');
  const language = options.language ?? '';
  const lang = language === '' ? '' : ` lang="${language.replace(/[^A-Za-z0-9_-]/g, '')}"`;
  const dir = textDirectionOf(language) === 'rtl' ? ' dir="rtl"' : '';
  return `<!doctype html>
<html${lang}${dir}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">
<style>${css.replace(/<\/style/gi, '<\\/style')}</style>
<script type="application/json" id="parallax-panel">${scriptJson(options.init)}</script>
<script defer src="${options.module.replace(/"/g, '%22')}"></script>
</head><body></body></html>`;
}

/** The scripts of a panel as code: inline ones as written, `src` ones read from the project. */
export function scriptCode(
  scripts: readonly PanelScript[], resolve: (path: string) => string | undefined, missing: (path: string) => never,
): FrameInit['scripts'] {
  return scripts.map((s) => {
    if (s.kind === 'inline') return { code: s.code, module: s.module };
    return { code: resolve(s.path) ?? missing(s.path), module: s.module };
  });
}

/** Messages a frame may send; anything else is dropped. */
export type FrameMessage =
  | { readonly t: 'ready' }
  | { readonly t: 'action'; readonly action: string; readonly data: Readonly<Record<string, Wire>> }
  | { readonly t: 'key'; readonly type: 'keydown' | 'keyup'; readonly code: string; readonly key: string; readonly repeat: boolean }
  | { readonly t: 'pointer'; readonly pointer: FramePointer }
  | { readonly t: 'press' }
  | { readonly t: 'file'; readonly path: string };

/** A pointer event in the frame, off its controls: frame-viewport pixels. */
export interface FramePointer {
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
  readonly pointerType: 'mouse' | 'pen' | 'touch';
  readonly pointerId: number;
  readonly isPrimary: boolean;
}

const POINTER_TYPES = new Set(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']);
const POINTER_KINDS = new Set(['mouse', 'pen', 'touch']);

const ACTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_PAYLOAD = 16 * 1024;
const MAX_PATH = 512;

function plainJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 8 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every((v) => plainJson(v, depth + 1));
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((v) => plainJson(v, depth + 1));
}

/** A frame's message, if it is one of the fixed set with the right shape. */
export function frameMessage(data: unknown): FrameMessage | undefined {
  if (typeof data !== 'object' || data === null || (data as { parallax?: unknown }).parallax !== 1) return undefined;
  const m = data as Record<string, unknown>;
  switch (m['t']) {
    case 'ready':
      return { t: 'ready' };
    case 'press':
      return { t: 'press' };
    case 'file': {
      const path = m['path'];
      return typeof path === 'string' && path !== '' && path.length <= MAX_PATH ? { t: 'file', path } : undefined;
    }
    case 'action': {
      const action = m['action'];
      const payload = m['data'] ?? {};
      if (typeof action !== 'string' || !ACTION_NAME.test(action)) return undefined;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !plainJson(payload, 0)) return undefined;
      if (JSON.stringify(payload).length > MAX_PAYLOAD) return undefined;
      return { t: 'action', action, data: payload as Record<string, Wire> };
    }
    case 'key': {
      const { type, code, key, repeat } = m as { type?: unknown; code?: unknown; key?: unknown; repeat?: unknown };
      if ((type !== 'keydown' && type !== 'keyup') || typeof code !== 'string' || typeof key !== 'string' || typeof repeat !== 'boolean') return undefined;
      if (code.length > 32 || key.length > 32) return undefined;
      return { t: 'key', type, code, key, repeat };
    }
    case 'pointer': {
      const p = m['pointer'] as Record<string, unknown> | null | undefined;
      if (typeof p !== 'object' || p === null) return undefined;
      const { type, x, y, buttons, pointerType, pointerId, isPrimary } = p;
      if (typeof type !== 'string' || !POINTER_TYPES.has(type) || typeof pointerType !== 'string' || !POINTER_KINDS.has(pointerType)) return undefined;
      if (![x, y, buttons, pointerId].every((n) => typeof n === 'number' && Number.isFinite(n)) || typeof isPrimary !== 'boolean') return undefined;
      if (!Number.isInteger(buttons) || (buttons as number) < 0 || (buttons as number) > 31) return undefined;
      return { t: 'pointer', pointer: { type, x, y, buttons, pointerType, pointerId, isPrimary } as FramePointer };
    }
    default:
      return undefined;
  }
}

export interface PanelFrameOptions {
  readonly document: Document;
  readonly srcdoc: string;
  /** A declared action, sent by a click or `parallax.action` in the frame. */
  readonly onAction: (action: string, data: Readonly<Record<string, Wire>>) => void;
  /** A key the frame didn't use, to replay to the game's input. */
  readonly onKey: (type: 'keydown' | 'keyup', init: { code: string; key: string; repeat: boolean }) => void;
  /** A non-modal panel's pointer event off its controls, in page pixels, to replay on the play area. */
  readonly onPointer: (pointer: FramePointer) => void;
  /** The player pressed inside the frame (anywhere, its controls too). */
  readonly onPress?: () => void;
  /** A project file's URL the frame may load (`FrameInit.project` null), or undefined: none. */
  readonly file?: (path: string) => string | undefined;
}

/** The page's side of one scripted panel's frame. */
export class PanelFrame {
  readonly element: HTMLIFrameElement;
  readonly #options: PanelFrameOptions;
  #ready = false;
  #pending: string | undefined;
  #sent: string | undefined;
  #capture = false;

  constructor(options: PanelFrameOptions) {
    this.#options = options;
    const frame = options.document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.setAttribute('title', 'Game panel');
    // The frame takes every press (its controls answer, the rest it hands back as `pointer`), even in a pass-through host.
    // `colorScheme: normal` on both sides: Chromium paints an opaque backdrop behind a frame whose
    // embedding element's color scheme (inherited from a dark host page, e.g. the editor) differs
    // from its document's, which hid the game behind every scripted panel.
    Object.assign(frame.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', background: 'transparent', pointerEvents: 'auto',
      colorScheme: 'normal',
    });
    frame.srcdoc = options.srcdoc;
    this.element = frame;
  }

  /** Send this frame's state (only when it changed; held until the frame is ready). */
  update(state: Readonly<Record<string, unknown>>, values: UiValueRules, strings: Readonly<Record<string, string>>, enabled: Readonly<Record<string, boolean>>): void {
    const text = JSON.stringify({ state: wireState(state, values), strings, enabled });
    if (text === this.#sent || text === this.#pending) return;
    if (!this.#ready) {
      this.#pending = text;
      return;
    }
    this.#post(text);
  }

  #post(text: string): void {
    this.#sent = text;
    const { state, strings, enabled } = JSON.parse(text) as { state: Wire; strings: unknown; enabled: unknown };
    // The frame's origin is opaque: '*' is the only target that reaches it (it holds nothing secret).
    this.element.contentWindow?.postMessage({ parallax: 1, t: 'state', state, strings, enabled }, '*');
  }

  /** A message event: handled (true) when it came from this frame. */
  receive(event: MessageEvent): boolean {
    if (event.source === null || event.source !== this.element.contentWindow) return false;
    const message = frameMessage(event.data);
    if (message === undefined) return true; // ours, but not one of the fixed set: dropped
    switch (message.t) {
      case 'ready':
        this.#ready = true;
        if (this.#capture) this.#postCapture();
        // A frame announces ready again when it reloads (moving the element reloads an
        // iframe): it starts empty, so it gets the latest state again, not only a pending one.
        if (this.#pending !== undefined || this.#sent !== undefined) {
          const latest = this.#pending ?? this.#sent!;
          this.#pending = undefined;
          this.#post(latest);
        }
        return true;
      case 'action':
        this.#options.onAction(message.action, message.data);
        return true;
      case 'key':
        this.#options.onKey(message.type, { code: message.code, key: message.key, repeat: message.repeat });
        return true;
      case 'press':
        this.#options.onPress?.();
        return true;
      case 'file':
        this.element.contentWindow?.postMessage({ parallax: 1, t: 'file', path: message.path, url: this.#options.file?.(message.path) ?? null }, '*');
        return true;
      case 'pointer': {
        // Frame pixels → page pixels: the panel host may be scaled (`@ui(scale=...)`).
        const r = this.element.getBoundingClientRect();
        const k = this.element.offsetWidth > 0 ? r.width / this.element.offsetWidth : 1;
        this.#options.onPointer({ ...message.pointer, x: r.left + message.pointer.x * k, y: r.top + message.pointer.y * k });
        return true;
      }
    }
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  /** While on, the frame's next real press is a capture press only (`press`, nothing else sees it). */
  setCapture(on: boolean): void {
    if (on === this.#capture) return;
    this.#capture = on;
    if (this.#ready) this.#postCapture();
  }

  #postCapture(): void {
    this.element.contentWindow?.postMessage({ parallax: 1, t: 'capture', on: this.#capture }, '*');
  }
}
