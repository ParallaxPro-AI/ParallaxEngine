/**
 * Search by meaning for `parallax library search`: every piece's text (`pieceText`) embedded
 * once by a small local model and kept in `shared_library/_index/`, so "person" finds
 * `civilian` and "evergreen" finds `tree_pine` without either word in their names.
 *
 *   _index/index.json      {model, dims, ids, texts, hashes, stamps}: which piece each row is,
 *                          the text it was embedded from (keyword matching reads it too) and
 *                          its hash, and the size and time of the files that text came from
 *                          (a piece whose files changed is re-read)
 *   _index/vectors.bin     one int8 row of `dims` per id, unit length before quantising
 *
 * The first search builds it (about half a minute) and later ones reuse it; a search after
 * pieces change re-embeds only those. `parallax library index` builds it up front. The model
 * is downloaded once (to `.cache/` in the checkout); with no model, search falls back to
 * keywords and says so.
 *
 * `PARALLAX_CACHE_DIR` moves what the CLI writes: the model downloads to
 * `$PARALLAX_CACHE_DIR/transformers/` and the index is saved to
 * `$PARALLAX_CACHE_DIR/library_index/`. Both are still read from the checkout when the cache
 * lacks them, so a read-only checkout with a prebuilt index and model searches offline: a
 * model found on disk is loaded with remote downloads off (`PARALLAX_OFFLINE=1` turns them off
 * always), and an index that can't be saved is used from memory.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { FoundPiece, Library, Piece } from './library.js';
import { listPieces, searchPieces } from './library.js';

/** The embedding model: small (23 MB quantised), English, 384 dimensions. */
export const MODEL = 'Xenova/all-MiniLM-L6-v2';
const CACHE_DIR = fileURLToPath(new URL('../../../.cache/transformers/', import.meta.url));
const INDEX_DIR = '_index';

type Env = Readonly<Record<string, string | undefined>>;

/** `$PARALLAX_CACHE_DIR`, absolute, or undefined when unset. */
function cacheRoot(env: Env): string | undefined {
  const dir = env['PARALLAX_CACHE_DIR'];
  return dir === undefined || dir.trim() === '' ? undefined : resolve(dir);
}

/** Where the model is looked for, first to last; the first is where it downloads. */
export function modelDirs(env: Env = process.env): string[] {
  const cache = cacheRoot(env);
  return cache === undefined ? [CACHE_DIR] : [`${cache}/transformers/`, CACHE_DIR];
}

/** Where the index is read from, first to last (the first holding one is used); the first is where it is saved. */
export function indexDirs(root: string, env: Env = process.env): string[] {
  const cache = cacheRoot(env);
  const own = `${root.replace(/\/$/, '')}/${INDEX_DIR}`;
  return cache === undefined ? [own] : [`${cache}/library_index`, own];
}

/** The model's files under a cache folder (the layout transformers.js caches and loads from). */
function hasModel(dir: string): boolean {
  return ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].every((f) => existsSync(`${dir}/${MODEL}/${f}`));
}

/** Words a model's own data implies but its name may not say. */
function tagsOf(model: Record<string, unknown>): string[] {
  const tags: string[] = [];
  const bones = ((model['skeleton'] as { bones?: unknown[] } | undefined)?.bones ?? []).length;
  if (bones === 17) tags.push('person', 'human', 'humanoid character', 'people', 'figure', 'npc', 'rider', 'player');
  else if (bones === 20) tags.push('animal', 'quadruped', 'creature', 'pet');
  else if (bones > 0) tags.push('rigged', 'animated');
  const sockets = ((model['sockets'] as { name?: string }[] | undefined) ?? []).map((s) => s.name ?? '');
  if (sockets.some((s) => s.startsWith('stand_'))) tags.push('rideable', 'stood on by a rider');
  if (sockets.some((s) => s.startsWith('seat_'))) tags.push('rideable', 'seat', 'sits a rider or driver');
  if (sockets.some((s) => s.startsWith('muzzle'))) tags.push('weapon', 'gun');
  return tags;
}

/** Distinct readable words from names like "crown_needles_dark_merged" (no "merged", "l", numbers). */
function nameWords(names: readonly string[], limit: number): string[] {
  const skip = new Set(['merged', 'colour', 'color', 'socket', 'point', 'base', 'main', 'part', 'mat', 'tor', 'hd', 'pel', 'dig', 'f']);
  const out = new Set<string>();
  for (const name of names) {
    for (const w of name.toLowerCase().split(/[^a-z]+/)) {
      if (w.length > 2 && !skip.has(w)) out.add(w);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

function modelPath(piece: Piece): string | undefined {
  const path = piece.files.find((f) => f.startsWith('assets/models/') && f.endsWith('.model.json'));
  return path === undefined ? undefined : `${piece.dir}/files/${path}`;
}

/** Size and modification time of the files `pieceText` reads: cheap to compare, unlike the text. */
function stampOf(piece: Piece): string {
  return [`${piece.dir}/piece.json`, modelPath(piece)].filter((f) => f !== undefined).map((f) => {
    const s = statSync(f);
    return `${s.size}@${Math.floor(s.mtimeMs)}`;
  }).join(',');
}

/** The model document a piece ships, if it ships one. */
function modelOf(piece: Piece): Record<string, unknown> | undefined {
  const path = modelPath(piece);
  if (path === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** What a piece is, as one line of text: its id, category, summary and what its model implies. */
export function pieceText(piece: Piece): string {
  const lines = [piece.id.replaceAll('_', ' '), piece.category, piece.summary.replace(/…/g, '')];
  const model = modelOf(piece);
  if (model !== undefined) {
    const tags = tagsOf(model);
    if (tags.length > 0) lines.push(tags.join(', '));
    const options = ((model['options'] as { name?: string }[] | undefined) ?? []).map((o) => o.name ?? '');
    const materials = Object.keys((model['materials'] as Record<string, unknown> | undefined) ?? {});
    const parts = ((model['parts'] as { name?: string }[] | undefined) ?? []).map((p) => p.name ?? '');
    lines.push(nameWords([...options, ...materials, ...parts], 40).join(' '));
  }
  return lines.filter((l) => l.trim() !== '').join('. ');
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

type Embed = (texts: string[]) => Promise<Float32Array[]>;

/**
 * The local model, loaded on first use; undefined when it can't be (offline before its first
 * download, or the package isn't installed). A model already on disk (`modelDirs`) is loaded
 * from there with downloads off, so no network is touched.
 */
export async function loadEmbedder(env: Env = process.env): Promise<Embed | undefined> {
  const dirs = modelDirs(env);
  const found = dirs.find(hasModel);
  const offline = found !== undefined || env['PARALLAX_OFFLINE'] === '1';
  if (found === undefined && env['PARALLAX_OFFLINE'] === '1') return undefined;
  try {
    const transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = found ?? dirs[0]!;
    transformers.env.localModelPath = found ?? dirs[0]!;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = !offline;
    const extract = await transformers.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
    return async (texts) => {
      const out = await extract(texts, { pooling: 'mean', normalize: true });
      const dims = out.dims[1]!;
      const data = out.data as Float32Array;
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    };
  } catch {
    return undefined;
  }
}

export interface SearchIndex {
  readonly model: string;
  readonly dims: number;
  readonly ids: readonly string[];
  readonly texts: readonly string[];
  readonly hashes: readonly string[];
  readonly stamps: readonly string[];
  readonly vectors: Int8Array;
}

/**
 * Writes the index of every piece to `dir` (default: the first of `indexDirs`), embedding only
 * those whose text isn't already in `previous` (all of them without one); returns the index,
 * how many it embedded, and why it could not be saved (a read-only folder), if it couldn't —
 * the index is still usable from memory.
 */
export async function buildIndex(
  library: Library, embed: Embed, previous?: SearchIndex, batch = 64, dir: string = indexDirs(library.root)[0]!,
): Promise<{ index: SearchIndex; embedded: number; unsaved?: string }> {
  const pieces = [...library.pieces.values()].sort((a, b) => a.id.localeCompare(b.id));
  const stamps = pieces.map(stampOf);
  const before = new Map<string, number>();
  if (previous !== undefined && previous.model === MODEL) previous.ids.forEach((id, r) => before.set(id, r));
  // A piece whose files are as they were keeps its text hash; only the others are read again.
  const texts = pieces.map((p, i) => {
    const r = before.get(p.id);
    return r !== undefined && previous!.stamps[r] === stamps[i] ? undefined : pieceText(p);
  });
  const text = pieces.map((p, i) => texts[i] ?? previous!.texts[before.get(p.id)!]!);
  const hashes = text.map(hash);
  const kept = new Map<string, Int8Array>();
  if (previous !== undefined && previous.model === MODEL) {
    previous.ids.forEach((id, r) => kept.set(`${id}|${previous.hashes[r]}`, previous.vectors.subarray(r * previous.dims, (r + 1) * previous.dims)));
  }
  const todo = pieces.map((p, i) => i).filter((i) => !kept.has(`${pieces[i]!.id}|${hashes[i]}`));
  const fresh = new Map<number, Float32Array>();
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    (await embed(slice.map((t) => text[t]!))).forEach((row, j) => fresh.set(slice[j]!, row));
  }
  const dims = previous?.dims ?? fresh.values().next().value?.length ?? 0;
  const vectors = new Int8Array(pieces.length * dims);
  pieces.forEach((p, r) => {
    const old = kept.get(`${p.id}|${hashes[r]}`);
    if (old !== undefined) { vectors.set(old, r * dims); return; }
    fresh.get(r)!.forEach((x, d) => { vectors[r * dims + d] = Math.max(-127, Math.min(127, Math.round(x * 127))); });
  });
  const index: SearchIndex = { model: MODEL, dims, ids: pieces.map((p) => p.id), texts: text, hashes, stamps, vectors };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/index.json`, `${JSON.stringify({ model: MODEL, dims, ids: index.ids, texts: text, hashes, stamps })}\n`);
    writeFileSync(`${dir}/vectors.bin`, vectors);
  } catch (error) {
    return { index, embedded: todo.length, unsaved: (error as Error).message };
  }
  return { index, embedded: todo.length };
}

/** The index of the first of `dirs` (default `indexDirs(root)`) that holds a readable one. */
export function readIndex(root: string, dirs: readonly string[] = indexDirs(root)): SearchIndex | undefined {
  for (const dir of dirs) {
    if (!existsSync(`${dir}/index.json`) || !existsSync(`${dir}/vectors.bin`)) continue;
    let meta: Omit<SearchIndex, 'vectors'>;
    try {
      meta = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8')) as Omit<SearchIndex, 'vectors'>;
    } catch {
      continue;
    }
    if (!Array.isArray(meta.stamps) || !Array.isArray(meta.texts)) continue; // an older index: rebuilt
    const bytes = readFileSync(`${dir}/vectors.bin`);
    return { ...meta, vectors: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
  return undefined;
}

/**
 * What a search must do before using the index: `stale`, pieces whose text changed since it
 * was built, that it lacks, or that it has and the library no longer does; and `restamp`,
 * true when files changed size or time but not their text (a fresh checkout), so writing
 * the new stamps saves reading them again. Only pieces whose files changed are read.
 */
export function indexStatus(library: Library, index: SearchIndex): { stale: string[]; restamp: boolean } {
  const at = new Map(index.ids.map((id, i) => [id, i]));
  let restamp = false;
  const stale = [...library.pieces.values()].filter((p) => {
    const r = at.get(p.id);
    if (r === undefined) return true;
    if (index.stamps[r] === stampOf(p)) return false;
    restamp = true;
    return index.hashes[r] !== hash(pieceText(p));
  }).map((p) => p.id);
  return { stale: [...stale, ...index.ids.filter((id) => !library.pieces.has(id))], restamp };
}

/**
 * Pieces ranked by meaning, nudged by the keyword search over the indexed texts: cosine similarity to the query,
 * plus a little for each query word the piece's id or summary contains, so an exact name
 * still comes first.
 */
export function rankByMeaning(library: Library, index: SearchIndex, query: number[] | Float32Array, words: string, options: { category?: string; limit?: number } = {}): FoundPiece[] {
  const texts = new Map(index.ids.map((id, i) => [id, index.texts[i]!]));
  const keyword = new Map(searchPieces(library, words, { limit: Number.MAX_SAFE_INTEGER, text: (p) => texts.get(p.id) ?? p.summary, ...(options.category !== undefined && { category: options.category }) }).map((p) => [p.id, p.score]));
  const best = Math.max(1, ...keyword.values());
  const listed = new Map(listPieces(library).map((p) => [p.id, p]));
  const scored: FoundPiece[] = [];
  index.ids.forEach((id, row) => {
    const piece = listed.get(id);
    if (piece === undefined || (options.category !== undefined && piece.category !== options.category)) return;
    let dot = 0;
    for (let d = 0; d < index.dims; d++) dot += query[d]! * index.vectors[row * index.dims + d]!;
    const score = dot / 127 + 0.25 * ((keyword.get(id) ?? 0) / best);
    scored.push({ ...piece, score: Math.round(score * 1000) / 1000 });
  });
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.limit ?? 10);
}
