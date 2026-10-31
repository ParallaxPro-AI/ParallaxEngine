/**
 * The `audio` service: sounds other plugins play themselves — the weather's thunder and
 * rain, the water's splashes — through the audio plugin (core: every game has it).
 * Which sound to play is always the game's data (a scene or component key naming a
 * sound); a plugin whose sound isn't configured plays nothing.
 *
 * A plugin's sounds are local to the machine that makes them: unlike `ctx.audio.play` on
 * a net server, they are not forwarded to clients (each machine's plugins make their own:
 * clients follow the weather and receive the water's splashes, and play them there).
 */

import type { Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface PluginSound {
  /** As written in the game's data: `sfx/thunder`, `assets/sfx/thunder.ogg`. */
  readonly sound: string;
  /** A world point, or null / absent: non-positional. */
  readonly at?: Vec3 | null;
  /** × the sound's audio.json level (default 1). */
  readonly volume?: number;
  readonly pitch?: number;
  /** Which Settings volume it follows (default 'sfx'). */
  readonly bus?: 'sfx' | 'music';
  /** Duck the music while it plays. */
  readonly duck?: boolean;
}

export interface AudioService {
  /** A one-shot. */
  play(sound: PluginSound): void;
  /**
   * Start a loop under `key` (e.g. "weather.rain"), or update its level and position if
   * it plays already (a different sound restarts it). It plays until `stop(key)`.
   */
  loop(key: string, sound: PluginSound): void;
  /** Stop the loop under `key` over `fade` seconds (default 0.5); nothing when none plays. */
  stop(key: string, fade?: number): void;
  /**
   * Override the scene's music with `track` (as written in data: `assets/music/boss.ogg`),
   * crossfading over `fade` seconds; null fades back to the scene's own (`ctx.audio.music`).
   */
  music?(track: string | null, fade: number): void;
}

export const AUDIO_SERVICE: ServiceKey<AudioService> = serviceKey<AudioService>(
  'audio', 'The audio plugin is core: build the game through createRuntime, which includes it.',
);
