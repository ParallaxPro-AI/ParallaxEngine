import { describe, expect, it } from 'vitest';
import { parseHtml } from './html.js';
import type { HtmlElement } from './html.js';

function tags(e: HtmlElement): unknown {
  return e.children.map((c) => (c.children.length > 0 ? [c.tag, tags(c)] : c.tag));
}

describe('parseHtml', () => {
  it('nests elements, reads attributes and lines, and skips comments, raw text and void elements', () => {
    const root = parseHtml([
      '<link rel="stylesheet" href="a.css">',
      '<style> .x > .y { color: red } <b> </style>',
      '<!-- <div data-bind="ignored"> -->',
      '<div class="hud" data-each=\'cards\'>',
      '  <template><button data-action="pick" data-key="Digit{index1}" disabled>',
      '    <span data-bind="name"></span><br><img src="x.png"/>',
      '  </button></template>',
      '</div>',
      '<script>if (a < b) { "<p>" }</script><p data-show="ok">x &amp; y</p>',
    ].join('\n'));
    expect(tags(root)).toEqual(['link', 'style', ['div', [['template', [['button', ['span', 'br', 'img']]]]]], 'script', 'p']);
    const div = root.children[2]!;
    expect(div.attrs.get('data-each')).toBe('cards');
    expect(div.line).toBe(4);
    const button = div.children[0]!.children[0]!;
    expect(button.attrs.get('data-key')).toBe('Digit{index1}');
    expect(button.attrs.has('disabled')).toBe(true);
    expect(button.children[0]!.line).toBe(6);
    expect(root.children[4]!.attrs.get('data-show')).toBe('ok');
  });

  it('tolerates unclosed and stray end tags', () => {
    const root = parseHtml('<div><p>one<p>two</div></span><b>three</b>');
    expect(tags(root)).toEqual([['div', [['p', ['p']]]], 'b']);
  });
});
