/**
 * An editor session on the headless platform: the game booted in edit mode with recording
 * surfaces and scripted input, stepped by hand. For engine tests and for tools that edit
 * or inspect a game without a page (the AI builder's Node side).
 */

import type { GameRuntime } from '@parallax/runtime/api';
import { startGame } from '@parallax/runtime/boot';
import type { ProjectFiles } from '@parallax/runtime/core';
import { HeadlessAudio, MemoryBinaryFiles, RecordingSurface2d, RecordingSurface3d } from '@parallax/runtime/platform';
import { HeadlessInput } from '@parallax/runtime/plugins/input';
import { ProjectDocuments } from './documents.js';
import { EditorSession } from './session.js';

export interface HeadlessEditorOptions {
  /**
   * The compiled entry's exports (`game/main.py`). Called again for every hot reload: return
   * freshly imported modules there (a new realm) to pick up changed code.
   */
  readonly entry: () => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
  readonly files: ProjectFiles;
  readonly mode: '2d' | '3d';
  /** A 3D game's model files by project path; default none (data-only). */
  readonly binary?: ReadonlyMap<string, Uint8Array>;
  /** Surface pixels (default 1280×720). */
  readonly size?: { readonly width: number; readonly height: number };
  /** The play seed (default 1). */
  readonly seed?: number;
}

export interface HeadlessEditor {
  readonly session: EditorSession;
  readonly input: HeadlessInput;
  readonly surface: RecordingSurface2d;
  readonly surface3d: RecordingSurface3d;
  /** One frame of `dt` seconds (default 1/60) of whatever runtime the session has now. */
  frame(dt?: number): void;
  frames(count: number, dt?: number): void;
}

export async function openHeadlessEditor(options: HeadlessEditorOptions): Promise<HeadlessEditor> {
  const size = options.size ?? { width: 1280, height: 720 };
  const input = new HeadlessInput();
  const surface = new RecordingSurface2d(size);
  const surface3d = new RecordingSurface3d(size);
  const documents = new ProjectDocuments(options.files);
  const boot = async (files: ProjectFiles): Promise<GameRuntime> => {
    const started = await startGame({
      entry: await options.entry(),
      files,
      devices: input,
      audio: new HeadlessAudio(),
      assets: null,
      ...(options.mode === '3d' ? { surface3d, binary: new MemoryBinaryFiles(options.binary ?? new Map()) } : { surface }),
      seed: options.seed ?? 1,
      editing: true,
    });
    return started.runtime;
  };
  const session = new EditorSession({
    runtime: await boot(documents),
    documents,
    host: { rebuild: (files) => boot(files) },
    ...(options.seed !== undefined && { seed: options.seed }),
  });
  const frame = (dt = 1 / 60): void => session.runtime.step(dt);
  return {
    session, input, surface, surface3d, frame,
    frames: (count, dt) => { for (let i = 0; i < count; i++) frame(dt); },
  };
}
