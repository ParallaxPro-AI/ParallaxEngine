/**
 * A game's own synthesized sounds: `assets/sfx/<name>.synth.json` (or `assets/music/`) is a
 * sound file whose content is a SynthSpec (core/synth.ts) instead of a recording. Its handle
 * is `sfx/<name>`, so `Assets.sfx.<name>` names it like any other sound and audio.json gives
 * it defaults. It may start from a built-in preset and change some of it:
 *
 *   { "preset": "hit_metal", "gain": 0.6 }                       the preset, quieter
 *   { "duration": 0.3, "layers": [{ "wave": "square", "freq": 880, "freq_end": 220 }] }
 *
 * The built-ins are `synth/<name>` (SDK `Synth.<name>`, synth_presets.ts). Specs are checked
 * when the game loads (PP3513 with the file and the problem); a bad one never plays silently.
 */

import { closestMatch, fail, synthProblems } from '../../../core/index.js';
import type { ProjectFiles, SynthSpec } from '../../../core/index.js';
import { SYNTH_PRESET_NAMES, SYNTH_PRESETS } from './synth_presets.js';

/** `assets/sfx/laser.synth.json` → folder and name. */
export const SYNTH_FILE = /^assets\/(sfx|music)\/([^/.]+)\.synth\.json$/;
/** The built-ins' folder: `synth/hit_metal`. */
export const SYNTH_FOLDER = 'synth';

/** A built-in preset by name; an unknown one fails with the closest name. */
export function synthPreset(name: string, where: string): SynthSpec {
  const spec = SYNTH_PRESETS[name];
  if (spec === undefined) {
    const guess = closestMatch(name, SYNTH_PRESET_NAMES);
    fail('PP2063', `${where}: there is no built-in synth sound "${name}"`, {
      fix: guess !== undefined ? `Did you mean "synth/${guess}"?` : `Built-ins: ${SYNTH_PRESET_NAMES.join(', ')}.`,
    });
  }
  return spec;
}

/** One `.synth.json`'s text as a checked spec (its `preset`, if any, merged under it). */
export function readSynth(text: string, path: string): SynthSpec {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return fail('PP3513', `${path} is not valid JSON: ${(error as Error).message}`, { fix: 'Write the sound as a JSON object: {"duration": 0.3, "layers": [...]}.' });
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    fail('PP3513', `${path} must be a JSON object`, { fix: 'e.g. {"preset": "hit_metal"} or {"duration": 0.3, "layers": [{"wave": "sine", "freq": 440}]}.' });
  }
  const { preset, ...own } = doc as Record<string, unknown>;
  let spec: Record<string, unknown> = own;
  if (preset !== undefined) {
    if (typeof preset !== 'string') fail('PP3513', `${path}: "preset" must name a built-in synth sound`, { fix: `Built-ins: ${SYNTH_PRESET_NAMES.join(', ')}.` });
    spec = { ...synthPreset(preset, path) as unknown as Record<string, unknown>, ...own };
  }
  const [problem] = synthProblems(spec);
  if (problem !== undefined) {
    fail('PP3513', `${path}: ${problem}`, {
      fix: 'A synth sound is {"duration": seconds, "layers": [{"wave": "sine|square|saw|triangle|noise", ...}]}; see the audio reference.',
    });
  }
  return spec as unknown as SynthSpec;
}

/** Every `.synth.json` among the project's files, by handle (`sfx/laser`). */
export function loadSynths(files: ProjectFiles | undefined): Map<string, { readonly path: string; readonly spec: SynthSpec }> {
  const out = new Map<string, { path: string; spec: SynthSpec }>();
  if (files === undefined) return out;
  for (const path of files.list()) {
    const match = SYNTH_FILE.exec(path);
    if (match === null) continue;
    out.set(`${match[1]}/${match[2]}`, { path, spec: readSynth(files.read(path), path) });
  }
  return out;
}
