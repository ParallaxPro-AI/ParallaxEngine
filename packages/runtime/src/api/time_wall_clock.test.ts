/** `ctx.time.wall_clock`: the platform's Unix-seconds clock, None when the host gives none. */

import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import { createRuntime, Game, kw, SceneRef } from './index.js';
import type { GameRuntime } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function run(wallClock?: () => number): GameRuntime {
  const projectFiles = files({
    'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 5 } } },
    'scenes/main/scene.json': { entities: [{ prefab: 'camera' }] },
  });
  const project = loadProject(projectFiles);
  const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d' }));
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
    surface: new RecordingSurface2d({ width: 100, height: 100 }),
    ...(wallClock !== undefined && { wallClock }),
  });
  runtime.start();
  return runtime;
}

describe('ctx.time.wall_clock', () => {
  it('is None without a platform clock', () => {
    expect(run().ctx.time.wall_clock).toBeNull();
  });

  it('reads the platform clock each time it is asked', () => {
    let now = 1_700_000_000;
    const r = run(() => now);
    expect(r.ctx.time.wall_clock).toBe(1_700_000_000);
    now += 3600;
    expect(r.ctx.time.wall_clock).toBe(1_700_003_600);
  });

  it('a clock that gives no number reads as None', () => {
    expect(run(() => Number.NaN).ctx.time.wall_clock).toBeNull();
  });
});
