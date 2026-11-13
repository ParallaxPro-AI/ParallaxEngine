/**
 * Synth sound files are read by check as the game reads them: a bad one is PP3513 at check
 * time instead of when the game loads. Over the paddle duel example (read-only), with files
 * added in memory.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/paddle_duel', import.meta.url));

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(DIR);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

function synthCodes(add: Record<string, string>): string[] {
  const result = checkFiles(memoryFiles({ ...files, ...add }), structuredClone(declarations), { assetFiles: false });
  return result.diagnostics.filter((d) => d.code === 'PP3513').map((d) => d.path ?? '');
}

describe('synth sound files', () => {
  it('a valid sound and a preset are clean', () => {
    expect(synthCodes({
      'assets/sfx/blip.synth.json': JSON.stringify({ duration: 0.2, layers: [{ wave: 'sine', freq: 660 }] }),
      'assets/music/hum.synth.json': JSON.stringify({ preset: 'bell', gain: 0.5 }),
    })).toEqual([]);
  });

  it('an unknown key, a value out of range or bad JSON is PP3513 at the file', () => {
    expect(synthCodes({
      'assets/sfx/smoke.synth.json': JSON.stringify({ extends: 'effect/smoke', rate: 5 }),
      'assets/sfx/ding.synth.json': JSON.stringify({ duration: 0, layers: [{ wave: 'sine', freq: 660 }] }),
      'assets/music/broken.synth.json': '{ "duration": ',
    }).sort()).toEqual(['assets/music/broken.synth.json', 'assets/sfx/ding.synth.json', 'assets/sfx/smoke.synth.json']);
  });
});
