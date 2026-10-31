/**
 * `parallax.voice` (sdk/parallax/voice.pyi): `VoiceApi` (the type of `ctx.voice`) and the
 * `voice()` factory `parallax.plugins` re-exports. Links, transmission and positional
 * playback live in the voice plugin; boot connects the platform's device (`connectVoice`).
 */

import { bindArgs, fail } from '../core/index.js';
import type { VoiceDevice } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { VOICE_MODES, voice as voicePlugin } from '../function/plugins/voice/index.js';
import type { VoiceEngine, VoiceMode, VoicePlugin } from '../function/plugins/voice/index.js';
import type { Player } from './context.js';

function playerId(value: unknown, where: string): string {
  if (typeof value === 'object' && value !== null && typeof (value as Player).id === 'string') return (value as Player).id;
  return fail('PP3461', `${where} takes a Player, got ${value === null || value === undefined ? 'None' : String(value)}`);
}

/** `ctx.voice`: the microphone, who is talking, mutes and volume. */
export class VoiceApi {
  readonly #engine: VoiceEngine;

  constructor(engine: VoiceEngine) {
    this.#engine = engine;
  }

  /** "off", "requesting", "live", "denied" or "unavailable". */
  get mic(): string { return this.#engine.mic(); }
  /** Ask for the microphone (from a click or key press: browsers ask the player then). */
  start(): void { this.#engine.start(); }
  stop(): void { this.#engine.stop(); }
  /** This player's voice is being sent now. */
  get transmitting(): boolean { return this.#engine.transmitting; }

  /** Whether `player` is talking now (for talking indicators). */
  talking(...args: unknown[]): boolean {
    const a = bindArgs('talking', args, { positional: ['player'], required: ['player'] }).args;
    return this.#engine.talking(playerId(a['player'], 'talking()'));
  }

  /** `mute(player, muted=True)`: stop hearing a player (on this machine only). */
  mute(...args: unknown[]): void {
    const a = bindArgs('mute', args, { positional: ['player', 'muted'], required: ['player'] }).args;
    this.#engine.mute(playerId(a['player'], 'mute()'), a['muted'] === undefined ? true : a['muted'] === true);
  }

  muted(...args: unknown[]): boolean {
    const a = bindArgs('muted', args, { positional: ['player'], required: ['player'] }).args;
    return this.#engine.muted(playerId(a['player'], 'muted()'));
  }

  /** Stop sending this player's voice (the push-to-talk key and voice activity are ignored). */
  get self_muted(): boolean { return this.#engine.selfMuted; }
  set self_muted(value: boolean) {
    if (typeof value !== 'boolean') fail('PP3461', `voice.self_muted must be True or False, got ${String(value)}`);
    this.#engine.selfMuted = value;
  }

  /** 0..1: how loud other players are (times the Settings master volume). */
  get volume(): number { return this.#engine.volume; }
  set volume(value: number) { this.#engine.volume = value; }
}

/**
 * `parallax.plugins.voice(*, mode="push_to_talk", talk=None, threshold=0.08, hangover=0.3,
 * near=2, far=25, positional=True)`.
 */
export function voice(...args: unknown[]): KernelPlugin {
  const a = bindArgs('voice', args, { keyword: ['mode', 'talk', 'threshold', 'hangover', 'near', 'far', 'positional'] }).args;
  const mode = a['mode'] ?? 'push_to_talk';
  if (typeof mode !== 'string' || !(VOICE_MODES as readonly string[]).includes(mode)) {
    fail('PP3460', `voice(mode=${String(mode)}) is not a mode`, { fix: `Modes: ${VOICE_MODES.join(', ')}.` });
  }
  const num = (name: string, fallback: number): number => {
    const v = a[name] ?? fallback;
    if (typeof v !== 'number') fail('PP3460', `voice(${name}=...) must be a number, got ${String(v)}`);
    return v;
  };
  const positional = a['positional'] ?? true;
  if (typeof positional !== 'boolean') fail('PP3460', 'voice(positional=...) must be True or False');
  const plugin = voicePlugin({
    mode: mode as VoiceMode, talk: a['talk'] ?? null, threshold: num('threshold', 0.08), hangover: num('hangover', 0.3),
    near: num('near', 2), far: num('far', 25), positional,
  });
  return Object.assign(plugin, { namespace: { name: 'voice', create: () => new VoiceApi(plugin.engine) } });
}

/** Boot: give the game's voice plugin (if it lists one) the platform's device. */
export function connectVoice(plugins: readonly KernelPlugin[], device: VoiceDevice): void {
  for (const p of plugins) if (p.id === 'voice') (p as VoicePlugin).connect(device);
}
