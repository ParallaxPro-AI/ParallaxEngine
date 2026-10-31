/**
 * The dev server on an ephemeral port, over a real build of the fixture project: it serves
 * the page, the engine bundle, the build and project data — and never Python source.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { buildProject } from './build.js';
import type { BuildResult } from './build.js';
import { bundleEngine } from './bundle.js';
import type { EngineBundle } from './bundle.js';
import { isPythonPath, pageHtml, servableProjectFile, startDevServer } from './dev_server.js';
import type { DevServer } from './dev_server.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/drop', import.meta.url));

let root: string;
let build: BuildResult;
let engine: EngineBundle;
let server: DevServer;

beforeAll(async () => {
  // A copy of the fixture, plus a symlink that names a .json but points at Python.
  root = mkdtempSync(`${tmpdir()}/parallax-dev-`);
  const project = `${root}/project`;
  const tree = directoryFiles(FIXTURE);
  for (const path of tree.all()) {
    mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
    writeFileSync(`${project}/${path}`, tree.bytes(path));
  }
  symlinkSync('../game/main.py', `${project}/prefabs/sneaky.json`);
  build = buildProject(project);
  engine = await bundleEngine();
  server = await startDevServer({
    projectDir: project, buildDir: build.buildDir, port: 0,
    state: () => ({ title: 'drop', manifest: build.manifest, diagnostics: build.diagnostics, engine, assetFiles: true }),
  });
});

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit): Promise<Response> => fetch(new URL(path, server.url), init);

/** The status of a request sent byte for byte (fetch would normalize `..` away before sending). */
function rawStatus(path: string): Promise<number> {
  const url = new URL(server.url);
  return new Promise((resolve, reject) => {
    let text = '';
    const socket = createConnection(Number(url.port), url.hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => { text += new TextDecoder().decode(chunk); });
    socket.on('error', reject);
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
  });
}

describe('parallax edit server', () => {
  it('builds the fixture cleanly into <project>/build', () => {
    expect(build.diagnostics).toEqual([]);
    expect(build.buildDir).toBe(`${root}/project/build`);
  });

  it('serves the page with an import map for the engine and the project module', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)![1]!) as { imports: Record<string, string> };
    expect(map.imports).toMatchObject({
      'parallax': '/engine/parallax.js', 'parallax/__rt__': '/engine/parallax/__rt__.js', 'project': '/build/project.js',
    });
    for (const url of Object.values(map.imports)) expect((await get(url)).status).toBe(200);
    expect(html).toContain("from '/engine/boot.js'");
  });

  it('serves the engine bundle as JavaScript, with source maps', async () => {
    const boot = await get('/engine/boot.js');
    expect(boot.status).toBe(200);
    expect(boot.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(await boot.text()).toMatch(/bootBrowser/);
    expect((await get('/engine/boot.js.map')).status).toBe(200);
  });

  it('serves the panel frame module to sandboxed (opaque-origin) frames, and names it to boot', async () => {
    const frame = await get('/engine/panel_frame.js', { headers: { Origin: 'null' } });
    expect(frame.status).toBe(200);
    expect(frame.headers.get('access-control-allow-origin')).toBe('*');
    expect(await frame.text()).toMatch(/parallax-panel/);
    expect(await (await get('/')).text()).toContain("panelFrame: '/engine/panel_frame.js'");
  });

  it('serves the build: manifest, project module and compiled modules only', async () => {
    expect((await get('/build/manifest.json')).status).toBe(200);
    expect((await get('/build/project.js')).status).toBe(200);
    const main = await get('/build/game/main.js');
    expect(main.status).toBe(200);
    expect(await main.text()).toContain("from 'parallax'");
    expect((await get('/build/declarations.json')).status).toBe(404);
    expect((await get('/build/nope.js')).status).toBe(404);
  });

  it('serves compiled modules\' source maps without the Python source in them', async () => {
    const res = await get('/build/game/main.js.map');
    expect(res.status).toBe(200);
    const map = await res.json() as Record<string, unknown>;
    expect(map['sources']).toEqual(['../../game/main.py']);
    expect(typeof map['mappings']).toBe('string');
    expect(map['sourcesContent']).toBeUndefined();
    expect(JSON.stringify(map)).not.toContain('import');
    expect((await get('/build/manifest.json.map')).status).toBe(404);
  });

  it('never serves Python source, however it is asked for', async () => {
    for (const path of [
      '/project/game/main.py', '/project/game/__init__.py', '/project/game/main.py?raw=1', '/project/game/main%2Epy',
      '/project/game/main.PY', '/build/project.pyi', '/game/main.py', '/project/prefabs/sneaky.json',
      '/build/game/main.py',
    ]) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 403]);
      expect(await res.text()).not.toContain('Behavior');
    }
  });

  it('rejects traversal and hidden paths, and anything off the allow-list', async () => {
    expect(await rawStatus('/project/../build/manifest.json')).toBe(400);
    expect(await rawStatus('/project/%2e%2e/build/manifest.json')).toBe(400);
    expect(await rawStatus('/project/prefabs%2f..%2f..%2fbuild%2fmanifest.json')).toBe(400);
    expect(await rawStatus('/project/../game/main.py')).toBe(403);
    expect(await rawStatus('/project/prefabs\\..\\..\\x.json')).toBe(400);
    expect((await get('/project/%zz')).status).toBe(400);
    expect((await get('/project/game/main.py%00.json')).status).toBe(400);
    expect((await get('/project/.git/config')).status).toBe(400);
    expect((await get('/project/tests/expected.json')).status).toBe(404);
    expect((await get('/project/build/manifest.json')).status).toBe(404);
    expect((await get('/package.json')).status).toBe(404);
    expect((await get('/', { method: 'POST' })).status).toBe(405);
  });

  it('serves project data and assets, and lists exactly what it serves', async () => {
    const prefab = await get('/project/prefabs/ball.prefab.json');
    expect(prefab.status).toBe(200);
    expect(prefab.headers.get('content-type')).toMatch(/application\/json/);
    const png = await get('/project/assets/images/dot.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    const { files } = (await (await get('/project-files.json')).json()) as { files: string[] };
    expect(files).toEqual(['assets/images/dot.png', 'prefabs/ball.prefab.json', 'prefabs/camera.prefab.json', 'prefabs/floor.prefab.json', 'scenes/main/scene.json']);
    for (const file of files) expect((await get(`/project/${file}`)).status).toBe(200);
  });

  it('pushes a reload to open pages', async () => {
    const res = await get('/__parallax__/events');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    server.reload();
    while (!text.includes('event: reload')) text += decoder.decode((await reader.read()).value);
    await reader.cancel();
  });
});

describe('dev server rules', () => {
  it('knows Python paths and the servable project files', () => {
    expect(isPythonPath('game/main.py')).toBe(true);
    expect(isPythonPath('a.pyc')).toBe(true);
    expect(isPythonPath('main.py/x.json')).toBe(true);
    expect(isPythonPath('assets/python.png')).toBe(false);
    expect(servableProjectFile('ui/hud.html')).toBe(true);
    expect(servableProjectFile('tests/x.json')).toBe(false);
    expect(servableProjectFile('notes.md')).toBe(false);
    expect(servableProjectFile('game/rules.py')).toBe(false);
  });

  it('tells the page to run data-only under --no-asset-files', () => {
    const html = (assetFiles: boolean): string => pageHtml({ title: 't', manifest: undefined, engine: { files: new Map(), imports: {}, entries: {} }, diagnostics: [], assetFiles });
    expect(html(false)).toContain('assetFiles: false');
    expect(html(true)).toContain('assetFiles: true');
  });

  it('embeds build diagnostics so they cannot close the script element', () => {
    const html = pageHtml({
      title: '<x>', manifest: undefined, engine: { files: new Map(), imports: {}, entries: {} }, assetFiles: false,
      diagnostics: [{ code: 'PP2001', severity: 'error', message: '</script><script>alert(1)', docs: 'd' }],
    });
    expect(html).not.toContain('</script><script>alert');
    expect(html).toContain('<title>&#60;x&#62;</title>');
  });
});
