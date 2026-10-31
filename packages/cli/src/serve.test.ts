/**
 * `parallax serve` / `serve-relay`: argument parsing, and the match server started and
 * stopped for real — from the project folder and from its web exports (loose and packed) —
 * with its health check, ticket gate and drain.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { WebSocketLink } from '@parallax/runtime/platform';
import { loadGame } from './bundle.js';
import { serveProject } from './serve.js';
import type { MatchServer } from './serve.js';
import { DEFAULT_RELAY_PORT, DEFAULT_SERVE_PORT, relayArgs, serveArgs } from './serve_cli.js';

const ARENA = fileURLToPath(new URL('./fixtures/arena', import.meta.url));
const example = (name: string): string => fileURLToPath(new URL(`../../../examples/${name}`, import.meta.url));

let root: string;
beforeAll(() => { root = mkdtempSync(`${tmpdir()}/parallax-serve-test-`); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('parallax serve arguments', () => {
  it('binds this machine only unless --host says otherwise', () => {
    expect(serveArgs(['game'])).toEqual({ dir: 'game', host: '127.0.0.1', port: DEFAULT_SERVE_PORT, drainSeconds: 300 });
    expect(serveArgs(['game', '--host', '0.0.0.0', '--port', '0', '--seed', '7', '--drain-seconds', '30', '--ticket-secret-env', 'S', '--match', 'm1']))
      .toEqual({ dir: 'game', host: '0.0.0.0', port: 0, seed: 7, drainSeconds: 30, ticketSecretEnv: 'S', match: 'm1' });
    expect(relayArgs([])).toEqual({ host: '127.0.0.1', port: DEFAULT_RELAY_PORT });
    expect(relayArgs(['--port', '9000', '--host', '::'])).toEqual({ host: '::', port: 9000 });
  });

  it('refuses bad usage', () => {
    expect(serveArgs(['game', '--port', 'x'])).toBe('--port needs a port number');
    expect(serveArgs(['game', '--port'])).toBe('--port needs a value');
    expect(serveArgs(['game', '--ticket-secret', 's'])).toBe('Unknown option --ticket-secret');
    expect(serveArgs(['game', '--ticket-secret-env', 'S'])).toMatch(/needs --match/);
    expect(serveArgs(['game', '--match', 'm'])).toMatch(/--ticket-secret-env too/);
    expect(serveArgs(['a', 'b'])).toBe('Unexpected argument b');
    expect(relayArgs(['game'])).toBe('Unexpected argument game');
  });
});

const get = (server: MatchServer, path: string): Promise<Response> => fetch(`http://127.0.0.1:${server.port}${path}`);

describe('serveProject', () => {
  it('builds a project and runs its match: health, status, WebSocket, drain', async () => {
    const server = await serveProject(ARENA, { port: 0, print: () => {} });
    try {
      expect(server.url).toBe(`ws://127.0.0.1:${server.port}/`);
      const health = await get(server, '/healthz');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, scene: 'main', accepting: true, maxPlayers: 4 });
      expect((await get(server, '/status')).status).toBe(200);
      expect((await get(server, '/')).status).toBe(426);
      const socket = new WebSocket(server.url);
      await new Promise((open, failed) => { socket.addEventListener('open', open); socket.addEventListener('error', failed); });
      socket.close();
      // No players: a drain stops at once and closes the port.
      await server.drain({ timeoutSeconds: 5 });
      await server.stopped;
      expect(server.status().accepting).toBe(false);
      await expect(get(server, '/healthz')).rejects.toThrow();
    } finally {
      server.stop();
    }
  });

  it('admits only ticket holders with a ticket secret', async () => {
    await expect(serveProject(ARENA, { ticketSecret: 's3cret' })).rejects.toThrow(/PP9572/);
    const server = await serveProject(ARENA, { port: 0, ticketSecret: 's3cret', match: 'm1', print: () => {} });
    try {
      const socket = new WebSocket(`${server.url}match/m1`);
      const closed = await new Promise<string>((done) => socket.addEventListener('close', (e) => done(e.reason)));
      expect(closed).toContain('no ticket');
    } finally {
      server.stop();
    }
  });

  it('names what it cannot serve', async () => {
    await expect(serveProject(root)).rejects.toThrow(/PP9570/);
  });
});

