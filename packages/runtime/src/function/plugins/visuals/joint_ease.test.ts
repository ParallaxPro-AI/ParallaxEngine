import { describe, expect, it } from 'vitest';
import { ease, EASE_KINDS, easing, ParallaxError } from '../../../core/index.js';
import { jointValue } from '../../../resource/index.js';
import { ease as apiEase, EASE_KINDS as API_KINDS } from '../../../api/math.js';

describe('one ease table (core) for math.ease and model joint moves', () => {
  it('api/math re-exports the core table', () => {
    expect(API_KINDS).toBe(EASE_KINDS);
    expect(apiEase('out_back', 0.3)).toBe(ease('out_back', 0.3));
    expect(() => easing('wobble')).toThrow(ParallaxError);
  });

  it('a timed joint move eases by its `ease` (absent: in_out_quad)', () => {
    const base = { start_value: 0, start_time: 10, seconds: 2 };
    expect(jointValue(10, base, 11)).toBeCloseTo(10 * ease('in_out_quad', 0.5));
    expect(jointValue(10, { ...base, ease: 'linear' }, 10.5)).toBeCloseTo(2.5);
    expect(jointValue(10, { ...base, ease: 'out_cubic' }, 10.5)).toBeCloseTo(10 * ease('out_cubic', 0.25));
    expect(jointValue(10, { ...base, ease: 'out_cubic' }, 12)).toBe(10);
  });
});
