import { beforeEach, describe, expect, it } from 'vitest';
import { Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import { audioPlugin, MusicLayer, Synth } from './audio.js';
import type { AudioApi } from './audio.js';
import { Settings } from './builtins.js';
import { Game } from './game.js';
import { kw } from './kwargs.js';
import { assetRef } from './project.js';
import { resetDeclarations } from './reset.js';
import { createRuntime } from './runtime.js';
import type { GameRuntime } from './runtime.js';
import { MusicRef, SceneRef, SoundRef } from './types.js';

/** Project files; every scene also places a camera (a 2D game draws through one). */
function files(contents: Record<string, unknown>): ProjectFiles {
  const withCamera: Record<string, unknown> = { 'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 8 } } } };
  for (const [p, v] of Object.entries(contents)) {
    const scene = v as { entities?: unknown[] };
    withCamera[p] = p.endsWith('/scene.json') ? { ...scene, entities: [...(scene.entities ?? []), { prefab: 'camera' }] } : v;
  }
  const text = Object.fromEntries(Object.entries(withCamera).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const ASSETS = ['assets/sfx/hit.ogg', 'assets/sfx/coin.ogg', 'assets/music/theme.ogg', 'assets/music/boss.ogg'];

/** The runtime builds the audio plugin from its `audio` output and `assets`. */
function run(): { runtime: GameRuntime; out: HeadlessAudio; audio: AudioApi } {
  const projectFiles = files({
    'assets/audio.json': { 'sfx/hit': { volume: 0.5 }, 'music/theme': { volume: 0.3 } },
    'prefabs/crate.prefab.json': { components: {} },
    'scenes/main/scene.json': { music: 'music/theme', entities: [{ prefab: 'crate', id: 'crate', at: [4, 0, 0] }] },
  });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const out = new HeadlessAudio();
  const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d' }));
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: out, assets: ASSETS, files: projectFiles, surface: new RecordingSurface2d(),
  });
  runtime.start();
  return { runtime, out, audio: (runtime.ctx as unknown as { audio: AudioApi }).audio };
}

beforeEach(() => resetDeclarations());

describe('ctx.audio', () => {
  it('plays a SoundRef with Python keyword arguments, at an entity', () => {
    const { runtime, out, audio } = run();
    const entity = runtime.wrap([...runtime.kernel.world.live()].find((r) => r.placedId === 'crate')!.id);
    audio.play(assetRef('sound', 'sfx/hit'), kw({ at: entity, volume: 0.5, pitch: 1.2 }));
    audio.play(new SoundRef('sfx/coin'), kw({ at: new Vec3(1, 2, 3) }));
    runtime.step(1 / 60);
    expect(out.plays.map((p) => [p.sound, p.volume, p.pitch, p.position])).toEqual([
      ['sfx/hit', 0.25, 1.2, [4, 0, 0]],
      ['sfx/coin', 1, 1, [1, 2, 3]],
    ]);
  });

  it('records to= as the player id', () => {
    const { runtime, out, audio } = run();
    audio.play(new SoundRef('sfx/coin'), kw({ to: runtime.ctx.players[0] }));
    runtime.step(1 / 60);
    expect(out.plays[0]!.to).toBe('local');
  });

  it('the scene music plays and ctx.audio.music overrides it', () => {
    const { runtime, out, audio } = run();
    runtime.step(1 / 60);
    expect(out.musicChanges[0]).toMatchObject({ track: 'music/theme', volume: 0.3 });
    audio.music(new MusicRef('music/boss'), kw({ fade: 2 }));
    runtime.step(1 / 60);
    expect(out.musicChanges[1]).toMatchObject({ track: 'music/boss', fade: 2 });
    audio.music(null);
    runtime.step(1 / 60);
    expect(out.music).toBeNull();
  });

  it('Settings volumes reach the buses', () => {
    const { runtime, out } = run();
    (runtime.ctx.get(Settings) as { sfx_volume: number }).sfx_volume = 0.25;
    runtime.step(1 / 60);
    expect(out.buses.sfx).toBe(0.25);
  });

  it('rejects the wrong kind of asset, None, bad keywords and bad to=', () => {
    const { audio } = run();
    expect(() => audio.play(new MusicRef('music/boss'))).toThrow(/PP3500[\s\S]*music track/);
    expect(() => audio.music(new SoundRef('sfx/hit'))).toThrow(/PP3500/);
    expect(() => audio.play(null)).toThrow(/PP3500[\s\S]*if item\.sound/);
    expect(() => audio.play('sfx/hit')).toThrow(/PP3500[\s\S]*Assets\.sfx/);
    expect(() => audio.play(new SoundRef('sfx/hit'), kw({ volum: 1 }))).toThrow(/PP3030[\s\S]*volume/);
    expect(() => audio.play(new SoundRef('sfx/hit'), kw({ to: 'p1' }))).toThrow(/PP3508/);
    expect(() => audio.play(new SoundRef('sfx/hit'), kw({ at: 'here' }))).toThrow(/PP3502/);
    expect(() => audio.play(new SoundRef('sfx/hti'))).toThrow(/PP2063[\s\S]*sfx\/hit/);
  });
});

describe('ctx.audio: synth, layers, beat clock, voices, ambience', () => {
  it('Synth.<name> plays a built-in synthesized sound; quantize= lands it on the grid', () => {
    const { runtime, out, audio } = run();
    audio.play(Synth['ui_click']);
    expect(() => audio.play(Synth['ui_click'], kw({ quantize: 'beat' }))).toThrow(/PP3514/);
    audio.music(new MusicRef('music/theme'), kw({ bpm: 120, beats_per_bar: 4, fade: 0 }));
    audio.play(Synth['tick'], kw({ quantize: 'bar' }));
    expect(() => audio.play(Synth['tick'], kw({ quantize: 'half' }))).toThrow(/PP3514.*"half"/);
    runtime.step(1 / 60);
    expect(out.playsOf('synth/ui_click')[0]).toMatchObject({ file: null, delay: 0 });
    expect(out.playsOf('synth/tick')[0]!.delay).toBe(0);
    expect(audio.bpm).toBe(120);
    expect(audio.time_to('bar')).toBeCloseTo(2 - 1 / 60, 6);
  });

  it('MusicLayer stems follow set_intensity; ambience and max_voices are settable', () => {
    const { runtime, out, audio } = run();
    audio.music(new MusicRef('music/theme'), kw({ layers: [new MusicLayer(new MusicRef('music/boss'), kw({ at: 0.5 }))] }));
    runtime.step(1 / 60);
    expect(out.musicLayers).toEqual([{ track: 'music/boss', volume: 1, gain: 0 }]);
    audio.set_intensity(0.7, kw({ fade: 2 }));
    runtime.step(1 / 60);
    expect(out.musicLayers.map((l) => l.gain)).toEqual([1]);
    expect(audio.intensity).toBe(0.7);
    expect(() => new MusicLayer(new SoundRef('sfx/hit'))).toThrow(/PP3500/);
    expect(() => audio.music(new MusicRef('music/theme'), kw({ layers: [new MusicRef('music/boss')] }))).toThrow(/PP3516/);
    audio.ambience = false;
    audio.max_voices = 8;
    expect([audio.ambience, audio.max_voices]).toEqual([false, 8]);
    expect(() => { audio.ambience = 1; }).toThrow(/PP3511/);
  });
});

