/**
 * Game code's view of procgen components: a method that shares its name with a field
 * (`Dungeon.rooms`, the room count, and `Dungeon.rooms()`, the generated rooms) is
 * callable from Python, while assigning the name still writes the field.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { createRuntime, EntityRef, Game, kw, resetDeclarations, SceneRef } from './index.js';
import { Dungeon, procgen } from './procgen.js';

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

describe('procgen component views', () => {
  it('Dungeon.rooms() lists the rooms though "rooms" is also the room-count field', () => {
    const projectFiles = files({
      'prefabs/empty.prefab.json': { components: {} },
      'scenes/main/scene.json': { entities: [{ id: 'crypt', prefab: 'empty', components: { dungeon: { seed: 3, rooms: 6 } } }] },
    });
    const project = loadProject(projectFiles);
    expect(project.diagnostics).toEqual([]);
    const game = new Game(kw({ id: 'test', title: 'Test', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', plugins: [procgen()] }));
    const runtime = createRuntime(game, project, { seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles,
      surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}) });
    runtime.start();
    runtime.step(1 / 60);
    const dungeon = runtime.ctx.world.placed(new EntityRef('crypt')).get(Dungeon) as unknown as {
      rooms: (() => { role: string }[]) | number; seed: number;
    };
    expect(typeof dungeon.rooms).toBe('function');
    const rooms = (dungeon.rooms as () => { role: string }[])();
    expect(rooms).toHaveLength(6);
    expect(rooms.filter((room) => room.role === 'entrance')).toHaveLength(1);
    dungeon.rooms = 9;
    runtime.step(1 / 60);
    expect((dungeon.rooms as unknown as () => unknown[])()).toHaveLength(9);
    expect(dungeon.seed).toBe(3);
  });
});
