/**
 * Music that pauses with the game: while `paused` says so the engine holds the music (one
 * `music_pause` command) and its beat clock, and lets both go on from where they were; a
 * track whose audio.json says `"pauses": false` keeps playing. Read back from HeadlessAudio.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { GameDefinition, ResourceDef, SystemDef } from '../../kernel/index.js';
import { HeadlessAudio } from '../../../platform/headless/audio.js';
import { audio, BEAT_EVENT } from './index.js';
import type { AudioNamespace } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const SETTINGS_DEF: ResourceDef = {
  id: 'settings', keep: 'profile',
  schema: { master_volume: t.number({ default: 1 }), music_volume: t.number({ default: 1 }), sfx_volume: t.number({ default: 1 }) },
};

function setup(audioJson: Record<string, unknown> = {}, scene: Record<string, unknown> = {}) {
  const project = files({
    'assets/audio.json': audioJson,
    'prefabs/camera.prefab.json': { components: { camera: {} } },
    'scenes/main/scene.json': { entities: [{ prefab: 'camera', id: 'cam', at: [0, 0, 0] }], ...scene },
    'scenes/menu/scene.json': { music: 'music/calm', entities: [] },
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const out = new HeadlessAudio();
  const state = { paused: false };
  const plugin = audio({
    output: out, assets: ['assets/music/calm.ogg', 'assets/music/menu.ogg', ...project.list()], files: project,
    defaults: loaded.audio, seed: 3, mode: '3d', paused: () => state.paused,
  });
  const beats: number[] = [];
  const listener: SystemDef = {
    id: 'beats', scenes: [], handlers: [{ event: BEAT_EVENT, method: 'beat' }],
    create: () => ({ beat: (_ctx: unknown, payload: Record<string, unknown>) => { beats.push(payload['beat'] as number); } }),
  };
  const game: GameDefinition = {
    components: [{ id: 'camera', schema: {} }], resources: [SETTINGS_DEF], events: [], behaviors: [], systems: [listener],
  };
  const kernel = new Kernel({ project: loaded, game, plugins: [plugin], context: {}, fixedStep: DT });
  const ctx = plugin.namespace!.create(kernel) as AudioNamespace;
  kernel.start('main');
  return { kernel, plugin, out, ctx, state, beats, steps: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); } };
}

describe('music pauses with the game', () => {
  it('holds the music while paused and lets it go on after, once each way', () => {
    const g = setup();
    g.ctx.music('music/calm', 0);
    g.steps(2);
    expect(g.out.musicPaused).toBe(false);
    g.state.paused = true;
    g.steps(3);
    expect(g.out.musicPaused).toBe(true);
    expect(g.plugin.engine.musicPaused).toBe(true);
    g.state.paused = false;
    g.steps(2);
    expect(g.out.musicPaused).toBe(false);
    expect(g.out.musicPauses.map((p) => p.paused)).toEqual([true, false]);
    // The track was never restarted.
    expect(g.out.musicChanges.map((m) => m.track)).toEqual(['music/calm']);
  });

  it('a track with "pauses": false keeps playing through the pause', () => {
    const g = setup({ 'music/menu': { pauses: false } });
    g.ctx.music('music/menu', 0);
    g.steps();
    g.state.paused = true;
    g.steps(3);
    expect(g.out.musicPaused).toBe(false);
    expect(g.out.musicPauses).toEqual([]);
  });

  it('a track changed during the pause is held if it pauses, and plays if it opts out', () => {
    const g = setup({ 'music/menu': { pauses: false } });
    g.ctx.music('music/calm', 0);
    g.steps();
    g.state.paused = true;
    g.steps();
    g.ctx.music('music/menu', 0);
    g.steps();
    expect(g.out.music).toBe('music/menu');
    expect(g.out.musicPaused).toBe(false);
    g.ctx.music('music/calm', 0);
    g.steps();
    expect(g.out.musicPaused).toBe(true);
  });

  it('the beat clock holds with the music: no beats while paused, none skipped after', () => {
    const g = setup();
    g.ctx.music('music/calm', 0, { bpm: 120 });
    g.steps(31); // half a second: beat 1 has fired
    const before = g.ctx.beat!;
    g.state.paused = true;
    g.steps(); // the hold starts at this frame's flush
    const held = g.ctx.beat!;
    const count = g.beats.length;
    g.steps(120);
    expect(g.beats.length).toBe(count);
    expect(g.ctx.beat).toBeCloseTo(held, 6);
    expect(held - before).toBeLessThan(0.1);
    g.state.paused = false;
    g.steps(60);
    expect(g.ctx.beat! - held).toBeCloseTo(2, 1);
    expect(g.beats).toEqual([...Array(g.beats.length).keys()]);
  });

  it('audio.json "pauses" is for music only', () => {
    const loaded = loadProject(files({ 'assets/audio.json': { 'sfx/hit': { pauses: false } } }));
    expect(loaded.diagnostics.map((d) => d.code)).toContain('PP1002');
  });
});

describe('music volume per scene and per call', () => {
  it('a scene\'s "music_volume" scales the track; the same track in another scene changes level, not track', () => {
    const g = setup({ 'music/calm': { volume: 0.8 } }, { music: 'music/calm', music_volume: 0.25 });
    g.steps();
    expect(g.out.musicChanges.at(-1)).toMatchObject({ track: 'music/calm', volume: 0.2 });
    g.kernel.requestScene('menu');
    g.steps(2);
    expect(g.out.musicChanges.at(-1)).toMatchObject({ track: 'music/calm', volume: 0.8 });
    expect(g.out.music).toBe('music/calm');
  });

  it('ctx.audio.music(volume=) scales the override', () => {
    const g = setup({ 'music/menu': { volume: 0.5 } });
    g.ctx.music('music/menu', 0, { volume: 0.5 });
    g.steps();
    expect(g.out.musicChanges.at(-1)).toMatchObject({ track: 'music/menu', volume: 0.25 });
  });

  it('"music_volume" out of range is PP1002', () => {
    const loaded = loadProject(files({ 'scenes/main/scene.json': { music_volume: 9, entities: [] } }));
    expect(loaded.diagnostics.map((d) => d.code)).toContain('PP1002');
  });
});

describe('mix groups', () => {
  it('audio.json "group" puts sounds in a group; set_group scales and mutes one-shots, music and survives a snapshot', () => {
    const g = setup({ 'music/calm': { group: 'score', volume: 0.5 }, 'music/menu': {} });
    const e = g.plugin.engine;
    expect(e.groupNames).toEqual(['score']);
    g.ctx.music('music/calm', 0);
    g.steps();
    expect(g.out.musicChanges.at(-1)).toMatchObject({ volume: 0.5 });
    e.setGroup('score', 0.5);
    g.steps();
    expect(g.out.musicChanges.at(-1)).toMatchObject({ track: 'music/calm', volume: 0.25 });
    e.setGroup('score', undefined, true);
    g.steps();
    expect(g.out.musicChanges.at(-1)).toMatchObject({ volume: 0 });
    expect(e.group('score')).toEqual({ volume: 0.5, muted: true });
    const saved = g.kernel.snapshot();
    e.setGroup('score', 1, false);
    g.kernel.restore(saved);
    expect(e.group('score')).toEqual({ volume: 0.5, muted: true });
    let code: string | undefined;
    try { e.setGroup('scroe', 1); } catch (err) { code = (err as { diagnostic?: { code: string; fix?: string } }).diagnostic?.code; }
    expect(code).toBe('PP3517');
  });
});
