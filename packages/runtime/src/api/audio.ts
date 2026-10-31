/**
 * `ctx.audio` (sdk/parallax/__init__.pyi `AudioApi`): Python arguments bound and checked,
 * then handed to the audio plugin's engine. Audio is core — every game has it — so the
 * runtime builds the plugin itself with `audioPlugin(...)`; it is not in `Game(plugins=)`.
 *
 *     ctx.audio.play(Assets.sfx.boing, at=self.entity, volume=0.5)
 *     ctx.audio.music(Assets.music.shadow_rift, fade=2)
 *     ctx.audio.music(None)
 *     ctx.audio.play(Assets.sfx.captain_line, duck=True)   # the music dips under it
 *     ctx.audio.preload(Assets.sfx.boss_roar, Assets.sfx.boss_stomp)   # a bank, before the fight
 *     ctx.audio.unload(Assets.sfx.boss_roar, Assets.sfx.boss_stomp)    # after it
 *     ctx.audio.play(Synth.hit_metal, at=hit.point)          # a built-in synthesized sound
 *     ctx.audio.music(Assets.music.calm, bpm=96, layers=[MusicLayer(Assets.music.drums, at=0.5)])
 *     ctx.audio.set_intensity(0.8, fade=2)                   # the drums come in
 *     ctx.audio.play(Assets.sfx.sting, quantize="bar")       # lands on the next downbeat
 *
 *     @on(Beat)
 *     def pulse(self, ctx, e): ...                           # e.beat, e.bar, e.beat_in_bar
 *
 * The `AudioSource` component handle comes from the visuals module (it defines the
 * component); the audio plugin plays it. `AudioListener` and `ReverbZone` are the audio
 * plugin's own data components (handles below).
 */

import { fail, Vec2, Vec3 } from '../core/index.js';
import type { AudioOutput, EntityId } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { audio } from '../function/plugins/audio/index.js';
import type { AudioEngine, MusicLayerRequest, PlayRequest, SpatialOptions } from '../function/plugins/audio/index.js';
import type { ProjectFiles } from '../core/index.js';
import type { Project } from '../resource/index.js';
import { BEAT_EVENT, MIX_COMPONENTS, SYNTH_PRESET_NAMES } from '../function/plugins/audio/index.js';
import { eventHandle } from './events.js';
import { Player } from './context.js';
import { componentHandle } from './handles.js';
import { Entity } from './entity.js';
import { bindArgs } from './kwargs.js';
import { AssetRef, MusicRef, SoundRef } from './types.js';

function refPath(value: unknown, Ref: typeof SoundRef | typeof MusicRef, where: string): string {
  if (value instanceof Ref) return value.path;
  const wanted = Ref === SoundRef ? 'a sound (Assets.sfx.<name>)' : 'a music track (Assets.music.<name>)';
  if (value instanceof AssetRef) {
    const got = value instanceof MusicRef ? 'a music track' : value instanceof SoundRef ? 'a sound' : `the asset "${value.path}"`;
    return fail('PP3500', `${where} takes ${wanted}, got ${got}`, {
      fix: Ref === SoundRef ? 'Music plays through ctx.audio.music(...).' : 'Sound effects play through ctx.audio.play(...).',
    });
  }
  if (value === null || value === undefined) {
    return fail('PP3500', `${where} needs ${wanted}, got None`, {
      fix: 'Guard optional sounds: `if item.sound: ctx.audio.play(item.sound)`.',
    });
  }
  return fail('PP3500', `${where} takes ${wanted}, got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`, {
    fix: `Use the generated handle: \`from project import Assets\`, then ${Ref === SoundRef ? 'Assets.sfx.<name>' : 'Assets.music.<name>'}.`,
  });
}

function position(value: unknown, where: string): Vec3 | Vec2 | EntityId | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Vec3 || value instanceof Vec2) return value;
  if (value instanceof Entity) return value.__entity_id__;
  return fail('PP3502', `${where} at= must be a Vec3, a Vec2 or an Entity, got ${String(value)}`, {
    fix: 'Pass a position (`at=hit.point`) or an entity (`at=self.entity`).',
  });
}

function bankPath(value: unknown, where: string): string {
  return value instanceof MusicRef ? refPath(value, MusicRef, where) : refPath(value, SoundRef, where);
}

/** Data components of the audio plugin (placed in prefabs and scenes; read and set from code). */
export const AudioListener = componentHandle(MIX_COMPONENTS[0]!, 'AudioListener');
export const ReverbZone = componentHandle(MIX_COMPONENTS[1]!, 'ReverbZone');

/** `@on(Beat)`: beat, bar, beat_in_bar (whole, 0-based) — the beat clock passed a beat. */
export const Beat = eventHandle(BEAT_EVENT, 'Beat');

/** `Synth.<name>`: the built-in synthesized sounds, played like any `Assets.sfx.*` (no file). */
export const Synth: Readonly<Record<string, SoundRef>> = Object.freeze(Object.fromEntries(
  SYNTH_PRESET_NAMES.map((name) => [name, new SoundRef(`synth/${name}`)]),
));

/** `MusicLayer(track, at=0.5, volume=1)`: a stem of layered music, heard once the intensity reaches `at`. */
export class MusicLayer {
  readonly track: MusicRef;
  readonly at: number;
  readonly volume: number;

  constructor(...args: unknown[]) {
    const a = bindArgs('MusicLayer', args, { positional: ['track', 'at'], keyword: ['volume'], required: ['track'] }).args;
    refPath(a['track'], MusicRef, 'MusicLayer()');
    this.track = a['track'] as MusicRef;
    const at = a['at'] ?? 0.5;
    if (typeof at !== 'number' || !(at >= 0 && at <= 1)) fail('PP3516', `MusicLayer at= must be an intensity 0..1, got ${String(at)}`, { fix: 'e.g. MusicLayer(Assets.music.drums, at=0.4).' });
    const volume = a['volume'] ?? 1;
    if (typeof volume !== 'number' || !(volume >= 0)) fail('PP3501', `MusicLayer volume must be a number >= 0, got ${String(volume)}`);
    this.at = at;
    this.volume = volume;
  }
}

/** `quantize=`: "beat", "bar", or a number of beats. */
function division(value: unknown, engine: AudioEngine, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (value === 'beat') return 1;
  if (value === 'bar') return engine.beatsPerBar ?? 4;
  if (typeof value === 'number' && value > 0 && Number.isFinite(value)) return value;
  return fail('PP3514', `${where} quantize= must be "beat", "bar" or a number of beats above 0, got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`, {
    fix: 'e.g. quantize="bar" (the next downbeat) or quantize=0.5 (the next half beat).',
  });
}

export class AudioApi {
  readonly #engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.#engine = engine;
  }

  /**
   * One-shot sound. Volume multiplies the default in assets/audio.json (and pitch its
   * pitch). `at=` makes it positional (a point, or an entity's position now).
   */
  play(...args: unknown[]): void {
    const a = bindArgs('audio.play', args, {
      positional: ['sound'], keyword: ['at', 'volume', 'pitch', 'to', 'duck', 'quantize'], required: ['sound'],
    }).args;
    // Absent: audio.json's "duck" for the sound decides.
    const duck = a['duck'];
    if (duck !== undefined && typeof duck !== 'boolean') fail('PP3511', `audio.play duck= must be True or False, got ${String(duck)}`);
    const to = a['to'];
    if (to !== undefined && to !== null && !(to instanceof Player)) {
      fail('PP3508', `audio.play to= must be a Player, got ${String(to)}`, { fix: 'Pass a player from ctx.players, or leave to= out for everyone.' });
    }
    const request: PlayRequest = {
      sound: refPath(a['sound'], SoundRef, 'audio.play()'),
      at: position(a['at'], 'audio.play()'),
      volume: (a['volume'] ?? 1) as number,
      pitch: (a['pitch'] ?? 1) as number,
      to: to instanceof Player ? to.id : null,
      duck,
      quantize: division(a['quantize'], this.#engine, 'audio.play()'),
    };
    this.#engine.play(request);
  }

  /** Play surface materials' impact sounds (physics `material(sound=...)`); False: the game plays its own. */
  get impact_sounds(): boolean {
    return this.#engine.impactSounds;
  }

  set impact_sounds(on: unknown) {
    if (typeof on !== 'boolean') fail('PP3511', `audio.impact_sounds must be True or False, got ${String(on)}`);
    this.#engine.impactSounds = on;
  }

  /** Fetch and decode these sounds ahead (one bank: a level's or a fight's sounds). */
  preload(...args: unknown[]): void {
    this.#engine.preload(this.#group(args, 'preload'));
  }

  /** Free these sounds' decoded audio until they play again. */
  unload(...args: unknown[]): void {
    this.#engine.unload(this.#group(args, 'unload'));
  }

  /** `preload(*sounds, bank=None)`: the named sounds plus every sound of the audio.json bank. */
  #group(args: readonly unknown[], name: string): string[] {
    const a = bindArgs(`audio.${name}`, args, { keyword: ['bank'], rest: true });
    const where = `audio.${name}()`;
    const bank = a.args['bank'] ?? null;
    if (bank !== null && typeof bank !== 'string') fail('PP3512', `${where} bank= must be a str, got ${String(bank)}`);
    return [...a.rest.map((s) => bankPath(s, where)), ...(bank === null ? [] : this.#engine.bankSounds(bank, where))];
  }

  /**
   * Override the scene's "music" until the next scene load (None fades out). `layers=` adds
   * stems by intensity; `bpm=` starts the beat clock with the track.
   */
  music(...args: unknown[]): void {
    const a = bindArgs('audio.music', args, {
      positional: ['track'], keyword: ['fade', 'volume', 'layers', 'bpm', 'beats_per_bar', 'offset'], required: ['track'],
    }).args;
    const track = a['track'] === null ? null : refPath(a['track'], MusicRef, 'audio.music()');
    const given = a['layers'] ?? [];
    const list = Array.isArray(given) ? given : typeof given === 'object' && given !== null && Symbol.iterator in given ? [...(given as Iterable<unknown>)] : null;
    if (list === null) fail('PP3516', 'audio.music() layers= must be a list of MusicLayer', { fix: 'e.g. layers=[MusicLayer(Assets.music.drums, at=0.4)].' });
    const layers: MusicLayerRequest[] = list.map((layer, i) => {
      if (!(layer instanceof MusicLayer)) fail('PP3516', `audio.music() layers[${i}] must be a MusicLayer, got ${String(layer)}`, { fix: 'Wrap each stem: MusicLayer(Assets.music.drums, at=0.4).' });
      return { track: layer.track.path, at: layer.at, volume: layer.volume };
    });
    const bpm = a['bpm'] ?? null;
    if (bpm !== null && typeof bpm !== 'number') fail('PP3514', `audio.music() bpm= must be a number, got ${String(bpm)}`);
    this.#engine.music(track, (a['fade'] ?? 1) as number, {
      layers, bpm, beatsPerBar: (a['beats_per_bar'] ?? 4) as number, offset: (a['offset'] ?? 0) as number, volume: (a['volume'] ?? 1) as number,
    });
  }

  /** `set_group(name, *, volume=None, mute=None)`: a mix group's level (audio.json `"group"`), for every sound in it. */
  set_group(...args: unknown[]): void {
    const a = bindArgs('audio.set_group', args, { positional: ['name'], keyword: ['volume', 'mute'], required: ['name'] }).args;
    if (typeof a['name'] !== 'string') fail('PP3517', `audio.set_group() name must be a str, got ${String(a['name'])}`);
    const mute = a['mute'] ?? undefined;
    if (mute !== undefined && typeof mute !== 'boolean') fail('PP3517', `audio.set_group() mute= must be True or False, got ${String(mute)}`);
    const volume = a['volume'] ?? undefined;
    if (volume !== undefined && typeof volume !== 'number') fail('PP3517', `audio.set_group() volume= must be a number, got ${String(volume)}`);
    this.#engine.setGroup(a['name'], volume as number | undefined, mute as boolean | undefined);
  }

  /** `group_volume(name) -> float`: the group's volume as set (1 by default; muting doesn't change it). */
  group_volume(...args: unknown[]): number {
    const a = bindArgs('audio.group_volume', args, { positional: ['name'], required: ['name'] }).args;
    return this.#engine.group(String(a['name'])).volume;
  }

  /** `group_muted(name) -> bool`. */
  group_muted(...args: unknown[]): boolean {
    const a = bindArgs('audio.group_muted', args, { positional: ['name'], required: ['name'] }).args;
    return this.#engine.group(String(a['name'])).muted;
  }

  /** The music's intensity, 0..1 (which layers are heard). */
  get intensity(): number {
    return this.#engine.intensity;
  }

  set intensity(value: unknown) {
    this.#engine.setIntensity(value as number, 1);
  }

  /** `set_intensity(value, fade=1)`: layers it turns on or off fade over `fade` seconds. */
  set_intensity(...args: unknown[]): void {
    const a = bindArgs('audio.set_intensity', args, { positional: ['value'], keyword: ['fade'], required: ['value'] }).args;
    this.#engine.setIntensity(a['value'] as number, (a['fade'] ?? 1) as number);
  }

  /** `set_tempo(bpm, beats_per_bar=None)`: the clock's tempo from now (a clock at beat 0 now if none runs). */
  set_tempo(...args: unknown[]): void {
    const a = bindArgs('audio.set_tempo', args, { positional: ['bpm'], keyword: ['beats_per_bar'], required: ['bpm'] }).args;
    this.#engine.setTempo(a['bpm'] as number, (a['beats_per_bar'] ?? undefined) as number | undefined);
  }

  /** The beat clock: beat now (fractional), bar, tempo — None without a clock. */
  get beat(): number | null { return this.#engine.beat; }
  get bar(): number | null { return this.#engine.bar; }
  get bpm(): number | null { return this.#engine.bpm; }

  /** Seconds until the next "beat", "bar" or n-beat boundary. */
  time_to(...args: unknown[]): number {
    const a = bindArgs('audio.time_to', args, { positional: ['grid'], required: ['grid'] }).args;
    return this.#engine.timeTo(division(a['grid'], this.#engine, 'audio.time_to()')!, 'audio.time_to()');
  }

  /** Synthesize the world's ambience: rain, wind, thunder, water (default True). */
  get ambience(): boolean {
    return this.#engine.ambience;
  }

  set ambience(on: unknown) {
    if (typeof on !== 'boolean') fail('PP3511', `audio.ambience must be True or False, got ${String(on)}`);
    this.#engine.ambience = on;
  }

  /** Voices heard at once (default 32): the strongest win, by audio.json priority, then loudness. */
  get max_voices(): number {
    return this.#engine.maxVoices;
  }

  set max_voices(n: unknown) {
    this.#engine.maxVoices = n as number;
  }
}

export interface AudioPluginOptions {
  readonly output: AudioOutput;
  readonly project: Project;
  /** `ProjectFiles.list()`, or null when the asset files aren't available (data-only playtests). */
  readonly assets: readonly string[] | null;
  /** Whether hosted sound URLs are fetched (a browser). */
  readonly remoteAssets?: boolean;
  readonly seed: number;
  readonly mode: '2d' | '3d';
  readonly spatial?: SpatialOptions;
  /** The active camera's entity (visuals); default: the first live camera. */
  readonly listener?: (kernel: Kernel) => EntityId | null;
  /** The project's files (`.synth.json` sounds). */
  readonly files?: ProjectFiles;
  /** Whether the game is paused (a modal panel froze time, not a hitstop): the music holds. */
  readonly paused?: (kernel: Kernel) => boolean;
}

/** The core audio plugin with `ctx.audio` as game code sees it. Built by the runtime. */
export function audioPlugin(options: AudioPluginOptions): KernelPlugin & { readonly engine: AudioEngine } {
  return audio({
    output: options.output,
    assets: options.assets,
    ...(options.remoteAssets !== undefined && { remoteAssets: options.remoteAssets }),
    defaults: options.project.audio,
    seed: options.seed,
    mode: options.mode,
    ...(options.spatial !== undefined && { spatial: options.spatial }),
    ...(options.listener !== undefined && { listener: options.listener }),
    ...(options.files !== undefined && { files: options.files }),
    ...(options.paused !== undefined && { paused: options.paused }),
    namespace: (engine) => new AudioApi(engine),
  });
}
