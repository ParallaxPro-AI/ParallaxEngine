/** The dev server with `--bundle`: the page boots from bundles.json, and bundles answer Range requests. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { buildProject } from './build.js';
import type { BuildResult } from './build.js';
import { bundleEngine } from './bundle.js';
import { pageHtml, parseRange, startDevServer } from './dev_server.js';
import type { DevServer, DevState } from './dev_server.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/drop', import.meta.url));
let root: string;
let build: BuildResult;
let server: DevServer;
let state: DevState;

beforeAll(async () => {
  root = mkdtempSync(`${tmpdir()}/parallax-devb-`);
  const project = `${root}/project`;
  const tree = directoryFiles(FIXTURE);
  for (const path of tree.all()) {
    mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
    writeFileSync(`${project}/${path}`, tree.bytes(path));
  }
  build = buildProject(project, { bundle: true });
  const engine = await bundleEngine();
  state = {
    title: 'drop', manifest: build.manifest, diagnostics: build.diagnostics, engine, assetFiles: true, bundles: build.bundles!.index,
    net: { mode: 'host', signal: 'ws://127.0.0.1:7000/' },
  };
  server = await startDevServer({ projectDir: project, buildDir: build.buildDir, port: 0, state: () => state });
});
afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit): Promise<Response> => fetch(new URL(path, server.url), init);

describe('dev server with bundles', () => {
  it('serves a page that boots from the bundles, with the job worker and the net defaults', () => {
    const html = pageHtml(state);
    expect(html).toContain("bundles: '/build/bundles/bundles.json'");
    expect(html).not.toContain('/project-files.json');
    expect(html).toContain("jobWorker: '/engine/job_worker.js'");
    expect(html).toContain('netFromUrl({"mode":"host","signal":"ws://127.0.0.1:7000/"})');
  });

  it('bundles the job worker into the engine', () => {
    expect(state.engine.files.has('job_worker.js')).toBe(true);
  });

  it('serves the index uncached and bundles immutable, answering Range with 206', async () => {
    const index = await get('/build/bundles/bundles.json');
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-store');
    const data = build.bundles!.index.bundles['data']!;
    const whole = await get(`/build/bundles/${data.file}`);
    expect(whole.headers.get('cache-control')).toContain('immutable');
    const all = new Uint8Array(await whole.arrayBuffer());
    expect(all.byteLength).toBe(data.size);
    const part = await get(`/build/bundles/${data.file}`, { headers: { Range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${data.size}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(all.subarray(10, 20));
    expect((await get(`/build/bundles/${data.file}`, { headers: { Range: `bytes=${data.size}-` } })).status).toBe(416);
  });

  it('serves only what the index names', async () => {
    expect((await get('/build/bundles/nope.ppk')).status).toBe(404);
  });

  it('parses ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual([0, 9]);
    expect(parseRange('bytes=90-', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=95-200', 100)).toEqual([95, 99]);
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});
