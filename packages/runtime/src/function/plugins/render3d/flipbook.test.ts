import { describe, expect, it } from 'vitest';
import { bakeFlipbooks, FIRE_FLIPBOOK, FLIPBOOK_SIDE, SMOKE_FLIPBOOK } from './flipbook.js';

/** Sum of a channel over one frame of a sheet. */
function frameSum(pixels: Uint8Array, size: number, frame: number, channel: number): number {
  const cell = size / FLIPBOOK_SIDE;
  const ox = (frame % FLIPBOOK_SIDE) * cell;
  const oy = Math.floor(frame / FLIPBOOK_SIDE) * cell;
  let sum = 0;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) sum += pixels[((oy + y) * size + ox + x) * 4 + channel]!;
  return sum;
}

describe('built-in flipbooks', () => {
  it('bakes a burst that fills every frame and fades out by the end of the sheet', () => {
    const start = performance.now();
    const a = bakeFlipbooks();
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(2000);
    expect(a.size).toBe(512);
    const fire = (f: number): number => frameSum(a.fire, a.size, f, 3);
    const smoke = (f: number): number => frameSum(a.smoke, a.size, f, 3);
    // Framed on the gas: no frame before the fade is empty (the old baker's gas drifted out of view by frame 16).
    for (const sheet of [fire, smoke]) {
      const sums = Array.from({ length: 64 }, (_, f) => sheet(f));
      const peak = Math.max(...sums);
      expect(Math.min(...sums.slice(0, 48))).toBeGreaterThan(peak * 0.25);
      expect(sums[63]!).toBeLessThan(peak * 0.02);
    }
    // Frame edges are transparent (the vignette): no square outline on a billboard.
    expect(a.fire[3]).toBe(0);
    expect(a.smoke[(a.size * (a.size - 1)) * 4 + 3]).toBe(0);
  });

  it('is deterministic and lazy: the texture source is PNG bytes baked on first read', () => {
    const one = bakeFlipbooks();
    const two = bakeFlipbooks();
    expect(one.fire.every((v, i) => v === two.fire[i])).toBe(true);
    const source = FIRE_FLIPBOOK.source;
    expect(source.kind).toBe('bytes');
    if (source.kind === 'bytes') expect([...source.bytes.subarray(1, 4)]).toEqual([80, 78, 71]);
    expect(FIRE_FLIPBOOK.source).toBe(source);
    expect(SMOKE_FLIPBOOK.colorSpace).toBe('linear');
  });
});
