/**
 * Panel markup, read and made safe before anything reaches the page. Game HTML is treated
 * as untrusted: it is parsed here (never handed to `innerHTML`), and only the panel
 * contract survives — elements, text, the `data-*` binding vocabulary, styles. Scripts,
 * frames, inline handlers, `javascript:` and off-project URLs are dropped.
 *
 * Panel JavaScript (DESIGN §4.12, §7.3) never runs in the page: `<script>` elements are
 * taken out of the markup here and listed (`SanitizedPanel.scripts`); the surface runs a
 * panel that has any in a sandboxed frame (`frame_host.ts`) whose only bridge is
 * `parallax.on_state(fn)` and `parallax.action(name, payload)`.
 */

import { remoteAssetUrl } from '../../../core/index.js';

export type MarkupNode = MarkupElement | MarkupText;

export interface MarkupElement {
  readonly kind: 'element';
  readonly tag: string;
  readonly attrs: readonly (readonly [name: string, value: string])[];
  readonly children: MarkupNode[];
}

export interface MarkupText {
  readonly kind: 'text';
  readonly text: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', hellip: '…',
  mdash: '—', ndash: '–', copy: '©', bull: '•', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Parse panel markup into a tree (tolerant: unclosed elements close with their parent). */
export function parseMarkup(source: string): MarkupNode[] {
  const root: MarkupElement = { kind: 'element', tag: '#root', attrs: [], children: [] };
  const stack: MarkupElement[] = [root];
  const top = (): MarkupElement => stack[stack.length - 1]!;
  const text = (t: string): void => {
    if (t !== '') top().children.push({ kind: 'text', text: decodeEntities(t) });
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      text(source.slice(i));
      break;
    }
    text(source.slice(i, lt));
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
      const end = source.indexOf('>', i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      const name = source.slice(i + 2, end === -1 ? source.length : end).trim().toLowerCase();
      i = end === -1 ? source.length : end + 1;
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const match = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(i, i + 64));
    if (match === null) {
      text('<');
      i++;
      continue;
    }
    const tag = match[1]!.toLowerCase();
    let end = i + match[0].length;
    let quote: string | null = null;
    while (end < source.length) {
      const ch = source[end]!;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      end++;
    }
    const body = source.slice(i + match[0].length, end);
    const attrs: [string, string][] = [];
    for (const attr of body.matchAll(ATTRIBUTE)) {
      const name = attr[1]!.toLowerCase();
      if (attrs.some(([n]) => n === name)) continue;
      attrs.push([name, decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '')]);
    }
    const element: MarkupElement = { kind: 'element', tag, attrs, children: [] };
    top().children.push(element);
    i = Math.min(end + 1, source.length);
    if (RAW_TEXT.has(tag)) {
      const close = source.toLowerCase().indexOf(`</${tag}`, i);
      const raw = source.slice(i, close === -1 ? source.length : close);
      if (raw !== '') element.children.push({ kind: 'text', text: tag === 'textarea' || tag === 'title' ? decodeEntities(raw) : raw });
      const closeEnd = close === -1 ? -1 : source.indexOf('>', close);
      i = closeEnd === -1 ? source.length : closeEnd + 1;
      continue;
    }
    if (!VOID.has(tag) && !body.trimEnd().endsWith('/')) stack.push(element);
  }
  return root.children;
}

// ── Paths ──────────────────────────────────────────────────────────────────────

/** The folder of a project path (`ui/hud.html` → `ui/`). */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

/**
 * A relative reference from a file in `folder` as a project path, or undefined when it is
 * not one: a scheme (`https:`, `javascript:`), protocol-relative, rooted, or above the
 * project root.
 */
export function projectPath(folder: string, ref: string): string | undefined {
  const value = ref.trim();
  if (value === '' || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('\\')) return undefined;
  const clean = value.split(/[?#]/)[0]!;
  const parts: string[] = [];
  for (const part of `${folder}${clean}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

// ── Sanitizing ─────────────────────────────────────────────────────────────────

/** Elements removed with their content. */
const DROPPED = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'title', 'noscript', 'portal', 'link', 'style',
]);
/** Elements replaced by their children. */
const UNWRAPPED = new Set(['html', 'head', 'body']);
/** Attributes holding a URL. */
export const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'poster', 'background', 'action', 'formaction', 'data', 'cite']);
/** Attributes never kept. */
const BLOCKED_ATTRS = new Set(['srcdoc', 'srcset', 'action', 'formaction', 'is', 'ping', 'target', 'http-equiv']);

/** How a sanitized URL attribute resolves: a page URL, or null to drop it. */
export type UrlResolver = (attr: string, value: string, tag: string) => string | null;

/** A panel file made safe: its elements, and the styles it named (in order). */
export interface SanitizedPanel {
  readonly nodes: MarkupNode[];
  /** `<style>` text and `<link rel="stylesheet">` targets, in document order. */
  readonly styles: readonly ({ readonly kind: 'inline'; readonly css: string } | { readonly kind: 'link'; readonly path: string })[];
  /** `<script>` elements in document order: inline code, or a `src` (as written), and whether it is a module. */
  readonly scripts: readonly PanelScript[];
}

export type PanelScript =
  | { readonly kind: 'inline'; readonly code: string; readonly module: boolean }
  | { readonly kind: 'src'; readonly path: string; readonly module: boolean };

/** Script types that are code (anything else, e.g. a JSON data block, is not a script). */
function scriptKind(type: string | undefined): 'classic' | 'module' | null {
  const t = (type ?? '').trim().toLowerCase();
  if (t === '' || t === 'text/javascript' || t === 'application/javascript') return 'classic';
  return t === 'module' ? 'module' : null;
}

/** Whether an attribute name may be set on a panel element at all (also for `data-attr-*` bindings). */
export function attributeAllowed(name: string): boolean {
  return !name.startsWith('on') && !BLOCKED_ATTRS.has(name) && /^[a-z_:][a-z0-9_.:-]*$/.test(name);
}

/**
 * The default resolver: fragments (`#icon-heart`) stay; project-relative paths become
 * URLs through `url`; `data:image/...` stays on images; anything else is dropped.
 */
export function urlResolver(folder: string, url: (projectPath: string) => string): UrlResolver {
  return (attr, value, tag) => {
    const v = value.trim();
    if (v.startsWith('#')) return v;
    if (tag === 'a' || tag === 'form') return null; // a panel never navigates the game page
    if (/^data:image\//i.test(v) && (attr === 'src' || attr === 'href' || attr === 'xlink:href' || attr === 'poster')) return v;
    // A hosted asset (core/remote_assets.ts): the asset store's own URL, the only absolute one a panel may name.
    const hosted = remoteAssetUrl(v);
    if (hosted !== undefined) return hosted;
    const path = projectPath(folder, v);
    if (path === undefined) return null;
    const hash = v.indexOf('#');
    return url(path) + (hash >= 0 ? v.slice(hash) : '');
  };
}

export function sanitizePanel(nodes: readonly MarkupNode[], resolve: UrlResolver, inlineCss: (css: string) => string): SanitizedPanel {
  const styles: SanitizedPanel['styles'][number][] = [];
  const scripts: PanelScript[] = [];
  const clean = (list: readonly MarkupNode[]): MarkupNode[] => {
    const out: MarkupNode[] = [];
    for (const node of list) {
      if (node.kind === 'text') {
        out.push(node);
        continue;
      }
      if (node.tag === 'style') {
        styles.push({ kind: 'inline', css: node.children.map((c) => (c.kind === 'text' ? c.text : '')).join('') });
        continue;
      }
      if (node.tag === 'link') {
        const rel = node.attrs.find(([n]) => n === 'rel')?.[1].toLowerCase().split(/\s+/) ?? [];
        const href = node.attrs.find(([n]) => n === 'href')?.[1];
        if (rel.includes('stylesheet') && href !== undefined) styles.push({ kind: 'link', path: href });
        continue;
      }
      if (node.tag === 'script') {
        const kind = scriptKind(node.attrs.find(([n]) => n === 'type')?.[1]);
        const src = node.attrs.find(([n]) => n === 'src')?.[1];
        if (kind !== null) {
          scripts.push(src !== undefined
            ? { kind: 'src', path: src, module: kind === 'module' }
            : { kind: 'inline', code: node.children.map((c) => (c.kind === 'text' ? c.text : '')).join(''), module: kind === 'module' });
        }
        continue;
      }
      if (DROPPED.has(node.tag)) continue;
      if (UNWRAPPED.has(node.tag)) {
        out.push(...clean(node.children));
        continue;
      }
      const tag = node.tag === 'form' ? 'div' : node.tag;
      const attrs: [string, string][] = [];
      for (const [name, value] of node.attrs) {
        if (!attributeAllowed(name)) continue;
        if (URL_ATTRS.has(name)) {
          const url = resolve(name, value, node.tag);
          if (url !== null) attrs.push([name, url]);
        } else if (name === 'style') {
          attrs.push([name, inlineCss(value)]);
        } else {
          attrs.push([name, value]);
        }
      }
      out.push({ kind: 'element', tag, attrs, children: clean(node.children) });
    }
    return out;
  };
  return { nodes: clean(nodes), styles, scripts };
}

/**
 * `<template src="ui/slot.html">` (a project path): its file's markup becomes the
 * template's content. Missing files are reported through `missing`.
 */
export function expandTemplates(
  nodes: readonly MarkupNode[], read: (path: string) => string | undefined, missing: (path: string) => void, depth = 0,
): MarkupNode[] {
  return nodes.map((node) => {
    if (node.kind === 'text') return node;
    const src = node.tag === 'template' ? node.attrs.find(([n]) => n === 'src')?.[1] : undefined;
    if (src !== undefined && depth < 8) {
      const text = read(src);
      if (text === undefined) {
        missing(src);
        return node;
      }
      return { ...node, attrs: node.attrs.filter(([n]) => n !== 'src'), children: expandTemplates(parseMarkup(text), read, missing, depth + 1) };
    }
    return { ...node, children: expandTemplates(node.children, read, missing, depth) };
  });
}
