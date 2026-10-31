/**
 * The local HTTP server behind `parallax edit`. It serves an allow-list and nothing else:
 *
 *   /                     the page: import map, build diagnostics, boot
 *   /engine/…             the engine bundle (in memory)
 *   /build/…              manifest.json, project.js and the modules the manifest lists
 *   /project/…            project data and assets with an allowed extension, outside
 *                         build/, tests/ and dot folders
 *   /project-files.json   the list of what /project/ serves
 *   /build/bundles/…      with `--bundle`: bundles.json and the files it names (Range
 *                         requests answered 206: the reader fetches one entry at a time)
 *   /__parallax__/events  live reload (server-sent events)
 *   /build/v<N>/…         `parallax edit`: the current build under a per-build prefix, so a
 *                         hot reload imports its modules afresh (a browser caches by URL)
 *   POST /__parallax__/save  `parallax edit` only: the editor writes its documents
 *
 * SECURITY: Python source never reaches the browser. Any path naming a `.py*` file is
 * refused (403) before routing, and again after symlinks resolve; everything else that is
 * not on the allow-list is 404. Paths with `..`, `.`, empty or dot segments, backslashes or
 * NUL are rejected (400). The server binds to localhost.
 *
 * The save endpoint writes files, so it answers only the page this server served: the
 * request must be JSON (a cross-site page can't send that without a CORS preflight, which
 * is never granted), its Origin must be this server, and its Host one of this server's
 * names (DNS rebinding). What it may write is the handler's decision (`edit.ts`).
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import { directoryFiles } from '@parallax/check';
import { PROJECT_MODULE, PROJECT_MODULE_FILE } from '@parallax/runtime/boot';
import type { BuildManifest } from '@parallax/runtime/boot';
import type { Diagnostic } from '@parallax/runtime/core';
import { BUNDLE_INDEX, isPacked } from '@parallax/runtime/resource';
import type { BundleIndex } from '@parallax/runtime/resource';
import { BOOT_MODULE, ENGINE_PREFIX, JOB_WORKER_MODULE, PANEL_FRAME_MODULE } from './bundle.js';
import type { EngineBundle } from './bundle.js';

const TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', map: 'application/json; charset=utf-8',
  json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  yarn: 'text/plain; charset=utf-8',
  plan: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', ktx2: 'image/ktx2',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

/** What /project/ may serve: data, UI markup, styles and panel scripts, media, models, fonts. */
const PROJECT_EXTENSIONS = new Set([
  'json', 'html', 'css', 'js', 'yarn', 'plan', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ogg', 'mp3', 'wav', 'm4a',
  'glb', 'gltf', 'bin', 'ktx2', 'woff', 'woff2', 'ttf', 'otf',
]);

/** Top-level project folders that are never served (generated output, playtests, dependencies). */
const PRIVATE_DIRS = new Set(['build', 'tests', 'node_modules', '__pycache__']);

/** `.py`, `.pyi`, `.pyc`, `.pyw`… anywhere in the path. */
const PYTHON = /\.py[a-z]?$/i;

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 || dot < path.lastIndexOf('/') ? '' : path.slice(dot + 1).toLowerCase();
}

export function isPythonPath(path: string): boolean {
  return path.split('/').some((segment) => PYTHON.test(segment));
}

/** Whether /project/ serves this project-relative path (already known to be well-formed). */
export function servableProjectFile(path: string): boolean {
  const top = path.split('/')[0]!;
  return !isPythonPath(path) && !PRIVATE_DIRS.has(top) && PROJECT_EXTENSIONS.has(extension(path));
}

/**
 * The project's files that leave the machine (`parallax build --bundle`, `parallax export
 * web`): the servable ones, judged again after symlinks resolve, so a `.json` that links to
 * a `.py`, or out of the project, stays home.
 */
export function servableProjectFiles(projectDir: string): string[] {
  const root = realpathSync(projectDir);
  return directoryFiles(projectDir).all().filter((path) => {
    if (!servableProjectFile(path)) return false;
    const real = realpathSync(`${projectDir}/${path}`);
    return real.startsWith(root + sep) && servableProjectFile(real.slice(root.length + 1).split(sep).join('/'));
  });
}

export interface DevState {
  readonly title: string;
  readonly manifest: BuildManifest | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly engine: EngineBundle;
  /** False with `--no-asset-files`: the game runs data-only (missing art draws nothing). */
  readonly assetFiles: boolean;
  /** With `--bundle`: the packed build's index; the page boots from the bundles. */
  readonly bundles?: BundleIndex;
  /** What the page does on the network (`--host-match`, `--join`); absent: a local game. */
  readonly net?: DevNet;
}

/** The page's networking (the URL's `?net=` overrides it). */
export type DevNet =
  | { readonly mode: 'host'; readonly signal: string; readonly room?: string }
  | { readonly mode: 'join'; readonly server: string }
  | { readonly mode: 'join'; readonly signal: string; readonly room: string };

/** Files under /build/bundles/ the index names, and the index. */
export function bundleFiles(index: BundleIndex | undefined): Set<string> {
  const out = new Set<string>();
  if (index === undefined) return out;
  out.add(BUNDLE_INDEX);
  for (const info of Object.values(index.bundles)) out.add(info.file);
  for (const entry of Object.values(index.files)) if (!isPacked(entry) && !/^[a-z]+:|^\//.test(entry.url)) out.add(entry.url);
  return out;
}

/** `Range: bytes=a-b` (one range) as [start, end] inclusive within `size`; null: none or unsatisfiable. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'unsatisfiable' {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'unsatisfiable' : [start, end];
}

export interface DevServerOptions {
  readonly projectDir: string;
  readonly buildDir: string;
  /** The current build; read on every request, so a rebuild takes effect at once. */
  readonly state: () => DevState;
  readonly port?: number;
  readonly host?: string;
  /** The page at `/` (default: the game, `pageHtml`). */
  readonly page?: (state: DevState) => string;
  /** `POST /__parallax__/save`'s handler (absent: no saving). Throws `Refusal` to refuse. */
  readonly save?: (body: unknown) => unknown;
  /** `POST /__parallax__/<name>` (a same-origin JSON write other than save); undefined: not found. Throws `Refusal`. */
  /** POST /__parallax__/<name>: the answer (or a promise of it); undefined is a 404. */
  readonly api?: (name: string, body: unknown) => unknown;
  /** `GET /__parallax__/<name>.json` (or `<name>/<key>.json`: name "name/key"); undefined: not found. */
  readonly data?: (name: string) => unknown;
}

export interface DevServer {
  readonly url: string;
  /** Tell every open page to reload. */
  reload(): void;
  /** Send every open page an event (`event: name`, JSON data). */
  broadcast(name: string, data: unknown): void;
  close(): Promise<void>;
}

/** The largest save request: a project's data documents, as JSON text. */
export const SAVE_LIMIT = 32 * 1024 * 1024;

export class Refusal {
  constructor(readonly status: 400 | 403 | 404 | 405 | 413 | 415, readonly reason: string) {}
}

/** Whether a request may write through this server: JSON, from the page this server served. */
export function sameOriginWrite(headers: IncomingMessage['headers'], port: number): string | null {
  const names = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = headers['host'];
  if (typeof host !== 'string' || !names.has(host)) return 'This server only takes writes addressed to localhost.';
  const origin = headers['origin'];
  if (origin !== `http://${host}`) return 'Writes come only from the editor page this server served.';
  const type = headers['content-type'];
  if (typeof type !== 'string' || type.split(';')[0]!.trim().toLowerCase() !== 'application/json') return 'Send the save as application/json.';
  return null;
}

/** The URL path as project-style segments, or a refusal. */
function cleanPath(rawUrl: string): string {
  const raw = rawUrl.split('?')[0]!.split('#')[0]!;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    throw new Refusal(400, 'Malformed URL');
  }
  if (isPythonPath(path)) throw new Refusal(403, 'Python source is never served; the browser gets compiled JavaScript only.');
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw new Refusal(400, 'Bad path');
  const segments = path.slice(1).split('/');
  if (path !== '/' && segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
    throw new Refusal(400, 'Bad path');
  }
  return path;
}

/** A file under `root`, after symlinks resolve; refused if it leaves `root` or becomes Python. */
function readInside(root: string, rel: string, allowed: (realRel: string) => boolean): Uint8Array {
  const target = `${root}/${rel}`;
  if (!existsSync(target)) throw new Refusal(404, 'Not found');
  const realRoot = realpathSync(root);
  const real = realpathSync(target);
  if (!real.startsWith(realRoot + sep)) throw new Refusal(404, 'Not found');
  const realRel = real.slice(realRoot.length + 1).split(sep).join('/');
  if (isPythonPath(realRel)) throw new Refusal(403, 'Python source is never served; the browser gets compiled JavaScript only.');
  if (!allowed(realRel) || !statSync(real).isFile()) throw new Refusal(404, 'Not found');
  return readFileSync(real);
}

/**
 * A compiled module's source map as the browser may see it: the line mappings and the .py
 * file names, never `sourcesContent` (the Python source stays on the developer's machine).
 */
export function publicSourceMap(bytes: Uint8Array): string {
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw new Error('The source map is not JSON; rebuild the project.');
  }
  const { version, file, sources, names, mappings } = map;
  return JSON.stringify({ version, file, sources, names: names ?? [], mappings });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function pageHtml(state: DevState): string {
  const imports = { ...state.engine.imports, [PROJECT_MODULE]: `/build/${PROJECT_MODULE_FILE}` };
  const source = state.bundles !== undefined
    ? `bundles: '/build/bundles/${BUNDLE_INDEX}',`
    : `project: '/project/',\n  fileIndex: '/project-files.json',`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(state.title)}</title>
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden; } #game { position: fixed; inset: 0; }</style>
<script type="importmap">${scriptJson({ imports })}</script>
</head>
<body>
<div id="game"></div>
<script type="application/json" id="parallax-build">${scriptJson(state.diagnostics)}</script>
<script type="module">
import { bootBrowser, netFromUrl } from '${ENGINE_PREFIX}${BOOT_MODULE}';
const seed = new URLSearchParams(location.search).get('seed');
// The running game, for devtools and test harnesses (\`parallaxGame.runtime\`, \`.timings\`, \`.jobs\`).
globalThis.parallaxGame = await bootBrowser({
  mount: document.getElementById('game'),
  build: '/build/',
  ${source}
  diagnostics: JSON.parse(document.getElementById('parallax-build').textContent),
  ...(seed !== null && { seed: Number(seed) }),
  assetFiles: ${state.assetFiles},
  panelFrame: '${ENGINE_PREFIX}${PANEL_FRAME_MODULE}',
  jobWorker: '${ENGINE_PREFIX}${JOB_WORKER_MODULE}',
  net: netFromUrl(${scriptJson(state.net ?? null)}),
});
new EventSource('/__parallax__/events').addEventListener('reload', () => location.reload());
</script>
</body>
</html>
`;
}

export function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const clients = new Set<ServerResponse>();

  const send = (
    res: ServerResponse, status: number, type: string, body: string | Uint8Array, head: boolean, headers: Record<string, string> = {},
  ): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(head ? undefined : body);
  };

  const projectFiles = (): string[] => directoryFiles(options.projectDir).all().filter(servableProjectFile);

  const buildFiles = (manifest: BuildManifest | undefined): Set<string> => {
    const out = new Set(['manifest.json']);
    if (manifest === undefined) return out;
    out.add(PROJECT_MODULE_FILE);
    for (const m of manifest.modules) if (m.output !== null) out.add(m.output);
    return out;
  };

  /** Compiled modules' source maps, for Python tracebacks on the error overlay. */
  const mapFiles = (manifest: BuildManifest | undefined): Set<string> => {
    const out = new Set<string>();
    for (const m of manifest?.modules ?? []) if (m.output !== null) out.add(`${m.output}.map`);
    return out;
  };

  let port = options.port ?? 5180;

  const post = (req: IncomingMessage, res: ServerResponse): void => {
    const json = (status: number, body: unknown): void => send(res, status, TYPES['json']!, JSON.stringify(body), false);
    const name = /^\/__parallax__\/([a-z][a-z0-9-]*)$/.exec(cleanPath(req.url ?? '/'))?.[1];
    const handler = name === 'save' ? options.save : name !== undefined && options.api !== undefined ? (body: unknown) => options.api!(name, body) : undefined;
    if (handler === undefined) {
      json(405, { error: 'Method not allowed' });
      return;
    }
    const refused = sameOriginWrite(req.headers, port);
    if (refused !== null) {
      json(403, { error: refused });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > SAVE_LIMIT) {
        json(413, { error: 'The save is too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > SAVE_LIMIT) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(400, { error: 'The save is not JSON' });
        return;
      }
      const failed = (error: unknown): void => {
        if (error instanceof Refusal) json(error.status, { error: error.reason });
        else json(500, { error: `Saving failed: ${(error as Error).message}` });
      };
      const answer = (out: unknown): void => {
        if (out === undefined) json(404, { error: 'Not found' });
        else json(200, out);
      };
      try {
        const out = handler(body);
        // A handler may answer later (one that asks another server).
        if (out instanceof Promise) out.then(answer, failed);
        else answer(out);
      } catch (error) {
        failed(error);
      }
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const head = req.method === 'HEAD';
    if (req.method === 'POST') {
      try {
        post(req, res);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        send(res, error.status, 'text/plain; charset=utf-8', error.reason, false);
      }
      return;
    }
    if (req.method !== 'GET' && !head) {
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', false);
      return;
    }
    try {
      // `/build/v<N>/…` is the current build under a per-build prefix (`parallax edit`'s hot reload).
      const path = cleanPath(req.url ?? '/').replace(/^\/build\/v\d+\//, '/build/');
      const state = options.state();
      if (path === '/' || path === '/index.html') {
        send(res, 200, TYPES['html']!, (options.page ?? pageHtml)(state), head);
      } else if (path === '/__parallax__/events') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders();
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else if (/^\/__parallax__\/[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9_-]*)?\.json$/.test(path) && options.data !== undefined) {
        const value = options.data(path.slice('/__parallax__/'.length, -'.json'.length));
        if (value === undefined) throw new Refusal(404, 'Not found');
        res.setHeader('Cache-Control', 'no-store');
        send(res, 200, TYPES['json']!, JSON.stringify(value), head);
      } else if (path === '/favicon.ico') {
        // No icon: answer so the browser doesn't log a 404 on every page.
        res.statusCode = 204;
        res.end();
      } else if (path === '/project-files.json') {
        send(res, 200, TYPES['json']!, JSON.stringify({ files: projectFiles() }), head);
      } else if (path.startsWith(ENGINE_PREFIX)) {
        const file = state.engine.files.get(path.slice(ENGINE_PREFIX.length));
        if (file === undefined) throw new Refusal(404, 'Not found');
        // Scripted panels run in sandboxed (opaque-origin) frames that load the panel frame module and its chunks.
        res.setHeader('Access-Control-Allow-Origin', '*');
        send(res, 200, TYPES[extension(path)] ?? 'application/octet-stream', file, head);
      } else if (path.startsWith('/build/bundles/')) {
        const rel = path.slice('/build/bundles/'.length);
        const allowed = bundleFiles(state.bundles);
        if (!allowed.has(rel)) throw new Refusal(404, 'Not found');
        const bytes = readInside(`${options.buildDir}/bundles`, rel, (r) => allowed.has(r));
        const type = rel === BUNDLE_INDEX ? TYPES['json']! : TYPES[extension(rel)] ?? 'application/octet-stream';
        // Bundles are content-addressed (a rebuild gives new names): cache them; never the index.
        const cache = rel === BUNDLE_INDEX ? 'no-store' : 'public, max-age=31536000, immutable';
        const raw = req.headers['range'];
        const range = parseRange(typeof raw === 'string' ? raw : undefined, bytes.byteLength);
        if (range === 'unsatisfiable') {
          send(res, 416, 'text/plain; charset=utf-8', 'Range not satisfiable', head, { 'Content-Range': `bytes */${bytes.byteLength}` });
        } else if (range !== null && rel !== BUNDLE_INDEX) {
          send(res, 206, type, bytes.subarray(range[0], range[1] + 1), head, {
            'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${range[0]}-${range[1]}/${bytes.byteLength}`,
          });
        } else {
          send(res, 200, type, bytes, head, { 'Cache-Control': cache, 'Accept-Ranges': 'bytes' });
        }
      } else if (path.startsWith('/build/') && mapFiles(state.manifest).has(path.slice('/build/'.length))) {
        const rel = path.slice('/build/'.length);
        send(res, 200, TYPES['map']!, publicSourceMap(readInside(options.buildDir, rel, (r) => mapFiles(state.manifest).has(r))), head);
      } else if (path.startsWith('/build/')) {
        const rel = path.slice('/build/'.length);
        const allowed = buildFiles(state.manifest);
        if (!allowed.has(rel)) throw new Refusal(404, 'Not found');
        send(res, 200, TYPES[extension(rel)]!, readInside(options.buildDir, rel, (r) => allowed.has(r)), head);
      } else if (path.startsWith('/project/')) {
        const rel = path.slice('/project/'.length);
        if (!servableProjectFile(rel)) throw new Refusal(404, 'Not found');
        send(res, 200, TYPES[extension(rel)]!, readInside(options.projectDir, rel, servableProjectFile), head);
      } else {
        throw new Refusal(404, 'Not found');
      }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      send(res, error.status, 'text/plain; charset=utf-8', error.reason, head);
    }
  };

  const server: Server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      send(res, 500, 'text/plain; charset=utf-8', `Internal error: ${(error as Error).message}`, false);
    }
  });

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', rejectStart);
    const host = options.host ?? '127.0.0.1';
    server.listen(options.port ?? 5180, host, () => {
      const address = server.address();
      port = typeof address === 'object' && address !== null ? address.port : options.port ?? 5180;
      resolveStart({
        url: `http://${host}:${port}/`,
        reload: () => {
          for (const client of clients) client.write('event: reload\ndata: {}\n\n');
        },
        broadcast: (name, data) => {
          const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
          for (const client of clients) client.write(payload);
        },
        close: () => new Promise((done) => {
          for (const client of clients) client.end();
          clients.clear();
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
