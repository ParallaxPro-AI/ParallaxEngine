import { describe, expect, it } from 'vitest';
import { biquad, renderSynth, synthProblems, synthStats } from './index.js';
import type { SynthSpec } from './index.js';

const METAL: SynthSpec = {
  duration: 0.4, seed: 21,
  layers: [
    { wave: 'noise', decay: 0.012, sustain: 0, filter: { type: 'highpass', freq: 3000 } },
    { wave: 'square', freq: 1400, freq_end: 620, decay: 0.09, sustain: 0, ring_hz: 317, drive: 2.4 },
  ],
};
const TONE: SynthSpec = { duration: 0.2, layers: [{ wave: 'sine', freq: 440, attack: 0.01, decay: 0.15, sustain: 0 }] };

describe('renderSynth', () => {
  it('is deterministic: the same spec and rate give the same samples', () => {
    const a = renderSynth(METAL, 22050);
    const b = renderSynth(METAL, 22050);
    expect(a.length).toBe(Math.floor(0.4 * 22050));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('normalizes to the spec gain, and the seed changes only the noise', () => {
    const noise: SynthSpec = { duration: 0.1, seed: 1, layers: [{ wave: 'noise', attack: 0, decay: 0, sustain: 1 }] };
    const pcm = renderSynth(noise);
    expect(synthStats(pcm).peak).toBeCloseTo(0.9, 5);
    expect(Array.from(renderSynth({ ...noise, seed: 2 }))).not.toEqual(Array.from(pcm));
    expect(synthStats(renderSynth({ ...TONE, gain: 0.5 })).peak).toBeCloseTo(0.5, 5);
  });

  it('appending a layer leaves the earlier layers\' noise unchanged', () => {
    const one: SynthSpec = { duration: 0.05, normalize: false, gain: 1, layers: [{ wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.5 }] };
    const two: SynthSpec = { ...one, layers: [...one.layers, { wave: 'sine', freq: 100, gain: 0, attack: 0, decay: 0, sustain: 1 }] };
    expect(Array.from(renderSynth(two))).toEqual(Array.from(renderSynth(one)));
  });

  it('an envelope shapes the level: a percussive hit is loud early and silent late', () => {
    const pcm = renderSynth(TONE, 48000);
    const rms = (from: number, to: number): number => synthStats(pcm.subarray(Math.floor(from * 48000), Math.floor(to * 48000))).rms;
    expect(rms(0.01, 0.04)).toBeGreaterThan(rms(0.15, 0.2) * 10);
  });

  it('a lowpass takes the top off: high-frequency energy drops', () => {
    const bright: SynthSpec = { duration: 0.2, normalize: false, gain: 1, layers: [{ wave: 'noise', attack: 0, decay: 0, sustain: 1 }] };
    const dull: SynthSpec = { ...bright, layers: [{ ...bright.layers[0]!, filter: { type: 'lowpass', freq: 300 } }] };
    const diff = (pcm: Float32Array): number => synthStats(pcm.map((v, i) => (i === 0 ? 0 : v - pcm[i - 1]!))).rms;
    expect(diff(renderSynth(dull))).toBeLessThan(diff(renderSynth(bright)) * 0.2);
  });

  it('biquad: a lowpass passes DC and blocks Nyquist', () => {
    const c = biquad('lowpass', 1000, 0.707, 0, 48000);
    expect((c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2)).toBeCloseTo(1, 6);
    expect((c.b0 - c.b1 + c.b2) / (1 - c.a1 + c.a2)).toBeCloseTo(0, 6);
  });
});

describe('synthProblems', () => {
  it('names each mistake: missing duration, no layers, unknown wave and keys, bad filter', () => {
    expect(synthProblems({ layers: [] })).toEqual([
      '"duration" (seconds) is required and must be a number',
      '"layers" must be a non-empty list (no layers is silence)',
    ]);
    expect(synthProblems({ duration: 30, layers: [{ wave: 'sqaure', fraq: 3, filter: { type: 'lowpass' } }], gian: 1 })).toEqual([
      'unknown key "gian" (keys: duration, layers, gain, seed, normalize)',
      '"duration" 30 is outside 0.005..20 seconds',
      'layers[0]: unknown key "fraq"',
      'layers[0].wave "sqaure" is not one of sine, square, saw, triangle, noise',
      'layers[0].filter.freq must be a frequency above 0 Hz',
    ]);
    expect(synthProblems(TONE)).toEqual([]);
    expect(synthProblems('loud')).toHaveLength(1);
  });
});
