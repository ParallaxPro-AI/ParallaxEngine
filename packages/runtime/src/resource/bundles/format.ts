/**
 * Packed asset bundles: a project's data and assets as a few content-addressed files
 * (`parallax build --bundle` writes them; `BundleReader` reads them). The index,
 * `bundles.json`, is the only file that changes name-for-name between builds — it is
 * fetched uncached; everything it names is immutable and cached forever.
 *
 *   {
 *     "format": "parallax.bundles", "version": 1,
 *     "bundles": { "<group>": { "file": "data.3f9c….ppk", "size": 81234, "eager": true } },
 *     "files": {
 *       "<project path>": { "hash": "<sha256 hex>", "size": 1024,
 *                           "bundle": "<group>", "offset": 0, "length": 412, "encoding": "gzip" }
 *       "<project path>": { "hash": "…", "size": 3100000, "url": "assets/music/<sha256>" }
 *     }
 *   }
 *
 * Every entry is compressed on its own (`gzip` when that is smaller, else `identity`), so a
 * ranged read of one entry needs nothing else of its bundle: an HTTP Range response is never
 * compressed by the server, so the compression has to be inside the bytes. Groups:
 *
 *   data    the text files the engine reads before the first frame (eager, fetched whole)
 *   images  images and fonts: renderers name them by URL, so they are unpacked at boot (eager)
 *   models  models and their buffers (lazy: one range read per file, on first use)
 *   sfx     sound effects (lazy)
 *
 * An entry with a `url` is a standalone content-addressed file (`assets/<kind>/<sha256>`):
 * music (a media element streams it by HTTP range), and library assets a host already
 * serves from `/assets/<kind>/<hash>` — a relative url resolves against the index, an
 * absolute one is the library's.
 */

import { fail } from '../../core/index.js';

export const BUNDLE_FORMAT = 'parallax.bundles';
export const BUNDLE_VERSION = 1;
/** The index's name next to the bundles. */
export const BUNDLE_INDEX = 'bundles.json';

export type BundleEncoding = 'gzip' | 'identity';

export interface BundleFileInfo {
  /** The bundle's file name (relative to the index). */
  readonly file: string;
  readonly size: number;
  /** Fetched whole at boot (otherwise each entry is a ranged read). */
  readonly eager: boolean;
}

interface EntryCommon {
  /** sha256 of the file's bytes (uncompressed), lowercase hex. */
  readonly hash: string;
  /** The file's size (uncompressed). */
  readonly size: number;
}

export interface PackedEntry extends EntryCommon {
  readonly bundle: string;
  readonly offset: number;
  readonly length: number;
  readonly encoding: BundleEncoding;
}

export interface LooseEntry extends EntryCommon {
  readonly url: string;
}

export type BundleEntry = PackedEntry | LooseEntry;

export interface BundleIndex {
  readonly format: typeof BUNDLE_FORMAT;
  readonly version: typeof BUNDLE_VERSION;
  readonly bundles: Readonly<Record<string, BundleFileInfo>>;
  readonly files: Readonly<Record<string, BundleEntry>>;
}

export function isPacked(entry: BundleEntry): entry is PackedEntry {
  return 'bundle' in entry;
}

const HASH = /^[0-9a-f]{64}$/;

function bad(where: string, message: string): never {
  return fail('PP9540', `The bundle index is malformed: ${where} ${message}`, {
    fix: 'Rebuild with `parallax build --bundle`; the index and its bundles are written together.',
  });
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A parsed `bundles.json`, checked: every entry's bundle exists and its range lies inside it. */
export function readBundleIndex(json: unknown): BundleIndex {
  if (typeof json !== 'object' || json === null) bad('the index', 'is not an object');
  const doc = json as Record<string, unknown>;
  if (doc['format'] !== BUNDLE_FORMAT) bad('"format"', `must be "${BUNDLE_FORMAT}"`);
  if (doc['version'] !== BUNDLE_VERSION) bad('"version"', `is ${JSON.stringify(doc['version'])}; this engine reads version ${BUNDLE_VERSION}`);
  const bundles = doc['bundles'];
  const files = doc['files'];
  if (typeof bundles !== 'object' || bundles === null) bad('"bundles"', 'is not an object');
  if (typeof files !== 'object' || files === null) bad('"files"', 'is not an object');
  for (const [name, info] of Object.entries(bundles as Record<string, unknown>)) {
    const b = info as Partial<BundleFileInfo>;
    if (typeof b?.file !== 'string' || b.file === '' || b.file.includes('..')) bad(`bundle "${name}"`, 'has no file name');
    if (!count(b.size)) bad(`bundle "${name}"`, 'has no size');
    if (typeof b.eager !== 'boolean') bad(`bundle "${name}"`, 'has no "eager"');
  }
  for (const [path, value] of Object.entries(files as Record<string, unknown>)) {
    const e = value as Partial<PackedEntry & LooseEntry>;
    if (typeof e?.hash !== 'string' || !HASH.test(e.hash)) bad(`"${path}"`, 'has no sha256 "hash"');
    if (!count(e.size)) bad(`"${path}"`, 'has no "size"');
    if (typeof e.url === 'string') continue;
    const bundle = (bundles as Record<string, BundleFileInfo>)[e.bundle ?? ''];
    if (bundle === undefined) bad(`"${path}"`, `names the bundle ${JSON.stringify(e.bundle)}, which the index doesn't list`);
    if (!count(e.offset) || !count(e.length) || e.offset + e.length > bundle.size) bad(`"${path}"`, 'has a range outside its bundle');
    if (e.encoding !== 'gzip' && e.encoding !== 'identity') bad(`"${path}"`, 'has no "encoding" (gzip or identity)');
  }
  return json as BundleIndex;
}

/** The group a project file is packed in, by its kind (see the module doc); `loose` = a standalone file. */
export function bundleGroup(path: string): 'data' | 'images' | 'models' | 'sfx' | 'loose' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (path.startsWith('assets/music/')) return 'loose';
  if (['json', 'yarn', 'plan', 'html', 'css', 'js'].includes(ext)) return 'data';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'images';
  if (['ogg', 'mp3', 'wav', 'm4a'].includes(ext)) return 'sfx';
  return 'models';
}

/** Kinds stored compressed (the rest are compressed formats already). */
export function compressible(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ['json', 'yarn', 'plan', 'html', 'css', 'js', 'svg', 'gltf', 'bin', 'glb', 'wav', 'ttf', 'otf'].includes(ext);
}
