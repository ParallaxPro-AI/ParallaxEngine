/**
 * The audio plugin beyond files: synthesized sounds (built-ins and `.synth.json`), layered
 * music by intensity, the beat clock with quantized plays, the voice budget, and the
 * ambience it synthesizes from the weather, wind and water services. Everything is read
 * back from HeadlessAudio's recording: what the engine decided, frame by frame.
 */

import { describe, expect, it } from 'vitest';
import { renderSynth, synthProblems, synthSeconds, synthStats, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, GameDefinition, KernelPlugin, ResourceDef, SystemDef } from '../../kernel/index.js';
import { HeadlessAudio } from '../../../platform/headless/audio.js';
import { WATER_WORLD_SERVICE, WEATHER_SERVICE, WIND_SERVICE } from '../../services/index.js';
import type { WaterBodyInfo, WeatherConditions } from '../../services/index.js';
import {
  audio, BEAT_EVENT, beatAtTime, changeTempo, collectBeats, layerGains, nearestOnArea, nearestOnCourse, nextBoundary, rampGain,
  SYNTH_PRESET_NAMES, SYNTH_PRESETS, tempoMap, thunderClap, timeAtBeat, VoiceBudget,
} from './index.js';
import type { AudioNamespace } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const AUDIO_SOURCE_DEF: ComponentDef = {
  id: 'audio_source',
  schema: {
    sound: t.ref('asset:sound', { default: '' }),
    playing: t.bool({ default: true }),
    loop: t.bool({ default: true }),
    volume: t.number({ default: 1, min: 0 }),
    pitch: t.number({ default: 1 }),
    spatial: t.bool({ default: true }),
  },
};
const CAMERA_DEF: ComponentDef = { id: 'camera', schema: {} };
const SETTINGS_DEF: ResourceDef = {
  id: 'settings', keep: 'profile',
  schema: { master_volume: t.number({ default: 1 }), music_volume: t.number({ default: 1 }), sfx_volume: t.number({ default: 1 }) },
};
const SOUNDS = ['assets/sfx/hit.ogg', 'assets/sfx/engine.ogg', 'assets/music/calm.ogg', 'assets/music/drums.ogg', 'assets/music/brass.ogg'];

interface Setup {
  readonly kernel: Kernel;
  readonly plugin: ReturnType<typeof audio>;
  readonly out: HeadlessAudio;
  readonly ctx: AudioNamespace;
  readonly beats: Record<string, unknown>[];
  steps(n?: number): void;
  id(placed: string): EntityId;
}

function setup(options: {
  extra?: Record<string, unknown>;
  audioJson?: Record<string, unknown>;
  scene?: Record<string, unknown>;
  assets?: readonly string[] | null;
  plugins?: readonly KernelPlugin[];
} = {}): Setup {
  const project = files({
    'assets/audio.json': options.audioJson ?? { 'music/calm': { volume: 0.5 } },
    'prefabs/camera.prefab.json': { components: { camera: {} } },
    'prefabs/engine.prefab.json': { components: { audio_source: { sound: 'sfx/engine' } } },
    'scenes/main/scene.json': options.scene ?? { entities: [{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }] },
    ...options.extra,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const out = new HeadlessAudio();
  const plugin = audio({
    output: out, assets: options.assets === undefined ? [...SOUNDS, ...project.list()] : options.assets, files: project,
    defaults: loaded.audio, seed: 3, mode: '3d',
  });
  const beats: Record<string, unknown>[] = [];
  const listener: SystemDef = {
    id: 'beats', scenes: [], handlers: [{ event: BEAT_EVENT, method: 'beat' }],
    create: () => ({ beat: (_ctx: unknown, payload: Record<string, unknown>) => { beats.push(payload); } }),
  };
  const game: GameDefinition = {
    components: [AUDIO_SOURCE_DEF, CAMERA_DEF], resources: [SETTINGS_DEF], events: [{ id: 'thunder' }], behaviors: [], systems: [listener],
  };
  const kernel = new Kernel({ project: loaded, game, plugins: [...(options.plugins ?? []), plugin], context: {}, fixedStep: DT });
  const ctx = plugin.namespace!.create(kernel) as AudioNamespace;
  kernel.start('main');
  return {
    kernel, plugin, out, ctx, beats,
    steps: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
    id: (placed) => [...kernel.world.live()].find((r) => r.placedId === placed)!.id,
  };
}

const play = (ctx: AudioNamespace, sound: string, extra: Record<string, unknown> = {}): void =>
  ctx.play({ sound, at: null, volume: 1, pitch: 1, to: null, ...extra });

// ── Synthesized sounds ────────────────────────────────────────────────────────

describe('synthesized sounds', () => {
  it('every built-in is valid, audible, and as long as its duration', () => {
    for (const [name, spec] of Object.entries(SYNTH_PRESETS)) {
      expect(synthProblems(spec), name).toEqual([]);
      const stats = synthStats(renderSynth(spec, 16000), 16000);
      expect(stats.peak, name).toBeGreaterThan(0.1);
      expect(stats.rms, name).toBeGreaterThan(0.01);
      expect(stats.seconds, name).toBeCloseTo(synthSeconds(spec), 2);
    }
  });

  it('the SDK\'s Synth class names exactly the built-ins', async () => {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync(p: string, e: 'utf8'): string };
    const stub = fs.readFileSync(new URL('../../../../../../sdk/parallax/__init__.pyi', import.meta.url).pathname, 'utf8');
    const body = /^class Synth:\n([\s\S]*?)\n\nclass /m.exec(stub)![1]!;
    expect([...body.matchAll(/^    (\w+): SoundRef$/gm)].map((m) => m[1])).toEqual(SYNTH_PRESET_NAMES);
  });

  it('a built-in plays with its spec and no file; the recording can measure it', () => {
    const g = setup();
    play(g.ctx, 'synth/hit_metal');
    g.steps();
    const [hit] = g.out.playsOf('synth/hit_metal');
    expect(hit).toMatchObject({ file: null, volume: 1, delay: 0 });
    expect(hit!.synth).toBe(SYNTH_PRESETS['hit_metal']);
    expect(g.out.stats(hit!)!.rms).toBeGreaterThan(0.05);
  });

  it('a .synth.json is a sound under its folder: a spec, or a preset changed; data-only runs hear it too', () => {
    const extra = {
      'assets/sfx/laser.synth.json': { duration: 0.3, layers: [{ wave: 'square', freq: 880, freq_end: 220, decay: 0.25, sustain: 0 }] },
      'assets/sfx/clang.synth.json': { preset: 'hit_metal', gain: 0.4 },
    };
    for (const assets of [undefined, null]) {
      const g = setup({ extra: { ...extra, 'assets/audio.json': { 'sfx/laser': { volume: 0.5 } } }, assets });
      play(g.ctx, 'sfx/laser');
      play(g.ctx, 'sfx/clang');
      g.steps();
      expect(g.out.playsOf('sfx/laser')[0]).toMatchObject({ volume: 0.5, file: null, synth: { duration: 0.3 } });
      expect(g.out.playsOf('sfx/clang')[0]!.synth).toEqual({ ...SYNTH_PRESETS['hit_metal'], gain: 0.4 });
    }
  });

  it('a bad spec fails at load with PP3513 and the file; unknown built-ins suggest the closest', () => {
    expect(() => setup({ extra: { 'assets/sfx/bad.synth.json': { duration: 0.2, layers: [{ wave: 'sqare' }] } } }))
      .toThrow(/PP3513.*assets\/sfx\/bad\.synth\.json.*sqare/);
    expect(() => setup({ extra: { 'assets/sfx/bad.synth.json': { preset: 'hit_metl' } } })).toThrow(/PP2063.*bad\.synth\.json.*hit_metl/);
    expect(() => setup({ extra: { 'assets/sfx/bad.synth.json': '{ not json' } })).toThrow(/PP3513/);
    const g = setup();
    expect(() => play(g.ctx, 'synth/zapp')).toThrow(/PP2063.*"zapp"/);
    expect(() => g.ctx.music('synth/zap', 1)).toThrow(/PP3500.*not a music track/);
  });

  it('a .synth.json next to a recording of the same name is PP3510', () => {
    expect(() => setup({ extra: { 'assets/sfx/hit.synth.json': { preset: 'hit_wood' } } })).toThrow(/PP3510.*sfx\/hit/);
  });

  it('an AudioSource can loop a built-in (a motor bed)', () => {
    const g = setup({ extra: { 'prefabs/car.prefab.json': { components: { audio_source: { sound: 'synth/motor_car' } } } },
      scene: { entities: [{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }, { prefab: 'car', id: 'car', at: [1, 0, 0] }] } });
    g.steps();
    expect(g.out.loops.map((l) => l.sound)).toEqual(['synth/motor_car']);
  });
});

// ── Layered music ─────────────────────────────────────────────────────────────

describe('layered music', () => {
  const layers = [{ track: 'music/drums', at: 0.4 }, { track: 'music/brass', at: 0.8, volume: 0.5 }];

  it('starts the stems with the track at the intensity\'s gains; intensity fades them in and out', () => {
    const g = setup();
    g.ctx.music('music/calm', 2, { layers });
    g.steps();
    expect(g.out.music).toBe('music/calm');
    expect(g.out.musicChanges.at(-1)).toMatchObject({ track: 'music/calm', volume: 0.5, layers: ['music/drums', 'music/brass'] });
    expect(g.out.musicLayers).toEqual([{ track: 'music/drums', volume: 1, gain: 0 }, { track: 'music/brass', volume: 0.5, gain: 0 }]);
    g.ctx.setIntensity(0.5, 1);
    g.steps();
    expect(g.out.musicLayers.map((l) => l.gain)).toEqual([1, 0]);
    const sent = g.out.frames.at(-1)!.commands.find((c) => c.kind === 'music_gains');
    expect(sent).toEqual({ kind: 'music_gains', gains: [1, 0], fade: 1 });
    g.steps(30);
    expect(g.plugin.engine.musicGains[0]).toBeCloseTo(0.5, 1);
    g.steps(40);
    expect(g.plugin.engine.musicGains).toEqual([1, 0]);
    // The same piece with the same stems: no restart, nothing sent when the intensity holds.
    const changes = g.out.musicChanges.length;
    g.ctx.music('music/calm', 2, { layers });
    g.ctx.setIntensity(0.5, 1);
    g.steps(2);
    expect(g.out.musicChanges).toHaveLength(changes);
    g.ctx.setIntensity(1, 0);
    g.steps();
    expect(g.plugin.engine.musicGains).toEqual([1, 1]);
  });

  it('snapshots keep the intensity; a restore restarts the piece at its gains', () => {
    const g = setup();
    g.ctx.music('music/calm', 0, { layers });
    g.ctx.setIntensity(0.9, 0);
    g.steps();
    const saved = g.kernel.snapshot();
    g.ctx.setIntensity(0, 0);
    g.steps();
    g.kernel.restore(saved);
    g.steps();
    expect(g.plugin.engine.intensity).toBe(0.9);
    expect(g.out.musicLayers.map((l) => l.gain)).toEqual([1, 1]);
  });

  it('checks the stems and the intensity (PP3516)', () => {
    const g = setup();
    expect(() => g.ctx.music('music/calm', 1, { layers: [{ track: 'music/drums', at: 2 }] })).toThrow(/PP3516/);
    expect(() => g.ctx.music(null, 1, { layers })).toThrow(/PP3516/);
    expect(() => g.ctx.music('music/calm', 1, { layers: [{ track: 'sfx/hit', at: 0 }] })).toThrow(/PP3500/);
    expect(() => g.ctx.setIntensity(1.5)).toThrow(/PP3516/);
  });

  it('pure gain math: thresholds and the linear ramp', () => {
    expect(layerGains([{ at: 0, volume: 1 }, { at: 0.5, volume: 0.7 }], 0.5)).toEqual([1, 0.7]);
    expect(layerGains([{ at: 0, volume: 1 }, { at: 0.5, volume: 0.7 }], 0.49)).toEqual([1, 0]);
    expect(rampGain(0, 1, 0.5, 2)).toBe(0.25);
    expect(rampGain(1, 0, 3, 2)).toBe(0);
    expect(rampGain(0, 1, 0, 0)).toBe(1);
  });
});

// ── Beat clock ────────────────────────────────────────────────────────────────

describe('beat clock', () => {
  it('a track with bpm fires `beat` every beat with its bar; music without bpm stops the clock', () => {
    const g = setup();
    g.ctx.music('music/calm', 0, { bpm: 120, beatsPerBar: 3 });
    g.steps(121); // two seconds and a frame: beats 0..4
    expect(g.beats).toEqual([
      { beat: 0, bar: 0, beat_in_bar: 0 }, { beat: 1, bar: 0, beat_in_bar: 1 }, { beat: 2, bar: 0, beat_in_bar: 2 },
      { beat: 3, bar: 1, beat_in_bar: 0 }, { beat: 4, bar: 1, beat_in_bar: 1 },
    ]);
    expect(g.plugin.engine.bpm).toBe(120);
    expect(g.plugin.engine.beat).toBeCloseTo(4.033, 2);
    g.ctx.music('music/drums', 0);
    g.steps(60);
    expect(g.beats).toHaveLength(5);
    expect(g.plugin.engine.beat).toBe(null);
  });

  it('quantize= delays a one-shot to the next boundary; without a clock it is PP3514', () => {
    const g = setup();
    expect(() => play(g.ctx, 'sfx/hit', { quantize: 1 })).toThrow(/PP3514/);
    g.ctx.music('music/calm', 0, { bpm: 120, offset: 0.1 });
    g.steps(10); // beat 0 at 0.1 s after the music started; now ~0.167 s in
    play(g.ctx, 'sfx/hit', { quantize: 1 });
    play(g.ctx, 'sfx/hit', { quantize: 4 });
    g.steps();
    const [beat, bar] = g.out.playsOf('sfx/hit');
    const now = g.out.frames.at(-1)!.time;
    const start = 0.1 + 1 / 60; // the music was asked for during frame 1
    expect(now + beat!.delay).toBeCloseTo(start + 0.5, 6);
    expect(now + bar!.delay).toBeCloseTo(start + 2, 6);
  });

  it('set_tempo keeps the beat continuous, or starts a clock at beat 0 now', () => {
    const g = setup();
    g.ctx.setTempo(60);
    g.steps(61);
    expect(g.beats.map((b) => b.beat)).toEqual([0, 1]);
    g.ctx.setTempo(120);
    const before = g.plugin.engine.beat!;
    g.steps(60);
    expect(g.plugin.engine.beat! - before).toBeCloseTo(2, 6);
    expect(() => g.ctx.setTempo(0)).toThrow(/PP3501/);
  });

  it('a restore puts the clock back at the beat it was on', () => {
    const g = setup();
    g.ctx.music('music/calm', 0, { bpm: 100 });
    g.steps(50);
    const saved = g.kernel.snapshot();
    const beat = g.plugin.engine.beat!;
    g.steps(100);
    g.kernel.restore(saved);
    expect(g.plugin.engine.beat).toBeCloseTo(beat, 9);
  });

  it('pure tempo math: seconds ⇄ beats, a tempo change without a jump, the grid', () => {
    let map = tempoMap(120, 1);
    expect(timeAtBeat(map, 4)).toBe(3);
    expect(beatAtTime(map, 0.5)).toBe(-1);
    map = changeTempo(map, 3, 60);
    expect(beatAtTime(map, 3)).toBeCloseTo(4, 9);
    expect(beatAtTime(map, 4)).toBeCloseTo(5, 9);
    expect(nextBoundary(map, 3.2, 4)).toBeCloseTo(3 + 4, 9);
    const { beats, next } = collectBeats(map, 3, 4.5);
    expect(beats.map((b) => [b.beat, b.bar, b.beatInBar])).toEqual([[3, 0, 3], [4, 1, 0], [5, 1, 1]]);
    expect(next).toBe(6);
  });
});

// ── Voices ────────────────────────────────────────────────────────────────────

describe('voice budget', () => {
  it('beyond max_voices the faintest loops go virtual (volume 0) and come back when room frees', () => {
    const g = setup({ scene: { entities: [
      { prefab: 'camera', id: 'cam', at: [0, 0, 0] },
      { prefab: 'engine', id: 'near', at: [1, 0, 0] }, { prefab: 'engine', id: 'mid', at: [10, 0, 0] }, { prefab: 'engine', id: 'far', at: [30, 0, 0] },
    ] } });
    g.ctx.max_voices = 2;
    g.steps(2);
    const heard = (): number[] => g.out.loops.map((l) => (l.volume > 0 ? 1 : 0));
    expect(heard()).toEqual([1, 1, 0]);
    expect(g.plugin.engine.voiceStats).toMatchObject({ real: 2, virtual: 1 });
    g.kernel.destroy(g.id('near'));
    g.steps(2);
    expect(heard()).toEqual([1, 1]);
    expect(() => { g.ctx.max_voices = 0; }).toThrow(/PP3515/);
  });

  it('a sound\'s audio.json limit stops its oldest one-shot; priority decides who is dropped when full', () => {
    const h = setup({ audioJson: { 'sfx/hit': { limit: 2, priority: 10 } } });
    for (let i = 0; i < 3; i++) play(h.ctx, 'sfx/hit');
    h.steps();
    const commands = h.out.frames.at(-1)!.commands;
    const plays = commands.filter((c) => c.kind === 'play').map((c) => (c as { voice: number }).voice);
    const stops = commands.filter((c) => c.kind === 'stop').map((c) => (c as { voice: number }).voice);
    expect(plays).toHaveLength(3);
    expect(stops).toEqual([plays[0]]);
    h.ctx.max_voices = 2;
    play(h.ctx, 'synth/zap'); // priority 64 outranks the remaining hits (10): it steals one
    h.steps();
    expect(h.plugin.engine.voiceStats.stolen).toBe(2);
    play(h.ctx, 'sfx/hit'); // full of a zap and an older hit, which outrank it: never started
    h.steps();
    expect(h.plugin.engine.voiceStats.dropped).toBe(1);
    expect(h.out.playsOf('sfx/hit')).toHaveLength(3);
  });

  it('audio.json priority and limit are checked (PP1002)', () => {
    const project = loadProject(files({ 'assets/audio.json': { 'sfx/hit': { priority: 300, limit: 0.5 }, 'sfx/engine': { priority: 10, limit: 3 } } }));
    expect(project.diagnostics.map((d) => [d.code, d.pointer])).toEqual([['PP1002', '/sfx~1hit/priority'], ['PP1002', '/sfx~1hit/limit']]);
    expect(project.audio.get('sfx/engine')).toEqual({ priority: 10, limit: 3 });
  });

  it('pure budget: a weaker one-shot is dropped when the budget is full of stronger ones', () => {
    const b = new VoiceBudget();
    b.max = 2;
    const shot = (voice: number, priority: number) => ({ voice, priority, audibility: 1, sound: `s${voice}`, ends: 10, limit: undefined });
    expect(b.admit(shot(1, 80), 0, []).start).toBe(true);
    expect(b.admit(shot(2, 80), 0, []).start).toBe(true);
    expect(b.admit(shot(3, 10), 0, [])).toEqual({ start: false, stop: [] });
    // Equal rank: the older one stays, the newer gives way.
    expect(b.admit(shot(4, 90), 0, [])).toEqual({ start: true, stop: [2] });
    // Once they end, there is room again.
    expect(b.admit(shot(5, 10), 11, []).start).toBe(true);
    expect(b.stats).toMatchObject({ dropped: 1, stolen: 1, oneShots: 1 });
  });
});

// ── Ambience ──────────────────────────────────────────────────────────────────

const CLEAR: WeatherConditions = {
  preset: 'clear', rain: 0, snow: 0, hail: 0, clouds: 0, overcast: 0, fog: 0, wind: 0, lightning: 0, wetness: 0,
  snowCover: 0, visibility: 10000, friction: 1, flash: 0,
};

function river(points: readonly [number, number, number][], flow: number): WaterBodyInfo {
  return {
    entity: null, kind: 'river', level: 0, center: Vec3.ZERO, halfX: 0, halfZ: 0, yaw: 0, shape: 'rect', depth: 2, waves: new Float32Array(),
    deep: [0, 0, 0], shallow: [0, 0, 0], clarity: 1, foam: 0, caustics: 0, ripple: 1, calmDistance: 0, width: 6, flow, version: 1,
    course: { xs: Float64Array.from(points.map((p) => p[0])), ys: Float64Array.from(points.map((p) => p[1])), zs: Float64Array.from(points.map((p) => p[2])) },
  };
}

function world(state: { weather: WeatherConditions; wind: number; bodies: WaterBodyInfo[] }): KernelPlugin {
  return {
    id: 'fake_world',
    install(kernel) {
      kernel.provide(WEATHER_SERVICE, { conditions: () => state.weather, recentStrikes: () => [], sheltered: () => false });
      kernel.provide(WIND_SERVICE, {
        settings: () => { throw new Error('unused'); },
        sample: (_x: number, _z: number, out = new Float64Array(2)) => { out[0] = state.wind; out[1] = 0; return out; },
        mean: (out = new Float64Array(2)) => { out[0] = state.wind; out[1] = 0; return out; },
        set: () => {},
      });
      kernel.provide(WATER_WORLD_SERVICE, {
        bodies: () => state.bodies, disturbances: () => [], heightAt: () => undefined, submerged: () => undefined, splash: () => {},
      });
    },
  };
}

describe('ambience', () => {
  it('rain and wind follow the weather; a river babbles from its nearest point; it stops when they do', () => {
    const state = { weather: { ...CLEAR, rain: 0.8 }, wind: 10, bodies: [river([[-50, 0, 20], [50, 0, 20]], 4)] };
    const g = setup({ plugins: [world(state)] });
    g.steps();
    const loops = (): Record<string, unknown> => Object.fromEntries(g.out.loops.map((l) => [l.sound, { volume: l.volume, pitch: l.pitch, position: l.position }]));
    expect(loops()).toEqual({
      'synth/rain': { volume: 0.56, pitch: 1, position: null },
      'synth/wind': { volume: 0.3, pitch: 1.03, position: null },
      'synth/river': { volume: 1, pitch: 1, position: [0, 0, 20] },
    });
    state.weather = CLEAR;
    state.wind = 0;
    state.bodies = [];
    g.steps();
    expect(g.out.loops).toEqual([]);
  });

  it('the scene\'s own weather sounds replace the synthesized rain and thunder; ambience = False silences it', () => {
    const state = { weather: { ...CLEAR, rain: 1 }, wind: 0, bodies: [] };
    const own = setup({ plugins: [world(state)], scene: { environment: { weather: { preset: 'storm', sounds: { rain: 'sfx/hit', thunder: 'sfx/hit' } } }, entities: [] } });
    own.kernel.emit({ id: 'thunder' }, { point: Vec3.ZERO, strength: 1, distance: 100 });
    own.steps();
    expect(own.out.played()).toEqual([]);
    const g = setup({ plugins: [world(state)] });
    g.kernel.emit(g.kernel.registry.events.get('thunder')!, { point: Vec3.ZERO, strength: 1, distance: 1500 });
    g.steps();
    expect(g.out.played().sort()).toEqual(['synth/rain', 'synth/thunder']);
    expect(g.out.playsOf('synth/thunder')[0]).toMatchObject(thunderClap(1, 1500));
    g.ctx.ambience = false;
    g.steps();
    expect(g.out.loops).toEqual([]);
    const saved = g.kernel.snapshot();
    g.ctx.ambience = true;
    g.kernel.restore(saved);
    expect(g.ctx.ambience).toBe(false);
  });

  it('pure geometry: nearest course point and lake edge', () => {
    const r = river([[0, 0, 0], [10, 0, 0], [10, 0, 10]], 1);
    expect(nearestOnCourse(r.course!, new Vec3(12, 5, 5))).toMatchObject({ d: 2 });
    const lake: WaterBodyInfo = { ...r, kind: 'lake', course: null, center: new Vec3(0, 1, 0), halfX: 5, halfZ: 5, shape: 'rect', level: 1 };
    const edge = nearestOnArea(lake, new Vec3(20, 3, 0));
    expect([edge.x, edge.y, edge.z]).toEqual([5, 1, 0]);
    const under = nearestOnArea({ ...lake, shape: 'ellipse' }, new Vec3(1, 3, 1));
    expect([under.x, under.z]).toEqual([1, 1]);
  });
});
