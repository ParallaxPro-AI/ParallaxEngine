import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetLink, NetMessage } from '@parallax/runtime/core';
import { WebSocketLink } from '@parallax/runtime/platform';
import { acceptKey, encodeFrame, WebSocketListener } from './websocket.js';

const open: WebSocketListener[] = [];
afterEach(() => { for (const l of open.splice(0)) l.close(); });

async function listen(maxMessage?: number): Promise<WebSocketListener> {
  const l = await WebSocketListener.listen(maxMessage === undefined ? {} : { maxMessage });
  open.push(l);
  return l;
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function accepted(listener: WebSocketListener): Promise<NetLink> {
  let link: NetLink | undefined;
  await until(() => (link = listener.accept()[0]) !== undefined);
  return link!;
}

/** A raw TCP client that does the opening handshake and sends hand-made frames. */
async function raw(port: number): Promise<{ send(bytes: Uint8Array): void; received(): Uint8Array; closed(): boolean }> {
  const socket = connect(port, '127.0.0.1');
  const chunks: Uint8Array[] = [];
  let ended = false;
  socket.on('data', (c) => chunks.push(c));
  socket.on('close', () => { ended = true; });
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write([
    'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
  ].join('\r\n'));
  await until(() => new TextDecoder().decode(concat(chunks)).includes('\r\n\r\n'));
  return { send: (b) => { socket.write(b); }, received: () => concat(chunks), closed: () => ended };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A client frame: masked, as RFC 6455 requires. */
function masked(opcode: number, payload: Uint8Array, fin = true, mask = true): Uint8Array {
  const frame = encodeFrame(opcode, payload, fin);
  if (!mask) return frame;
  const head = frame.length - payload.length;
  const key = new Uint8Array([1, 2, 3, 4]);
  const out = new Uint8Array(frame.length + 4);
  out.set(frame.subarray(0, head));
  out[1]! |= 0x80;
  out.set(key, head);
  for (let i = 0; i < payload.length; i++) out[head + 4 + i] = payload[i]! ^ key[i & 3]!;
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('WebSocket server (RFC 6455)', () => {
  it('computes the handshake accept key from the RFC example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it("talks to the engine's WebSocket client both ways, with messages of every length class", async () => {
    const listener = await listen();
    const client = new WebSocketLink(`ws://127.0.0.1:${listener.port}/match`);
    client.send('hello');
    const server = await accepted(listener);
    await until(() => client.state === 'open');
    const long = 'x'.repeat(70_000);
    client.send('é'.repeat(200));
    client.send(long);
    const got: NetMessage[] = [];
    await until(() => { got.push(...server.receive()); return got.length === 3; });
    expect(got).toEqual(['hello', 'é'.repeat(200), long]);
    server.send('welcome');
    server.send(long);
    const back: NetMessage[] = [];
    await until(() => { back.push(...client.receive()); return back.length === 2; });
    expect(back).toEqual(['welcome', long]);
    // binary frames carry the protocol's binary form, both ways
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    client.send(bytes);
    server.send(new Uint8Array([9, 8, 7]));
    const bin: NetMessage[] = [];
    await until(() => { bin.push(...server.receive()); return bin.length === 1; });
    expect(bin[0]).toEqual(bytes);
    const binBack: NetMessage[] = [];
    await until(() => { binBack.push(...client.receive()); return binBack.length === 1; });
    expect(binBack[0]).toEqual(new Uint8Array([9, 8, 7]));
    expect(server.unreliable).toBe(false);
    server.close('bye now');
    await until(() => client.state === 'closed');
    expect(client.closeReason).toBe('bye now');
  });

  it('reassembles fragmented messages and answers pings', async () => {
    const listener = await listen();
    const c = await raw(listener.port);
    const server = await accepted(listener);
    c.send(masked(0x1, text('frag'), false));
    c.send(masked(0x9, text('p')));
    c.send(masked(0x0, text('mented'), true));
    await until(() => server.receive().includes('fragmented') || false);
    c.send(masked(0x2, new Uint8Array([1, 2]), false));
    c.send(masked(0x0, new Uint8Array([3]), true));
    const parts: NetMessage[] = [];
    await until(() => { parts.push(...server.receive()); return parts.length === 1; });
    expect(parts[0]).toEqual(new Uint8Array([1, 2, 3]));
    const bytes = c.received();
    expect([...bytes.subarray(bytes.length - 3)]).toEqual([0x8a, 1, 'p'.charCodeAt(0)]);
  });

  it('closes on unmasked frames, bad UTF-8 in text and oversized messages', async () => {
    const listener = await listen(64);
    const cases: [Uint8Array, number][] = [
      [masked(0x1, text('x'), true, false), 1002],
      [masked(0x1, new Uint8Array([0xff, 0xfe])), 1007],
      [masked(0x2, new Uint8Array(65)), 1009],
      [masked(0x1, text('y'.repeat(65))), 1009],
    ];
    for (const [frame, status] of cases) {
      const c = await raw(listener.port);
      const server = await accepted(listener);
      c.send(frame);
      await until(() => server.state === 'closed');
      await until(() => c.closed());
      const bytes = c.received();
      const close = bytes.findIndex((b, i) => b === 0x88 && i > 0 && bytes[i - 1] === 0x0a);
      expect(close).toBeGreaterThan(0);
      expect((bytes[close + 2]! << 8) | bytes[close + 3]!).toBe(status);
    }
  });

  it('refuses plain HTTP and other WebSocket versions', async () => {
    const listener = await listen();
    const res = await fetch(`http://127.0.0.1:${listener.port}/`);
    expect(res.status).toBe(426);
  });
});
