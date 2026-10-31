/**
 * Character and viewmodel data checks over a real example (read-only): the FPS example's
 * player with humanoid abilities set in memory, broken one rule at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/fps_shooter', import.meta.url));
const PLAYER = 'prefabs/player.prefab.json';

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

function withPlayer(character: Record<string, unknown>, extra: Record<string, unknown> = {}): readonly Diagnostic[] {
  const player = JSON.parse(files[PLAYER]!) as { components: Record<string, Record<string, unknown>> };
  Object.assign(player.components['character']!, character);
  Object.assign(player.components, extra);
  return checkFiles(memoryFiles({ ...files, [PLAYER]: JSON.stringify(player) }), declarations, { assetFiles: false }).diagnostics;
}

const CODES = /^PP(317[6-9]|3180|3199|3873|410[0-9])$/;

function brief(found: readonly Diagnostic[]): string[] {
  return found.filter((d) => CODES.test(d.code)).map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('character checks', () => {
  it('accepts the humanoid abilities with their defaults and tuned values', () => {
    expect(brief(withPlayer({ stances: { prone: true }, traversal: { climb_height: 2.2 }, swim: {}, skydive: {}, parachute: {}, carry: {} }))).toEqual([]);
  });

  it('reports the rules between fields, at their pointers', () => {
    expect(brief(withPlayer({
      eye_height: 2, stances: { crouch_height: 0.5 }, swim: { exit_depth: 1.5 }, parachute: {}, traversal: { vault_height: 3 },
    }))).toEqual([
      'PP3199 /components/character/eye_height',
      'PP3177 /components/character/stances/crouch_height',
      'PP3178 /components/character/swim/exit_depth',
      'PP3178 /components/character/swim/float_depth',
      'PP3179 /components/character/parachute',
      'PP3180 /components/character/traversal/vault_height',
    ].sort((a, b) => a.split(' ')[1]!.localeCompare(b.split(' ')[1]!)));
  });

  it('schema errors still come from the schema (an unknown record field)', () => {
    const found = withPlayer({ stances: { crouch: 1 } });
    expect(found.some((d) => d.pointer?.startsWith('/components/character/stances') === true && d.severity === 'error')).toBe(true);
  });

  it('a declared Animator param of the wrong kind for the character is PP3176', () => {
    expect(brief(withPlayer({}, { animator: { params: { speed: 0, grounded: 0, jumped: 'trigger' } } })))
      .toEqual(['PP3176 /components/animator/params/grounded']);
    expect(brief(withPlayer({ animate: false }, { animator: { params: { grounded: 0 } } }))).toEqual([]);
  });

  it('viewmodel_item grips are two sockets', () => {
    expect(brief(withPlayer({}, { viewmodel_item: { grips: ['grip_r'] } }))).toEqual(['PP3873 /components/viewmodel_item/grips']);
  });
});
