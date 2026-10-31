import type { KeyValueStore } from '../../core/index.js';

/** In-memory storage: tests, servers, and browsers where persistent storage is unavailable. */
export class MemoryStore implements KeyValueStore {
  readonly #entries = new Map<string, string>();

  get(key: string): string | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: string): void {
    this.#entries.set(key, value);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }
}
