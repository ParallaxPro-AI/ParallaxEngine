/** Binary project files (models, glTF buffers) over HTTP. A non-2xx response rejects. */

import type { BinaryFiles } from '../../../core/index.js';

export class HttpBinaryFiles implements BinaryFiles {
  readonly #url: (path: string) => string;
  readonly #fetch: (url: string) => Promise<Response>;

  /** `url` maps a project path (`assets/models/knight.glb`) to where it is served. */
  constructor(url: (path: string) => string, fetcher: (url: string) => Promise<Response> = (u) => fetch(u)) {
    this.#url = url;
    this.#fetch = fetcher;
  }

  async read(path: string): Promise<Uint8Array> {
    const url = this.#url(path);
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
