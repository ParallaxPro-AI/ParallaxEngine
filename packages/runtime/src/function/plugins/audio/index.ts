/**
 * audio — sound effects, music and looping entity sounds (SDK
 * `AudioApi`, `AudioSource`, `SoundRef`/`MusicRef`, `Settings` volumes). Core: every game
 * has it. It reaches the speakers only through core's `AudioOutput` port; the headless
 * adapter records, the browser one plays through Web Audio.
 *
 * Contributes `ctx.audio` and per-frame work in the 'render' hook (after the UI, so a
 * panel's button sound is in the same frame); the beat clock's `beat` events are emitted in
 * the 'input' hook, so the frame's game code hears them. Synthesized sounds (synth_presets.ts,
 * synths.ts), layered music (stems.ts), the beat clock (transport.ts), the voice budget
 * (voices.ts) and the world's ambience (ambience.ts) are the engine's parts beyond files. The `audio_source` component it plays is
 * defined by the visuals plugin and read here by id; `Settings` is the api's built-in
 * resource. Levels vary through the plugin's own seeded random source, saved in snapshots.
 *
 * One `audio(...)` value serves one kernel.
 */

import { fail } from '../../../core/index.js';
import type { AudioOutput, EntityId, ProjectFiles } from '../../../core/index.js';
import type { AudioDefaults } from '../../../resource/index.js';
import type { EventDef, Kernel, KernelPlugin } from '../../kernel/index.js';
import { AUDIO_SERVICE } from '../../services/index.js';
import { AudioEngine, BEAT_EVENT, THUNDER_EVENT } from './engine.js';
import type { MusicOptions, PlayRequest } from './engine.js';
import { SPATIAL_2D, SPATIAL_3D } from './spatial.js';
import { MIX_COMPONENTS } from './mix.js';
import type { SpatialOptions } from './spatial.js';

export { AudioCatalog, audioHandle } from './catalog.js';
export type { AudioFolder } from './catalog.js';
export { AudioDefaultsTable, checkAudioDefaults } from './defaults.js';
export { AUDIO_SOURCE, AudioEngine, BEAT_EVENT, CAMERA, THUNDER_EVENT, IMPACT_FULL_SPEED, IMPACT_LIMIT, IMPACT_WINDOW, checkFade, checkPitch, checkVolume, firstCamera, SCENE_MUSIC_FADE, SETTINGS } from './engine.js';
export type { ForwardedSound, MusicLayerRequest, MusicOptions, PlayRequest } from './engine.js';
export { AMBIENCE_KEYS, ambienceLoops, nearestOnArea, nearestOnCourse, sceneWeatherSounds, thunderClap } from './ambience.js';
export { layerGain, layerGains, rampGain } from './stems.js';
export { loadSynths, readSynth, SYNTH_FILE, synthPreset } from './synths.js';
export { SYNTH_PRESET_NAMES, SYNTH_PRESETS } from './synth_presets.js';
export * from './transport.js';
export { DEFAULT_MAX_VOICES, DEFAULT_PRIORITY, ONE_SHOT_SECONDS, VoiceBudget, voiceScore } from './voices.js';
export type { Contender, VoiceStats } from './voices.js';
export { SPATIAL_2D, SPATIAL_3D, spatialize } from './spatial.js';
export {
  AUDIO_LISTENER, AUDIO_LISTENER_SCHEMA, dopplerFactor, MIX_COMPONENTS, NEUTRAL_MIX, OCCLUSION_EVERY, occlusionBetween, REVERB_PRESETS,
  REVERB_ZONE, REVERB_ZONE_SCHEMA, reverbAt,
} from './mix.js';
export type { ListenerSettings, Zone } from './mix.js';
export type { SpatialOptions, Spatialized } from './spatial.js';

/** `ctx.audio` at the kernel level: plain values (the api layer binds Python arguments). */
export interface AudioNamespace {
  play(request: PlayRequest): void;
  music(track: string | null, fade: number, options?: MusicOptions): void;
  setIntensity(value: number, fade?: number): void;
  setTempo(bpm: number, beatsPerBar?: number): void;
  readonly intensity: number;
  readonly beat: number | null;
  preload(sounds: readonly string[]): void;
  unload(sounds: readonly string[]): void;
  /** Play surface materials' impact sounds (default true). */
  impact_sounds: boolean;
  /** Synthesize the world's ambience from the weather, wind and water plugins (default true). */
  ambience: boolean;
  max_voices: number;
}

/** The physics plugins' event, by id (audio hears it without importing them). */
export const IMPACT_EVENT = 'impact';

export interface AudioOptions {
  /** The speakers: `HeadlessAudio` in tests, `WebAudioOutput` in a browser. */
  readonly output: AudioOutput;
  /**
   * The project's file paths (`ProjectFiles.list()`); sound files are found under
   * assets/sfx/ and assets/music/. `null` = the asset files aren't available (data-only
   * playtests): references are still checked for form and folder.
   */
  readonly assets: readonly string[] | null;
  /** Whether hosted sound URLs are fetched (a browser); default false: they play silently. */
  readonly remoteAssets?: boolean;
  /** `Project.audio` (assets/audio.json). */
  readonly defaults: ReadonlyMap<string, AudioDefaults>;
  /** Seed of the variation random source (independent of the game's `random`). */
  readonly seed: number;
  /** The game's mode: 2D measures sound distance in the x/y plane. */
  readonly mode: '2d' | '3d';
  /** Distance model; default `SPATIAL_2D` / `SPATIAL_3D` by mode. */
  readonly spatial?: SpatialOptions;
  /**
   * The listener entity (the active camera). Default: the first live entity with a
   * `camera` component. The api passes the visuals plugin's active camera when it has one.
   */
  readonly listener?: (kernel: Kernel) => EntityId | null;
  /** The `ctx.audio` object game code sees; default the plain `AudioNamespace`. */
  readonly namespace?: (engine: AudioEngine) => object;
  /** The project's files: `assets/sfx/<name>.synth.json` sounds are read from them. */
  readonly files?: ProjectFiles;
  /** Whether the game is paused now: the music holds (audio.json `"pauses": false` opts a track out). Default: never. */
  readonly paused?: (kernel: Kernel) => boolean;
}

export function audio(options: AudioOptions): KernelPlugin & { readonly engine: AudioEngine } {
  if (!Number.isInteger(options.seed)) fail('PP3503', `audio seed must be an integer, got ${options.seed}`);
  if (options.mode !== '2d' && options.mode !== '3d') fail('PP3503', `audio mode must be "2d" or "3d", got ${String(options.mode)}`);
  const spatial = options.spatial ?? (options.mode === '2d' ? SPATIAL_2D : SPATIAL_3D);
  if (!(spatial.near > 0 && spatial.far > spatial.near)) {
    fail('PP3503', `audio spatial distances must satisfy 0 < near < far, got near ${spatial.near}, far ${spatial.far}`);
  }
  let engine: AudioEngine | undefined;
  // The physics plugin defines the `impact` event; the kernel matches handlers by the
  // definition itself, so it is looked up in the registry once installed (none: never heard).
  let impact: EventDef = { id: IMPACT_EVENT };
  // The weather plugin's `thunder`, likewise: ambience answers it with a synthesized clap.
  let thunder: EventDef = { id: THUNDER_EVENT };
  const current = (): AudioEngine => {
    if (engine === undefined) fail('PP9509', 'The audio plugin is used before its kernel was built');
    return engine;
  };

  return {
    id: 'audio',
    components: MIX_COMPONENTS,
    events: [BEAT_EVENT],
    systems: [{
      // Engine-internal: materials' impact sounds, and the weather's thunder.
      id: 'engine_audio_impacts',
      scenes: [],
      handlers: [
        { get event() { return impact; }, method: 'impact', always: true },
        { get event() { return thunder; }, method: 'thunder', always: true },
      ],
      create: () => ({
        impact: (_ctx: unknown, payload: Record<string, unknown>) => { current().impact(payload); },
        thunder: (_ctx: unknown, payload: Record<string, unknown>) => { current().thunder(payload); },
      }),
    }],
    get engine(): AudioEngine { return current(); },
    install(kernel) {
      if (engine !== undefined) {
        fail('PP9514', 'This audio plugin is already installed in another kernel', { fix: 'Call audio(...) once per kernel.' });
      }
      const created = new AudioEngine(kernel, {
        output: options.output, assets: options.assets, ...(options.remoteAssets !== undefined && { remoteAssets: options.remoteAssets }), defaults: options.defaults, seed: options.seed, mode: options.mode,
        spatial, listener: options.listener, ...(options.files !== undefined && { files: options.files }),
        ...(options.paused !== undefined && { paused: options.paused }),
      });
      engine = created;
      kernel.provide(AUDIO_SERVICE, created);
      impact = kernel.registry.events.get(IMPACT_EVENT) ?? impact;
      thunder = kernel.registry.events.get(THUNDER_EVENT) ?? thunder;
      kernel.observeScenes({ loading: (scene) => created.sceneLoading(scene.music, scene.id, scene.environment, scene.musicVolume) });
      kernel.addHook('input', () => created.tick());
      kernel.observeEntities({
        added: (records) => created.entitiesAdded(records),
        removed: (records) => created.entitiesRemoved(records),
        changed: (record) => created.entityChanged(record),
      });
      kernel.addHook('render', () => created.flush());
    },
    // Hot reload: the old runtime's sounds and music stop before the new one plays.
    dispose: () => engine?.dispose(),
    snapshot: () => current().snapshot(),
    restore: (_kernel, state) => current().restore(state),
    namespace: {
      name: 'audio',
      create: () => {
        const e = current();
        if (options.namespace !== undefined) return options.namespace(e);
        const plain: AudioNamespace = {
          play: (request) => e.play(request),
          music: (track, fade, musicOptions) => e.music(track, fade, musicOptions),
          setIntensity: (value, fade) => e.setIntensity(value, fade),
          setTempo: (bpm, beatsPerBar) => e.setTempo(bpm, beatsPerBar),
          get intensity() { return e.intensity; },
          get beat() { return e.beat; },
          get ambience() { return e.ambience; },
          set ambience(on: boolean) { e.ambience = on; },
          get max_voices() { return e.maxVoices; },
          set max_voices(n: number) { e.maxVoices = n; },
          preload: (sounds) => e.preload(sounds),
          unload: (sounds) => e.unload(sounds),
          get impact_sounds() { return e.impactSounds; },
          set impact_sounds(on: boolean) { e.impactSounds = on; },
        };
        return plain;
      },
    },
  };
}
