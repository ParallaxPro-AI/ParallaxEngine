import { describe, expect, it } from 'vitest';
import { numberStr } from '../../../api/pyrt/values.js';
import { frameDocument, frameMessage } from './frame_host.js';
import { numberText, WIRE_VALUES, wireState } from './frame_values.js';
import { parseMarkup, sanitizePanel, urlResolver } from './markup.js';

class Ref {
  constructor(readonly id: string) {}
}

const PAGE_VALUES = {
  text: (v: unknown): string => (v instanceof Ref ? `Ref(${v.id})` : String(v)),
  truthy: Boolean,
};

describe('scripted panels: markup, document, messages', () => {
  it('takes scripts out of the markup (inline and src, classic and module; JSON blocks are not scripts)', () => {
    const panel = sanitizePanel(parseMarkup(
      '<p id="x">hi</p><script>parallax.action("go")</script><script type="module" src="menu.js"></script>'
      + '<script type="application/json">{"a":1}</script><button onclick="steal()">b</button>',
    ), urlResolver('ui/', (p) => `/project/${p}`), (c) => c);
    expect(panel.scripts).toEqual([
      { kind: 'inline', code: 'parallax.action("go")', module: false },
      { kind: 'src', path: 'menu.js', module: true },
    ]);
    expect(JSON.stringify(panel.nodes)).not.toContain('script');
    expect(JSON.stringify(panel.nodes)).not.toContain('onclick');
  });

  it('the frame document: a CSP that blocks the network, :host styles for the whole document, the panel as inert data', () => {
    const html = frameDocument({
      module: 'http://127.0.0.1:5180/engine/panel_frame.js',
      css: ':host { color: red } </style><script>x</script>',
      init: { nodes: [], scripts: [{ code: 'a < b </script>', module: false }], folder: 'ui/', project: 'http://127.0.0.1:5180/project/', modal: true },
    });
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' http://127.0.0.1:5180/engine/");
    expect(csp).toContain('img-src http://127.0.0.1:5180/project/ data:');
    expect(csp).not.toContain('connect-src');
    expect(html).toContain(':root { color: red }');
    // Nothing from the panel closes the style element or the inert JSON block early.
    expect(html.match(/<\/style/gi)).toHaveLength(1);
    const json = /<script type="application\/json" id="parallax-panel">(.*?)<\/script>/s.exec(html)![1]!;
    expect(json).not.toContain('<');
    expect(JSON.parse(json).scripts[0].code).toBe('a < b </script>');
  });

  it('a packed build\'s frame (no project URL) may load data: files only, and asks the page for each one', () => {
    const html = frameDocument({
      module: 'https://cdn.example/engine/panel_frame.js', css: '',
      init: { nodes: [], scripts: [], folder: 'ui/', project: null, modal: false },
    });
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
    expect(csp).toContain('img-src data:;');
    expect(csp).toContain('font-src data:;');
    expect(csp).not.toContain('null');
    expect(frameMessage({ parallax: 1, t: 'file', path: 'assets/images/dot.png' })).toEqual({ t: 'file', path: 'assets/images/dot.png' });
    for (const bad of [{ parallax: 1, t: 'file' }, { parallax: 1, t: 'file', path: '' }, { parallax: 1, t: 'file', path: 'x'.repeat(513) }]) {
      expect(frameMessage(bad)).toBeUndefined();
    }
  });

  it('accepts only the fixed message set, well-formed', () => {
    expect(frameMessage({ parallax: 1, t: 'ready' })).toEqual({ t: 'ready' });
    expect(frameMessage({ parallax: 1, t: 'press', x: 4 })).toEqual({ t: 'press' }); // nothing else crosses
    expect(frameMessage({ parallax: 1, t: 'action', action: 'start', data: { seed: 4, name: 'x', tags: ['a'] } }))
      .toEqual({ t: 'action', action: 'start', data: { seed: 4, name: 'x', tags: ['a'] } });
    expect(frameMessage({ parallax: 1, t: 'action', action: 'start' })).toEqual({ t: 'action', action: 'start', data: {} });
    for (const bad of [
      { t: 'ready' }, { parallax: 1, t: 'eval', code: '1' }, { parallax: 1, t: 'action', action: 'a b' },
      { parallax: 1, t: 'action', action: 'go', data: { f: Number.NaN } }, { parallax: 1, t: 'action', action: 'go', data: [1] },
      { parallax: 1, t: 'action', action: 'go', data: { big: 'x'.repeat(20000) } },
      { parallax: 1, t: 'key', type: 'keypress', code: 'KeyA', key: 'a', repeat: false }, 'ready', null,
    ]) expect(frameMessage(bad)).toBeUndefined();
    expect(frameMessage({ parallax: 1, t: 'key', type: 'keydown', code: 'Escape', key: 'Escape', repeat: false })).toMatchObject({ code: 'Escape' });
  });

  it('state crosses as JSON; other values as their text; the frame reads it with Python rules', () => {
    const dict = { __getitem__: (k: string) => ({ a: 1.5 } as Record<string, number>)[k], __contains__: () => true, *[Symbol.iterator]() { yield 'a'; } };
    const list = new Set([1, 2]);
    expect(wireState({ n: 3, s: 'x', b: false, none: null, ref: new Ref('sword'), dict, list, items: [{ ref: new Ref('bow') }] }, PAGE_VALUES))
      .toEqual({ n: 3, s: 'x', b: false, none: null, ref: 'Ref(sword)', dict: { a: 1.5 }, list: [1, 2], items: [{ ref: 'Ref(bow)' }] });
    expect([WIRE_VALUES.text(null), WIRE_VALUES.text(true), WIRE_VALUES.text(0.1 + 0.2), WIRE_VALUES.text(['a', 1])])
      .toEqual(['None', 'True', '0.30000000000000004', "['a', 1]"]);
    expect([[], {}, '', 0, null, [0], 'x'].map(WIRE_VALUES.truthy)).toEqual([false, false, false, false, false, true, true]);
    for (const n of [0, 3, -7, 0.5, 1e16, 1.5e16, 1e-5, 123456789.125, 1e21, -2.5e-7, Number.NaN, Infinity]) expect(numberText(n)).toBe(numberStr(n));
  });
});
