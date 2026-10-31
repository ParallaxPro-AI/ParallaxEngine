/**
 * The Editor over a stand-in session: Play starts from the start scene and Stop comes back,
 * the editor camera is remembered per scene and restored, and a save that wrote files says so.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import type { BrowserGame } from '@parallax/runtime/boot';
import type { CameraPose, EditorSession } from './session/index.js';
import { Editor, playStartScene, projectLabel } from './editor.js';
import type { Change } from './editor.js';
import { CameraMemory } from './camera_memory.js';
import type { PoseStorage } from './camera_memory.js';

const GAME_CAMERA: CameraPose = { position: new Vec3(0, 5, -10), rotation: Quat.IDENTITY, fov: 60 };

class FakeSession {
  mode: 'edit' | 'playing' | 'paused' = 'edit';
  scene = 'main';
  readonly startScene = 'main';
  dragging = false;
  cameraPose: CameraPose = GAME_CAMERA;
  played: string[] = [];
  selection: readonly unknown[] = [];
  select(ids: readonly unknown[]): void { this.selection = ids; }
  dirtyPaths: string[] = [];
  readonly documents = {
    onChange: () => () => {},
    locked: null,
    dirty: () => this.dirtyPaths,
    has: () => true,
    read: () => 'x = 1\n',
    json: () => ({}),
    markSaved: (paths: readonly string[]) => { this.dirtyPaths = this.dirtyPaths.filter((p) => !paths.includes(p)); },
    project: () => ({ scenes: new Map([['main', {}], ['cave', {}]]), diagnostics: [] }),
  };
  setCamera(pose: Partial<CameraPose>): void { this.cameraPose = { ...this.cameraPose, ...pose }; }
  openScene(scene: string): void {
    if (scene === 'missing') throw new Error('Unknown scene');
    this.scene = scene;
    this.cameraPose = GAME_CAMERA; // a newly opened scene starts from its own camera
  }
  play(options: { scene?: string } = {}): void { this.played.push(options.scene ?? this.scene); this.mode = 'playing'; }
  stop(): readonly never[] { this.mode = 'edit'; return []; }
}

function storage(): PoseStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

const game = { runtime: { game: { id: 'boxes' } }, stage: { stage: { focus: () => {} } }, sources: { files: { list: () => [], read: () => '' } } } as unknown as BrowserGame;

function open(store: PoseStorage, session = new FakeSession()): { editor: Editor; session: FakeSession } {
  const editor = new Editor(game, session as unknown as EditorSession, 'Boxes', { cameras: new CameraMemory('boxes', store) });
  return { editor, session };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('playStartScene', () => {
  it('plays the start scene whichever scene is edited, else the edited one', () => {
    const scenes = new Set(['main', 'cave']);
    expect(playStartScene('main', 'cave', scenes)).toBe('main');
    expect(playStartScene('main', 'main', scenes)).toBe('main');
    expect(playStartScene('gone', 'cave', scenes)).toBe('cave');
    expect(playStartScene(undefined, 'cave', scenes)).toBe('cave');
  });

  it('Play from another scene starts the start scene; Stop is back on the edited scene', () => {
    const { editor, session } = open(storage());
    editor.openScene('cave');
    editor.play();
    expect(session.played).toEqual(['main']);
    expect(editor.log.at(-1)!.text).toContain('start scene main');
    editor.stop();
    expect(session.mode).toBe('edit');
    expect(session.scene).toBe('cave');
  });
});

describe('scene selection', () => {
  it('the scene row selects the scene; any other select (an empty click, a deselect) clears it', () => {
    const { editor } = open(storage());
    expect(editor.sceneSelected).toBe(false);
    editor.selectScene();
    expect(editor.sceneSelected).toBe(true);
    editor.select([]);
    expect(editor.sceneSelected).toBe(false);
  });
});

describe('editor camera memory', () => {
  it('first open uses the game camera; a reload restores the last view of each scene', () => {
    const store = storage();
    const first = open(store);
    expect(first.session.cameraPose).toBe(GAME_CAMERA);
    first.session.setCamera({ position: new Vec3(7, 8, 9) });
    first.editor.openScene('cave'); // remembers main's view
    expect(first.session.cameraPose.position.x).toBe(0); // cave: never viewed, its own camera
    first.session.setCamera({ position: new Vec3(-4, 1, 2) });
    first.editor.rememberCamera();

    const reload = open(store);
    expect(reload.session.cameraPose.position.x).toBe(7);
    reload.editor.openScene('cave');
    expect(reload.session.cameraPose.position.x).toBe(-4);
  });

  it('does not remember the camera while playing', () => {
    const store = storage();
    const { editor, session } = open(store);
    editor.play();
    session.setCamera({ position: new Vec3(99, 0, 0) });
    editor.rememberCamera();
    expect(open(store).session.cameraPose.position.x).toBe(0); // the pose kept at Play, not the moved one
  });
});

describe('save state', () => {
  it('dirty, the "Name *" label and a saved change after a save that wrote files', async () => {
    const { editor, session } = open(storage());
    expect(editor.dirty).toBe(false);
    expect(projectLabel('Boxes', editor.dirty)).toBe('Boxes');
    session.dirtyPaths = ['code/game.py'];
    expect(projectLabel('Boxes', editor.dirty)).toBe('Boxes *');
    const changes: Change[][] = [];
    editor.on((c) => changes.push([...c]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ saved: ['code/game.py'] }), { status: 200 })));
    await editor.save({ auto: true });
    expect(editor.dirty).toBe(false);
    expect(editor.lastSave).toMatchObject({ paths: ['code/game.py'], auto: true });
    expect(changes.some((c) => c.includes('saved'))).toBe(true);
    changes.length = 0;
    await editor.save(); // nothing to save: no saved change
    expect(changes.some((c) => c.includes('saved'))).toBe(false);
  });
});
