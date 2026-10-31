import { describe, expect, it } from 'vitest';
import type { ConflictResolver, Diagnostic, SaveConflict } from '../../core/index.js';
import { MemoryStore } from '../headless/memory_store.js';
import { MemorySaveRemote } from '../headless/save_remote.js';
import { HttpSaveRemote, keyOf, slotOf } from '../browser/save_remote.js';
import { CloudStore, SYNC_KEY } from './cloud_store.js';

let clock = 1000;
function device(remote: MemorySaveRemote, resolve?: ConflictResolver, local = new MemoryStore()) {
  const problems: Diagnostic[] = [];
  const store = new CloudStore({ local, remote, onProblem: (d) => problems.push(d), debounceSeconds: 0, now: () => clock++, ...(resolve && { resolve }) });
  return { store, local, problems };
}

describe('CloudStore', () => {
  it('pushes local writes and pulls them on another device', async () => {
    const remote = new MemorySaveRemote();
    const a = device(remote);
    a.store.set('profile', '{"coins":3}');
    a.store.set('slot:one', 'A');
    expect(await a.store.sync()).toBe('synced');
    const b = device(remote);
    expect(await b.store.sync()).toBe('synced');
    expect(b.store.get('profile')).toBe('{"coins":3}');
    expect(b.store.keys().sort()).toEqual(['profile', 'slot:one']);
    expect(b.local.get(SYNC_KEY)).toBeDefined();
    expect(b.store.get(SYNC_KEY)).toBeUndefined();
  });

  it('offline: keeps playing locally, warns once, and syncs later', async () => {
    const remote = new MemorySaveRemote();
    remote.available = false;
    const a = device(remote);
    a.store.set('profile', 'v1');
    expect(await a.store.sync()).toBe('offline');
    a.store.set('profile', 'v2');
    expect(await a.store.flush()).toBe('offline');
    expect(a.problems.map((p) => [p.code, p.severity])).toEqual([['PP9560', 'warning']]);
    remote.available = true;
    expect(await a.store.flush()).toBe('synced');
    expect(await remote.read('profile')).toMatchObject({ text: 'v2', version: 1 });
  });

  it('a key changed on both devices goes to the resolver, which can keep either', async () => {
    const remote = new MemorySaveRemote();
    const seen: SaveConflict[] = [];
    const a = device(remote);
    a.store.set('profile', 'base');
    await a.store.sync();
    const b = device(remote, async (c) => { seen.push(c); return 'remote'; });
    await b.store.sync();
    a.store.set('profile', 'from A');
    await a.store.flush();
    b.store.set('profile', 'from B');
    await b.store.sync();
    expect(seen.map((c) => [c.key, c.local.text, c.remote?.text])).toEqual([['profile', 'from B', 'from A']]);
    expect(b.store.get('profile')).toBe('from A');

    const c = device(remote, async () => 'local');
    await c.store.sync();
    c.store.set('profile', 'from C');
    a.store.set('profile', 'A again');
    await a.store.flush();
    await c.store.flush();
    expect((await remote.read('profile')) as unknown).toMatchObject({ text: 'from C' });
  });

  it('by default the newer copy wins', async () => {
    const remote = new MemorySaveRemote();
    const a = device(remote);
    const b = device(remote);
    b.store.set('slot:x', 'older (B)');
    a.store.set('slot:x', 'newer (A)');
    await a.store.sync();
    await b.store.sync();
    expect(b.store.get('slot:x')).toBe('newer (A)');
  });

  it('after the game starts, a remote win is stored locally and that key is no longer pushed this run', async () => {
    const remote = new MemorySaveRemote();
    const a = device(remote);
    a.store.set('profile', 'one');
    await a.store.sync();
    const b = device(remote, async () => 'remote');
    await b.store.sync();
    b.store.start();
    a.store.set('profile', 'two');
    await a.store.flush();
    b.store.set('profile', 'running game');
    await b.store.flush();
    expect(b.store.get('profile')).toBe('two');
    b.store.set('profile', 'running game again');
    await b.store.flush();
    expect((await remote.read('profile')) as unknown).toMatchObject({ text: 'two' });
  });

  it('deletions travel both ways', async () => {
    const remote = new MemorySaveRemote();
    const a = device(remote);
    a.store.set('slot:x', '1');
    await a.store.sync();
    const b = device(remote);
    await b.store.sync();
    a.store.delete('slot:x');
    await a.store.flush();
    expect(await remote.read('slot:x')).toBeNull();
    await b.store.sync();
    expect(b.store.get('slot:x')).toBeUndefined();
  });

  it('pushes again after the debounce', async () => {
    const remote = new MemorySaveRemote();
    let timer: (() => void) | undefined;
    const store = new CloudStore({ local: new MemoryStore(), remote, onProblem: () => {}, setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => {} });
    store.set('profile', 'x');
    expect(store.status).toBe('pending');
    timer!();
    await new Promise((r) => setTimeout(r, 0));
    await store.flush();
    expect(remote.writes).toBe(1);
  });
});

describe('HttpSaveRemote', () => {
  it('maps keys to slot ids reversibly', () => {
    for (const key of ['profile', 'slot:auto', 'slot:a_b', 'slot:é']) {
      expect(slotOf(key)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(keyOf(slotOf(key))).toBe(key);
    }
  });

  it('speaks /api/game-saves: list, read, versioned write, 409 conflict, unavailable', async () => {
    const calls: string[] = [];
    const responses: Record<string, () => Response> = {
      'GET /api/game-saves?gameId=g': () => Response.json({ saves: [{ slot: 'slot_3aa', version: 2, updatedAt: '2026-01-01T00:00:00Z' }] }),
      'GET /api/game-saves/g/slot_3aa': () => Response.json({ version: 2, envelope: { updatedAt: 5, data: 'hello' } }),
      'PUT /api/game-saves/g/profile': () => Response.json({ conflict: true, serverVersion: 4, serverSave: { updatedAt: 9, data: 'theirs' } }, { status: 409 }),
      'PUT /api/game-saves/g/slot_3aa': () => Response.json({ ok: true, version: 3 }),
    };
    const remote = new HttpSaveRemote({
      gameId: 'g', deviceId: 'd',
      fetch: async (url, init) => {
        const key = `${init?.method ?? 'GET'} ${url}`;
        calls.push(init?.body === undefined ? key : `${key} ${String(init.body).slice(0, 40)}`);
        return responses[key]?.() ?? new Response('nope', { status: 401 });
      },
    });
    expect(await remote.list()).toEqual([{ key: 'slot:a', version: 2, updatedAt: Date.parse('2026-01-01T00:00:00Z') }]);
    expect(await remote.read('slot:a')).toEqual({ key: 'slot:a', version: 2, updatedAt: 5, text: 'hello' });
    expect(await remote.write('slot:a', 'new', 2, 7)).toEqual({ ok: true, version: 3 });
    expect(await remote.write('profile', 'mine', 1, 7)).toEqual({ ok: false, conflict: { key: 'profile', version: 4, updatedAt: 9, text: 'theirs' } });
    expect(await remote.read('missing')).toBe('unavailable');
    expect(calls[2]).toContain('{"baseVersion":2,"envelope"');
  });
});
