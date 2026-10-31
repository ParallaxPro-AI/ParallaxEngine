import { describe, expect, it } from 'vitest';
import { scopeCss } from './css.js';
import { expandTemplates, parseMarkup, projectPath, sanitizePanel, urlResolver } from './markup.js';
import type { MarkupNode } from './markup.js';

const url = (p: string): string => `/project/${p}`;

function html(nodes: readonly MarkupNode[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.text
    : `<${n.tag}${n.attrs.map(([k, v]) => ` ${k}="${v}"`).join('')}>${html(n.children)}</${n.tag}>`)).join('');
}

function clean(source: string, folder = 'ui/') {
  return sanitizePanel(parseMarkup(source), urlResolver(folder, url), (css) => css);
}

describe('parseMarkup', () => {
  it('reads elements, attributes, text, entities, void and self-closing elements', () => {
    const nodes = parseMarkup('<p class=a data-bind="x">A &amp; B&nbsp;&#9679;<br>c<img src="i.png"/></p><!-- note -->');
    expect(html(nodes)).toBe('<p class="a" data-bind="x">A & B ●c<br></br>c<img src="i.png"></img></p>'.replace('●c<br></br>c', '●<br></br>c'));
  });

  it('closes unclosed elements with their parent and keeps raw text raw', () => {
    expect(html(parseMarkup('<div><span>a</div><style>p > a { }</style>'))).toBe('<div><span>a</span></div><style>p > a { }</style>');
  });
});

describe('sanitizePanel', () => {
  it('drops scripts, frames, inline handlers and blocked attributes', () => {
    const out = clean('<div onclick="x()" data-action="go"><script>alert(1)</script><iframe src="x"></iframe>'
      + '<button onmouseover=y formaction="javascript:z" is="evil">Go</button></div>');
    expect(html(out.nodes)).toBe('<div data-action="go"><button>Go</button></div>');
  });

  it('resolves project URLs from the panel folder and drops off-project ones', () => {
    const out = clean('<img src="../assets/a.png"><img src="https://evil.test/x.png"><img src="javascript:alert(1)">'
      + '<a href="next.html">x</a><svg><use href="#heart"></use></svg><img src="data:image/png;base64,AA">');
    expect(html(out.nodes)).toBe('<img src="/project/assets/a.png"></img><img></img><img></img><a>x</a>'
      + '<svg><use href="#heart"></use></svg><img src="data:image/png;base64,AA"></img>');
  });

  it('collects <style> and stylesheet links in order, and unwraps html/head/body', () => {
    const out = clean('<html><head><link rel="stylesheet" href="a.css"><style>.x{}</style><title>t</title></head>'
      + '<body><form><p>hi</p></form></body></html>');
    expect(out.styles).toEqual([{ kind: 'link', path: 'a.css' }, { kind: 'inline', css: '.x{}' }]);
    expect(html(out.nodes)).toBe('<div><p>hi</p></div>');
  });

  it('expands <template src> from a project path', () => {
    const read = (p: string): string | undefined => (p === 'ui/slot.html' ? '<b data-bind="name"></b>' : undefined);
    const missing: string[] = [];
    const nodes = expandTemplates(parseMarkup('<ul data-each="xs"><template src="ui/slot.html"></template><template src="nope.html"></template></ul>'), read, (p) => missing.push(p));
    expect(html(nodes)).toBe('<ul data-each="xs"><template><b data-bind="name"></b></template><template src="nope.html"></template></ul>');
    expect(missing).toEqual(['nope.html']);
  });
});

describe('paths and CSS', () => {
  it('projectPath stays inside the project', () => {
    expect(projectPath('ui/', './a/../b.css')).toBe('ui/b.css');
    expect(projectPath('ui/', '../../x')).toBeUndefined();
    expect(projectPath('ui/', '/abs')).toBeUndefined();
    expect(projectPath('ui/', 'http://x/y')).toBeUndefined();
  });

  it('scopes game CSS to the panel: :root → :host, urls resolved, @import inlined', () => {
    const sheets: Record<string, string> = { 'ui/base.css': ':root { --a: 1; } .b { background: url(img/b.png); }' };
    const css = scopeCss('@import "base.css";\n.c { background: url("https://evil.test/x.png"); }', 'ui/', {
      read: (p) => sheets[p], url,
    });
    expect(css).toContain(':host { --a: 1; }');
    expect(css).toContain('url("/project/ui/img/b.png")');
    expect(css).toContain('url("about:invalid")');
    expect(css).not.toContain('@import');
  });
});

describe('hosted assets in panels', () => {
  const PNG = 'https://r2.parallaxpro.ai/assets/image_sprite/41/2d/412d9d91b45c42ea51966b71f1f0af61b00ae67323784fd5f27ee92f976624da.png';

  it('an asset-store URL is the one absolute URL a panel may name (normalized to r2)', () => {
    const resolve = urlResolver('ui/', url);
    expect(resolve('src', PNG, 'img')).toBe(PNG);
    expect(resolve('src', PNG.replace('r2.', ''), 'img')).toBe(PNG);
    expect(resolve('src', 'https://example.com/a.png', 'img')).toBeNull();
    expect(resolve('src', 'icons/a.png', 'img')).toBe('/project/ui/icons/a.png');
  });

  it('and in css url()', () => {
    const files = { read: () => undefined, url };
    expect(scopeCss(`.a { background: url("${PNG}") }`, 'ui/', files)).toContain(`url("${PNG}")`);
    expect(scopeCss('.a { background: url("https://example.com/a.png") }', 'ui/', files)).not.toContain('example.com');
  });
});
