/**
 * Cloud saves, local first. `CloudStore` is the `KeyValueStore` the engine gets: every
 * read and write is the local store's (localStorage in a browser), synchronous and offline-
 * safe. Beside it, it keeps one bookkeeping entry (`SYNC_KEY`): per key, the remote version
 * the two last agreed on (`base`), whether this device changed it since (`dirty`, or
 * `deleted`), and when.
 *
 *   sync()   before the game starts: pull what changed on the remote, push what changed
 *            here, and settle keys changed on both through the `ConflictResolver`. The
 *            profile and save slots the game then loads are the merged ones.
 *   flush()  while the game runs (debounced after writes, and when the page hides): push
 *            only. A running game owns its keys; a key another device wrote meanwhile is a
 *            conflict for the resolver: "local" overwrites it, "remote" stores the remote's
 *            copy locally and stops pushing that key until the next start (the running game
 *            would otherwise overwrite it the next time it saves).
 *
 * Unavailable remote (offline, signed out): nothing is lost — dirty keys stay dirty and
 * go up on a later flush or start. Problems are reported once as PP9560 warnings.
 */

import { diagnostic } from '../../core/index.js';
import type {
  ConflictResolver, Diagnostic, KeyValueStore, RemoteSave, SaveConflict, SaveRemote, SyncState,
} from '../../core/index.js';

/** The local key holding the sync bookkeeping (never listed by `keys()`). */
export const SYNC_KEY = '__sync__';

interface KeyState {
  /** Remote version both sides agree on (0: never synced). */
  base: number;
  dirty: boolean;
  deleted: boolean;
  /** When this device last changed the key (ms since the epoch). */
  updatedAt: number;
}

export interface CloudStoreOptions {
  readonly local: KeyValueStore;
  readonly remote: SaveRemote;
  /** Default: the newer copy wins. */
  readonly resolve?: ConflictResolver;
  readonly onProblem: (d: Diagnostic) => void;
  /** Push this long after the last write (default 2 s); 0 = only on `flush()`. */
  readonly debounceSeconds?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** The newer copy wins; a deletion counts as written at its time. */
export const newerWins: ConflictResolver = (c: SaveConflict) =>
  Promise.resolve(c.remote !== null && c.remote.updatedAt > c.local.updatedAt ? 'remote' : 'local');

export class CloudStore implements KeyValueStore {
  readonly #local: KeyValueStore;
  readonly #remote: SaveRemote;
  readonly #resolve: ConflictResolver;
  readonly #onProblem: (d: Diagnostic) => void;
  readonly #debounce: number;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #state: Record<string, KeyState>;
  /** Keys whose remote copy won during this run: not pushed again until the next start. */
  readonly #held = new Set<string>();
  #started = false;
  #timer: unknown;
  #busy: Promise<void> | undefined;
  #reported = false;
  #status: SyncState = 'idle';
  readonly #listeners = new Set<(state: SyncState) => void>();

  constructor(options: CloudStoreOptions) {
    this.#local = options.local;
    this.#remote = options.remote;
    this.#resolve = options.resolve ?? newerWins;
    this.#onProblem = options.onProblem;
    this.#debounce = options.debounceSeconds ?? 2;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#state = this.#readState();
  }

  get status(): SyncState {
    return this.#status;
  }

  /** Hear sync state changes (e.g. a "Saved to cloud" indicator). Returns an unsubscribe. */
  onStatus(listener: (state: SyncState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  // ── KeyValueStore ──────────────────────────────────────────────────────────

  get(key: string): string | undefined {
    return key === SYNC_KEY ? undefined : this.#local.get(key);
  }

  set(key: string, value: string): void {
    if (key === SYNC_KEY) return;
    if (this.#local.get(key) === value) return;
    this.#local.set(key, value);
    this.#touch(key, false);
  }

  delete(key: string): void {
    if (key === SYNC_KEY || this.#local.get(key) === undefined) return;
    this.#local.delete(key);
    this.#touch(key, true);
  }

  keys(): string[] {
    return this.#local.keys().filter((k) => k !== SYNC_KEY);
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /** The full two-way sync, before the game starts. Resolves when done (or unavailable). */
  async sync(): Promise<SyncState> {
    await this.#exclusive(() => this.#pullAndPush());
    return this.#status;
  }

  /** The game started: from now on, push only. */
  start(): void {
    this.#started = true;
  }

  /** Push every dirty key now. */
  async flush(): Promise<SyncState> {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    await this.#exclusive(() => this.#push());
    return this.#status;
  }

  dispose(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #readState(): Record<string, KeyState> {
    const text = this.#local.get(SYNC_KEY);
    if (text === undefined) return {};
    try {
      const parsed = JSON.parse(text) as Record<string, KeyState>;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      this.#problem('the sync bookkeeping was unreadable and was reset (every key will be compared again)');
      return {};
    }
  }

  #saveState(): void {
    this.#local.set(SYNC_KEY, JSON.stringify(this.#state));
  }

  #touch(key: string, deleted: boolean): void {
    const s = this.#state[key] ?? { base: 0, dirty: false, deleted: false, updatedAt: 0 };
    s.dirty = true;
    s.deleted = deleted;
    s.updatedAt = this.#now();
    this.#state[key] = s;
    this.#saveState();
    this.#setStatus('pending');
    if (this.#debounce > 0) {
      if (this.#timer !== undefined) this.#clearTimer(this.#timer);
      this.#timer = this.#setTimer(() => { this.#timer = undefined; void this.flush(); }, this.#debounce * 1000);
    }
  }

  /** One sync at a time: a request while one runs waits for it, then runs. */
  #exclusive(work: () => Promise<void>): Promise<void> {
    const run = (this.#busy ?? Promise.resolve()).then(() => {
      this.#setStatus('syncing');
      return work();
    });
    this.#busy = run.catch(() => {});
    return run;
  }

  async #pullAndPush(): Promise<void> {
    const listed = await this.#remote.list();
    if (listed === 'unavailable') return this.#offline();
    const remote = new Map(listed.map((info) => [info.key, info]));
    for (const [key, info] of remote) {
      const s = this.#state[key];
      if (s !== undefined && s.base === info.version) continue;
      if (s?.dirty === true) {
        const copy = await this.#remote.read(key);
        if (copy === 'unavailable') return this.#offline();
        if (!(await this.#settle(key, copy))) return this.#offline();
      } else {
        const copy = await this.#remote.read(key);
        if (copy === 'unavailable') return this.#offline();
        if (copy !== null) this.#take(copy);
      }
    }
    // Synced once, gone from the remote, unchanged here: deleted on another device.
    for (const [key, s] of Object.entries(this.#state)) {
      if (!remote.has(key) && s.base > 0 && !s.dirty) {
        this.#local.delete(key);
        delete this.#state[key];
      }
    }
    this.#saveState();
    await this.#push();
  }

  async #push(): Promise<void> {
    // Keys written before cloud saves were turned on are pushed too (base 0).
    for (const key of this.keys()) if (this.#state[key] === undefined) this.#state[key] = { base: 0, dirty: true, deleted: false, updatedAt: this.#now() };
    for (const [key, s] of Object.entries(this.#state)) {
      if (!s.dirty || this.#held.has(key)) continue;
      if (s.deleted) {
        if (s.base > 0 && (await this.#remote.delete(key)) === 'unavailable') return this.#offline();
        delete this.#state[key];
        this.#saveState();
        continue;
      }
      const text = this.#local.get(key);
      if (text === undefined) { delete this.#state[key]; continue; }
      const result = await this.#remote.write(key, text, s.base, s.updatedAt);
      if (result === 'unavailable') return this.#offline();
      if (result.ok) {
        // Unless the game wrote again while the request was out, the two sides agree now.
        s.base = result.version;
        if (this.#local.get(key) === text && !s.deleted) s.dirty = false;
      } else if (!(await this.#settle(key, result.conflict))) {
        return this.#offline();
      }
      this.#saveState();
    }
    this.#setStatus(this.#hasPending() ? 'pending' : 'synced');
  }

  #hasPending(): boolean {
    return Object.entries(this.#state).some(([key, s]) => s.dirty && !this.#held.has(key));
  }

  /** A key changed on both sides: ask the resolver, then make both agree. False: the remote became unavailable. */
  async #settle(key: string, remote: RemoteSave | null): Promise<boolean> {
    const s = this.#state[key]!;
    const choice = await this.#resolve({ key, local: { text: s.deleted ? undefined : this.#local.get(key), updatedAt: s.updatedAt }, remote });
    if (choice === 'remote') {
      if (remote === null) {
        this.#local.delete(key);
        delete this.#state[key];
      } else {
        this.#take(remote);
        if (this.#started) this.#held.add(key);
      }
      return true;
    }
    // Keep this device's copy: write it over the remote's version.
    s.base = remote?.version ?? 0;
    if (s.deleted) {
      if ((await this.#remote.delete(key)) === 'unavailable') return false;
      delete this.#state[key];
      return true;
    }
    const text = this.#local.get(key)!;
    const again = await this.#remote.write(key, text, s.base, s.updatedAt);
    if (again === 'unavailable') return false;
    if (again.ok) { s.base = again.version; s.dirty = false; }
    return true;
  }

  #take(copy: RemoteSave): void {
    this.#local.set(copy.key, copy.text);
    this.#state[copy.key] = { base: copy.version, dirty: false, deleted: false, updatedAt: copy.updatedAt };
  }

  #offline(): void {
    this.#saveState();
    this.#setStatus('offline');
    this.#problem('the save cloud is unavailable (offline, or not signed in); progress is kept on this device and synced later');
  }

  #problem(what: string): void {
    if (this.#reported) return;
    this.#reported = true;
    this.#onProblem(diagnostic('PP9560', `Cloud saves: ${what}`, {
      severity: 'warning', fix: 'Sign in and stay online to sync; nothing is lost meanwhile.',
    }));
  }

  #setStatus(state: SyncState): void {
    if (state === this.#status) return;
    this.#status = state;
    for (const listener of [...this.#listeners]) listener(state);
  }
}
