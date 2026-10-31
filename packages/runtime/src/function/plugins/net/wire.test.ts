/**
 * The wire: binary and JSON encodings of every message round-trip to the same value; the
 * binary decoder rejects anything malformed; transforms quantize within their bounds; and
 * delta snapshots reconstruct exactly over a lossy channel. Sizes are measured against the
 * JSON form and against protocol 2's JSON-of-floats transforms.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Quat, SeededRandom, Vec3 } from '../../../core/index.js';
import type { ClientMessage, EntityJson, PoseWire, ServerMessage } from './protocol.js';
import { packRotation, positionOf, quantizePose, unpackRotation } from './quantize.js';
import type { QuantPose } from './quantize.js';
import { SnapshotReceiver, SnapshotSender } from './snapshots.js';
import { decodeClient, decodeServer, encodeClient, encodeServer, wireSize } from './wire.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof ParallaxError ? error.diagnostic.code : String(error); }
  return undefined;
}

const SERVER: ServerMessage[] = [
  { t: 'welcome', protocol: 3, seat: { index: 1, id: 'p1', name: 'Ann ✓', entity: 42 }, tick_rate: 30, token: 'abc123' },
  { t: 'scene', epoch: 2, scene: 'arena', seed: 123456789 },
  {
    t: 'state', epoch: 2, tick: 77,
    players: [{ index: 0, id: 'p0', name: 'Bo', entity: null }],
    entities: [
      { id: 9, origin: { prefab: 'ship', parent: null, owner: 0 }, set: { hull: { hp: 80.5, gold: 5, tags: ['a', 'b'], nested: { x: null, y: true } } }, transform: { p: [1000, -250, 3], r: packRotation(Quat.IDENTITY) }, visible: true, tags: ['loot'] },
      { id: 10, origin: { parent: 9, child: 0 }, removed: ['link'], hidden: false, transform: { p: [0, 0, 0], r: 7, s: [2, 2, 2] } },
      { id: 11, origin: { scene: 4 }, visible: false, hidden: true },
    ],
    destroyed: [3, 4],
    resources: { score: { value: -12, ratio: 0.25 } },
    feedback: [{ kind: 'toast', text: { s: 'hi' }, seconds: 2 }],
  },
  { t: 'state', epoch: 0, tick: 1, entities: [], destroyed: [] },
  { t: 'snap', epoch: 2, tick: 78, rt: 12.345, now: 11.5, sceneStart: 2.25, base: 75, ack: 301, poses: [{ id: 9, d: [5, 0, -3] }, { id: 12, p: [1, 2, 3], r: 99, s: [1, 0.5, 1] }, { id: 13, r: 4 }] },
  { t: 'snap', epoch: 0, tick: 1, rt: 0, now: 0, sceneStart: 0, base: -1, ack: -1, poses: [] },
  { t: 'rejected', rpc: 'buy', code: 'PP3354', message: 'too fast' },
  { t: 'bye', code: 'PP3359', message: 'The server shut down' },
];

const CLIENT: ClientMessage[] = [
  { t: 'hello', protocol: 3, name: 'Ann' },
  { t: 'hello', protocol: 3, name: 'Ann', rejoin: 'tok' },
  {
    t: 'input', ack: 77, view: 12.25, frames: [
      { seq: 300, actions: { 'Move.x': { k: 'axis1', value: 0.5 }, 'Move.stick': { k: 'axis2', x: -1, y: 0.25 } } },
      { seq: 301, actions: { 'Fire.shoot': { k: 'button', held: true, down: false }, 'Bar.slot': { k: 'group', slot: 3 } }, pointer: { x: 100, y: 50, world: [1.5, 0, -2], over: 9, held: true, down: true } },
      { seq: 302, actions: { 'Bar.slot': { k: 'group', slot: null } }, pointer: { x: 0, y: 0, world: null, over: null, held: false, down: false } },
    ],
  },
  { t: 'rpc', rpc: 'buy', args: { item: 'sword', count: 2, target: 9 }, view: 3.5 },
  { t: 'leave' },
];

describe('wire codec', () => {
  it('every message round-trips through both encodings', () => {
    for (const m of SERVER) {
      expect(decodeServer(encodeServer(m, 'binary'))).toEqual(m);
      expect(decodeServer(encodeServer(m, 'json'))).toEqual(m);
    }
    for (const m of CLIENT) {
      expect(decodeClient(encodeClient(m, 'binary'))).toEqual(m);
      expect(decodeClient(encodeClient(m, 'json'))).toEqual(m);
    }
  });

  it('a malformed binary client message is PP9354, never a bad value', () => {
    const good = encodeClient(CLIENT[2]!, 'binary') as Uint8Array;
    expect(code(() => decodeClient(good.subarray(0, good.length - 1)))).toBe('PP9354');
    expect(code(() => decodeClient(new Uint8Array([...good, 0])))).toBe('PP9354');
    expect(code(() => decodeClient(new Uint8Array([99])))).toBe('PP9354');
    expect(code(() => decodeClient(new Uint8Array([])))).toBe('PP9354');
    // a NaN axis
    const nan = encodeClient({ t: 'input', ack: -1, view: 0, frames: [{ seq: 0, actions: { a: { k: 'axis1', value: Number.NaN } } }] }, 'binary') as Uint8Array;
    expect(code(() => decodeClient(nan))).toBe('PP9354');
    // a huge count with no bytes behind it
    expect(code(() => decodeClient(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0x7f])))).toBe('PP9354');
    // too many frames
    const many = Array.from({ length: 9 }, (_, i) => ({ seq: i, actions: {} }));
    expect(code(() => decodeClient(encodeClient({ t: 'input', ack: -1, view: 0, frames: many }, 'binary')))).toBe('PP9354');
    expect(code(() => decodeClient(encodeClient({ t: 'input', ack: -1, view: 0, frames: many }, 'json')))).toBe('PP9354');
    // invalid UTF-8 in a name
    expect(code(() => decodeClient(new Uint8Array([1, 3, 2, 0xc3, 0x28, 0])))).toBe('PP9354');
  });
});

describe('quantization', () => {
  it('positions keep a millimetre; rotations stay within a quarter of a degree', () => {
    const rng = new SeededRandom(7);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const q = Quat.from_euler(new Vec3(rng.next() * 360 - 180, rng.next() * 360 - 180, rng.next() * 360 - 180));
      const back = unpackRotation(packRotation(q));
      const dot = Math.abs(q.x * back.x + q.y * back.y + q.z * back.z + q.w * back.w);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI);
      const p = new Vec3(rng.next() * 2000 - 1000, rng.next() * 100, rng.next() * 2000 - 1000);
      const pq = positionOf(quantizePose(p, q, Vec3.ONE).p);
      expect(pq.distance_to(p)).toBeLessThan(0.00087);
    }
    expect(worst).toBeLessThan(0.25);
    expect(packRotation(Quat.IDENTITY)).toBe(packRotation(new Quat(0, 0, 0, -1)));
  });
});

describe('delta snapshots', () => {
  it('reconstruct exactly over a channel that loses a third of them', () => {
    const rng = new SeededRandom(3);
    const sender = new SnapshotSender();
    const receiver = new SnapshotReceiver();
    const positions = Array.from({ length: 20 }, (_, i) => new Vec3(i, 0, 0));
    let checked = 0;
    for (let tick = 1; tick <= 300; tick++) {
      const current = new Map<number, QuantPose>();
      positions.forEach((p, i) => {
        // half the entities move each tick; the rest stand still
        if (i % 2 === 0) positions[i] = p.__add__(new Vec3(rng.next() - 0.5, 0, rng.next() - 0.5));
        if (i === 7 && tick > 150) return; // one leaves view
        current.set(i, quantizePose(positions[i]!, Quat.from_euler(new Vec3(0, tick, 0)), Vec3.ONE));
      });
      const base = sender.base;
      const poses: PoseWire[] = sender.build(tick, current);
      if (rng.next() < 0.33) continue; // lost
      const got = receiver.receive(tick, base, poses);
      expect(got).toBeDefined();
      for (const [id, pose] of current) expect(got!.get(id)).toEqual(pose);
      checked++;
      // the acknowledgement itself is lost a fifth of the time
      if (rng.next() < 0.8) sender.ack(receiver.newest);
    }
    expect(checked).toBeGreaterThan(180);
    expect(receiver.unusable).toBe(0);
  });

  it('binary is a fraction of JSON; a delta snapshot a fraction of protocol 2 transforms', () => {
    const rng = new SeededRandom(11);
    const n = 60;
    const entities: EntityJson[] = Array.from({ length: n }, (_, i) => ({
      id: 1000 + i, origin: { prefab: i % 3 === 0 ? 'minion_blue' : 'minion_red', parent: null, owner: null },
      set: { health: { current: 100, max: 100 }, side: { side: i % 2 === 0 ? 'blue' : 'red' }, unit: { lane: 'mid', gold: 25 } },
      transform: { p: [Math.round(rng.next() * 1e5), 0, Math.round(rng.next() * 1e5)], r: packRotation(Quat.from_euler(new Vec3(0, rng.next() * 360, 0))) },
      visible: true, tags: ['minion'],
    }));
    const state: ServerMessage = { t: 'state', epoch: 1, tick: 1, entities, destroyed: [] };
    const sizes: Record<string, number> = { stateBinary: wireSize(encodeServer(state, 'binary')), stateJson: wireSize(encodeServer(state, 'json')) };

    // A tick of 60 walking units (about 4 cm each at 30 Hz), against the last acknowledged tick.
    const sender = new SnapshotSender();
    const pose = (i: number, t: number): QuantPose => quantizePose(new Vec3(i + t * 0.04, 0, i * 2), Quat.from_euler(new Vec3(0, i * 6, 0)), Vec3.ONE);
    sender.build(1, new Map(entities.map((e, i) => [e.id, pose(i, 1)])));
    sender.ack(1);
    const poses = sender.build(2, new Map(entities.map((e, i) => [e.id, pose(i, 2)])));
    const snap: ServerMessage = { t: 'snap', epoch: 1, tick: 2, rt: 1.5, now: 1.5, sceneStart: 0, base: 1, ack: 40, poses };
    const v2 = JSON.stringify({ t: 'state', epoch: 1, tick: 2, now: 1.5, entities: entities.map((e, i) => {
      const p = positionOf(pose(i, 2).p);
      return { id: e.id, transform: [p.x, p.y, p.z, 0, 0.0523359562, 0, 0.9986295348, 1, 1, 1] };
    }), destroyed: [] });
    Object.assign(sizes, { snapBinary: wireSize(encodeServer(snap, 'binary')), snapJson: wireSize(encodeServer(snap, 'json')), v2Transforms: wireSize(v2) });
    if (process.env['PP_NET_REPORT'] === '1') console.log('wire sizes (bytes)', sizes);
    expect(sizes['stateBinary']).toBeLessThan(sizes['stateJson']! * 0.5);
    expect(sizes['snapBinary']).toBeLessThan(sizes['snapJson']! * 0.5);
    expect(sizes['snapBinary']).toBeLessThan(sizes['v2Transforms']! * 0.15);
  });
});

declare const process: { readonly env: Record<string, string | undefined> };
