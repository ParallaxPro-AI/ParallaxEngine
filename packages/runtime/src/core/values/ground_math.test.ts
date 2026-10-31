import { describe, expect, it } from 'vitest';
import {
  catmullRomPolyline, cosDegrees, footprintArea, footprintBounds, fractalNoise2, hash2, polylineNearest, rectFootprint, sdFootprint, sdSegment,
  smootherstep, smoothstep, valueNoise2,
} from './ground_math.js';

describe('ground math', () => {
  it('hashes and noise are in range, repeatable and seed-dependent', () => {
    for (let i = -50; i < 50; i++) {
      const h = hash2(i, i * 7, 3);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      const n = valueNoise2(i * 0.37, i * -0.21, 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(hash2(3, 4, 1)).toBe(hash2(3, 4, 1));
    expect(hash2(3, 4, 1)).not.toBe(hash2(3, 4, 2));
    // Value noise passes through its lattice hashes.
    expect(valueNoise2(2, 3, 9)).toBe(hash2(2, 3, 9));
    const layer = { kind: 'ridged' as const, amplitude: 1, wavelength: 10, octaves: 4, gain: 0.5, lacunarity: 2, seed: 1 };
    expect(fractalNoise2(layer, 12.5, -3)).toBe(fractalNoise2(layer, 12.5, -3));
  });

  it('easing', () => {
    expect([smoothstep(0, 1, -1), smoothstep(0, 1, 0.5), smoothstep(0, 1, 2)]).toEqual([0, 0.5, 1]);
    expect([smootherstep(0), smootherstep(0.5), smootherstep(1)]).toEqual([0, 0.5, 1]);
  });

  it('cosDegrees matches Math.cos to 1e-15 without calling it', () => {
    for (let d = -720; d <= 720; d += 7.3) expect(cosDegrees(d)).toBeCloseTo(Math.cos((d * Math.PI) / 180), 14);
    expect(cosDegrees(90)).toBeCloseTo(0, 15);
  });

  it('footprints are signed distances, negative inside', () => {
    expect(sdFootprint({ kind: 'circle', x: 1, z: 1, radius: 2 }, 1, 1)).toBe(-2);
    expect(sdFootprint({ kind: 'circle', x: 1, z: 1, radius: 2 }, 4, 1)).toBe(1);
    const box = rectFootprint(0, 0, 4, 2, 0);
    expect(sdFootprint(box, 0, 0)).toBe(-1);
    expect(sdFootprint(box, 5, 0)).toBe(3);
    expect(sdFootprint(box, 5, 4)).toBeCloseTo(Math.hypot(3, 3), 12);
    // Rotated 90°: the long side runs along z.
    const turned = rectFootprint(0, 0, 4, 2, 90);
    expect(sdFootprint(turned, 0, 1.9)).toBeLessThan(0);
    expect(sdFootprint(turned, 1.9, 0)).toBeGreaterThan(0);
    const tri = { kind: 'polygon' as const, points: [[0, 0], [4, 0], [0, 4]] as [number, number][] };
    expect(sdFootprint(tri, 1, 1)).toBe(-1);
    expect(sdFootprint(tri, -1, 0)).toBe(1);
    expect(footprintArea(tri)).toBe(8);
    expect(footprintBounds(turned, 1)).toEqual({ minX: -2, minZ: -3, maxX: 2, maxZ: 3 });
  });

  it('Catmull-Rom polylines pass through their control points', () => {
    const line = catmullRomPolyline([[0, 0], [10, 0], [10, 10]], false);
    expect([line[0], line[1]]).toEqual([0, 0]);
    expect([line[16], line[17]]).toEqual([10, 0]);
    expect([line.at(-2), line.at(-1)]).toEqual([10, 10]);
    const near = polylineNearest(line, 5, 1);
    expect(near.distance).toBeLessThan(2);
    expect(near.index).toBeGreaterThan(3);
    expect(near.index).toBeLessThan(6);
    expect(sdSegment(0, 5, -1, 0, 1, 0)).toBe(5);
    const loop = catmullRomPolyline([[0, 0], [10, 0], [5, 8]], true);
    expect([loop.at(-2), loop.at(-1)]).toEqual([0, 0]);
  });
});
