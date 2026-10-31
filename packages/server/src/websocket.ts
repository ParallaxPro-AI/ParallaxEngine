/**
 * The game server's door: a WebSocket server (RFC 6455) on `node:http`, implementing the
 * engine's net port (`NetListener`, `NetLink`). Binary frames carry the net protocol's
 * binary form, text frames its JSON debug form. A WebSocket is one reliable stream, so
 * `unreliable` sends are delivered reliably (`unreliable === false`).
 *
 * What it does: the opening handshake (GET + Upgrade, version 13, Sec-WebSocket-Accept),
 * masked client frames, 7/16/64-bit lengths, fragmented messages, ping → pong, the close
 * handshake (with code and reason), and strict failures — unmasked client frames, invalid
 * UTF-8 in text, oversized messages and protocol errors close the connection with the
 * matching status code. No extensions (permessage-deflate is declined by omission).
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { NetIdentity, NetLink, NetLinkState, NetListener, NetMessage } from '@parallax/runtime/core';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Close codes (RFC 6455 §7.4.1). */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  tooBig: 1009,
} as const;

/** `Sec-WebSocket-Accept` for a client's key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** One frame as bytes (server frames are never masked). */
export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const length = payload.length;
  const head = length < 126 ? 2 : length < 0x10000 ? 4 : 10;
  const frame = new Uint8Array(head + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) {
    frame[1] = length;
  } else if (length < 0x10000) {
    frame[1] = 126;
    view(frame).setUint16(2, length);
  } else {
    frame[1] = 127;
    view(frame).setBigUint64(2, BigInt(length));
  }
  frame.set(payload, head);
  return frame;
}

interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Uint8Array;
}

class ProtocolFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Frames from a byte stream: `push` bytes, `next` a whole frame or null. Clients must mask. */
export class FrameReader {
  #buffer: Uint8Array = new Uint8Array(0);
  readonly #maxPayload: number;

  constructor(maxPayload: number) {
    this.#maxPayload = maxPayload;
  }

  push(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : concat([this.#buffer, chunk]);
  }

  next(): Frame | null {
    const b = this.#buffer;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    if ((b[0]! & 0x70) !== 0) throw new ProtocolFailure(CLOSE.protocolError, 'reserved bits set (no extension was negotiated)');
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    if (!masked) throw new ProtocolFailure(CLOSE.protocolError, 'client frames must be masked');
    let length = b[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = view(b).getUint16(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      const big = view(b).getBigUint64(2);
      if (big > BigInt(this.#maxPayload)) throw new ProtocolFailure(CLOSE.tooBig, 'message too big');
      length = Number(big);
      offset = 10;
    }
    if (opcode >= 0x8 && (length > 125 || !fin)) throw new ProtocolFailure(CLOSE.protocolError, 'malformed control frame');
    if (length > this.#maxPayload) throw new ProtocolFailure(CLOSE.tooBig, 'message too big');
    if (b.length < offset + 4 + length) return null;
    const mask = b.subarray(offset, offset + 4);
    const payload = b.slice(offset + 4, offset + 4 + length);
    for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
    this.#buffer = b.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A Sec-WebSocket-Key: 16 bytes, base64. */
function isNonce(key: string): boolean {
  try { return atob(key).length === 16; } catch { return false; }
}

let connections = 0;

/** One client connection: a `NetLink`. */
export class WebSocketConnection implements NetLink {
  readonly id: string;
  readonly unreliable = false;
  /** The request path the client opened (`/`, `/match/abc?ticket=…`). */
  readonly path: string;
  /** Who this is, once an admission gate checked their ticket (`GatedListener`). */
  identity: NetIdentity | undefined;
  readonly #socket: Socket;
  readonly #reader: FrameReader;
  readonly #maxMessage: number;
  #state: NetLinkState = 'open';
  #reason: string | null = null;
  readonly #inbox: NetMessage[] = [];
  #fragments: Uint8Array[] | null = null;
  #fragmentText = false;
  #fragmentBytes = 0;
  #closeSent = false;

  constructor(socket: Socket, path: string, maxMessage: number, head: Uint8Array) {
    this.id = `ws-${++connections}`;
    this.path = path;
    this.#socket = socket;
    this.#maxMessage = maxMessage;
    this.#reader = new FrameReader(maxMessage);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Uint8Array) => this.#data(chunk));
    socket.on('error', (error) => this.#ended(`socket error: ${error.message}`));
    socket.on('close', () => this.#ended('connection lost'));
    if (head.length > 0) this.#data(head);
  }

  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }

  send(message: NetMessage): void {
    if (this.#state !== 'open') return;
    this.#socket.write(typeof message === 'string' ? encodeFrame(OP_TEXT, encoder.encode(message)) : encodeFrame(OP_BINARY, message));
  }

  receive(): NetMessage[] {
    return this.#inbox.splice(0);
  }

  close(reason = 'closed'): void {
    this.#fail(CLOSE.normal, reason);
  }

  /** Close with a specific status code (`CLOSE.goingAway` when the server stops). */
  end(code: number, reason: string): void {
    this.#fail(code, reason);
  }

  #data(chunk: Uint8Array): void {
    if (this.#state === 'closed') return;
    this.#reader.push(chunk);
    try {
      for (let frame = this.#reader.next(); frame !== null && this.#state === 'open'; frame = this.#reader.next()) this.#frame(frame);
    } catch (error) {
      if (error instanceof ProtocolFailure) this.#fail(error.code, error.message);
      else throw error;
    }
  }

  #frame(frame: Frame): void {
    switch (frame.opcode) {
      case OP_PING:
        this.#socket.write(encodeFrame(OP_PONG, frame.payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = frame.payload.length >= 2 ? view(frame.payload).getUint16(0) : CLOSE.normal;
        const reason = frame.payload.length > 2 ? new TextDecoder().decode(frame.payload.subarray(2)) : '';
        this.#fail(code, reason === '' ? `closed by the client (${code})` : reason);
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.#fragments !== null) throw new ProtocolFailure(CLOSE.protocolError, 'a new message began inside a fragmented one');
        if (frame.fin) { this.#message(frame.payload, frame.opcode === OP_TEXT); return; }
        this.#fragmentText = frame.opcode === OP_TEXT;
        this.#fragments = [frame.payload];
        this.#fragmentBytes = frame.payload.length;
        return;
      case OP_CONTINUATION: {
        if (this.#fragments === null) throw new ProtocolFailure(CLOSE.protocolError, 'continuation without a message');
        this.#fragments.push(frame.payload);
        this.#fragmentBytes += frame.payload.length;
        if (this.#fragmentBytes > this.#maxMessage) throw new ProtocolFailure(CLOSE.tooBig, 'message too big');
        if (!frame.fin) return;
        const whole = concat(this.#fragments);
        this.#fragments = null;
        this.#message(whole, this.#fragmentText);
        return;
      }
      default:
        throw new ProtocolFailure(CLOSE.protocolError, `unknown opcode ${frame.opcode}`);
    }
  }

  #message(payload: Uint8Array, text: boolean): void {
    if (!text) { this.#inbox.push(payload); return; }
    this.#text(payload);
  }

  #text(payload: Uint8Array): void {
    let text: string;
    try {
      text = utf8.decode(payload);
    } catch {
      throw new ProtocolFailure(CLOSE.invalidPayload, 'text frame is not valid UTF-8');
    }
    this.#inbox.push(text);
  }

  /** Send a close frame (once) and end the socket. */
  #fail(code: number, reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
    if (!this.#closeSent) {
      this.#closeSent = true;
      const bytes = encoder.encode(reason).subarray(0, 123);
      const payload = new Uint8Array(2 + bytes.length);
      view(payload).setUint16(0, code);
      payload.set(bytes, 2);
      this.#socket.end(encodeFrame(OP_CLOSE, payload));
    }
  }

  #ended(reason: string): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#reason = reason;
  }
}

export interface WebSocketListenerOptions {
  /** Default 0: any free port (read it from `port` after `listen`). */
  readonly port?: number;
  /** Default 127.0.0.1. Use 0.0.0.0 to accept other machines. */
  readonly host?: string;
  /** Largest message accepted, in bytes (default 1 MiB). */
  readonly maxMessage?: number;
  /**
   * Plain HTTP requests (not upgrades) on the same port, e.g. a health check: answer and
   * return true, or return false for the default 426 "connect with a WebSocket".
   */
  readonly onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

function reject(socket: Socket, status: string, why: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${encoder.encode(why).length}\r\n\r\n${why}`);
}

/** The listener the net plugin accepts players from. HTTP requests that aren't upgrades get 426 (or `onRequest`'s answer). */
export class WebSocketListener implements NetListener {
  readonly #server: Server;
  readonly #pending: WebSocketConnection[] = [];
  readonly #all = new Set<WebSocketConnection>();
  readonly #maxMessage: number;
  #port = 0;

  private constructor(maxMessage: number, onRequest: WebSocketListenerOptions['onRequest']) {
    this.#maxMessage = maxMessage;
    this.#server = createServer((req, res) => {
      if (onRequest?.(req, res) === true) return;
      res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket' });
      res.end('This is a Parallax game server: connect with a WebSocket.');
    });
    this.#server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Uint8Array) => this.#upgrade(req, socket, head));
  }

  static async listen(options: WebSocketListenerOptions = {}): Promise<WebSocketListener> {
    const listener = new WebSocketListener(options.maxMessage ?? 1 << 20, options.onRequest);
    await new Promise<void>((done, failed) => {
      listener.#server.once('error', failed);
      listener.#server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => done());
    });
    listener.#port = (listener.#server.address() as AddressInfo).port;
    return listener;
  }

  get port(): number { return this.#port; }

  #upgrade(req: IncomingMessage, socket: Socket, head: Uint8Array): void {
    const key = req.headers['sec-websocket-key'];
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket'
      || !/\bupgrade\b/i.test(req.headers.connection ?? '')) {
      reject(socket, '400 Bad Request', 'Expected a WebSocket upgrade.');
      return;
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (typeof key !== 'string' || !isNonce(key)) {
      reject(socket, '400 Bad Request', 'Sec-WebSocket-Key must be 16 bytes, base64.');
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '', '',
    ].join('\r\n'));
    const connection = new WebSocketConnection(socket, req.url ?? '/', this.#maxMessage, head);
    this.#pending.push(connection);
    this.#all.add(connection);
    socket.on('close', () => this.#all.delete(connection));
  }

  accept(): NetLink[] {
    return this.#pending.splice(0);
  }

  /** Stop accepting, close every connection (1001 going away) and the port. */
  close(): void {
    for (const c of this.#all) c.end(CLOSE.goingAway, 'server shutting down');
    this.#server.close();
    // Idle keep-alive requests (health checks) would hold the port open.
    this.#server.closeIdleConnections();
  }
}
