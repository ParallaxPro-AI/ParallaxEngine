/**
 * The project's files as an editor holds them: the files it was opened on (read when first
 * needed), the JSON documents parsed on demand, edited by patches. Edits are JSON-Patch operations (RFC 6902 add /
 * remove / replace) on one file each; applying returns the inverse, which is what undo
 * stores. It is a `ProjectFiles`, so a game (and `loadProject`) runs on the edited data
 * directly, and the project it loads is cached until the next edit.
 *
 * A patch whose pointer is "" creates (`add`), replaces or deletes (`remove`) a whole
 * file. Edited files are written back as 2-space-indented JSON; untouched files keep
 * their text byte for byte.
 */

import { fail } from '@parallax/runtime/core';
import type { ProjectFiles } from '@parallax/runtime/core';
import { loadProject } from '@parallax/runtime/resource';
import type { Json, JsonObject, Project } from '@parallax/runtime/resource';

export type JsonOp =
  | { readonly op: 'add'; readonly pointer: string; readonly value: Json }
  | { readonly op: 'replace'; readonly pointer: string; readonly value: Json }
  | { readonly op: 'remove'; readonly pointer: string };

/** Operations on one file, applied in order. */
export interface FilePatch {
  readonly path: string;
  readonly ops: readonly JsonOp[];
}

type Mutable = { [key: string]: unknown } | unknown[];

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) fail('PP9621', `"${pointer}" is not a JSON pointer`, { fix: 'Start it with "/" ("" is the whole document).' });
  return pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function pointerOf(...segments: readonly (string | number)[]): string {
  return segments.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** The value at a pointer, or undefined. */
export function getAt(doc: Json | undefined, pointer: string): Json | undefined {
  let at: unknown = doc;
  for (const key of parsePointer(pointer)) {
    if (Array.isArray(at)) at = at[Number(key)];
    else if (typeof at === 'object' && at !== null) at = (at as Record<string, unknown>)[key];
    else return undefined;
  }
  return at as Json | undefined;
}

function where(path: string, pointer: string): string {
  return `${path}${pointer === '' ? '' : ` at ${pointer}`}`;
}

/** Apply one op to a mutable document (root ops are handled by the caller); returns its inverse. */
function applyOp(doc: Mutable, op: JsonOp, path: string): JsonOp {
  const keys = parsePointer(op.pointer);
  const last = keys.pop()!;
  let parent: unknown = doc;
  for (const key of keys) {
    parent = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, unknown> | null)?.[key];
    if (typeof parent !== 'object' || parent === null) {
      fail('PP9622', `Can't edit ${where(path, op.pointer)}: its parent doesn't exist`, { fix: 'Add the parent object first (or re-read the document; it changed).' });
    }
  }
  if (Array.isArray(parent)) {
    const index = last === '-' ? parent.length : Number(last);
    const bound = op.op === 'add' ? parent.length : parent.length - 1;
    if (!Number.isInteger(index) || index < 0 || index > bound) {
      fail('PP9622', `Can't ${op.op} ${where(path, op.pointer)}: index ${last} is out of range`, { fix: 'Re-read the document; it changed.' });
    }
    if (op.op === 'add') {
      parent.splice(index, 0, clone(op.value));
      return { op: 'remove', pointer: pointerOf(...keys, index) };
    }
    const old = parent[index] as Json;
    if (op.op === 'remove') {
      parent.splice(index, 1);
      return { op: 'add', pointer: op.pointer, value: old };
    }
    parent[index] = clone(op.value);
    return { op: 'replace', pointer: op.pointer, value: old };
  }
  const obj = parent as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(obj, last);
  const old = obj[last] as Json;
  if (op.op === 'remove' || op.op === 'replace') {
    if (!had) fail('PP9622', `Can't ${op.op} ${where(path, op.pointer)}: there is nothing there`, { fix: 'Use "add", or re-read the document.' });
  }
  if (op.op === 'remove') {
    delete obj[last];
    return { op: 'add', pointer: op.pointer, value: old };
  }
  obj[last] = clone(op.value);
  return had ? { op: 'replace', pointer: op.pointer, value: old } : { op: 'remove', pointer: op.pointer };
}

export class ProjectDocuments implements ProjectFiles {
  readonly #base: ProjectFiles;
  /** Files written by edits (created or changed); everything else is read from the base files. */
  readonly #text = new Map<string, string>();
  readonly #paths: Set<string>;
  readonly #json = new Map<string, Json>();
  readonly #dirty = new Set<string>();
  readonly #listeners = new Set<(paths: readonly string[]) => void>();
  #project: Project | undefined;
  #version = 0;
  #locked: string | null = null;

  /** Edits over `files`, which are read when first needed (and never changed). */
  constructor(files: ProjectFiles) {
    this.#base = files;
    this.#paths = new Set(files.list());
  }

  /** Grows by one per applied edit (and per `replaceFiles`). */
  get version(): number {
    return this.#version;
  }

  /** Why edits are refused now (`lock`), or null. */
  get locked(): string | null {
    return this.#locked;
  }

  /**
   * Refuse every edit (`apply`, so undo and redo too) until `unlock`, e.g. while another
   * tool writes the project. `replaceFiles` still takes the files it writes.
   */
  lock(reason: string): void {
    this.#locked = reason;
  }

  unlock(): void {
    this.#locked = null;
  }

  /**
   * Take files changed outside the editor (another program, a host's tool): each
   * path's new text, or null when it was removed. The documents read them from now on as
   * saved, any unsaved edit to those paths dropped. Listeners hear the paths.
   */
  replaceFiles(files: ReadonlyMap<string, string | null>): void {
    if (files.size === 0) return;
    for (const [path, text] of files) {
      this.#json.delete(path);
      this.#dirty.delete(path);
      if (text === null) {
        this.#paths.delete(path);
        this.#text.delete(path);
      } else {
        this.#paths.add(path);
        this.#text.set(path, text);
      }
    }
    this.#project = undefined;
    this.#version++;
    const changed = [...files.keys()];
    for (const listener of this.#listeners) listener(changed);
  }

  list(): string[] {
    return [...this.#paths].sort();
  }

  read(path: string): string {
    if (!this.#paths.has(path)) fail('PP9623', `There is no file "${path}" in the project`);
    return this.#text.get(path) ?? this.#base.read(path);
  }

  has(path: string): boolean {
    return this.#paths.has(path);
  }

  /** A JSON file, parsed (a copy: edit through `apply`). */
  json(path: string): Json {
    return clone(this.#parsed(path));
  }

  /** A value inside a JSON file, or undefined. */
  get(path: string, pointer: string): Json | undefined {
    return clone(getAt(this.#paths.has(path) ? this.#parsed(path) : undefined, pointer));
  }

  #parsed(path: string): Json {
    const cached = this.#json.get(path);
    if (cached !== undefined) return cached;
    const text = this.read(path);
    let value: Json;
    try {
      value = JSON.parse(text) as Json;
    } catch (error) {
      return fail('PP9624', `${path} is not valid JSON: ${(error as Error).message}`, { path, fix: 'Fix the file\'s syntax before editing it here.' });
    }
    this.#json.set(path, value);
    return value;
  }

  /** The project as `loadProject` reads these files (cached until the next edit). */
  project(): Project {
    this.#project ??= loadProject(this);
    return this.#project;
  }

  /**
   * Apply patches atomically: every op is checked against a working copy first, so a
   * failing op changes nothing. Returns the inverse patches (apply them to undo), last
   * file first.
   */
  apply(patches: readonly FilePatch[]): FilePatch[] {
    if (this.#locked !== null) {
      fail('PP9648', `The project is read-only for now: ${this.#locked}`, { fix: 'Wait until editing is unlocked, then make the change again.' });
    }
    const working = new Map<string, Json | null>();
    const inverse: FilePatch[] = [];
    for (const patch of patches) {
      let doc: Json | null = working.has(patch.path) ? working.get(patch.path)! : (this.#paths.has(patch.path) ? clone(this.#parsed(patch.path)) : null);
      const undo: JsonOp[] = [];
      for (const op of patch.ops) {
        if (op.pointer === '') {
          if (op.op === 'add') {
            if (doc !== null) fail('PP9622', `Can't create ${patch.path}: it exists`, { fix: 'Use "replace" to overwrite it.' });
            doc = clone(op.value);
            undo.unshift({ op: 'remove', pointer: '' });
          } else {
            if (doc === null) fail('PP9622', `Can't ${op.op} ${patch.path}: it doesn't exist`, { fix: 'Use "add" to create it.' });
            undo.unshift(op.op === 'remove' ? { op: 'add', pointer: '', value: doc } : { op: 'replace', pointer: '', value: doc });
            doc = op.op === 'remove' ? null : clone(op.value);
          }
          continue;
        }
        if (doc === null || typeof doc !== 'object') {
          fail('PP9622', `Can't edit ${where(patch.path, op.pointer)}: the file holds no object or list`, { fix: 'Create the file first.' });
        }
        undo.unshift(applyOp(doc as Mutable, op, patch.path));
      }
      working.set(patch.path, doc);
      inverse.unshift({ path: patch.path, ops: undo });
    }
    const changed: string[] = [];
    for (const [path, doc] of working) {
      if (doc === null) {
        this.#paths.delete(path);
        this.#text.delete(path);
        this.#json.delete(path);
      } else {
        this.#paths.add(path);
        this.#text.set(path, `${JSON.stringify(doc, null, 2)}\n`);
        this.#json.set(path, doc);
      }
      this.#dirty.add(path);
      changed.push(path);
    }
    this.#project = undefined;
    this.#version++;
    for (const listener of this.#listeners) listener(changed);
    return inverse;
  }

  /** Files changed since the last `markSaved` (a host writes these to disk or the server). */
  dirty(): string[] {
    return [...this.#dirty].sort();
  }

  markSaved(paths: readonly string[] = this.dirty()): void {
    for (const path of paths) this.#dirty.delete(path);
  }

  /** Hear every applied edit (the paths it touched). */
  onChange(listener: (paths: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}

/** A JSON object's own keys and values, typed for reading documents. */
export function asObject(value: Json | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}
