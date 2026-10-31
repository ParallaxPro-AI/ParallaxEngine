/**
 * Voice management: how many sounds are heard at once, and which give way. Decided by the
 * engine — deterministic, the same in a recording as in the browser — not by the speakers.
 *
 *   budget     at most `max` voices are audible (`ctx.audio.max_voices`, default 32): one-shots
 *              while they last, plus looping voices (AudioSources, plugin loops, ambience).
 *              Music is not counted.
 *   priority   each sound's audio.json `priority` (default 64, higher wins), then how loud it
 *              is heard (volume × distance attenuation), then age (the older one stays).
 *   one-shots  a new one beyond its sound's audio.json `limit` stops the oldest of that sound;
 *              beyond the budget it stops the weakest one-shot if it outranks it, or is not
 *              started at all (counted in `stats.dropped`).
 *   loops      ranked every frame: the strongest that fit next to the live one-shots are
 *              real, the rest virtual — still running, at volume 0, so they come back in step
 *              when room frees (a crowd of engines; the nearest are heard).
 *
 * The engine never decodes a recording, so a recorded one-shot "lasts" ONE_SHOT_SECONDS for
 * the budget; a synthesized one lasts exactly its duration (÷ pitch).
 */

export const DEFAULT_MAX_VOICES = 32;
export const DEFAULT_PRIORITY = 64;
/** How long a recorded one-shot counts toward the budget. */
export const ONE_SHOT_SECONDS = 2;

export interface Contender {
  readonly voice: number;
  readonly priority: number;
  /** 0..1: volume × attenuation as heard. */
  readonly audibility: number;
}

interface LiveShot extends Contender {
  readonly sound: string;
  readonly ends: number;
}

export interface VoiceStats {
  /** One-shots counted as playing now. */
  readonly oneShots: number;
  /** Looping voices heard / held silent last frame. */
  readonly real: number;
  readonly virtual: number;
  /** One-shots never started because the budget was full of stronger sounds. */
  readonly dropped: number;
  /** One-shots stopped early to make room (their sound's limit, or a stronger sound). */
  readonly stolen: number;
}

/** Rank: priority first, then loudness, then the older voice (lower id). */
export function voiceScore(c: Contender): number {
  return c.priority * 1000 + Math.max(0, Math.min(1, c.audibility)) * 100 - c.voice * 1e-7;
}

export class VoiceBudget {
  max = DEFAULT_MAX_VOICES;
  #shots: LiveShot[] = [];
  #real = 0;
  #virtual = 0;
  #dropped = 0;
  #stolen = 0;

  /**
   * Admit a new one-shot at `now`. Returns whether it starts, and the voices to stop for it
   * (one-shots only; looping voices give way through `rank`).
   */
  admit(shot: Contender & { readonly sound: string; readonly ends: number; readonly limit: number | undefined }, now: number, loops: readonly Contender[]):
    { readonly start: boolean; readonly stop: readonly number[] } {
    this.#shots = this.#shots.filter((s) => s.ends > now);
    const stop: number[] = [];
    if (shot.limit !== undefined) {
      const same = this.#shots.filter((s) => s.sound === shot.sound);
      for (const old of same.slice(0, Math.max(0, same.length - shot.limit + 1))) {
        stop.push(old.voice);
        this.#shots = this.#shots.filter((s) => s !== old);
      }
    }
    const loud = loops.filter((l) => l.audibility > 0);
    if (this.#shots.length + Math.min(loud.length, this.max) >= this.max) {
      const strongest = [...loud].sort((a, b) => voiceScore(b) - voiceScore(a)).slice(0, Math.max(0, this.max - this.#shots.length));
      const weakest = [...this.#shots, ...strongest].reduce<Contender | undefined>(
        (w, c) => (w === undefined || voiceScore(c) < voiceScore(w) ? c : w), undefined,
      );
      if (weakest === undefined || voiceScore(shot) <= voiceScore(weakest)) {
        this.#dropped++;
        this.#stolen += stop.length;
        return { start: false, stop };
      }
      const victim = this.#shots.find((s) => s.voice === weakest.voice);
      if (victim !== undefined) {
        stop.push(victim.voice);
        this.#shots = this.#shots.filter((s) => s !== victim);
      }
    }
    this.#stolen += stop.length;
    this.#shots.push({ voice: shot.voice, priority: shot.priority, audibility: shot.audibility, sound: shot.sound, ends: shot.ends });
    return { start: true, stop };
  }

  /** The looping voices that are virtual this frame (the rest are heard). */
  rank(loops: readonly Contender[], now: number): Set<number> {
    this.#shots = this.#shots.filter((s) => s.ends > now);
    const slots = Math.max(0, this.max - this.#shots.length);
    const ordered = [...loops].sort((a, b) => voiceScore(b) - voiceScore(a));
    const virtual = new Set(ordered.slice(slots).map((c) => c.voice));
    this.#real = ordered.length - virtual.size;
    this.#virtual = virtual.size;
    return virtual;
  }

  /** A one-shot that ended early (stopped by the game or a restore). */
  forget(voice: number): void {
    this.#shots = this.#shots.filter((s) => s.voice !== voice);
  }

  clear(): void {
    this.#shots = [];
  }

  get stats(): VoiceStats {
    return { oneShots: this.#shots.length, real: this.#real, virtual: this.#virtual, dropped: this.#dropped, stolen: this.#stolen };
  }
}
