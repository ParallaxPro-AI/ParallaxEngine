/**
 * Panel binding: sanitized markup built into elements once, then bound to the panel's
 * state every frame with the least DOM work — each binding remembers what it last wrote
 * and touches the element only when that changes; `data-each` keeps one copy of its
 * template per item (by position) and only adds or removes copies at the end.
 *
 * The vocabulary (sdk `Panel`, DESIGN §4.12; `check`'s `ui_checks.ts` holds the static rules):
 *
 *   data-bind="a.b"        text content (dotted path), shown with the game language's `str()`
 *   data-format=           int | percent (0..1) | time (seconds → m:ss) | bar (0..1 fill) |
 *                          pips (`value` of `data-max` filled; data-max is a number or a path)
 *   data-count="0.6"       with data-bind: a number counts to each new value over that many
 *                          seconds (eased out; whole numbers stay whole) — score count-ups
 *   data-text="key"        the locale string (`locale/<lang>.json`)
 *   data-show / data-hide  shown while truthy / falsy (the game language's truthiness)
 *   data-class-<c>         class <c> while truthy
 *   data-attr-<a>          attribute <a>: removed for None/False, empty for True, else the text
 *   data-style-<p>         style property <p>
 *   data-each="list"       one copy of the child <template> per item; paths inside are the item's
 *   data-action="name"     a click sends the action; the payload is the enclosing data-each
 *                          item's fields, then the element's own `data-*` attributes
 *                          (`data-level-id` → `level_id`, as strings — the engine parses
 *                          them toward the parameter's type), exactly what a headless
 *                          `game.click(panel, name, **data)` passes
 *   data-key="Digit1"      a keyboard shortcut for the element's action; `{index1}` /
 *                          `{index}` inside data-each is the item's 1- / 0-based position
 */

import type { UiValueRules } from '../../../core/index.js';
import { attributeAllowed, URL_ATTRS } from './markup.js';
import type { MarkupElement, MarkupNode, UrlResolver } from './markup.js';
import type { DomDocument, DomElement, DomNode, DomParent } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';

/** `data-*` names that are binding vocabulary, never payload. */
const VOCABULARY = new Set(['data-bind', 'data-show', 'data-hide', 'data-text', 'data-each', 'data-action', 'data-key', 'data-format', 'data-max', 'data-count']);
const PREFIXES = ['data-class-', 'data-attr-', 'data-style-'] as const;

export interface BindFrame {
  readonly state: Readonly<Record<string, unknown>>;
  readonly values: UiValueRules;
  readonly strings: Readonly<Record<string, string>>;
  /** Function actions with `when=`: false while disabled. */
  readonly enabled: Readonly<Record<string, boolean>>;
  /** Seconds (the frame's clock) for `data-count`; absent: the page's clock. */
  readonly time?: number;
}

/** What a click on an element sends. */
export interface PanelTarget {
  readonly action: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface BinderOptions {
  /** A URL attribute's value from a binding: its page URL, or null to drop it. */
  readonly url: UrlResolver;
  /** An inline style from a binding, made safe. */
  readonly style: (css: string) => string;
}

// ── Values ─────────────────────────────────────────────────────────────────────

/** A game-language dict (compiled Python's `dict`): `__getitem__` / `__contains__`, iterating its keys. */
interface DictLike {
  __getitem__(key: unknown): unknown;
  __contains__(key: unknown): boolean;
  [Symbol.iterator](): Iterator<unknown>;
}

function isDictLike(value: unknown): value is DictLike {
  const v = value as Partial<DictLike> | null;
  return typeof v === 'object' && v !== null && typeof v.__getitem__ === 'function' && typeof v.__contains__ === 'function'
    && typeof v[Symbol.iterator] === 'function';
}

/** A dotted path in `data` (objects, Maps, dicts); undefined when any step is missing. */
export function resolvePath(data: unknown, path: string): unknown {
  let current = data;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (current instanceof Map) current = current.get(key);
    else if (isDictLike(current)) current = current.__contains__(key) ? current.__getitem__(key) : undefined;
    else if (typeof current === 'object' || typeof current === 'function') current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A value as `data-format` shows it (`bar` is drawn, not formatted: see the binder). */
export function formatValue(value: unknown, format: string | undefined, max: unknown, values: UiValueRules): string {
  const n = numberOf(value);
  switch (format) {
    case 'int':
      return n === undefined ? values.text(value) : String(Math.round(n));
    case 'percent':
      return n === undefined ? values.text(value) : `${Math.round(n * 100)}%`;
    case 'time': {
      if (n === undefined) return values.text(value);
      const s = Math.max(0, Math.floor(n));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
    }
    case 'pips': {
      if (n === undefined) return values.text(value);
      const limit = numberOf(max);
      const filled = Math.max(0, Math.round(limit === undefined ? n : Math.min(n, limit)));
      const empty = limit === undefined ? 0 : Math.max(0, Math.round(limit) - filled);
      return '●'.repeat(Math.min(filled, 1000)) + '○'.repeat(Math.min(empty, 1000));
    }
    default:
      return value === undefined ? '' : values.text(value);
  }
}

/** The payload a click on `element` sends: the item's fields, then the element's `data-*` attributes. */
export function payloadOf(element: DomElement, item: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = isPlainObject(item) ? { ...item } : {};
  if (item instanceof Map) for (const [k, v] of item) data[String(k)] = v;
  else if (isDictLike(item)) for (const k of { [Symbol.iterator]: () => item[Symbol.iterator]() }) data[String(k)] = item.__getitem__(k);
  for (const name of element.getAttributeNames()) {
    if (!name.startsWith('data-') || VOCABULARY.has(name) || PREFIXES.some((p) => name.startsWith(p))) continue;
    data[name.slice(5).replaceAll('-', '_')] = element.getAttribute(name) ?? '';
  }
  return data;
}

// ── Scopes ─────────────────────────────────────────────────────────────────────

type Update = (frame: BindFrame, data: unknown) => void;

interface Site {
  readonly element: DomElement;
  readonly action: string;
  readonly key: string | null;
  readonly scope: Scope;
}

interface Each {
  readonly container: DomElement;
  readonly anchor: DomNode;
  readonly template: readonly MarkupNode[];
  readonly copies: { readonly scope: Scope; readonly nodes: DomNode[] }[];
}

class Scope {
  item: unknown;
  readonly index: number;
  readonly updates: Update[] = [];
  readonly sites: Site[] = [];
  readonly eaches: Each[] = [];

  constructor(item: unknown, index: number) {
    this.item = item;
    this.index = index;
  }

  update(frame: BindFrame, data: unknown): void {
    for (const update of this.updates) update(frame, data);
  }

  /** Every action site in this scope and the copies under it. */
  *allSites(): Generator<Site> {
    yield* this.sites;
    for (const each of this.eaches) for (const copy of each.copies) yield* copy.scope.allSites();
  }
}

/** A changed-only writer: `write` runs when the value differs from the last one written. */
function cached<T>(write: (value: T) => void): (value: T) => void {
  let last: { value: T } | undefined;
  return (value) => {
    if (last !== undefined && last.value === value) return;
    last = { value };
    write(value);
  };
}

export class PanelBinding {
  readonly #doc: DomDocument;
  readonly #options: BinderOptions;
  readonly #root = new Scope(undefined, 0);
  readonly #sites = new WeakMap<DomElement, Site>();
  #frame: BindFrame | undefined;
  /** Top-level nodes built into the parent. */
  readonly nodes: DomNode[] = [];

  constructor(doc: DomDocument, markup: readonly MarkupNode[], parent: DomParent, options: BinderOptions) {
    this.#doc = doc;
    this.#options = options;
    for (const node of markup) {
      const built = this.#build(node, parent, null, this.#root, false);
      if (built !== undefined) this.nodes.push(built);
    }
  }

  /** Bind to this frame's state. */
  update(frame: BindFrame): void {
    this.#frame = frame;
    this.#root.update(frame, frame.state);
  }

  /**
   * The action a click on `path` (the event's composed path, innermost first) sends, or
   * undefined when it lands on no action, or on a disabled one.
   */
  target(path: readonly unknown[]): PanelTarget | undefined {
    for (const node of path) {
      const site = this.#sites.get(node as DomElement);
      if (site !== undefined) return this.#send(site);
    }
    return undefined;
  }

  /** The action whose `data-key` is `code` (first enabled match), if any. */
  shortcut(code: string): PanelTarget | undefined {
    for (const site of this.#root.allSites()) {
      if (site.key !== code) continue;
      const sent = this.#send(site);
      if (sent !== undefined) return sent;
    }
    return undefined;
  }

  /** Whether `element` is an action of this panel (for focus navigation). */
  isAction(element: unknown): boolean {
    return this.#sites.has(element as DomElement);
  }

  #send(site: Site): PanelTarget | undefined {
    if (this.#frame?.enabled[site.action] === false || site.element.getAttribute('disabled') !== null) return undefined;
    return { action: site.action, data: payloadOf(site.element, site.scope.item) };
  }

  remove(): void {
    for (const node of this.nodes) node.remove();
  }

  // ── Building ──────────────────────────────────────────────────────────────────

  #build(node: MarkupNode, parent: DomParent, before: DomNode | null, scope: Scope, svg: boolean): DomNode | undefined {
    if (node.kind === 'text') return parent.insertBefore(this.#doc.createTextNode(node.text), before);
    if (node.tag === 'template') return undefined; // only data-each draws a template
    const inSvg = svg || node.tag === 'svg';
    // Markup names are lowercased when parsed; SVG's camelCase ones are restored here, as an HTML parser does.
    const element = inSvg ? this.#doc.createElementNS(SVG, svgTagName(node.tag)) : this.#doc.createElement(node.tag);
    const attrs = new Map(node.attrs);
    for (const [name, value] of node.attrs) {
      element.setAttribute(inSvg ? svgAttributeName(name) : name, name === 'data-key' ? indexed(value, scope.index) : value);
    }
    parent.insertBefore(element, before);
    this.#bind(element, attrs, scope);
    const each = attrs.get('data-each');
    if (each !== undefined) {
      this.#each(element, node, each, scope, inSvg);
    } else if (attrs.get('data-format') !== 'bar') {
      for (const child of node.children) this.#build(child, element, null, scope, inSvg);
    }
    return element;
  }

  #each(element: DomElement, node: MarkupElement, path: string, scope: Scope, svg: boolean): void {
    let template: readonly MarkupNode[] | undefined;
    let anchor: DomNode | undefined;
    for (const child of node.children) {
      if (child.kind === 'element' && child.tag === 'template') {
        if (template === undefined) {
          template = child.children;
          anchor = element.appendChild(this.#doc.createTextNode(''));
        }
        continue;
      }
      this.#build(child, element, null, scope, svg);
    }
    if (template === undefined || anchor === undefined) return; // `check` reports PP2076
    const each: Each = { container: element, anchor, template, copies: [] };
    scope.eaches.push(each);
    const tpl = template;
    scope.updates.push((frame, data) => {
      const items = listOf(resolvePath(data, path));
      for (let i = 0; i < items.length; i++) {
        let copy = each.copies[i];
        if (copy === undefined) {
          const copyScope = new Scope(items[i], i);
          const nodes: DomNode[] = [];
          for (const t of tpl) {
            const built = this.#build(t, element, each.anchor, copyScope, svg);
            if (built !== undefined) nodes.push(built);
          }
          copy = { scope: copyScope, nodes };
          each.copies.push(copy);
        }
        copy.scope.item = items[i];
        copy.scope.update(frame, items[i]);
      }
      while (each.copies.length > items.length) {
        for (const n of each.copies.pop()!.nodes) n.remove();
      }
    });
  }

  #bind(element: DomElement, attrs: ReadonlyMap<string, string>, scope: Scope): void {
    const updates = scope.updates;
    const format = attrs.get('data-format');
    const maxSpec = attrs.get('data-max');
    const maxOf = (data: unknown): unknown => {
      if (maxSpec === undefined) return undefined;
      return /^\d+(\.\d+)?$/.test(maxSpec) ? Number(maxSpec) : resolvePath(data, maxSpec);
    };

    const textKey = attrs.get('data-text');
    const bind = attrs.get('data-bind');
    if (bind !== undefined && format === 'bar') {
      element.classList.toggle('parallax-bar', true);
      const fill = this.#doc.createElement('span');
      fill.setAttribute('class', 'parallax-bar-fill');
      element.appendChild(fill);
      const width = cached<string>((w) => fill.style.setProperty('width', w));
      updates.push((_frame, data) => {
        const n = numberOf(resolvePath(data, bind)) ?? 0;
        width(`${(Math.min(1, Math.max(0, n)) * 100).toFixed(2)}%`);
      });
    } else if (bind !== undefined && attrs.has('data-count')) {
      const text = cached<string>((t) => { element.textContent = t; });
      const seconds = Math.max(0.01, Number(attrs.get('data-count')) || 0.5);
      const count = { from: 0, to: undefined as number | undefined, start: 0, shown: 0 };
      updates.push((frame, data) => {
        const raw = resolvePath(data, bind);
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
        if (value === undefined) return text(formatValue(raw, format, maxOf(data), frame.values));
        const now = frame.time ?? (globalThis.performance?.now() ?? 0) / 1000;
        if (count.to === undefined) Object.assign(count, { from: value, to: value, start: now - seconds, shown: value });
        else if (value !== count.to) Object.assign(count, { from: count.shown, to: value, start: now });
        const t = Math.min(1, Math.max(0, (now - count.start) / seconds));
        const eased = 1 - (1 - t) ** 3;
        count.shown = t >= 1 ? value : count.from + (value - count.from) * eased;
        const whole = Number.isInteger(value) && Number.isInteger(count.from);
        text(formatValue(whole ? Math.round(count.shown) : count.shown, format, maxOf(data), frame.values));
      });
    } else if (bind !== undefined) {
      const text = cached<string>((t) => { element.textContent = t; });
      updates.push((frame, data) => text(formatValue(resolvePath(data, bind), format, maxOf(data), frame.values)));
    } else if (textKey !== undefined) {
      const text = cached<string>((t) => { element.textContent = t; });
      updates.push((frame) => text(frame.strings[textKey] ?? textKey));
    }

    const show = attrs.get('data-show');
    const hide = attrs.get('data-hide');
    if (show !== undefined || hide !== undefined) {
      const visible = cached<boolean>((v) => {
        if (v) element.style.removeProperty('display');
        else element.style.setProperty('display', 'none', 'important');
      });
      updates.push((frame, data) => visible(
        (show === undefined || frame.values.truthy(resolvePath(data, show))) && (hide === undefined || !frame.values.truthy(resolvePath(data, hide))),
      ));
    }

    for (const [name, path] of attrs) {
      if (name.startsWith('data-class-') && name.length > 'data-class-'.length) {
        const token = name.slice('data-class-'.length);
        const on = cached<boolean>((v) => element.classList.toggle(token, v));
        updates.push((frame, data) => on(frame.values.truthy(resolvePath(data, path))));
      } else if (name.startsWith('data-attr-') && name.length > 'data-attr-'.length) {
        this.#attrBinding(element, name.slice('data-attr-'.length), path, updates);
      } else if (name.startsWith('data-style-') && name.length > 'data-style-'.length) {
        const property = name.slice('data-style-'.length);
        const set = cached<string>((v) => {
          if (v === '') element.style.removeProperty(property);
          else element.style.setProperty(property, v);
        });
        updates.push((frame, data) => {
          const value = resolvePath(data, path);
          set(value === null || value === undefined ? '' : this.#options.style(frame.values.text(value)));
        });
      }
    }

    const action = attrs.get('data-action');
    if (action !== undefined) {
      const key = element.getAttribute('data-key');
      const site: Site = { element, action, key, scope };
      scope.sites.push(site);
      this.#sites.set(element, site);
      const disabled = cached<boolean>((off) => {
        element.classList.toggle('parallax-disabled', off);
        if (off) element.setAttribute('aria-disabled', 'true');
        else element.removeAttribute('aria-disabled');
      });
      updates.push((frame) => disabled(frame.enabled[action] === false));
    }
  }

  #attrBinding(element: DomElement, name: string, path: string, updates: Update[]): void {
    if (!attributeAllowed(name)) return; // an inline handler or a blocked attribute is never set
    const tag = element.tagName.toLowerCase();
    const property = name === 'value' || name === 'checked' ? name : undefined;
    // An HTML element lowercases any name it is given; an SVG one needs `viewBox` as written.
    const attribute = svgAttributeName(name);
    const set = cached<string | null>((v) => {
      if (v === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, v);
      if (property === 'checked') (element as unknown as Record<string, unknown>)['checked'] = v !== null;
      else if (property === 'value' && v !== null && 'value' in element) (element as unknown as Record<string, unknown>)['value'] = v;
    });
    updates.push((frame, data) => {
      const value = resolvePath(data, path);
      if (value === null || value === undefined || value === false) return set(null);
      if (value === true) return set('');
      const text = frame.values.text(value);
      if (URL_ATTRS.has(name)) return set(this.#options.url(name, text, tag));
      if (name === 'style') return set(this.#options.style(text));
      return set(text);
    });
  }
}

function indexed(key: string, index: number): string {
  return key.replaceAll('{index1}', String(index + 1)).replaceAll('{index}', String(index));
}

function listOf(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object' && Symbol.iterator in value) return [...(value as Iterable<unknown>)];
  return [];
}

/** SVG element names with capitals (the HTML parsing spec's table), by their lowercased form. */
const SVG_TAGS: Readonly<Record<string, string>> = {
  'altglyph': 'altGlyph', 'altglyphdef': 'altGlyphDef', 'altglyphitem': 'altGlyphItem', 'animatecolor': 'animateColor',
  'animatemotion': 'animateMotion', 'animatetransform': 'animateTransform', 'clippath': 'clipPath',
  'feblend': 'feBlend', 'fecolormatrix': 'feColorMatrix', 'fecomponenttransfer': 'feComponentTransfer',
  'fecomposite': 'feComposite', 'feconvolvematrix': 'feConvolveMatrix', 'fediffuselighting': 'feDiffuseLighting',
  'fedisplacementmap': 'feDisplacementMap', 'fedistantlight': 'feDistantLight', 'fedropshadow': 'feDropShadow',
  'feflood': 'feFlood', 'fefunca': 'feFuncA', 'fefuncb': 'feFuncB', 'fefuncg': 'feFuncG', 'fefuncr': 'feFuncR',
  'fegaussianblur': 'feGaussianBlur', 'feimage': 'feImage', 'femerge': 'feMerge', 'femergenode': 'feMergeNode',
  'femorphology': 'feMorphology', 'feoffset': 'feOffset', 'fepointlight': 'fePointLight',
  'fespecularlighting': 'feSpecularLighting', 'fespotlight': 'feSpotLight', 'fetile': 'feTile',
  'feturbulence': 'feTurbulence', 'foreignobject': 'foreignObject', 'glyphref': 'glyphRef',
  'lineargradient': 'linearGradient', 'radialgradient': 'radialGradient', 'textpath': 'textPath',
};

/** SVG attribute names with capitals (`viewBox`, `preserveAspectRatio`…), by their lowercased form. */
const SVG_ATTRIBUTES: Readonly<Record<string, string>> = {
  'attributename': 'attributeName', 'attributetype': 'attributeType', 'basefrequency': 'baseFrequency',
  'baseprofile': 'baseProfile', 'calcmode': 'calcMode', 'clippathunits': 'clipPathUnits',
  'diffuseconstant': 'diffuseConstant', 'edgemode': 'edgeMode', 'filterunits': 'filterUnits', 'glyphref': 'glyphRef',
  'gradienttransform': 'gradientTransform', 'gradientunits': 'gradientUnits', 'kernelmatrix': 'kernelMatrix',
  'kernelunitlength': 'kernelUnitLength', 'keypoints': 'keyPoints', 'keysplines': 'keySplines', 'keytimes': 'keyTimes',
  'lengthadjust': 'lengthAdjust', 'limitingconeangle': 'limitingConeAngle', 'markerheight': 'markerHeight',
  'markerunits': 'markerUnits', 'markerwidth': 'markerWidth', 'maskcontentunits': 'maskContentUnits',
  'maskunits': 'maskUnits', 'numoctaves': 'numOctaves', 'pathlength': 'pathLength',
  'patterncontentunits': 'patternContentUnits', 'patterntransform': 'patternTransform', 'patternunits': 'patternUnits',
  'pointsatx': 'pointsAtX', 'pointsaty': 'pointsAtY', 'pointsatz': 'pointsAtZ', 'preservealpha': 'preserveAlpha',
  'preserveaspectratio': 'preserveAspectRatio', 'primitiveunits': 'primitiveUnits', 'refx': 'refX', 'refy': 'refY',
  'repeatcount': 'repeatCount', 'repeatdur': 'repeatDur', 'requiredextensions': 'requiredExtensions',
  'requiredfeatures': 'requiredFeatures', 'specularconstant': 'specularConstant',
  'specularexponent': 'specularExponent', 'spreadmethod': 'spreadMethod', 'startoffset': 'startOffset',
  'stddeviation': 'stdDeviation', 'stitchtiles': 'stitchTiles', 'surfacescale': 'surfaceScale',
  'systemlanguage': 'systemLanguage', 'tablevalues': 'tableValues', 'targetx': 'targetX', 'targety': 'targetY',
  'textlength': 'textLength', 'viewbox': 'viewBox', 'viewtarget': 'viewTarget', 'xchannelselector': 'xChannelSelector',
  'ychannelselector': 'yChannelSelector', 'zoomandpan': 'zoomAndPan',
};

/** An SVG element's name as the DOM expects it (`lineargradient` → `linearGradient`). */
export function svgTagName(tag: string): string {
  return SVG_TAGS[tag] ?? tag;
}

/** An SVG attribute's name as the DOM expects it (`viewbox` → `viewBox`); `xlink:href` and others as written. */
export function svgAttributeName(name: string): string {
  return SVG_ATTRIBUTES[name] ?? name;
}
