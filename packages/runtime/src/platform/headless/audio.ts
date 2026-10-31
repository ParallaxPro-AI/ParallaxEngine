/**
 * Headless audio: records every frame the engine sends, and keeps a model of what would
 * be audible — which voices are playing, the music, the bus volumes — so playtests can
 * assert "the jump sound played at the player, at volume 0.3" or "the boss music is on".
 * Deterministic: it only reflects what the engine decided. A synthesized sound can be
 * measured too: `render(play)` is its PCM (core/synth.ts) and `stats(play)` its peak and RMS —
 * how a playtest asserts a sound is audible, since nothing headless can hear it.
 */

import { renderSynth, synthStats } from '../../core/index.js';
import type {
  AudioBuses, AudioCommand, AudioFrame, AudioListener, AudioMix, AudioOutput, AudioPlay, AudioPosition, AudioSound, SynthSpec, SynthStats,
} from '../../core/index.js';

/** One started voice, as a playtest reads it. */
export interface RecordedPlay {
  readonly frame: number;
  readonly time: number;
  readonly voice: number;
  /** `sfx/jump`. */
  readonly sound: string;
  readonly file: string | null;
  readonly volume: number;
  readonly pitch: number;
  readonly position: AudioPosition | null;
  readonly attenuation: number;
  readonly pan: number;
  readonly loop: boolean;
  readonly source: AudioPlay['source'];
  readonly to: string | null;
  readonly duck: boolean;
  readonly occlusion: number;
  /** Seconds after the frame's time it starts (quantized to the beat); 0 = at once. */
  readonly delay: number;
  /** The synthesized sound's spec (a `synth/` built-in or a `.synth.json`), if it is one. */
  readonly synth: SynthSpec | null;
}

export interface RecordedMusic {
  readonly frame: number;
  readonly time: number;
  /** `music/title`, or null for silence. */
  readonly track: string | null;
  readonly volume: number;
  readonly fade: number;
  /** Stems playing with it, as `music/<name>` handles (absent: none). */
  readonly layers?: readonly string[];
}

/** A stem of the current music and its gain (0..1, the target it ramps to). */
export interface MusicLayerState {
  readonly track: string;
  readonly volume: number;
  readonly gain: number;
}

/** A looping voice still playing (started, not stopped), with its latest parameters. */
export interface ActiveVoice {
  readonly voice: number;
  readonly sound: string;
  readonly loop: boolean;
  readonly volume: number;
  readonly pitch: number;
  readonly position: AudioPosition | null;
  readonly attenuation: number;
  readonly pan: number;
  readonly occlusion: number;
}

const NEUTRAL: Omit<AudioMix, 'kind'> = { reverb: null, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 };

export class HeadlessAudio implements AudioOutput {
  /** Every frame received, in order. */
  readonly frames: AudioFrame[] = [];
  readonly plays: RecordedPlay[] = [];
  readonly musicChanges: RecordedMusic[] = [];
  /** Files fetched ahead: at startup and by `ctx.audio.preload`, minus those released since. */
  preloaded: readonly string[] = [];
  /** Every `release` call's files, in order. */
  readonly released: string[][] = [];
  #mix: Omit<AudioMix, 'kind'> = NEUTRAL;
  #buses: Omit<AudioBuses, 'kind'> = { master: 1, music: 1, sfx: 1 };
  #music: AudioSound | null = null;
  #musicPaused = false;
  /** Every `music_pause` received: when the music was held (true) or resumed (false). */
  readonly musicPauses: { readonly frame: number; readonly time: number; readonly paused: boolean }[] = [];
  #layers: MusicLayerState[] = [];
  #listener: AudioListener | null = null;
  readonly #active = new Map<number, ActiveVoice>();

  preload(files: readonly string[]): void {
    this.preloaded = [...new Set([...this.preloaded, ...files])];
  }

  release(files: readonly string[]): void {
    this.released.push([...files]);
    this.preloaded = this.preloaded.filter((f) => !files.includes(f));
  }

  /** The mix now: the reverb heard, panning, ducking settings. */
  get mix(): Omit<AudioMix, 'kind'> {
    return this.#mix;
  }


  submit(frame: AudioFrame): void {
    this.frames.push(frame);
    this.#listener = frame.listener;
    for (const command of frame.commands) this.#apply(frame, command);
  }

  /** Handles of the sounds started (one-shots and entity voices), in order; optionally since a frame. */
  played(sinceFrame = 0): string[] {
    return this.plays.filter((p) => p.frame >= sinceFrame).map((p) => p.sound);
  }

  /** The plays of one sound. */
  playsOf(sound: string): RecordedPlay[] {
    return this.plays.filter((p) => p.sound === sound);
  }

  /** The current music track handle (null = silence). */
  get music(): string | null {
    return this.#music?.handle ?? null;
  }

  /** Whether the current music is held where it is (the game is paused). */
  get musicPaused(): boolean {
    return this.#musicPaused;
  }

  /** The current music's stems and their gains. */
  get musicLayers(): readonly MusicLayerState[] {
    return this.#layers;
  }

  /** A synthesized play's samples (null for a recording). */
  render(play: RecordedPlay, sampleRate?: number): Float32Array | null {
    return play.synth === null ? null : renderSynth(play.synth, sampleRate);
  }

  /** A synthesized play's peak, RMS and audible fraction (null for a recording). */
  stats(play: RecordedPlay): SynthStats | null {
    const pcm = this.render(play);
    return pcm === null ? null : synthStats(pcm);
  }

  get buses(): Omit<AudioBuses, 'kind'> {
    return this.#buses;
  }

  get listener(): AudioListener | null {
    return this.#listener;
  }

  /**
   * Looping voices playing now (engines, ambience: what a playtest checks is on). A
   * recorder cannot know a file's length, so non-looping voices are only in `plays`.
   */
  get loops(): ActiveVoice[] {
    return [...this.#active.values()];
  }

  /** The level a voice would be heard at: master × bus × volume × attenuation. */
  heard(voice: ActiveVoice | RecordedPlay): number {
    return this.#buses.master * this.#buses.sfx * voice.volume * voice.attenuation;
  }

  /** Forget the recording (not the current state). */
  clear(): void {
    this.frames.length = 0;
    this.plays.length = 0;
    this.musicChanges.length = 0;
    this.musicPauses.length = 0;
  }

  #apply(frame: AudioFrame, command: AudioCommand): void {
    switch (command.kind) {
      case 'play': {
        const { voice, sound, volume, pitch, position, attenuation, pan, loop, source, to, duck, occlusion } = command;
        this.plays.push({
          frame: frame.frame, time: frame.time, voice, sound: sound.handle, file: sound.file, volume, pitch, position,
          attenuation, pan, loop, source, to, duck, occlusion, delay: command.delay ?? 0, synth: sound.synth ?? null,
        });
        if (loop) this.#active.set(voice, { voice, sound: sound.handle, loop, volume, pitch, position, attenuation, pan, occlusion });
        return;
      }
      case 'update': {
        const voice = this.#active.get(command.voice);
        if (voice === undefined) return;
        const { volume, pitch, position, attenuation, pan, occlusion } = command;
        this.#active.set(command.voice, { ...voice, volume, pitch, position, attenuation, pan, occlusion });
        return;
      }
      case 'stop':
        this.#active.delete(command.voice);
        return;
      case 'stop_all':
        this.#active.clear();
        return;
      case 'music':
        this.#music = command.track;
        this.#musicPaused = false;
        this.#layers = (command.layers ?? []).map((l) => ({ track: l.track.handle, volume: l.volume, gain: l.gain }));
        this.musicChanges.push({
          frame: frame.frame, time: frame.time, track: command.track?.handle ?? null, volume: command.volume, fade: command.fade,
          ...(this.#layers.length > 0 && { layers: this.#layers.map((l) => l.track) }),
        });
        return;
      case 'music_pause':
        this.#musicPaused = command.paused;
        this.musicPauses.push({ frame: frame.frame, time: frame.time, paused: command.paused });
        return;
      case 'music_gains':
        this.#layers = this.#layers.map((l, i) => ({ ...l, gain: command.gains[i] ?? l.gain }));
        return;
      case 'buses':
        this.#buses = { master: command.master, music: command.music, sfx: command.sfx };
        return;
      case 'mix': {
        const { reverb, panning, duckLevel, duckRelease } = command;
        this.#mix = { reverb, panning, duckLevel, duckRelease };
        return;
      }
    }
  }
}
