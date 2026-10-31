/**
 * The bundle transport over HTTP. The index is fetched uncached (`no-cache`, or a reload
 * when the reader suspects it is stale); bundles are immutable and use the HTTP cache.
 * One entry is one `Range` request; a server that ignores Range answers 200 with the
 * whole file, which is then fetched once and sliced for every later range of it.
 * 404 and 410 are "not there" (`null`: an old build's file after a redeploy).
 */

import { fail } from '../../core/index.js';
import type { BundleTransport } from '../../core/index.js';
import { gunzipBytes, sha256Hex } from '../headless/memory_bundles.js';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const GONE = new Set([404, 410]);

async function body(response: Response, progress?: (bytes: number) => void): Promise<Uint8Array> {
  if (progress === undefined || response.body === null) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    progress(received);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

export class HttpBundles implements BundleTransport {
  readonly #index: string;
  readonly #fetch: Fetch;
  /** Files a server sent whole in answer to a Range request. */
  readonly #whole = new Map<string, Promise<Uint8Array | null>>();

  /** `index` is the absolute URL of bundles.json. */
  constructor(index: string, fetcher: Fetch = (url, init) => globalThis.fetch(url, init)) {
    this.#index = index;
    this.#fetch = fetcher;
  }

  url(file: string): string {
    return new URL(file, this.#index).href;
  }

  async index(fresh: boolean): Promise<unknown> {
    const response = await this.#get(fresh ? `${this.#index}${this.#index.includes('?') ? '&' : '?'}fresh=${Date.now()}` : this.#index,
      { cache: fresh ? 'reload' : 'no-cache' }, 'the bundle index');
    if (!response.ok) {
      fail('PP9543', `The bundle index (${this.#index}) answered HTTP ${response.status}`, {
        fix: 'Build with `parallax build --bundle` and serve bundles.json with its bundles.',
      });
    }
    return response.json() as Promise<unknown>;
  }

  async whole(file: string, progress?: (bytes: number) => void): Promise<Uint8Array | null> {
    const url = this.url(file);
    const response = await this.#get(url, {}, file);
    if (GONE.has(response.status)) return null;
    if (!response.ok) fail('PP9543', `Fetching ${url} failed with HTTP ${response.status}`, { fix: 'Check the connection, then reload.' });
    return body(response, progress);
  }

  async range(file: string, offset: number, length: number): Promise<Uint8Array | null> {
    const cached = this.#whole.get(file);
    if (cached !== undefined) return slice(await cached, offset, length);
    const url = this.url(file);
    const response = await this.#get(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } }, file);
    if (GONE.has(response.status) || response.status === 416) return null;
    if (response.status === 206) return new Uint8Array(await response.arrayBuffer());
    if (!response.ok) fail('PP9543', `Fetching part of ${url} failed with HTTP ${response.status}`, { fix: 'Check the connection, then reload.' });
    // 200: the server ignored the Range header and sent everything; keep it for the file's other entries.
    const all = body(response);
    this.#whole.set(file, all);
    return slice(await all, offset, length);
  }

  gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    return gunzipBytes(bytes);
  }

  sha256(bytes: Uint8Array): Promise<string | undefined> {
    return sha256Hex(bytes);
  }

  async #get(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      return fail('PP9543', `Could not fetch ${what} (${url}): ${(error as Error).message}`, { fix: 'Check the connection, then reload.' });
    }
  }
}

function slice(bytes: Uint8Array | null, offset: number, length: number): Uint8Array | null {
  return bytes === null ? null : bytes.subarray(offset, offset + length);
}
