/**
 * The shared library: ready-made behaviors, systems, panels and data that a
 * project COPIES. Nothing depends on the library at run time — once copied, a piece is the
 * project's own code.
 *
 *   shared_library/<category>/<piece>/
 *     piece.json   manifest: id, summary, version, requires (other pieces), plugins, setup
 *     files/       copied into the project at the same relative paths
 *     demo/        a minimal host project for the piece's own playtests (never copied)
 *
 * Copy rules: a file the project lacks is written; an identical one is left alone; a
 * different one is a conflict (nothing is written — the project's code is never
 * overwritten). `locale/*.json` files are merged key by key (a key with another text is a
 * conflict). Every copy is recorded in `<project>/.parallax/library.json` with the sha256 of
 * each file as copied.
 *
 * Roots: the library is `shared_library/` plus any extra roots, each laid out the same way
 * (`<root>/<category>/<piece>/piece.json`): `--library DIR` (repeatable), then the folders in
 * `PARALLAX_LIBRARY_PATH` (separated like PATH: ':', ';' on Windows). Ids are global: on a
 * clash the earlier root wins (shared_library first) and the later piece is skipped with a
 * warning, so an extra root adds pieces but never replaces one.
 *
 * Codes: PP9590 bad manifest, PP9591 unknown piece, PP9592 dependency cycle, PP9593 not a
 * project, PP9594 conflict, PP9595 plugin missing from the game (warning), PP9596 bad record.
 *
 * Plugins: a piece that needs a plugin the game doesn't list (piece.json `plugins`) adds it to
 * `Game(plugins=[...])` in game/main.py, with its `from parallax.plugins import`, as part of the
 * same plan — a model prefab with a collider in a game without physics would otherwise not
 * build. When the list can't be edited mechanically (no `Game(...)`, `plugins=` isn't a list
 * literal) or the game already has the other physics plugin (a game has one), main.py is left
 * alone and the add warns (PP9595).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { closestMatch, diagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';

/** The repository's `shared_library/`, next to `packages/`. */
export const LIBRARY_DIR = fileURLToPath(new URL('../../../shared_library/', import.meta.url));

export const RECORD_PATH = '.parallax/library.json';

/**
 * The library's roots, in precedence order: `shared_library/`, then `extra` (`--library DIR`
 * flags), then `PARALLAX_LIBRARY_PATH`'s folders. Empty entries are skipped and each folder is
 * listed once.
 */
export function libraryRoots(extra: readonly string[] = [], env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const fromEnv = (env['PARALLAX_LIBRARY_PATH'] ?? '').split(delimiter);
  const roots: string[] = [];
  for (const dir of [LIBRARY_DIR, ...extra, ...fromEnv]) {
    if (dir.trim() === '') continue;
    const abs = resolve(dir);
    if (!roots.some((r) => resolve(r) === abs)) roots.push(dir === LIBRARY_DIR ? dir : abs);
  }
  return roots;
}

export interface PieceManifest {
  readonly id: string;
  readonly summary: string;
  /** Date-shaped version of the piece ("2026.10.23"); bump when its files change. */
  readonly version: string;
  /** Pieces copied with this one (their files first). */
  readonly requires: readonly string[];
  /** Plugin factories the game must list in `Game(plugins=[...])` ("hud", "combat"). */
  readonly plugins: readonly string[];
  /** What the author does after copying (list a system, tag a scene, set a config value). */
  readonly setup: readonly string[];
  /** The old shared-library refs this piece replaces ("lib:pause_menu"). */
  readonly replaces: readonly string[];
  /** Check the demo with asset files required (default true). */
  readonly asset_files: boolean;
}

export interface Piece extends PieceManifest {
  /** Folder of the piece, absolute. */
  readonly dir: string;
  /** The library root the piece is in. */
  readonly root: string;
  /** "ui", "gameplay", … — the folder the piece sits in. */
  readonly category: string;
  /** Project-relative paths of every file under `files/`, sorted. */
  readonly files: readonly string[];
}

export interface Library {
  /** The first root (shared_library/ unless roots were given): where the search index lives. */
  readonly root: string;
  /** Every root, in precedence order (`libraryRoots`). */
  readonly roots: readonly string[];
  readonly pieces: ReadonlyMap<string, Piece>;
  readonly diagnostics: readonly Diagnostic[];
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'build') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split('\\').join('/'));
  }
  return out.sort();
}

const ID = /^[a-z][a-z0-9_]*$/;
const KEYS = ['id', 'summary', 'version', 'requires', 'plugins', 'setup', 'replaces', 'asset_files'];

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function readManifest(dir: string, root: string, category: string, out: Diagnostic[]): Piece | undefined {
  const path = `${dir}/piece.json`;
  const where = relative(resolve(dir, '../..'), path);
  const bad = (message: string, fix: string): undefined => {
    out.push(diagnostic('PP9590', message, { path: where, fix }));
    return undefined;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return bad(`piece.json is not JSON: ${(error as Error).message}`, 'Fix the JSON syntax.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('piece.json must be an object', 'Write {"id": …, "summary": …}.');
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!KEYS.includes(key)) {
      const near = closestMatch(key, KEYS);
      return bad(`piece.json has an unknown key "${key}"`, near !== undefined ? `Did you mean "${near}"?` : `Keys: ${KEYS.join(', ')}.`);
    }
  }
  const folder = dir.split('/').pop()!;
  if (typeof m['id'] !== 'string' || !ID.test(m['id'])) return bad('"id" must be a snake_case string', `Use the folder name, "${folder}".`);
  if (m['id'] !== folder) return bad(`"id" is "${m['id']}" but the folder is "${folder}"`, 'Name the folder after the piece id.');
  if (typeof m['summary'] !== 'string' || m['summary'].trim() === '') return bad('"summary" must be a sentence', 'Say in one line what the piece gives a game.');
  if (typeof m['version'] !== 'string' || !/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(m['version'])) return bad('"version" must look like "2026.10.23"', 'Use the date the piece last changed.');
  for (const key of ['requires', 'plugins', 'setup', 'replaces']) {
    if (m[key] !== undefined && !strings(m[key])) return bad(`"${key}" must be a list of strings`, `Write "${key}": ["…"].`);
  }
  if (m['asset_files'] !== undefined && typeof m['asset_files'] !== 'boolean') return bad('"asset_files" must be true or false', 'Remove it, or write false when the demo names sounds or images the library does not ship.');
  const files = walk(`${dir}/files`);
  if (files.length === 0) return bad('the piece has no files/', 'Put what the piece copies into files/, laid out like a project.');
  return {
    id: m['id'],
    summary: m['summary'],
    version: m['version'],
    requires: (m['requires'] as string[] | undefined) ?? [],
    plugins: (m['plugins'] as string[] | undefined) ?? [],
    setup: (m['setup'] as string[] | undefined) ?? [],
    replaces: (m['replaces'] as string[] | undefined) ?? [],
    asset_files: (m['asset_files'] as boolean | undefined) ?? true,
    dir,
    root,
    category,
    files,
  };
}

/**
 * Every piece under the roots (`<root>/<category>/<piece>/piece.json`), with manifest
 * problems. Default: `libraryRoots()` (shared_library/ and PARALLAX_LIBRARY_PATH); a piece
 * in a later root with an earlier root's id is skipped (a warning).
 */
export function loadLibrary(roots: string | readonly string[] = libraryRoots()): Library {
  const all = typeof roots === 'string' ? [roots] : [...roots];
  const first = all[0] ?? LIBRARY_DIR;
  const out: Diagnostic[] = [];
  const pieces = new Map<string, Piece>();
  for (const [r, root] of all.entries()) {
    if (!existsSync(root)) {
      out.push(diagnostic('PP9590', `There is no library at ${root}`, {
        fix: r === 0 ? 'Run from a ParallaxEngine checkout: it has shared_library/ next to packages/.'
          : 'Fix the folder named by --library or PARALLAX_LIBRARY_PATH: a library root holds <category>/<piece>/piece.json.',
      }));
      continue;
    }
    for (const category of readdirSync(root, { withFileTypes: true })) {
      if (!category.isDirectory() || category.name.startsWith('_') || category.name.startsWith('.')) continue;
      for (const entry of readdirSync(`${root}/${category.name}`, { withFileTypes: true })) {
        const dir = `${root}/${category.name}/${entry.name}`;
        if (!entry.isDirectory() || !existsSync(`${dir}/piece.json`)) continue;
        const piece = readManifest(dir, root, category.name, out);
        if (piece === undefined) continue;
        const twin = pieces.get(piece.id);
        if (twin !== undefined && twin.root !== root) {
          out.push(diagnostic('PP9590', `Two pieces are called "${piece.id}": ${dir} is skipped, ${twin.dir} (an earlier library root) is used`, {
            severity: 'warning', fix: 'Piece ids are global across library roots; rename the later one to use both.',
          }));
          continue;
        }
        if (twin !== undefined) {
          out.push(diagnostic('PP9590', `Two pieces are called "${piece.id}" (${twin.category}/ and ${category.name}/)`, { fix: 'Piece ids are global; rename one.' }));
          continue;
        }
        pieces.set(piece.id, piece);
      }
    }
  }
  for (const piece of pieces.values()) {
    for (const need of piece.requires) {
      if (!pieces.has(need)) {
        out.push(diagnostic('PP9591', `${piece.id} requires "${need}", which is not a piece`, {
          path: `${piece.category}/${piece.id}/piece.json`, fix: hint(need, pieces),
        }));
      }
    }
  }
  return { root: first, roots: all, pieces, diagnostics: out };
}

function hint(id: string, pieces: ReadonlyMap<string, Piece>): string {
  const near = closestMatch(id, [...pieces.keys()]);
  return near !== undefined ? `Did you mean "${near}"? (parallax library list)` : 'See `parallax library list`.';
}

/** The pieces to copy for `ids`, dependencies first, each once. */
export function resolvePieces(library: Library, ids: readonly string[]): { pieces: Piece[]; diagnostics: Diagnostic[] } {
  const order: Piece[] = [];
  const done = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const visit = (id: string, chain: readonly string[]): void => {
    if (done.has(id)) return;
    if (chain.includes(id)) {
      diagnostics.push(diagnostic('PP9592', `Pieces require each other in a cycle: ${[...chain, id].join(' → ')}`, { fix: 'Remove one of the requires.' }));
      return;
    }
    const piece = library.pieces.get(id);
    if (piece === undefined) {
      diagnostics.push(diagnostic('PP9591', `There is no library piece "${id}"`, { fix: hint(id, library.pieces) }));
      return;
    }
    for (const need of piece.requires) visit(need, [...chain, id]);
    done.add(id);
    order.push(piece);
  };
  for (const id of ids) visit(id, []);
  return { pieces: order, diagnostics };
}

// ─────────────────────────────────────────────────────────────────────────────
// Copying
// ─────────────────────────────────────────────────────────────────────────────

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Files merged key by key instead of copied whole. */
export function isMergedFile(path: string): boolean {
  return /^locale\/[^/]+\.json$/.test(path);
}

export interface RecordedPiece {
  readonly from: string;
  readonly version: string;
  /** sha256 over the piece's files as copied (path + content, in order). */
  readonly sha: string;
  /** Copied file → sha256 as copied. */
  readonly files: Readonly<Record<string, string>>;
  /** Merged file → the keys this piece added or found already equal. */
  readonly text: Readonly<Record<string, readonly string[]>>;
}

export interface LibraryRecord {
  readonly pieces: Readonly<Record<string, RecordedPiece>>;
}

export interface AddPlan {
  readonly pieces: readonly Piece[];
  /** Project-relative path → new content (copies and merged files). */
  readonly writes: ReadonlyMap<string, Uint8Array>;
  /** Files already identical in the project. */
  readonly unchanged: readonly string[];
  readonly record: LibraryRecord;
  readonly diagnostics: readonly Diagnostic[];
  /** Plugin factories the plan adds to `Game(plugins=[...])` in game/main.py (its write is in `writes`). */
  readonly plugins: readonly string[];
}

function readRecord(projectDir: string, out: Diagnostic[]): LibraryRecord {
  const path = `${projectDir}/${RECORD_PATH}`;
  if (!existsSync(path)) return { pieces: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as LibraryRecord;
    if (typeof raw === 'object' && raw !== null && typeof raw.pieces === 'object' && raw.pieces !== null) return raw;
  } catch {
    // reported below
  }
  out.push(diagnostic('PP9596', `${RECORD_PATH} is not a library record`, { path: RECORD_PATH, fix: 'Restore it from version control, or delete it (copied files stay; only the provenance is lost).' }));
  return { pieces: {} };
}

export function readLibraryRecord(projectDir: string): { record: LibraryRecord; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return { record: readRecord(projectDir, diagnostics), diagnostics };
}

type Json = Record<string, unknown>;

function parseObject(text: string): Json | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What copying `ids` (and their requirements) into `projectDir` would do. Nothing is
 * written; `applyAdd` writes a plan without conflicts. `requireProject: false` lets the
 * library's own tests copy into an empty scratch folder.
 */
export function planAdd(library: Library, projectDir: string, ids: readonly string[], options: { requireProject?: boolean } = {}): AddPlan {
  const diagnostics: Diagnostic[] = [];
  const resolved = resolvePieces(library, ids);
  diagnostics.push(...resolved.diagnostics);
  const empty: AddPlan = { pieces: [], writes: new Map(), unchanged: [], record: { pieces: {} }, diagnostics, plugins: [] };
  if ((options.requireProject ?? true) && !existsSync(`${projectDir}/game/main.py`)) {
    diagnostics.push(diagnostic('PP9593', `${projectDir} is not a Parallax project (no game/main.py)`, { fix: 'Name the project folder: parallax library add <piece> <project>.' }));
  }
  if (diagnostics.some((d) => d.severity === 'error')) return empty;

  const previous = readRecord(projectDir, diagnostics);
  const writes = new Map<string, Uint8Array>();
  const merged = new Map<string, Json>();
  const unchanged: string[] = [];
  const recorded: Record<string, RecordedPiece> = { ...previous.pieces };
  const encoder = new TextEncoder();
  const current = (path: string): Uint8Array | undefined => {
    const planned = writes.get(path);
    if (planned !== undefined) return planned;
    const full = `${projectDir}/${path}`;
    return existsSync(full) ? readFileSync(full) : undefined;
  };

  for (const piece of resolved.pieces) {
    const files: Record<string, string> = {};
    const text: Record<string, string[]> = {};
    const whole = createHash('sha256');
    for (const path of piece.files) {
      const data = readFileSync(`${piece.dir}/files/${path}`);
      whole.update(path).update(data);
      if (isMergedFile(path)) {
        const fragment = parseObject(new TextDecoder().decode(data));
        if (fragment === undefined) {
          diagnostics.push(diagnostic('PP9590', `${piece.id}: files/${path} must be a JSON object of strings`, { fix: 'Write {"key": "text"}.' }));
          continue;
        }
        let target = merged.get(path);
        if (target === undefined) {
          const existing = current(path);
          const parsed = existing === undefined ? {} : parseObject(new TextDecoder().decode(existing));
          if (parsed === undefined) {
            diagnostics.push(diagnostic('PP9594', `${path} in the project is not a JSON object, so ${piece.id}'s strings can't be merged into it`, { path, fix: 'Fix the file, then add the piece again.' }));
            continue;
          }
          target = parsed;
          merged.set(path, target);
        }
        const keys: string[] = [];
        for (const [key, value] of Object.entries(fragment)) {
          if (!(key in target)) target[key] = value;
          else if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
            diagnostics.push(diagnostic('PP9594', `${path} already has "${key}" with another text than ${piece.id}'s`, {
              path, fix: `Keep yours and skip the piece's: rename your key, or set it to ${JSON.stringify(value)} first.`,
            }));
            continue;
          }
          keys.push(key);
        }
        text[path] = keys;
        continue;
      }
      files[path] = sha256(data);
      const existing = current(path);
      if (existing === undefined) writes.set(path, data);
      else if (same(existing, data)) {
        if (!writes.has(path) && !unchanged.includes(path)) unchanged.push(path);
      }
      else {
        const was = previous.pieces[piece.id]?.files[path];
        const why = was === undefined
          ? 'the project already has a different file there'
          : was === sha256(existing) ? 'the library\'s copy changed since it was added' : 'it was edited since it was copied';
        diagnostics.push(diagnostic('PP9594', `${piece.id} would overwrite ${path}: ${why}`, {
          path, fix: was === undefined
            ? 'Move or rename the project\'s file, then add the piece again.'
            : 'Merge by hand; the library never overwrites project code.',
        }));
      }
    }
    recorded[piece.id] = {
      from: relative(resolve(piece.root, '..'), piece.dir).split('\\').join('/'),
      version: piece.version,
      sha: whole.digest('hex'),
      files,
      text,
    };
  }
  for (const [path, value] of merged) {
    const data = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
    const existing = current(path);
    if (existing === undefined || !same(existing, data)) writes.set(path, data);
  }
  // The plugins the pieces need, added to game/main.py (or warned about when that can't be done).
  const main = current(MAIN_PATH);
  let plugins: string[] = [];
  if (main !== undefined) {
    const source = new TextDecoder().decode(main);
    const needed = unlisted(source, resolved.pieces);
    const edit = needed.length > 0 ? withPlugins(source, needed.map((n) => n.plugin)) : undefined;
    if (edit !== undefined && edit.added.length > 0) {
      writes.set(MAIN_PATH, encoder.encode(edit.source));
      plugins = edit.added;
    }
    for (const { piece, plugin } of needed) {
      if (!plugins.includes(plugin)) diagnostics.push(pluginWarning(piece, plugin));
    }
  }
  return { pieces: resolved.pieces, writes, unchanged, record: { pieces: recorded }, diagnostics, plugins };
}

const MAIN_PATH = 'game/main.py';

/** The other physics plugin: a game lists one, so the one a piece names is never added beside it. */
const PHYSICS_RIVAL: Readonly<Record<string, string>> = { physics2d: 'physics3d', physics3d: 'physics2d' };

function lists(source: string, plugin: string): boolean {
  return new RegExp(`\\b${plugin}\\s*\\(`).test(codeOnly(source));
}

/**
 * `source` with every string literal and comment blanked to spaces (newlines kept), so offsets
 * still line up: a docstring that mentions `Game(plugins=[...])` is not the call.
 */
export function codeOnly(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    if (c === '#') {
      const eol = source.indexOf('\n', i);
      const end = eol < 0 ? source.length : eol;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j) && (triple || source[j] !== '\n')) j += source[j] === '\\' ? 2 : 1;
      const end = Math.min(source.length, j + quote.length);
      blank(i, end);
      i = end;
    } else i++;
  }
  return out.join('');
}

/** Each (piece, plugin) whose plugin `source` doesn't call, first piece per plugin. */
function unlisted(source: string, pieces: readonly Piece[]): { piece: Piece; plugin: string }[] {
  const out: { piece: Piece; plugin: string }[] = [];
  for (const piece of pieces) {
    for (const plugin of piece.plugins) {
      if (!lists(source, plugin) && !out.some((n) => n.plugin === plugin)) out.push({ piece, plugin });
    }
  }
  return out;
}

function pluginWarning(piece: Piece, plugin: string): Diagnostic {
  return diagnostic('PP9595', `${piece.id} needs the ${plugin} plugin, and game/main.py doesn't list it`, {
    severity: 'warning', path: MAIN_PATH, fix: `Add ${plugin}() to Game(plugins=[...]) (from parallax.plugins import ${plugin}).`,
  });
}

/** Index just past the bracket closing the one opened at `open` (strings and comments skipped), or -1. */
function closing(source: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '#') {
      const end = source.indexOf('\n', i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j)) j += source[j] === '\\' ? 2 : 1;
      if (j >= source.length) return -1;
      i = j + quote.length - 1;
    } else if (pairs[c] !== undefined) {
      stack.push(pairs[c]!);
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** The indentation of the last line in `text` that holds code. */
function lastIndent(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return /^[ \t]*/.exec(lines[lines.length - 1] ?? '')![0];
}

/** `items` appended to a comma-separated bracket body (`[...]` / `(...)` contents). */
function appendItems(body: string, items: readonly string[]): string {
  const trimmed = body.replace(/\s+$/, '');
  if (trimmed === '') return items.join(', ');
  const tail = body.slice(trimmed.length);
  if (!body.includes('\n')) return `${trimmed}${trimmed.endsWith(',') ? ' ' : ', '}${items.join(', ')}`;
  const indent = lastIndent(trimmed);
  return `${trimmed}${trimmed.endsWith(',') ? '' : ','}${items.map((i) => `\n${indent}${i},`).join('')}${tail}`;
}

/**
 * `source` (a game/main.py) with `plugins` added to its `Game(plugins=[...])` and imported from
 * parallax.plugins; `added` is what went in (a physics plugin beside the other one never does).
 * Undefined when the call can't be edited mechanically.
 */
export function withPlugins(source: string, plugins: readonly string[]): { source: string; added: string[] } | undefined {
  const added: string[] = [];
  for (const p of plugins) {
    if (added.includes(p) || lists(source, p)) continue;
    const rival = PHYSICS_RIVAL[p];
    if (rival !== undefined && (lists(source, rival) || added.includes(rival))) continue;
    added.push(p);
  }
  if (added.length === 0) return { source, added };
  // Positions come from the code alone (no strings or comments); edits go into `source`.
  const code = codeOnly(source);
  const call = /(^|[^\w.])Game\s*\(/m.exec(code);
  if (call === null) return undefined;
  const open = call.index + call[0].length - 1;
  const close = closing(code, open);
  if (close < 0) return undefined;
  const args = code.slice(open + 1, close - 1);
  // A list written `plugins.physics3d()` (with `from parallax import plugins`) gets the same form and no import.
  const qualified = /\bplugins\.\w+\s*\(/.test(args);
  const calls = added.map((p) => `${qualified ? 'plugins.' : ''}${p}()`);
  let edited: string;
  const kw = /(^|[\s,])plugins\s*=\s*/.exec(args);
  if (kw !== null) {
    const at = open + 1 + kw.index + kw[0].length;
    if (code[at] !== '[') return undefined;
    const end = closing(code, at);
    if (end < 0 || end > close) return undefined;
    edited = `${source.slice(0, at + 1)}${appendItems(source.slice(at + 1, end - 1), calls)}${source.slice(end - 1)}`;
  } else if (args.trim() === '') {
    edited = `${source.slice(0, open + 1)}plugins=[${calls.join(', ')}]${source.slice(close - 1)}`;
  } else if (/^[ \t]*\n/.test(args)) {
    const indent = /\n([ \t]*)\S/.exec(args)?.[1] ?? '    ';
    edited = `${source.slice(0, open + 1)}\n${indent}plugins=[${calls.join(', ')}],${source.slice(open + 1)}`;
  } else {
    edited = `${source.slice(0, open + 1)}plugins=[${calls.join(', ')}], ${source.slice(open + 1)}`;
  }
  return { source: qualified ? edited : withImports(edited, added, call.index), added };
}

/** `names` added to `from parallax.plugins import ...` (a new import line when there is none). */
function withImports(source: string, names: readonly string[], before: number): string {
  const code = codeOnly(source);
  const line = /^from[ \t]+parallax\.plugins[ \t]+import[ \t]+/m.exec(code);
  if (line !== null && line.index < before) {
    const start = line.index + line[0].length;
    if (source[start] === '(') {
      const end = closing(source, start);
      if (end > 0) {
        const body = source.slice(start + 1, end - 1);
        const missing = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(body));
        return missing.length === 0 ? source : `${source.slice(0, start + 1)}${appendItems(body, missing)}${source.slice(end - 1)}`;
      }
    } else {
      const eol = source.indexOf('\n', start);
      const stop = eol < 0 ? source.length : eol;
      const text = source.slice(start, stop);
      const hash = text.indexOf('#');
      const list = (hash < 0 ? text : text.slice(0, hash)).replace(/\s+$/, '');
      if (!list.endsWith('\\')) {
        const missing = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(list));
        if (missing.length === 0) return source;
        return `${source.slice(0, start)}${list}, ${missing.join(', ')}${source.slice(start + list.length)}`;
      }
    }
  }
  const statement = `from parallax.plugins import ${names.join(', ')}\n`;
  // After the last top-level import (keeps `from __future__` first), else at the top.
  let at = 0;
  const imports = /^(?:from|import)[ \t][^\n]*(?:\n|$)/gm;
  for (let m = imports.exec(code); m !== null && m.index < before; m = imports.exec(code)) {
    if (m[0].includes('(') && !m[0].includes(')')) {
      const end = closing(source, m.index + m[0].indexOf('('));
      if (end < 0) break;
      const eol = source.indexOf('\n', end);
      at = eol < 0 ? source.length : eol + 1;
      imports.lastIndex = at;
    } else {
      at = m.index + m[0].length;
    }
  }
  const sep = at > 0 && !source.slice(0, at).endsWith('\n') ? '\n' : '';
  return `${source.slice(0, at)}${sep}${statement}${source.slice(at)}`;
}

/** Write a plan (refuses one with errors) and the record. */
export function applyAdd(projectDir: string, plan: AddPlan): void {
  if (plan.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error('applyAdd: the plan has errors; nothing was written');
  }
  for (const [path, data] of plan.writes) {
    const full = `${projectDir}/${path}`;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  mkdirSync(`${projectDir}/.parallax`, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(plan.record.pieces).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(`${projectDir}/${RECORD_PATH}`, `${JSON.stringify({ pieces: sorted }, null, 2)}\n`);
}

/** Plugins a piece needs that `game/main.py` doesn't seem to list (warnings, PP9595); `planAdd` adds what it can. */
export function missingPlugins(projectDir: string, pieces: readonly Piece[]): Diagnostic[] {
  const main = `${projectDir}/game/main.py`;
  if (!existsSync(main)) return [];
  const source = readFileSync(main, 'utf8');
  const out: Diagnostic[] = [];
  for (const piece of pieces) {
    for (const plugin of piece.plugins) {
      if (!lists(source, plugin)) out.push(pluginWarning(piece, plugin));
    }
  }
  return out;
}

/** One line per piece: `id  category  summary`. */
export function formatList(library: Library): string {
  const pieces = [...library.pieces.values()].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  const width = Math.max(0, ...pieces.map((p) => p.id.length));
  const lines: string[] = [];
  let category = '';
  for (const p of pieces) {
    if (p.category !== category) {
      category = p.category;
      lines.push(`${lines.length > 0 ? '\n' : ''}${category}/`);
    }
    lines.push(`  ${p.id.padEnd(width)}  ${p.summary}`);
  }
  return lines.join('\n');
}

/** One piece as `parallax library list --json` prints it. */
export interface ListedPiece {
  readonly id: string;
  readonly category: string;
  readonly summary: string;
  readonly version: string;
  readonly requires: readonly string[];
  /** Project-relative paths the piece copies (locale files are merged key by key). */
  readonly files: readonly string[];
}

/**
 * The library as data, sorted like `formatList`: what a host serving the editor needs to list
 * pieces and to know which project files an add would touch, without loading the library itself.
 */
export function listPieces(library: Library): ListedPiece[] {
  return [...library.pieces.values()]
    .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, category: p.category, summary: p.summary, version: p.version, requires: [...p.requires], files: [...p.files] }));
}

/** Lowercase words with a plural `s`/`es` dropped, so "pines" finds `tree_pine` and "benches" `bench`. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
    .map((w) => (/(x|z|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** One piece `parallax library search` found, with how well it matched. */
export interface FoundPiece extends ListedPiece {
  readonly score: number;
}

/**
 * Pieces matching `query`, best first. A query word in the id counts most, then the
 * category, then the summary (or `options.text`); a piece must match every query word somewhere, unless
 * none does, when the pieces matching the most words come back instead.
 */
export function searchPieces(library: Library, query: string, options: { category?: string; limit?: number; text?: (piece: Piece) => string } = {}): FoundPiece[] {
  const asked = [...new Set(words(query))];
  if (asked.length === 0) return [];
  const scored = listPieces(library)
    .filter((p) => options.category === undefined || p.category === options.category)
    .map((p) => {
      const id = words(p.id);
      const piece = library.pieces.get(p.id);
      const summary = new Set(words(options.text !== undefined && piece !== undefined ? options.text(piece) : p.summary));
      let score = 0;
      let matched = 0;
      for (const w of asked) {
        const s = id.includes(w) ? 10 : id.some((i) => i.startsWith(w) && w.length > 3 || w.startsWith(i) && i.length > 3) ? 6
          : p.category === w ? 3 : summary.has(w) ? 2 : [...summary].some((s) => s.startsWith(w) && w.length > 3) ? 1 : 0;
        if (s > 0) matched++;
        score += s;
      }
      // Shorter ids are the plainer match ("tree_pine" before "tree_pine_dead_snag").
      return { ...p, score: score * 100 + matched * 1000 - id.length, matched };
    })
    .filter((p) => p.matched > 0);
  const best = Math.max(0, ...scored.map((p) => p.matched));
  return scored
    .filter((p) => p.matched === best)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 10)
    .map(({ matched: _, ...p }) => p);
}

/** True when `path` is a directory (for argument parsing). */
export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
