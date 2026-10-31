/**
 * The bundle transport over files in memory (a packed build read from disk, or made by a
 * test): ranges are slices, `null` for a file that isn't there. Decompression and hashing
 * use the standard `DecompressionStream` and `crypto.subtle` (Node and browsers alike).
 */

import { fail } from '../../core/index.js';
import type { BundleTransport } from '../../core/index.js';

/** Gunzip through the standard stream API. */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** sha256 hex through `crypto.subtle`; undefined where there is none (an insecure origin). */
export async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export class MemoryBundles implements BundleTransport {
  readonly #files: Map<string, Uint8Array>;
  readonly #indexName: string;
  /** Every request, for tests: `whole <file>`, `range <file> <offset>+<length>`, `index`. */
  readonly requests: string[] = [];

  /** `files` by name relative to the index (`bundles.json`, `data.<hash>.ppk`, `assets/music/<hash>`). */
  constructor(files: ReadonlyMap<string, Uint8Array>, indexName = 'bundles.json') {
    this.#files = new Map(files);
    this.#indexName = indexName;
  }

  /** Replace or remove files (a redeploy, in tests). */
  replace(files: ReadonlyMap<string, Uint8Array | null>): void {
    for (const [name, bytes] of files) {
      if (bytes === null) this.#files.delete(name);
      else this.#files.set(name, bytes);
    }
  }

  async index(fresh: boolean): Promise<unknown> {
    this.requests.push(fresh ? 'index fresh' : 'index');
    const bytes = this.#files.get(this.#indexName);
    if (bytes === undefined) fail('PP9543', `There is no ${this.#indexName}`, { fix: 'Build with `parallax build --bundle`.' });
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  async whole(file: string, progress?: (bytes: number) => void): Promise<Uint8Array | null> {
    this.requests.push(`whole ${file}`);
    const bytes = this.#files.get(file);
    if (bytes === undefined) return null;
    progress?.(bytes.byteLength);
    return new Uint8Array(bytes);
  }

  async range(file: string, offset: number, length: number): Promise<Uint8Array | null> {
    this.requests.push(`range ${file} ${offset}+${length}`);
    const bytes = this.#files.get(file);
    return bytes === undefined ? null : new Uint8Array(bytes.subarray(offset, offset + length));
  }

  url(file: string): string {
    return `memory:${file}`;
  }

  gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    return gunzipBytes(bytes);
  }

  sha256(bytes: Uint8Array): Promise<string | undefined> {
    return sha256Hex(bytes);
  }
}
