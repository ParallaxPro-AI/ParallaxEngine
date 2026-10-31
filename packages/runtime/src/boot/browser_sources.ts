/**
 * Where a browser game's files come from, behind one shape boot hands to the platform:
 *
 *   loose    `parallax edit`'s /project/ tree: the index lists every path, text files are
 *            fetched up front, everything else is fetched by URL when used
 *   bundles  a packed build (`parallax build --bundle`): the eager bundles (data, images)
 *            are fetched whole with byte progress; images and fonts become blob URLs (the
 *            renderers and panels name them by URL); models and sounds are ranged reads on
 *            first use; music streams from its loose content-addressed file. A scripted panel's
 *            frame (an opaque origin) can't load the page's blob: URLs: it gets data: URLs
 *
 * Either way a hosted asset (a `https://r2.parallaxpro.ai/assets/…` URL the data names in
 * place of a project path, core/remote_assets.ts) is its own URL: fetched directly from the
 * asset store, which serves it with open CORS.
 */

import { fail, fetchRemoteAsset, isRemoteAsset, remoteAssetUrl } from '../core/index.js';
import type { BinaryFiles, ProjectFiles } from '../core/index.js';
import { BundleReader, bundleGroup } from '../resource/index.js';
import type { BundleProgress } from '../resource/index.js';
import { fetchProjectFiles, HttpBinaryFiles, HttpBundles } from '../platform/index.js';
import type { FrameFiles } from '../platform/index.js';

export interface GameSources {
  readonly kind: 'loose' | 'bundles';
  readonly files: ProjectFiles;
  /** Every project path (asset references resolve against it). */
  readonly paths: readonly string[];
  /** A project file's URL (images, fonts, styles; `HttpBinaryFiles` in loose mode). */
  url(path: string): string;
  /** The files as a scripted panel's sandboxed frame loads them. */
  readonly frame: FrameFiles;
  readonly binary: BinaryFiles;
  /** A sound file's bytes, for decoding. */
  audio(file: string): Promise<ArrayBuffer>;
  /** A streamable URL for a music file, or undefined (decode it instead). */
  stream(file: string): string | undefined;
  /** The game started on these files (bundles: only unchanged entries may come from a newer index now). */
  commit(): void;
  /** Bytes fetched (bundles) or files fetched (loose), for the boot report. */
  readonly report: () => string;
  dispose(): void;
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** A hosted asset's bytes as a decodable buffer. */
const remoteBuffer = async (url: string): Promise<ArrayBuffer> => {
  const bytes = await fetchRemoteAsset(url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export async function looseSources(projectUrl: URL, indexUrl: string): Promise<GameSources> {
  const fetched = await fetchProjectFiles({ index: indexUrl, base: projectUrl.href });
  const url = (path: string): string => (remoteAssetUrl(path) ?? new URL(encodePath(path), projectUrl).href);
  return {
    kind: 'loose',
    files: fetched.files,
    paths: fetched.paths,
    url,
    frame: { base: projectUrl.href, url },
    binary: new HttpBinaryFiles(url),
    audio: async (file) => {
      const response = await fetch(url(file));
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url(file)}`);
      return response.arrayBuffer();
    },
    // Loose files are plain HTTP: a media element can stream music straight from them.
    stream: (file) => url(file),
    commit: () => {},
    report: () => `${fetched.paths.length} files listed`,
    dispose: () => {},
  };
}

/** Bytes as base64 (a data: URL's payload), in chunks so a large image doesn't overflow the call stack. */
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css', html: 'text/html', json: 'application/json',
};

export async function bundleSources(
  indexUrl: string, progress: (p: BundleProgress) => void, onStale: () => void,
): Promise<GameSources> {
  const reader = await BundleReader.open(new HttpBundles(indexUrl), { onStale });
  await reader.loadEager(progress);
  const blobs = new Map<string, string>();
  for (const path of reader.eagerPaths()) {
    if (bundleGroup(path) !== 'images') continue;
    const type = IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
    blobs.set(path, URL.createObjectURL(new Blob([reader.unpacked(path)! as Uint8Array<ArrayBuffer>], { type })));
  }
  const url = (path: string): string => {
    const hosted = remoteAssetUrl(path);
    if (hosted !== undefined) return hosted;
    const blob = blobs.get(path) ?? reader.streamUrl(path);
    if (blob !== undefined) return blob;
    return fail('PP9541', `${path} is loaded on demand from the bundles, so it has no URL to name`, {
      path, fix: 'Models and sounds load through the renderer and audio; only images, fonts and styles are named by URL.',
    });
  };
  const dataUrls = new Map<string, string>();
  const frameUrl = (path: string): string | undefined => {
    const hosted = remoteAssetUrl(path);
    if (hosted !== undefined) return hosted;
    let data = dataUrls.get(path);
    if (data === undefined) {
      const bytes = blobs.has(path) ? reader.unpacked(path) : undefined;
      if (bytes === undefined) return undefined;
      const type = IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
      dataUrls.set(path, data = `data:${type};base64,${base64(bytes)}`);
    }
    return data;
  };
  return {
    kind: 'bundles',
    files: reader.projectFiles(),
    paths: reader.list(),
    url,
    frame: { base: null, url: frameUrl },
    binary: { read: (path) => (isRemoteAsset(path) ? fetchRemoteAsset(path) : reader.read(path)) },
    audio: async (file) => {
      if (isRemoteAsset(file)) return remoteBuffer(file);
      const bytes = await reader.read(file);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    stream: (file) => (isRemoteAsset(file) ? file : reader.streamUrl(file)),
    commit: () => reader.commit(),
    report: () => {
      const s = reader.stats;
      return `${s.requests} requests, ${(s.bytes / 1024).toFixed(1)} KB${s.refreshes > 0 ? `, index re-read ${s.refreshes}×` : ''}`;
    },
    dispose: () => { for (const blob of blobs.values()) URL.revokeObjectURL(blob); },
  };
}
