import { describe, expect, it } from 'vitest';
import { PARTICLE3D_STRIDE, RIBBON_STRIDE } from '../../../core/index.js';
import type { Frame3d, ParticleBatch3d, Ribbon3d, Texture3d } from '../../../core/index.js';
import { planVfx, RIBBON_VERTEX_FLOATS, VFX_INSTANCE_FLOATS } from './vfx.js';

const IMAGE: Texture3d = { id: 'assets/images/puff.png', source: { kind: 'file', path: 'assets/images/puff.png' }, colorSpace: 'srgb', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' };

function batch(look: Partial<ParticleBatch3d>, particles: readonly number[][]): ParticleBatch3d {
  const data = new Float32Array(particles.length * PARTICLE3D_STRIDE);
  particles.forEach((p, i) => data.set(p, i * PARTICLE3D_STRIDE));
  return {
    blend: 'alpha', shape: 'circle', image: null, frames: [1, 1], facing: 'camera', soft: 0.3, lit: false, intensity: 1,
    count: particles.length, data, entity: null, ...look,
  };
}

function ribbon(blend: Ribbon3d['blend'], points: number): Ribbon3d {
  const p = new Float32Array(points * RIBBON_STRIDE);
  for (let i = 0; i < points; i++) p.set([i, 0, 0, 0.5, 1, 1, 1, 1], i * RIBBON_STRIDE);
  return { blend, points: p, intensity: 2, core: 0.2, entity: null };
}

const frame = (more: Partial<Frame3d>): Frame3d => more as Frame3d;

describe('effects on the GPU (plan)', () => {
  it('packs particles: center, angle in radians, stretch and soft, size, progress and look flags, linear color × intensity, sheet', () => {
    const plan = planVfx(frame({
      particles: [
        batch({ shape: 'glow', facing: 'velocity', blend: 'additive', intensity: 2 }, [[1, 2, 3, 0.5, 0.5, 90, 1, 0.5, 0, 0.8, 0.1, 0.2, 0.3, 0.25, 0, 0]]),
        batch({ image: IMAGE, frames: [8, 4], lit: true, facing: 'up' }, [[0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0]]),
      ],
    }), () => true)!;
    const p = plan.instances;
    expect(plan.particles.map((i) => [i.blend, i.first, i.count, i.texture?.id ?? null])).toEqual([['additive', 0, 1, null], ['alpha', 1, 1, IMAGE.id]]);
    expect([p[0], p[1], p[2]]).toEqual([1, 2, 3]);
    expect(p[3]).toBeCloseTo(Math.PI / 2);
    expect([...p.subarray(4, 8)].map((x) => +x.toFixed(3))).toEqual([0.1, 0.2, 0.3, 0.3]);
    // Glow (2) + 4 × velocity (1).
    expect([...p.subarray(8, 12)]).toEqual([0.5, 0.5, 0.25, 6]);
    expect(p[12]).toBeCloseTo(2);
    expect(p[13]).toBeCloseTo(2 * 0.214, 2);
    expect(p[15]).toBeCloseTo(0.8);
    const o = VFX_INSTANCE_FLOATS;
    // Circle (0) + 4 × up (2) + lit (16) + image (32); its 8 × 4 sheet.
    expect(p[o + 11]).toBe(56);
    expect([p[o + 16], p[o + 17]]).toEqual([8, 4]);
  });

  it('waits for images to load, and is null with nothing to draw', () => {
    expect(planVfx(frame({}), () => true)).toBeNull();
    expect(planVfx(frame({ particles: [batch({ image: IMAGE }, [[0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]])] }), () => false)).toBeNull();
  });

  it('expands ribbons into six vertices per segment, alpha then additive, each with its point\'s tangent', () => {
    const plan = planVfx(frame({ ribbons: [ribbon('additive', 3), ribbon('alpha', 2)] }), () => true)!;
    expect(plan.ribbons).toEqual({ alpha: { first: 0, count: 6 }, additive: { first: 6, count: 12 } });
    const v = plan.ribbonVertices;
    const vertex = (i: number): number[] => [...v.subarray(i * RIBBON_VERTEX_FLOATS, (i + 1) * RIBBON_VERTEX_FLOATS)];
    // The additive ribbon's middle point: tangent from its neighbours (2, 0, 0), width, core.
    const middle = vertex(6 + 1);
    expect(middle.slice(0, 8)).toEqual([1, 0, 0, -1, 2, 0, 0, 0.5]);
    expect(middle[8]).toBeCloseTo(2);
    expect(middle[12]).toBeCloseTo(0.2);
    expect(vertex(6 + 5)[3]).toBe(1);
  });
});
