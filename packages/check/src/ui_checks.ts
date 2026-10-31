/**
 * Panel markup against its panel: every `data-bind`-style key against what `state()`
 * returns (as far as it is known statically), `data-each` against lists, `data-action`
 * against `actions` (and the payload an event or function action needs), `data-text`
 * against the locale; a scene's `ui` list against panels that open by themselves.
 */

import { closestMatch, UI_ICON_NAMES } from '@parallax/runtime/core';
import type { CheckContext } from './context.js';
import type { PanelAction, PanelDecl, Shape } from './declarations.js';
import { parseHtml } from './html.js';
import type { HtmlElement } from './html.js';

/** Attributes whose value is a state key path. */
const KEY_ATTRS = ['data-bind', 'data-show', 'data-hide'];
const KEY_PREFIXES = ['data-class-', 'data-attr-', 'data-style-'];
/** The binding vocabulary; any other data-* attribute is payload for data-action. */
const VOCABULARY = new Set(['data-bind', 'data-show', 'data-hide', 'data-text', 'data-each', 'data-action', 'data-key',
  'data-format', 'data-max', 'data-count']);
const FORMATS = ['int', 'percent', 'time', 'bar', 'pips'];

interface Scope {
  /** What keys resolve against; undefined = unknown (no errors). */
  readonly shape: Shape | undefined;
  readonly item: boolean;
}

type Lookup = { readonly found: Shape } | { readonly missing: string; readonly known: readonly string[] } | { readonly unknown: true };

function lookup(shape: Shape | undefined, path: string): Lookup {
  let current = shape;
  for (const key of path.split('.')) {
    if (current === undefined || current.kind === 'any') return { unknown: true };
    if (current.kind !== 'object') return { unknown: true };
    const next = current.keys[key];
    if (next === undefined) return current.open ? { unknown: true } : { missing: key, known: Object.keys(current.keys) };
    current = next;
  }
  return current === undefined ? { unknown: true } : { found: current };
}

export function panelHtmlPath(ctx: CheckContext, panel: PanelDecl): string | undefined {
  if (panel.html === undefined) return undefined;
  const local = panel.feature !== null ? `features/${panel.feature}/${panel.html}` : undefined;
  if (local !== undefined && ctx.files.exists(local)) return local;
  return ctx.files.exists(panel.html) ? panel.html : undefined;
}

export function checkUi(ctx: CheckContext): void {
  // A panel that opens by itself can't also be opened by a scene: the runtime fails the
  // scene load on it (ui/engine.ts sceneLoaded). Unknown ids are PP2054 (data checks).
  for (const scene of ctx.project.scenes.values()) {
    scene.ui.forEach((id, i) => {
      const panel = ctx.decl.panels[id];
      if (panel === undefined || !(panel.when || panel.toggle_with !== undefined || panel.while_held !== undefined)) return;
      ctx.report('PP2081', `Scene "${scene.id}" lists panel "${id}" in "ui", but it opens by itself (when= / toggle_with= / while_held=)`, {
        path: scene.path, pointer: `/ui/${i}`, fix: `Remove "${id}" from the scene's "ui" list.`,
      });
    });
  }
  for (const [id, panel] of Object.entries(ctx.decl.panels)) {
    if (panel.html === undefined) continue;
    const path = panelHtmlPath(ctx, panel);
    if (path === undefined) {
      ctx.report('PP2072', `Panel "${id}" html "${panel.html}" does not exist`, {
        path: panel.path, line: panel.line,
        fix: panel.feature !== null ? `Create features/${panel.feature}/${panel.html} (or ${panel.html}).` : `Create ${panel.html}.`,
      });
      continue;
    }
    const root = expandTemplates(ctx, parseHtml(ctx.files.read(path)), path, 0);
    new PanelWalk(ctx, id, panel, path).children(root, { shape: panel.state ?? undefined, item: false });
  }
}

/** `<template src="ui/slot.html">` shares a template file between panels. */
function expandTemplates(ctx: CheckContext, element: HtmlElement, path: string, depth: number): HtmlElement {
  const src = element.tag === 'template' ? element.attrs.get('src') : undefined;
  if (src !== undefined && depth < 8) {
    if (!ctx.files.exists(src)) {
      ctx.report('PP2072', `Template file "${src}" does not exist`, { path, line: element.line });
    } else {
      const included = parseHtml(ctx.files.read(src));
      return { ...element, children: included.children.map((c) => expandTemplates(ctx, c, src, depth + 1)) };
    }
  }
  return { ...element, children: element.children.map((c) => expandTemplates(ctx, c, path, depth)) };
}

class PanelWalk {
  readonly #ctx: CheckContext;
  readonly #id: string;
  readonly #panel: PanelDecl;
  readonly #path: string;

  constructor(ctx: CheckContext, id: string, panel: PanelDecl, path: string) {
    this.#ctx = ctx;
    this.#id = id;
    this.#panel = panel;
    this.#path = path;
  }

  children(element: HtmlElement, scope: Scope): void {
    for (const child of element.children) this.element(child, scope);
  }

  element(element: HtmlElement, scope: Scope): void {
    if (element.tag === 'icon') this.icon(element);
    for (const [name, value] of element.attrs) {
      if (KEY_ATTRS.includes(name) || KEY_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length)) {
        this.key(name, value, element, scope);
      } else if (name === 'data-max' && !/^\d+(\.\d+)?$/.test(value)) {
        this.key(name, value, element, scope);
      } else if (name === 'data-text') {
        this.text(value, element, scope);
      } else if (name === 'data-count' && !(/^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 10)) {
        this.#report('PP2075', `data-count="${value}" must be the seconds a number takes to count to a new value (0..10)`, element, 'e.g. data-count="0.6" next to data-bind="score".');
      } else if (name === 'data-count' && !element.attrs.has('data-bind')) {
        this.#report('PP2075', 'data-count counts a bound number: it needs data-bind on the same element', element, 'e.g. <b data-bind="score" data-count="0.6"></b>.');
      } else if (name === 'data-format' && !FORMATS.includes(value)) {
        this.#report('PP2075', `Unknown data-format "${value}"`, element, `Formats: ${FORMATS.join(', ')}.`);
      } else if (name === 'data-action') {
        this.action(value, element, scope);
      } else if (name === 'data-key' && value.split(/[\s,]+/).includes('Escape')) {
        // The browser takes Escape to release the cursor lock, so a game can't rely on it.
        this.#report('PP2078', 'data-key="Escape": the browser takes Escape to release the cursor lock', element, 'Use data-key="KeyP" for pause and menus.');
      }
    }
    const each = element.attrs.get('data-each');
    if (each === undefined) {
      this.children(element, scope);
      return;
    }
    const found = this.key('data-each', each, element, scope);
    let item: Shape | undefined;
    if (found !== undefined && found.kind === 'list') item = found.item;
    else if (found !== undefined && found.kind !== 'any') {
      this.#report('PP2073', `data-each="${each}" is not a list in ${this.#id}.state()`, element, 'data-each repeats over a list of items.');
    }
    const templates = element.children.filter((c) => c.tag === 'template');
    if (templates.length === 0) {
      this.#report('PP2076', `data-each="${each}" has no <template> child`, element, 'Put the markup for one item in a <template> inside it.');
    }
    for (const child of element.children) {
      if (child.tag === 'template') this.children(child, { shape: item, item: true });
      else this.element(child, scope);
    }
  }

  #report(code: `PP${number}`, message: string, element: HtmlElement, fix?: string): void {
    this.#ctx.report(code, message, { path: this.#path, line: element.line, ...(fix !== undefined && { fix }) });
  }

  /** `<icon name="...">` names one of the engine's built-in icons. */
  icon(element: HtmlElement): void {
    const name = (element.attrs.get('name') ?? '').trim();
    if (UI_ICON_NAMES.includes(name)) return;
    const near = name === '' ? undefined : closestMatch(name, UI_ICON_NAMES);
    this.#report('PP2077', name === '' ? '<icon> has no name' : `Unknown icon "${name}"`, element,
      near !== undefined ? `Did you mean "${near}"?` : `Built-in icons: ${UI_ICON_NAMES.join(', ')}.`);
  }

  key(attr: string, path: string, element: HtmlElement, scope: Scope): Shape | undefined {
    if (path === '') {
      this.#report('PP2070', `${attr} is empty`, element);
      return undefined;
    }
    const result = lookup(scope.shape, path);
    if ('found' in result) return result.found;
    if ('missing' in result) {
      const where = scope.item ? 'the data-each item' : `${this.#id}.state()`;
      const guess = closestMatch(result.missing, result.known);
      this.#report('PP2070', `${attr}="${path}": "${result.missing}" is not a key of ${where}`, element,
        guess !== undefined ? `Did you mean "${guess}"?` : `Keys: ${result.known.join(', ') || '(none)'}.`);
    }
    return undefined;
  }

  text(key: string, element: HtmlElement, scope: Scope): void {
    if (this.#ctx.textKeys.has(key)) return;
    const inState = 'found' in lookup(scope.shape, key);
    const guess = closestMatch(key, this.#ctx.sourceKeys);
    this.#report('PP2062', `data-text="${key}" is not a key of locale/en.json`, element,
      inState ? `"${key}" is a state key: use data-bind="${key}" to show it, or add the text to locale/en.json.`
        : guess !== undefined ? `Did you mean "${guess}"?` : `Add "${key}" to locale/en.json.`);
  }

  action(name: string, element: HtmlElement, scope: Scope): void {
    const action = this.#panel.actions[name];
    if (action === undefined) {
      if (this.#panel.actions_dynamic === true) return;
      const known = Object.keys(this.#panel.actions);
      const guess = closestMatch(name, known);
      this.#report('PP2071', `data-action="${name}" is not an action of panel "${this.#id}"`, element,
        guess !== undefined ? `Did you mean "${guess}"?` : known.length > 0 ? `Actions: ${known.join(', ')}.` : `Add "${name}" to ${this.#panel.name}.actions.`);
      return;
    }
    const required = this.#required(action);
    if (required.length === 0) return;
    const payload = new Set<string>();
    for (const attr of element.attrs.keys()) {
      if (attr.startsWith('data-') && !VOCABULARY.has(attr) && !KEY_PREFIXES.some((p) => attr.startsWith(p))) {
        payload.add(attr.slice(5).replaceAll('-', '_'));
      }
    }
    if (scope.item) {
      if (scope.shape === undefined || scope.shape.kind !== 'object' || scope.shape.open) return;
      for (const key of Object.keys(scope.shape.keys)) payload.add(key);
    }
    const missing = required.filter((r) => !payload.has(r));
    if (missing.length > 0) {
      this.#report('PP2074', `data-action="${name}" sends no ${missing.map((m) => `"${m}"`).join(', ')}`, element,
        scope.item ? `Add ${missing.join(', ')} to each "${name}" item in state(), or data-${missing[0]!.replaceAll('_', '-')}="..." on the element.`
          : `Add data-${missing[0]!.replaceAll('_', '-')}="..." on the element.`);
    }
  }

  #required(action: PanelAction): readonly string[] {
    if (action.kind === 'event') {
      const event = this.#ctx.decl.events[action.event];
      if (event === undefined) return [];
      return Object.entries(event.fields).filter(([, s]) => !('default' in s) && s.runtime_only !== true && s.default_expr === undefined)
        .map(([n]) => n);
    }
    if (action.kind === 'function' || action.kind === 'rpc') return action.required ?? [];
    return [];
  }
}
