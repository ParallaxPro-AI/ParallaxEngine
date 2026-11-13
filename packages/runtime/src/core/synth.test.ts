import { describe, expect, it } from 'vitest';
import { biquad, expandSong, noteFrequency, renderSynth, songSeconds, synthProblems, synthSeconds, synthStats } from './index.js';
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
      'unknown key "gian" (keys: duration, layers, gain, seed, normalize, song)',
      '"duration" 30 is outside 0.005..20 seconds',
      'layers[0]: unknown key "fraq"',
      'layers[0].wave "sqaure" is not one of sine, square, saw, triangle, noise',
      'layers[0].filter.freq must be a frequency above 0 Hz',
    ]);
    expect(synthProblems(TONE)).toEqual([]);
    expect(synthProblems('loud')).toHaveLength(1);
  });
});

describe('songs', () => {
  const SONG: SynthSpec = {
    duration: undefined as unknown as number, layers: [], gain: 0.8,
    song: {
      bpm: 120, bars: 2, steps_per_beat: 2,
      instruments: {
        bass: { wave: 'saw', attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.05, filter: { type: 'lowpass', freq: 900 } },
        kick: [{ wave: 'sine', freq: 120, freq_end: 45, decay: 0.2, sustain: 0 }, { wave: 'noise', decay: 0.01, sustain: 0, gain: 0.3 }],
      },
      tracks: [
        { instrument: 'bass', steps: 'C2 - . Eb2 | G2 . C3+G3 .' },
        { instrument: 'kick', steps: 'x . x .', gain: 0.9 },
      ],
    },
  };
  const { duration: _unused, ...spec } = SONG;
  const written = spec as unknown as SynthSpec;

  it('notes are A4 = 440 Hz equal temperament, with sharps, flats and transposition', () => {
    expect(noteFrequency('A4')).toBeCloseTo(440, 6);
    expect(noteFrequency('C4')).toBeCloseTo(261.626, 2);
    expect(noteFrequency('F#3')).toBeCloseTo(184.997, 2);
    expect(noteFrequency('Bb2')).toBeCloseTo(116.541, 2);
    expect(noteFrequency('A3', 12)).toBeCloseTo(440, 6);
    expect(noteFrequency('H2')).toBeUndefined();
  });

  it('expands steps into timed layers: held notes, chords split their gain, drums repeat to the end', () => {
    expect(synthProblems(written)).toEqual([]);
    expect(songSeconds(written.song!)).toBe(4);
    expect(synthSeconds(written)).toBe(4);
    const notes = expandSong(written.song!);
    const bass = notes.filter((n) => n.wave === 'saw');
    // 8 steps of 0.25 s, repeated twice over two bars: C2 (held 2), Eb2, G2, C3+G3 → 5 layers a pass.
    expect(bass.length).toBe(10);
    expect(bass[0]!.delay).toBe(0);
    expect(bass[0]!.length).toBeCloseTo(0.5 + 0.05, 6);
    expect(bass[0]!.freq).toBeCloseTo(noteFrequency('C2')!, 6);
    expect(bass[1]!.delay).toBeCloseTo(0.75, 6);
    const chord = bass.filter((n) => Math.abs(n.delay! - 1.5) < 1e-9);
    expect(chord.map((n) => n.gain)).toEqual([0.5, 0.5]);
    expect(bass[5]!.delay).toBeCloseTo(2, 6);
    const kicks = notes.filter((n) => n.wave === 'sine');
    expect(kicks.length).toBe(8);
    expect(kicks[1]!.delay).toBeCloseTo(0.5, 6);
    expect(kicks[0]!.freq_end).toBe(45);
    expect(kicks[0]!.gain).toBeCloseTo(0.9, 6);
  });

  it('renders past the one-sound limits: longer than 20 s and far more than 24 layers', () => {
    const long: SynthSpec = { layers: [], song: { bpm: 100, bars: 12, instruments: { hat: { wave: 'noise', decay: 0.03, sustain: 0 } }, tracks: [{ instrument: 'hat', steps: 'x x x x' }] } } as unknown as SynthSpec;
    expect(synthProblems(long)).toEqual([]);
    expect(expandSong(long.song!).length).toBe(12 * 16);
    const pcm = renderSynth(long, 8000);
    expect(pcm.length).toBe(Math.floor(28.8 * 8000));
    expect(synthStats(pcm, 8000).peak).toBeCloseTo(0.9, 3);
    const late = synthStats(pcm.subarray(Math.floor(27 * 8000), Math.floor(28 * 8000)), 8000);
    expect(late.rms).toBeGreaterThan(0.01);
  });

  it('is deterministic and swing pushes the off-beats', () => {
    expect(Array.from(renderSynth(written, 8000))).toEqual(Array.from(renderSynth(written, 8000)));
    const swung = expandSong({ ...written.song!, swing: 0.25 }).filter((n) => n.wave === 'saw');
    expect(swung[1]!.delay).toBeCloseTo(0.75 + 0.25 * 0.25, 6);
  });

  it('names each mistake in a song', () => {
    const bad = { song: { bpm: 5, bars: 1.5, tempo: 1, instruments: { lead: { wave: 'sine', delay: 1 } }, tracks: [{ instrument: 'pad', steps: 'C4 Q9 x', at: -1 }] } };
    expect(synthProblems(bad)).toEqual([
      'song: unknown key "tempo" (keys: bpm, bars, beats_per_bar, steps_per_beat, swing, instruments, tracks)',
      'song.bpm must be a tempo from 20 to 400',
      'song.bars must be a whole number of bars, at least 1',
      'song.instruments.lead: "delay" comes from the track\'s steps, not the instrument',
      'song.tracks[0].instrument "pad" is not one of the song\'s instruments',
      'song.tracks[0].steps: "Q9" is not a note (C4, F#3, Bb2), a chord (C4+E4), x, - or .',
      'song.tracks[0].at must be at least 0',
    ]);
    expect(synthProblems({ song: { bpm: 60, bars: 100, instruments: { a: { wave: 'sine' } }, tracks: [{ instrument: 'a', steps: 'C4' }] } })).toEqual([
      'song lasts 400.0 s; at most 300',
    ]);
  });
});
