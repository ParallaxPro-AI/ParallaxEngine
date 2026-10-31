import { describe, expect, it } from 'vitest';
import type { UiValueRules } from '../../../core/index.js';
import { formatValue, PanelBinding, payloadOf } from './binding.js';
import type { BindFrame } from './binding.js';
import { BUILTIN_PANELS } from './builtins.js';
import type { DomDocument, DomElement, DomNode } from './dom.js';
import { parseMarkup, sanitizePanel, urlResolver } from './markup.js';

// ── A minimal DOM that counts writes ───────────────────────────────────────────

let writes = 0;

class FakeText implements DomNode {
  parentNode: FakeElement | null = null;
  #text: string;
  constructor(text: string) { this.#text = text; }
  get textContent(): string { return this.#text; }
  set textContent(v: string | null) { writes++; this.#text = v ?? ''; }
  remove(): void { this.parentNode?.detach(this); }
}

class FakeElement implements DomElement {
  parentNode: FakeElement | null = null;
  readonly tagName: string;
  readonly namespace: string | null;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly styles = new Map<string, string>();
  readonly classList = {
    toggle: (token: string, force?: boolean): boolean => {
      writes++;
      const on = force ?? !this.classes.has(token);
      if (on) this.classes.add(token); else this.classes.delete(token);
      return on;
    },
  };
  readonly style = {
    setProperty: (name: string, value: string): void => { writes++; this.styles.set(name, value); },
    removeProperty: (name: string): string => { writes++; const v = this.styles.get(name) ?? ''; this.styles.delete(name); return v; },
  };

  constructor(tag: string, namespace: string | null = null) {
    this.tagName = tag.toUpperCase();
    this.namespace = namespace;
  }

  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string | null) {
    writes++;
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    if (v) this.appendChild(new FakeText(v));
  }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  getAttributeNames(): string[] { return [...this.attrs.keys()]; }
  setAttribute(name: string, value: string): void { writes++; this.attrs.set(name, value); }
  removeAttribute(name: string): void { writes++; this.attrs.delete(name); }
  appendChild<T extends DomNode>(node: T): T { return this.insertBefore(node, null); }
  insertBefore<T extends DomNode>(node: T, before: DomNode | null): T {
    const n = node as unknown as FakeElement | FakeText;
    n.parentNode?.detach(n);
    const at = before === null ? -1 : this.children.indexOf(before as FakeElement | FakeText);
    if (at < 0) this.children.push(n); else this.children.splice(at, 0, n);
    n.parentNode = this;
    return node;
  }
  detach(node: FakeElement | FakeText): void {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parentNode = null;
  }
  remove(): void { this.parentNode?.detach(this); }

  /** Elements below, depth first. */
  *all(): Generator<FakeElement> {
    for (const c of this.children) if (c instanceof FakeElement) { yield c; yield* c.all(); }
  }
  find(attr: string, value?: string): FakeElement[] {
    return [...this.all()].filter((e) => e.attrs.has(attr) && (value === undefined || e.attrs.get(attr) === value));
  }
  shown(): boolean { return this.styles.get('display') !== 'none'; }
}

const doc: DomDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => { made.push(tag); return new FakeElement(tag, ns); },
  createTextNode: (text) => new FakeText(text),
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Python-like display and truthiness, as the api runtime supplies them. */
/** Element names the fake document was asked for in a namespace (SVG). */
const made: string[] = [];

const values: UiValueRules = {
  text: (v) => (v === null || v === undefined ? '' : v === true ? 'True' : v === false ? 'False' : String(v)),
  truthy: (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0)),
};

function mount(source: string) {
  const root = new FakeElement('root');
  const nodes = sanitizePanel(parseMarkup(source), urlResolver('ui/', (p) => `/project/${p}`), (css) => css).nodes;
  const binding = new PanelBinding(doc, nodes, root, { url: urlResolver('ui/', (p) => `/project/${p}`), style: (c) => c });
  const frame = (state: Record<string, unknown>, extra: Partial<BindFrame> = {}): void => {
    binding.update({ state, values, strings: { score: 'Score', title: 'Hi' }, enabled: {}, ...extra });
  };
  return { root, binding, frame };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('formatValue', () => {
  it('formats int, percent, time and pips; anything else reads as the language shows it', () => {
    expect(formatValue(3.6, 'int', undefined, values)).toBe('4');
    expect(formatValue(0.425, 'percent', undefined, values)).toBe('43%');
    expect(formatValue(65.9, 'time', undefined, values)).toBe('1:05');
    expect(formatValue(3725, 'time', undefined, values)).toBe('1:02:05');
    expect(formatValue(2, 'pips', 3, values)).toBe('●●○');
    expect(formatValue(3, 'pips', undefined, values)).toBe('●●●');
    expect(formatValue(true, undefined, undefined, values)).toBe('True');
    expect(formatValue(undefined, undefined, undefined, values)).toBe('');
  });
});

describe('PanelBinding', () => {
  it('data-count counts a bound number to each new value over its seconds, eased; whole numbers stay whole', () => {
    const { root, binding } = mount('<b data-bind="score" data-count="1"></b>');
    const at = (score: unknown, time: number): string => {
      binding.update({ state: { score }, values, strings: {}, enabled: {}, time });
      return (root.children[0] as FakeElement).textContent;
    };
    expect(at(10, 0)).toBe('10');
    expect(at(110, 1)).toBe('10');
    const mid = Number(at(110, 1.5));
    expect(mid).toBeGreaterThan(60);
    expect(mid).toBeLessThan(110);
    expect(at(110, 2)).toBe('110');
    expect(at('done', 3)).toBe('done');
  });

  it('keeps SVG camelCase names (viewBox, linearGradient, preserveAspectRatio), bound ones too; HTML stays as written', () => {
    const { root, frame } = mount(`<svg viewBox="0 0 10 10" preserveAspectRatio="none"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse"></linearGradient></defs><rect data-attr-viewbox="box"></rect></svg><div title="t"></div>`);
    frame({ box: '0 0 4 4' });
    const svg = root.children[0] as FakeElement;
    expect([...svg.attrs.keys()]).toEqual(['viewBox', 'preserveAspectRatio']);
    const gradient = (svg.children[0] as FakeElement).children[0] as FakeElement;
    expect(gradient.tagName).toBe('LINEARGRADIENT'); // the fake upper-cases; the name it was made with:
    expect(made).toContain('linearGradient');
    expect([...gradient.attrs.keys()]).toEqual(['id', 'gradientUnits']);
    expect((svg.children[1] as FakeElement).attrs.get('viewBox')).toBe('0 0 4 4');
    expect([...(root.children[1] as FakeElement).attrs.keys()]).toEqual(['title']);
  });

  it('binds text, locale text, formats, show/hide, classes, attributes and styles', () => {
    const { root, frame } = mount(`
      <p data-text="score"></p><b data-bind="player.hp" data-format="int"></b>
      <i data-show="alive">alive</i><i data-hide="alive">dead</i>
      <div data-class-low="low" data-attr-title="tip" data-attr-disabled="locked" data-style-color="color"></div>
      <span data-bind="hearts" data-format="pips" data-max="max"></span>
      <div class="bar" data-bind="charge" data-format="bar"></div>`);
    frame({ player: { hp: 7.4 }, alive: true, low: 1, tip: 'Hint', locked: false, color: 'red', hearts: 1, max: 3, charge: 0.25 });
    const [p, b] = [...root.all()];
    expect([p!.textContent, b!.textContent]).toEqual(['Score', '7']);
    const [alive, dead] = root.find('data-show').concat(root.find('data-hide'));
    expect([alive!.shown(), dead!.shown()]).toEqual([true, false]);
    const div = root.find('data-class-low')[0]!;
    expect([div.classes.has('low'), div.attrs.get('title'), div.attrs.has('disabled'), div.styles.get('color')]).toEqual([true, 'Hint', false, 'red']);
    expect(root.find('data-format', 'pips')[0]!.textContent).toBe('●○○');
    const bar = root.find('data-format', 'bar')[0]!;
    expect([bar.classes.has('parallax-bar'), (bar.children[0] as FakeElement).styles.get('width')]).toEqual([true, '25.00%']);

    frame({ player: { hp: 2 }, alive: false, low: 0, tip: 'Hint', locked: true, color: null, hearts: 3, max: 3, charge: 2 });
    expect([b!.textContent, alive!.shown(), dead!.shown(), div.classes.has('low'), div.attrs.get('disabled'), div.styles.has('color')])
      .toEqual(['2', false, true, false, '', false]);
    expect((bar.children[0] as FakeElement).styles.get('width')).toBe('100.00%');
  });

  it('touches the DOM only for what changed', () => {
    const { frame } = mount('<p data-bind="a"></p><p data-bind="b"></p><p data-show="c"></p><p data-text="title"></p>');
    frame({ a: 1, b: 2, c: true });
    writes = 0;
    frame({ a: 1, b: 2, c: true });
    expect(writes).toBe(0);
    frame({ a: 1, b: 3, c: true });
    expect(writes).toBe(1);
  });

  it('repeats a data-each template per item, reusing copies and trimming the end', () => {
    const { root, frame } = mount('<ul data-each="cards"><li class="head">x</li><template><li data-bind="name" data-class-rare="rare"></li></template></ul>');
    frame({ cards: [{ name: 'A' }, { name: 'B', rare: true }] });
    const items = (): string[] => root.find('data-bind', 'name').map((e) => e.textContent);
    expect(items()).toEqual(['A', 'B']);
    const first = root.find('data-bind', 'name')[0];
    frame({ cards: [{ name: 'C' }, { name: 'D' }, { name: 'E' }] });
    expect(items()).toEqual(['C', 'D', 'E']);
    expect(root.find('data-bind', 'name')[0]).toBe(first);
    frame({ cards: [{ name: 'F' }] });
    expect(items()).toEqual(['F']);
    expect(root.find('class', 'head')).toHaveLength(1);
    frame({ cards: [] });
    expect(items()).toEqual([]);
  });

  it('a click sends the item fields, then the element\'s data-* attributes, as headless clicks do', () => {
    const { root, binding, frame } = mount(`
      <div data-each="levels"><template>
        <button data-action="play" data-mode="hard" data-level-id="override"><span data-bind="name"></span></button>
      </template></div>
      <button data-action="quit">Quit</button>`);
    const ref = { id: 'cave', toString: () => 'cave' };
    frame({ levels: [{ name: 'One', level: ref, level_id: 'x' }, { name: 'Two', level: 'b', level_id: 'y' }] });
    const buttons = root.find('data-action', 'play');
    const span = buttons[1]!.children[0] as FakeElement;
    // The path a click reports runs from the innermost node outward.
    expect(binding.target([span, buttons[1], root])).toEqual({ action: 'play', data: { name: 'Two', level: 'b', level_id: 'override', mode: 'hard' } });
    expect(binding.target([buttons[0]])!.data['level']).toBe(ref);
    expect(binding.target([root.find('data-action', 'quit')[0]])).toEqual({ action: 'quit', data: {} });
    expect(binding.target([root])).toBeUndefined();
  });

  it('a disabled action (when= false, or a disabled element) neither clicks nor fires its shortcut', () => {
    const { root, binding, frame } = mount('<button data-action="buy" data-key="KeyB" data-attr-disabled="poor">Buy</button>');
    const button = root.find('data-action', 'buy')[0]!;
    frame({ poor: false }, { enabled: { buy: false } });
    expect([button.classes.has('parallax-disabled'), button.attrs.get('aria-disabled')]).toEqual([true, 'true']);
    expect(binding.target([button])).toBeUndefined();
    expect(binding.shortcut('KeyB')).toBeUndefined();
    frame({ poor: false }, { enabled: { buy: true } });
    expect(button.attrs.has('aria-disabled')).toBe(false);
    expect(binding.shortcut('KeyB')).toEqual({ action: 'buy', data: {} });
    frame({ poor: true }, { enabled: { buy: true } });
    expect(binding.target([button])).toBeUndefined();
  });

  it('data-key "Digit{index1}" numbers data-each copies from 1', () => {
    const { binding, frame } = mount('<div data-each="cards"><template><button data-action="pick" data-key="Digit{index1}"></button></template></div>');
    frame({ cards: [{ perk: 'a' }, { perk: 'b' }] });
    expect(binding.shortcut('Digit2')).toEqual({ action: 'pick', data: { perk: 'b' } });
    expect(binding.shortcut('Digit3')).toBeUndefined();
  });

  it('never sets an inline handler, and keeps bound URLs on the project', () => {
    const { root, frame } = mount('<img data-attr-onerror="js" data-attr-src="icon"><a data-attr-href="link">x</a>');
    frame({ js: 'alert(1)', icon: '../assets/i.png', link: 'javascript:alert(1)' });
    const [img, a] = [...root.all()];
    expect(img!.attrs.has('onerror')).toBe(false);
    expect(img!.attrs.get('src')).toBe('/project/assets/i.png');
    expect(a!.attrs.has('href')).toBe(false);
  });

  it('reads game-language dicts (items and paths) like plain objects', () => {
    class Dict {
      readonly #m: Map<unknown, unknown>;
      constructor(entries: [string, unknown][]) { this.#m = new Map(entries); }
      __getitem__(k: unknown): unknown { return this.#m.get(k); }
      __contains__(k: unknown): boolean { return this.#m.has(k); }
      [Symbol.iterator](): Iterator<unknown> { return this.#m.keys(); }
    }
    const { root, binding, frame } = mount('<p data-bind="stats.hp"></p><div data-each="xs"><template><button data-action="go" data-bind="n"></button></template></div>');
    frame(new Dict([['stats', new Dict([['hp', 9]])], ['xs', [new Dict([['n', 1]])]]]) as unknown as Record<string, unknown>);
    expect(root.find('data-bind', 'stats.hp')[0]!.textContent).toBe('9');
    expect(binding.target(root.find('data-action', 'go'))).toEqual({ action: 'go', data: { n: 1 } });
  });

  it('payloadOf reads attributes set by bindings (data-attr-data-*) at click time', () => {
    const el = new FakeElement('button');
    el.setAttribute('data-action', 'choose');
    el.setAttribute('data-attr-data-option', 'index');
    el.setAttribute('data-option', '2');
    expect(payloadOf(el, { index: 2, text: 'Yes' })).toEqual({ index: 2, text: 'Yes', option: '2' });
  });
});

describe('built-in panels', () => {
  it('the dialogue box shows the line and sends choose(option) / next', () => {
    const { root, binding, frame } = mount(BUILTIN_PANELS['builtin:dialogue.html']!);
    const options = [{ index: 0, speaker: null, text: 'Yes', enabled: true }, { index: 1, speaker: null, text: 'No', enabled: false }];
    frame({ speaker: 'Elder', text: 'Will you help?', tags: [], options });
    expect(root.find('data-bind', 'text').map((e) => e.textContent)).toEqual(['Will you help?', 'Yes', 'No']);
    const choices = root.find('data-action', 'choose');
    expect(choices.map((c) => c.classes.has('enabled'))).toEqual([true, false]);
    expect(binding.target([choices[0]])!.data['option']).toBe('0');
    expect(binding.shortcut('Digit1')).toMatchObject({ action: 'choose', data: { option: '0' } });
    expect(root.find('data-action', 'next')[0]!.shown()).toBe(false);
    frame({ speaker: null, text: 'Farewell.', tags: [], options: [] });
    expect([root.find('data-action', 'next')[0]!.shown(), root.find('data-show', 'speaker')[0]!.shown()]).toEqual([true, false]);
  });

  it('the settings menu shows the Settings values and sends adjust / cycle / toggle / rebind', () => {
    const { root, binding, frame } = mount(BUILTIN_PANELS['builtin:settings.html']!);
    const controls = [
      { slot: 'Controls.jump:key', label: 'Jump', device: 'keyboard', binding: 'Space', changed: false, capturing: false },
      { slot: 'Controls.jump:pad', label: 'Jump', device: 'gamepad', binding: 'A / ✕', changed: true, capturing: true },
    ];
    frame({
      master_volume: 0.8, music_volume: 1, sfx_volume: 0.5, quality: 'high', language: 'en', languages_many: false,
      mouse_sensitivity: 1, stick_sensitivity: 1, invert_look: false, controls, capturing: true, remapped: true,
    });
    expect(root.find('data-bind', 'master_volume')[0]!.textContent).toBe('80%');
    expect(root.find('data-show', 'invert_look')[0]!.shown()).toBe(false);
    expect(root.find('data-show', 'languages_many').every((e) => !e.shown())).toBe(true);
    const lower = root.find('data-action', 'adjust')[0]!;
    expect(binding.target([lower])).toEqual({ action: 'adjust', data: { setting: 'master_volume', step: '-0.1' } });
    expect(binding.target([root.find('data-action', 'cycle')[1]!])!.data).toEqual({ setting: 'quality', step: '1' });
    expect(binding.target([root.find('data-action', 'toggle')[0]!])!.data).toEqual({ setting: 'invert_look' });
    const rebind = root.find('data-action', 'rebind');
    expect(rebind.map((e) => [e.classes.has('changed'), e.classes.has('capturing')])).toEqual([[false, false], [true, true]]);
    expect(binding.target([rebind[0]!])!.data['slot']).toBe('Controls.jump:key');
    expect(root.find('data-bind', 'binding').map((e) => e.textContent)).toEqual(['Space', 'A / ✕']);
  });
  });
