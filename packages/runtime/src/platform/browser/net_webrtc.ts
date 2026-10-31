/**
 * The net port over WebRTC: a player's browser hosts the match. The host's `WebRtcListener`
 * is the server's door (`NetListener`); each joining player's `WebRtcLink` is its client
 * link. Offers, answers and ICE candidates travel through the core `Signaling` port (the
 * product's lobby, or the reference relay in `packages/server`).
 *
 * Each connection has two data channels, created negotiated (fixed ids, no in-band
 * announcement) on both sides:
 *
 *   reliable    ordered, retransmitted           state, RPCs, handshakes
 *   unreliable  unordered, no retransmits        snapshots, input
 *
 * Framing. Every data-channel message starts with a kind byte: a whole binary or text
 * message, or one chunk of a larger one. Data channels only promise small messages across
 * browsers, so anything over `CHUNK` bytes is split on the reliable channel (ordered, so
 * chunks reassemble in sequence, at most `MAX_MESSAGE` bytes). An unreliable message too big
 * for one chunk is sent reliably instead — losing one chunk would lose all of it.
 *
 * Back-pressure. An unreliable send is skipped while the channel has more than
 * `UNRELIABLE_HIGH_WATER` bytes queued (old snapshots are worthless); a reliable one fails
 * the link past `RELIABLE_LIMIT` (the peer stopped reading).
 */

import { fail, HOST_PEER } from '../../core/index.js';
import type { NetChannel, NetLink, NetLinkState, NetListener, NetMessage, Signaling } from '../../core/index.js';

/** The parts of RTCDataChannel this adapter uses. */
export interface RtcDataChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

export interface RtcDescription {
  readonly type: string;
  readonly sdp?: string;
}

/** The parts of RTCPeerConnection this adapter uses. */
export interface RtcPeerConnectionLike {
  readonly connectionState: string;
  createDataChannel(label: string, init: { ordered: boolean; maxRetransmits?: number; negotiated: true; id: number }): RtcDataChannelLike;
  createOffer(): Promise<RtcDescription>;
  createAnswer(): Promise<RtcDescription>;
  setLocalDescription(description: RtcDescription): Promise<void>;
  setRemoteDescription(description: RtcDescription): Promise<void>;
  addIceCandidate(candidate: object): Promise<void>;
  onicecandidate: ((event: { readonly candidate: { toJSON(): object } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  close(): void;
}

export type CreatePeer = () => RtcPeerConnectionLike;

/** Bytes per data-channel message (16 KiB works between every browser). */
export const CHUNK = 16 * 1024;
/** The largest message reassembled from chunks. */
export const MAX_MESSAGE = 8 * 1024 * 1024;
export const UNRELIABLE_HIGH_WATER = 64 * 1024;
export const RELIABLE_LIMIT = 16 * 1024 * 1024;

const KIND = { binary: 0, text: 1, binaryPart: 2, binaryLast: 3, textPart: 4, textLast: 5 } as const;
const CHANNELS = { reliable: { id: 0, ordered: true }, unreliable: { id: 1, ordered: false, maxRetransmits: 0 } } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The default peer: the platform's RTCPeerConnection with `iceServers`. */
export function browserPeer(iceServers: readonly object[] = [{ urls: 'stun:stun.l.google.com:19302' }]): CreatePeer {
  return () => {
    const Ctor = (globalThis as { RTCPeerConnection?: new (config: object) => RtcPeerConnectionLike }).RTCPeerConnection;
    if (Ctor === undefined) fail('PP9357', 'This platform has no WebRTC (RTCPeerConnection)');
    return new Ctor({ iceServers });
  };
}

/** Frames one message into data-channel messages (`CHUNK` bytes at most each). */
export function frame(message: NetMessage): Uint8Array[] {
  const text = typeof message === 'string';
  const body = text ? encoder.encode(message) : message;
  if (body.length + 1 <= CHUNK) {
    const out = new Uint8Array(body.length + 1);
    out[0] = text ? KIND.text : KIND.binary;
    out.set(body, 1);
    return [out];
  }
  const parts: Uint8Array[] = [];
  const size = CHUNK - 1;
  for (let at = 0; at < body.length; at += size) {
    const piece = body.subarray(at, Math.min(body.length, at + size));
    const last = at + size >= body.length;
    const out = new Uint8Array(piece.length + 1);
    out[0] = text ? (last ? KIND.textLast : KIND.textPart) : (last ? KIND.binaryLast : KIND.binaryPart);
    out.set(piece, 1);
    parts.push(out);
  }
  return parts;
}

/** Reassembles framed data-channel messages. `push` returns a whole message, null (more to come), or throws on a bad frame. */
export class Reassembler {
  #parts: Uint8Array[] = [];
  #bytes = 0;
  #text: boolean | null = null;

  push(data: Uint8Array): NetMessage | null {
    if (data.length === 0) throw new Error('empty data-channel message');
    const kind = data[0]!;
    const body = data.subarray(1);
    switch (kind) {
      case KIND.binary:
      case KIND.text:
        if (this.#text !== null) throw new Error('a whole message inside a chunked one');
        return kind === KIND.text ? decoder.decode(body) : body.slice();
      case KIND.binaryPart: case KIND.binaryLast: case KIND.textPart: case KIND.textLast: {
        const text = kind === KIND.textPart || kind === KIND.textLast;
        if (this.#text !== null && this.#text !== text) throw new Error('chunks of different kinds');
        this.#text = text;
        this.#bytes += body.length;
        if (this.#bytes > MAX_MESSAGE) throw new Error('message too big');
        this.#parts.push(body.slice());
        if (kind === KIND.binaryPart || kind === KIND.textPart) return null;
        const whole = new Uint8Array(this.#bytes);
        let at = 0;
        for (const p of this.#parts) { whole.set(p, at); at += p.length; }
        this.#parts = [];
        this.#bytes = 0;
        this.#text = null;
        return text ? decoder.decode(whole) : whole;
      }
      default:
        throw new Error(`unknown frame kind ${kind}`);
    }
  }
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

type Signal =
  | { readonly kind: 'offer' | 'answer'; readonly sdp: string }
  | { readonly kind: 'ice'; readonly candidate: object }
  | { readonly kind: 'bye'; readonly reason: string };

function parseSignal(payload: string): Signal | null {
  let v: unknown;
  try { v = JSON.parse(payload); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if ((o['kind'] === 'offer' || o['kind'] === 'answer') && typeof o['sdp'] === 'string') return { kind: o['kind'], sdp: o['sdp'] };
  if (o['kind'] === 'ice' && typeof o['candidate'] === 'object' && o['candidate'] !== null) return { kind: 'ice', candidate: o['candidate'] };
  if (o['kind'] === 'bye' && typeof o['reason'] === 'string') return { kind: 'bye', reason: o['reason'] };
  return null;
}

let links = 0;

/**
 * One peer connection with its two channels: the `NetLink` both ends use. Created by
 * `WebRtcLink` (the joining side) or by the host's listener.
 */
class RtcConnection implements NetLink {
  readonly id: string;
  readonly unreliable = true;
  readonly #pc: RtcPeerConnectionLike;
  readonly #reliable: RtcDataChannelLike;
  readonly #lossy: RtcDataChannelLike;
  readonly #reassembler = new Reassembler();
  readonly #inbox: NetMessage[] = [];
  readonly #outbox: { readonly message: NetMessage; readonly channel: NetChannel }[] = [];
  readonly #remoteCandidates: object[] = [];
  #remoteSet = false;
  #state: NetLinkState = 'connecting';
  #reason: string | null = null;
  /** Called with each local ICE candidate and description to signal to the other side. */
  readonly #signal: (signal: Signal) => void;
  /** Unreliable sends skipped because the channel was backed up. */
  skipped = 0;

  constructor(pc: RtcPeerConnectionLike, signal: (signal: Signal) => void) {
    this.id = `rtc-${links++}`;
    this.#pc = pc;
    this.#signal = signal;
    this.#reliable = pc.createDataChannel('reliable', { ...CHANNELS.reliable, negotiated: true });
    this.#lossy = pc.createDataChannel('unreliable', { ...CHANNELS.unreliable, negotiated: true });
    for (const ch of [this.#reliable, this.#lossy]) {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => this.#opened();
      ch.onclose = () => this.#lost('data channel closed');
      ch.onerror = () => this.#lost('data channel error');
    }
    this.#reliable.onmessage = (e) => this.#message(e.data, true);
    this.#lossy.onmessage = (e) => this.#message(e.data, false);
    pc.onicecandidate = (e) => { if (e.candidate !== null) signal({ kind: 'ice', candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.#lost(`peer connection ${pc.connectionState}`);
    };
  }

  get state(): NetLinkState { return this.#state; }
  get closeReason(): string | null { return this.#reason; }

  /** The joining side: make the offer. */
  async offer(): Promise<void> {
    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription(offer);
    this.#signal({ kind: 'offer', sdp: offer.sdp ?? '' });
  }

  /** A signal from the other side. */
  async signal(s: Signal): Promise<void> {
    if (this.#state === 'closed') return;
    switch (s.kind) {
      case 'offer': {
        await this.#pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        await this.#remoteReady();
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);
        this.#signal({ kind: 'answer', sdp: answer.sdp ?? '' });
        return;
      }
      case 'answer':
        await this.#pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        await this.#remoteReady();
        return;
      case 'ice':
        // Candidates can arrive before the description they belong to.
        if (this.#remoteSet) await this.#pc.addIceCandidate(s.candidate);
        else this.#remoteCandidates.push(s.candidate);
        return;
      case 'bye':
        this.#lost(s.reason);
    }
  }

  async #remoteReady(): Promise<void> {
    this.#remoteSet = true;
    for (const c of this.#remoteCandidates.splice(0)) await this.#pc.addIceCandidate(c);
  }

  #opened(): void {
    if (this.#state !== 'connecting' || this.#reliable.readyState !== 'open' || this.#lossy.readyState !== 'open') return;
    this.#state = 'open';
    for (const { message, channel } of this.#outbox.splice(0)) this.send(message, channel);
  }

  #message(data: unknown, reliable: boolean): void {
    const bytes = bytesOf(data);
    try {
      if (bytes === null) throw new Error('a non-binary data-channel message');
      if (!reliable && bytes[0] !== KIND.binary && bytes[0] !== KIND.text) throw new Error('a chunk on the unreliable channel');
      const whole = reliable ? this.#reassembler.push(bytes) : new Reassembler().push(bytes);
      if (whole !== null) this.#inbox.push(whole);
    } catch (error) {
      this.close(`bad data from the peer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  send(message: NetMessage, channel: NetChannel = 'reliable'): void {
    if (this.#state === 'closed') return;
    if (this.#state === 'connecting') { this.#outbox.push({ message, channel }); return; }
    const frames = frame(message);
    if (channel === 'unreliable' && frames.length === 1) {
      if (this.#lossy.bufferedAmount > UNRELIABLE_HIGH_WATER) { this.skipped++; return; }
      this.#lossy.send(frames[0]!);
      return;
    }
    if (this.#reliable.bufferedAmount > RELIABLE_LIMIT) { this.close('the peer stopped reading (send buffer full)'); return; }
    for (const f of frames) this.#reliable.send(f);
  }

  receive(): NetMessage[] {
    return this.#inbox.splice(0);
  }

  close(reason = 'closed'): void {
    if (this.#state === 'closed') return;
    // Tell the other side why, then hang up.
    this.#signal({ kind: 'bye', reason });
    this.#end(reason);
  }

  /** The transport went away (no goodbye to send). */
  #lost(reason: string): void {
    if (this.#state === 'closed') return;
    this.#end(reason);
  }

  #end(reason: string): void {
    this.#state = 'closed';
    this.#reason = reason;
    this.#reliable.close();
    this.#lossy.close();
    this.#pc.close();
  }

  /** The signalling relay says the other side left. */
  gone(): void {
    this.#lost('the peer left');
  }
}

/** Run a signal handler, failing the link (not the frame) when the browser's WebRTC rejects it. */
function handle(link: RtcConnection, work: Promise<void>): void {
  work.catch((error: unknown) => link.close(`WebRTC negotiation failed: ${error instanceof Error ? error.message : String(error)}`));
}

/** A joining player's link to a hosting browser. Signalling is pumped whenever the link is used. */
export class WebRtcLink implements NetLink {
  readonly unreliable = true;
  readonly #signaling: Signaling;
  readonly #conn: RtcConnection;

  constructor(signaling: Signaling, createPeer: CreatePeer) {
    this.#signaling = signaling;
    this.#conn = new RtcConnection(createPeer(), (s) => signaling.send(HOST_PEER, JSON.stringify(s)));
    handle(this.#conn, this.#conn.offer());
  }

  get id(): string { return this.#conn.id; }
  get state(): NetLinkState { this.#pump(); return this.#conn.state; }
  get closeReason(): string | null { return this.#conn.closeReason; }

  #pump(): void {
    for (const m of this.#signaling.receive()) {
      if (m.from !== HOST_PEER) continue;
      if (m.payload === null) { this.#conn.gone(); continue; }
      const s = parseSignal(m.payload);
      if (s !== null) handle(this.#conn, this.#conn.signal(s));
    }
    if (this.#signaling.state === 'closed' && this.#conn.state === 'connecting') {
      this.#conn.close(`signalling closed before the connection opened: ${this.#signaling.closeReason ?? ''}`);
    }
  }

  send(message: NetMessage, channel?: NetChannel): void {
    this.#pump();
    this.#conn.send(message, channel);
  }

  receive(): NetMessage[] {
    this.#pump();
    return this.#conn.receive();
  }

  close(reason?: string): void {
    this.#conn.close(reason);
  }
}

/** The hosting browser's door: one connection per peer that signals an offer. */
export class WebRtcListener implements NetListener {
  readonly #signaling: Signaling;
  readonly #createPeer: CreatePeer;
  readonly #peers = new Map<string, RtcConnection>();
  /** Connections not yet handed out by `accept` (handed out once open). */
  readonly #pending: RtcConnection[] = [];
  #open = true;

  constructor(signaling: Signaling, createPeer: CreatePeer) {
    this.#signaling = signaling;
    this.#createPeer = createPeer;
  }

  accept(): NetLink[] {
    if (!this.#open) return [];
    for (const m of this.#signaling.receive()) {
      const known = this.#peers.get(m.from);
      if (m.payload === null) {
        known?.gone();
        this.#peers.delete(m.from);
        continue;
      }
      const s = parseSignal(m.payload);
      if (s === null) continue;
      if (s.kind === 'offer') {
        // A new offer from a peer replaces its old connection (it reloaded, or retried).
        known?.close('replaced by a new offer');
        const to = m.from;
        const conn = new RtcConnection(this.#createPeer(), (signal) => this.#signaling.send(to, JSON.stringify(signal)));
        this.#peers.set(to, conn);
        this.#pending.push(conn);
        handle(conn, conn.signal(s));
      } else if (known !== undefined) {
        handle(known, known.signal(s));
      }
    }
    const ready: NetLink[] = [];
    for (const conn of [...this.#pending]) {
      if (conn.state === 'connecting') continue;
      this.#pending.splice(this.#pending.indexOf(conn), 1);
      if (conn.state === 'open') ready.push(conn);
    }
    return ready;
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    for (const conn of this.#pending.splice(0)) conn.close('the host stopped');
    this.#signaling.close('the host stopped');
  }
}
