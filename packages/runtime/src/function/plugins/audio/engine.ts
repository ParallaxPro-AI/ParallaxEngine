/**
 * The audio engine: one per kernel. It turns what the game asks for into one `AudioFrame`
 * per frame for the output port:
 *
 *   one-shots   `ctx.audio.play` — checked, levels drawn and position resolved at the call;
 *               panned against the listener when the frame is sent (after the UI phase).
 *   music       the scene's "music", or `ctx.audio.music(...)`'s override until the next
 *               scene load; a change crossfades, the same track keeps playing.
 *   sources     every entity's `audio_source` component, derived each frame: a voice
 *               plays while the component exists and `playing` is true. A looping one
 *               follows its entity (position, volume, pitch); a non-looping one plays once
 *               per false→true of `playing`. While game time is frozen (pause, hitstop)
 *               entity voices are muted; one-shots continue.
 *   pause       while the game is paused (a modal panel froze time; not a hitstop) the music
 *               is held where it is and resumes from there, its beat clock with it — unless
 *               the track's audio.json entry says `"pauses": false` (a pause-menu-safe bed)
 *   buses       Settings master/music/sfx volumes, sent when they change.
 *   mix         the listener's `audio_listener` (HRTF, Doppler, occlusion, ducking) and the
 *               `reverb_zone` it stands in (mix.ts), sent when it changes
 *   plugins     other plugins' one-shots and named loops (AUDIO_SERVICE: thunder, rain,
 *               splashes): like ctx.audio.play, but never forwarded to net clients; loops
 *               are in snapshots
 *   banks       `ctx.audio.preload` / `unload`: groups of sounds fetched ahead, or freed
 *   impacts     a physics `impact` event whose material has a `sound` plays it at the
 *               contact point, louder the faster the surfaces closed (IMPACT_FULL_SPEED),
 *               at most IMPACT_LIMIT of one sound per IMPACT_WINDOW seconds (a collapsing
 *               pile is a few clatters, not a hundred); `ctx.audio.impact_sounds = False`
 *               turns it off for games that play their own
 *   synth       sounds described as data (`synth/<preset>`, `.synth.json` files: synths.ts)
 *               travel as `AudioSound.synth`; the output renders them
 *   layers      `ctx.audio.music(..., layers=)`: stems sample-locked with the track, each
 *               heard once `ctx.audio.intensity` reaches its threshold (stems.ts)
 *   clock       `ctx.audio.music(..., bpm=)` / `set_tempo`: a beat clock on the audio's time
 *               (transport.ts): the `beat` event each beat, `play(quantize=)` on the grid
 *   voices      at most `max_voices` heard at once, by priority and loudness (voices.ts)
 *   ambience    synthesized rain, wind, thunder and water from the weather, wind and water
 *               plugins' services (ambience.ts); `ctx.audio.ambience = False` silences it
 *
 * Everything that decides what is heard is deterministic: levels vary through the
 * plugin's own seeded random source, which snapshots save. In-flight one-shots are not
 * part of a snapshot (they are fire-and-forget); a restore stops every voice and rebuilds
 * the entity voices and the music from the restored state.
 */

import { closestMatch, fail, SeededRandom, synthSeconds, Vec2, Vec3 } from '../../../core/index.js';
import type {
  AudioBuses, AudioCommand, AudioListener, AudioMix, AudioOutput, AudioPosition, AudioSound, EntityId, ProjectFiles, RandomState,
} from '../../../core/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import type { AudioService, PluginSound } from '../../services/index.js';
import type { AudioDefaults, Json } from '../../../resource/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import { AudioCatalog } from './catalog.js';
import { AudioDefaultsTable } from './defaults.js';
import { AMBIENCE_KEYS, ambienceLoops, sceneWeatherSounds, thunderClap } from './ambience.js';
import type { WeatherSounds } from './ambience.js';
import { layerGains, rampGain } from './stems.js';
import type { StemLayer } from './stems.js';
import { loadSynths } from './synths.js';
import { barOf, beatAtTime, bpmAt, changeTempo, collectBeats, MAX_BPM, MIN_BPM, nextBoundary, tempoMap } from './transport.js';
import type { TempoMap } from './transport.js';
import { DEFAULT_MAX_VOICES, DEFAULT_PRIORITY, ONE_SHOT_SECONDS, VoiceBudget } from './voices.js';
import type { Contender, VoiceStats } from './voices.js';
import { CENTERED, listenerAt, position, spatialize } from './spatial.js';
import {
  AUDIO_LISTENER, DEFAULT_LISTENER, dopplerFactor, listenerSettings, NEUTRAL_MIX, OCCLUSION_EVERY, occlusionBetween, REVERB_ZONE, reverbAt,
} from './mix.js';
import type { ListenerSettings, Zone } from './mix.js';
import type { SpatialOptions } from './spatial.js';

/** Read by id; the component itself is defined by the visuals plugin (SDK field names). */
export const AUDIO_SOURCE = 'audio_source';
/** The listener is the first live camera unless `listener` says otherwise. */
export const CAMERA = 'camera';
export const SETTINGS = 'settings';

/** The scene's music crossfades over this when a scene load changes it. */
export const SCENE_MUSIC_FADE = 1;
/** Entity voices stop over this (a cut would click). */
const SOURCE_STOP_FADE = 0.05;
/** Closing speed (m/s) at which an impact sound plays at full volume; slower ones scale down to IMPACT_MIN. */
export const IMPACT_FULL_SPEED = 8;
const IMPACT_MIN = 0.15;
/** At most this many impact sounds of one sound start within IMPACT_WINDOW game seconds. */
export const IMPACT_LIMIT = 3;
export const IMPACT_WINDOW = 0.1;
/** Ambience loops fade in and out over this. */
const AMBIENCE_FADE = 1;
/** Ambience gives way to the game's own sounds in the voice budget. */
const AMBIENCE_PRIORITY = 40;
/** At most this many `beat` events in one frame (a hitch must not flood the game). */
const BEATS_PER_FRAME = 8;
/** A stolen one-shot stops over this. */
const STEAL_FADE = 0.02;

/** The `beat` event: the beat clock passed a whole beat (beat, bar, beat_in_bar; 0-based). */
export const BEAT_EVENT = { id: 'beat' } as const;
/** The weather plugin's event, by id. */
export const THUNDER_EVENT = 'thunder';

/** One stem of layered music, as `ctx.audio.music(layers=...)` gives it. */
export interface MusicLayerRequest {
  /** As written: `music/drums` or a MusicRef's path. */
  readonly track: string;
  /** Heard once the intensity reaches this (0..1). */
  readonly at: number;
  /** × its audio.json volume (default 1). */
  readonly volume?: number;
}

/** `ctx.audio.music`'s options beyond the track and fade. */
export interface MusicOptions {
  readonly layers?: readonly MusicLayerRequest[];
  /** Start a beat clock with the track: its tempo, meter, and where its beat 0 is (seconds into it). */
  readonly bpm?: number | null;
  readonly beatsPerBar?: number;
  readonly offset?: number;
  /** × the track's audio.json volume (default 1). */
  readonly volume?: number;
}

export interface PlayRequest {
  /** As written: a handle (`sfx/hit`, `synth/zap`, a SoundRef's path) or a hosted URL. */
  readonly sound: string;
  /** A world point, an entity (its position now), or null for a non-positional sound. */
  readonly at: Vec3 | Vec2 | EntityId | null;
  readonly volume: number;
  readonly pitch: number;
  /** Player id (`to=`), or null for everyone. */
  readonly to: string | null;
  /** Duck the music while it plays (dialogue, announcer lines). Default false. */
  readonly duck?: boolean;
  /** Start on the next boundary of a grid of this many beats (the beat clock); absent: now. */
  readonly quantize?: number | null;
}

export interface AudioEngineOptions {
  readonly output: AudioOutput;
  readonly assets: readonly string[] | null;
  /** Whether hosted sound URLs are fetched (a browser); default false: they play silently. */
  readonly remoteAssets?: boolean;
  /** The project's assets/audio.json (`Project.audio`). */
  readonly defaults: ReadonlyMap<string, AudioDefaults>;
  readonly seed: number;
  readonly mode: '2d' | '3d';
  readonly spatial: SpatialOptions;
  readonly listener: ((kernel: Kernel) => EntityId | null) | undefined;
  /** The project's files: `.synth.json` sounds are read from them. */
  readonly files?: ProjectFiles;
  /** Whether the game is paused now (music holds). Default: never. */
  readonly paused?: (kernel: Kernel) => boolean;
}

/**
 * A one-shot as a server forwards it to clients (DESIGN §6.5: `ctx.audio.play` on the server
 * reaches the relevant clients): the sound's handle, where (resolved to a point now, so an
 * entity the client doesn't have still places it), the call's volume and pitch (each client
 * draws its own variation from audio.json), and the recipient player id (null: everyone).
 */
export interface ForwardedSound {
  readonly sound: string;
  readonly at: Vec3 | null;
  readonly volume: number;
  readonly pitch: number;
  readonly to: string | null;
}

interface PendingShot {
  readonly voice: number;
  readonly sound: AudioSound;
  readonly bus: 'sfx' | 'music';
  readonly volume: number;
  readonly pitch: number;
  readonly position: Vec3 | null;
  readonly to: string | null;
  readonly duck: boolean;
  /** Seconds after this frame's time to start (quantized). */
  readonly delay: number;
}

/** The listener this frame: where, its axes, its settings, and its entity (rays ignore it). */
interface Hearing {
  readonly listener: AudioListener;
  readonly at: Vec3;
  readonly id: EntityId;
  readonly settings: ListenerSettings;
}

interface SourceState {
  voice: number | null;
  /** Handle of the sound the voice plays. */
  sound: string;
  loop: boolean;
  /** A non-looping source already played for this `playing` = true. */
  fired: boolean;
  /**
   * The voice was playing when a snapshot it is restored from was taken: restart it with
   * the levels drawn then, without drawing again.
   */
  resume: boolean;
  /** audio.json levels drawn when the voice started. */
  volumeFactor: number;
  pitchFactor: number;
  /** Last update sent, to send only changes. */
  sent: string;
  /** World position last frame (Doppler); undefined before the first. */
  before: Vec3 | undefined;
  occlusion: number;
  /** Volume × attenuation as heard before the voice budget (its rank next frame). */
  audibility: number;
}

/** A plugin's loop (AUDIO_SERVICE.loop): what it asked for, and its voice. */
interface PluginLoop {
  voice: number | null;
  sound: string;
  bus: 'sfx' | 'music';
  volume: number;
  pitch: number;
  at: Vec3 | null;
  /** audio.json levels drawn when the voice started. */
  volumeFactor: number;
  pitchFactor: number;
  /** Last update sent. */
  sent: string;
  audibility: number;
}

/** A plugin loop stops over this unless `stop` says otherwise. */
const LOOP_STOP_FADE = 0.5;

/** A stem as the engine keeps it: its handle, threshold and call volume. */
interface Layer {
  readonly track: string;
  readonly at: number;
  readonly volume: number;
}

interface Override {
  readonly track: string | null;
  readonly fade: number;
  readonly layers: readonly Layer[];
  /** × the track's audio.json volume (absent in older snapshots: 1). */
  readonly volume?: number;
}

interface Music {
  /** The scene's "music" handle. */
  scene: string | null;
  /** The scene's "music_volume" (× the track's audio.json volume). */
  sceneVolume: number;
  /** `ctx.audio.music(...)` since the scene loaded. */
  override: Override | null;
  /** What the output was last told (track and layers). Undefined: tell it again (start, restore). */
  current: string | null | undefined;
  /** The current layers' gains as last sent, and when (the ramp the output plays). */
  gains: { from: number[]; to: number[]; start: number; fade: number; layerVolumes: number[] } | null;
}

/** The beat clock and the next whole beat its `beat` event fires for. */
interface Clock {
  map: TempoMap;
  next: number;
}

/** The plugin's snapshot state. */
interface AudioState {
  readonly random: RandomState;
  readonly nextVoice: number;
  readonly music: { readonly scene: string | null; readonly override: Override | null; readonly current: string | null; readonly sceneVolume?: number };
  /** Intensity and its fade; the beat clock as [beat now, bpm, beats per bar, next event beat] (absent in older snapshots). */
  readonly intensity?: readonly [number, number];
  readonly clock?: readonly [number, number, number, number] | null;
  readonly ambience?: boolean;
  readonly maxVoices?: number;
  readonly weatherSounds?: WeatherSounds;
  /** Mix groups set by `ctx.audio.set_group`: [name, volume, muted] (absent: none). */
  readonly groups?: ReadonlyArray<readonly [string, number, boolean]>;
  /** `ctx.audio.impact_sounds` (absent in older snapshots: on). */
  readonly impactSounds?: boolean;
  /** [entity, playing, fired, volumeFactor, pitchFactor] for every entity with an audio_source. */
  readonly sources: ReadonlyArray<readonly [number, boolean, boolean, number, number]>;
  /** Plugin loops: [key, sound, bus, volume, pitch, at or null, volumeFactor, pitchFactor] (absent in older snapshots). */
  readonly loops?: ReadonlyArray<readonly [string, string, 'sfx' | 'music', number, number, readonly [number, number, number] | null, number, number]>;
}

function finite(value: unknown, what: string, check: (n: number) => boolean, range: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !check(value)) {
    fail('PP3501', `${what} must be a number ${range}, got ${typeof value === 'number' ? value : JSON.stringify(value) ?? String(value)}`, {
      fix: `Pass a finite number ${range}.`,
    });
  }
  return value;
}

export function checkVolume(value: unknown, what: string): number {
  return finite(value, what, (n) => n >= 0, '>= 0 (1 = the audio.json default)');
}

export function checkPitch(value: unknown, what: string): number {
  return finite(value, what, (n) => n > 0, '> 0 (a playback-rate multiplier: 1 = unchanged)');
}

export function checkFade(value: unknown, what: string): number {
  return finite(value, what, (n) => n >= 0, '>= 0 (seconds)');
}

/** A stored ref (SoundRef object or its id string) as its written string. */
function writtenRef(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    const json = (value as { toJSON(): unknown }).toJSON();
    if (typeof json === 'string') return json;
  }
  return null;
}

export class AudioEngine implements AudioService {
  readonly kernel: Kernel;
  readonly catalog: AudioCatalog;
  readonly defaults: AudioDefaultsTable;
  readonly #output: AudioOutput;
  readonly #mode: '2d' | '3d';
  readonly #spatial: SpatialOptions;
  readonly #listenerOf: (kernel: Kernel) => EntityId | null;
  readonly #random: SeededRandom;
  #nextVoice = 1;
  #pending: PendingShot[] = [];
  #commands: AudioCommand[] = [];
  readonly #sources = new Map<EntityId, SourceState>();
  readonly #loops = new Map<string, PluginLoop>();
  readonly #music: Music = { scene: null, sceneVolume: 1, override: null, current: undefined, gains: null };
  #intensity = 0;
  #intensityFade = 1;
  #clock: Clock | null = null;
  readonly #voices = new VoiceBudget();
  /** Synthesize the world's ambience (`ctx.audio.ambience`). */
  ambience = true;
  /** What the scene's weather sounds already cover. */
  #weatherSounds: WeatherSounds = { rain: false, thunder: false };
  #buses: string | undefined;
  #mix: string = JSON.stringify(NEUTRAL_MIX);
  #listenerBefore: Vec3 | undefined;
  /** Play materials' impact sounds (`ctx.audio.impact_sounds`). */
  impactSounds = true;
  /** Game times of recent impact sounds, by handle (the voice limit). */
  readonly #impacts = new Map<string, number[]>();
  #forward: ((sound: ForwardedSound) => void) | null = null;
  readonly #pausedOf: (kernel: Kernel) => boolean;
  /** Mix groups changed by `ctx.audio.set_group` (absent: volume 1, not muted). */
  readonly #groups = new Map<string, { volume: number; muted: boolean }>();
  /** Whether the output holds the music now (as last told; a new track starts unpaused). */
  #musicHeld = false;
  /** Everything was stopped because logic is off (see #silence). */
  #silent = false;
  /** Real seconds the beat clock has been held for, and since when it is held now. */
  #heldTotal = 0;
  #heldSince: number | null = null;

  constructor(kernel: Kernel, options: AudioEngineOptions) {
    this.kernel = kernel;
    this.#output = options.output;
    this.#mode = options.mode;
    this.#spatial = options.spatial;
    this.#listenerOf = options.listener ?? firstCamera;
    this.#pausedOf = options.paused ?? (() => false);
    this.#random = new SeededRandom(options.seed);
    this.catalog = new AudioCatalog(options.assets, options.remoteAssets ?? false, loadSynths(options.files));
    this.defaults = new AudioDefaultsTable(options.defaults, this.catalog);

    const settings = kernel.registry.resources.get(SETTINGS);
    for (const name of ['master_volume', 'music_volume', 'sfx_volume']) {
      if (settings === undefined || !(name in settings.schema)) {
        fail('PP3505', `The audio plugin needs the "${SETTINGS}" resource with ${name}`, {
          fix: 'Build the kernel through the api layer (it declares Settings), or declare a "settings" resource with master_volume, music_volume and sfx_volume.',
        });
      }
    }
    this.#output.preload(this.catalog.files());
  }

  /** Fetch and decode these sounds now (a level's sounds before it starts: one bank). */
  preload(sounds: readonly string[], where = 'ctx.audio.preload'): void {
    const files = this.#bankFiles(sounds, where);
    if (files.length > 0) this.#output.preload(files);
  }

  /** Free these sounds' decoded audio; playing one later loads it again. */
  unload(sounds: readonly string[], where = 'ctx.audio.unload'): void {
    const files = this.#bankFiles(sounds, where);
    if (files.length > 0) this.#output.release(files);
  }

  /** The sounds audio.json puts in `bank` (PP3512 with a suggestion when no sound does). */
  bankSounds(bank: string, where: string): string[] {
    const sounds = this.defaults.bank(bank);
    if (sounds.length === 0) {
      const guess = closestMatch(bank, this.defaults.banks());
      fail('PP3512', `${where}: no sound in assets/audio.json is in bank "${bank}"`, {
        fix: guess === undefined ? 'Give sounds a "bank" in assets/audio.json.' : `Did you mean "${guess}"?`,
      });
    }
    return sounds;
  }

  #bankFiles(sounds: readonly string[], where: string): string[] {
    return sounds.flatMap((written) => {
      const folder = written.startsWith('music/') ? 'music' : 'sfx';
      const file = this.catalog.sound(written, folder, where).file;
      return file === null ? [] : [file];
    });
  }

  // ── Requests (ctx.audio) ───────────────────────────────────────────────────

  play(request: PlayRequest | PluginSound): void {
    // ctx.audio.play (a PlayRequest: `to` is always given) is forwarded to net clients; a plugin's sound is local.
    const game = 'to' in request;
    const where = game ? 'ctx.audio.play' : 'a plugin sound';
    const bus = game ? 'sfx' : request.bus ?? 'sfx';
    const sound = this.catalog.sound(request.sound, bus, where);
    const volume = checkVolume(request.volume ?? 1, `${where} volume`);
    const pitch = checkPitch(request.pitch ?? 1, `${where} pitch`);
    const at = this.#resolveAt(request.at ?? null, where);
    const to = game ? (request as PlayRequest).to : null;
    const quantize = game ? (request as PlayRequest).quantize ?? null : null;
    const delay = quantize === null ? 0 : this.#quantizedDelay(quantize, where);
    const drawn = this.defaults.draw(sound.handle, this.#random);
    if (game) this.#forward?.({ sound: sound.handle, at, volume, pitch, to });
    this.#pending.push({
      voice: this.#nextVoice++, sound, bus, volume: drawn.volume * volume, pitch: drawn.pitch * pitch, position: at, to,
      duck: (request.duck ?? this.defaults.get(sound.handle).duck) === true, delay,
    });
  }

  // ── Plugin loops (AUDIO_SERVICE) ───────────────────────────────────────────

  loop(key: string, request: PluginSound): void {
    const where = `the "${key}" loop`;
    const bus = request.bus ?? 'sfx';
    const sound = this.catalog.sound(request.sound, bus, where).handle;
    const volume = checkVolume(request.volume ?? 1, `${where} volume`);
    const pitch = checkPitch(request.pitch ?? 1, `${where} pitch`);
    const at = this.#resolveAt(request.at ?? null, where);
    const playing = this.#loops.get(key);
    if (playing !== undefined && playing.sound === sound && playing.bus === bus) {
      playing.volume = volume;
      playing.pitch = pitch;
      playing.at = at;
      return;
    }
    if (playing?.voice !== null && playing !== undefined) this.#commands.push({ kind: 'stop', voice: playing.voice, fade: SOURCE_STOP_FADE });
    const drawn = this.defaults.draw(sound, this.#random);
    this.#loops.set(key, { voice: null, sound, bus, volume, pitch, at, volumeFactor: drawn.volume, pitchFactor: drawn.pitch, sent: '', audibility: 0 });
  }

  stop(key: string, fade = LOOP_STOP_FADE): void {
    const playing = this.#loops.get(key);
    if (playing === undefined) return;
    if (playing.voice !== null) this.#commands.push({ kind: 'stop', voice: playing.voice, fade: checkFade(fade, `stopping the "${key}" loop: fade`) });
    this.#loops.delete(key);
  }

  /** The plugin loops playing now, by key (tests and tools). */
  get loops(): ReadonlyMap<string, { readonly sound: string; readonly volume: number }> {
    return this.#loops;
  }

  /**
   * A physics `impact` (payload as the physics plugins emit it): play its material's sound
   * at the point, scaled by speed and rate-limited per sound. Returns whether it played.
   */
  impact(payload: Fields): boolean {
    if (!this.impactSounds) return false;
    const written = writtenRef(payload['sound']);
    if (written === null || written === '') return false;
    const at = payload['point'];
    const speed = payload['speed'];
    if (!(at instanceof Vec3) || typeof speed !== 'number') return false;
    const handle = this.catalog.sound(written, 'sfx', 'the impact material\'s sound').handle;
    const now = this.kernel.time.now;
    const recent = (this.#impacts.get(handle) ?? []).filter((t) => now - t < IMPACT_WINDOW);
    if (recent.length >= IMPACT_LIMIT) { this.#impacts.set(handle, recent); return false; }
    recent.push(now);
    this.#impacts.set(handle, recent);
    const volume = Math.max(IMPACT_MIN, Math.min(1, speed / IMPACT_FULL_SPEED));
    this.play({ sound: handle, at, volume: Math.round(volume * 1000) / 1000, pitch: 1, to: null });
    return true;
  }

  /** Hear every one-shot as it is requested (a net server forwards them to clients); null stops. */
  forwardTo(listener: ((sound: ForwardedSound) => void) | null): void {
    this.#forward = listener;
  }

  /**
   * Override the scene's music until the next scene load; null fades out. `layers` play
   * sample-locked with it by intensity; `bpm` starts the beat clock with it (none stops it).
   */
  music(track: string | null, fade: number, options: MusicOptions = {}): void {
    const where = 'ctx.audio.music';
    const handle = track === null ? null : this.catalog.sound(track, 'music', where).handle;
    const layers = (options.layers ?? []).map((layer, i): Layer => {
      const at = layer.at;
      if (typeof at !== 'number' || !(at >= 0 && at <= 1)) {
        fail('PP3516', `${where} layers[${i}] at= must be an intensity 0..1, got ${String(at)}`, { fix: 'e.g. MusicLayer(Assets.music.drums, at=0.4).' });
      }
      return { track: this.catalog.sound(layer.track, 'music', `${where} layers[${i}]`).handle, at, volume: checkVolume(layer.volume ?? 1, `${where} layers[${i}] volume`) };
    });
    if (handle === null && layers.length > 0) fail('PP3516', `${where}: layers need a track to play with`, { fix: 'Pass the base track first: ctx.audio.music(Assets.music.calm, layers=[...]).' });
    const volume = checkVolume(options.volume ?? 1, `${where} volume`);
    this.#music.override = { track: handle, fade: checkFade(fade, `${where} fade`), layers, ...(volume !== 1 && { volume }) };
    const bpm = options.bpm ?? null;
    if (bpm === null) {
      this.#clock = null;
      return;
    }
    const offset = finite(options.offset ?? 0, `${where} offset`, (n) => n >= 0, '>= 0 (seconds into the track where beat 0 is)');
    this.#startClock(bpm, options.beatsPerBar ?? 4, this.#clockNow + offset, where);
  }

  /** The music's intensity (0..1): which layers are heard. */
  get intensity(): number {
    return this.#intensity;
  }

  /** Set the intensity; layers it turns on or off fade over `fade` seconds. */
  setIntensity(value: number, fade = 1): void {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      fail('PP3516', `audio.intensity must be 0..1, got ${String(value)}`, { fix: 'Clamp it: ctx.audio.set_intensity(min(1.0, danger), fade=2).' });
    }
    this.#intensityFade = checkFade(fade, 'audio.set_intensity fade');
    this.#intensity = value;
  }

  /** Each layer's gain heard now (0..1 × its volume), as the output ramps it; empty without layers. */
  get musicGains(): number[] {
    const g = this.#music.gains;
    if (g === null) return [];
    const elapsed = this.kernel.time.realNow - g.start;
    return g.to.map((to, i) => Math.round(rampGain(g.from[i] ?? 0, to, elapsed, g.fade) * 1e6) / 1e6);
  }

  // ── Beat clock ─────────────────────────────────────────────────────────────

  /** The beat clock's time: real seconds, less those the music was held for (paused). */
  get #clockNow(): number {
    const now = this.kernel.time.realNow;
    return now - this.#heldTotal - (this.#heldSince === null ? 0 : now - this.#heldSince);
  }

  // ── Mix groups ─────────────────────────────────────────────────────────────

  /** The groups audio.json names, in order of first use. */
  get groupNames(): string[] {
    return this.defaults.groups();
  }

  /** `ctx.audio.set_group(name, volume=, mute=)`: every sound of the group, playing or to come, follows. */
  setGroup(name: string, volume?: number, muted?: boolean): void {
    const names = this.defaults.groups();
    if (!names.includes(name)) {
      const guess = closestMatch(name, names);
      fail('PP3517', `audio.set_group: no sound in assets/audio.json is in group "${name}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Give sounds a group in assets/audio.json: {"sfx/line_1": {"group": "voice"}}.',
      });
    }
    const now = this.#groups.get(name) ?? { volume: 1, muted: false };
    this.#groups.set(name, { volume: volume === undefined ? now.volume : checkVolume(volume, 'audio.set_group volume'), muted: muted ?? now.muted });
  }

  /** A group's level now: { volume, muted }. */
  group(name: string): { readonly volume: number; readonly muted: boolean } {
    return this.#groups.get(name) ?? { volume: 1, muted: false };
  }

  /** The level a sound's group puts on it (1 without one). */
  #groupLevel(handle: string): number {
    const group = this.defaults.get(handle).group;
    if (group === undefined) return 1;
    const g = this.#groups.get(group);
    return g === undefined ? 1 : g.muted ? 0 : g.volume;
  }

  /** Whether the music is held now (the game is paused and the track pauses with it). */
  get musicPaused(): boolean {
    return this.#musicHeld;
  }

  /** Hold or release the music (and its clock) to follow the game's pause. After `#flushMusic`. */
  #flushPause(): void {
    const track = this.currentMusic;
    const hold = track !== null && this.#pausedOf(this.kernel) && this.defaults.get(track).pauses !== false;
    const now = this.kernel.time.realNow;
    if (hold && this.#heldSince === null) this.#heldSince = now;
    if (!hold && this.#heldSince !== null) {
      this.#heldTotal += now - this.#heldSince;
      this.#heldSince = null;
    }
    if (hold === this.#musicHeld) return;
    this.#musicHeld = hold;
    this.#commands.push({ kind: 'music_pause', paused: hold });
  }

  #startClock(bpm: unknown, beatsPerBar: unknown, anchor: number, where: string): void {
    const tempo = finite(bpm, `${where} bpm`, (n) => n >= MIN_BPM && n <= MAX_BPM, `within ${MIN_BPM}..${MAX_BPM} (beats per minute)`);
    if (typeof beatsPerBar !== 'number' || !Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 32) {
      fail('PP3514', `${where} beats_per_bar must be a whole number 1..32, got ${String(beatsPerBar)}`, { fix: 'e.g. 4 (4/4) or 3 (a waltz).' });
    }
    const map = tempoMap(tempo, anchor, beatsPerBar);
    const now = beatAtTime(map, this.#clockNow);
    this.#clock = { map, next: Math.max(0, Math.ceil(now - 1e-9)) };
  }

  /** Change the clock's tempo from now on (beats stay continuous); with no clock, start one at beat 0 now. */
  setTempo(bpm: number, beatsPerBar?: number): void {
    const where = 'audio.set_tempo';
    const now = this.#clockNow;
    if (this.#clock === null || (beatsPerBar !== undefined && beatsPerBar !== this.#clock.map.beatsPerBar)) {
      this.#startClock(bpm, beatsPerBar ?? this.#clock?.map.beatsPerBar ?? 4, now, where);
      return;
    }
    const tempo = finite(bpm, `${where} bpm`, (n) => n >= MIN_BPM && n <= MAX_BPM, `within ${MIN_BPM}..${MAX_BPM} (beats per minute)`);
    this.#clock.map = changeTempo(this.#clock.map, now, tempo);
  }

  /** The clock's beat now (fractional; negative before beat 0), or null without a clock. */
  get beat(): number | null {
    return this.#clock === null ? null : beatAtTime(this.#clock.map, this.#clockNow);
  }

  get bar(): number | null {
    const beat = this.beat;
    return beat === null || this.#clock === null ? null : barOf(this.#clock.map, Math.floor(beat));
  }

  get bpm(): number | null {
    return this.#clock === null ? null : bpmAt(this.#clock.map, this.#clockNow);
  }

  get beatsPerBar(): number | null {
    return this.#clock?.map.beatsPerBar ?? null;
  }

  /** Seconds until the next boundary of a `division`-beat grid (1 = beat; beats_per_bar = bar). */
  timeTo(division: number, where = 'audio.time_to'): number {
    return this.#quantizedDelay(division, where);
  }

  #quantizedDelay(division: number, where: string): number {
    if (this.#clock === null) {
      fail('PP3514', `${where}: quantize needs a beat clock, and none is running`, {
        fix: 'Start one with the music (ctx.audio.music(track, bpm=120)) or ctx.audio.set_tempo(120).',
      });
    }
    finite(division, `${where} quantize`, (n) => n > 0, '> 0 (beats), or "beat" / "bar"');
    const now = this.#clockNow;
    return Math.round((nextBoundary(this.#clock.map, now, division) - now) * 1e6) / 1e6;
  }

  /** At the start of a frame: the `beat` events for every whole beat the clock passed. */
  tick(): void {
    const clock = this.#clock;
    if (clock === null) return;
    const now = this.#clockNow;
    const { beats, next } = collectBeats(clock.map, clock.next, now, BEATS_PER_FRAME);
    // A long hitch: skip to now rather than replay a backlog of beats.
    clock.next = beats.length === BEATS_PER_FRAME ? Math.max(next, Math.floor(beatAtTime(clock.map, now)) + 1) : next;
    for (const b of beats) this.kernel.emit(BEAT_EVENT, { beat: b.beat, bar: b.bar, beat_in_bar: b.beatInBar });
  }

  // ── Voices ─────────────────────────────────────────────────────────────────

  /** Voices heard at once (`ctx.audio.max_voices`). */
  get maxVoices(): number {
    return this.#voices.max;
  }

  set maxVoices(n: number) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 256) {
      fail('PP3515', `audio.max_voices must be a whole number 1..256, got ${String(n)}`, { fix: 'e.g. 24 on phones, 48 for a busy battle.' });
    }
    this.#voices.max = n;
  }

  get voiceStats(): VoiceStats {
    return this.#voices.stats;
  }

  // ── Ambience ───────────────────────────────────────────────────────────────

  /** The weather's `thunder` event: a synthesized clap, unless the scene's weather names its own. */
  thunder(payload: Fields): void {
    if (!this.ambience || this.#weatherSounds.thunder) return;
    const strength = payload['strength'];
    const distance = payload['distance'];
    if (typeof strength !== 'number' || typeof distance !== 'number') return;
    this.play(thunderClap(strength, distance));
  }

  #flushAmbience(at: Vec3 | null): void {
    const wanted = this.ambience ? ambienceLoops(this.kernel, at, this.#weatherSounds) : null;
    for (const key of AMBIENCE_KEYS) {
      const sound = wanted?.get(key) ?? null;
      if (sound === null) this.stop(key, AMBIENCE_FADE);
      else this.loop(key, sound);
    }
  }

  /** The track playing now (or fading in), for tests and tools. */
  get currentMusic(): string | null {
    const { override, scene } = this.#music;
    return override !== null ? override.track : scene;
  }

  // ── Kernel wiring ──────────────────────────────────────────────────────────

  sceneLoading(music: string | undefined, sceneId: string, environment?: Readonly<Record<string, unknown>>, volume = 1): void {
    this.#music.scene = music === undefined ? null : this.catalog.sound(music, 'music', `scene "${sceneId}" "music"`).handle;
    this.#music.sceneVolume = volume;
    this.#music.override = null;
    this.#clock = null;
    this.#weatherSounds = sceneWeatherSounds(environment);
  }

  entitiesAdded(records: readonly EntityRecord[]): void {
    for (const record of records) this.#track(record);
  }

  entitiesRemoved(records: readonly EntityRecord[]): void {
    for (const record of records) this.#untrack(record.id);
  }

  entityChanged(record: EntityRecord): void {
    if (record.components.has(AUDIO_SOURCE)) this.#track(record);
    else this.#untrack(record.id);
  }

  /** Once per frame, after the UI: send what changed. */
  flush(): void {
    // Logic off (an editor's edit mode): the scene is drawn, not played, so nothing sounds.
    if (!this.kernel.logic) {
      this.#silence();
      return;
    }
    this.#silent = false;
    const hearing = this.#hearing();
    const listener = hearing?.listener ?? null;
    const now = this.kernel.time.realNow;
    this.#flushBuses();
    this.#flushMix(hearing);
    this.#flushMusic();
    this.#flushPause();
    this.#flushAmbience(hearing?.at ?? null);
    const loops = this.#loopContenders();
    for (const shot of this.#pending) {
      const where = shot.position === null ? CENTERED : spatialize(shot.position, listener, this.#mode, this.#spatial);
      const doppler = shot.position === null || hearing === null ? 1
        : dopplerFactor(shot.position, shot.position, hearing.at, this.#listenerBefore ?? hearing.at, this.kernel.time.dt, hearing.settings.doppler);
      const pitch = shot.pitch * doppler;
      const defaults = this.defaults.get(shot.sound.handle);
      const length = shot.sound.synth !== undefined ? synthSeconds(shot.sound.synth) / pitch : ONE_SHOT_SECONDS;
      const volume = shot.volume * this.#groupLevel(shot.sound.handle);
      const admitted = this.#voices.admit({
        voice: shot.voice, sound: shot.sound.handle, priority: defaults.priority ?? DEFAULT_PRIORITY, audibility: volume * where.attenuation,
        ends: now + shot.delay + length, limit: defaults.limit,
      }, now, loops);
      for (const voice of admitted.stop) this.#commands.push({ kind: 'stop', voice, fade: STEAL_FADE });
      if (!admitted.start) continue;
      this.#commands.push({
        kind: 'play', voice: shot.voice, sound: shot.sound, bus: shot.bus, volume, pitch, loop: false,
        position: shot.position === null ? null : position(shot.position), attenuation: where.attenuation, pan: where.pan,
        source: 'one_shot', to: shot.to, duck: shot.duck, occlusion: this.#occlusion(hearing, shot.position, undefined),
        ...(shot.delay > 0 && { delay: shot.delay }),
      });
    }
    this.#pending = [];
    const virtual = this.#voices.rank(loops, now);
    for (const [id, state] of this.#sources) this.#flushSource(id, state, hearing, virtual);
    for (const [key, loop] of this.#loops) this.#flushLoop(key, loop, listener, virtual);
    this.#listenerBefore = hearing?.at;
    if (this.#commands.length === 0) return;
    const commands = this.#commands;
    this.#commands = [];
    this.#output.submit({ frame: this.kernel.time.frame, time: this.kernel.time.realNow, listener, commands });
  }

  /**
   * Stop every voice and the music once, and drop what was queued. Sources, loops and the
   * music keep their state without a voice, so they start again when logic comes back on.
   */
  #silence(): void {
    this.#pending = [];
    if (this.#silent) return;
    this.#silent = true;
    for (const state of this.#sources.values()) state.voice = null;
    for (const loop of this.#loops.values()) loop.voice = null;
    this.#music.current = null;
    this.#music.gains = null;
    this.#voices.clear();
    this.#commands = [];
    this.#output.submit({
      frame: this.kernel.time.frame, time: this.kernel.time.realNow, listener: null,
      commands: [{ kind: 'stop_all' }, { kind: 'music', track: null, volume: 0, pitch: 1, fade: 0 }],
    });
  }

  /**
   * The kernel is done (hot reload): silence everything this runtime started — every voice
   * (one-shots, entity sounds, plugin loops) and the music — at once, so a runtime that
   * takes over the same output starts from quiet.
   */
  dispose(): void {
    this.#pending = [];
    this.#commands = [];
    this.#sources.clear();
    this.#loops.clear();
    this.#music.current = null;
    this.#music.gains = null;
    this.#clock = null;
    this.#voices.clear();
    this.#output.submit({
      frame: this.kernel.time.frame, time: this.kernel.time.realNow, listener: null,
      commands: [{ kind: 'stop_all' }, { kind: 'music', track: null, volume: 0, pitch: 1, fade: 0 }],
    });
  }

  snapshot(): Json {
    const state: AudioState = {
      random: this.#random.state(),
      nextVoice: this.#nextVoice,
      music: {
        scene: this.#music.scene, override: this.#music.override, current: this.#music.current ?? null,
        ...(this.#music.sceneVolume !== 1 && { sceneVolume: this.#music.sceneVolume }),
      },
      sources: [...this.#sources].map(([id, s]) => [id, s.voice !== null, s.fired, s.volumeFactor, s.pitchFactor] as const),
      ...(!this.impactSounds && { impactSounds: false }),
      intensity: [this.#intensity, this.#intensityFade],
      clock: this.#clock === null ? null : [
        beatAtTime(this.#clock.map, this.#clockNow), bpmAt(this.#clock.map, this.#clockNow), this.#clock.map.beatsPerBar, this.#clock.next,
      ],
      ...(!this.ambience && { ambience: false }),
      ...(this.#groups.size > 0 && { groups: [...this.#groups].map(([name, g]) => [name, g.volume, g.muted] as const) }),
      ...(this.#voices.max !== DEFAULT_MAX_VOICES && { maxVoices: this.#voices.max }),
      weatherSounds: this.#weatherSounds,
      loops: [...this.#loops].map(([key, l]) => [
        key, l.sound, l.bus, l.volume, l.pitch, l.at === null ? null : [l.at.x, l.at.y, l.at.z] as const, l.volumeFactor, l.pitchFactor,
      ] as const),
    };
    return state as unknown as Json;
  }

  restore(saved: Json): void {
    const state = saved as unknown as AudioState;
    if (typeof state !== 'object' || state === null || !Array.isArray(state.random) || !Array.isArray(state.sources)) {
      fail('PP9002', 'The snapshot\'s audio state is malformed');
    }
    this.#random.restore(state.random);
    this.#nextVoice = state.nextVoice;
    this.impactSounds = state.impactSounds ?? true;
    this.#impacts.clear();
    this.#pending = [];
    this.#commands = [{ kind: 'stop_all' }];
    this.#music.scene = state.music.scene;
    this.#music.sceneVolume = state.music.sceneVolume ?? 1;
    // Older snapshots' overrides have no layers.
    this.#music.override = state.music.override === null ? null : { ...state.music.override, layers: state.music.override.layers ?? [] };
    this.#music.current = undefined;
    this.#music.gains = null;
    [this.#intensity, this.#intensityFade] = state.intensity ?? [0, 1];
    this.ambience = state.ambience ?? true;
    this.#groups.clear();
    for (const [name, volume, muted] of state.groups ?? []) this.#groups.set(name, { volume, muted });
    this.#voices.clear();
    this.#voices.max = state.maxVoices ?? DEFAULT_MAX_VOICES;
    this.#weatherSounds = state.weatherSounds ?? { rain: false, thunder: false };
    if (state.clock === null || state.clock === undefined) {
      this.#clock = null;
    } else {
      // Re-anchored at the restoring frame's time: the beat it was at, at the tempo it had.
      const [beat, bpm, beatsPerBar, next] = state.clock;
      const map = tempoMap(bpm, this.#clockNow - (beat * 60) / bpm, beatsPerBar);
      this.#clock = { map, next };
    }
    this.#buses = undefined;
    this.#mix = JSON.stringify(NEUTRAL_MIX);
    this.#listenerBefore = undefined;
    this.#sources.clear();
    this.#loops.clear();
    for (const [key, sound, bus, volume, pitch, at, volumeFactor, pitchFactor] of state.loops ?? []) {
      this.#loops.set(key, {
        voice: null, sound, bus, volume, pitch, at: at === null ? null : new Vec3(at[0], at[1], at[2]), volumeFactor, pitchFactor, sent: '', audibility: 0,
      });
    }
    const savedSources = new Map(state.sources.map(([id, playing, fired, volume, pitch]) => [id as EntityId, { playing, fired, volume, pitch }]));
    for (const record of this.kernel.world.live()) {
      const fields = record.components.get(AUDIO_SOURCE);
      if (fields === undefined) continue;
      const s = savedSources.get(record.id);
      const sound = this.#sourceSound(fields);
      this.#sources.set(record.id, {
        voice: null, sound, loop: fields['loop'] === true, fired: s?.fired ?? false,
        // A one-shot source can't resume mid-sound (its position in the file isn't known): it stays fired.
        resume: fields['loop'] === true && (s?.playing ?? false),
        volumeFactor: s?.volume ?? 1, pitchFactor: s?.pitch ?? 1, sent: '', before: undefined, occlusion: 0, audibility: 0,
      });
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #resolveAt(at: PlayRequest['at'], where: string): Vec3 | null {
    if (at === null) return null;
    if (at instanceof Vec3) return at;
    if (at instanceof Vec2) return new Vec3(at.x, at.y, 0);
    if (typeof at === 'number') {
      const record = this.kernel.world.peek(at);
      if (record === undefined) {
        fail('PP3502', `${where} at= names an entity that no longer exists`, {
          fix: 'Read its position while it exists (in its own `destroyed` handler it still does), or pass a Vec3.',
        });
      }
      return record.transform.worldPosition();
    }
    return fail('PP3502', `${where} at= must be a Vec3, a Vec2 or an Entity`, { fix: 'Pass a position or an entity.' });
  }

  /** The listener: the first live entity with an `audio_listener`, else the camera (`listener` option). */
  #hearing(): Hearing | null {
    let id: EntityId | null = null;
    for (const record of this.kernel.world.live()) if (record.components.has(AUDIO_LISTENER)) { id = record.id; break; }
    id ??= this.#listenerOf(this.kernel);
    if (id === null) return null;
    const record = this.kernel.world.get(id);
    if (record === undefined) return null;
    const node = record.transform;
    const at = node.worldPosition();
    return { listener: listenerAt(at, node.worldRotation()), at, id, settings: listenerSettings(record.components.get(AUDIO_LISTENER)) };
  }

  #flushMix(hearing: Hearing | null): void {
    const settings = hearing?.settings ?? DEFAULT_LISTENER;
    const zones: Zone[] = [];
    if (hearing !== null) {
      for (const record of this.kernel.world.live()) {
        const fields = record.components.get(REVERB_ZONE);
        if (fields !== undefined) zones.push({ id: record.id, at: record.transform.worldPosition(), fields });
      }
    }
    const mix: AudioMix = {
      kind: 'mix', reverb: hearing === null ? null : reverbAt(hearing.at, zones), panning: settings.panning,
      duckLevel: settings.duckLevel, duckRelease: settings.duckRelease,
    };
    const key = JSON.stringify(mix);
    if (key === this.#mix) return;
    this.#mix = key;
    this.#commands.push(mix);
  }

  /** 0/1 occlusion of a positional sound (with `occlusion` on, in 3D, with physics3d). */
  #occlusion(hearing: Hearing | null, at: Vec3 | null, source: EntityId | undefined): number {
    if (at === null || hearing === null || !hearing.settings.occlusion || this.#mode !== '3d') return 0;
    const physics = this.kernel.tryService(PHYSICS3D_SERVICE);
    if (physics === undefined) return 0;
    return occlusionBetween(physics, hearing.at, at, source === undefined ? [hearing.id] : [hearing.id, source]);
  }

  #flushBuses(): void {
    const settings = this.kernel.resource(SETTINGS);
    const level = (name: string): number => {
      const v = settings[name];
      return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fail('PP3505', `Settings.${name} must be a number 0..1`);
    };
    const buses: AudioBuses = { kind: 'buses', master: level('master_volume'), music: level('music_volume'), sfx: level('sfx_volume') };
    const key = `${buses.master}|${buses.music}|${buses.sfx}`;
    if (key === this.#buses) return;
    this.#buses = key;
    this.#commands.push(buses);
  }

  /** The layers playing with the current music. */
  get #layers(): readonly Layer[] {
    return this.#music.override?.layers ?? [];
  }

  #flushMusic(): void {
    const music = this.#music;
    const track = this.currentMusic;
    const layers = this.#layers;
    const level = (music.override !== null ? music.override.volume ?? 1 : music.sceneVolume) * (track === null ? 1 : this.#groupLevel(track));
    const desired = track === null ? null : layers.length === 0 && level === 1 ? track : JSON.stringify([track, layers.map((l) => l.track), level]);
    const stems: StemLayer[] = layers.map((l) => ({ at: l.at, volume: 1 }));
    const now = this.kernel.time.realNow;
    if (desired === music.current) {
      // Same music: only the intensity can have moved its layers.
      const g = music.gains;
      if (g === null) return;
      const targets = layerGains(stems, this.#intensity);
      if (targets.every((t, i) => t === g.to[i])) return;
      music.gains = { from: this.musicGains, to: targets, start: now, fade: this.#intensityFade, layerVolumes: g.layerVolumes };
      this.#commands.push({ kind: 'music_gains', gains: targets, fade: this.#intensityFade });
      return;
    }
    const fade = music.current === undefined ? 0 : music.override !== null ? music.override.fade : SCENE_MUSIC_FADE;
    music.current = desired;
    music.gains = null;
    this.#musicHeld = false;
    if (track === null) {
      this.#commands.push({ kind: 'music', track: null, volume: 0, pitch: 1, fade });
      return;
    }
    const drawn = this.defaults.draw(track, this.#random);
    const targets = layerGains(stems, this.#intensity);
    const layerVolumes = layers.map((l) => this.defaults.draw(l.track, this.#random).volume * l.volume);
    if (layers.length > 0) music.gains = { from: targets, to: targets, start: now, fade: 0, layerVolumes };
    this.#commands.push({
      kind: 'music', track: this.catalog.sound(track, 'music', 'music'), volume: drawn.volume * level, pitch: drawn.pitch, fade,
      ...(layers.length > 0 && {
        layers: layers.map((l, i) => ({ track: this.catalog.sound(l.track, 'music', 'music'), volume: layerVolumes[i]!, gain: targets[i]! })),
      }),
    });
  }

  /** Every looping voice playing now, as the voice budget ranks it (last frame's levels). */
  #loopContenders(): Contender[] {
    const out: Contender[] = [];
    for (const state of this.#sources.values()) {
      if (state.voice !== null && state.loop) out.push({ voice: state.voice, priority: this.defaults.get(state.sound).priority ?? DEFAULT_PRIORITY, audibility: state.audibility });
    }
    for (const [key, loop] of this.#loops) {
      if (loop.voice === null) continue;
      const priority = this.defaults.get(loop.sound).priority ?? (key.startsWith('ambience.') ? AMBIENCE_PRIORITY : DEFAULT_PRIORITY);
      out.push({ voice: loop.voice, priority, audibility: loop.audibility });
    }
    return out;
  }

  #track(record: EntityRecord): void {
    const fields = record.components.get(AUDIO_SOURCE);
    if (fields === undefined || this.#sources.has(record.id)) return;
    this.#sources.set(record.id, {
      voice: null, sound: this.#sourceSound(fields), loop: fields['loop'] === true, fired: false, resume: false,
      volumeFactor: 1, pitchFactor: 1, sent: '', before: undefined, occlusion: 0, audibility: 0,
    });
  }

  #untrack(id: EntityId): void {
    const state = this.#sources.get(id);
    if (state === undefined) return;
    if (state.voice !== null) this.#commands.push({ kind: 'stop', voice: state.voice, fade: SOURCE_STOP_FADE });
    this.#sources.delete(id);
  }

  #sourceSound(fields: Fields): string {
    const written = writtenRef(fields['sound']);
    if (written === null || written === '') return '';
    return this.catalog.sound(written, 'sfx', 'AudioSource.sound').handle;
  }

  #flushSource(id: EntityId, state: SourceState, hearing: Hearing | null, virtual: ReadonlySet<number>): void {
    const listener = hearing?.listener ?? null;
    const record = this.kernel.world.get(id);
    const fields = record?.components.get(AUDIO_SOURCE);
    if (record === undefined || fields === undefined) return;
    const playing = sourceBool(fields, 'playing');
    const loop = sourceBool(fields, 'loop');
    const spatial = sourceBool(fields, 'spatial');
    const sound = this.#sourceSound(fields);

    if (state.voice !== null && (sound !== state.sound || loop !== state.loop || !playing)) {
      this.#commands.push({ kind: 'stop', voice: state.voice, fade: SOURCE_STOP_FADE });
      state.voice = null;
    }
    if (!playing || sound !== state.sound || loop !== state.loop) {
      state.fired = false;
      state.resume = false;
    }
    state.sound = sound;
    state.loop = loop;
    if (!playing) return;
    if (sound === '') {
      fail('PP3504', 'An AudioSource is playing but has no sound', {
        fix: 'Set its "sound" (e.g. "sfx/engine_loop" in the prefab, or Assets.sfx.<name> in code).',
      });
    }

    const volume = checkVolume(fields['volume'], 'AudioSource.volume') * this.#groupLevel(sound);
    const pitch = checkPitch(fields['pitch'], 'AudioSource.pitch');
    const at = spatial ? record.transform.worldPosition() : null;
    const where = at === null ? CENTERED : spatialize(at, listener, this.#mode, this.#spatial);
    const muted = this.kernel.time.frozen || (state.voice !== null && virtual.has(state.voice));
    state.audibility = this.kernel.time.frozen ? 0 : state.volumeFactor * volume * where.attenuation;
    const doppler = at === null || hearing === null ? 1
      : dopplerFactor(at, state.before ?? at, hearing.at, this.#listenerBefore ?? hearing.at, this.kernel.time.dt, hearing.settings.doppler);
    state.before = at ?? undefined;
    if (state.voice === null || (this.kernel.time.frame + (state.voice ?? 0)) % OCCLUSION_EVERY === 0) {
      state.occlusion = this.#occlusion(hearing, at, id);
    }

    if (state.voice === null) {
      if (state.fired && !state.resume) return;
      if (!state.resume) {
        const drawn = this.defaults.draw(sound, this.#random);
        state.volumeFactor = drawn.volume;
        state.pitchFactor = drawn.pitch;
      }
      state.resume = false;
      state.voice = this.#nextVoice++;
      state.fired = !loop;
      const params = this.#sourceParams(state, volume, pitch * doppler, muted, at, where);
      state.sent = JSON.stringify(params);
      this.#commands.push({
        kind: 'play', voice: state.voice, sound: this.catalog.sound(sound, 'sfx', 'AudioSource.sound'), bus: 'sfx', loop,
        ...params, source: 'entity', to: null, duck: false,
      });
      return;
    }
    const params = this.#sourceParams(state, volume, pitch * doppler, muted, at, where);
    const key = JSON.stringify(params);
    if (key === state.sent) return;
    state.sent = key;
    this.#commands.push({ kind: 'update', voice: state.voice, ...params });
  }

  #flushLoop(name: string, loop: PluginLoop, listener: AudioListener | null, virtual: ReadonlySet<number>): void {
    const where = loop.at === null ? CENTERED : spatialize(loop.at, listener, this.#mode, this.#spatial);
    const group = this.#groupLevel(loop.sound);
    loop.audibility = loop.volumeFactor * loop.volume * group * where.attenuation;
    const heard = loop.voice === null || !virtual.has(loop.voice);
    const params = {
      volume: heard ? loop.volumeFactor * loop.volume * group : 0, pitch: loop.pitchFactor * loop.pitch,
      position: loop.at === null ? null : position(loop.at), attenuation: where.attenuation, pan: where.pan, occlusion: 0,
    };
    const key = JSON.stringify(params);
    if (loop.voice !== null && key === loop.sent) return;
    loop.sent = key;
    if (loop.voice !== null) {
      this.#commands.push({ kind: 'update', voice: loop.voice, ...params });
      return;
    }
    loop.voice = this.#nextVoice++;
    this.#commands.push({
      kind: 'play', voice: loop.voice, sound: this.catalog.sound(loop.sound, loop.bus, `the "${name}" loop`), bus: loop.bus, loop: true,
      ...params, source: 'plugin', to: null, duck: false,
    });
  }

  #sourceParams(
    state: SourceState, volume: number, pitch: number, muted: boolean, at: Vec3 | null, where: { attenuation: number; pan: number },
  ): { volume: number; pitch: number; position: AudioPosition | null; attenuation: number; pan: number; occlusion: number } {
    return {
      volume: muted ? 0 : state.volumeFactor * volume,
      pitch: state.pitchFactor * pitch,
      position: at === null ? null : position(at),
      attenuation: where.attenuation,
      pan: where.pan,
      occlusion: state.occlusion,
    };
  }
}

function sourceBool(fields: Fields, name: string): boolean {
  const value = fields[name];
  if (typeof value !== 'boolean') {
    fail('PP3504', `AudioSource.${name} must be True or False, got ${JSON.stringify(value) ?? String(value)}`, {
      fix: `Set ${name} to true/false in the prefab, or True/False in code.`,
    });
  }
  return value;
}

/** The default listener: the first live entity with a camera, in spawn order. */
export function firstCamera(kernel: Kernel): EntityId | null {
  for (const record of kernel.world.live()) if (record.components.has(CAMERA)) return record.id;
  return null;
}
