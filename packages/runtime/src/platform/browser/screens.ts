/**
 * The browser's screen surface (core `ScreenSurface`): each in-world screen's panel is
 * built with the same markup pipeline and bindings as HUD panels (ui/markup.ts,
 * ui/binding.ts), in a host element kept out of view but laid out at the screen's texel
 * size — its live layout answers hit tests. When a screen is due, that layout is painted
 * into the screen's canvas (screens_paint.ts), registered in `SCREEN_TARGETS` under the
 * screen's target name with a rising version; the render3d surface uploads a target's
 * canvas when its version changes.
 *
 * Panel scripts don't run on screens (PP3335). Styles apply as on the HUD, with `:host`
 * meaning the screen's root; the painter draws flat styling (see screens_paint.ts).
 */

import { fail } from '../../core/index.js';
import type { ProjectFiles, ScreenFrame, ScreenHit, ScreenSurface, ScreensFrame } from '../../core/index.js';
import { PanelBinding } from './ui/binding.js';
import { BUILTIN_PANELS, DEFAULT_PANEL_CSS } from './ui/builtins.js';
import { inlineStyle, scopeCss } from './ui/css.js';
import type { DomDocument, DomParent } from './ui/dom.js';
import { expandTemplates, folderOf, parseMarkup, projectPath, sanitizePanel, urlResolver } from './ui/markup.js';
import { paintDom } from './screens_paint.js';
import { VIEW_CONTAINER_STYLE } from './ui/viewport.js';
import type { MarkupNode } from './ui/markup.js';

/** Rendered screen images by target name; render3d's surface reads them. */
export const SCREEN_TARGETS = new Map<string, { readonly canvas: HTMLCanvasElement; version: number }>();

const ROOT_CLASS = 'pp-screen-root';

export interface DomScreenOptions {
  readonly files: ProjectFiles;
  /** A project path's URL on the page. */
  readonly url: (path: string) => string;
  /** Where the hidden layout hosts live (default `document.body`). */
  readonly parent?: HTMLElement;
}

interface Host {
  readonly target: string;
  readonly element: HTMLElement;
  readonly root: HTMLElement;
  readonly binding: PanelBinding;
  readonly html: string;
  width: number;
  height: number;
}

export class DomScreenSurface implements ScreenSurface {
  readonly #files: ProjectFiles;
  readonly #url: (path: string) => string;
  readonly #parent: HTMLElement;
  readonly #hosts = new Map<string, Host>();
  readonly #compiled = new Map<string, { nodes: MarkupNode[]; css: string }>();

  constructor(options: DomScreenOptions) {
    this.#files = options.files;
    this.#url = options.url;
    this.#parent = options.parent ?? document.body;
  }

  #compile(html: string): { nodes: MarkupNode[]; css: string } {
    const cached = this.#compiled.get(html);
    if (cached !== undefined) return cached;
    const has = (path: string): boolean => this.#files.list().includes(path);
    const read = (path: string): string | undefined => (has(path) ? this.#files.read(path) : undefined);
    const builtin = BUILTIN_PANELS[html];
    const source = builtin ?? read(html);
    if (source === undefined) fail('PP2072', `Panel markup "${html}" does not exist`, { path: html, fix: `Create ${html}, or fix the @ui html= path.` });
    const folder = builtin !== undefined ? '' : folderOf(html);
    const expanded = expandTemplates(parseMarkup(source), read, (missing) => {
      fail('PP2072', `Template file "${missing}" does not exist`, { path: html, fix: `Create ${missing} (a project path), or fix <template src>.` });
    });
    const panel = sanitizePanel(expanded, urlResolver(folder, this.#url), (css) => inlineStyle(css, folder, this.#url));
    if (panel.scripts.length > 0) {
      fail('PP3335', `Panel ${html} has a <script>; panels on in-world screens can't run scripts`, { path: html, fix: 'Show a script-free panel on the screen (bindings and actions work).' });
    }
    const files = { read, url: this.#url };
    const css = panel.styles.map((style) => {
      if (style.kind === 'inline') return scopeCss(style.css, folder, files);
      const path = projectPath(folder, style.path);
      const text = path === undefined ? undefined : read(path);
      if (path === undefined || text === undefined) fail('PP2072', `Stylesheet "${style.path}" (linked from ${html}) does not exist in the project`, { path: html });
      return scopeCss(text, folderOf(path), files, new Set([path]));
    }).join('\n');
    const compiled = { nodes: panel.nodes, css };
    this.#compiled.set(html, compiled);
    return compiled;
  }

  #host(screen: ScreenFrame): Host {
    let host = this.#hosts.get(screen.target);
    if (host !== undefined && host.html === screen.panel.html) return host;
    host?.element.remove();
    const compiled = this.#compile(screen.panel.html);
    const element = document.createElement('div');
    element.dataset['screen'] = screen.target;
    Object.assign(element.style, {
      position: 'fixed', left: '-100000px', top: '0', overflow: 'hidden', pointerEvents: 'none', contain: 'layout paint',
      container: VIEW_CONTAINER_STYLE, // viewport units measure the screen (ui/viewport.ts)
    });
    const root = document.createElement('div');
    root.className = ROOT_CLASS;
    Object.assign(root.style, { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' });
    const css = `.${ROOT_CLASS} { background: #000; }\n${(DEFAULT_PANEL_CSS + '\n' + compiled.css).replaceAll(':host', `.${ROOT_CLASS}`)}`;
    const style = document.createElement('style');
    style.textContent = css;
    element.append(style, root);
    this.#parent.append(element);
    const folder = screen.panel.html.startsWith('builtin:') ? '' : folderOf(screen.panel.html);
    const binding = new PanelBinding(document as unknown as DomDocument, compiled.nodes, root as unknown as DomParent, {
      url: urlResolver(folder, this.#url),
      style: (value) => inlineStyle(value, folder, this.#url),
    });
    const canvas = SCREEN_TARGETS.get(screen.target)?.canvas ?? document.createElement('canvas');
    if (!SCREEN_TARGETS.has(screen.target)) SCREEN_TARGETS.set(screen.target, { canvas, version: 0 });
    host = { target: screen.target, element, root, binding, html: screen.panel.html, width: 0, height: 0 };
    this.#hosts.set(screen.target, host);
    return host;
  }

  present(frame: ScreensFrame): void {
    const seen = new Set<string>();
    for (const screen of frame.screens) {
      seen.add(screen.target);
      const host = this.#host(screen);
      if (host.width !== screen.width || host.height !== screen.height) {
        host.width = screen.width;
        host.height = screen.height;
        Object.assign(host.element.style, { width: `${screen.width}px`, height: `${screen.height}px` });
        const canvas = SCREEN_TARGETS.get(screen.target)!.canvas;
        canvas.width = screen.width;
        canvas.height = screen.height;
      }
      host.binding.update({ state: screen.panel.state, values: frame.values, strings: frame.strings, enabled: screen.panel.enabled });
      if (screen.due) this.#raster(host);
    }
    for (const [target, host] of this.#hosts) {
      if (seen.has(target)) continue;
      host.element.remove();
      this.#hosts.delete(target);
      SCREEN_TARGETS.delete(target);
    }
  }

  /** Paint the host's laid-out DOM into its canvas. */
  #raster(host: Host): void {
    const entry = SCREEN_TARGETS.get(host.target);
    if (entry === undefined) return;
    paintDom(host.root, entry.canvas, '#000');
    entry.version++;
  }

  hit(target: string, x: number, y: number): ScreenHit | null {
    const host = this.#hosts.get(target);
    if (host === undefined) return null;
    const origin = host.root.getBoundingClientRect();
    let found: ScreenHit | null = null;
    // The last action in document order that contains the point is the one drawn on top.
    for (const element of host.root.querySelectorAll<HTMLElement>('[data-action]')) {
      if (!host.binding.isAction(element)) continue;
      const r = element.getBoundingClientRect();
      const lx = r.left - origin.left;
      const ly = r.top - origin.top;
      if (x < lx || x >= lx + r.width || y < ly || y >= ly + r.height) continue;
      const sent = host.binding.target([element]);
      if (sent !== undefined) found = { action: sent.action, data: sent.data };
    }
    return found;
  }

  dispose(): void {
    for (const host of this.#hosts.values()) host.element.remove();
    for (const target of this.#hosts.keys()) SCREEN_TARGETS.delete(target);
    this.#hosts.clear();
  }
}

