/**
 * `parallax build --bundle`: pack the project's served files (data, UI, assets — exactly
 * what `/project/` serves, never Python, tests or build output, nor a symlink to them) into content-addressed
 * bundles for `BundleReader` (format: runtime `resource/bundles/format.ts`).
 *
 * Output, in `<build>/bundles/`:
 *
 *   bundles.json                 the index (the only file to serve uncached)
 *   <group>.<hash16>.ppk         one per group with files: data, images, models, sfx
 *   assets/<kind>/<sha256>.<ext> loose files: music (streamed by a media element)
 *
 * Deterministic: files in path order, each entry gzipped on its own when that saves bytes
 * (gzip's header carries no timestamp), so the same project packs to the same bytes and
 * names. The folder is replaced on each pack; a deploy should keep older `.ppk` files for a
 * while so a page that is still running the previous build can finish loading (the reader
 * re-reads the index and keeps working when an entry's hash is unchanged).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { directoryFiles } from '@parallax/check';
import { BUNDLE_FORMAT, BUNDLE_INDEX, BUNDLE_VERSION, bundleGroup, compressible } from '@parallax/runtime/resource';
import type { BundleEntry, BundleFileInfo, BundleIndex } from '@parallax/runtime/resource';
import { servableProjectFiles } from './dev_server.js';

/** Groups fetched whole at boot. */
const EAGER = new Set(['data', 'images']);

export interface PackedGroup {
  readonly group: string;
  readonly file: string;
  readonly files: number;
  /** Bytes of the files as they are, and as packed. */
  readonly raw: number;
  readonly packed: number;
}

export interface PackResult {
  readonly dir: string;
  readonly index: BundleIndex;
  readonly groups: readonly PackedGroup[];
  /** Loose (standalone) files and their bytes. */
  readonly loose: { readonly files: number; readonly bytes: number };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function packProject(projectDir: string, outDir: string): PackResult {
  const tree = directoryFiles(projectDir);
  const paths = servableProjectFiles(projectDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const files: Record<string, BundleEntry> = {};
  const bundles: Record<string, BundleFileInfo> = {};
  const parts = new Map<string, { chunks: Uint8Array[]; size: number; raw: number; paths: string[] }>();
  let looseFiles = 0;
  let looseBytes = 0;
  for (const path of paths) {
    const bytes = tree.bytes(path);
    const hash = sha256(bytes);
    const group = bundleGroup(path);
    if (group === 'loose') {
      const kind = path.split('/')[1] ?? 'files';
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const url = `assets/${kind}/${hash}.${ext}`;
      mkdirSync(`${outDir}/assets/${kind}`, { recursive: true });
      writeFileSync(`${outDir}/${url}`, bytes);
      files[path] = { hash, size: bytes.byteLength, url };
      looseFiles++;
      looseBytes += bytes.byteLength;
      continue;
    }
    const zipped = compressible(path) ? gzipSync(bytes, { level: 9 }) : null;
    const gzip = zipped !== null && zipped.byteLength < bytes.byteLength;
    const stored = gzip ? zipped : bytes;
    const part = parts.get(group) ?? { chunks: [], size: 0, raw: 0, paths: [] };
    files[path] = { hash, size: bytes.byteLength, bundle: group, offset: part.size, length: stored.byteLength, encoding: gzip ? 'gzip' : 'identity' };
    part.chunks.push(stored);
    part.size += stored.byteLength;
    part.raw += bytes.byteLength;
    part.paths.push(path);
    parts.set(group, part);
  }
  const groups: PackedGroup[] = [];
  for (const [group, part] of [...parts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = new Uint8Array(part.size);
    let at = 0;
    for (const chunk of part.chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    const file = `${group}.${sha256(bytes).slice(0, 16)}.ppk`;
    writeFileSync(`${outDir}/${file}`, bytes);
    bundles[group] = { file, size: bytes.byteLength, eager: EAGER.has(group) };
    groups.push({ group, file, files: part.paths.length, raw: part.raw, packed: bytes.byteLength });
  }
  const index: BundleIndex = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, bundles, files };
  writeFileSync(`${outDir}/${BUNDLE_INDEX}`, `${JSON.stringify(index)}\n`);
  return { dir: outDir, index, groups, loose: { files: looseFiles, bytes: looseBytes } };
}

/** One line per group, for the build summary. */
export function packSummary(result: PackResult): string {
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
  const lines = result.groups.map((g) => `  ${g.file}  ${g.files} files, ${kb(g.raw)} → ${kb(g.packed)}${result.index.bundles[g.group]!.eager ? ' (boot)' : ' (on demand)'}`);
  if (result.loose.files > 0) lines.push(`  assets/…  ${result.loose.files} loose files (streamed), ${kb(result.loose.bytes)}`);
  return [`Bundles in ${result.dir}:`, ...lines].join('\n');
}
