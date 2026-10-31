/**
 * `assets/audio.json`: per-sound default volume and pitch, each a number or a `[lo, hi]`
 * range picked from on every play (variation, so a repeated sound doesn't machine-gun).
 * The resource loader parses the file's shape; this checks the values make sense for
 * audio, and draws a play's levels from the plugin's seeded random source.
 *
 *   { "sfx/key_type": { "volume": [0.5, 0.75], "pitch": [0.96, 1.1] } }
 *
 * A call's own `volume=` / `pitch=` multiply the defaults. A sound without an entry plays
 * at volume 1, pitch 1.
 */

import { closestMatch, diagnostic, fail } from '../../../core/index.js';
import type { Diagnostic, SeededRandom } from '../../../core/index.js';
import type { AudioDefaults, AudioLevel } from '../../../resource/index.js';
import type { AudioCatalog } from './catalog.js';

const AUDIO_JSON = 'assets/audio.json';
/** Playback rates outside this are inaudible or broken in every browser. */
const PITCH_MIN = 0.0625;
const PITCH_MAX = 16;
/** Above this a default is almost certainly a percent or dB value written by mistake. */
const VOLUME_MAX = 4;

function levelProblem(level: AudioLevel, what: 'volume' | 'pitch'): string | undefined {
  const values = typeof level === 'number' ? [level] : [...level];
  if (!values.every(Number.isFinite)) return 'must be finite numbers';
  if (typeof level !== 'number' && level[0] > level[1]) return `is a range [lo, hi] with lo > hi (${level[0]} > ${level[1]})`;
  if (what === 'volume' && values.some((v) => v < 0 || v > VOLUME_MAX)) return `must be within 0..${VOLUME_MAX} (1 = as recorded)`;
  if (what === 'pitch' && values.some((v) => v < PITCH_MIN || v > PITCH_MAX)) {
    return `must be within ${PITCH_MIN}..${PITCH_MAX} (a playback rate: 1 = as recorded)`;
  }
  return undefined;
}

/**
 * Every problem with the defaults: values out of range, and (when the asset files are
 * known) entries naming a sound that doesn't exist.
 */
export function checkAudioDefaults(
  defaults: ReadonlyMap<string, AudioDefaults>, catalog: AudioCatalog,
): Diagnostic[] {
  const problems: Diagnostic[] = [];
  for (const [key, entry] of defaults) {
    for (const what of ['volume', 'pitch'] as const) {
      const level = entry[what];
      if (level === undefined) continue;
      const problem = levelProblem(level, what);
      if (problem !== undefined) {
        problems.push(diagnostic('PP3501', `audio.json "${key}" ${what} ${problem}`, {
          path: AUDIO_JSON, pointer: `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}/${what}`,
          fix: what === 'volume' ? 'Use a gain like 0.4, or a range like [0.3, 0.5].' : 'Use a rate like 1.1, or a range like [0.95, 1.05].',
        }));
      }
    }
    if (!catalog.has(key)) {
      const guess = closestMatch(key, catalog.handles());
      problems.push(diagnostic('PP2063', `audio.json has defaults for "${key}", which has no file under assets/`, {
        path: AUDIO_JSON, pointer: `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Add assets/${key}.ogg, or remove the entry.`,
      }));
    }
  }
  return problems;
}

/** The defaults, checked; the first problem fails with its diagnostic. */
export class AudioDefaultsTable {
  readonly #defaults: ReadonlyMap<string, AudioDefaults>;

  constructor(defaults: ReadonlyMap<string, AudioDefaults>, catalog: AudioCatalog) {
    const [first] = checkAudioDefaults(defaults, catalog);
    if (first !== undefined) fail(first.code, first.message, first);
    this.#defaults = defaults;
  }

  get(handle: string): AudioDefaults {
    return this.#defaults.get(handle) ?? {};
  }

  /** The sounds in a bank, in audio.json order. */
  bank(name: string): string[] {
    return [...this.#defaults].filter(([, d]) => d.bank === name).map(([handle]) => handle);
  }

  /** The mix groups audio.json names, in file order. */
  groups(): string[] {
    return [...new Set([...this.#defaults.values()].flatMap((d) => (d.group === undefined ? [] : [d.group])))];
  }

  banks(): string[] {
    return [...new Set([...this.#defaults.values()].flatMap((d) => (d.bank === undefined ? [] : [d.bank])))];
  }

  /**
   * One play's default levels. A range draws from `random` (volume first, then pitch); a
   * fixed level draws nothing, so adding variation to one sound never shifts another's.
   */
  draw(handle: string, random: SeededRandom): { volume: number; pitch: number } {
    const entry = this.get(handle);
    return { volume: pick(entry.volume ?? 1, random), pitch: pick(entry.pitch ?? 1, random) };
  }
}

function pick(level: AudioLevel, random: SeededRandom): number {
  if (typeof level === 'number') return level;
  const [lo, hi] = level;
  return lo === hi ? lo : lo + (hi - lo) * random.next();
}
