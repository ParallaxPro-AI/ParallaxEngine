/**
 * Reading a packed project (see `format.ts`) through the `BundleTransport` port.
 *
 *   boot      `open` reads the index; `loadEager` fetches the eager bundles whole (data,
 *             images) with byte progress and unpacks their entries; `projectFiles()` then
 *             serves the data files synchronously, as the engine's `ProjectFiles` port wants
 *   lazy      `read(path)` fetches one entry by range on first use (models, sounds); two
 *             reads of one path share the request; nothing decoded is cached here (the
 *             renderers and audio keep what they decode)
 *   checks    every entry's sha256 is compared with the index (where the platform hashes)
 *
 * Stale bundles. An index names immutable files; after a redeploy the old ones may be gone.
 * A missing file or a hash mismatch re-reads the index once (uncached):
 *
 *   before `commit()` (still booting)  the new index is adopted whole and the load retried
 *   after (the game is running)        an entry is served from the new index only when its
 *                                      hash is unchanged (content-addressed: same bytes);
 *                                      otherwise PP9542 — the game was updated and must reload
 */

import { fail } from '../../core/index.js';
import type { BundleTransport, ProjectFiles } from '../../core/index.js';
import { isPacked, readBundleIndex } from './format.js';
import type { BundleEntry, BundleIndex } from './format.js';

export interface BundleProgress {
  /** Bytes of the eager bundles received so far, and their total. */
  readonly loaded: number;
  readonly total: number;
}

export interface BundleStats {
  /** Transport fetches: whole bundles, ranges and loose files. */
  readonly requests: number;
  /** Bytes received (compressed, as sent). */
  readonly bytes: number;
  /** Times the index was re-read for a missing or changed file. */
  readonly refreshes: number;
}

export interface BundleReaderOptions {
  /** The running game's bundles were replaced (PP9542 follows on reads of changed files): tell the player to reload. */
  readonly onStale?: () => void;
}

const decoder = new TextDecoder();

/** The bytes were not what the index promised. */
class Mismatch extends Error {}

export class BundleReader {
  readonly #transport: BundleTransport;
  readonly #onStale: () => void;
  #index: BundleIndex;
  #committed = false;
  #refreshing: Promise<BundleIndex> | undefined;
  /** Eager bundles' decoded entries, by path. */
  readonly #unpacked = new Map<string, Uint8Array>();
  readonly #texts = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<Uint8Array>>();
  #stats = { requests: 0, bytes: 0, refreshes: 0 };

  private constructor(transport: BundleTransport, index: BundleIndex, options: BundleReaderOptions) {
    this.#transport = transport;
    this.#index = index;
    this.#onStale = options.onStale ?? (() => {});
  }

  static async open(transport: BundleTransport, options: BundleReaderOptions = {}): Promise<BundleReader> {
    return new BundleReader(transport, readBundleIndex(await transport.index(false)), options);
  }

  get index(): BundleIndex {
    return this.#index;
  }

  get stats(): BundleStats {
    return { ...this.#stats };
  }

  /** Every project path the bundles hold, sorted. */
  list(): string[] {
    return Object.keys(this.#index.files).sort();
  }

  has(path: string): boolean {
    return Object.hasOwn(this.#index.files, path);
  }

  /** Bytes the eager bundles weigh (the boot progress bar's total). */
  eagerBytes(): number {
    return Object.values(this.#index.bundles).filter((b) => b.eager).reduce((n, b) => n + b.size, 0);
  }

  /** Fetch and unpack every eager bundle. Before `commit`, a stale index is replaced and the load retried. */
  async loadEager(progress?: (p: BundleProgress) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#loadEagerOnce(progress);
        return;
      } catch (error) {
        if (!(error instanceof Mismatch) || attempt > 0) throw this.#coded(error);
        this.#index = await this.#refresh();
        this.#unpacked.clear();
        this.#texts.clear();
      }
    }
  }

  /** The game started on these bundles: from now on only unchanged entries may come from a newer index. */
  commit(): void {
    this.#committed = true;
  }

  /** A data file's text (after `loadEager`). */
  text(path: string): string {
    const known = this.#texts.get(path);
    if (known !== undefined) return known;
    const bytes = this.#unpacked.get(path);
    if (bytes === undefined) {
      return fail('PP9541', `${path} is not in an eager bundle, so it can't be read before the game starts`, {
        fix: this.has(path) ? 'Read it with `read(path)` (it loads on demand).' : 'Rebuild with `parallax build --bundle`: the file is not in the bundles.',
      });
    }
    const text = decoder.decode(bytes);
    this.#texts.set(path, text);
    return text;
  }

  /**
   * The project's files as the engine's `ProjectFiles` port: every bundled path listed;
   * data files (eager) readable; others are binary assets the renderers and audio load
   * with `read`.
   */
  projectFiles(): ProjectFiles {
    const paths = this.list();
    return { list: () => paths, read: (path) => this.text(path) };
  }

  /** An eager entry's bytes, synchronously (after `loadEager`); undefined for lazy ones. */
  unpacked(path: string): Uint8Array | undefined {
    return this.#unpacked.get(path);
  }

  /** Paths of the eager entries (unpacked at boot). */
  eagerPaths(): string[] {
    return [...this.#unpacked.keys()].sort();
  }

  /** A file's bytes: unpacked already, or one ranged read. */
  read(path: string): Promise<Uint8Array> {
    const ready = this.#unpacked.get(path);
    if (ready !== undefined) return Promise.resolve(ready);
    let pending = this.#inflight.get(path);
    if (pending === undefined) {
      pending = this.#readLazy(path).finally(() => this.#inflight.delete(path));
      this.#inflight.set(path, pending);
    }
    return pending;
  }

  /** A loose file's URL (music streams from it); undefined for packed entries. */
  streamUrl(path: string): string | undefined {
    const entry = this.#index.files[path];
    return entry === undefined || isPacked(entry) ? undefined : this.#transport.url(entry.url);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async #loadEagerOnce(progress: ((p: BundleProgress) => void) | undefined): Promise<void> {
    const eager = Object.entries(this.#index.bundles).filter(([, b]) => b.eager);
    const total = eager.reduce((n, [, b]) => n + b.size, 0);
    const received = new Map<string, number>();
    const report = (): void => progress?.({ loaded: [...received.values()].reduce((a, b) => a + b, 0), total });
    report();
    await Promise.all(eager.map(async ([group, info]) => {
      this.#stats.requests++;
      const bytes = await this.#transport.whole(info.file, (n) => { received.set(group, n); report(); });
      if (bytes === null || bytes.byteLength !== info.size) throw new Mismatch(`${info.file} is ${bytes === null ? 'missing' : 'the wrong size'}`);
      this.#stats.bytes += bytes.byteLength;
      received.set(group, bytes.byteLength);
      report();
      const entries = Object.entries(this.#index.files).filter(([, e]) => isPacked(e) && e.bundle === group);
      await Promise.all(entries.map(async ([path, entry]) => {
        const e = entry as Extract<BundleEntry, { bundle: string }>;
        this.#unpacked.set(path, await this.#decode(path, e, bytes.subarray(e.offset, e.offset + e.length)));
      }));
    }));
  }

  async #readLazy(path: string): Promise<Uint8Array> {
    const first = this.#entry(path, this.#index);
    try {
      return await this.#fetchEntry(path, first, this.#index);
    } catch (error) {
      if (!(error instanceof Mismatch)) throw this.#coded(error);
    }
    const fresh = await this.#refresh();
    const next = fresh.files[path];
    if (next === undefined || next.hash !== first.hash) {
      if (this.#committed) {
        this.#onStale();
        return fail('PP9542', `This game was updated while it was running: ${path} changed`, {
          path, fix: 'Reload the page to play the new version.',
        });
      }
    }
    if (!this.#committed) this.#index = fresh;
    try {
      return await this.#fetchEntry(path, this.#entry(path, fresh), fresh);
    } catch (error) {
      return fail('PP9542', `${path} could not be loaded from the bundles even after re-reading the index: ${(error as Error).message}`, {
        path, fix: 'The bundles on the server are incomplete: rebuild with `parallax build --bundle` and upload every file.',
      });
    }
  }

  #entry(path: string, index: BundleIndex): BundleEntry {
    const entry = index.files[path];
    if (entry === undefined) {
      return fail('PP9541', `${path} is not in the bundles`, { path, fix: 'Rebuild with `parallax build --bundle` after adding the file.' });
    }
    return entry;
  }

  async #fetchEntry(path: string, entry: BundleEntry, index: BundleIndex): Promise<Uint8Array> {
    this.#stats.requests++;
    if (!isPacked(entry)) {
      const bytes = await this.#transport.whole(entry.url);
      if (bytes === null) throw new Mismatch(`${entry.url} is missing`);
      this.#stats.bytes += bytes.byteLength;
      return this.#verify(path, entry, bytes);
    }
    const info = index.bundles[entry.bundle] ?? this.#entryBundle(entry);
    const bytes = await this.#transport.range(info.file, entry.offset, entry.length);
    if (bytes === null || bytes.byteLength !== entry.length) throw new Mismatch(`${info.file} is ${bytes === null ? 'missing' : 'shorter than the index says'}`);
    this.#stats.bytes += bytes.byteLength;
    return this.#decode(path, entry, bytes);
  }

  #entryBundle(entry: Extract<BundleEntry, { bundle: string }>): never {
    return fail('PP9540', `The bundle index names the bundle "${entry.bundle}" but doesn't list it`);
  }

  async #decode(path: string, entry: Extract<BundleEntry, { bundle: string }>, bytes: Uint8Array): Promise<Uint8Array> {
    let plain: Uint8Array;
    try {
      plain = entry.encoding === 'gzip' ? await this.#transport.gunzip(bytes) : bytes;
    } catch (error) {
      throw new Mismatch(`${path} did not decompress (${(error as Error).message})`);
    }
    return this.#verify(path, entry, plain);
  }

  async #verify(path: string, entry: BundleEntry, bytes: Uint8Array): Promise<Uint8Array> {
    if (bytes.byteLength !== entry.size) throw new Mismatch(`${path} is ${bytes.byteLength} bytes, the index says ${entry.size}`);
    const hash = await this.#transport.sha256(bytes);
    if (hash !== undefined && hash !== entry.hash) throw new Mismatch(`${path}'s contents don't match the index`);
    return bytes;
  }

  #refresh(): Promise<BundleIndex> {
    if (this.#refreshing === undefined) {
      this.#stats.refreshes++;
      this.#refreshing = this.#transport.index(true).then(readBundleIndex).finally(() => { this.#refreshing = undefined; });
    }
    return this.#refreshing;
  }

  #coded(error: unknown): unknown {
    if (!(error instanceof Mismatch)) return error;
    return fail('PP9542', `The game's bundles are out of date or damaged: ${error.message}`, {
      fix: 'Reload the page; if it persists, rebuild with `parallax build --bundle` and upload the index with its bundles.',
    });
  }
}
