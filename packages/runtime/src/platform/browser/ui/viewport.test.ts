import { describe, expect, it } from 'vitest';
import { scopeCss, inlineStyle } from './css.js';
import { frameDocument } from './frame_host.js';
import { containerQueries, containerUnits, viewportCss } from './viewport.js';

const files = { read: () => undefined, url: (p: string) => `/p/${p}` };

describe('panel viewport units and queries', () => {
  it('turns viewport units into container units', () => {
    expect(containerUnits('.a { height: 12vh; width: 3.5vw; font-size: clamp(12px, 2vmin, 4VMAX); margin: -1.5e1vh 0 }'))
      .toBe('.a { height: 12cqh; width: 3.5cqw; font-size: clamp(12px, 2cqmin, 4cqmax); margin: -1.5e1cqh 0 }');
    expect(containerUnits('.a { top: calc(100dvh - 2svw); left: 5lvmin; inset: 1vb 2vi }'))
      .toBe('.a { top: calc(100cqh - 2cqw); left: 5cqmin; inset: 1cqb 2cqi }');
  });

  it('leaves strings, comments, urls and names alone', () => {
    const css = '.vh-2vh, .x1vh { content: "10vh"; background: url(data:font/woff2;base64,AB5vh/=); } /* 4vw */ @keyframes v2vw {}';
    expect(containerUnits(css)).toBe(css);
    expect(containerUnits(".a{background:url('a 5vh.png') 0 5vh}")).toBe(".a{background:url('a 5vh.png') 0 5cqh}");
  });

  it('turns @media size queries into @container queries on the game view', () => {
    expect(containerQueries('@media (max-width: 600px) { .a { x: 1 } }'))
      .toBe('@container parallax-view (max-width: 600px) { .a { x: 1 } }');
    expect(containerQueries('@media(max-height:500px){.a{x:1}}'))
      .toBe('@container parallax-view (max-height:500px) {.a{x:1}}');
    expect(containerQueries('@media only screen and (orientation: portrait) and (max-aspect-ratio: 3/4) {.a{}}'))
      .toBe('@container parallax-view (orientation: portrait) and (max-aspect-ratio: 3/4) {.a{}}');
    expect(containerQueries('@media (400px <= width <= 700px) {.a{}}'))
      .toBe('@container parallax-view (400px <= width <= 700px) {.a{}}');
    expect(containerQueries('@media (max-width: 600px), (max-height: 400px) {.a{}}'))
      .toBe('@container parallax-view ((max-width: 600px)) or ((max-height: 400px)) {.a{}}');
  });

  it('nests a size query inside the media features it is combined with', () => {
    expect(containerQueries('@media (pointer: coarse) and (max-height: 500px) { .a { x: 1 } .b { y: 2 } } .c { z: 3 }'))
      .toBe('@media (pointer: coarse) { @container parallax-view (max-height: 500px) { .a { x: 1 } .b { y: 2 } }} .c { z: 3 }');
  });

  it('keeps media queries that are not about the view size', () => {
    for (const css of [
      '@media (pointer: coarse) {.a{}}', '@media (prefers-reduced-motion: reduce) {.a{}}', '@media print {.a{}}',
      '@media (hover: hover), (max-width: 600px) {.a{}}', '@media not all and (max-width: 600px) {.a{}}',
      '@media (min-device-width: 600px) {.a{}}',
    ]) expect(containerQueries(css)).toBe(css);
  });

  it('rewrites nested and repeated queries, and leaves @media inside strings', () => {
    const css = '@supports (display: grid) { @media (max-width: 9px) { .a { content: "@media (width: 1px) {" } } } @media (min-width: 2px) {.b{}}';
    expect(viewportCss(css)).toBe('@supports (display: grid) { @container parallax-view (max-width: 9px) { .a { content: "@media (width: 1px) {" } } } '
      + '@container parallax-view (min-width: 2px) {.b{}}');
  });

  it('applies to every panel stylesheet and inline style, and the frame document is the container', () => {
    expect(scopeCss(':root { --s: 2vh } @media (max-width: 600px) { .a { width: 50vw } }', 'ui/', files))
      .toBe(':host { --s: 2cqh } @container parallax-view (max-width: 600px) { .a { width: 50cqw } }');
    expect(inlineStyle('height: 10vh; background: url(x.png)', 'ui/', files.url)).toBe('height: 10cqh; background: url("/p/ui/x.png")');
    const doc = frameDocument({ module: '/e/panel_frame.js', css: '', init: { nodes: [], scripts: [], folder: 'ui/', project: '/p/', modal: false } });
    expect(doc).toContain('container: parallax-view / size');
  });
});
