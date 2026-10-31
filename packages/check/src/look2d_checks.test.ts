/**
 * 2D look warnings over the maze chase example (read-only): a finished 2D game of SVG sprites
 * and effects, which must stay quiet, then plain characters, imageless games, missing effects,
 * a missing background and built-in 3D effects introduced in memory one at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/maze_chase', import.meta.url));
const FEEDBACK = 'game/systems/feedback.py';

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

/** Look diagnostics (and built-in effect errors) after adding / replacing files (null removes one). */
function look(add: Record<string, string | null> = {}, decl: (d: Declarations) => Declarations = (d) => d): readonly Diagnostic[] {
  const all: Record<string, string> = { ...files };
  for (const [path, text] of Object.entries(add)) {
    if (text === null) delete all[path];
    else all[path] = text;
  }
  return checkFiles(memoryFiles(all), decl(structuredClone(declarations)), { assetFiles: false }).diagnostics
    .filter((d) => /^PP221\d$/.test(d.code) || (d.code === 'PP2063' && /built-in 3D effect/.test(d.message)));
}

function brief(found: readonly Diagnostic[]): string[] {
  return found.map((d) => `${d.code} ${d.path ?? ''}`).sort();
}

/** Every prefab and image with its images taken away: sprites keep only size and color. */
function imageless(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith('assets/images/')) out[path] = null;
    if (!path.startsWith('prefabs/')) continue;
    const prefab = JSON.parse(text) as { components?: Record<string, Record<string, unknown>> };
    const sprite = prefab.components?.['sprite'];
    if (sprite !== undefined) {
      delete sprite['image'];
      delete sprite['animations'];
    }
    out[path] = JSON.stringify(prefab);
  }
  return out;
}

const noImageRefs = (d: Declarations): Declarations => ({ ...d, project_refs: d.project_refs.filter((r) => !(r.ref[0] === 'Assets' && r.ref[1] === 'images')) });

describe('2D look checks', () => {
  it('a finished 2D game with sprites, effects and a background is clean', () => {
    expect(brief(look())).toEqual([]);
  });

  it('PP2211: a character drawn as a plain shape, and not once it has an image or vector art', () => {
    const plain = JSON.stringify({ components: { shape: { kind: 'rect', size: [1, 1], color: '#e0685a' } } });
    expect(brief(look({ 'prefabs/enemy_slime.prefab.json': plain }))).toEqual(['PP2211 prefabs/enemy_slime.prefab.json']);
    const sprite = JSON.stringify({ components: { sprite: { image: 'images/glow', size: [1, 1] } } });
    expect(brief(look({ 'prefabs/enemy_slime.prefab.json': sprite }))).toEqual([]);
    const vector = JSON.stringify({ components: { shape: { kind: 'polygon', points: [[0, 1], [1, -1], [-1, -1]], color: '#e0685a' } } });
    expect(brief(look({ 'prefabs/ship.prefab.json': vector }))).toEqual([]);
    // "bathtub" holds no character word ("bat" only inside a word).
    expect(brief(look({ 'prefabs/bathtub.prefab.json': plain }))).toEqual([]);
  });

  it('PP2210: a game that draws no image anywhere is reported once, not per character', () => {
    const found = look(imageless(), noImageRefs);
    expect(found.map((d) => d.code)).toEqual(['PP2210']);
  });

  it('PP2212: no effect, and quiet with an effect file or a ctx.vfx call', () => {
    const vfx = Object.fromEntries(Object.keys(files).filter((p) => p.startsWith('assets/vfx/')).map((p) => [p, null]));
    const quiet = files[FEEDBACK]!.replace(/ctx\.vfx\.play\([^\n]*\n/g, 'pass\n');
    expect(brief(look({ ...vfx, [FEEDBACK]: quiet }))).toEqual(['PP2212 game/main.py']);
    expect(brief(look({ [FEEDBACK]: quiet }))).toEqual([]);
    expect(brief(look(vfx))).toEqual([]);
  });

  it('PP2213: no camera background, and quiet when code sets one', () => {
    const camera = JSON.parse(files['prefabs/camera.prefab.json']!) as { components: { camera: Record<string, unknown> } };
    delete camera.components.camera['background'];
    const bare = { 'prefabs/camera.prefab.json': JSON.stringify(camera) };
    expect(brief(look(bare))).toEqual(['PP2213 prefabs/camera.prefab.json']);
    const sky = files[FEEDBACK]! + '\n\ndef sky(ctx):\n    ctx.camera.main.background = Color.hex("#102030")\n';
    expect(brief(look({ ...bare, [FEEDBACK]: sky }))).toEqual([]);
  });

  it('PP2063: a built-in Effect played from Python in a 2D game is an error at its line', () => {
    const code = 'from parallax import Effect, vec2\n\n\ndef pop(ctx):\n    ctx.vfx.play(Effect.sparkle, at=vec2(0, 0))\n';
    const found = look({ 'game/pop.py': code });
    expect(found.map((d) => [d.code, d.severity, d.path, d.line])).toEqual([['PP2063', 'error', 'game/pop.py', 5]]);
    // A game's own Effect (a status effect) is not the engine's.
    const own = 'from game.status import Effect\n\n\ndef burn(target):\n    target.add(Effect.burning)\n';
    expect(brief(look({ 'game/burn.py': own }))).toEqual([]);
  });

  it('a 3D game is left to the 3D look checks', () => {
    const three = (d: Declarations): Declarations => ({ ...d, game: { ...d.game!, mode: '3d' } });
    expect(look({}, three).filter((d) => d.code.startsWith('PP221'))).toEqual([]);
  });
});
