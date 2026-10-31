/**
 * The editor's state and actions over one EditorSession. Panels read the session through
 * `editor.session` (its runtime changes on hot reload), call the actions here — which turn
 * every coded failure into a console entry instead of an exception — and redraw on
 * `editor.on(...)`.
 */

import { diagnosticsOf } from '@parallax/runtime/boot';
import type { BrowserGame } from '@parallax/runtime/boot';
import { Vec3 } from '@parallax/runtime/core';
import type { Diagnostic, EntityId } from '@parallax/runtime/core';
import type { JsonObject } from '@parallax/runtime/resource';
import type { EditorSession, GizmoMode, GizmoSpace } from './session/index.js';
import { save } from './server_link.js';
import { Autosave } from './autosave.js';
import type { AutosaveOptions } from './autosave.js';
import { CameraMemory, projectKey } from './camera_memory.js';

/**
 * What changed: panels redraw for the kinds they show. `saved`: a save wrote files (see
 * `Editor.lastSave`). `rename`: a request to rename the selection in place (F2; the hierarchy answers it).
 */
/** `build`: a build event (a rebuild on the server) has been taken in: documents, and the runtime when it was rebuilt. */
export type Change = 'selection' | 'documents' | 'mode' | 'world' | 'gizmo' | 'log' | 'saved' | 'rename' | 'title' | 'build';

/** The last save that wrote something. */
export interface SaveRecord {
  readonly paths: readonly string[];
  readonly time: Date;
  /** Started by autosave or the page being hidden, not by Ctrl+S / Save. */
  readonly auto: boolean;
}

export interface SaveOptions {
  /** An automatic save (autosave, page hidden): marked so in `lastSave`. */
  readonly auto?: boolean;
  /** The page may be closing: send with `keepalive` so the request outlives it. */
  readonly keepalive?: boolean;
}

/**
 * Where Play starts: the game's start scene (`Game(start_scene=...)`), its primary
 * scene, whichever scene is being edited — unless the start scene
 * is not in the documents (then the edited scene).
 */
export function playStartScene(startScene: string | undefined, editing: string, scenes: { has(scene: string): boolean }): string {
  return startScene !== undefined && scenes.has(startScene) ? startScene : editing;
}

/** The project's name as the top bar shows it: `Name *` while there are unsaved documents. */
/** The browser tab's title for a project. */
export function editorPageTitle(title: string): string {
  return `${title} — Parallax Editor`;
}

export function projectLabel(title: string, dirty: boolean): string {
  return dirty ? `${title} *` : title;
}

/** How often the editor camera is written to the camera memory (when it moved). */
const CAMERA_MEMORY_MS = 1_000;

export type LogLevel = 'info' | 'warning' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly text: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly time: Date;
}

export interface GizmoSettings {
  mode: GizmoMode;
  space: GizmoSpace;
  /** Snapping while dragging (Ctrl / Cmd held inverts it). */
  snap: boolean;
}

export const SNAP = { translate: 0.5, rotate: 15, scale: 0.1 } as const;

export class Editor {
  readonly session: EditorSession;
  readonly game: BrowserGame;
  #title: string;
  readonly gizmo: GizmoSettings = { mode: 'translate', space: 'world', snap: false };
  readonly log: LogEntry[] = [];
  /** The Scene tab's camera in the play world (the viewport's, not the game's: panels leave it out). */
  playCamera: EntityId | undefined;
  /** Build diagnostics of the code the session runs (the server's latest build). */
  buildDiagnostics: readonly Diagnostic[] = [];
  /** The last save that wrote files (undefined before the first). */
  lastSave: SaveRecord | undefined;
  readonly #listeners = new Set<(changes: ReadonlySet<Change>) => void>();
  readonly #cameras: CameraMemory;
  #saving = false;
  /** Files changed outside while the game played, for Stop to take in. */
  readonly #outside = new Map<string, string | null>();

  constructor(game: BrowserGame, session: EditorSession, title: string, options: { readonly cameras?: CameraMemory } = {}) {
    this.game = game;
    this.session = session;
    this.#title = title;
    session.documents.onChange(() => this.emit('documents', 'world'));
    this.#cameras = options.cameras ?? new CameraMemory(projectKey(game.runtime.game.id, globalThis.location?.search ?? ''));
    this.#restoreCamera();
  }

  /** The project's name, as the top bar and the page title show it. */
  get title(): string {
    return this.#title;
  }

  /**
   * Show the project under a new name (the top bar, the page title, Publish's context). The
   * editor stores no name of its own: a host's rename action (`EditorHost.setRenameAction`)
   * saves it where the project lives, then calls this.
   */
  setTitle(title: string): void {
    const next = title.trim();
    if (next === '' || next === this.#title) return;
    this.#title = next;
    if (globalThis.document !== undefined) document.title = editorPageTitle(next);
    this.emit('title');
  }

  /** There are unsaved documents. */
  get dirty(): boolean {
    return this.documents.dirty().length > 0;
  }

  get documents(): EditorSession['documents'] {
    return this.session.documents;
  }

  get editing(): boolean {
    return this.session.mode === 'edit';
  }

  /** Why editing is locked (`setReadOnly`), or null. */
  get readOnly(): string | null {
    return this.documents.locked;
  }

  /**
   * Lock editing (`reason`: what the indicator says, e.g. "Another tool is editing") or
   * unlock it (null). While locked the documents refuse every edit (PP9648), a drag in
   * progress is cancelled and saves wait; looking, selecting and Play still work, and files
   * changed outside still arrive (`takeOutsideChanges`).
   */
  setReadOnly(reason: string | null): void {
    if (reason === this.documents.locked) return;
    if (reason === null) {
      this.documents.unlock();
    } else {
      if (this.editing && this.session.dragging) this.session.cancelDrag();
      this.documents.lock(reason);
    }
    this.emit('mode', 'documents', 'world');
  }

  /**
   * Data files changed outside the editor (path → new text, null: removed) go into the
   * documents and the edit world without reloading the page. While playing they wait for
   * Stop. Unsaved edits to those paths give way to the files.
   */
  takeOutsideChanges(files: ReadonlyMap<string, string | null>): void {
    if (files.size === 0) return;
    for (const [path, text] of files) this.#outside.set(path, text);
    if (this.editing) this.#applyOutside();
  }

  #applyOutside(): void {
    if (this.#outside.size === 0) return;
    const files = new Map(this.#outside);
    this.#outside.clear();
    const errors = this.run('Files changed outside', () => this.session.replaceFiles(files));
    this.write('info', `Took the changes to ${[...files.keys()].join(', ')}`);
    if (errors !== undefined && errors.length > 0) this.write('warning', 'The changed files have problems; the scene shows the last good state', errors);
    this.emit('documents', 'world', 'selection');
  }

  on(listener: (changes: ReadonlySet<Change>) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  emit(...changes: Change[]): void {
    const set = new Set(changes);
    for (const listener of this.#listeners) listener(set);
  }

  write(level: LogLevel, text: string, diagnostics: readonly Diagnostic[] = []): void {
    this.log.push({ level, text, diagnostics, time: new Date() });
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.emit('log');
  }

  /** Run an action; a failure goes to the console (with its diagnostics) and answers undefined. */
  run<T>(what: string, action: () => T, ...changes: Change[]): T | undefined {
    try {
      const out = action();
      if (changes.length > 0) this.emit(...changes);
      return out;
    } catch (error) {
      this.fail(what, error);
      return undefined;
    }
  }

  fail(what: string, error: unknown): void {
    const diagnostics = diagnosticsOf(error);
    this.write('error', `${what}: ${diagnostics[0]?.message ?? (error as Error).message ?? String(error)}`, diagnostics);
  }

  // ── Selection and entities ──────────────────────────────────────────────────

  /** The scene row was picked: Properties shows the scene's settings (cleared by any select). */
  sceneSelected = false;

  select(ids: readonly EntityId[]): void {
    this.sceneSelected = false;
    this.run('Select', () => this.session.select(ids), 'selection');
  }

  /** Pick the scene row: no entity selected, the scene's settings in Properties. */
  selectScene(): void {
    this.session.select([]);
    this.sceneSelected = true;
    this.emit('selection');
  }

  /** Delete the selection: placements from the scene, prefab children from their prefab (undoable). */
  removeSelected(): void {
    const ids = this.session.selection;
    if (ids.length === 0 || !this.editing) return;
    this.run('Delete', () => {
      this.session.deleteEntities(ids);
      this.session.select([]);
    }, 'selection', 'world');
  }

  /**
   * Rename an entity: its placement's id or prefab child's name ('' removes it). What is
   * typed is made a code name ("My Crate" → "My_Crate"). The hierarchy and inspector both call this.
   */
  renameEntity(id: EntityId, name: string): void {
    if (!this.editing) return;
    const clean = name.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=\d)/, '_');
    this.run('Rename', () => this.session.rename(id, clean), 'world', 'selection');
  }

  /** Ask for an in-place rename of the selection's first entity (F2). */
  requestRename(): void {
    if (this.editing && this.session.selection.length > 0) this.emit('rename');
  }

  /** Place a prefab at `at` (a drop point), else ahead of the editor camera (3D) or at the view's center (2D). */
  addPrefab(prefab: string, at?: readonly number[]): void {
    if (!this.editing) return;
    const pose = this.session.cameraPose;
    const where = at?.map(round) ?? (this.session.dimension === '2d'
      ? [round(pose.position.x), round(pose.position.y)]
      : placeAhead(pose.position, pose.rotation.rotate(Vec3.FORWARD)));
    const placement: JsonObject = { prefab, at: where };
    const id = this.run(`Add ${prefab}`, () => this.session.addEntity(placement));
    if (id !== undefined) {
      this.select([id]);
      this.write('info', `Placed ${prefab} at [${where.join(', ')}]`);
    }
  }

  openScene(scene: string): void {
    this.rememberCamera();
    const opened = this.run(`Open ${scene}`, () => { this.session.openScene(scene); return true; });
    if (opened === true) this.#restoreCamera();
    this.emit('world', 'selection');
  }

  // ── Editor camera memory ────────────────────────────────────────────────────

  /** Keep the editor camera's pose for this project and scene (edit mode; a no-op when it hasn't moved). */
  rememberCamera(): void {
    if (this.editing) this.#cameras.save(this.session.scene, this.session.cameraPose);
  }

  /** The remembered pose of the open scene, if it was viewed before (else the session's: the game camera). */
  #restoreCamera(): void {
    const pose = this.#cameras.load(this.session.scene);
    if (pose !== undefined && this.editing) this.session.setCamera(pose);
  }

  // ── History ─────────────────────────────────────────────────────────────────

  undo(): void {
    if (this.editing) this.run('Undo', () => this.session.undo(), 'selection');
  }

  redo(): void {
    if (this.editing) this.run('Redo', () => this.session.redo(), 'selection');
  }

  // ── Play ────────────────────────────────────────────────────────────────────

  play(): void {
    if (this.session.mode === 'paused') {
      this.resume();
      return;
    }
    if (!this.editing) return;
    this.rememberCamera();
    const scene = playStartScene(this.session.startScene, this.session.scene, this.documents.project().scenes);
    const ok = this.run('Play', () => { this.session.play({ scene }); return true; }, 'mode', 'world', 'selection');
    if (ok === true) {
      this.write('info', scene === this.session.scene ? `Playing ${scene}` : `Playing from the start scene ${scene} (Stop returns to ${this.session.scene})`);
      // Keys and pointer now belong to the game.
      this.game.stage.stage.focus({ preventScroll: true });
    }
  }

  pause(): void {
    this.run('Pause', () => this.session.pause(), 'mode');
  }

  resume(): void {
    this.run('Resume', () => this.session.resume(), 'mode');
    this.game.stage.stage.focus({ preventScroll: true });
  }

  step(): void {
    if (this.session.mode === 'playing') this.pause();
    this.run('Step', () => this.session.step(1), 'world');
  }

  stop(): void {
    if (this.editing) return;
    const problems = this.run('Stop', () => this.session.stop(), 'mode', 'world', 'selection');
    if (problems !== undefined && problems.length > 0) this.write('warning', 'The edit world was rebuilt from the documents', problems);
    if (this.editing) this.#applyOutside();
  }

  setTimeScale(scale: number): void {
    this.run('Time scale', () => this.session.setTimeScale(scale));
  }

  // ── Saving ──────────────────────────────────────────────────────────────────

  get saving(): boolean {
    return this.#saving;
  }

  async save(options: SaveOptions = {}): Promise<void> {
    if (this.#saving) return;
    // Locked: the host is writing the project; unsaved edits wait for the unlock.
    if (this.documents.locked !== null) {
      if (options.auto !== true && this.dirty) this.write('warning', `Not saved: the project is read-only for now (${this.documents.locked})`);
      return;
    }
    this.#saving = true;
    this.emit('documents');
    let saved: string[] = [];
    try {
      const disk = this.game.sources.files;
      const onDisk = new Set(disk.list());
      saved = await save(this.documents, (path) => (onDisk.has(path) ? disk.read(path) : undefined), options.keepalive === true ? keepaliveFetch : fetch);
      if (saved.length > 0) {
        this.lastSave = { paths: saved, time: new Date(), auto: options.auto === true };
        this.write('info', `${options.auto === true ? 'Autosaved' : 'Saved'} ${saved.join(', ')}`);
      }
    } catch (error) {
      this.fail(options.auto === true ? 'Autosave' : 'Save', error);
    } finally {
      this.#saving = false;
      if (saved.length > 0) this.emit('documents', 'saved');
      else this.emit('documents');
    }
  }

  /**
   * Autosave every 30 s while there are unsaved documents (not while playing or dragging),
   * a save when the page is hidden or closed, and the editor camera remembered as it moves.
   * Ctrl+S and Save work as before. Answers a function that stops all of it.
   */
  startAutosave(options: { readonly target?: EventTarget; readonly intervalMs?: number } = {}): () => void {
    const target = options.target ?? globalThis;
    const state: AutosaveOptions['state'] = () => ({
      dirty: this.dirty && this.documents.locked === null, playing: !this.editing, dragging: this.session.dragging, saving: this.#saving,
    });
    const autosave = new Autosave({ state, save: () => this.save({ auto: true }), ...(options.intervalMs !== undefined && { intervalMs: options.intervalMs }) });
    autosave.start();
    const camera = setInterval(() => this.rememberCamera(), CAMERA_MEMORY_MS);
    // Hidden (tab switched, app backgrounded, or closing): keep the camera and the edits now.
    // The documents don't change while the game plays, so a page that goes away mid-play saves too.
    const hidden = (): void => {
      this.rememberCamera();
      const s = state();
      if (s.dirty && !s.dragging && !s.saving) void this.save({ auto: true, keepalive: true });
    };
    const visibility = (): void => { if (globalThis.document?.visibilityState === 'hidden') hidden(); };
    target.addEventListener('pagehide', hidden);
    globalThis.document?.addEventListener('visibilitychange', visibility);
    return () => {
      autosave.stop();
      clearInterval(camera);
      target.removeEventListener('pagehide', hidden);
      globalThis.document?.removeEventListener('visibilitychange', visibility);
    };
  }
}

/** A save that outlives the page (`keepalive`; the browser caps such bodies at 64 KB, so a larger one goes plain). */
const keepaliveFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, { ...init, keepalive: true });
  } catch {
    return fetch(input, init);
  }
};

/** Eight meters along the view, kept above the ground plane. */
function placeAhead(from: Vec3, forward: Vec3): number[] {
  const p = from.__add__(forward.__mul__(8));
  return [round(p.x), round(Math.max(0, p.y)), round(p.z)];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
