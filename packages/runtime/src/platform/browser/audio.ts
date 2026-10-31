/**
 * Web Audio output. The engine decides levels, pitch (Doppler included), attenuation, pan,
 * occlusion, ducking and reverb; this makes them audible:
 *
 *   graph      voice: source → gain (volume × attenuation) → lowpass (occlusion) → panner
 *              → sfx bus; sfx → master (dry) and → reverb send → convolver → master;
 *              music slots → music bus → duck → master → speakers. Settings volumes set
 *              the buses.
 *   panning    stereo: a StereoPanner at the engine's `pan`. HRTF (`mix.panning`): an
 *              HRTF PannerNode at the voice's position in the listener's frame (right, up,
 *              −forward), the listener fixed at the origin — so the engine's handedness never
 *              meets Web Audio's; the panner never attenuates (the engine already did)
 *   occlusion  0..1 closes a lowpass from 20 kHz to 800 Hz and takes 40% off the level
 *   reverb     one convolver per preset, made on first use from a seeded noise impulse;
 *              changing preset crossfades their sends
 *   ducking    while any `duck` voice plays, the duck gain glides to `mix.duckLevel`, and
 *              back over `mix.duckRelease` seconds after the last one ends
 *   buffers    each file fetched and decoded once (`preload` at startup; on demand
 *              otherwise; `release` forgets them). A one-shot whose buffer isn't ready within
 *              LATE_LIMIT seconds is dropped (a late sound is worse than none); loops and
 *              music start late.
 *   music      two slots: a change crossfades the old track out and the new one in over
 *              `fade` seconds; the same track only changes level. With `stream`, music plays
 *              from a media element (streamed by HTTP, never decoded whole) — long tracks
 *              start at once and cost no decoded memory. Layered music (`layers`) is decoded:
 *              every stem starts at the same context time (sample-locked), each through its
 *              own gain, which `music_gains` ramps linearly. `music_pause` holds the slot
 *              where it is: a streamed track's element pauses; decoded sources go to
 *              playbackRate 0 together (so stems stay locked) under a short gain dip, and
 *              resume from the same sample. A new track starts unpaused.
 *   synth      a sound with `synth` (core/synth.ts) is rendered once at the context's rate
 *              and cached by its spec — no fetch, no decode
 *   timing     a play's `delay` (beat-quantized) starts it that many seconds after it arrives,
 *              scheduled on the context's clock
 *   limits     at most `maxVoices` voices: a new one steals the oldest one-shot, or is
 *              dropped when every voice is a loop. At most `maxPerSound` one-shots of one
 *              sound at once (ten bricks breaking in a frame): the oldest makes room.
 *   smoothing  level, pan and filter changes glide (SMOOTHING) so tracking a moving entity
 *              doesn't crackle; stops fade (a cut clicks).
 *
 * Boot contract: browsers start an AudioContext suspended. Call `resume()` from the first
 * user gesture (pointerdown / keydown / touchend), and when the page is shown again; call
 * `suspend()` when it is hidden (phones otherwise keep loops playing in the background).
 * iOS reports `interrupted` after a call or Siri: `resume()` handles it the same way.
 * Sounds sent while suspended are dropped like late ones; loops and music start once it runs.
 */

import { fail, isRemoteAsset, renderSynth } from '../../core/index.js';
import type {
  AudioCommand, AudioFrame, AudioListener, AudioMix, AudioMusic, AudioMusicGains, AudioOutput, AudioPlay, AudioPosition, AudioSound,
  AudioUpdate, ReverbPreset, SynthSpec,
} from '../../core/index.js';

/** What this adapter uses of an AudioContext (a real one, or a test double). */
export type AudioContextLike = Pick<
  AudioContext,
  | 'createGain' | 'createStereoPanner' | 'createBufferSource' | 'decodeAudioData' | 'destination' | 'currentTime' | 'resume' | 'state'
  | 'createBiquadFilter' | 'createPanner' | 'createConvolver' | 'createBuffer' | 'sampleRate' | 'suspend'
> & Partial<Pick<AudioContext, 'createMediaElementSource'>>;

/** The part of an HTMLAudioElement music streaming uses. */
export interface MediaLike {
  src: string;
  loop: boolean;
  playbackRate: number;
  preservesPitch?: boolean;
  crossOrigin: string | null;
  play(): Promise<void>;
  pause(): void;
}

export interface WebAudioOptions {
  readonly context: AudioContextLike;
  /** A project file's bytes (boot: `fetch(url).then((r) => r.arrayBuffer())`, or a bundle read). */
  readonly load: (file: string) => Promise<ArrayBuffer>;
  /** Stream music from this URL through a media element (undefined for a file: decode it). */
  readonly stream?: (file: string) => string | undefined;
  /** Default: `new Audio()`. */
  readonly createMedia?: () => MediaLike;
  readonly maxVoices?: number;
  readonly maxPerSound?: number;
  /** Called when a file fails to load or decode (boot shows it in the dev overlay). */
  readonly onError?: (file: string, error: unknown) => void;
}

const LATE_LIMIT = 0.15;
const SMOOTHING = 0.03;
const MIN_FADE = 0.01;
const OPEN_FILTER = 20000;
const CLOSED_FILTER = 800;
const DUCK_ATTACK = 0.08;
/** The music's dip when it is held or let go (a hard stop clicks). */
const PAUSE_FADE = 0.06;

/** Impulse shape per preset: seconds of tail, decay exponent, pre-delay, and a lowpass on the tail. */
const REVERBS: Readonly<Record<ReverbPreset, { seconds: number; decay: number; delay: number; lowpass: number }>> = {
  room: { seconds: 0.6, decay: 3.5, delay: 0.005, lowpass: 9000 },
  hall: { seconds: 2.6, decay: 2.2, delay: 0.02, lowpass: 7000 },
  cave: { seconds: 3.8, decay: 1.6, delay: 0.035, lowpass: 5000 },
  arena: { seconds: 2.2, decay: 2.6, delay: 0.03, lowpass: 8000 },
  forest: { seconds: 1.1, decay: 4.5, delay: 0.012, lowpass: 4000 },
  underwater: { seconds: 1.6, decay: 2.0, delay: 0.0, lowpass: 900 },
};

interface Voice {
  readonly id: number;
  readonly handle: string;
  readonly loop: boolean;
  readonly duck: boolean;
  readonly startedAt: number;
  source: AudioBufferSourceNode | null;
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly panner: StereoPannerNode | PannerNode;
  stopped: boolean;
}

interface MusicSlot {
  /** The track's handle, with its layers' (layered music is one piece). */
  readonly handle: string;
  readonly source: AudioBufferSourceNode | null;
  readonly media: MediaLike | null;
  readonly gain: GainNode;
  /** Stems: each source through its own gain (× its volume) into `gain`. */
  readonly layers: readonly { readonly source: AudioBufferSourceNode; readonly gain: GainNode; readonly volume: number }[];
  /** Its playback rate and level, for resuming after a pause. */
  readonly pitch: number;
  volume: number;
  paused: boolean;
}

/** A music command's identity: the track and its stems. */
const musicKey = (command: AudioMusic): string | null =>
  command.track === null ? null : [command.track.handle, ...(command.layers ?? []).map((l) => l.track.handle)].join('|');

/** The voice's level with occlusion applied. */
const level = (volume: number, attenuation: number, occlusion: number): number => volume * attenuation * (1 - 0.4 * occlusion);
const cutoff = (occlusion: number): number => OPEN_FILTER + (CLOSED_FILTER - OPEN_FILTER) * occlusion;

/** A position in the listener's frame, as Web Audio's default listener (−z ahead, +y up) hears it. */
export function listenerSpace(position: AudioPosition, listener: AudioListener | null): AudioPosition {
  if (listener === null) return position;
  const d = [position[0] - listener.position[0], position[1] - listener.position[1], position[2] - listener.position[2]];
  const dot = (axis: AudioPosition): number => d[0]! * axis[0] + d[1]! * axis[1] + d[2]! * axis[2];
  return [dot(listener.right), dot(listener.up), -dot(listener.forward)];
}

export class WebAudioOutput implements AudioOutput {
  readonly #ctx: AudioContextLike;
  readonly #load: (file: string) => Promise<ArrayBuffer>;
  readonly #stream: ((file: string) => string | undefined) | undefined;
  readonly #createMedia: () => MediaLike;
  readonly #onError: (file: string, error: unknown) => void;
  readonly #maxVoices: number;
  readonly #maxPerSound: number;
  readonly #buffers = new Map<string, Promise<AudioBuffer | null>>();
  readonly #ready = new Map<string, AudioBuffer>();
  /** Rendered synthesized sounds, by their spec. */
  readonly #synths = new Map<string, AudioBuffer>();
  readonly #voices = new Map<number, Voice>();
  readonly #master: GainNode;
  readonly #sfx: GainNode;
  readonly #musicBus: GainNode;
  readonly #duck: GainNode;
  readonly #reverbs = new Map<ReverbPreset, GainNode>();
  #mix: Omit<AudioMix, 'kind'> = { reverb: null, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 };
  #listener: AudioListener | null = null;
  #ducking = 0;
  #music: MusicSlot | null = null;
  /** Whether the current music is held (a late-starting slot starts held). */
  #musicPaused = false;
  /** The track asked for last (a late-decoding track starts only if still wanted). */
  #wantedMusic: string | null = null;

  constructor(options: WebAudioOptions) {
    this.#ctx = options.context;
    this.#load = options.load;
    this.#stream = options.stream;
    this.#createMedia = options.createMedia ?? (() => new Audio() as unknown as MediaLike);
    this.#onError = options.onError ?? ((file, error) => { console.error(`audio: could not load ${file}`, error); });
    this.#maxVoices = options.maxVoices ?? 32;
    this.#maxPerSound = options.maxPerSound ?? 6;
    if (!(this.#maxVoices >= 1 && this.#maxPerSound >= 1)) {
      fail('PP3506', 'WebAudioOutput voice limits must be at least 1');
    }
    this.#master = this.#ctx.createGain();
    this.#master.connect(this.#ctx.destination);
    this.#sfx = this.#ctx.createGain();
    this.#sfx.connect(this.#master);
    this.#musicBus = this.#ctx.createGain();
    this.#duck = this.#ctx.createGain();
    this.#musicBus.connect(this.#duck);
    this.#duck.connect(this.#master);
  }

  /** Call from the first user gesture, and when the page is shown again (also after an iOS interruption). */
  resume(): Promise<void> {
    return this.#ctx.state === 'running' ? Promise.resolve() : this.#ctx.resume();
  }

  /** Call when the page is hidden: silence and release the audio device until `resume()`. */
  suspend(): Promise<void> {
    return this.#ctx.state === 'running' ? this.#ctx.suspend() : Promise.resolve();
  }

  /** Voices playing now (for the dev overlay and tests). */
  get voiceCount(): number {
    return this.#voices.size;
  }

  /** Whether the music is ducked now, and the reverb heard (for tests and tools). */
  get ducked(): boolean {
    return this.#ducking > 0;
  }

  get reverb(): AudioMix['reverb'] {
    return this.#mix.reverb;
  }

  preload(files: readonly string[]): void {
    for (const file of files) {
      if (this.#streams(file)) continue;
      void this.#buffer(file);
    }
  }

  release(files: readonly string[]): void {
    for (const file of files) {
      this.#buffers.delete(file);
      this.#ready.delete(file);
    }
  }

  submit(frame: AudioFrame): void {
    this.#listener = frame.listener;
    for (const command of frame.commands) this.#apply(command);
  }

  #apply(command: AudioCommand): void {
    switch (command.kind) {
      case 'play': return this.#play(command);
      case 'update': return this.#update(command);
      case 'stop': return this.#stop(command.voice, command.fade);
      case 'stop_all':
        for (const id of [...this.#voices.keys()]) this.#stop(id, MIN_FADE);
        return;
      case 'music': return this.#changeMusic(command);
      case 'music_gains': return this.#musicGains(command);
      case 'music_pause':
        this.#musicPaused = command.paused;
        if (this.#music !== null) this.#holdMusic(this.#music, command.paused);
        return;
      case 'buses': {
        const now = this.#ctx.currentTime;
        this.#master.gain.setTargetAtTime(command.master, now, SMOOTHING);
        this.#sfx.gain.setTargetAtTime(command.sfx, now, SMOOTHING);
        this.#musicBus.gain.setTargetAtTime(command.music, now, SMOOTHING);
        return;
      }
      case 'mix': return this.#applyMix(command);
    }
  }

  /** Music files stream through a media element; so does a hosted file playing as music (`music`). */
  #streams(file: string, music = false): boolean {
    return (file.startsWith('assets/music/') || (music && isRemoteAsset(file))) && this.#stream?.(file) !== undefined && this.#ctx.createMediaElementSource !== undefined;
  }

  /** A synthesized sound's buffer: rendered at the context's rate on first use, then cached. */
  #synth(spec: SynthSpec): AudioBuffer {
    const key = JSON.stringify(spec);
    let buffer = this.#synths.get(key);
    if (buffer === undefined) {
      const pcm = renderSynth(spec, this.#ctx.sampleRate);
      buffer = this.#ctx.createBuffer(1, pcm.length, this.#ctx.sampleRate);
      buffer.getChannelData(0).set(pcm);
      this.#synths.set(key, buffer);
    }
    return buffer;
  }

  /** A sound's buffer now (decoded or synthesized), a promise of it, or null when it has nothing to play. */
  #soundBuffer(sound: AudioSound): AudioBuffer | Promise<AudioBuffer | null> | null {
    if (sound.synth !== undefined) return this.#synth(sound.synth);
    if (sound.file === null) return null;
    return this.#ready.get(sound.file) ?? this.#buffer(sound.file);
  }

  #buffer(file: string): Promise<AudioBuffer | null> {
    let pending = this.#buffers.get(file);
    if (pending === undefined) {
      pending = this.#load(file)
        .then((bytes) => this.#ctx.decodeAudioData(bytes))
        .then((buffer) => { if (this.#buffers.get(file) === pending) this.#ready.set(file, buffer); return buffer; })
        .catch((error: unknown) => { this.#onError(file, error); return null; });
      this.#buffers.set(file, pending);
    }
    return pending;
  }

  // ── Mix ────────────────────────────────────────────────────────────────────

  #applyMix(mix: AudioMix): void {
    const now = this.#ctx.currentTime;
    this.#mix = { reverb: mix.reverb, panning: mix.panning, duckLevel: mix.duckLevel, duckRelease: mix.duckRelease };
    if (mix.reverb !== null) this.#reverbSend(mix.reverb.preset);
    for (const [preset, send] of this.#reverbs) {
      send.gain.setTargetAtTime(mix.reverb?.preset === preset ? mix.reverb.wet : 0, now, 0.15);
    }
    if (this.#ducking > 0) this.#duck.gain.setTargetAtTime(mix.duckLevel, now, DUCK_ATTACK / 3);
  }

  /** The send into a preset's convolver, built on first use. */
  #reverbSend(preset: ReverbPreset): GainNode {
    let send = this.#reverbs.get(preset);
    if (send !== undefined) return send;
    send = this.#ctx.createGain();
    send.gain.value = 0;
    const convolver = this.#ctx.createConvolver();
    convolver.buffer = this.#impulse(preset);
    const tone = this.#ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = REVERBS[preset].lowpass;
    this.#sfx.connect(send);
    send.connect(convolver);
    convolver.connect(tone);
    tone.connect(this.#master);
    this.#reverbs.set(preset, send);
    return send;
  }

  /** A stereo impulse: pre-delay, then exponentially decaying noise (seeded: the same every run). */
  #impulse(preset: ReverbPreset): AudioBuffer {
    const { seconds, decay, delay } = REVERBS[preset];
    const rate = this.#ctx.sampleRate;
    const length = Math.max(1, Math.round(rate * (seconds + delay)));
    const buffer = this.#ctx.createBuffer(2, length, rate);
    let seed = 0x9e3779b9 ^ preset.length * 2654435761;
    const noise = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2147483648 - 1;
    };
    const start = Math.round(rate * delay);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = start; i < length; i++) data[i] = noise() * (1 - (i - start) / (length - start)) ** decay;
    }
    return buffer;
  }

  #duckStart(): void {
    this.#ducking++;
    if (this.#ducking === 1) this.#duck.gain.setTargetAtTime(this.#mix.duckLevel, this.#ctx.currentTime, DUCK_ATTACK / 3);
  }

  #duckEnd(): void {
    this.#ducking = Math.max(0, this.#ducking - 1);
    if (this.#ducking === 0) this.#duck.gain.setTargetAtTime(1, this.#ctx.currentTime, Math.max(MIN_FADE, this.#mix.duckRelease / 3));
  }

  // ── Voices ─────────────────────────────────────────────────────────────────

  #play(command: AudioPlay): void {
    const buffer = this.#soundBuffer(command.sound);
    if (buffer === null) return;
    const audible = command.volume * command.attenuation > 0;
    if (!command.loop && !audible) return;
    if (!this.#makeRoom(command)) return;
    const gain = this.#ctx.createGain();
    gain.gain.value = level(command.volume, command.attenuation, command.occlusion);
    const filter = this.#ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff(command.occlusion);
    const panner = this.#panner(command.position, command.pan);
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(this.#sfx);
    const voice: Voice = {
      id: command.voice, handle: command.sound.handle, loop: command.loop, duck: command.duck, startedAt: this.#ctx.currentTime + (command.delay ?? 0),
      source: null, gain, filter, panner, stopped: false,
    };
    this.#voices.set(voice.id, voice);
    if (voice.duck) this.#duckStart();
    const start = (buffer: AudioBuffer): void => {
      if (voice.stopped) return;
      if (!voice.loop && (this.#ctx.state !== 'running' || this.#ctx.currentTime - voice.startedAt > LATE_LIMIT)) {
        this.#forget(voice);
        return;
      }
      const source = this.#ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = voice.loop;
      source.playbackRate.value = command.pitch;
      source.connect(gain);
      source.onended = () => { if (this.#voices.get(voice.id) === voice) this.#forget(voice); };
      source.start(Math.max(this.#ctx.currentTime, voice.startedAt));
      voice.source = source;
    };
    if (!(buffer instanceof Promise)) start(buffer);
    else void buffer.then((ready) => { if (ready === null) this.#forget(voice); else start(ready); });
  }

  /** Stereo panner, or (HRTF mix, positional voice) an HRTF panner in the listener's frame. */
  #panner(position: AudioPosition | null, pan: number): StereoPannerNode | PannerNode {
    if (this.#mix.panning === 'hrtf' && position !== null) {
      const panner = this.#ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;
      this.#place(panner, position, false);
      return panner;
    }
    const panner = this.#ctx.createStereoPanner();
    panner.pan.value = pan;
    return panner;
  }

  #place(panner: PannerNode, position: AudioPosition, glide: boolean): void {
    const [x, y, z] = listenerSpace(position, this.#listener);
    const now = this.#ctx.currentTime;
    for (const [param, value] of [[panner.positionX, x], [panner.positionY, y], [panner.positionZ, z]] as const) {
      if (glide) param.setTargetAtTime(value, now, SMOOTHING);
      else param.value = value;
    }
  }

  /** Apply the voice limits; false = drop the new voice. */
  #makeRoom(command: AudioPlay): boolean {
    if (!command.loop) {
      const same = [...this.#voices.values()].filter((v) => !v.loop && v.handle === command.sound.handle);
      if (same.length >= this.#maxPerSound) this.#stop(same[0]!.id, MIN_FADE);
    }
    if (this.#voices.size < this.#maxVoices) return true;
    const oldestShot = [...this.#voices.values()].find((v) => !v.loop);
    if (oldestShot === undefined) return false;
    this.#stop(oldestShot.id, MIN_FADE);
    return true;
  }

  #update(command: AudioUpdate): void {
    const voice = this.#voices.get(command.voice);
    if (voice === undefined) return;
    const now = this.#ctx.currentTime;
    voice.gain.gain.setTargetAtTime(level(command.volume, command.attenuation, command.occlusion), now, SMOOTHING);
    voice.filter.frequency.setTargetAtTime(cutoff(command.occlusion), now, SMOOTHING * 3);
    if ('pan' in voice.panner) voice.panner.pan.setTargetAtTime(command.pan, now, SMOOTHING);
    else if (command.position !== null) this.#place(voice.panner, command.position, true);
    voice.source?.playbackRate.setTargetAtTime(command.pitch, now, SMOOTHING);
  }

  #stop(id: number, fade: number): void {
    const voice = this.#voices.get(id);
    if (voice === undefined) return;
    voice.stopped = true;
    this.#voices.delete(id);
    if (voice.duck) this.#duckEnd();
    const now = this.#ctx.currentTime;
    const seconds = Math.max(MIN_FADE, fade);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + seconds);
    voice.source?.stop(now + seconds);
  }

  #forget(voice: Voice): void {
    voice.stopped = true;
    if (this.#voices.get(voice.id) === voice) {
      this.#voices.delete(voice.id);
      if (voice.duck) this.#duckEnd();
    }
    voice.gain.disconnect();
    voice.filter.disconnect();
    voice.panner.disconnect();
  }

  // ── Music ──────────────────────────────────────────────────────────────────

  #changeMusic(command: AudioMusic): void {
    const now = this.#ctx.currentTime;
    const fade = Math.max(MIN_FADE, command.fade);
    const old = this.#music;
    const key = musicKey(command);
    // A music command starts its track playing; the engine re-sends a pause when it should hold.
    this.#musicPaused = false;
    if (key !== null && old !== null && old.handle === key) {
      if (old.paused) this.#holdMusic(old, false);
      old.volume = command.volume;
      this.#wantedMusic = old.handle;
      old.gain.gain.setTargetAtTime(command.volume, now, fade / 3);
      return;
    }
    if (old !== null) {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fade);
      old.source?.stop(now + fade);
      for (const layer of old.layers) layer.source.stop(now + fade);
      if (old.media !== null) setTimeout(() => old.media!.pause(), fade * 1000);
      this.#music = null;
    }
    this.#wantedMusic = key;
    if (command.track === null || key === null) return;
    const track: AudioSound = command.track;
    const layers = command.layers ?? [];
    if (track.synth !== undefined || layers.length > 0) {
      this.#startLayered(command, key, fade);
      return;
    }
    const file = track.file;
    if (file === null) return;
    const fadeIn = (gain: GainNode): void => {
      const at = this.#ctx.currentTime;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(command.volume, at + fade);
      gain.connect(this.#musicBus);
    };
    if (this.#streams(file, true)) {
      const media = this.#createMedia();
      media.crossOrigin = 'anonymous';
      media.src = this.#stream!(file)!;
      media.loop = true;
      media.preservesPitch = false;
      media.playbackRate = command.pitch;
      const gain = this.#ctx.createGain();
      this.#ctx.createMediaElementSource!(media as unknown as HTMLMediaElement).connect(gain);
      fadeIn(gain);
      this.#music = { handle: key, source: null, media, gain, layers: [], pitch: command.pitch, volume: command.volume, paused: false };
      media.play().catch((error: unknown) => {
        // Autoplay refused before a gesture: start it on resume.
        if ((error as Error)?.name !== 'NotAllowedError') this.#onError(file, error);
      });
      return;
    }
    const start = (buffer: AudioBuffer): void => {
      if (this.#wantedMusic !== key || this.#music !== null) return;
      const gain = this.#ctx.createGain();
      fadeIn(gain);
      const source = this.#ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.value = command.pitch;
      source.connect(gain);
      source.start();
      this.#music = { handle: key, source, media: null, gain, layers: [], pitch: command.pitch, volume: command.volume, paused: false };
      if (this.#musicPaused) this.#holdMusic(this.#music, true);
    };
    const ready = this.#ready.get(file);
    if (ready !== undefined) start(ready);
    else void this.#buffer(file).then((buffer) => { if (buffer !== null) start(buffer); });
  }

  /**
   * Layered (or synthesized) music: every buffer ready first, then the track and its stems
   * start at one context time, so the stems stay sample-locked for as long as they loop.
   */
  #startLayered(command: AudioMusic, key: string, fade: number): void {
    const sounds = [command.track!, ...(command.layers ?? []).map((l) => l.track)];
    const buffers = sounds.map((sound) => this.#soundBuffer(sound));
    if (buffers.some((b) => b === null)) return;
    void Promise.all(buffers).then((ready) => {
      if (this.#wantedMusic !== key || this.#music !== null || ready.some((b) => b === null)) return;
      const at = this.#ctx.currentTime + SMOOTHING;
      const gain = this.#ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(command.volume, at + fade);
      gain.connect(this.#musicBus);
      const loop = (buffer: AudioBuffer, into: GainNode): AudioBufferSourceNode => {
        const source = this.#ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.playbackRate.value = command.pitch;
        source.connect(into);
        source.start(at);
        return source;
      };
      const source = loop(ready[0]!, gain);
      const layers = (command.layers ?? []).map((layer, i) => {
        const g = this.#ctx.createGain();
        g.gain.value = layer.gain * layer.volume;
        g.connect(gain);
        return { source: loop(ready[i + 1]!, g), gain: g, volume: layer.volume };
      });
      this.#music = { handle: key, source, media: null, gain, layers, pitch: command.pitch, volume: command.volume, paused: false };
      if (this.#musicPaused) this.#holdMusic(this.#music, true);
    });
  }

  /** The layers' new gains, each ramped linearly from where it is over `fade`. */
  #musicGains(command: AudioMusicGains): void {
    const layers = this.#music?.layers ?? [];
    const now = this.#ctx.currentTime;
    layers.forEach((layer, i) => {
      const target = (command.gains[i] ?? 0) * layer.volume;
      layer.gain.gain.cancelScheduledValues(now);
      layer.gain.gain.setValueAtTime(layer.gain.gain.value, now);
      layer.gain.gain.linearRampToValueAtTime(target, now + Math.max(MIN_FADE, command.fade));
    });
  }

  /** Hold the slot where it is, or let it go on from there (a short dip either way: no click). */
  #holdMusic(slot: MusicSlot, paused: boolean): void {
    if (slot.paused === paused) return;
    slot.paused = paused;
    const now = this.#ctx.currentTime;
    const g = slot.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (paused) {
      g.linearRampToValueAtTime(0, now + PAUSE_FADE);
      const at = now + PAUSE_FADE;
      for (const source of [slot.source, ...slot.layers.map((l) => l.source)]) source?.playbackRate.setValueAtTime(0, at);
      if (slot.media !== null) {
        const media = slot.media;
        setTimeout(() => { if (slot.paused) media.pause(); }, PAUSE_FADE * 1000);
      }
      return;
    }
    for (const source of [slot.source, ...slot.layers.map((l) => l.source)]) {
      source?.playbackRate.cancelScheduledValues(now);
      source?.playbackRate.setValueAtTime(slot.pitch, now);
    }
    if (slot.media !== null) void slot.media.play().catch(() => {});
    g.linearRampToValueAtTime(slot.volume, now + PAUSE_FADE);
  }

  /** Whether the current music is held (for tests and tools). */
  get musicPaused(): boolean {
    return this.#music?.paused ?? this.#musicPaused;
  }

  /** A streamed track that autoplay refused: try again (boot calls this after `resume`). */
  retryMusic(): void {
    if (this.#music?.paused === true) return;
    void this.#music?.media?.play().catch(() => {});
  }
}
