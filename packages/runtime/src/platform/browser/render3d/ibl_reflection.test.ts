import { describe, expect, it } from 'vitest';
import { reflectionSky } from './ibl.js';
import { luminance } from './layout.js';
import { ENV_FIELDS, glslPost, wgslPost } from './post_shaders.js';

describe('reflection sky', () => {
  const zenith = [0.12, 0.25, 0.7] as const;
  const horizon = [0.5, 0.6, 0.75] as const;

  it('takes the ambient light\'s hue and keeps each color\'s luminance (a neutral kitchen ambient: grey steel)', () => {
    const { zenith: z, horizon: h } = reflectionSky(zenith, horizon, [0.5, 0.48, 0.45]);
    expect(luminance(z)).toBeCloseTo(luminance(zenith), 6);
    expect(luminance(h)).toBeCloseTo(luminance(horizon), 6);
    // No longer blue: blue over red shrinks toward the ambient's 0.9.
    expect(h[2] / h[0]).toBeLessThan(1.2);
    expect(horizon[2] / horizon[0]).toBeGreaterThan(1.4);
  });

  it('leaves a sky-hued ambient (outdoors) and a black one alone', () => {
    const outdoor = reflectionSky(zenith, horizon, [0.31, 0.425, 0.725]);
    expect(outdoor.horizon[2] / outdoor.horizon[0]).toBeGreaterThan(1.4);
    expect(reflectionSky(zenith, horizon, [0, 0, 0])).toEqual({ zenith, horizon });
  });
});

describe('environment cube sky', () => {
  it('turns to ground below the horizon (the old engine\'s procedural sky)', () => {
    expect(ENV_FIELDS.map((f) => f.name)).toContain('envHorizon');
    expect(wgslPost('envSky')).toMatch(/mix\(sky, ground, below\)/);
    expect(glslPost('envSky').fragment).toMatch(/mix\(sky, ground, below\)/);
  });
});
