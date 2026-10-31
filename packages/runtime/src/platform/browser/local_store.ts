import { diagnostic } from '../../core/index.js';
import type { Diagnostic, KeyValueStore } from '../../core/index.js';

/** The subset of the Web Storage API this adapter uses. */
export interface WebStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `localStorage`, scoped to one game by a key prefix. Storage can be missing or throw at
 * any call (private mode, blocked site data, a full quota); every call is guarded, and a
 * failure is reported once through `onProblem` as a PP9520 warning — reads then act as
 * empty and writes are lost, so the game keeps running without persistence.
 */
export class LocalStore implements KeyValueStore {
  readonly #prefix: string;
  readonly #storage: () => WebStorage | null;
  readonly #onProblem: (d: Diagnostic) => void;
  #reported = false;

  constructor(gameId: string, options: { storage?: () => WebStorage | null; onProblem: (d: Diagnostic) => void }) {
    this.#prefix = `parallax:${gameId}:`;
    this.#storage = options.storage ?? (() => globalThis.localStorage);
    this.#onProblem = options.onProblem;
  }

  get(key: string): string | undefined {
    return this.#guard('read', undefined, (s) => s.getItem(this.#prefix + key) ?? undefined);
  }

  set(key: string, value: string): void {
    this.#guard('write', undefined, (s) => s.setItem(this.#prefix + key, value));
  }

  delete(key: string): void {
    this.#guard('write', undefined, (s) => s.removeItem(this.#prefix + key));
  }

  keys(): string[] {
    return this.#guard('read', [], (s) => {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key !== null && key.startsWith(this.#prefix)) keys.push(key.slice(this.#prefix.length));
      }
      return keys.sort();
    });
  }

  #guard<T>(what: 'read' | 'write', failed: T, body: (storage: WebStorage) => T): T {
    try {
      const storage = this.#storage();
      if (storage === null || storage === undefined) throw new Error('localStorage is not available');
      return body(storage);
    } catch (error) {
      if (!this.#reported) {
        this.#reported = true;
        this.#onProblem(diagnostic('PP9520', `Saved data could not be ${what === 'read' ? 'read' : 'written'}: ${(error as Error).message}`, {
          severity: 'warning',
          fix: 'Allow site data for this page (private browsing and full storage block it); until then nothing is saved.',
        }));
      }
      return failed;
    }
  }
}
