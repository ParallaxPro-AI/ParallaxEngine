/**
 * Look warnings over the paddle duel example (read-only): a 3D game of single-box pieces and
 * no models, which must stay quiet, then trees, ponds, houses, roads and bare outdoor scenes
 * added in memory one at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/paddle_duel', import.meta.url));
const ARENA = 'scenes/arena/scene.json';

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

const shape = (kind: string, size: number[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ shape: { kind, size, ...extra } });
const prefab = (components: Record<string, unknown>, children: Record<string, unknown>[] = []): string =>
  JSON.stringify({ components, children: children.map((c) => ({ components: c })) });

const TREE = prefab(shape('cylinder', [0.4, 2, 0.4]), [shape('sphere', [2, 2, 2])]);
const HOUSE = prefab(shape('box', [6, 3, 5]), [shape('cone', [7, 2, 6]), shape('box', [1, 2, 0.1])]);

/** Look diagnostics after adding / replacing files (null removes one) and editing the declarations. */
function look(add: Record<string, string | null> = {}, decl: (d: Declarations) => Declarations = (d) => d): readonly Diagnostic[] {
  const all: Record<string, string> = { ...files };
  for (const [path, text] of Object.entries(add)) {
    if (text === null) delete all[path];
    else all[path] = text;
  }
  return checkFiles(memoryFiles(all), decl(structuredClone(declarations)), { assetFiles: false }).diagnostics.filter((d) => /^PP220\d$/.test(d.code));
}

function brief(found: readonly Diagnostic[]): string[] {
  return found.map((d) => `${d.code} ${d.path ?? ''}${d.pointer === undefined || d.pointer === '' ? '' : ` ${d.pointer}`}`).sort();
}

/** The arena with extra placements and environment keys. */
function arena(entities: Record<string, unknown>[], environment?: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const scene = JSON.parse(files[ARENA]!) as Record<string, unknown> & { entities: unknown[] };
  scene.entities.push(...entities);
  if (environment !== undefined) scene['environment'] = environment;
  return JSON.stringify({ ...scene, ...extra });
}

describe('look checks', () => {
  it('a 3D game of single-shape pieces with effects is clean', () => {
    expect(brief(look())).toEqual([]);
  });

  it('never checks a 2D game', () => {
    expect(look({ 'prefabs/tree.prefab.json': TREE, 'prefabs/house.prefab.json': HOUSE },
      (d) => ({ ...d, game: { ...d.game!, mode: '2d' } }))).toEqual([]);
  });

  it('a game of assembled shapes and no model (PP2200); trees and houses name their feature (PP2201, PP2205)', () => {
    const found = look({ 'prefabs/tree.prefab.json': TREE, 'prefabs/house.prefab.json': HOUSE });
    expect(brief(found)).toEqual([
      'PP2200 prefabs/house.prefab.json',
      'PP2201 prefabs/tree.prefab.json',
      'PP2205 prefabs/house.prefab.json',
    ]);
    expect(found.every((d) => d.severity === 'warning')).toBe(true);
    expect(found.find((d) => d.code === 'PP2200')!.fix).toContain('pnpm parallax library search house');
    expect(found.find((d) => d.code === 'PP2201')!.fix).toContain('tree_pine');
    expect(found.find((d) => d.code === 'PP2201')!.fix).toContain('"foliage": {"layers": [{"kind": "tree"');
    expect(found.find((d) => d.code === 'PP2205')!.fix).toContain('"structure": {"plan": "buildings/house.plan"');
  });

  it('one model anywhere ends PP2200; a shape tree is still PP2201', () => {
    const found = look({
      'prefabs/tree.prefab.json': TREE, 'prefabs/house.prefab.json': HOUSE,
      'prefabs/statue.prefab.json': prefab({ model: { model: 'models/statue' } }),
    });
    expect(brief(found)).toEqual(['PP2201 prefabs/tree.prefab.json', 'PP2205 prefabs/house.prefab.json']);
  });

  it('a tree with a model, or a name with "rock" inside a word, is no natural object', () => {
    expect(look({
      'prefabs/tree.prefab.json': prefab({ model: { model: 'models/tree_pine' } }, [shape('box', [1, 1, 1])]),
      'prefabs/rocket.prefab.json': prefab(shape('cone', [1, 3, 1])),
      'prefabs/pine_tree.prefab.json': prefab(shape('cone', [2, 4, 2])),
    }).map((d) => `${d.code} ${d.path!}`)).toEqual(['PP2201 prefabs/pine_tree.prefab.json']);
  });

  it('water drawn as a flat shape (PP2202); a thin strip or a water_body is not', () => {
    expect(brief(look({
      'prefabs/pond.prefab.json': prefab(shape('plane', [20, 1, 12])),
      'prefabs/water_strip.prefab.json': prefab(shape('plane', [12, 1, 1.3])),
      'prefabs/lake.prefab.json': prefab({ water_body: { kind: 'lake', area: { center: [0, 0], radius: 10 } }, ...shape('plane', [20, 1, 20]) }),
    }))).toEqual(['PP2202 prefabs/pond.prefab.json']);
  });

  it('a placement named like water, with its own flat shape (PP2202)', () => {
    expect(brief(look({ [ARENA]: arena([{ prefab: 'field', id: 'river', components: shape('box', [30, 0.2, 6]) }]) })))
      .toEqual(['PP2202 scenes/arena/scene.json /entities/17']);
  });

  it('a road or track assembled from shapes (PP2206)', () => {
    const found = look({ 'prefabs/race_track.prefab.json': prefab(shape('box', [10, 0.1, 40]), [shape('box', [0.5, 1, 40]), shape('box', [0.5, 1, 40])]) });
    expect(found.filter((d) => d.code === 'PP2206').map((d) => d.path)).toEqual(['prefabs/race_track.prefab.json']);
    expect(found.find((d) => d.code === 'PP2206')!.fix).toContain('"track": {}');
  });

  it('a 3D game with no effect anywhere (PP2203, at the Game declaration)', () => {
    const feedback = 'game/systems/feedback.py';
    const vfx = Object.keys(files).filter((p) => p.startsWith('assets/vfx/'));
    const found = look({ ...Object.fromEntries(vfx.map((p) => [p, null])), [feedback]: files[feedback]!.replace(/ctx\.vfx\.play\(Assets\.vfx\.\w+, /g, 'print(') });
    expect(found.map((d) => `${d.code} ${d.path!}:${d.line!}`)).toEqual([`PP2203 game/main.py:${declarations.game!.line}`]);
  });

  it('an outdoor scene with an untuned look (PP2204) on flat ground (PP2207)', () => {
    const ground = { prefab: 'field', id: 'ground', components: shape('plane', [80, 1, 80]) };
    const scene = arena([{ prefab: 'tree', at: [5, 0, 5] }, ground], { ambient: '#bcbcc4' });
    // The title scene extends the arena: its environment and ground are the arena's, reported once.
    expect(brief(look({ 'prefabs/tree.prefab.json': TREE, [ARENA]: scene }))).toEqual([
      'PP2201 prefabs/tree.prefab.json',
      'PP2204 scenes/arena/scene.json /environment',
      'PP2207 scenes/arena/scene.json /entities/18',
    ]);
    // A sky (or a post grade) is a tuned look; a terrain is not flat ground.
    const tuned = arena([{ prefab: 'tree', at: [5, 0, 5] }, ground], { sky: 'atmosphere' }, { terrain: { size: [100, 100] } });
    expect(brief(look({ 'prefabs/tree.prefab.json': TREE, [ARENA]: tuned }))).toEqual(['PP2201 prefabs/tree.prefab.json']);
  });

  it('a ground plane the start scene\'s code spawns, with trees spawned too (PP2207)', () => {
    const found = look({ 'prefabs/tree.prefab.json': TREE, 'prefabs/slope.prefab.json': prefab(shape('plane', [1, 1, 1])) }, (d) => ({
      ...d, game: { ...d.game!, start_scene: 'arena' },
      spawns: [...d.spawns, ...['tree', 'slope'].map((p) => ({ prefab: p, path: 'game/main.py', line: 1, components: [], params: [] }))],
    }));
    expect(found.filter((d) => d.code === 'PP2207').map((d) => d.path)).toEqual(['prefabs/slope.prefab.json']);
  });

  it('an explosion where nothing blows up (PP2208), but not with combat, vehicles or a bomb', () => {
    const strike = 'from parallax import Effect\n\ndef celebrate(ctx, at):\n    ctx.vfx.play(Effect.explosion, at=at)\n';
    const found = look({ 'game/fx.py': strike });
    expect(found.filter((d) => d.code === 'PP2208').map((d) => `${d.path}:${d.line}`)).toEqual(['game/fx.py:4']);
    expect(look({ 'game/fx.py': strike.replace('celebrate', 'detonate_bomb') }).filter((d) => d.code === 'PP2208')).toEqual([]);
    const withPlugin = (id: string) => (d: Declarations): Declarations => ({ ...d, game: { ...d.game!, plugins: [...d.game!.plugins, { ...d.game!.plugins[0]!, id }] } });
    expect(look({ 'game/fx.py': strike }, withPlugin('combat')).filter((d) => d.code === 'PP2208')).toEqual([]);
    expect(look({ 'game/fx.py': strike }, withPlugin('vehicles')).filter((d) => d.code === 'PP2208')).toEqual([]);
    expect(look({ 'game/fx.py': strike.replace('Effect.explosion', 'Effect.impact') }).filter((d) => d.code === 'PP2208')).toEqual([]);
  });
});
