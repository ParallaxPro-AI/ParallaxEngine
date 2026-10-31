import { describe, expect, it } from 'vitest';
import { panelScale } from './panel_scale.js';

describe('panel scale', () => {
  it('viewport: 1:1 down to 1280 x 720 (844 x 390 on touch), then shrinks to fit', () => {
    expect(panelScale('viewport', 1458, 957, false)).toBe(1);
    expect(panelScale('viewport', 3840, 2160, false)).toBe(1);
    expect(panelScale('viewport', 540, 960, false)).toBeCloseTo(540 / 1280);
    expect(panelScale('viewport', 1280, 600, false)).toBeCloseTo(600 / 720);
    expect(panelScale('viewport', 844, 390, true)).toBe(1);
    expect(panelScale('viewport', 390, 844, true)).toBeCloseTo(390 / 844);
  });

  it('design: a 1920 x 1080 canvas shrunk to fit, never zoomed in', () => {
    expect(panelScale('design', 1920, 1080, false)).toBe(1);
    expect(panelScale('design', 3840, 2160, false)).toBe(1);
    expect(panelScale('design', 1458, 957, false)).toBeCloseTo(1458 / 1920);
    expect(panelScale('design', 1920, 540, false)).toBeCloseTo(0.5);
  });

  it('design on touch: a 1688 x 780 canvas at 0.5 at most; a portrait phone keeps its area', () => {
    expect(panelScale('design', 844, 390, true)).toBeCloseTo(0.5);
    expect(panelScale('design', 2000, 1200, true)).toBe(0.5);
    expect(panelScale('design', 1688, 300, true)).toBeCloseTo(300 / 780); // short strip: height-bound
    const portrait = panelScale('design', 390, 844, true);
    expect(portrait).toBeCloseTo(Math.sqrt((390 * 844) / (1688 * 780)));
    expect((390 / portrait) * (844 / portrait)).toBeCloseTo(1688 * 780); // the layout area stays the canvas's
  });

  it('none and unmeasured sizes stay 1:1', () => {
    expect(panelScale('none', 300, 200, false)).toBe(1);
    expect(panelScale('design', 0, 0, false)).toBe(1);
  });
});
