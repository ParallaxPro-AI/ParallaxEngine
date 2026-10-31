/**
 * The save remote port: a player's saves kept off the device (cloud saves), so a profile
 * and save slots follow them between devices. The engine always reads and writes the
 * local `KeyValueStore`; `CloudStore` (platform) keeps it in step with a `SaveRemote`.
 *
 * A remote stores whole values by key, each with a version that rises on every write
 * (optimistic concurrency): a write names the version it replaces, and a remote that has
 * moved on refuses it with its own copy — a conflict, never a silent overwrite.
 *
 * `'unavailable'` is an expected answer, not an error: offline, signed out, a server
 * down. The game keeps playing on the local store and syncs later.
 *
 * Adapters: `platform/browser/save_remote.ts` (a hosted `/api/game-saves`),
 * `platform/headless/save_remote.ts` (in memory, for tests and servers).
 */

export interface RemoteSaveInfo {
  readonly key: string;
  readonly version: number;
  /** Milliseconds since the epoch, as the writing device said. */
  readonly updatedAt: number;
}

export interface RemoteSave extends RemoteSaveInfo {
  readonly text: string;
}

export type SaveWrite =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly conflict: RemoteSave };

export interface SaveRemote {
  /** Every key the remote holds, without contents. */
  list(): Promise<readonly RemoteSaveInfo[] | 'unavailable'>;
  read(key: string): Promise<RemoteSave | null | 'unavailable'>;
  /** Write `text` over version `base` (0: the key is new). `updatedAt`: when this device changed it. */
  write(key: string, text: string, base: number, updatedAt: number): Promise<SaveWrite | 'unavailable'>;
  /** Remove the key (a missing key is fine). */
  delete(key: string): Promise<'ok' | 'unavailable'>;
}

/** A key changed both here and on the remote since they last agreed. */
export interface SaveConflict {
  readonly key: string;
  readonly local: { readonly text: string | undefined; readonly updatedAt: number };
  readonly remote: RemoteSave | null;
}

/**
 * Decides a conflict: keep this device's copy, or take the remote's. A host's UI
 * asks the player ("This device: 2 h ago — Cloud: 5 min ago"); the default picks the newer.
 */
export type ConflictResolver = (conflict: SaveConflict) => Promise<'local' | 'remote'>;

export type SyncState = 'idle' | 'syncing' | 'synced' | 'pending' | 'offline';
