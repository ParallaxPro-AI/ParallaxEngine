/**
 * The browser's panel surface (core's `UiSurface`): draws the open panels in the stage's
 * UI layer and reports clicks, taps and `data-key` shortcuts as panel clicks.
 *
 *   ui layer (.parallax-ui, pass-through)
 *     hud       non-modal panels of layer "hud"
 *     feedback  toasts, announcements, floating text, labels
 *     menu      layer "menu" panels
 *     overlay   layer "overlay" panels
 *
 * Each panel (each seat's copy of a PlayerPanel) is a host element laid out over the full
 * stage or its seat's viewport, with an open shadow root holding the default style, the
 * game's CSS and the bound markup — so game CSS can't reach the page or another panel,
 * and `position: fixed` resolves against the panel's area (the host contains layout).
 * The host is also the size container panel CSS measures: `vh` / `vw` and `@media` size
 * queries are rewritten to container units and queries (viewport.ts), so a panel sizes to
 * the game view (or its seat's viewport), not the page around it.
 *
 * Pointer: a modal host takes every press (nothing reaches the game under it); a
 * non-modal panel lets presses through except on its controls (actions, buttons, inputs).
 * Keyboard: `data-key` shortcuts work on the top modal (or every panel when none is
 * modal), and a key a shortcut takes never reaches the game's input; while a modal is
 * open its first action has focus (without a focus-visible ring until the player
 * navigates), arrows / Tab move between its actions, Enter / Space activate; a gamepad's
 * d-pad and south button do the same.
 * While a control is being rebound (`UiFrame.capturing`) the surface ignores keys and pads.
 * The stage's virtual cursor (`virtual_cursor.ts`) takes its look from `UiFrame.cursor`.
 *
 * A real press inside a scripted panel's frame dispatches `FRAME_PRESS_EVENT` (bubbling,
 * no detail) on the UI layer: the page never sees the frame's own pointer events, and a
 * host page may want to know that the player clicked the game view (to lock the pointer).
 * With `setPressCapture(true)` the next real press in a frame is only that: its controls and
 * scripts never see it (the page's own click-to-capture, as on the rest of the game view).
 *
 * A host page that shows something else in the game's place (an editor's scene view)
 * suspends the surface (`setSuspended`): the UI layer is hidden, and keys, pads and clicks
 * are ignored; panels keep following the game's state, so they are current when shown again.
 */

import { fail, textDirectionOf, UI_ICON_NAMES } from '../../../core/index.js';
import type { ProjectFiles, UiClick, UiEffect, UiFloatStyle, UiFrame, UiLayer, UiPanelFrame, UiPanelScale, UiRect, UiSurface } from '../../../core/index.js';
import { PanelBinding } from './binding.js';
import { BUILTIN_PANELS, DEFAULT_PANEL_CSS, FEEDBACK_CSS, PASS_THROUGH_CSS } from './builtins.js';
import { ClaimedKeys } from './claimed_keys.js';
import { inlineStyle, scopeCss } from './css.js';
import { fontFaceCss, installFonts } from './fonts.js';
import { registerPanelFonts, renameFontFamilies, renameNodeFonts, scopePanelFonts } from './panel_fonts.js';
import { frameDocument, PanelFrame, scriptCode } from './frame_host.js';
import type { FrameFiles } from './frame_host.js';
import { expandIcons } from './icons.js';
import { expandTemplates, folderOf, parseMarkup, projectPath, sanitizePanel, urlResolver } from './markup.js';
import type { MarkupNode, PanelScript } from './markup.js';
import { QUIET_FOCUS, VISIBLE_FOCUS } from './dom.js';
import type { DomDocument, DomParent } from './dom.js';
import { panelScale } from './panel_scale.js';
import { VIEW_CONTAINER_STYLE } from './viewport.js';
import { virtualCursorFor } from './virtual_cursor.js';

const LAYERS = ['hud', 'feedback', 'menu', 'overlay'] as const;
const FLOAT_SECONDS = 1;
/** The game's own look for toasts and announcements (optional). */
export const FEEDBACK_THEME = 'ui/feedback.html';

const cssRgba = ([r, g, b, a]: readonly number[]): string =>
  `rgba(${Math.round(r! * 255)}, ${Math.round(g! * 255)}, ${Math.round(b! * 255)}, ${a})`;

/** A `FloatStyle` as the element's own style: its keyframes (pp-float) read the custom properties. */
export function applyFloatStyle(el: HTMLElement, style: UiFloatStyle): void {
  const s = el.style;
  s.fontSize = `${style.size}px`;
  s.fontWeight = style.bold ? '800' : '500';
  if (style.font !== null) s.fontFamily = style.font;
  if (style.outline !== null && style.outlineWidth > 0) {
    // Stroke behind the fill (paint-order), so a thick outline doesn't eat the glyphs.
    s.setProperty('-webkit-text-stroke', `${style.outlineWidth * 2}px ${cssRgba(style.outline)}`);
    s.setProperty('paint-order', 'stroke fill');
  }
  s.setProperty('--pp-rise', `${-style.rise}px`);
  s.setProperty('--pp-pop', String(style.pop));
  s.setProperty('--pp-end', String(style.endScale));
  s.animationDuration = `${style.seconds}s`;
}
/** Standard-layout gamepad buttons the surface navigates with. */
const PAD = { south: 0, up: 12, down: 13, left: 14, right: 15 } as const;

export interface DomUiSurfaceOptions {
  /** The stage's UI layer. */
  readonly ui: HTMLElement;
  /** The project's text files (panel markup and CSS). */
  readonly files: ProjectFiles;
  /** A project path's URL on the page (images and fonts that markup and CSS name). */
  readonly url: (path: string) => string;
  /** Where keys are heard; default the page's window. */
  readonly keys?: EventTarget;
  /** Gamepads for menu navigation; default `navigator.getGamepads`. */
  readonly gamepads?: () => readonly (Gamepad | null)[];
  /**
   * URL of the engine's panel frame module (`panel_frame.js`): panels with `<script>` run in
   * a sandboxed frame that loads it. Without it such a panel is an error (PP2076).
   */
  readonly frameModule?: string;
  /** The project's files as those frames load them; default `url`'s, under `url('')`. */
  readonly frameFiles?: FrameFiles;
}

interface Compiled {
  readonly nodes: MarkupNode[];
  /** The panel's CSS, its `@font-face` rules lifted out into `faces` (panel_fonts.ts). */
  readonly css: string;
  /** The panel's own `@font-face` rules, families renamed per panel; declared on the document. */
  readonly faces: string;
  /** Declared family (lower case) → its registered name, for inline styles. */
  readonly families: ReadonlyMap<string, string>;
  readonly scripts: readonly PanelScript[];
}

interface PanelHost {
  readonly key: string;
  readonly panel: string;
  readonly seat: number;
  readonly layer: UiLayer;
  readonly element: HTMLElement;
  readonly root: ShadowRoot;
  /** The panel's markup, bound (empty for a scripted panel: its markup lives in its frame). */
  readonly binding: PanelBinding;
  /** A scripted panel's sandboxed frame. */
  readonly frame: PanelFrame | null;
  /** Where it is laid out (a fraction of the UI layer) and how its pixels scale. */
  viewport: UiRect;
  scale: UiPanelScale;
  /** The layout last applied (`#layout`), to skip unchanged writes. */
  rect: string;
  modal: boolean;
  dispose(): void;
}

interface Timed {
  readonly element: Element;
  readonly until: number;
}

function rectKey(r: UiRect): string {
  return r.map((v) => (v * 100).toFixed(4)).join(',');
}

function place(element: HTMLElement, r: UiRect): void {
  Object.assign(element.style, {
    left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%`,
  });
}

function isEditable(node: unknown): boolean {
  const el = node as { tagName?: string; isContentEditable?: boolean } | null;
  if (el === null || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

/** The event a real press inside a scripted panel's frame dispatches on the UI layer (it bubbles). */
export const FRAME_PRESS_EVENT = 'parallax:framepress';

export class DomUiSurface implements UiSurface {
  readonly #ui: HTMLElement;
  readonly #doc: Document;
  readonly #files: ProjectFiles;
  readonly #url: (path: string) => string;
  readonly #gamepads: () => readonly (Gamepad | null)[];
  readonly #frameModule: string | undefined;
  readonly #frameFiles: FrameFiles | undefined;
  readonly #keys: EventTarget;
  readonly #layers: Record<(typeof LAYERS)[number], HTMLElement>;
  readonly #compiled = new Map<string, Compiled>();
  readonly #hosts = new Map<string, PanelHost>();
  #clicks: UiClick[] = [];
  #order: PanelHost[] = [];
  #topModal: string | null = null;
  #padHeld = new Set<number>();
  /** A control is being rebound: keys and pads go to the game's input, untouched. */
  #capturing = false;
  #suspended = false;
  #pressCapture = false;
  /** Keys a `data-key` shortcut took: the game's input never sees them (claimed_keys.ts). */
  readonly #claimed = new ClaimedKeys();
  /** The language the UI layer's `lang` / `dir` were last set for. */
  #language: string | null = null;
  readonly #dispose: (() => void)[] = [];
  /** The UI layer's size, once measured; panel scales follow it. */
  #size: { width: number; height: number } | undefined;
  /** `(pointer: coarse)`: a touch screen's panels scale by the touch rules. */
  readonly #coarse: MediaQueryList | undefined;

  readonly #feedback: ShadowRoot;
  readonly #areas = new Map<string, { element: HTMLElement; toasts: HTMLElement; announce: Element | null }>();
  #timed: Timed[] = [];
  readonly #labels = new Map<number, HTMLElement>();
  #floats: HTMLElement;
  /** `ui/feedback.html`'s templates once read (null: the game has none; undefined: not looked yet). */
  #theme: { readonly templates: ReadonlyMap<string, readonly MarkupNode[]>; readonly families: ReadonlyMap<string, string> } | null | undefined;

  constructor(options: DomUiSurfaceOptions) {
    this.#ui = options.ui;
    this.#doc = options.ui.ownerDocument;
    this.#files = options.files;
    this.#url = options.url;
    this.#gamepads = options.gamepads ?? (() => globalThis.navigator?.getGamepads?.() ?? []);
    this.#frameModule = options.frameModule;
    this.#frameFiles = options.frameFiles;
    const layer = (name: string): HTMLElement => {
      const el = this.#doc.createElement('div');
      el.className = `parallax-ui-${name}`;
      Object.assign(el.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
      this.#ui.append(el);
      return el;
    };
    this.#layers = { hud: layer('hud'), feedback: layer('feedback'), menu: layer('menu'), overlay: layer('overlay') };
    this.#layers.feedback.style.container = VIEW_CONTAINER_STYLE;
    this.#feedback = this.#layers.feedback.attachShadow({ mode: 'open' });
    this.#feedback.append(this.#style(FEEDBACK_CSS));
    this.#floats = this.#area([0, 0, 1, 1]).element;
    installFonts(this.#doc);
    const view = this.#doc.defaultView;
    this.#coarse = view?.matchMedia?.('(pointer: coarse)');
    const relayout = (): void => {
      for (const host of this.#hosts.values()) this.#layout(host);
    };
    if (this.#coarse !== undefined) {
      this.#coarse.addEventListener('change', relayout);
      this.#dispose.push(() => this.#coarse!.removeEventListener('change', relayout));
    }
    const Observer = (view as (Window & typeof globalThis) | null)?.ResizeObserver;
    if (Observer !== undefined) {
      const observer = new Observer((entries) => {
        const box = entries[entries.length - 1]!.contentRect;
        this.#size = { width: box.width, height: box.height };
        relayout();
      });
      observer.observe(this.#ui);
      this.#dispose.push(() => observer.disconnect());
    }

    const keys = options.keys ?? globalThis.window;
    this.#keys = keys;
    const onMessage = (e: Event): void => {
      for (const host of this.#hosts.values()) if (host.frame?.receive(e as MessageEvent) === true) return;
    };
    keys.addEventListener('message', onMessage);
    this.#dispose.push(() => keys.removeEventListener('message', onMessage));
    const onKey = (e: Event): void => this.#key(e as KeyboardEvent);
    // Capture: a panel sees its keys before the game's input does (typing in a panel field, Enter on a button).
    keys.addEventListener('keydown', onKey, { capture: true });
    this.#dispose.push(() => keys.removeEventListener('keydown', onKey, { capture: true }));
  }

  // ── UiSurface ─────────────────────────────────────────────────────────────────

  takeClicks(): UiClick[] {
    const out = this.#clicks;
    this.#clicks = [];
    return this.#suspended ? [] : out;
  }

  /** While on, a real press inside a scripted panel's frame only dispatches `FRAME_PRESS_EVENT` (a host's click-to-capture). */
  setPressCapture(on: boolean): void {
    this.#pressCapture = on;
    for (const host of this.#hosts.values()) host.frame?.setCapture(on);
  }

  /** Whether the surface is suspended (`setSuspended`). */
  get suspended(): boolean {
    return this.#suspended;
  }

  /** Hide the panels and ignore keys, pads and clicks while the host shows something else. */
  setSuspended(suspended: boolean): void {
    if (suspended === this.#suspended) return;
    this.#suspended = suspended;
    this.#ui.style.visibility = suspended ? 'hidden' : '';
    this.#clicks = [];
    this.#padHeld.clear();
    if (suspended) {
      // Focus inside a hidden panel would keep the page's keys; give it back.
      const active = this.#doc.activeElement as HTMLElement | null;
      if (active !== null && this.#ui.contains(active)) active.blur();
      for (const host of this.#hosts.values()) {
        (host.root.activeElement as HTMLElement | null)?.blur?.();
      }
      this.#topModal = null; // shown again: the top modal takes focus afresh
    }
  }

  present(frame: UiFrame): void {
    this.#capturing = frame.capturing;
    this.#direction(frame.language);
    virtualCursorFor(this.#ui).setLook(frame.cursor, this.#url);
    const wanted: PanelHost[] = [];
    for (const panel of frame.panels) {
      for (const instance of panel.instances) {
        const key = `${panel.id}#${instance.seat}`;
        const host = this.#hosts.get(key) ?? this.#create(key, panel, instance.seat);
        host.modal = panel.modal;
        host.element.style.pointerEvents = panel.modal ? 'auto' : 'none';
        host.viewport = instance.viewport;
        host.scale = panel.scale ?? 'viewport';
        this.#layout(host);
        if (host.frame !== null) {
          host.frame.update(instance.state, frame.values, frame.strings, panel.enabled);
        } else {
          host.binding.update({ state: instance.state, values: frame.values, strings: frame.strings, enabled: panel.enabled, time: frame.time });
        }
        wanted.push(host);
      }
    }
    for (const [key, host] of this.#hosts) {
      if (!wanted.includes(host)) {
        host.dispose();
        this.#hosts.delete(key);
      }
    }
    this.#arrange(wanted);
    this.#order = wanted;
    if (!this.#suspended) {
      this.#focusTopModal();
      this.#pollPads();
    }
    this.#effects(frame);
  }

  /** Remove everything the surface added and its listeners. */
  dispose(): void {
    for (const host of this.#hosts.values()) host.dispose();
    this.#hosts.clear();
    for (const fn of this.#dispose.splice(0)) fn();
    for (const el of Object.values(this.#layers)) el.remove();
  }

  // ── Panels ────────────────────────────────────────────────────────────────────

  #compile(html: string): Compiled {
    const cached = this.#compiled.get(html);
    if (cached !== undefined) return cached;
    const builtin = BUILTIN_PANELS[html];
    const has = (path: string): boolean => this.#files.list().includes(path);
    const read = (path: string): string | undefined => (has(path) ? this.#files.read(path) : undefined);
    let source: string;
    if (builtin !== undefined) {
      source = builtin;
    } else {
      const text = read(html);
      if (text === undefined) {
        fail('PP2072', `Panel markup "${html}" does not exist`, { path: html, fix: `Create ${html}, or fix the @ui html= path.` });
      }
      source = text;
    }
    const folder = builtin !== undefined ? '' : folderOf(html);
    const expanded = expandTemplates(parseMarkup(source), read, (missing) => {
      fail('PP2072', `Template file "${missing}" does not exist`, { path: html, fix: `Create ${missing} (a project path), or fix <template src>.` });
    });
    let url = this.#url;
    let sanitized = sanitizePanel(expanded, urlResolver(folder, url), (css) => inlineStyle(css, folder, url));
    // A scripted panel runs in a frame (#frame): its markup and CSS name files by the frame's URLs.
    if (sanitized.scripts.length > 0 && this.#frameFiles !== undefined) {
      const frameFiles = this.#frameFiles;
      url = (path) => frameFiles.url(path) ?? '';
      sanitized = sanitizePanel(expanded, urlResolver(folder, url), (css) => inlineStyle(css, folder, url));
    }
    const files = { read, url };
    const panel = {
      ...sanitized,
      nodes: expandIcons(sanitized.nodes, (name) => fail('PP2077', `Unknown icon "${name}" in ${html}`, {
        path: html, fix: `Built-in icons: ${UI_ICON_NAMES.join(', ')}.`,
      })),
    };
    const styles = panel.styles.map((style) => {
      if (style.kind === 'inline') return scopeCss(style.css, folder, files);
      const path = projectPath(folder, style.path);
      const text = path === undefined ? undefined : read(path);
      if (path === undefined || text === undefined) {
        fail('PP2072', `Stylesheet "${style.path}" (linked from ${html}) does not exist in the project`, {
          path: html, fix: 'Link a .css file in the project by a relative path (href="style.css" next to the panel).',
        });
      }
      return scopeCss(text, folderOf(path), files, new Set([path]));
    }).join('\n');
    const fonts = scopePanelFonts(styles);
    const compiled = {
      nodes: renameNodeFonts(panel.nodes, fonts.families), css: fonts.css, faces: fonts.faces, families: fonts.families,
      scripts: panel.scripts,
    };
    this.#compiled.set(html, compiled);
    return compiled;
  }

  #style(css: string): HTMLStyleElement {
    const style = this.#doc.createElement('style');
    style.textContent = css;
    return style;
  }

  #create(key: string, panel: UiPanelFrame, seat: number): PanelHost {
    const compiled = this.#compile(panel.html);
    const element = this.#doc.createElement('div');
    element.className = 'parallax-panel';
    element.dataset['panel'] = panel.id;
    // The panel's CSS measures this area, not the page (viewport.ts).
    Object.assign(element.style, { position: 'absolute', contain: 'layout paint', overflow: 'hidden', container: VIEW_CONTAINER_STYLE });
    const root = element.attachShadow({ mode: 'open' });
    const folder = panel.html.startsWith('builtin:') ? '' : folderOf(panel.html);
    const scripted = compiled.scripts.length > 0;
    const frame = scripted ? this.#frame(panel, compiled, folder, seat) : null;
    if (frame !== null) {
      frame.setCapture(this.#pressCapture);
      root.append(frame.element);
    }
    else registerPanelFonts(this.#doc, compiled.faces);
    if (frame === null) root.append(this.#style(DEFAULT_PANEL_CSS), this.#style(PASS_THROUGH_CSS), this.#style(compiled.css));
    const binding = new PanelBinding(this.#doc as unknown as DomDocument, scripted ? [] : compiled.nodes, root as unknown as DomParent, {
      url: urlResolver(folder, this.#url),
      style: (css) => renameFontFamilies(inlineStyle(css, folder, this.#url), compiled.families),
    });
    const onClick = (e: Event): void => {
      const target = binding.target(e.composedPath());
      if (target === undefined) return;
      this.#clicks.push({ panel: panel.id, action: target.action, data: target.data, seat });
      // A pointer click leaves no focus behind, so a later Space/Enter is the game's again.
      if ((e as MouseEvent).detail > 0) (root.activeElement as HTMLElement | null)?.blur();
    };
    root.addEventListener('click', onClick);
    const host: PanelHost = {
      key, panel: panel.id, seat, layer: panel.layer, element, root, binding, frame, viewport: [0, 0, 1, 1], scale: 'viewport', rect: '', modal: panel.modal,
      dispose: () => {
        root.removeEventListener('click', onClick);
        element.remove();
      },
    };
    this.#hosts.set(key, host);
    return host;
  }

  /** A scripted panel's sandboxed frame (frame_host.ts): its markup, styles and scripts run there. */
  #frame(panel: UiPanelFrame, compiled: Compiled, folder: string, seat: number): PanelFrame {
    const module = this.#frameModule;
    if (module === undefined) {
      fail('PP2076', `Panel "${panel.id}" (${panel.html}) has a <script>, and this page can't run panel scripts`, {
        path: panel.html, fix: 'Boot the game with the engine\'s panel frame module (`parallax edit` does), or remove the script.',
      });
    }
    const has = (path: string): boolean => this.#files.list().includes(path);
    const scripts = scriptCode(compiled.scripts, (src) => {
      const path = projectPath(folder, src);
      return path !== undefined && has(path) && path.endsWith('.js') ? this.#files.read(path) : undefined;
    }, (src) => fail('PP2072', `Script "${src}" (in ${panel.html}) is not a .js file in the project`, {
      path: panel.html, fix: 'Name a .js file next to the panel (src="menu.js"), or write the script inline.',
    }));
    const files = this.#frameFiles ?? { base: this.#url(''), url: this.#url };
    const srcdoc = frameDocument({
      module,
      css: `${fontFaceCss()}\n${compiled.faces}\n${DEFAULT_PANEL_CSS}\n${compiled.css}`,
      ...(this.#language !== null && { language: this.#language }),
      init: { nodes: compiled.nodes, scripts, folder, project: files.base, modal: panel.modal },
    });
    return new PanelFrame({
      document: this.#doc,
      srcdoc,
      file: (path) => {
        try { return files.url(path); } catch { return undefined; } // e.g. a packed file with no URL (PP9541)
      },
      onAction: (action, data) => this.#clicks.push({ panel: panel.id, action, data, seat }),
      onKey: (type, init) => {
        const KeyEvent = (this.#doc.defaultView as (Window & typeof globalThis) | null)?.KeyboardEvent ?? KeyboardEvent;
        this.#keys.dispatchEvent(new KeyEvent(type, { ...init, bubbles: true, cancelable: true }));
      },
      onPress: () => {
        const Custom = (this.#doc.defaultView as (Window & typeof globalThis) | null)?.CustomEvent ?? CustomEvent;
        this.#ui.dispatchEvent(new Custom(FRAME_PRESS_EVENT, { bubbles: true }));
      },
      // On the panels layer itself: the stage hears it as a press on the play area, not on a panel.
      onPointer: (p) => {
        const Pointer = (this.#doc.defaultView as (Window & typeof globalThis) | null)?.PointerEvent ?? PointerEvent;
        this.#ui.dispatchEvent(new Pointer(p.type, {
          clientX: p.x, clientY: p.y, buttons: p.buttons, pointerType: p.pointerType, pointerId: p.pointerId, isPrimary: p.isPrimary,
          bubbles: true, cancelable: true,
        }));
      },
    });
  }

  /**
   * The UI layer reads in the player's language's direction: `dir="rtl"` for a right-to-left
   * language (removed otherwise) and `lang`. Both inherit into every panel's shadow root; a
   * scripted panel's frame takes them when it is created.
   */
  #direction(language: string): void {
    if (language === this.#language) return;
    this.#language = language;
    if (language === '') this.#ui.removeAttribute('lang');
    else this.#ui.setAttribute('lang', language);
    if (textDirectionOf(language) === 'rtl') this.#ui.setAttribute('dir', 'rtl');
    else this.#ui.removeAttribute('dir');
  }

  /**
   * A host over its viewport at its scale (panel_scale.ts): laid out on (w / s) × (h / s)
   * CSS pixels and shrunk by s from its top-left corner, so it covers its viewport exactly.
   */
  #layout(host: PanelHost): void {
    const size = this.#size ?? this.#measure();
    const r = host.viewport;
    const s = panelScale(host.scale, r[2] * size.width, r[3] * size.height, this.#coarse?.matches === true);
    const key = `${rectKey(r)}@${s}`;
    if (key === host.rect) return;
    host.rect = key;
    place(host.element, s === 1 ? r : [r[0], r[1], r[2] / s, r[3] / s]);
    Object.assign(host.element.style, s === 1 ? { transform: '', transformOrigin: '' } : { transform: `scale(${s})`, transformOrigin: '0 0' });
  }

  /** The UI layer's size in CSS pixels (kept current by a ResizeObserver where there is one). */
  #measure(): { width: number; height: number } {
    const size = { width: this.#ui.clientWidth, height: this.#ui.clientHeight };
    if (size.width > 0 && size.height > 0) this.#size = size;
    return size;
  }

  /** Hosts in their layers in opening order; elements move only when the order changed. */
  #arrange(hosts: readonly PanelHost[]): void {
    for (const layer of ['hud', 'menu', 'overlay'] as const) {
      const container = this.#layers[layer];
      const want = hosts.filter((h) => h.layer === layer).map((h) => h.element);
      const have = [...container.children];
      if (want.length === have.length && want.every((el, i) => el === have[i])) continue;
      for (const el of want) container.append(el);
    }
  }

  // ── Focus and keys ────────────────────────────────────────────────────────────

  #top(): PanelHost | undefined {
    for (let i = this.#order.length - 1; i >= 0; i--) if (this.#order[i]!.modal) return this.#order[i];
    return undefined;
  }

  /** Hosts whose shortcuts and navigation are live: the top modal, else every panel (topmost first). */
  #live(): PanelHost[] {
    const top = this.#top();
    if (top !== undefined) return this.#order.filter((h) => h.panel === top.panel).reverse();
    return [...this.#order].reverse();
  }

  #actions(host: PanelHost): HTMLElement[] {
    return [...host.root.querySelectorAll<HTMLElement>('[data-action]')].filter((el) => host.binding.isAction(el)
      && el.getAttribute('aria-disabled') === null && !el.hasAttribute('disabled')
      && (typeof el.checkVisibility !== 'function' || el.checkVisibility()));
  }

  #focusTopModal(): void {
    const top = this.#top();
    const key = top?.key ?? null;
    if (key === this.#topModal) return;
    this.#topModal = key;
    if (top === undefined) return;
    if (top.frame !== null) top.frame.focus();
    // Focus without the ring: opening a modal is not keyboard navigation (the old engine showed
    // none); arrows, Tab and the d-pad then move a visible focus (#move).
    else this.#actions(top)[0]?.focus(QUIET_FOCUS);
  }

  /** The panel host holding keyboard focus, and the focused element in it. */
  #focused(): { host: PanelHost; element: HTMLElement } | undefined {
    for (const host of this.#hosts.values()) {
      const active = host.root.activeElement as HTMLElement | null;
      if (active !== null) return { host, element: active };
    }
    return undefined;
  }

  #move(host: PanelHost, step: 1 | -1): void {
    const actions = this.#actions(host);
    if (actions.length === 0) return;
    const at = actions.indexOf(host.root.activeElement as HTMLElement);
    const next = at < 0 ? (step > 0 ? 0 : actions.length - 1) : (at + step + actions.length) % actions.length;
    actions[next]!.focus(VISIBLE_FOCUS);
  }

  #activate(host: PanelHost, element: HTMLElement): boolean {
    const target = host.binding.target([element]);
    if (target === undefined) return false;
    this.#clicks.push({ panel: host.panel, action: target.action, data: target.data, seat: host.seat });
    return true;
  }

  #key(e: KeyboardEvent): void {
    if (this.#capturing || this.#suspended) return;
    if (this.#claimed.swallow(e)) return;
    const origin = e.composedPath()[0];
    // The virtual cursor's open select list handles its own keys.
    if ((origin as Element | undefined)?.closest?.('[data-parallax-select]') != null) return;
    if (isEditable(origin) && this.#ui.contains(e.target as Node)) {
      e.stopPropagation(); // typing in a panel field is not game input
      return;
    }
    if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      for (const host of this.#live()) {
        const target = host.binding.shortcut(e.code);
        if (target === undefined) continue;
        this.#clicks.push({ panel: host.panel, action: target.action, data: target.data, seat: host.seat });
        this.#claimed.claim(e); // not also a toggle_with / action press once the panel closes
        return;
      }
    }
    const focused = this.#focused();
    const top = this.#top();
    const scope = top ?? focused?.host;
    if (scope === undefined) return;
    const handled = ((): boolean => {
      switch (e.code) {
        case 'Enter': case 'NumpadEnter': case 'Space':
          return focused !== undefined && !e.repeat && this.#activate(focused.host, focused.element);
        case 'ArrowDown': case 'ArrowRight':
          if (top === undefined) return false;
          this.#move(scope, 1);
          return true;
        case 'ArrowUp': case 'ArrowLeft':
          if (top === undefined) return false;
          this.#move(scope, -1);
          return true;
        case 'Tab':
          this.#move(scope, e.shiftKey ? -1 : 1);
          return true;
        default:
          return false;
      }
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** While a modal is open: d-pad moves focus, south activates (edges only). */
  #pollPads(): void {
    const top = this.#top();
    const held = new Set<number>();
    for (const pad of this.#gamepads()) {
      if (pad === null || !pad.connected || pad.mapping !== 'standard') continue;
      for (const index of Object.values(PAD)) if (pad.buttons[index]?.pressed === true) held.add(index);
    }
    const pressed = [...held].filter((b) => !this.#padHeld.has(b));
    this.#padHeld = held;
    if (top === undefined || this.#capturing) return;
    for (const button of pressed) {
      if (button === PAD.down || button === PAD.right) this.#move(top, 1);
      else if (button === PAD.up || button === PAD.left) this.#move(top, -1);
      else if (button === PAD.south) {
        const active = top.root.activeElement as HTMLElement | null;
        if (active === null || !this.#activate(top, active)) this.#move(top, 1);
      }
    }
  }

  // ── Feedback ──────────────────────────────────────────────────────────────────

  #area(viewport: UiRect): { element: HTMLElement; toasts: HTMLElement; announce: Element | null } {
    const key = rectKey(viewport);
    let area = this.#areas.get(key);
    if (area === undefined) {
      const element = this.#doc.createElement('div');
      element.className = 'area';
      place(element, viewport);
      const toasts = this.#doc.createElement('div');
      toasts.className = 'toasts';
      element.append(toasts);
      this.#feedback.append(element);
      area = { element, toasts, announce: null };
      this.#areas.set(key, area);
    }
    return area;
  }

  #text(className: string, text: string): HTMLElement {
    const el = this.#doc.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
  }

  #effects(frame: UiFrame): void {
    const now = frame.time;
    this.#timed = this.#timed.filter((t) => {
      if (t.until <= now) {
        t.element.remove();
        return false;
      }
      if (t.until - now < 0.25) t.element.classList.add('leaving');
      return true;
    });
    if (frame.effects.length > 0) this.#loadTheme();
    for (const effect of frame.effects) this.#effect(effect, now, frame);

    const seen = new Set<number>();
    for (const label of frame.labels) {
      seen.add(label.key);
      let el = this.#labels.get(label.key);
      if (el === undefined) {
        el = this.#text(label.kind === undefined ? 'label' : `label ${label.kind}`, label.text);
        this.#floats.append(el);
        this.#labels.set(label.key, el);
      }
      if (el.textContent !== label.text) el.textContent = label.text;
      el.style.left = `${label.at[0] * 100}%`;
      el.style.top = `${label.at[1] * 100}%`;
    }
    for (const [key, el] of this.#labels) {
      if (!seen.has(key)) {
        el.remove();
        this.#labels.delete(key);
      }
    }
  }

  /**
   * The game's look for toasts and announcements: `ui/feedback.html`, compiled like a panel. Its
   * styles (inline or linked, fonts included) style the feedback layer — `.toast`, `.announce`,
   * `.title`, `.subtitle`, `.float`, `.label` — and a `<template data-feedback="toast">` /
   * `"announce"` replaces that item's markup, bound like a panel to {text} / {title, subtitle}.
   */
  #loadTheme(): void {
    if (this.#theme !== undefined) return;
    this.#theme = null;
    if (!this.#files.list().includes(FEEDBACK_THEME)) return;
    const compiled = this.#compile(FEEDBACK_THEME);
    registerPanelFonts(this.#doc, compiled.faces);
    this.#feedback.append(this.#style(compiled.css));
    const templates = new Map<string, readonly MarkupNode[]>();
    const visit = (nodes: readonly MarkupNode[]): void => {
      for (const node of nodes) {
        if (node.kind !== 'element') continue;
        const kind = node.tag === 'template' ? node.attrs.find(([n]) => n === 'data-feedback')?.[1] : undefined;
        if (kind !== undefined) templates.set(kind, node.children);
        else visit(node.children);
      }
    };
    visit(compiled.nodes);
    this.#theme = { templates, families: compiled.families };
  }

  /** A themed item: the template built and bound to `state`, in a wrapper the layer times out. */
  #themed(kind: 'toast' | 'announce', state: Record<string, unknown>, frame: UiFrame): HTMLElement | undefined {
    const nodes = this.#theme?.templates.get(kind);
    if (nodes === undefined) return undefined;
    const el = this.#doc.createElement('div');
    el.className = `${kind}-themed`;
    const families = this.#theme!.families;
    const binding = new PanelBinding(this.#doc as unknown as DomDocument, nodes, el as unknown as DomParent, {
      url: urlResolver(folderOf(FEEDBACK_THEME), this.#url),
      style: (css) => renameFontFamilies(inlineStyle(css, folderOf(FEEDBACK_THEME), this.#url), families),
    });
    binding.update({ state, values: frame.values, strings: frame.strings, enabled: {} });
    return el;
  }

  #effect(effect: UiEffect, now: number, frame: UiFrame): void {
    switch (effect.kind) {
      case 'toast': {
        const el = this.#themed('toast', { text: effect.text }, frame) ?? this.#text('toast', effect.text);
        this.#area(effect.viewport).toasts.append(el);
        this.#timed.push({ element: el, until: now + effect.seconds });
        return;
      }
      case 'announce': {
        const area = this.#area(effect.viewport);
        area.announce?.remove();
        let el = this.#themed('announce', { title: effect.title, subtitle: effect.subtitle }, frame);
        if (el === undefined) {
          el = this.#doc.createElement('div');
          el.className = 'announce';
          el.append(this.#text('title', effect.title));
          if (effect.subtitle !== null) el.append(this.#text('subtitle', effect.subtitle));
        }
        area.element.append(el);
        area.announce = el;
        this.#timed.push({ element: el, until: now + effect.seconds });
        return;
      }
      case 'float_text': {
        const style = effect.style;
        const el = this.#text(style === undefined ? 'float' : 'float styled', effect.text);
        el.style.left = `${effect.at[0] * 100}%`;
        el.style.top = `${effect.at[1] * 100}%`;
        const fill = effect.color ?? style?.color ?? null;
        if (fill !== null) el.style.color = cssRgba(fill);
        if (style !== undefined) applyFloatStyle(el, style);
        this.#floats.append(el);
        this.#timed.push({ element: el, until: now + (style?.seconds ?? FLOAT_SECONDS) });
      }
    }
  }
}
