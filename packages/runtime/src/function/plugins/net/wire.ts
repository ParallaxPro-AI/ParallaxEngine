/**
 * The protocol's two encodings of the same messages (`protocol.ts`):
 *
 *   binary  a type byte, then the message's fields in a fixed order: unsigned and zigzag
 *           varints for integers (ids, ticks, millimetres), float32 for input axes and
 *           scale, float64 for clocks, a packed u32 for rotations, and a tagged compact form
 *           for the free-form JSON parts (component fields, resources, RPC args, feedback)
 *   json    the message object as JSON text (the debug form)
 *
 * `decodeClient` is the trust boundary: it never yields a value a check would reject
 * (non-finite numbers, wrong kinds, trailing bytes, too many frames) — PP9354 instead.
 */

import { fail } from '../../../core/index.js';
import type { NetMessage } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { checkClientMessage, isChannelTopic, MAX_CHANNEL_BYTES, MAX_INPUT_FRAMES } from './protocol.js';
import type {
  ActionValue, ClientMessage, EntityJson, EntityOrigin, InputFrame, PointerJson, PoseWire, SeatJson, ServerMessage, TransformWire,
  WireFormat,
} from './protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Message type bytes, client → server and server → client. */
const C = { hello: 1, input: 2, rpc: 3, leave: 4, channel: 5 } as const;
const S = { welcome: 16, scene: 17, state: 18, snap: 19, rejected: 20, bye: 21, channel: 22 } as const;

// ── Bytes ──────────────────────────────────────────────────────────────────────

export class ByteWriter {
  #buf = new Uint8Array(256);
  #view = new DataView(this.#buf.buffer);
  #at = 0;

  #room(n: number): void {
    if (this.#at + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#at + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#at));
    this.#buf = next;
    this.#view = new DataView(next.buffer);
  }

  u8(v: number): void { this.#room(1); this.#buf[this.#at++] = v; }

  /** Unsigned varint, 7 bits a byte, for 0 ≤ v ≤ 2^53. */
  uv(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) fail('PP9355', `A wire varint must be a whole number ≥ 0, got ${v}`);
    this.#room(8);
    while (v >= 0x80) {
      this.#buf[this.#at++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.#buf[this.#at++] = v;
  }

  /** Signed (zigzag) varint. */
  sv(v: number): void {
    if (!Number.isSafeInteger(v)) fail('PP9355', `A wire integer must be whole, got ${v}`);
    this.uv(v < 0 ? -2 * v - 1 : 2 * v);
  }

  /** Optional unsigned: null → 0, n → n + 1. */
  ouv(v: number | null): void { this.uv(v === null ? 0 : v + 1); }

  f32(v: number): void { this.#room(4); this.#view.setFloat32(this.#at, v, true); this.#at += 4; }
  f64(v: number): void { this.#room(8); this.#view.setFloat64(this.#at, v, true); this.#at += 8; }
  u32(v: number): void { this.#room(4); this.#view.setUint32(this.#at, v, true); this.#at += 4; }

  str(s: string): void {
    const bytes = encoder.encode(s);
    this.uv(bytes.length);
    this.#room(bytes.length);
    this.#buf.set(bytes, this.#at);
    this.#at += bytes.length;
  }

  bytes(): Uint8Array { return this.#buf.slice(0, this.#at); }
}

class Malformed extends Error {}

export class ByteReader {
  readonly #buf: Uint8Array;
  readonly #view: DataView;
  #at = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  #need(n: number): void { if (this.#at + n > this.#buf.length) throw new Malformed('message ends early'); }

  get done(): boolean { return this.#at === this.#buf.length; }

  u8(): number { this.#need(1); return this.#buf[this.#at++]!; }

  uv(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new Malformed('varint too large');
        return value;
      }
      scale *= 0x80;
    }
    throw new Malformed('varint too long');
  }

  sv(): number { const z = this.uv(); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
  ouv(): number | null { const v = this.uv(); return v === 0 ? null : v - 1; }

  f32(): number {
    this.#need(4);
    const v = this.#view.getFloat32(this.#at, true);
    this.#at += 4;
    if (!Number.isFinite(v)) throw new Malformed('non-finite number');
    return v;
  }

  f64(): number {
    this.#need(8);
    const v = this.#view.getFloat64(this.#at, true);
    this.#at += 8;
    if (!Number.isFinite(v)) throw new Malformed('non-finite number');
    return v;
  }

  u32(): number { this.#need(4); const v = this.#view.getUint32(this.#at, true); this.#at += 4; return v; }

  str(): string {
    const n = this.uv();
    this.#need(n);
    const s = decoder.decode(this.#buf.subarray(this.#at, this.#at + n));
    this.#at += n;
    return s;
  }

  /** A count of following items, each at least `min` bytes (bounds hostile lengths). */
  count(min = 1): number {
    const n = this.uv();
    if (n * min > this.#buf.length - this.#at) throw new Malformed('count exceeds the message');
    return n;
  }
}

// ── Free-form JSON, compactly ─────────────────────────────────────────────────

const J = { null: 0, false: 1, true: 2, int: 3, f64: 4, str: 5, array: 6, object: 7 } as const;

export function writeJson(w: ByteWriter, value: Json): void {
  if (value === null) { w.u8(J.null); return; }
  switch (typeof value) {
    case 'boolean': w.u8(value ? J.true : J.false); return;
    case 'number':
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) { w.u8(J.int); w.sv(value); } else { w.u8(J.f64); w.f64(value); }
      return;
    case 'string': w.u8(J.str); w.str(value); return;
    default:
      if (Array.isArray(value)) {
        w.u8(J.array);
        w.uv(value.length);
        for (const item of value) writeJson(w, item);
        return;
      }
      w.u8(J.object);
      {
        const entries = Object.entries(value as JsonObject).filter(([, v]) => v !== undefined);
        w.uv(entries.length);
        for (const [k, v] of entries) { w.str(k); writeJson(w, v as Json); }
      }
  }
}

const MAX_DEPTH = 32;

export function readJson(r: ByteReader, depth = 0): Json {
  if (depth > MAX_DEPTH) throw new Malformed('value nested too deeply');
  switch (r.u8()) {
    case J.null: return null;
    case J.false: return false;
    case J.true: return true;
    case J.int: return r.sv();
    case J.f64: return r.f64();
    case J.str: return r.str();
    case J.array: {
      const n = r.count();
      const out: Json[] = [];
      for (let i = 0; i < n; i++) out.push(readJson(r, depth + 1));
      return out;
    }
    case J.object: {
      const n = r.count(2);
      const out: Record<string, Json> = {};
      for (let i = 0; i < n; i++) {
        const k = r.str();
        if (k === '__proto__') throw new Malformed('reserved key');
        out[k] = readJson(r, depth + 1);
      }
      return out;
    }
    default: throw new Malformed('unknown value tag');
  }
}

function readObject(r: ByteReader): JsonObject {
  const v = readJson(r);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Malformed('expected an object');
  return v as JsonObject;
}

// ── Pieces ─────────────────────────────────────────────────────────────────────

const A = { button: 0, axis1: 1, axis2: 2, group: 3 } as const;

function writeAction(w: ByteWriter, v: ActionValue): void {
  switch (v.k) {
    case 'button': w.u8(A.button); w.u8((v.held ? 1 : 0) | (v.down ? 2 : 0)); return;
    case 'axis1': w.u8(A.axis1); w.f32(v.value); return;
    case 'axis2': w.u8(A.axis2); w.f32(v.x); w.f32(v.y); return;
    case 'group': w.u8(A.group); w.ouv(v.slot); return;
  }
}

function readAction(r: ByteReader): ActionValue {
  switch (r.u8()) {
    case A.button: { const f = r.u8(); if (f > 3) throw new Malformed('bad button'); return { k: 'button', held: (f & 1) !== 0, down: (f & 2) !== 0 }; }
    case A.axis1: return { k: 'axis1', value: r.f32() };
    case A.axis2: return { k: 'axis2', x: r.f32(), y: r.f32() };
    case A.group: return { k: 'group', slot: r.ouv() };
    default: throw new Malformed('unknown action kind');
  }
}

function writePointer(w: ByteWriter, p: PointerJson): void {
  w.u8((p.held ? 1 : 0) | (p.down ? 2 : 0) | (p.world !== null ? 4 : 0));
  w.f32(p.x); w.f32(p.y);
  if (p.world !== null) { w.f32(p.world[0]); w.f32(p.world[1]); w.f32(p.world[2]); }
  w.ouv(p.over);
}

function readPointer(r: ByteReader): PointerJson {
  const f = r.u8();
  if (f > 7) throw new Malformed('bad pointer');
  const x = r.f32();
  const y = r.f32();
  const world = (f & 4) !== 0 ? [r.f32(), r.f32(), r.f32()] as const : null;
  return { x, y, world, over: r.ouv(), held: (f & 1) !== 0, down: (f & 2) !== 0 };
}

function writeFrame(w: ByteWriter, f: InputFrame): void {
  w.uv(f.seq);
  const entries = Object.entries(f.actions);
  w.uv(entries.length);
  for (const [name, value] of entries) { w.str(name); writeAction(w, value); }
  if (f.pointer === undefined) w.u8(0); else { w.u8(1); writePointer(w, f.pointer); }
}

function readFrame(r: ByteReader): InputFrame {
  const seq = r.uv();
  const n = r.count(2);
  const actions: Record<string, ActionValue> = {};
  for (let i = 0; i < n; i++) {
    const name = r.str();
    if (name === '__proto__') throw new Malformed('reserved key');
    actions[name] = readAction(r);
  }
  const has = r.u8();
  if (has > 1) throw new Malformed('bad frame');
  return has === 1 ? { seq, actions, pointer: readPointer(r) } : { seq, actions };
}

function writeSeat(w: ByteWriter, s: SeatJson): void {
  w.uv(s.index); w.str(s.id); w.str(s.name); w.ouv(s.entity);
}

function readSeat(r: ByteReader): SeatJson {
  return { index: r.uv(), id: r.str(), name: r.str(), entity: r.ouv() };
}

function writeVec(w: ByteWriter, v: readonly number[]): void { w.sv(v[0]!); w.sv(v[1]!); w.sv(v[2]!); }
function readVec(r: ByteReader): [number, number, number] { return [r.sv(), r.sv(), r.sv()]; }
function writeScale(w: ByteWriter, v: readonly number[]): void { w.f32(v[0]!); w.f32(v[1]!); w.f32(v[2]!); }
function readScale(r: ByteReader): [number, number, number] { return [r.f32(), r.f32(), r.f32()]; }

function writeTransform(w: ByteWriter, t: TransformWire): void {
  w.u8(t.s === undefined ? 0 : 1);
  writeVec(w, t.p);
  w.u32(t.r);
  if (t.s !== undefined) writeScale(w, t.s);
}

function readTransform(r: ByteReader): TransformWire {
  const f = r.u8();
  const p = readVec(r);
  const rot = r.u32();
  return f === 1 ? { p, r: rot, s: readScale(r) } : { p, r: rot };
}

function writeOrigin(w: ByteWriter, o: EntityOrigin): void {
  if ('scene' in o) { w.u8(0); w.uv(o.scene); return; }
  if ('child' in o) { w.u8(1); w.uv(o.parent); w.uv(o.child); return; }
  w.u8(2); w.str(o.prefab); w.ouv(o.parent); w.ouv(o.owner);
}

function readOrigin(r: ByteReader): EntityOrigin {
  switch (r.u8()) {
    case 0: return { scene: r.uv() };
    case 1: return { parent: r.uv(), child: r.uv() };
    case 2: return { prefab: r.str(), parent: r.ouv(), owner: r.ouv() };
    default: throw new Malformed('unknown origin');
  }
}

const E = { origin: 1, set: 2, removed: 4, transform: 8, visible: 16, visibleTrue: 32, hidden: 64, hiddenTrue: 128, tags: 256 } as const;

function writeEntity(w: ByteWriter, e: EntityJson): void {
  w.uv(e.id);
  let flags = 0;
  if (e.origin !== undefined) flags |= E.origin;
  if (e.set !== undefined) flags |= E.set;
  if (e.removed !== undefined) flags |= E.removed;
  if (e.transform !== undefined) flags |= E.transform;
  if (e.visible !== undefined) flags |= E.visible | (e.visible ? E.visibleTrue : 0);
  if (e.hidden !== undefined) flags |= E.hidden | (e.hidden ? E.hiddenTrue : 0);
  if (e.tags !== undefined) flags |= E.tags;
  w.uv(flags);
  if (e.origin !== undefined) writeOrigin(w, e.origin);
  if (e.set !== undefined) {
    const entries = Object.entries(e.set);
    w.uv(entries.length);
    for (const [cid, fields] of entries) { w.str(cid); writeJson(w, fields); }
  }
  if (e.removed !== undefined) { w.uv(e.removed.length); for (const c of e.removed) w.str(c); }
  if (e.transform !== undefined) writeTransform(w, e.transform);
  if (e.tags !== undefined) { w.uv(e.tags.length); for (const tag of e.tags) w.str(tag); }
}

function readEntity(r: ByteReader): EntityJson {
  const id = r.uv();
  const flags = r.uv();
  const e: { -readonly [K in keyof EntityJson]: EntityJson[K] } = { id };
  if (flags & E.origin) e.origin = readOrigin(r);
  if (flags & E.set) {
    const n = r.count(2);
    const set: Record<string, JsonObject> = {};
    for (let i = 0; i < n; i++) set[r.str()] = readObject(r);
    e.set = set;
  }
  if (flags & E.removed) { const n = r.count(); e.removed = Array.from({ length: n }, () => r.str()); }
  if (flags & E.transform) e.transform = readTransform(r);
  if (flags & E.visible) e.visible = (flags & E.visibleTrue) !== 0;
  if (flags & E.hidden) e.hidden = (flags & E.hiddenTrue) !== 0;
  if (flags & E.tags) { const n = r.count(); e.tags = Array.from({ length: n }, () => r.str()); }
  return e;
}

const P = { abs: 1, delta: 2, rot: 4, scale: 8 } as const;

function writePose(w: ByteWriter, p: PoseWire): void {
  w.uv(p.id);
  w.u8((p.p !== undefined ? P.abs : 0) | (p.d !== undefined ? P.delta : 0) | (p.r !== undefined ? P.rot : 0) | (p.s !== undefined ? P.scale : 0));
  if (p.p !== undefined) writeVec(w, p.p);
  if (p.d !== undefined) writeVec(w, p.d);
  if (p.r !== undefined) w.u32(p.r);
  if (p.s !== undefined) writeScale(w, p.s);
}

function readPose(r: ByteReader): PoseWire {
  const id = r.uv();
  const f = r.u8();
  const pose: { -readonly [K in keyof PoseWire]: PoseWire[K] } = { id };
  if (f & P.abs) pose.p = readVec(r);
  if (f & P.delta) pose.d = readVec(r);
  if (f & P.rot) pose.r = r.u32();
  if (f & P.scale) pose.s = readScale(r);
  return pose;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function encodeServerBinary(m: ServerMessage): Uint8Array {
  const w = new ByteWriter();
  w.u8(S[m.t]);
  switch (m.t) {
    case 'welcome': w.uv(m.protocol); writeSeat(w, m.seat); w.uv(m.tick_rate); w.str(m.token); break;
    case 'scene': w.uv(m.epoch); w.str(m.scene); w.f64(m.seed); break;
    case 'state':
      w.uv(m.epoch); w.uv(m.tick);
      w.u8((m.players !== undefined ? 1 : 0) | (m.resources !== undefined ? 2 : 0) | (m.feedback !== undefined ? 4 : 0) | (m.world !== undefined ? 8 : 0));
      if (m.players !== undefined) { w.uv(m.players.length); for (const s of m.players) writeSeat(w, s); }
      w.uv(m.entities.length); for (const e of m.entities) writeEntity(w, e);
      w.uv(m.destroyed.length); for (const id of m.destroyed) w.uv(id);
      if (m.resources !== undefined) writeJson(w, m.resources as JsonObject);
      if (m.feedback !== undefined) writeJson(w, m.feedback as Json[]);
      if (m.world !== undefined) writeJson(w, m.world);
      break;
    case 'snap':
      w.uv(m.epoch); w.uv(m.tick); w.f64(m.rt); w.f64(m.now); w.f64(m.sceneStart); w.sv(m.base); w.sv(m.ack);
      w.uv(m.poses.length); for (const p of m.poses) writePose(w, p);
      break;
    case 'channel': w.str(m.topic); writeJson(w, m.payload); break;
    case 'rejected': w.str(m.rpc); w.str(m.code); w.str(m.message); break;
    case 'bye': w.str(m.code); w.str(m.message); break;
  }
  return w.bytes();
}

export function decodeServerBinary(bytes: Uint8Array): ServerMessage {
  const r = new ByteReader(bytes);
  let m: ServerMessage;
  switch (r.u8()) {
    case S.welcome: m = { t: 'welcome', protocol: r.uv(), seat: readSeat(r), tick_rate: r.uv(), token: r.str() }; break;
    case S.scene: m = { t: 'scene', epoch: r.uv(), scene: r.str(), seed: r.f64() }; break;
    case S.state: {
      const epoch = r.uv();
      const tick = r.uv();
      const f = r.u8();
      const players = (f & 1) !== 0 ? Array.from({ length: r.count() }, () => readSeat(r)) : undefined;
      const entities = Array.from({ length: r.count() }, () => readEntity(r));
      const destroyed = Array.from({ length: r.count() }, () => r.uv());
      const resources = (f & 2) !== 0 ? readObject(r) as Record<string, JsonObject> : undefined;
      const feedback = (f & 4) !== 0 ? readJson(r) as Json[] : undefined;
      const world = (f & 8) !== 0 ? readObject(r) : undefined;
      m = {
        t: 'state', epoch, tick, entities, destroyed,
        ...(players !== undefined && { players }), ...(resources !== undefined && { resources }), ...(feedback !== undefined && { feedback }),
        ...(world !== undefined && { world }),
      };
      break;
    }
    case S.snap: {
      const epoch = r.uv(); const tick = r.uv(); const rt = r.f64(); const now = r.f64(); const sceneStart = r.f64(); const base = r.sv(); const ack = r.sv();
      m = { t: 'snap', epoch, tick, rt, now, sceneStart, base, ack, poses: Array.from({ length: r.count(2) }, () => readPose(r)) };
      break;
    }
    case S.channel: m = { t: 'channel', topic: r.str(), payload: readJson(r) }; break;
    case S.rejected: m = { t: 'rejected', rpc: r.str(), code: r.str(), message: r.str() }; break;
    case S.bye: m = { t: 'bye', code: r.str(), message: r.str() }; break;
    default: throw new Malformed('unknown message type');
  }
  if (!r.done) throw new Malformed('trailing bytes');
  return m;
}

export function encodeClientBinary(m: ClientMessage): Uint8Array {
  const w = new ByteWriter();
  w.u8(C[m.t]);
  switch (m.t) {
    case 'hello':
      w.uv(m.protocol); w.str(m.name);
      if (m.rejoin === undefined) w.u8(0); else { w.u8(1); w.str(m.rejoin); }
      break;
    case 'input':
      w.sv(m.ack); w.f64(m.view); w.uv(m.frames.length);
      for (const f of m.frames) writeFrame(w, f);
      break;
    case 'rpc': w.str(m.rpc); writeJson(w, m.args); w.f64(m.view); break;
    case 'channel': w.str(m.topic); writeJson(w, m.payload); break;
    case 'leave': break;
  }
  return w.bytes();
}

function decodeClientBinary(bytes: Uint8Array): ClientMessage {
  const r = new ByteReader(bytes);
  let m: ClientMessage;
  switch (r.u8()) {
    case C.hello: {
      const protocol = r.uv();
      const name = r.str();
      const has = r.u8();
      if (has > 1) throw new Malformed('bad hello');
      m = has === 1 ? { t: 'hello', protocol, name, rejoin: r.str() } : { t: 'hello', protocol, name };
      break;
    }
    case C.input: {
      const ack = r.sv();
      const view = r.f64();
      const n = r.count(3);
      if (ack < -1 || n > MAX_INPUT_FRAMES) throw new Malformed('bad input');
      m = { t: 'input', ack, view, frames: Array.from({ length: n }, () => readFrame(r)) };
      break;
    }
    case C.rpc: m = { t: 'rpc', rpc: r.str(), args: readObject(r), view: r.f64() }; break;
    case C.channel: {
      const topic = r.str();
      const payload = readJson(r);
      if (!isChannelTopic(topic) || JSON.stringify(payload).length > MAX_CHANNEL_BYTES) throw new Malformed('bad channel message');
      m = { t: 'channel', topic, payload };
      break;
    }
    case C.leave: m = { t: 'leave' }; break;
    default: throw new Malformed('unknown message type');
  }
  if (!r.done) throw new Malformed('trailing bytes');
  return m;
}

// ── Either form ───────────────────────────────────────────────────────────────

export function encodeServer(m: ServerMessage, format: WireFormat): NetMessage {
  return format === 'binary' ? encodeServerBinary(m) : JSON.stringify(m);
}

export function encodeClient(m: ClientMessage, format: WireFormat): NetMessage {
  return format === 'binary' ? encodeClientBinary(m) : JSON.stringify(m);
}

export function formatOf(message: NetMessage): WireFormat {
  return typeof message === 'string' ? 'json' : 'binary';
}

/** A client's message, checked for shape. PP9354 when it isn't one. */
export function decodeClient(message: NetMessage): ClientMessage {
  if (typeof message === 'string') {
    let value: unknown;
    try { value = JSON.parse(message); } catch { return fail('PP9354', 'A client sent a message that is not JSON'); }
    return checkClientMessage(value);
  }
  try {
    return decodeClientBinary(message);
  } catch (error) {
    if (error instanceof Malformed || error instanceof TypeError || error instanceof RangeError) {
      return fail('PP9354', `A client sent a malformed binary message (${error.message})`);
    }
    throw error;
  }
}

/** A server's message. The server is trusted; this only checks it is one of ours. */
export function decodeServer(message: NetMessage): ServerMessage {
  if (typeof message === 'string') {
    let value: unknown;
    try { value = JSON.parse(message); } catch { return fail('PP9354', 'The server sent a message that is not JSON'); }
    if (typeof value !== 'object' || value === null || typeof (value as { t?: unknown }).t !== 'string') {
      return fail('PP9354', 'The server sent a message without a type');
    }
    return value as ServerMessage;
  }
  try {
    return decodeServerBinary(message);
  } catch (error) {
    if (error instanceof Malformed || error instanceof TypeError || error instanceof RangeError) {
      return fail('PP9354', `The server sent a malformed binary message (${error.message})`);
    }
    throw error;
  }
}

/** Bytes a message takes on the wire (text: its UTF-8 length). */
export function wireSize(message: NetMessage): number {
  return typeof message === 'string' ? encoder.encode(message).length : message.length;
}
