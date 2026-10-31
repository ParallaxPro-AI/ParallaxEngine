import { describe, expect, it } from 'vitest';
import { JOYSTICK_DEAD_ZONE, stickPosition } from './touch_fly.js';

describe('stickPosition', () => {
  it('scales the offset by the reach, x right and y down', () => {
    expect(stickPosition(18, -9, 36)).toEqual({ x: 0.5, y: -0.25 });
  });

  it('clamps a push past the rim to the unit circle', () => {
    const { x, y } = stickPosition(100, 100, 36);
    expect(Math.hypot(x, y)).toBeCloseTo(1);
    expect(x).toBeCloseTo(y);
  });

  it('rests inside the dead zone', () => {
    expect(stickPosition(36 * JOYSTICK_DEAD_ZONE * 0.5, 0, 36)).toEqual({ x: 0, y: 0 });
  });

  it('rests without a reach', () => {
    expect(stickPosition(10, 10, 0)).toEqual({ x: 0, y: 0 });
  });
});
