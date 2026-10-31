import { describe, expect, it } from 'vitest';
import type { AudioCommand, AudioPlay, AudioSound } from '../../core/index.js';
import { WebAudioOutput } from './audio.js';
import type { AudioContextLike } from './audio.js';

/** A Web Audio double: records the graph and parameter automation, plays nothing. */
class FakeParam {
  value: number;
  readonly events: Array<[string, number, number]> = [];
  constructor(value: number) { this.value = value; }
  setTargetAtTime(v: number, t: number): void { this.events.push(['target', v, t]); this.value = v; }
  setValueAtTime(v: number, t: number): void { this.events.push(['set', v, t]); this.value = v; }
  linearRampToValueAtTime(v: number, t: number): void { this.events.push(['ramp', v, t]); this.value = v; }
  cancelScheduledValues(): void { /* nothing scheduled ahead in the double */ }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnected = false;
  connect(node: FakeNode): void { this.connections.push(node); }
  disconnect(): void { this.disconnected = true; }
}

class FakeGain extends FakeNode { readonly gain = new FakeParam(1); }
class FakePanner extends FakeNode { readonly pan = new FakeParam(0); }
class FakeFilter extends FakeNode { type = 'lowpass'; readonly frequency = new FakeParam(350); }
class Fake3dPanner extends FakeNode {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  rolloffFactor = 1;
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);
}
class FakeConvolver extends FakeNode { buffer: unknown = null; }
class FakeBuffer {
  readonly channels: Float32Array[];
  constructor(n: number, length: number) { this.channels = Array.from({ length: n }, () => new Float32Array(length)); }
  getChannelData(i: number): Float32Array { return this.channels[i]!; }
}
class FakeMedia {
  src = '';
  loop = false;
  playbackRate = 1;
  preservesPitch = true;
  crossOrigin: string | null = null;
  playing = false;
  play(): Promise<void> { this.playing = true; return Promise.resolve(); }
  pause(): void { this.playing = false; }
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  started = false;
  startedAt = 0;
  stoppedAt: number | undefined;
  onended: (() => void) | null = null;
  start(t = 0): void { this.started = true; this.startedAt = t; }
  stop(t = 0): void { this.stoppedAt = t; }
}

class FakeContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  decoded: string[] = [];
  readonly gains: FakeGain[] = [];
  readonly convolvers: FakeConvolver[] = [];
  readonly media: FakeMedia[] = [];
  readonly sampleRate = 8000;
  createGain(): FakeGain { const g = new FakeGain(); this.gains.push(g); return g; }
  createStereoPanner(): FakePanner { return new FakePanner(); }
  createPanner(): Fake3dPanner { return new Fake3dPanner(); }
  createBiquadFilter(): FakeFilter { return new FakeFilter(); }
  createConvolver(): FakeConvolver { const c = new FakeConvolver(); this.convolvers.push(c); return c; }
  createBuffer(n: number, length: number): FakeBuffer { return new FakeBuffer(n, length); }
  createMediaElementSource(media: FakeMedia): FakeNode { this.media.push(media); return new FakeNode(); }
  suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
  createBufferSource(): FakeSource { const s = new FakeSource(); this.sources.push(s); return s; }
  decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
    const name = new TextDecoder().decode(bytes);
    this.decoded.push(name);
    return Promise.resolve({ name });
  }
  resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
}

function setup(options: { maxVoices?: number; maxPerSound?: number; stream?: (file: string) => string | undefined } = {}): { ctx: FakeContext; out: WebAudioOutput; loads: string[] } {
  const ctx = new FakeContext();
  const loads: string[] = [];
  const out = new WebAudioOutput({
    context: ctx as unknown as AudioContextLike,
    load: (file) => { loads.push(file); return Promise.resolve(new TextEncoder().encode(file).buffer as ArrayBuffer); },
    createMedia: () => new FakeMedia(),
    ...options,
  });
  return { ctx, out, loads };
}

const sound = (name: string): AudioSound => ({ handle: `sfx/${name}`, file: `assets/sfx/${name}.ogg` });
const shot = (voice: number, name: string, extra: Partial<AudioPlay> = {}): AudioPlay => ({
  kind: 'play', voice, sound: sound(name), bus: 'sfx', volume: 1, pitch: 1, loop: false, position: null,
  attenuation: 1, pan: 0, source: 'one_shot', to: null, duck: false, occlusion: 0, ...extra,
});
const send = (out: WebAudioOutput, ...commands: AudioCommand[]): void => out.submit({ frame: 1, time: 0, listener: null, commands });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('WebAudioOutput', () => {
  it('decodes each file once, however often it plays', async () => {
    const { ctx, out, loads } = setup();
    out.preload(['assets/sfx/hit.ogg', 'assets/sfx/jump.ogg']);
    await settle();
    send(out, shot(1, 'hit'), shot(2, 'hit'), shot(3, 'jump'));
    await settle();
    expect(loads).toEqual(['assets/sfx/hit.ogg', 'assets/sfx/jump.ogg']);
    expect(ctx.decoded).toHaveLength(2);
    expect(ctx.sources.filter((s) => s.started)).toHaveLength(3);
  });

  it('applies volume × attenuation, pan and pitch, and routes through the sfx bus', async () => {
    const { ctx, out } = setup();
    out.preload(['assets/sfx/hit.ogg']);
    await settle();
    send(out, shot(1, 'hit', { volume: 0.5, attenuation: 0.5, pan: -0.4, pitch: 1.2 }));
    const source = ctx.sources[0]!;
    expect(source.playbackRate.value).toBe(1.2);
    const gain = source.connections[0] as FakeGain;
    expect(gain.gain.value).toBe(0.25);
    const filter = gain.connections[0] as FakeFilter;
    expect(filter.frequency.value).toBe(20000);
    const panner = filter.connections[0] as FakePanner;
    expect(panner.pan.value).toBe(-0.4);
  });

  it('drops a one-shot whose buffer arrives late or that is inaudible; starts loops late', async () => {
    const { ctx, out } = setup();
    send(out, shot(1, 'slow'), shot(2, 'loop', { loop: true }), shot(3, 'quiet', { attenuation: 0 }));
    ctx.currentTime = 1;
    await settle();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.loop).toBe(true);
    expect(out.voiceCount).toBe(1);
  });

  it('limits voices per sound and in total, stealing the oldest one-shot', async () => {
    const { ctx, out } = setup({ maxVoices: 3, maxPerSound: 2 });
    out.preload(['assets/sfx/hit.ogg', 'assets/sfx/hum.ogg']);
    await settle();
    send(out, shot(1, 'hit'), shot(2, 'hit'), shot(3, 'hit'));
    expect(ctx.sources[0]!.stoppedAt).toBeDefined();
    expect(out.voiceCount).toBe(2);
    send(out, shot(4, 'hum', { loop: true }), shot(5, 'hum', { loop: true }));
    expect(out.voiceCount).toBe(3);
    send(out, shot(6, 'hum', { loop: true }));
    expect(out.voiceCount).toBe(3);
    send(out, shot(7, 'hum', { loop: true }));
    expect(out.voiceCount).toBe(3);
    expect(ctx.sources.filter((s) => s.loop && s.started)).toHaveLength(3);
  });

  it('glides updates and fades stops', async () => {
    const { ctx, out } = setup();
    out.preload(['assets/sfx/engine.ogg']);
    await settle();
    send(out, shot(1, 'engine', { loop: true }));
    send(out, { kind: 'update', voice: 1, volume: 0.5, pitch: 1.4, position: null, attenuation: 1, pan: 0.3, occlusion: 0 });
    const source = ctx.sources[0]!;
    expect(source.playbackRate.events.at(-1)?.[0]).toBe('target');
    expect(source.playbackRate.value).toBe(1.4);
    ctx.currentTime = 2;
    send(out, { kind: 'stop', voice: 1, fade: 0.5 });
    expect(source.stoppedAt).toBe(2.5);
    expect(out.voiceCount).toBe(0);
  });

  it('crossfades music, keeps the same track, and fades to silence', async () => {
    const { ctx, out } = setup();
    const track = (name: string): AudioSound => ({ handle: `music/${name}`, file: `assets/music/${name}.ogg` });
    out.preload(['assets/music/a.ogg', 'assets/music/b.ogg']);
    await settle();
    send(out, { kind: 'music', track: track('a'), volume: 0.3, pitch: 1, fade: 0 });
    const a = ctx.sources[0]!;
    expect(a.loop).toBe(true);
    send(out, { kind: 'music', track: track('a'), volume: 0.5, pitch: 1, fade: 1 });
    expect(ctx.sources).toHaveLength(1);
    ctx.currentTime = 10;
    send(out, { kind: 'music', track: track('b'), volume: 0.4, pitch: 1, fade: 2 });
    expect(a.stoppedAt).toBe(12);
    const b = ctx.sources[1]!;
    expect((b.connections[0] as FakeGain).gain.events).toEqual([['set', 0, 10], ['ramp', 0.4, 12]]);
    send(out, { kind: 'music', track: null, volume: 0, pitch: 1, fade: 1 });
    expect(b.stoppedAt).toBe(11);
  });

  it('sets bus volumes from Settings', () => {
    const { out, ctx } = setup();
    send(out, { kind: 'buses', master: 0.8, music: 0.5, sfx: 0.25 });
    const [master, sfx, music, duck] = ctx.gains;
    expect(master!.connections).toEqual([ctx.destination]);
    expect(sfx!.connections).toEqual([master]);
    expect(music!.connections).toEqual([duck]);
    expect(duck!.connections).toEqual([master]);
    expect([master!.gain.value, sfx!.gain.value, music!.gain.value]).toEqual([0.8, 0.25, 0.5]);
  });

  it('a sound without a file (a data-only run) plays silently and fetches nothing', () => {
    const { out, loads } = setup();
    expect(() => send(out, shot(1, 'x', { sound: { handle: 'sfx/x', file: null } }))).not.toThrow();
    expect(loads).toEqual([]);
  });

  it('resume() resumes a suspended or interrupted context; suspend() suspends a running one', async () => {
    const { ctx, out } = setup();
    ctx.state = 'suspended';
    await out.resume();
    expect(ctx.state).toBe('running');
    await out.suspend();
    expect(ctx.state).toBe('suspended');
    ctx.state = 'interrupted' as AudioContextState;
    await out.resume();
    expect(ctx.state).toBe('running');
  });

  it('occlusion closes the voice\'s lowpass and lowers it; updates glide there', async () => {
    const { ctx, out } = setup();
    out.preload(['assets/sfx/engine.ogg']);
    await settle();
    send(out, shot(1, 'engine', { loop: true, occlusion: 1 }));
    const gain = ctx.sources[0]!.connections[0] as FakeGain;
    const filter = gain.connections[0] as FakeFilter;
    expect([gain.gain.value, filter.frequency.value]).toEqual([0.6, 800]);
    send(out, { kind: 'update', voice: 1, volume: 1, pitch: 1, position: null, attenuation: 1, pan: 0, occlusion: 0 });
    expect(filter.frequency.events.at(-1)).toEqual(['target', 20000, 0]);
    expect(gain.gain.value).toBe(1);
  });

  it('ducks the music while a duck voice plays and releases after the last one', async () => {
    const { ctx, out } = setup();
    out.preload(['assets/sfx/line.ogg']);
    await settle();
    const duck = ctx.gains[3]!;
    send(out, { kind: 'mix', reverb: null, panning: 'stereo', duckLevel: 0.25, duckRelease: 0.9 });
    send(out, shot(1, 'line', { duck: true }), shot(2, 'line', { duck: true }));
    expect(out.ducked).toBe(true);
    expect(duck.gain.value).toBe(0.25);
    ctx.sources[0]!.onended!();
    expect(duck.gain.value).toBe(0.25);
    ctx.sources[1]!.onended!();
    expect(out.ducked).toBe(false);
    expect(duck.gain.events.at(-1)).toEqual(['target', 1, 0]);
  });

  it('reverb: one convolver per preset from a seeded impulse, crossfading their sends', () => {
    const { ctx, out } = setup();
    send(out, { kind: 'mix', reverb: { preset: 'cave', wet: 0.5 }, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 });
    expect(ctx.convolvers).toHaveLength(1);
    const impulse = ctx.convolvers[0]!.buffer as FakeBuffer;
    expect(impulse.channels).toHaveLength(2);
    expect(impulse.channels[0]!.length).toBe(Math.round(8000 * (3.8 + 0.035)));
    expect(impulse.channels[0]!.some((v) => v !== 0)).toBe(true);
    send(out, { kind: 'mix', reverb: { preset: 'room', wet: 0.3 }, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 });
    send(out, { kind: 'mix', reverb: { preset: 'cave', wet: 0.5 }, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 });
    expect(ctx.convolvers).toHaveLength(2);
    expect(out.reverb).toEqual({ preset: 'cave', wet: 0.5 });
    const again = new FakeContext();
    const second = new WebAudioOutput({ context: again as unknown as AudioContextLike, load: () => Promise.reject(new Error('x')) });
    second.submit({ frame: 1, time: 0, listener: null, commands: [{ kind: 'mix', reverb: { preset: 'cave', wet: 0.5 }, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 }] });
    expect((again.convolvers[0]!.buffer as FakeBuffer).channels[1]).toEqual(impulse.channels[1]);
  });

  it('HRTF: positional voices get an HRTF panner placed in the listener\'s frame', async () => {
    const { ctx, out } = setup();
    out.preload(['assets/sfx/bee.ogg']);
    await settle();
    out.submit({
      frame: 1, time: 0, listener: { position: [10, 0, 0], right: [0, 0, -1], forward: [1, 0, 0], up: [0, 1, 0] },
      commands: [
        { kind: 'mix', reverb: null, panning: 'hrtf', duckLevel: 0.35, duckRelease: 0.6 },
        shot(1, 'bee', { loop: true, position: [15, 2, -3] }),
      ],
    });
    const filter = (ctx.sources[0]!.connections[0] as FakeGain).connections[0] as FakeFilter;
    const panner = filter.connections[0] as Fake3dPanner;
    expect([panner.panningModel, panner.rolloffFactor]).toEqual(['HRTF', 0]);
    // 5 m ahead, 3 m to the right, 2 m up → Web Audio (x right, y up, −z ahead).
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([3, 2, -5]);
  });

  it('streams music through a media element when given a URL, and never decodes it', async () => {
    const { ctx, out, loads } = setup({ stream: (file) => `https://cdn.example/${file}` });
    out.preload(['assets/music/theme.ogg']);
    send(out, { kind: 'music', track: { handle: 'music/theme', file: 'assets/music/theme.ogg' }, volume: 0.5, pitch: 1, fade: 1 });
    await settle();
    expect(loads).toEqual([]);
    expect(ctx.media.map((m) => [m.src, m.loop, m.playing])).toEqual([['https://cdn.example/assets/music/theme.ogg', true, true]]);
  });

  it('release() forgets decoded audio: the next play loads it again', async () => {
    const { out, loads } = setup();
    out.preload(['assets/sfx/hit.ogg']);
    await settle();
    out.release(['assets/sfx/hit.ogg']);
    out.preload(['assets/sfx/hit.ogg']);
    await settle();
    expect(loads).toEqual(['assets/sfx/hit.ogg', 'assets/sfx/hit.ogg']);
  });

  it('renders a synthesized sound at the context rate once, fetching nothing', () => {
    const { ctx, out, loads } = setup();
    const synth: AudioSound = { handle: 'synth/tick', file: null, synth: { duration: 0.05, layers: [{ wave: 'sine', freq: 1000, decay: 0.04, sustain: 0 }] } };
    send(out, shot(1, 'x', { sound: synth }), shot(2, 'x', { sound: synth }));
    expect(loads).toEqual([]);
    const [a, b] = ctx.sources;
    expect(a!.started && b!.started).toBe(true);
    expect(a!.buffer).toBe(b!.buffer);
    const pcm = (a!.buffer as FakeBuffer).getChannelData(0);
    expect(pcm.length).toBe(400);
    expect(Math.max(...pcm.map(Math.abs))).toBeCloseTo(0.9, 5);
  });

  it('schedules a quantized play `delay` seconds ahead on the context clock', async () => {
    const { ctx, out } = setup();
    out.preload(['assets/sfx/hit.ogg']);
    await settle();
    ctx.currentTime = 2;
    send(out, shot(1, 'hit', { delay: 0.25 }));
    expect(ctx.sources[0]!.startedAt).toBe(2.25);
  });

  it('layered music: every stem starts at one time, through its own gain; music_gains ramps them', async () => {
    const { ctx, out } = setup();
    const music = (name: string): AudioSound => ({ handle: `music/${name}`, file: `assets/music/${name}.ogg` });
    send(out, {
      kind: 'music', track: music('calm'), volume: 0.5, pitch: 1, fade: 1,
      layers: [{ track: music('drums'), volume: 0.8, gain: 1 }, { track: music('brass'), volume: 1, gain: 0 }],
    });
    await settle();
    await settle();
    const [base, drums, brass] = ctx.sources;
    expect(ctx.sources).toHaveLength(3);
    expect(new Set(ctx.sources.map((s) => s.startedAt)).size).toBe(1);
    expect(ctx.sources.every((s) => s.loop)).toBe(true);
    const gainOf = (s: FakeSource): FakeGain => s.connections[0] as FakeGain;
    expect(gainOf(drums!).gain.value).toBeCloseTo(0.8);
    expect(gainOf(brass!).gain.value).toBe(0);
    expect(gainOf(drums!).connections[0]).toBe(gainOf(base!));
    ctx.currentTime = 3;
    send(out, { kind: 'music_gains', gains: [0, 1], fade: 2 });
    expect(gainOf(brass!).gain.events.at(-1)).toEqual(['ramp', 1, 5]);
    expect(gainOf(drums!).gain.events.at(-1)).toEqual(['ramp', 0, 5]);
    // The same piece again only changes its level; another set of stems is another piece.
    send(out, { kind: 'music', track: music('calm'), volume: 0.4, pitch: 1, fade: 1, layers: [{ track: music('drums'), volume: 0.8, gain: 0 }, { track: music('brass'), volume: 1, gain: 1 }] });
    expect(ctx.sources).toHaveLength(3);
    send(out, { kind: 'music', track: music('calm'), volume: 0.4, pitch: 1, fade: 1 });
    expect(base!.stoppedAt).toBe(4);
    expect(drums!.stoppedAt).toBe(4);
  });

  it('music_pause holds decoded stems together at rate 0 and resumes them; a streamed track pauses its element', async () => {
    const { ctx, out } = setup({ stream: (file) => (file.includes('long') ? `/x/${file}` : undefined) });
    const music = (name: string): AudioSound => ({ handle: `music/${name}`, file: `assets/music/${name}.ogg` });
    send(out, { kind: 'music', track: music('calm'), volume: 0.5, pitch: 1.1, fade: 0, layers: [{ track: music('drums'), volume: 1, gain: 1 }] });
    await settle();
    await settle();
    expect(ctx.sources).toHaveLength(2);
    ctx.currentTime = 2;
    send(out, { kind: 'music_pause', paused: true });
    expect(out.musicPaused).toBe(true);
    for (const s of ctx.sources) expect(s.playbackRate.value).toBe(0);
    expect(new Set(ctx.sources.map((s) => s.playbackRate.events.at(-1)![2])).size).toBe(1);
    expect(ctx.sources.every((s) => s.stoppedAt === undefined)).toBe(true);
    ctx.currentTime = 5;
    send(out, { kind: 'music_pause', paused: false });
    for (const s of ctx.sources) expect(s.playbackRate.value).toBe(1.1);
    expect(out.musicPaused).toBe(false);
    // A streamed track: the element pauses (after the dip) and plays again.
    send(out, { kind: 'music', track: music('long'), volume: 0.5, pitch: 1, fade: 0 });
    const media = ctx.media.at(-1)!;
    expect(media.playing).toBe(true);
    send(out, { kind: 'music_pause', paused: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(media.playing).toBe(false);
    send(out, { kind: 'music_pause', paused: false });
    expect(media.playing).toBe(true);
  });

  it('a track that starts late while the music is held starts held; a new music command starts it playing', async () => {
    const { ctx, out } = setup();
    const music = (name: string): AudioSound => ({ handle: `music/${name}`, file: `assets/music/${name}.ogg` });
    send(out, { kind: 'music', track: music('calm'), volume: 0.5, pitch: 1, fade: 0 }, { kind: 'music_pause', paused: true });
    await settle();
    await settle();
    expect(ctx.sources[0]!.playbackRate.value).toBe(0);
    send(out, { kind: 'music', track: music('boss'), volume: 0.5, pitch: 1, fade: 0 });
    await settle();
    await settle();
    expect(ctx.sources.at(-1)!.playbackRate.value).toBe(1);
    expect(out.musicPaused).toBe(false);
  });
});
