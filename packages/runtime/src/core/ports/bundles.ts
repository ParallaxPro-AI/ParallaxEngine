/**
 * The bundle transport port: how `resource/bundles`' reader gets the bytes of a packed
 * project (`bundles.json` and the files it names). Browser: HTTP with Range requests,
 * `DecompressionStream` and `crypto.subtle`. Headless: an in-memory map (tests, servers).
 *
 * Paths given to the transport are as the index writes them: bundle file names and loose
 * urls, relative to the index (or absolute, for a library's `/assets/<kind>/<hash>`).
 * `null` from a fetch means "not there" (HTTP 404/410: an old build's file after a
 * redeploy) — the reader then re-reads the index; any other failure throws.
 */

export interface BundleTransport {
  /** The index's JSON. `fresh`: bypass every cache (the reader suspects it is stale). */
  index(fresh: boolean): Promise<unknown>;
  /** A whole file, reporting bytes as they arrive. */
  whole(file: string, progress?: (bytes: number) => void): Promise<Uint8Array | null>;
  /** `length` bytes from `offset` of a file. */
  range(file: string, offset: number, length: number): Promise<Uint8Array | null>;
  /** Where a file is, for consumers that stream by URL (a media element playing music). */
  url(file: string): string;
  gunzip(bytes: Uint8Array): Promise<Uint8Array>;
  /** sha256 as lowercase hex; undefined where the platform can't hash (checks are skipped). */
  sha256(bytes: Uint8Array): Promise<string | undefined>;
}
