import { describe, expect, it } from 'vitest';
import { RTL_LANGUAGES, textDirectionOf, UI_ICON_NAMES, UI_ICONS } from '../../../core/index.js';
import { DEFAULT_PANEL_CSS, FEEDBACK_CSS } from './builtins.js';
import { fontFaceCss, UI_FONTS } from './fonts.js';
import { frameDocument } from './frame_host.js';
import { expandIcons, iconElement } from './icons.js';
import { parseMarkup, sanitizePanel, urlResolver } from './markup.js';
import type { MarkupElement } from './markup.js';

describe('text direction', () => {
  it('right-to-left languages, by language or script subtag', () => {
    for (const tag of ['ar', 'ar-EG', 'he_IL', 'fa', 'ur-PK', 'az-Arab', 'yi']) expect(textDirectionOf(tag)).toBe('rtl');
    for (const tag of ['en', 'en-US', 'ja', 'de', 'az', 'ku-Latn', 'pa', '', '  ', 'xx-123']) expect(textDirectionOf(tag)).toBe('ltr');
    expect(textDirectionOf(undefined)).toBe('ltr');
    expect(textDirectionOf(null)).toBe('ltr');
    expect(RTL_LANGUAGES).toContain('he');
  });

  it('a scripted panel frame carries lang and dir', () => {
    const doc = (language?: string): string => frameDocument({
      module: 'http://x/engine/panel_frame.js', css: '', ...(language !== undefined && { language }),
      init: { nodes: [], scripts: [], folder: 'ui/', project: 'http://x/p/', modal: false },
    });
    expect(doc('ar')).toContain('<html lang="ar" dir="rtl">');
    expect(doc('en-US')).toContain('<html lang="en-US">');
    expect(doc()).toContain('<html>');
    expect(doc('x"><script>')).toContain('<html lang="xscript">');
  });
});

describe('icons', () => {
  it('keeps every name of the original set', () => {
    expect(UI_ICON_NAMES).toHaveLength(43);
    for (const name of ['blade', 'coin', 'gem', 'skull', 'crosshair', 'close', 'check', 'lock', 'chevron', 'star', 'timer', 'swords']) {
      expect(UI_ICONS[name]).toMatch(/^<(path|circle)/);
    }
  });

  it('<icon name> becomes an inline 24×24 svg, attributes kept, label → accessible image', () => {
    const svg = iconElement('coin', [['name', 'coin'], ['class', 'big gold'], ['data-show', 'rich']])!;
    expect(svg.tag).toBe('svg');
    expect(svg.attrs).toEqual([
      ['class', 'parallax-icon big gold'], ['viewBox', '0 0 24 24'], ['data-icon', 'coin'], ['aria-hidden', 'true'], ['data-show', 'rich'],
    ]);
    expect(svg.children.every((c) => c.kind === 'element' && (c.tag === 'path' || c.tag === 'circle'))).toBe(true);
    expect(iconElement('coin', [['label', 'Gold']])!.attrs).toContainEqual(['aria-label', 'Gold']);
    expect(iconElement('nope')).toBeUndefined();
  });

  it('expands icons after sanitizing; unknown names are reported and dropped', () => {
    const missing: string[] = [];
    const panel = sanitizePanel(parseMarkup('<div><icon name="bolt" onclick="x()"></icon> 5 <icon name="zap"></icon></div>'),
      urlResolver('ui/', (p) => `/p/${p}`), (css) => css);
    const out = expandIcons(panel.nodes, (n) => missing.push(n));
    const div = out[0] as MarkupElement;
    expect(div.children.map((c) => (c.kind === 'element' ? c.tag : c.text))).toEqual(['svg', ' 5 ']);
    expect((div.children[0] as MarkupElement).attrs.some(([n]) => n === 'onclick')).toBe(false);
    expect(missing).toEqual(['zap']);
  });
});

describe('fonts', () => {
  it('declares Inter and Cinzel from the shipped files', () => {
    expect(UI_FONTS.map((f) => f.family)).toEqual(['Inter', 'Cinzel']);
    const css = fontFaceCss();
    expect(css).toContain('@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: block; '
      + 'src: url("data:font/woff2;base64,d09GMg');
    expect(fontFaceCss(() => 'https://cdn.test/f.woff2')).toContain('src: url("https://cdn.test/f.woff2") format("woff2"); }');
    expect(css).toContain('font-family: "Cinzel"');
    expect(fontFaceCss((f) => f, [{ family: 'X', weight: '400', file: undefined }])).toBe('');
  });

  it('panels default to the engine fonts, as tokens a game can restyle', () => {
    expect(DEFAULT_PANEL_CSS).toContain('--parallax-font: Inter, system-ui');
    expect(DEFAULT_PANEL_CSS).toContain('--parallax-font-display: Cinzel');
    expect(DEFAULT_PANEL_CSS).toContain('font: 15px/1.4 var(--parallax-font)');
    expect(DEFAULT_PANEL_CSS).toContain('.parallax-icon');
    expect(FEEDBACK_CSS).toContain('Inter, system-ui');
  });
});
