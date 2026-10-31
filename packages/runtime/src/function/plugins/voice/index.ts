/**
 * voice — proximity voice chat (sdk/parallax/voice.pyi; core `VoiceDevice`). Every player
 * in a net match opens an audio link to every other (a mesh: fine for the small matches
 * browsers host; the lower player id makes the offer), signalled over the `channels`
 * service: a client sends `{to, payload}` to the server, which forwards `{from, payload}`
 * to that seat (the server never reads the payload).
 *
 * When this player transmits (`mode`):
 *   push_to_talk     while the `talk` action is held
 *   voice_activity   while the microphone is louder than `threshold`, and `hangover`
 *                    seconds after (so words aren't clipped)
 *   open             always
 * and never while self-muted or without a live microphone (`ctx.voice.start()` asks for it).
 *
 * How each voice is heard, every frame: from the talker's player entity, relative to this
 * player's camera — full within `near` meters, falling off as near / distance, silent from
 * `far` (with a fade over the last quarter), panned along the camera's right; times
 * `volume` and the Settings master volume; 0 for a muted player. Without an entity the
 * voice is heard unpanned at full volume (`positional=False` makes every voice so: radio).
 *
 * Voice is presentation: no world state depends on it, so it is not in snapshots except
 * the player's own choices (mutes, self-mute, volume).
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { Quat, VoiceDevice, VoicePlayback } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import { ACTIONS_SERVICE, CHANNELS_SERVICE, PLAYERS_SERVICE } from '../../services/index.js';

export const VOICE_MODES = ['push_to_talk', 'voice_activity', 'open'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

const TOPIC = 'voice';

export interface VoiceOptions {
  readonly mode: VoiceMode;
  /** The push-to-talk action (a game action handle), required for push_to_talk. */
  readonly talk: unknown;
  readonly threshold: number;
  readonly hangover: number;
  readonly near: number;
  readonly far: number;
  readonly positional: boolean;
}

export interface VoiceEngine {
  /** The microphone's state ('unavailable' with no device connected). */
  mic(): string;
  /** Ask for the microphone. */
  start(): void;
  stop(): void;
  /** Whether a player is talking now (this player: transmitting and audible). */
  talking(player: string): boolean;
  /** Whether this player's voice is being sent now. */
  readonly transmitting: boolean;
  mute(player: string, muted: boolean): void;
  muted(player: string): boolean;
  selfMuted: boolean;
  volume: number;
  /** How a peer is heard right now (tests, debug views). */
  playback(player: string): VoicePlayback | undefined;
}

export interface VoicePlugin extends KernelPlugin {
  readonly engine: VoiceEngine;
  /** The platform's device (boot connects it; none: voice is unavailable). */
  connect(device: VoiceDevice): void;
}

interface ViewLike {
  readonly seat: number;
  readonly active: boolean;
  readonly position: Vec3;
  readonly rotation: Quat;
}

export function voice(options: VoiceOptions): VoicePlugin {
  if (!(VOICE_MODES as readonly string[]).includes(options.mode)) {
    fail('PP3460', `voice(mode=${JSON.stringify(options.mode)}) is not a mode`, { fix: `Modes: ${VOICE_MODES.join(', ')}.` });
  }
  if (options.mode === 'push_to_talk' && (options.talk === null || options.talk === undefined)) {
    fail('PP3460', 'voice(mode="push_to_talk") needs talk=, the action that is held to talk', { fix: 'Pass talk=Controls.talk (a button bound to e.g. KeyV), or use mode="voice_activity".' });
  }
  if (!(options.threshold > 0 && options.threshold < 1)) fail('PP3460', `voice(threshold=${options.threshold}) must be between 0 and 1`);
  if (!(options.hangover >= 0)) fail('PP3460', `voice(hangover=${options.hangover}) can't be negative`);
  if (!(options.near > 0 && options.far > options.near)) fail('PP3460', `voice(near=${options.near}, far=${options.far}): need 0 < near < far`);

  let device: VoiceDevice | undefined;
  let installed: Kernel | undefined;
  const mutes = new Set<string>();
  const linked = new Set<string>();
  const heard = new Map<string, VoicePlayback>();
  let transmitting = false;
  let lastVoice = -Infinity;
  let selfMuted = false;
  let volume = 1;

  const kernelOf = (): Kernel => {
    if (installed === undefined) fail('PP9460', 'voice is used before its kernel was built');
    return installed;
  };

  /** This machine's player: its seat index and id (single player: seat 0). */
  const me = (kernel: Kernel): { seat: number; id: string } | null => {
    const seats = kernel.tryService(PLAYERS_SERVICE)?.seats();
    if (seats === undefined) return { seat: 0, id: 'player-0' };
    const local = seats.find((s) => s.local);
    return local === undefined ? null : { seat: local.index, id: local.id };
  };

  const relay = (kernel: Kernel): void => {
    const channels = kernel.tryService(CHANNELS_SERVICE);
    if (channels === undefined) return;
    const self = me(kernel);
    const seats = kernel.tryService(PLAYERS_SERVICE)?.seats() ?? [];
    for (const message of channels.receive(TOPIC)) {
      const p = message.payload as JsonObject | null;
      if (typeof p !== 'object' || p === null || typeof p['payload'] !== 'string') continue;
      if (channels.role === 'server' && typeof message.from === 'number' && typeof p['to'] === 'string') {
        const from = seats.find((s) => s.index === message.from);
        const to = seats.find((s) => s.id === p['to']);
        if (from === undefined || to === undefined) continue;
        if (self !== null && to.id === self.id) device?.receiveSignal({ peer: from.id, payload: p['payload'] });
        else channels.send(TOPIC, { from: from.id, payload: p['payload'] }, to.index);
      } else if (channels.role === 'client' && message.from === 'server' && typeof p['from'] === 'string') {
        device?.receiveSignal({ peer: p['from'], payload: p['payload'] });
      }
    }
    if (device === undefined) return;
    for (const signal of device.takeSignals()) {
      if (channels.role === 'client') {
        channels.send(TOPIC, { to: signal.peer, payload: signal.payload });
      } else {
        const to = seats.find((s) => s.id === signal.peer);
        if (to !== undefined && self !== null) channels.send(TOPIC, { from: self.id, payload: signal.payload }, to.index);
      }
    }
  };

  /** Open links to every other player in play; close links to those who left. */
  const link = (kernel: Kernel): void => {
    if (device === undefined || kernel.tryService(CHANNELS_SERVICE) === undefined) return;
    const self = me(kernel);
    if (self === null) return;
    const others = new Set((kernel.tryService(PLAYERS_SERVICE)?.seats() ?? []).filter((s) => s.id !== self.id).map((s) => s.id));
    for (const id of others) {
      if (linked.has(id)) continue;
      linked.add(id);
      device.connect(id, self.id < id);
    }
    for (const id of [...linked]) {
      if (others.has(id)) continue;
      linked.delete(id);
      heard.delete(id);
      device.disconnect(id);
    }
  };

  const decideTransmit = (kernel: Kernel): void => {
    if (device === undefined) return;
    const self = me(kernel);
    let on = false;
    if (!selfMuted && device.mic === 'live' && self !== null) {
      if (options.mode === 'open') on = true;
      else if (options.mode === 'push_to_talk') on = kernel.service(ACTIONS_SERVICE).held(options.talk, self.seat, null);
      else {
        if (device.micLevel() > options.threshold) lastVoice = kernel.time.realNow;
        on = kernel.time.realNow - lastVoice <= options.hangover;
      }
    }
    if (on !== transmitting) device.transmit(on);
    transmitting = on;
  };

  const listener = (kernel: Kernel, seat: number): ViewLike | undefined => {
    for (const record of kernel.world.live()) {
      const view = (record.components.get('camera') as { __view__?: ViewLike } | undefined)?.__view__;
      if (view !== undefined && view.active && view.seat === seat) return view;
    }
    return undefined;
  };

  const master = (kernel: Kernel): number => {
    try {
      const v = kernel.resource('settings')['master_volume'];
      return typeof v === 'number' ? v : 1;
    } catch {
      // A kernel built without the api's Settings (plugin tests) has no master volume.
      return 1;
    }
  };

  const spatial = (at: Vec3, view: ViewLike): { attenuation: number; pan: number } => {
    const offset = at.__sub__(view.position);
    const distance = offset.length();
    let attenuation = distance <= options.near ? 1 : options.near / distance;
    const fadeFrom = options.far - (options.far - options.near) / 4;
    if (distance >= options.far) attenuation = 0;
    else if (distance > fadeFrom) attenuation *= (options.far - distance) / (options.far - fadeFrom);
    const right = view.rotation.rotate(new Vec3(1, 0, 0));
    const ease = Math.min(1, distance / options.near);
    const pan = distance > 0 ? Math.max(-1, Math.min(1, (offset.dot(right) / distance) * ease)) : 0;
    return { attenuation, pan };
  };

  const play = (kernel: Kernel): void => {
    if (device === undefined) return;
    const self = me(kernel);
    const players = kernel.tryService(PLAYERS_SERVICE);
    const view = self === null ? undefined : listener(kernel, self.seat);
    const gainScale = volume * master(kernel);
    for (const peer of device.peers()) {
      if (peer.state !== 'open') continue;
      let attenuation = 1;
      let pan = 0;
      const seat = players?.seats().find((s) => s.id === peer.id);
      const entity = seat === undefined ? null : players!.entity(seat.index);
      const record = entity === null ? undefined : kernel.world.get(entity);
      if (options.positional && record !== undefined && view !== undefined) {
        ({ attenuation, pan } = spatial(record.transform.worldPosition(), view));
      }
      const playback: VoicePlayback = { gain: mutes.has(peer.id) ? 0 : attenuation * gainScale, pan };
      heard.set(peer.id, playback);
      device.play(peer.id, playback);
    }
  };

  const engine: VoiceEngine = {
    mic: () => device?.mic ?? 'unavailable',
    start() { device?.openMic(); },
    stop() {
      device?.closeMic();
    },
    talking(player) {
      const kernel = kernelOf();
      if (device === undefined) return false;
      if (player === me(kernel)?.id) return transmitting && device.micLevel() > options.threshold;
      return !mutes.has(player) && (device.peers().find((p) => p.id === player)?.level ?? 0) > options.threshold;
    },
    get transmitting() { return transmitting; },
    mute(player, muted) {
      if (muted) mutes.add(player);
      else mutes.delete(player);
    },
    muted: (player) => mutes.has(player),
    get selfMuted() { return selfMuted; },
    set selfMuted(value: boolean) { selfMuted = value; },
    get volume() { return volume; },
    set volume(value: number) {
      if (!(value >= 0 && value <= 1)) fail('PP3461', `voice volume must be from 0 to 1, got ${value}`);
      volume = value;
    },
    playback: (player) => heard.get(player),
  };

  return {
    id: 'voice',
    engine,
    connect(next) {
      device = next;
    },
    install(kernel) {
      if (installed !== undefined) fail('PP3460', 'This voice plugin is already installed in another kernel', { fix: 'Call voice() once per game.' });
      installed = kernel;
      kernel.addHook('input', () => {
        link(kernel);
        relay(kernel);
        decideTransmit(kernel);
      });
      kernel.addHook('render', () => play(kernel));
    },
    snapshot: (): Json => ({ mutes: [...mutes].sort(), self_muted: selfMuted, volume }),
    restore(_kernel, state) {
      const s = state as JsonObject;
      mutes.clear();
      for (const m of s['mutes'] as string[]) mutes.add(m);
      selfMuted = s['self_muted'] === true;
      volume = s['volume'] as number;
    },
  };
}
