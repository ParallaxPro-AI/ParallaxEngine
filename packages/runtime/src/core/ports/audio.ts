/**
 * The audio port: what the audio plugin asks of the speakers. The engine decides
 * everything that must be deterministic — which sound, its volume and pitch (audio.json
 * defaults and their random variation), its distance attenuation and stereo pan relative to
 * the listener, music changes and the Settings bus volumes — and hands the result over
 * once per frame as plain data. An output only has to make it audible: the browser adapter
 * through Web Audio, the headless one by recording it for playtests.
 *
 * Commands are JSON-shaped on purpose: the same frame can be recorded, compared, or sent
 * from a server to its clients.
 */

import type { SynthSpec } from '../synth.js';

/** Settings volume buses. Every sound plays on `sfx`; tracks from `music/` on `music`. */
export type AudioBus = 'sfx' | 'music';

/** A sound or music track: its handle (`sfx/hit`, `music/title`) and the file it plays. */
export interface AudioSound {
  /** What `Assets.sfx.hit` names: folder and file name, no `assets/`, no extension. */
  readonly handle: string;
  /**
   * Project-relative file (`assets/sfx/hit.ogg`). Null when the game runs without its
   * asset files (playtests of data-only projects): the engine still checks the handle's
   * folder and form, and the output can record it but not play it.
   */
  readonly file: string | null;
  /**
   * A synthesized sound (a built-in `synth/<preset>`, or `assets/sfx/<name>.synth.json`): the
   * output renders it with `renderSynth` instead of loading a file (`file` is null).
   */
  readonly synth?: SynthSpec;
}

export type AudioPosition = readonly [number, number, number];

/** Start a voice. `volume`/`pitch` are final (defaults × call × variation), before the bus. */
export interface AudioPlay {
  readonly kind: 'play';
  /** Engine-assigned, unique for the output's lifetime; later commands name it. */
  readonly voice: number;
  readonly sound: AudioSound;
  readonly bus: AudioBus;
  readonly volume: number;
  /** Playback rate: 1 = as recorded, 2 = an octave up. */
  readonly pitch: number;
  readonly loop: boolean;
  /** World position the sound comes from; null for a non-positional sound. */
  readonly position: AudioPosition | null;
  /** 0..1 distance gain the engine computed for `position` (1 when non-positional). */
  readonly attenuation: number;
  /** -1 (left) .. 1 (right) (0 when non-positional). */
  readonly pan: number;
  /** A one-shot (`ctx.audio.play`, a plugin's), a voice of an entity's `AudioSource`, or a plugin's loop (rain). */
  readonly source: 'one_shot' | 'entity' | 'plugin';
  /** `to=`: the player id the sound is for; null = everyone. */
  readonly to: string | null;
  /** While it plays, the music ducks to the mix's `duckLevel` (dialogue, announcer lines). */
  readonly duck: boolean;
  /** 0..1: how much solid geometry is between the sound and the listener (1 = fully behind a wall). */
  readonly occlusion: number;
  /**
   * Seconds after the frame's `time` to start (a sound quantized to the beat clock); absent
   * or 0 = now. The output schedules it sample-accurately.
   */
  readonly delay?: number;
}

/** New parameters for a playing voice (looping `AudioSource`s track their entity). */
export interface AudioUpdate {
  readonly kind: 'update';
  readonly voice: number;
  readonly volume: number;
  readonly pitch: number;
  readonly position: AudioPosition | null;
  readonly attenuation: number;
  readonly pan: number;
  readonly occlusion: number;
}

export interface AudioStop {
  readonly kind: 'stop';
  readonly voice: number;
  /** Seconds to fade out over (0 = cut). */
  readonly fade: number;
}

/** Change the music: crossfade to `track` over `fade` seconds; null fades to silence. */
export interface AudioMusic {
  readonly kind: 'music';
  readonly track: AudioSound | null;
  /** The track's audio.json volume (variation drawn); 0 with no track. */
  readonly volume: number;
  readonly pitch: number;
  readonly fade: number;
  /**
   * Stems that play sample-locked with `track` (adaptive music): started together, each at
   * its own gain (0..1 × its audio.json `volume`), changed later by `music_gains`.
   */
  readonly layers?: readonly AudioMusicLayer[];
}

export interface AudioMusicLayer {
  readonly track: AudioSound;
  /** Its audio.json volume (variation drawn). */
  readonly volume: number;
  /** 0..1 now (the intensity's target for it). */
  readonly gain: number;
}

/** New gains for the current music's layers (index-aligned), ramped linearly over `fade` seconds. */
export interface AudioMusicGains {
  readonly kind: 'music_gains';
  readonly gains: readonly number[];
  readonly fade: number;
}

/**
 * Pause or resume the current music where it is (the game paused under a modal panel; a
 * track whose audio.json says `"pauses": false` is never paused). A new `music` command
 * starts its track playing: the engine re-sends a pause for it when it should be held.
 */
export interface AudioMusicPause {
  readonly kind: 'music_pause';
  readonly paused: boolean;
}

/** Settings volumes, 0..1 each. The heard level of a voice is master × its bus × its volume. */
export interface AudioBuses {
  readonly kind: 'buses';
  readonly master: number;
  readonly music: number;
  readonly sfx: number;
}

/** Reverb presets an output models (a convolver impulse each). */
export type ReverbPreset = 'room' | 'hall' | 'cave' | 'arena' | 'forest' | 'underwater';

/**
 * How the whole mix sounds, from the listener's `AudioListener` and the `ReverbZone` it is
 * in. Sent when it changes. `reverb.wet` is already blended by the listener's depth in the zone.
 */
export interface AudioMix {
  readonly kind: 'mix';
  readonly reverb: { readonly preset: ReverbPreset; readonly wet: number } | null;
  /** 'hrtf': positional voices are rendered binaurally from `position` and the listener's axes. */
  readonly panning: 'stereo' | 'hrtf';
  /** Music level (×) while a ducking voice plays, and seconds to come back after it ends. */
  readonly duckLevel: number;
  readonly duckRelease: number;
}

/** Stop every voice now (not the music): sent before a restored snapshot rebuilds them. */
export interface AudioStopAll {
  readonly kind: 'stop_all';
}

export type AudioCommand = AudioPlay | AudioUpdate | AudioStop | AudioMusic | AudioMusicGains | AudioMusicPause | AudioBuses | AudioMix | AudioStopAll;

/** Where the sound is heard from (the active camera), for outputs that want it. */
export interface AudioListener {
  readonly position: AudioPosition;
  /** Unit vector to the listener's right; the engine pans along it. */
  readonly right: AudioPosition;
  /** Unit vectors the listener faces and its up (HRTF panning needs the full frame). */
  readonly forward: AudioPosition;
  readonly up: AudioPosition;
}

/** One frame's audio: sent after the frame's UI, only when there is something to say. */
export interface AudioFrame {
  /** `kernel.time.frame` and wall seconds since the game started (`time.realNow`). */
  readonly frame: number;
  readonly time: number;
  readonly listener: AudioListener | null;
  readonly commands: readonly AudioCommand[];
}

/** The speakers. */
export interface AudioOutput {
  /** Every sound file the game may play, once at startup (and `ctx.audio.preload`): fetch and decode them ahead. */
  preload(files: readonly string[]): void;
  /** Files the game won't play for a while (`ctx.audio.unload`): free their decoded audio; a later play loads them again. */
  release(files: readonly string[]): void;
  submit(frame: AudioFrame): void;
}
