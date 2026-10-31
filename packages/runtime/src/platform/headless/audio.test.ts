import { describe, expect, it } from 'vitest';
import type { AudioPlay } from '../../core/index.js';
import { HeadlessAudio } from './audio.js';

const play = (voice: number, handle: string, loop: boolean): AudioPlay => ({
  kind: 'play', voice, sound: { handle, file: null }, bus: 'sfx', volume: 0.5, pitch: 1, loop, position: [1, 0, 0],
  attenuation: 0.5, pan: 0.2, source: loop ? 'entity' : 'one_shot', to: null, duck: !loop, occlusion: 0,
});

describe('HeadlessAudio', () => {
  it('records plays, music and buses, and models which loops are on', () => {
    const out = new HeadlessAudio();
    out.preload(['assets/sfx/a.ogg']);
    expect(out.preloaded).toEqual(['assets/sfx/a.ogg']);
    out.submit({
      frame: 3, time: 0.05, listener: { position: [0, 0, 0], right: [1, 0, 0], forward: [0, 0, 1], up: [0, 1, 0] },
      commands: [
        { kind: 'buses', master: 0.5, music: 1, sfx: 0.8 },
        { kind: 'music', track: { handle: 'music/theme', file: null }, volume: 0.3, pitch: 1, fade: 0 },
        play(1, 'sfx/hit', false),
        play(2, 'sfx/engine', true),
      ],
    });
    expect(out.played()).toEqual(['sfx/hit', 'sfx/engine']);
    expect(out.playsOf('sfx/hit')[0]).toMatchObject({ frame: 3, time: 0.05, position: [1, 0, 0] });
    expect(out.music).toBe('music/theme');
    expect(out.loops.map((v) => v.sound)).toEqual(['sfx/engine']);
    expect(out.heard(out.playsOf('sfx/hit')[0]!)).toBeCloseTo(0.5 * 0.8 * 0.5 * 0.5);
    expect(out.listener).toEqual({ position: [0, 0, 0], right: [1, 0, 0], forward: [0, 0, 1], up: [0, 1, 0] });
    expect(out.playsOf('sfx/hit')[0]).toMatchObject({ duck: true, occlusion: 0 });

    out.submit({
      frame: 4, time: 0.06, listener: null,
      commands: [{ kind: 'update', voice: 2, volume: 1, pitch: 1.3, position: null, attenuation: 1, pan: 0, occlusion: 1 }],
    });
    expect(out.loops[0]).toMatchObject({ pitch: 1.3, volume: 1, occlusion: 1 });
    expect(out.played(4)).toEqual([]);
    out.submit({ frame: 5, time: 0.07, listener: null, commands: [{ kind: 'stop', voice: 2, fade: 0.1 }] });
    expect(out.loops).toEqual([]);
    out.submit({ frame: 6, time: 0.08, listener: null, commands: [play(3, 'sfx/engine', true), { kind: 'stop_all' }] });
    expect(out.loops).toEqual([]);
    out.clear();
    expect(out.plays).toEqual([]);
    expect(out.music).toBe('music/theme');
  });

  it('keeps the mix, and what is preloaded and released', () => {
    const out = new HeadlessAudio();
    expect(out.mix).toEqual({ reverb: null, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 });
    out.submit({ frame: 1, time: 0, listener: null, commands: [{ kind: 'mix', reverb: { preset: 'cave', wet: 0.4 }, panning: 'hrtf', duckLevel: 0.2, duckRelease: 1 }] });
    expect(out.mix).toEqual({ reverb: { preset: 'cave', wet: 0.4 }, panning: 'hrtf', duckLevel: 0.2, duckRelease: 1 });
    out.preload(['a', 'b']);
    out.preload(['c']);
    out.release(['a']);
    expect(out.preloaded).toEqual(['b', 'c']);
    expect(out.released).toEqual([['a']]);
  });
});
