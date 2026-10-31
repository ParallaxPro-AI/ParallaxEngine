/**
 * `parallax.cinematics` the way a game uses it: `plugins.cinematics(skip=Controls.skip)`,
 * content/cinematic/*.json, `ctx.cinematics.play(Content..., bind=...)`, the real camera
 * (visuals plugin) taken and handed back, events heard by a system, and the skip key.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { CinematicDef, CinematicEnded, CinematicMarker, cinematics, CinematicsApi, CinematicStarted } from './cinematics.js';
import { Actions, button } from './input.js';
import { createRuntime, EntityRef, Game, kw, on, resetDeclarations, SceneRef, system, System } from './index.js';
import type { ContentRef, Context, GameRuntime } from './index.js';

const STEP = 1 / 60;

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

function setup(): { r: GameRuntime; input: HeadlessInput; log: string[]; api: () => CinematicsApi } {
  class Controls extends Actions {
    static skip = button(kw({ keyboard: 'Escape' }));
  }
  Controls.__init_subclass__();
  const log: string[] = [];
  class Recorder extends System {
    started(_c: unknown, e: { cinematic: ContentRef<unknown> }) { log.push(`started ${e.cinematic.id}`); }
    marker(_c: unknown, e: { name: string; skipped: boolean }) { log.push(`marker ${e.name}${e.skipped ? ' skipped' : ''}`); }
    ended(_c: unknown, e: { cinematic: ContentRef<unknown>; skipped: boolean }) { log.push(`ended ${e.cinematic.id}${e.skipped ? ' skipped' : ''}`); }
  }
  on(CinematicStarted)(Recorder.prototype.started);
  on(CinematicMarker)(Recorder.prototype.marker);
  on(CinematicEnded)(Recorder.prototype.ended);
  system('recorder')(Recorder);
  const projectFiles = files({
    'prefabs/cam.prefab.json': { components: { camera: { rig: 'fixed', fov: 60 } } },
    'prefabs/hero.prefab.json': { components: {} },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'cam', id: 'cam', at: [0, 10, -20] },
        { prefab: 'hero', id: 'hero', at: [0, 0, 0] },
      ],
    },
    'content/cinematic/intro.json': {
      bind: ['star'],
      tracks: [
        { type: 'camera', keys: [{ t: 1, position: [0, 2, -4], relative_to: 'star', look_at: 'star', fov: 40, ease: 'linear' }] },
        { type: 'transform', target: 'star', keys: [{ t: 1, position: [0, 0, 2], ease: 'linear' }] },
        { type: 'event', keys: [{ t: 0.5, name: 'halfway' }] },
      ],
    },
  });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const input = new HeadlessInput();
  const game = new Game(kw({
    id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d',
    plugins: [cinematics(kw({ skip: Controls.skip }))], systems: [Recorder],
  }));
  const r = createRuntime(game, project, {
    seed: 1, devices: input, audio: new HeadlessAudio(), assets: null, files: projectFiles, surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  r.start();
  r.step(STEP);
  return { r, input, log, api: () => (r.ctx as unknown as Context & { cinematics: CinematicsApi }).cinematics };
}

describe('parallax.cinematics', () => {
  it('plays from code with bind=, drives the real camera and hands it back', () => {
    const { r, log, api } = setup();
    const hero = r.ctx.world.placed(new EntityRef('hero'));
    const cam = r.ctx.world.placed(new EntityRef('cam'));
    const intro = r.ctx.content(CinematicDef).get('intro');
    api().play(intro, kw({ bind: { star: hero } }));
    expect(api().playing).toBe(true);
    expect(api().current).toBe(intro);
    r.step(STEP);
    expect(log).toEqual(['started intro']);
    for (let i = 0; i < 29; i++) r.step(STEP);
    // Halfway: the camera is between its start and the shot following the hero, after the rigs ran.
    expect((cam.transform.position as Vec3).is_close(new Vec3(0, 6, -11.5))).toBe(true);
    for (let i = 0; i < 31; i++) r.step(STEP);
    expect(log).toEqual(['started intro', 'marker halfway', 'ended intro']);
    expect(api().playing).toBe(false);
    expect((hero.transform.position as Vec3).is_close(new Vec3(0, 0, 2))).toBe(true);
    // A "fixed" camera is put back where it was.
    expect((cam.transform.position as Vec3).is_close(new Vec3(0, 10, -20))).toBe(true);
  });

  it('the skip key ends it at its end state', () => {
    const { r, input, log, api } = setup();
    const hero = r.ctx.world.placed(new EntityRef('hero'));
    api().play(r.ctx.content(CinematicDef).get('intro'), kw({ bind: { star: hero } }));
    r.step(STEP);
    input.tapKey('Escape');
    r.step(STEP);
    expect(api().playing).toBe(false);
    expect(log).toEqual(['started intro', 'marker halfway skipped', 'ended intro skipped']);
    expect((hero.transform.position as Vec3).is_close(new Vec3(0, 0, 2))).toBe(true);
    expect(api().skip()).toBe(false);
  });

  it('arguments are checked', () => {
    const { r, api } = setup();
    expect(code(() => api().play('intro'))).toBe('PP7211');
    expect(code(() => api().play(r.ctx.content(CinematicDef).get('intro'), kw({ bind: { star: 3.5 } })))).toBe('PP7213');
    expect(code(() => api().play(r.ctx.content(CinematicDef).get('intro')))).toBe('PP7213');
    expect(code(() => cinematics(kw({ skip: 'Escape' })))).toBe('PP7292');
  });
});
