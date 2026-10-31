/**
 * `parallax edit` on an ephemeral port over a copy of the fixture: the editor page, the
 * per-build module prefix, saving (and everything the save endpoint refuses), and the
 * "build" events — which leave the editor's own saves out of "changed".
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { edit, libraryModelFile, savablePath } from './edit.js';
import type { EditSession } from './edit.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/drop', import.meta.url));

let root: string;
let project: string;
let session: EditSession;
let origin: string;

beforeAll(async () => {
  root = mkdtempSync(`${tmpdir()}/parallax-edit-`);
  project = `${root}/project`;
  const tree = directoryFiles(FIXTURE);
  for (const path of tree.all()) {
    mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
    writeFileSync(`${project}/${path}`, tree.bytes(path));
  }
  session = await edit(project, { port: 0, open: false, log: () => {} });
  origin = new URL(session.server.url).origin;
}, 60_000);

afterAll(async () => {
  await session?.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string): Promise<Response> => fetch(new URL(path, session.server.url));

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(new URL('/__parallax__/save', session.server.url), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** The next "build" event the server sends (the stream opens before `trigger` runs). */
async function nextBuild(trigger: () => void, timeoutMs = 20_000): Promise<{ version: number; changed: string[] }> {
  const controller = new AbortController();
  const res = await fetch(new URL('/__parallax__/events', session.server.url), { signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read(); // ": connected"
  trigger();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('The event stream ended');
      text += new TextDecoder().decode(value);
      const match = /event: build\ndata: (.*)\n\n/.exec(text);
      if (match !== null) return JSON.parse(match[1]!) as { version: number; changed: string[] };
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

describe('parallax edit', () => {
  it('serves the editor page over the engine bundle with the editor in it', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('import { bootEditor } from \'/engine/editor.js\'');
    expect(html).toContain('<link rel="stylesheet" href="/engine/editor.css">');
    expect(html).toMatch(/version: 1,/);
    const js = await get('/engine/editor.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('bootEditor');
    expect((await get('/engine/editor.css')).headers.get('content-type')).toMatch(/text\/css/);
  });

  it('serves the current build under any /build/v<N>/ prefix', async () => {
    const plain = await (await get('/build/manifest.json')).text();
    expect(await (await get('/build/v1/manifest.json')).text()).toBe(plain);
    expect(await (await get('/build/v42/manifest.json')).text()).toBe(plain);
    expect((await get('/build/v1/game/main.py')).status).toBe(403);
  });

  it('saves JSON documents into the project, and announces the rebuild without them', async () => {
    const path = 'scenes/main/scene.json';
    const doc = JSON.parse(readFileSync(`${project}/${path}`, 'utf8')) as { entities: unknown[] };
    const text = `${JSON.stringify({ ...doc, entities: [] }, null, 2)}\n`;
    const event = await nextBuild(() => { void post({ files: [{ path, text }], removed: [] }); });
    expect(readFileSync(`${project}/${path}`, 'utf8')).toBe(text);
    expect(event.changed).toEqual([]);
    expect(event.version).toBeGreaterThan(1);
  });

  it('announces files changed outside the editor', async () => {
    const event = await nextBuild(() => writeFileSync(`${project}/game/extra_module.py`, 'X = 1\n'));
    expect(event.changed).toContain('game/extra_module.py');
  });

  it('creates new data files in their folders', async () => {
    const res = await post({ files: [{ path: 'prefabs/new_thing.prefab.json', text: '{ "tags": ["new"] }\n' }], removed: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: ['prefabs/new_thing.prefab.json'] });
    expect(readFileSync(`${project}/prefabs/new_thing.prefab.json`, 'utf8')).toContain('"new"');
  });

  it('refuses writes from anywhere but its own page', async () => {
    const ok = { files: [{ path: 'scenes/main/scene.json', text: '{}' }], removed: [] };
    expect((await post(ok, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(ok, { Origin: '' })).status).toBe(403);
    expect((await post(ok, { 'Content-Type': 'text/plain' })).status).toBe(403);
    // DNS rebinding: a foreign name resolving to localhost.
    expect((await post(ok, { Host: 'evil.example', Origin: 'http://evil.example' })).status).toBe(403);
  });

  it('refuses anything but JSON data files', async () => {
    for (const path of ['game/main.py', 'build/manifest.json', 'tests/x.json', '.git/config.json', '../escape.json', 'scenes/../../escape.json', '/etc/x.json', 'ui/hud.html']) {
      const res = await post({ files: [{ path, text: '{}' }], removed: [] });
      expect(res.status, path).toBe(403);
    }
    expect((await post({ files: [{ path: 'scenes/main/scene.json', text: '{ nope' }], removed: [] })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post({ files: 'x' })).status).toBe(400);
  });

  it("serves a library model piece's model document for the Asset Library's thumbnails", async () => {
    const res = await get('/__parallax__/library-model/accordion.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { format?: string }).format).toBe('parallax.model');
    expect((await get('/__parallax__/library-model/time_trial.json')).status).toBe(404);
    expect((await get('/__parallax__/library-model/no_such_piece.json')).status).toBe(404);
  });

  it('accepts GET only elsewhere', async () => {
    const res = await fetch(new URL('/project-files.json', session.server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
    expect(res.status).toBe(405);
  });
});

describe('libraryModelFile', () => {
  it("picks the piece's own model document, else its only one", () => {
    expect(libraryModelFile('crate', ['assets/models/crate.model.json', 'prefabs/crate.prefab.json'])).toBe('assets/models/crate.model.json');
    expect(libraryModelFile('arms', ['assets/models/fp_arms.model.json', 'prefabs/arms.prefab.json'])).toBe('assets/models/fp_arms.model.json');
    expect(libraryModelFile('pair', ['assets/models/a.model.json', 'assets/models/b.model.json'])).toBeUndefined();
    expect(libraryModelFile('menu', ['game/lib/menu.py', 'ui/lib/menu.html'])).toBeUndefined();
  });
});

describe('savablePath', () => {
  it('takes project JSON outside build/, tests/ and dot folders', () => {
    expect(savablePath('scenes/main/scene.json')).toBe(true);
    expect(savablePath('prefabs/a.prefab.json')).toBe(true);
    for (const bad of ['', 'a.py', 'x.json.py', 'build/a.json', 'tests/a.json', '.hidden/a.json', 'a/../b.json', 'a//b.json', 'a\\b.json', 'ui/a.css', 42]) {
      expect(savablePath(bad), String(bad)).toBe(false);
    }
  });
});
