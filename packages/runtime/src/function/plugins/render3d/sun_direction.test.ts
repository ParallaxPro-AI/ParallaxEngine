import { describe, expect, it } from 'vitest';
import { upwardSun } from './engine.js';

/** Direction a directional light travels for placement rotation [pitch, yaw, 0] (its +z). */
function aimed(pitch: number, yaw: number): [number, number, number] {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)];
}

describe('upwardSun (PP3817)', () => {
  it('passes a sun that shines down: a positive first rotation angle', () => {
    expect(upwardSun(aimed(50, 30))).toBeNull();
    expect(upwardSun(aimed(14, 120))).toBeNull();
    expect(upwardSun([0, -1, 0])).toBeNull();
  });

  it('passes a horizon sun and a zero vector', () => {
    expect(upwardSun(aimed(0, 90))).toBeNull();
    expect(upwardSun([0, 0, 0])).toBeNull();
  });

  it('flags the ported racing sun [-14, 120, 0], which left the ground ambient-only', () => {
    const why = upwardSun(aimed(-14, 120));
    expect(why).toContain('14.0° below the horizon');
  });

  it('flags a straight-up light whatever its length', () => {
    expect(upwardSun([0, 3, 0])).toContain('90.0° below the horizon');
  });
});
