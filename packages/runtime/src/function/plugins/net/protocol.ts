/**
 * The wire protocol's messages. Each has one meaning and two encodings (`wire.ts`): binary
 * (normal play) and JSON text (the debug form, readable in a network inspector). A side
 * answers in the form it is spoken to.
 *
 *   client → server   hello, input (unreliable, redundant), rpc, channel, leave
 *   server → client   welcome, scene, state (reliable: structure, fields, feedback, world),
 *                     snap (unreliable: transforms, clocks, input acks), channel, rejected, bye
 *
 * `channel` carries a plugin's message (services/channels.ts: chat, voice signalling) on the
 * reliable channel: a topic and a JSON payload of at most MAX_CHANNEL_BYTES.
 *
 * Field values travel in the kernel's encoded (save) form; entity references are the
 * SERVER's entity ids, which each client maps to its own. Transforms travel quantized
 * (`quantize.ts`): whole millimetres and a packed rotation, so a snapshot can be a delta
 * against the last one the client acknowledged and both sides agree on every bit.
 *
 * Everything a client sends is untrusted: `checkClientMessage` checks the shape (the binary
 * decoder builds only well-formed values) and the server checks the meaning (seat, rpc id,
 * argument types, rate).
 */

import { fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';

/** Bumped on any incompatible change; client and server must agree. 3: binary + snapshots + prediction; 4: world state; 5: channels; 6: snapshot scene start (monotonic game time). */
export const PROTOCOL = 6;

/** A channel message's limits: its topic's length, and its payload's as JSON text (UTF-16 units). */
export const MAX_CHANNEL_TOPIC = 64;
export const MAX_CHANNEL_BYTES = 16 * 1024;

export type WireFormat = 'binary' | 'json';

/** One action's state for a frame. Buttons: held + went down; axis1: value; axis2: [x, y]; group: slot pressed. */
export type ActionValue =
  | { readonly k: 'button'; readonly held: boolean; readonly down: boolean }
  | { readonly k: 'axis1'; readonly value: number }
  | { readonly k: 'axis2'; readonly x: number; readonly y: number }
  | { readonly k: 'group'; readonly slot: number | null };

/** Action states by "<set>.<action>". On the wire only actions that aren't idle are listed. */
export type ActionFrame = Readonly<Record<string, ActionValue>>;

/**
 * The client's pointer with its input (so `ctx.input.pointer` reads it for that player on
 * the server): screen position, the world point and entity (server id) under it as the
 * client resolved them (null when it couldn't), the left button held and went down.
 */
export interface PointerJson {
  readonly x: number;
  readonly y: number;
  readonly world: readonly [number, number, number] | null;
  readonly over: number | null;
  readonly held: boolean;
  readonly down: boolean;
}

/** One frame of a client's input. `seq` counts the client's frames from 0. */
export interface InputFrame {
  readonly seq: number;
  readonly actions: ActionFrame;
  readonly pointer?: PointerJson;
}

export interface SeatJson {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  /** The seat's player entity (server id), or null. */
  readonly entity: number | null;
}

/**
 * How a client finds the entity behind a server id:
 *   scene  the i-th root the scene file placed (the client loaded the same scene)
 *   child  the k-th prefab child of an entity it already has
 *   prefab spawned by the server: the client spawns the prefab itself
 */
export type EntityOrigin =
  | { readonly scene: number }
  | { readonly parent: number; readonly child: number }
  | { readonly prefab: string; readonly parent: number | null; readonly owner: number | null };

/** A whole local transform, quantized: millimetres, packed rotation, scale (absent: 1, 1, 1). */
export interface TransformWire {
  readonly p: readonly [number, number, number];
  readonly r: number;
  readonly s?: readonly [number, number, number];
}

export interface EntityJson {
  readonly id: number;
  /** Present when the client doesn't have this entity yet. */
  readonly origin?: EntityOrigin;
  /** Changed component fields (encoded); a component new to the client lists all its replicated fields. */
  readonly set?: Readonly<Record<string, JsonObject>>;
  /** Components removed since the last state. */
  readonly removed?: readonly string[];
  /** Sent on first sight and when it comes back into view; moving entities then travel in `snap`. */
  readonly transform?: TransformWire;
  /** `entity.visible` as game code set it. */
  readonly visible?: boolean;
  /** Interest: the client keeps this placed entity but hides it (out of view). */
  readonly hidden?: boolean;
  readonly tags?: readonly string[];
}

/**
 * One entity's pose in a snapshot. Against the baseline: `d` is the millimetre delta,
 * `p` an absolute position (no baseline value), `r` / `s` present when they differ.
 * Entities whose pose equals the baseline are left out.
 */
export interface PoseWire {
  readonly id: number;
  readonly p?: readonly [number, number, number];
  readonly d?: readonly [number, number, number];
  readonly r?: number;
  readonly s?: readonly [number, number, number];
}

export type ServerMessage =
  | {
    readonly t: 'welcome'; readonly protocol: number; readonly seat: SeatJson; readonly tick_rate: number;
    /** Present the seat on a new link within the rejoin window (`hello.rejoin`). */
    readonly token: string;
  }
  | { readonly t: 'scene'; readonly epoch: number; readonly scene: string; readonly seed: number }
  | {
    readonly t: 'state';
    readonly epoch: number;
    readonly tick: number;
    readonly players?: readonly SeatJson[];
    readonly entities: readonly EntityJson[];
    readonly destroyed: readonly number[];
    readonly resources?: Readonly<Record<string, JsonObject>>;
    /** One-shot feedback of this tick, after its spawns (so references resolve). */
    readonly feedback?: readonly Json[];
    /** World state outside entities the client hasn't had yet (world_sync.ts: terrain edits, felled foliage, wind). */
    readonly world?: JsonObject;
  }
  | {
    readonly t: 'snap';
    readonly epoch: number;
    readonly tick: number;
    /** Server wall clock (`time.realNow`): interpolation and lag compensation run on it. */
    readonly rt: number;
    /** Server game time (`ctx.time.now`); clients follow it. */
    readonly now: number;
    /** Server game time when its scene loaded (`ctx.time.scene_time` = now − sceneStart). */
    readonly sceneStart: number;
    /** The snapshot tick these poses are relative to (one the client acknowledged), or -1. */
    readonly base: number;
    /** The newest of this client's input frames the poses include, or -1. */
    readonly ack: number;
    readonly poses: readonly PoseWire[];
  }
  | { readonly t: 'channel'; readonly topic: string; readonly payload: Json }
  | { readonly t: 'rejected'; readonly rpc: string; readonly code: string; readonly message: string }
  | { readonly t: 'bye'; readonly code: string; readonly message: string };

export type ClientMessage =
  | { readonly t: 'hello'; readonly protocol: number; readonly name: string; readonly rejoin?: string }
  | {
    readonly t: 'input';
    /** The newest snapshot tick reconstructed (the server's next baseline), or -1. */
    readonly ack: number;
    /** The server time the client is showing (interpolated view): lag compensation rewinds to it. -1: not known yet. */
    readonly view: number;
    /** The newest frames the server may not have yet, oldest first (redundant on unreliable links). */
    readonly frames: readonly InputFrame[];
  }
  | { readonly t: 'rpc'; readonly rpc: string; readonly args: JsonObject; readonly view: number }
  | { readonly t: 'channel'; readonly topic: string; readonly payload: Json }
  /** Leaving on purpose: no rejoin window. */
  | { readonly t: 'leave' };

// ── Shape checks for untrusted JSON ───────────────────────────────────────────

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1;

export function isActionValue(value: unknown): value is ActionValue {
  if (!object(value)) return false;
  switch (value['k']) {
    case 'button': return typeof value['held'] === 'boolean' && typeof value['down'] === 'boolean';
    case 'axis1': return finite(value['value']);
    case 'axis2': return finite(value['x']) && finite(value['y']);
    case 'group': return value['slot'] === null || (Number.isInteger(value['slot']) && (value['slot'] as number) >= 0);
    default: return false;
  }
}

export function isPointer(value: unknown): value is PointerJson {
  if (!object(value)) return false;
  const world = value['world'];
  const over = value['over'];
  return finite(value['x']) && finite(value['y']) && typeof value['held'] === 'boolean' && typeof value['down'] === 'boolean'
    && (world === null || (Array.isArray(world) && world.length === 3 && world.every(finite)))
    && (over === null || (Number.isInteger(over) && (over as number) >= 0));
}

function isFrame(value: unknown): value is InputFrame {
  return object(value) && Number.isInteger(value['seq']) && (value['seq'] as number) >= 0
    && object(value['actions']) && Object.values(value['actions']).every(isActionValue)
    && (value['pointer'] === undefined || isPointer(value['pointer']));
}

export function isChannelTopic(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHANNEL_TOPIC;
}

/** Most input frames one message may carry. */
export const MAX_INPUT_FRAMES = 8;

/** A client's message (already parsed from JSON), checked for shape. PP9354 when it isn't one. */
export function checkClientMessage(value: unknown): ClientMessage {
  if (!object(value)) return fail('PP9354', 'A client sent a message that is not an object');
  switch (value['t']) {
    case 'hello':
      if (typeof value['protocol'] === 'number' && typeof value['name'] === 'string'
        && (value['rejoin'] === undefined || typeof value['rejoin'] === 'string')) return value as unknown as ClientMessage;
      break;
    case 'input': {
      const frames = value['frames'];
      if (count(value['ack']) && finite(value['view']) && Array.isArray(frames) && frames.length <= MAX_INPUT_FRAMES && frames.every(isFrame)) {
        return value as unknown as ClientMessage;
      }
      break;
    }
    case 'rpc':
      if (typeof value['rpc'] === 'string' && object(value['args']) && finite(value['view'])) return value as unknown as ClientMessage;
      break;
    case 'channel':
      if (isChannelTopic(value['topic']) && 'payload' in value && JSON.stringify(value['payload']).length <= MAX_CHANNEL_BYTES) {
        return value as unknown as ClientMessage;
      }
      break;
    case 'leave':
      return { t: 'leave' };
    default:
      break;
  }
  return fail('PP9354', `A client sent a malformed "${String(value['t'])}" message`);
}
