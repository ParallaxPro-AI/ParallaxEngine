import { describe, expect, it } from 'vitest';
import type { MarkupElement } from './markup.js';
import { registerPanelFonts, renameFontFamilies, renameNodeFonts, resolvePanelFonts, scopePanelFonts } from './panel_fonts.js';

const PANEL = `
@font-face { font-family: 'Orbitron'; font-weight: 400; src: url("data:font/woff2;base64,AAA") format("woff2"); }
@font-face { font-family: Orbitron; font-weight: 700; src: url("data:font/woff2;base64,BBB") format("woff2"); }
:host { --title-font: "Orbitron", serif; }
h1 { font-family: Orbitron, sans-serif; }
.big { font: 700 2em/1 'orbitron', system-ui; }
p { font-family: Inter, system-ui; content: "Orbitron"; }
`;

describe('scopePanelFonts', () => {
  it('lifts the faces out and renames the family everywhere the panel names it', () => {
    const fonts = scopePanelFonts(PANEL);
    const scoped = fonts.families.get('orbitron')!;
    expect(scoped).toMatch(/^Orbitron__pp[0-9a-z]+$/);
    expect(fonts.css).not.toContain('@font-face');
    expect(fonts.faces.match(/@font-face/g)).toHaveLength(2);
    expect(fonts.faces).toContain(`font-family: "${scoped}"`);
    expect(fonts.faces).toContain('font-weight: 700');
    expect(fonts.css).toContain(`--title-font: "${scoped}", serif`);
    expect(fonts.css).toContain(`font-family: "${scoped}", sans-serif`);
    expect(fonts.css).toContain(`font: 700 2em/1 "${scoped}", system-ui`);
    // Undeclared families and non-font strings stay.
    expect(fonts.css).toContain('font-family: Inter, system-ui; content: "Orbitron"');
  });

  it('gives the same declaration the same name and a different one a different name', () => {
    const a = scopePanelFonts(PANEL).families.get('orbitron');
    const b = scopePanelFonts(`${PANEL}\n.x { color: red; }`).families.get('orbitron');
    const c = scopePanelFonts(PANEL.replace('BBB', 'CCC')).families.get('orbitron');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('leaves CSS without faces alone', () => {
    const css = 'h1 { font-family: Inter; }';
    expect(scopePanelFonts(css)).toEqual({ css, faces: '', families: new Map() });
  });

  it('renames multi-word bare families and inline styles', () => {
    const fonts = scopePanelFonts(`@font-face { font-family: "Press Start 2P"; src: url(a.woff2); }
.t { font-family: Press Start 2P, monospace; }`);
    const scoped = fonts.families.get('press start 2p')!;
    expect(fonts.css).toContain(`font-family: "${scoped}", monospace`);
    expect(renameFontFamilies("font-family: 'Press Start 2P'", fonts.families)).toBe(`font-family: "${scoped}"`);
    const nodes = renameNodeFonts([{ kind: 'element', tag: 'b', attrs: [['style', 'font: 12px Press Start 2P']], children: [] }], fonts.families);
    expect((nodes[0] as MarkupElement).attrs[0]![1]).toBe(`font: 12px "${scoped}"`);
  });
});

describe('registerPanelFonts', () => {
  function fakeDocument(): { doc: Document; style: () => { textContent: string } | null } {
    let style: { id: string; textContent: string } | null = null;
    const doc = {
      getElementById: (id: string) => (style !== null && style.id === id ? style : null),
      createElement: () => ({ id: '', textContent: '' }),
      head: { append: (el: { id: string; textContent: string }) => { style = el; } },
    } as unknown as Document;
    return { doc, style: () => style };
  }

  it('a declared family resolves to its registered name for layers outside panels (TouchSkin.font)', () => {
    const { doc } = fakeDocument();
    expect(resolvePanelFonts(doc, 'Orbitron, sans-serif')).toBe('Orbitron, sans-serif');
    const { faces, families } = scopePanelFonts(PANEL);
    registerPanelFonts(doc, faces);
    const scoped = families.get('orbitron')!;
    expect(resolvePanelFonts(doc, 'Orbitron, sans-serif')).toBe(`"${scoped}", sans-serif`);
    expect(resolvePanelFonts(doc, '"orbitron"')).toBe(`"${scoped}"`);
    expect(resolvePanelFonts(doc, 'Inter, system-ui')).toBe('Inter, system-ui');
  });

  it('declares each face on the document once', () => {
    const { doc, style } = fakeDocument();
    const { faces } = scopePanelFonts(PANEL);
    registerPanelFonts(doc, faces);
    registerPanelFonts(doc, faces);
    expect(style()!.textContent.match(/@font-face/g)).toHaveLength(2);
    registerPanelFonts(doc, scopePanelFonts(PANEL.replace('BBB', 'CCC')).faces);
    expect(style()!.textContent.match(/@font-face/g)).toHaveLength(4);
  });
});
