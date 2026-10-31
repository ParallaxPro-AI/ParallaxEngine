/**
 * The cinematic presentation tracks through the real runtime: the grade blended into the
 * environment's resolved post settings, a focus track reaching the renderer as the view's
 * depth of field, the CinematicPanel's state (letterbox, subtitle, dialogue) and its
 * `advance` action, and the `advance=` button.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { ENVIRONMENT_SERVICE } from '../function/services/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { CinematicDef, CinematicPanel, cinematics, CinematicsApi } from './cinematics.js';
import { Actions, button } from './input.js';
import { createRuntime, Game, kw, resetDeclarations, SceneRef } from './index.js';
import type { Context, GameRuntime } from './index.js';

const STEP = 1 / 60;

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function setup(): { r: GameRuntime; input: HeadlessInput; surface: RecordingSurface3d; api: () => CinematicsApi } {
  class Controls extends Actions {
    static skip = button(kw({ keyboard: 'Escape' }));
    static advance = button(kw({ keyboard: 'Enter' }));
  }
  Controls.__init_subclass__();
  const projectFiles = files({
    'prefabs/cam.prefab.json': { components: { camera: { rig: 'fixed', fov: 60 } } },
    'scenes/main/scene.json': { entities: [{ prefab: 'cam', id: 'cam', at: [0, 2, -10] }] },
    'content/cinematic/intro.json': {
      duration: 2,
      tracks: [
        { type: 'grade', post: { preset: 'noir' }, keys: [{ t: 1, weight: 1, ease: 'linear' }] },
        { type: 'focus', keys: [{ t: 0, distance: 5, range: 2, blur: 8 }] },
        { type: 'letterbox', keys: [{ t: 0.5, amount: 1, ease: 'linear' }] },
        { type: 'subtitle', keys: [{ t: 0, text: 'Long ago…', seconds: 0.5 }] },
        { type: 'dialogue', keys: [{ t: 1, speaker: 'Guide', text: 'Wake up.' }] },
      ],
    },
  });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const input = new HeadlessInput();
  const surface = new RecordingSurface3d();
  const game = new Game(kw({
    id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d',
    plugins: [cinematics(kw({ skip: Controls.skip, advance: Controls.advance }))],
  }));
  const r = createRuntime(game, project, {
    seed: 1, devices: input, audio: new HeadlessAudio(), assets: null, files: projectFiles, surface3d: surface, binary: new MemoryBinaryFiles({}),
  });
  r.start();
  r.step(STEP);
  return { r, input, surface, api: () => (r.ctx as unknown as Context & { cinematics: CinematicsApi }).cinematics };
}

const steps = (r: GameRuntime, n: number): void => { for (let i = 0; i < n; i++) r.step(STEP); };

describe('cinematic presentation', () => {
  it('grade: the scene\'s look blends toward the preset by the weight, and back after', () => {
    const { r, api } = setup();
    const post = () => r.kernel.service(ENVIRONMENT_SERVICE).resolve().post;
    expect(post().saturation).toBe(1);
    api().play(r.ctx.content(CinematicDef).get('intro'));
    steps(r, 30);
    // noir: saturation 0, contrast 1.25 — halfway at weight 0.5.
    expect(post().saturation).toBeCloseTo(0.5, 2);
    expect(post().contrast).toBeCloseTo(1.125, 2);
    api().skip();
    r.step(STEP);
    expect(post().saturation).toBe(1);
  });

  it('focus: the renderer gets the camera\'s depth of field while it plays, none after', () => {
    const { r, api, surface } = setup();
    expect(surface.last!.views[0]!.depthOfField ?? null).toBeNull();
    api().play(r.ctx.content(CinematicDef).get('intro'));
    r.step(STEP);
    expect(surface.last!.views[0]!.depthOfField).toEqual({ focusDistance: 5, focusRange: 2, maxBlur: 8 });
    api().skip();
    r.step(STEP);
    expect(surface.last!.views[0]!.depthOfField ?? null).toBeNull();
  });

  it('the panel shows the letterbox, subtitle and the waiting line; Continue and the advance button go on', () => {
    const { r, input, api } = setup();
    const panel = new CinematicPanel();
    const state = () => panel.state(r.ctx) as Record<string, unknown>;
    expect(api().__presentation__()).toBeNull();
    api().play(r.ctx.content(CinematicDef).get('intro'));
    r.step(STEP);
    expect(state()).toMatchObject({ has_subtitle: true, subtitle: 'Long ago…', dialogue: false, awaiting: false });
    steps(r, 59);
    expect(state()).toMatchObject({ has_subtitle: false, bars: true, bar: '12.500%', dialogue: true, speaker: 'Guide', text: 'Wake up.', awaiting: true });
    steps(r, 30);
    expect(api().time).toBeCloseTo(1, 6);
    // The panel's Continue action.
    (CinematicPanel.actions as { advance(ctx: unknown): unknown }).advance(r.ctx);
    expect(api().awaiting).toBe(false);
    steps(r, 70);
    expect(api().playing).toBe(false);
    // Again, with the advance button.
    api().play(r.ctx.content(CinematicDef).get('intro'));
    steps(r, 62);
    expect(api().awaiting).toBe(true);
    input.tapKey('Enter');
    r.step(STEP);
    expect(api().awaiting).toBe(false);
  });
});
