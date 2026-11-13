/**
 * Synthesized sound files (`assets/sfx/<name>.synth.json`, `assets/music/<name>.synth.json`)
 * through the audio plugin's own reader, so check reports what the game would otherwise
 * fail with when it loads (PP3513: bad JSON, unknown keys, out-of-range values, an unknown
 * preset) with the file and the problem.
 */

import { ParallaxError } from '@parallax/runtime/core';
import { readSynth, SYNTH_FILE } from '@parallax/runtime/plugins/audio';
import type { CheckContext } from './context.js';

export function checkSynths(ctx: CheckContext): void {
  for (const path of ctx.files.all()) {
    if (!SYNTH_FILE.test(path)) continue;
    try {
      readSynth(ctx.files.read(path), path);
    } catch (e) {
      if (!(e instanceof ParallaxError)) throw e;
      const d = e.diagnostic;
      ctx.report(d.code, d.message, { path, ...(d.fix !== undefined && { fix: d.fix }) });
    }
  }
}
