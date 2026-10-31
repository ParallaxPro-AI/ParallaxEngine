/**
 * Spot lights' inner and outer cones: `Light.inner_angle` is the fully lit core; the 3D light
 * texture carries its cosine where the shaders smoothstep from the outer edge, and the 2D
 * light model fades between the two.
 */

import { describe, expect, it } from 'vitest';
import type { Light2d, Light3d } from '../../../core/index.js';
import { lightFalloff } from '../../../function/plugins/render2d/index.js';
import { innerCone, packLights } from './layout.js';

const spot = (extra: Partial<Light3d> = {}): Light3d => ({
  kind: 'spot', color: [1, 1, 1], intensity: 1, position: [0, 0, 0], direction: [0, 0, 1], range: 10, angle: 60, shadows: false, entity: null, ...extra,
});
const cos = (deg: number): number => Math.cos((deg / 2) * Math.PI / 180);

describe('spot cones', () => {
  it('3D: inner_angle packs its cosine after the outer one; absent keeps the soft 20% edge', () => {
    const [plain] = [packLights([spot()], new Map())];
    expect(plain![11]).toBeCloseTo(cos(60), 6);
    expect(plain![13]).toBeCloseTo(innerCone(cos(60)), 6);
    const tight = packLights([spot({ innerAngle: 20 })], new Map());
    expect(tight[13]).toBeCloseTo(cos(20), 6);
    // A core as wide as the cone keeps a sliver of edge (no zero-width smoothstep).
    const full = packLights([spot({ innerAngle: 60 })], new Map());
    expect(full[13]!).toBeGreaterThan(full[11]!);
  });

  it('2D: full strength inside the core, fading to zero at the cone edge', () => {
    const light: Light2d = { kind: 'spot', x: 0, y: 0, color: [1, 1, 1], intensity: 1, radius: 10, direction: 0, cone: 90, inner: 30, entity: 1 };
    const at = (deg: number): number => lightFalloff(light, 2 * Math.cos(deg * Math.PI / 180), 2 * Math.sin(deg * Math.PI / 180));
    const center = at(0);
    expect(at(10)).toBeCloseTo(center, 6);
    expect(at(30)).toBeLessThan(center);
    expect(at(30)).toBeGreaterThan(0);
    expect(at(44.9)).toBeLessThan(center * 0.01);
    expect(at(46)).toBe(0);
    const hard: Light2d = { ...light, inner: undefined } as unknown as Light2d;
    delete (hard as { inner?: number }).inner;
    expect(lightFalloff(hard, 2 * Math.cos(Math.PI / 6), 2 * Math.sin(Math.PI / 6))).toBeCloseTo(center, 6);
  });
});
