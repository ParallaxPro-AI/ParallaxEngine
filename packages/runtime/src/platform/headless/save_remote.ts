/**
 * A save remote in memory: versions and conflicts as a real one keeps them. Tests share
 * one between two `CloudStore`s to play two devices; `available = false` plays offline.
 */

import type { RemoteSave, RemoteSaveInfo, SaveRemote, SaveWrite } from '../../core/index.js';

export class MemorySaveRemote implements SaveRemote {
  readonly #saves = new Map<string, RemoteSave>();
  available = true;
  /** Writes accepted, for tests. */
  writes = 0;

  async list(): Promise<readonly RemoteSaveInfo[] | 'unavailable'> {
    if (!this.available) return 'unavailable';
    return [...this.#saves.values()].map(({ key, version, updatedAt }) => ({ key, version, updatedAt }));
  }

  async read(key: string): Promise<RemoteSave | null | 'unavailable'> {
    if (!this.available) return 'unavailable';
    return this.#saves.get(key) ?? null;
  }

  async write(key: string, text: string, base: number, updatedAt: number): Promise<SaveWrite | 'unavailable'> {
    if (!this.available) return 'unavailable';
    const current = this.#saves.get(key);
    if ((current?.version ?? 0) !== base) return { ok: false, conflict: current ?? { key, version: 0, updatedAt: 0, text: '' } };
    const version = base + 1;
    this.#saves.set(key, { key, text, version, updatedAt });
    this.writes++;
    return { ok: true, version };
  }

  async delete(key: string): Promise<'ok' | 'unavailable'> {
    if (!this.available) return 'unavailable';
    this.#saves.delete(key);
    return 'ok';
  }
}
