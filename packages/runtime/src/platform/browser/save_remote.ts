/**
 * The save remote over the product's `/api/game-saves` (session cookie auth):
 *
 *   GET    /api/game-saves?gameId=<id>        → { saves: [{ slot, version, updatedAt, … }] }
 *   GET    /api/game-saves/<id>/<slot>        → { envelope, version }        (404: none)
 *   PUT    /api/game-saves/<id>/<slot>        { baseVersion, envelope }  → { ok, version }
 *                                             409 → { conflict, serverVersion, serverSave }
 *   DELETE /api/game-saves/<id>/<slot>
 *
 * A store key becomes a slot id (`[A-Za-z0-9_-]{1,64}`) reversibly: other characters, and
 * `_` itself, are written `_xx` (hex). The value travels as the envelope's `data` string;
 * `envelope.updatedAt` carries the device's change time. 401, network errors and 5xx are
 * `unavailable` (play goes on locally); anything else malformed is PP9561.
 */

import { fail } from '../../core/index.js';
import type { RemoteSave, RemoteSaveInfo, SaveRemote, SaveWrite } from '../../core/index.js';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpSaveRemoteOptions {
  /** The product's game id (a UUID). */
  readonly gameId: string;
  /** Identifies this device in the envelope (a random id kept in local storage). */
  readonly deviceId: string;
  /** Default `/api/game-saves`. */
  readonly base?: string;
  readonly fetch?: Fetch;
}

const SLOT = /^[A-Za-z0-9-]$/;

export function slotOf(key: string): string {
  let out = '';
  for (const ch of key) out += SLOT.test(ch) ? ch : [...new TextEncoder().encode(ch)].map((b) => `_${b.toString(16).padStart(2, '0')}`).join('');
  if (out.length === 0 || out.length > 64) fail('PP9561', `The save key "${key}" is too long for a cloud save slot`, { fix: 'Use save slot names under ~20 characters.' });
  return out;
}

export function keyOf(slot: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < slot.length; i++) {
    if (slot[i] === '_') { bytes.push(parseInt(slot.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(slot.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface Envelope {
  readonly updatedAt: number;
  readonly data: unknown;
}

export class HttpSaveRemote implements SaveRemote {
  readonly #options: HttpSaveRemoteOptions;
  readonly #fetch: Fetch;
  readonly #base: string;

  constructor(options: HttpSaveRemoteOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, { credentials: 'include', ...init }));
    this.#base = options.base ?? '/api/game-saves';
  }

  async list(): Promise<readonly RemoteSaveInfo[] | 'unavailable'> {
    const response = await this.#request(`${this.#base}?gameId=${encodeURIComponent(this.#options.gameId)}`);
    if (response === 'unavailable') return response;
    const body = await response.json() as { saves?: { slot: string; version: number; updatedAt: string }[] };
    if (!Array.isArray(body.saves)) this.#malformed('the slot list');
    return body.saves.map((s) => ({ key: keyOf(s.slot), version: s.version, updatedAt: Date.parse(s.updatedAt) || 0 }));
  }

  async read(key: string): Promise<RemoteSave | null | 'unavailable'> {
    const response = await this.#request(this.#url(key), {}, [404]);
    if (response === 'unavailable') return response;
    if (response.status === 404) return null;
    const body = await response.json() as { envelope?: Envelope; version?: number };
    return this.#save(key, body.envelope, body.version);
  }

  async write(key: string, text: string, base: number, updatedAt: number): Promise<SaveWrite | 'unavailable'> {
    const slot = slotOf(key);
    const envelope = {
      schemaVersion: 1, gameVersion: 0, gameId: this.#options.gameId, slot, createdAt: updatedAt, updatedAt,
      deviceId: this.#options.deviceId, metadata: {}, data: text, checksum: '',
    };
    const response = await this.#request(this.#url(key), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: base, envelope }),
    }, [409]);
    if (response === 'unavailable') return response;
    if (response.status === 409) {
      const body = await response.json() as { serverVersion?: number; serverSave?: Envelope };
      return { ok: false, conflict: this.#save(key, body.serverSave, body.serverVersion) };
    }
    const body = await response.json() as { version?: number };
    if (typeof body.version !== 'number') this.#malformed('the write answer');
    return { ok: true, version: body.version };
  }

  async delete(key: string): Promise<'ok' | 'unavailable'> {
    const response = await this.#request(this.#url(key), { method: 'DELETE' }, [404]);
    return response === 'unavailable' ? response : 'ok';
  }

  #url(key: string): string {
    return `${this.#base}/${encodeURIComponent(this.#options.gameId)}/${slotOf(key)}`;
  }

  #save(key: string, envelope: Envelope | undefined, version: number | undefined): RemoteSave {
    if (envelope === undefined || typeof version !== 'number' || typeof envelope.data !== 'string') this.#malformed(`the save "${key}"`);
    return { key, version, updatedAt: envelope.updatedAt, text: envelope.data };
  }

  async #request(url: string, init: RequestInit = {}, expected: readonly number[] = []): Promise<Response | 'unavailable'> {
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch {
      return 'unavailable';
    }
    if (response.ok || expected.includes(response.status)) return response;
    if (response.status === 401 || response.status === 429 || response.status >= 500) return 'unavailable';
    return fail('PP9561', `The save cloud answered HTTP ${response.status} for ${url}`, { fix: 'This is a product/engine mismatch; report it.' });
  }

  #malformed(what: string): never {
    return fail('PP9561', `The save cloud sent ${what} in a shape this engine doesn't read`, { fix: 'This is a product/engine mismatch; report it.' });
  }
}
