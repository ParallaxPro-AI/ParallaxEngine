/**
 * A panel's own `@font-face` rules. A non-scripted panel draws in a shadow root, and
 * Chromium ignores `@font-face` declared inside one, so a template's font would silently
 * fall back. The surface lifts each panel's faces out of its CSS and declares them once on
 * the page's document (`registerPanelFonts`), where shadow roots see them.
 *
 * Document-level families are shared by every panel, so a panel can't be allowed to
 * redefine another's (or the engine's `Inter`): each declared family is renamed to
 * `<family>__pp<hash>`, the hash taken over that family's faces in the panel (their
 * descriptors and sources). Two panels that declare the same family the same way share
 * one registration; two that declare it differently get two names. References to the
 * family in the panel's `font-family` / `font` declarations and custom properties
 * (`--title-font: 'Orbitron', serif`), and in its inline styles, are renamed to match.
 * Families the panel doesn't declare (`system-ui`, the engine's `Inter`) are untouched.
 */

import type { MarkupNode } from './markup.js';

export interface PanelFonts {
  /** The panel's CSS without its `@font-face` rules, its family references renamed. */
  readonly css: string;
  /** The renamed `@font-face` rules ('' when the panel declares none). */
  readonly faces: string;
  /** Declared family (lower case) → the name it was registered under. */
  readonly families: ReadonlyMap<string, string>;
}

const FACE = /@font-face\s*\{[^{}]*\}/gi;
const FAMILY = /font-family\s*:\s*([^;}]*)/i;
/** Declarations whose values name font families. */
const DECLARATION = /((?:^|[;{\s])(?:font-family|font|--[\w-]+)\s*:)([^;{}]*)/gi;

function unquote(value: string): string {
  const v = value.trim();
  return /^(["']).*\1$/s.test(v) ? v.slice(1, -1).trim() : v.replace(/\s+/g, ' ');
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `value` (a declaration's value) with each declared family renamed. */
function renameIn(value: string, families: ReadonlyMap<string, string>): string {
  let out = value;
  for (const [family, scoped] of families) {
    const name = escapeRegExp(family).replace(/ /g, '\\s+');
    out = out
      .replace(new RegExp(`(["'])\\s*${name}\\s*\\1`, 'gi'), `"${scoped}"`)
      // A bare family name: a whole comma-separated item (or the `font` shorthand's family, after a size).
      .replace(new RegExp(`(^|[\\s,])${name}(?=\\s*(?:,|!|$))`, 'gi'), `$1"${scoped}"`);
  }
  return out;
}

/** References to declared families in `css` (declarations or an inline style) renamed. */
export function renameFontFamilies(css: string, families: ReadonlyMap<string, string>): string {
  if (families.size === 0) return css;
  return css.replace(DECLARATION, (_whole, head: string, value: string) => head + renameIn(value, families));
}

/** A panel's CSS split into its renamed `@font-face` rules and the rest. */
export function scopePanelFonts(css: string): PanelFonts {
  const faces: { family: string; rule: string }[] = [];
  const rest = css.replace(FACE, (rule) => {
    const match = FAMILY.exec(rule);
    const family = match === null ? '' : unquote(match[1]!);
    if (family !== '') faces.push({ family, rule });
    return '';
  });
  if (faces.length === 0) return { css, faces: '', families: new Map() };
  const byFamily = new Map<string, string[]>();
  for (const f of faces) {
    const key = f.family.toLowerCase();
    byFamily.set(key, [...(byFamily.get(key) ?? []), f.rule.replace(/\s+/g, ' ')]);
  }
  const families = new Map<string, string>();
  for (const [key, rules] of byFamily) {
    const original = faces.find((f) => f.family.toLowerCase() === key)!.family;
    families.set(key, `${original.replace(/["'\\]/g, '')}__pp${hash(`${key}\n${rules.join('\n')}`)}`);
  }
  const renamed = faces.map((f) => f.rule.replace(FAMILY, `font-family: "${families.get(f.family.toLowerCase())}"`));
  return { css: renameFontFamilies(rest, families), faces: renamed.join('\n'), families };
}

const STYLE_ID = 'parallax-panel-fonts';
const registered = new WeakMap<Document, Set<string>>();
/** Per document: declared family (lower case) → the first name it was registered under. */
const families = new WeakMap<Document, Map<string, string>>();
const SCOPED = /font-family\s*:\s*"([^"]+)__pp[0-9a-z]+"/i;

/** Declare a panel's (renamed) `@font-face` rules on the page's document, each rule once. */
export function registerPanelFonts(doc: Document, faces: string): void {
  if (faces === '') return;
  let seen = registered.get(doc);
  if (seen === undefined) {
    seen = new Set();
    registered.set(doc, seen);
  }
  const fresh = (faces.match(FACE) ?? []).filter((rule) => !seen.has(rule));
  if (fresh.length === 0) return;
  let names = families.get(doc);
  if (names === undefined) {
    names = new Map();
    families.set(doc, names);
  }
  for (const rule of fresh) {
    seen.add(rule);
    const scoped = /font-family\s*:\s*"([^"]+)"/i.exec(rule)?.[1];
    const family = SCOPED.exec(rule)?.[1];
    if (scoped !== undefined && family !== undefined && !names.has(family.toLowerCase())) names.set(family.toLowerCase(), scoped);
  }
  let style = doc.getElementById(STYLE_ID);
  if (style === null) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    (doc.head ?? doc.documentElement).append(style);
  }
  style.textContent = `${style.textContent ?? ''}${fresh.join('\n')}\n`;
}

/**
 * A CSS font-family list (`"Bangers", sans-serif`) as it draws on this page: each family a
 * panel has declared with `@font-face` (and that panel has been shown) renamed to its
 * registered name; other families as written. For the engine's own layers outside panels
 * (the touch controls' `TouchSkin.font`).
 */
export function resolvePanelFonts(doc: Document, list: string): string {
  const names = families.get(doc);
  return names === undefined || names.size === 0 ? list : renameIn(list, names);
}

/** Markup with each `style` attribute's references to declared families renamed. */
export function renameNodeFonts(nodes: MarkupNode[], families: ReadonlyMap<string, string>): MarkupNode[] {
  if (families.size === 0) return nodes;
  return nodes.map((node) => (node.kind === 'text' ? node : {
    ...node,
    attrs: node.attrs.map(([name, value]) => [name, name === 'style' ? renameFontFamilies(value, families) : value] as const),
    children: renameNodeFonts(node.children, families),
  }));
}
