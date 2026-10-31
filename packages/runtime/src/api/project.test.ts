import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import { content, createRuntime, Game, kw, ModelRef, resetDeclarations, rt, SceneRef, SoundRef } from './index.js';
import { assetRef, contentRef, prefabRef } from './project.js';

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

beforeEach(() => resetDeclarations());

describe('project handles', () => {
  it('are value refs; content refs are the same objects the running game lists', () => {
    class Stage { static __annotations__ = { number: () => rt.int }; }
    const StageDef = content('stage')(Stage);
    const dawn = contentRef('stage', 'dawn');
    expect(contentRef('stage', 'dawn')).toBe(dawn);
    expect(() => dawn.data).toThrow(/PP3032/);

    const projectFiles = files({ 'content/stage/dawn.json': { number: 3 }, 'scenes/main/scene.json': { entities: [] } });
    const project = loadProject(projectFiles);
    const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d' }));
    const runtime = createRuntime(game, project, {
      seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles, surface: new RecordingSurface2d(),
    });
    // Bound as soon as the game exists: no code had to list the kind first.
    expect((dawn.data as { number: number }).number).toBe(3);
    runtime.start();
    expect(runtime.ctx.content(StageDef).get('dawn')).toBe(dawn);

    expect(prefabRef('ball').__eq__(prefabRef('ball'))).toBe(true);
    expect(assetRef('sound', 'sfx/hit')).toBeInstanceOf(SoundRef);
    const knight = assetRef('model', 'models/knight', ['run', 'idle']) as ModelRef & { clips: Record<string, { name: string }> };
    expect(knight).toBeInstanceOf(ModelRef);
    expect(knight.clips['run']!.name).toBe('run');
    expect(() => assetRef('mesh', 'x')).toThrow(/PP9004/);
  });
});
