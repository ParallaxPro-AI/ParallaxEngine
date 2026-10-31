import { describe, expect, it } from 'vitest';
import { Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { AudioPlay, EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, GameDefinition, ResourceDef } from '../../kernel/index.js';
import { HeadlessAudio } from '../../../platform/headless/audio.js';
import { AUDIO_SERVICE } from '../../services/index.js';
import { audio } from './index.js';
import type { AudioNamespace, AudioOptions } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** Test stand-ins for the visuals plugin's components (SDK field names) and the api's Settings. */
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
  id: 'settings',
  keep: 'profile',
  schema: {
    master_volume: t.number({ default: 1 }), music_volume: t.number({ default: 1 }), sfx_volume: t.number({ default: 1 }),
  },
};

const SOUNDS = [
  'assets/sfx/hit.ogg', 'assets/sfx/jump.ogg', 'assets/sfx/key_type.ogg', 'assets/sfx/engine_loop.ogg',
  'assets/music/prism_run.ogg', 'assets/music/boss.mp3',
];

interface Setup {
  readonly kernel: Kernel;
  readonly plugin: ReturnType<typeof audio>;
  readonly out: HeadlessAudio;
  readonly ctx: AudioNamespace;
  id(placed: string): EntityId;
  steps(n?: number): void;
}

function setup(options: {
  audioJson?: Record<string, unknown>;
  prefabs?: Record<string, unknown>;
  scenes?: Record<string, unknown>;
  start?: string;
  assets?: readonly string[] | null;
  mode?: '2d' | '3d';
  seed?: number;
} = {}): Setup {
  const project = loadProject(files({
    'assets/audio.json': options.audioJson ?? {
      'sfx/hit': { volume: 0.4 },
      'sfx/key_type': { volume: [0.5, 0.75], pitch: [0.96, 1.1] },
      'music/prism_run': { volume: 0.28 },
    },
    'prefabs/camera.prefab.json': { components: { camera: {} } },
    'prefabs/thing.prefab.json': { components: {} },
    ...Object.fromEntries(Object.entries(options.prefabs ?? {}).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    ...Object.fromEntries(Object.entries(options.scenes ?? {
      main: { music: 'music/prism_run', entities: [{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }] },
    }).map(([id, s]) => [`scenes/${id}/scene.json`, s])),
  }));
  expect(project.diagnostics).toEqual([]);
  const out = new HeadlessAudio();
  const pluginOptions: AudioOptions = {
    output: out,
    assets: options.assets === undefined ? SOUNDS : options.assets,
    defaults: project.audio,
    seed: options.seed ?? 7,
    mode: options.mode ?? '3d',
  };
  const plugin = audio(pluginOptions);
  const game: GameDefinition = {
    components: [AUDIO_SOURCE_DEF, CAMERA_DEF], resources: [SETTINGS_DEF], events: [], behaviors: [], systems: [],
  };
  const kernel = new Kernel({ project, game, plugins: [plugin], context: {}, fixedStep: DT });
  const ctx = plugin.namespace!.create(kernel) as AudioNamespace;
  kernel.start(options.start ?? 'main');
  return {
    kernel, plugin, out, ctx,
    id: (placed) => [...kernel.world.live()].find((r) => r.placedId === placed)!.id,
    steps: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const play = (ctx: AudioNamespace, sound: string, extra: Partial<Parameters<AudioNamespace['play']>[0]> = {}): void =>
  ctx.play({ sound, at: null, volume: 1, pitch: 1, to: null, ...extra });

describe('audio.json banks and ducking', () => {
  const audioJson = {
    'sfx/hit': { volume: 0.4, bank: 'boss' },
    'sfx/key_type': { bank: 'boss' },
    'sfx/captain_line': { duck: true },
    'music/prism_run': { volume: 0.28 },
  };

  it('ducks by audio.json default; the call overrides it', () => {
    const g = setup({ audioJson, assets: [...SOUNDS, 'assets/sfx/captain_line.ogg'] });
    play(g.ctx, 'sfx/captain_line');
    play(g.ctx, 'sfx/hit');
    play(g.ctx, 'sfx/captain_line', { duck: false });
    g.steps();
    expect(g.out.playsOf('sfx/captain_line').map((p) => p.duck)).toEqual([true, false]);
    expect(g.out.playsOf('sfx/hit')[0]!.duck).toBe(false);
  });

  it('groups sounds into banks; an unknown bank is PP3512 with a suggestion', () => {
    const { plugin } = setup({ audioJson, assets: [...SOUNDS, 'assets/sfx/captain_line.ogg'] });
    expect(plugin.engine.bankSounds('boss', 'test')).toEqual(['sfx/hit', 'sfx/key_type']);
    expect(() => plugin.engine.bankSounds('bos', 'test')).toThrow(/PP3512[\s\S]*"boss"/);
  });
});

describe('one-shots', () => {
  it('records a play with the audio.json default multiplied by the call', () => {
    const g = setup();
    play(g.ctx, 'sfx/hit', { volume: 0.5 });
    g.steps();
    const [hit] = g.out.playsOf('sfx/hit');
    expect(hit).toMatchObject({
      frame: 1, sound: 'sfx/hit', file: 'assets/sfx/hit.ogg', volume: 0.2, pitch: 1, position: null, loop: false,
      attenuation: 1, pan: 0, source: 'one_shot', to: null,
    });
    expect(hit!.time).toBeCloseTo(DT);
  });

  it('accepts a sound by its handle, with or without defaults; a file path or bare name is PP2063', () => {
    const g = setup();
    expect(() => play(g.ctx, 'assets/sfx/hit.ogg')).toThrow(/PP2063[\s\S]*file path[\s\S]*"sfx\/hit"/);
    expect(() => play(g.ctx, 'hit')).toThrow(/PP2063[\s\S]*bare name[\s\S]*"sfx\/hit"/);
    play(g.ctx, 'sfx/hit');
    play(g.ctx, 'sfx/jump', { pitch: 1.5 });
    g.steps();
    expect(g.out.played()).toEqual(['sfx/hit', 'sfx/jump']);
    expect(g.out.playsOf('sfx/jump')[0]).toMatchObject({ volume: 1, pitch: 1.5 });
  });

  it('draws ranged volume and pitch from its own seeded source, deterministically', () => {
    const run = (seed: number): Array<[number, number]> => {
      const g = setup({ seed });
      for (let i = 0; i < 20; i++) play(g.ctx, 'sfx/key_type');
      g.steps();
      return g.out.plays.map((p) => [p.volume, p.pitch]);
    };
    const a = run(7);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
    for (const [volume, pitch] of a) {
      expect(volume).toBeGreaterThanOrEqual(0.5);
      expect(volume).toBeLessThanOrEqual(0.75);
      expect(pitch).toBeGreaterThanOrEqual(0.96);
      expect(pitch).toBeLessThanOrEqual(1.1);
    }
    expect(new Set(a.map(([v]) => v)).size).toBeGreaterThan(10);
  });

  it('fixed levels draw nothing, so they never shift another sound\'s variation', () => {
    const g1 = setup();
    play(g1.ctx, 'sfx/key_type');
    const g2 = setup();
    play(g2.ctx, 'sfx/hit');
    play(g2.ctx, 'sfx/jump');
    play(g2.ctx, 'sfx/key_type');
    g1.steps();
    g2.steps();
    expect(g2.out.playsOf('sfx/key_type')[0]!.volume).toBe(g1.out.playsOf('sfx/key_type')[0]!.volume);
  });

  it('an unknown sound is PP2063 with the closest name', () => {
    const g = setup();
    expect(() => play(g.ctx, 'sfx/jmup')).toThrow(/PP2063[\s\S]*unknown sound "sfx\/jmup"[\s\S]*Did you mean "sfx\/jump"/);
  });

  it('music is not a sound effect, and malformed names are PP3500', () => {
    const g = setup();
    expect(() => play(g.ctx, 'music/boss')).toThrow(/PP3500[\s\S]*music track[\s\S]*ctx\.audio\.music/);
    expect(() => play(g.ctx, 'images/hit')).toThrow(/PP3500/);
    expect(() => play(g.ctx, 'sfx/Hit Sound')).toThrow(/PP3500/);
  });

  it('bad levels are PP3501', () => {
    const g = setup();
    expect(() => play(g.ctx, 'sfx/hit', { volume: -1 })).toThrow(/PP3501/);
    expect(() => play(g.ctx, 'sfx/hit', { pitch: 0 })).toThrow(/PP3501/);
    expect(() => play(g.ctx, 'sfx/hit', { volume: Number.NaN })).toThrow(/PP3501/);
  });

  it('without asset files, references are checked for form and play with no file', () => {
    const g = setup({ assets: null });
    play(g.ctx, 'sfx/anything');
    g.steps();
    expect(g.out.plays[0]).toMatchObject({ sound: 'sfx/anything', file: null });
    expect(g.out.preloaded).toEqual([]);
    expect(() => play(g.ctx, 'music/x')).toThrow(/PP3500/);
  });

  it('preloads every sound file at install', () => {
    expect(setup().out.preloaded).toEqual(SOUNDS);
  });

  it('two files for one sound are PP3510', () => {
    expect(() => setup({ assets: ['assets/sfx/hit.ogg', 'assets/sfx/hit.wav'] })).toThrow(/PP3510/);
  });
});

describe('positional sound', () => {
  it('attenuates with distance and pans along the camera\'s right', () => {
    const g = setup();
    play(g.ctx, 'sfx/jump', { at: new Vec3(2, 0, 0) });
    play(g.ctx, 'sfx/jump', { at: new Vec3(-12, 0, 0) });
    play(g.ctx, 'sfx/jump', { at: new Vec3(0, 0, 200) });
    g.steps();
    const [near, left, far] = g.out.playsOf('sfx/jump');
    expect(near).toMatchObject({ position: [2, 0, 0], attenuation: 1 });
    expect(near!.pan).toBeCloseTo(0.8 * 2 / 3);
    expect(left!.attenuation).toBeCloseTo(3 / 12);
    expect(left!.pan).toBeCloseTo(-0.8);
    expect(far).toMatchObject({ attenuation: 0, pan: 0 });
  });

  it('follows the camera\'s rotation: turned 180°, right is left', () => {
    const g = setup();
    g.kernel.world.require(g.id('cam')).transform.rotation = Quat.from_euler(new Vec3(0, 180, 0));
    play(g.ctx, 'sfx/jump', { at: new Vec3(12, 0, 0) });
    g.steps();
    expect(g.out.plays[0]!.pan).toBeCloseTo(-0.8);
  });

  it('2D measures in the x/y plane: the camera\'s z distance does not attenuate', () => {
    const g = setup({
      mode: '2d',
      scenes: { main: { entities: [{ prefab: 'camera', id: 'cam', at: [0, 0, -50] }] } },
    });
    play(g.ctx, 'sfx/jump', { at: new Vec2(5, 0) });
    g.steps();
    expect(g.out.plays[0]).toMatchObject({ attenuation: 1, position: [5, 0, 0] });
    expect(g.out.plays[0]!.pan).toBeCloseTo(0.4);
  });

  it('at= an entity is its position at the call; one destroyed this phase still has one', () => {
    const g = setup({ scenes: { main: { entities: [
      { prefab: 'camera', id: 'cam' }, { prefab: 'thing', id: 'thing', at: [1, 2, 3] },
    ] } } });
    const thing = g.id('thing');
    g.kernel.destroy(thing);
    play(g.ctx, 'sfx/hit', { at: thing });
    g.steps();
    expect(g.out.plays[0]!.position).toEqual([1, 2, 3]);
    expect(() => play(g.ctx, 'sfx/hit', { at: thing })).toThrow(/PP3502/);
  });

  it('with no camera, positional sounds play centered', () => {
    const g = setup({ scenes: { main: { entities: [] } } });
    play(g.ctx, 'sfx/hit', { at: new Vec3(30, 0, 0) });
    g.steps();
    expect(g.out.plays[0]).toMatchObject({ attenuation: 1, pan: 0 });
    expect(g.out.listener).toBeNull();
  });
});

describe('music', () => {
  const scenes = {
    main: { music: 'music/prism_run', entities: [] },
    same: { music: 'music/prism_run', entities: [] },
    other: { music: 'music/boss', entities: [] },
    quiet: { entities: [] },
  };

  it('starts the scene\'s music at its audio.json volume, crossfades on scene change, keeps the same track', () => {
    const g = setup({ scenes });
    g.steps();
    expect(g.out.music).toBe('music/prism_run');
    expect(g.out.musicChanges).toEqual([{ frame: 1, time: DT, track: 'music/prism_run', volume: 0.28, fade: 0 }]);
    g.kernel.requestScene('same');
    g.steps(2);
    expect(g.out.musicChanges).toHaveLength(1);
    g.kernel.requestScene('other');
    g.steps(2);
    expect(g.out.musicChanges[1]).toMatchObject({ track: 'music/boss', volume: 1, fade: 1 });
    g.kernel.requestScene('quiet');
    g.steps(2);
    expect(g.out.musicChanges[2]).toMatchObject({ track: null, fade: 1 });
  });

  it('is silent while logic is off (edit mode) and starts the scene\'s music when it comes back on', () => {
    const g = setup({ scenes });
    g.kernel.setLogic(false);
    g.steps(2);
    expect(g.out.music).toBeNull();
    g.kernel.setLogic(true);
    g.steps();
    expect(g.out.music).toBe('music/prism_run');
    g.kernel.setLogic(false);
    g.steps();
    expect(g.out.music).toBeNull();
  });

  it('ctx.audio.music overrides until the next scene load; None fades out', () => {
    const g = setup({ scenes });
    g.steps();
    g.ctx.music('music/boss', 0.5);
    g.steps();
    expect(g.out.musicChanges[1]).toMatchObject({ track: 'music/boss', fade: 0.5 });
    g.ctx.music(null, 2);
    g.steps();
    expect(g.out.musicChanges[2]).toMatchObject({ track: null, fade: 2 });
    g.kernel.requestScene('main');
    g.steps(2);
    expect(g.out.music).toBe('music/prism_run');
  });

  it('unknown and misfiled tracks are coded errors', () => {
    const g = setup({ scenes });
    expect(() => g.ctx.music('music/bos', 1)).toThrow(/PP2063[\s\S]*Did you mean "music\/boss"/);
    expect(() => g.ctx.music('sfx/hit', 1)).toThrow(/PP3500/);
    expect(() => g.ctx.music('music/boss', -1)).toThrow(/PP3501/);
    expect(() => setup({ scenes: { main: { music: 'music/prism_rn', entities: [] } } })).toThrow(/PP2063[\s\S]*prism_run/);
  });
});

describe('AudioSource', () => {
  const prefabs = {
    car: { components: { audio_source: { sound: 'sfx/engine_loop', loop: true, playing: false, spatial: true } } },
    alarm: { components: { audio_source: { sound: 'sfx/hit', loop: false, playing: true, spatial: false, volume: 0.5 } } },
  };
  const scene = (extra: unknown[]) => ({ main: { entities: [{ prefab: 'camera', id: 'cam' }, ...extra] } });

  it('a loop plays while playing is true, follows its entity, and stops when turned off', () => {
    const g = setup({ prefabs, scenes: scene([{ prefab: 'car', id: 'car', at: [2, 0, 0] }]) });
    g.steps();
    expect(g.out.loops).toEqual([]);
    const car = g.kernel.world.require(g.id('car'));
    const source = car.components.get('audio_source')!;
    source['playing'] = true;
    g.steps();
    expect(g.out.loops).toHaveLength(1);
    expect(g.out.plays[0]).toMatchObject({ sound: 'sfx/engine_loop', loop: true, source: 'entity', position: [2, 0, 0] });
    source['pitch'] = 1.4;
    car.transform.position = new Vec3(-2, 0, 0);
    g.steps();
    expect(g.out.loops[0]).toMatchObject({ pitch: 1.4, position: [-2, 0, 0] });
    expect(g.out.loops[0]!.pan).toBeLessThan(0);
    const frames = g.out.frames.length;
    g.steps(3);
    expect(g.out.frames.length).toBe(frames);
    source['playing'] = false;
    g.steps();
    expect(g.out.loops).toEqual([]);
    expect(g.out.plays).toHaveLength(1);
  });

  it('a non-looping source plays once per playing = true', () => {
    const g = setup({ prefabs, scenes: scene([{ prefab: 'alarm', id: 'alarm' }]) });
    g.steps(5);
    expect(g.out.playsOf('sfx/hit')).toHaveLength(1);
    expect(g.out.plays[0]).toMatchObject({ volume: 0.2, position: null, loop: false });
    const source = g.kernel.world.require(g.id('alarm')).components.get('audio_source')!;
    source['playing'] = false;
    g.steps();
    source['playing'] = true;
    g.steps();
    expect(g.out.playsOf('sfx/hit')).toHaveLength(2);
  });

  it('stops with its entity, with its component, and on scene unload', () => {
    const g = setup({ prefabs, scenes: { ...scene([{ prefab: 'car', id: 'a' }, { prefab: 'car', id: 'b' }, { prefab: 'car', id: 'c' }]), quiet: { entities: [] } } });
    for (const id of ['a', 'b', 'c']) g.kernel.world.require(g.id(id)).components.get('audio_source')!['playing'] = true;
    g.steps();
    expect(g.out.loops).toHaveLength(3);
    g.kernel.destroy(g.id('a'));
    g.kernel.removeComponent(g.id('b'), 'audio_source');
    g.steps();
    expect(g.out.loops).toHaveLength(1);
    g.kernel.requestScene('quiet');
    g.steps(2);
    expect(g.out.loops).toEqual([]);
  });

  it('is muted while game time is frozen', () => {
    const g = setup({ prefabs, scenes: scene([{ prefab: 'car', id: 'car' }]) });
    g.kernel.world.require(g.id('car')).components.get('audio_source')!['playing'] = true;
    g.steps();
    g.kernel.setFrozen(true);
    g.steps();
    expect(g.out.loops[0]!.volume).toBe(0);
    g.kernel.setFrozen(false);
    g.steps();
    expect(g.out.loops[0]!.volume).toBe(1);
  });

  it('a playing source without a sound, or with a non-boolean flag, is PP3504', () => {
    const g = setup({ prefabs: { mute: { components: { audio_source: {} } } }, scenes: scene([{ prefab: 'mute' }]) });
    expect(() => g.steps()).toThrow(/PP3504[\s\S]*no sound/);
  });
});

describe('Settings volumes', () => {
  it('sends the buses first, then whenever Settings change', () => {
    const g = setup();
    g.steps();
    expect(g.out.buses).toEqual({ master: 1, music: 1, sfx: 1 });
    const settings = g.kernel.resource('settings');
    settings['music_volume'] = 0.5;
    settings['master_volume'] = 0.8;
    g.steps();
    expect(g.out.buses).toEqual({ master: 0.8, music: 0.5, sfx: 1 });
    const frames = g.out.frames.length;
    g.steps(2);
    expect(g.out.frames.length).toBe(frames);
  });

  it('the plugin needs the settings resource (PP3505)', () => {
    const project = loadProject(files({ 'scenes/main/scene.json': { entities: [] } }));
    const plugin = audio({ output: new HeadlessAudio(), assets: null, defaults: project.audio, seed: 1, mode: '2d' });
    const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
    expect(() => new Kernel({ project, game, plugins: [plugin], context: {} })).toThrow(/PP3505/);
  });
});

describe('snapshot and restore', () => {
  it('restores the variation source, the music and entity loops', () => {
    const g = setup({
      prefabs: { car: { components: { audio_source: { sound: 'sfx/key_type', loop: true } } } },
      scenes: { main: { music: 'music/prism_run', entities: [{ prefab: 'camera' }, { prefab: 'car' }] } },
    });
    g.steps();
    const snapshot = g.kernel.snapshot();
    const draws = (): number[] => {
      for (let i = 0; i < 5; i++) play(g.ctx, 'sfx/key_type');
      g.steps();
      return g.out.plays.slice(-5).map((p) => p.volume);
    };
    const first = draws();
    g.ctx.music('music/boss', 1);
    g.steps();
    g.kernel.restore(snapshot);
    g.steps();
    const frame = g.out.frames.at(-1)!;
    expect(frame.commands[0]).toEqual({ kind: 'stop_all' });
    expect(g.out.music).toBe('music/prism_run');
    expect(g.out.loops).toHaveLength(1);
    const restarted = frame.commands.find((c): c is AudioPlay => c.kind === 'play')!;
    expect(restarted.sound.handle).toBe('sfx/key_type');
    expect(draws()).toEqual(first);
  });

  it('a non-looping source that already played stays quiet after a restore', () => {
    const g = setup({
      prefabs: { bell: { components: { audio_source: { sound: 'sfx/hit', loop: false } } } },
      scenes: { main: { entities: [{ prefab: 'bell' }] } },
    });
    g.steps();
    const snapshot = g.kernel.snapshot();
    g.kernel.restore(snapshot);
    g.steps(2);
    expect(g.out.playsOf('sfx/hit')).toHaveLength(1);
  });
});

describe('audio.json values', () => {
  it('out-of-range levels fail at install with PP3501 and a pointer', () => {
    expect(() => setup({ audioJson: { 'sfx/hit': { volume: [0.8, 0.2] } } })).toThrow(/PP3501[\s\S]*lo > hi[\s\S]*\/sfx~1hit\/volume/);
    expect(() => setup({ audioJson: { 'sfx/hit': { pitch: 0 } } })).toThrow(/PP3501/);
    expect(() => setup({ audioJson: { 'sfx/hit': { volume: 40 } } })).toThrow(/PP3501/);
  });

  it('defaults for a sound with no file are PP2063 when the files are known', () => {
    expect(() => setup({ audioJson: { 'sfx/jumpp': { volume: 1 } } })).toThrow(/PP2063[\s\S]*Did you mean "sfx\/jump"/);
    expect(() => setup({ audioJson: { 'sfx/jumpp': { volume: 1 } }, assets: null })).not.toThrow();
  });
});

describe('the audio service (other plugins\' sounds)', () => {
  it('plays a plugin one-shot like ctx.audio.play, but never forwards it to net clients', () => {
    const g = setup();
    const forwarded: string[] = [];
    g.plugin.engine.forwardTo((s) => forwarded.push(s.sound));
    const service = g.kernel.service(AUDIO_SERVICE);
    service.play({ sound: 'sfx/hit', at: new Vec3(3, 0, 0), volume: 0.5 });
    play(g.ctx, 'sfx/jump');
    g.steps();
    expect(g.out.playsOf('sfx/hit')[0]).toMatchObject({ volume: 0.2, loop: false, source: 'one_shot' });
    expect(forwarded).toEqual(['sfx/jump']);
  });

  it('keeps a named loop: its level follows the calls, another sound restarts it, stop ends it; snapshots keep it', () => {
    const g = setup();
    const service = g.kernel.service(AUDIO_SERVICE);
    service.loop('weather.rain', { sound: 'sfx/engine_loop', volume: 0.5 });
    g.steps();
    expect(g.out.loops.map((l) => [l.sound, l.volume])).toEqual([['sfx/engine_loop', 0.5]]);
    service.loop('weather.rain', { sound: 'sfx/engine_loop', volume: 0.8 });
    g.steps();
    expect(g.out.loops.map((l) => [l.sound, l.volume])).toEqual([['sfx/engine_loop', 0.8]]);
    expect(g.out.playsOf('sfx/engine_loop')).toHaveLength(1);
    const saved = g.kernel.snapshot();
    service.loop('weather.rain', { sound: 'sfx/key_type' });
    g.steps();
    expect(g.out.loops.map((l) => l.sound)).toEqual(['sfx/key_type']);
    g.kernel.restore(saved);
    g.steps();
    expect(g.out.loops.map((l) => [l.sound, l.volume])).toEqual([['sfx/engine_loop', 0.8]]);
    service.stop('weather.rain');
    service.stop('nothing');
    g.steps();
    expect(g.out.loops).toEqual([]);
    expect(g.plugin.engine.loops.size).toBe(0);
  });

  it('checks the sound like any other (PP2063 for one that does not exist)', () => {
    const g = setup();
    expect(() => g.kernel.service(AUDIO_SERVICE).loop('x', { sound: 'sfx/rian' })).toThrow(/PP2063/);
  });
});

describe('dispose', () => {
  it('kernel.dispose() stops every voice and the music; a second runtime on the same output plays', () => {
    const g = setup();
    g.kernel.service(AUDIO_SERVICE).loop('weather.rain', { sound: 'sfx/engine_loop' });
    g.steps(2);
    expect(g.out.music).toBe('music/prism_run');
    expect(g.out.loops).toHaveLength(1);
    g.kernel.dispose();
    expect(g.out.loops).toEqual([]);
    expect(g.out.music).toBe(null);
    const project = loadProject(files({ 'prefabs/camera.prefab.json': { components: { camera: {} } }, 'scenes/main/scene.json': { music: 'music/prism_run', entities: [] } }));
    const plugin = audio({ output: g.out, assets: SOUNDS, defaults: project.audio, seed: 1, mode: '3d' });
    const kernel = new Kernel({
      project, game: { components: [AUDIO_SOURCE_DEF, CAMERA_DEF], resources: [SETTINGS_DEF], events: [], behaviors: [], systems: [] },
      plugins: [plugin], context: {}, fixedStep: DT,
    });
    kernel.start('main');
    kernel.step(DT);
    expect(g.out.music).toBe('music/prism_run');
  });
});
