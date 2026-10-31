/** Terrain, foliage and wind scene blocks, checked over the racing example (read-only). */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

let files: Record<string, string>;
let declarations: Declarations;
const SCENE = 'scenes/terrain_sprint/scene.json';

beforeAll(() => {
  const dir = fileURLToPath(new URL('../../../examples/racing', import.meta.url));
  const tree = directoryFiles(dir);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(dir);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

/** Ground diagnostics after changing the scene's blocks (and optionally the game's plugin list). */
function ground(change: (scene: Record<string, unknown>) => void, plugins: string[] = [], drop: string[] = []): string[] {
  const scene = JSON.parse(files[SCENE]!) as Record<string, unknown>;
  change(scene);
  const base = structuredClone(declarations);
  const decl: Declarations = { ...base, game: { ...base.game!, plugins: [...base.game!.plugins.filter((p) => !drop.includes(p.id)), ...plugins.map((id) => ({ ...base.game!.plugins[0]!, id }))] } };
  const found = checkFiles(memoryFiles({ ...files, [SCENE]: JSON.stringify(scene) }), decl, { assetFiles: false }).diagnostics;
  return found.filter((d) => /^PP32(0|3)/.test(d.code) && (d.path === undefined || d.path === SCENE)).map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('ground checks', () => {
  it('the example is clean', () => {
    expect(ground(() => undefined)).toEqual([]);
  });

  it('reports terrain data errors with the runtime\'s codes and pointers', () => {
    expect(ground((s) => { (s['terrain'] as Record<string, unknown>)['max_heigth'] = 3; })).toEqual(['PP3200 /terrain/max_heigth']);
    expect(ground((s) => { (s['terrain'] as Record<string, unknown>)['paint'] = [{ layer: 'grss', center: [0, 0], radius: 3 }]; })).toEqual(['PP3200 /terrain/paint/0/layer']);
  });

  it('blocks need their plugin', () => {
    // racing declares wind() and foliage() itself; drop them to see the missing-plugin error.
    expect(ground((s) => { s['wind'] = { speed: 3 }; }, [], ['wind'])).toEqual(['PP3209 /wind']);
    expect(ground((s) => { s['foliage'] = { layers: [] }; }, [], ['foliage'])).toEqual(['PP3209 /foliage']);
  });

  it('a foliage model layer names a model by its handle', () => {
    const withModel = (model: string): string[] => {
      const scene = JSON.parse(files[SCENE]!) as Record<string, unknown>;
      const foliage = scene['foliage'] as { layers: Record<string, unknown>[] };
      foliage.layers.push({ id: 'banners', kind: 'model', model, density: 0.001, on: 'grass', seed: 7 });
      const assets = Object.fromEntries(['banner', 'barrier_arm', 'kart'].map((m) => [`assets/models/${m}.model.json`, files[`assets/models/${m}.model.json`] ?? '{}']));
      return checkFiles(memoryFiles({ ...files, ...assets, [SCENE]: JSON.stringify(scene) }), declarations, { assetFiles: true }).diagnostics
        .filter((d) => d.code === 'PP3207').map((d) => `${d.pointer ?? ''} ${d.fix ?? ''}`);
    };
    expect(withModel('models/banner')).toEqual([]);
    expect(withModel('models/baner')).toEqual(['/foliage/layers/4/model Did you mean "models/banner"?']);
  });

  it('foliage layers must name the terrain\'s layers', () => {
    const layers = [{ kind: 'tree', on: 'gras' }, { kind: 'grass', on: 'grass', avoid: ['road'] }];
    expect(ground((s) => { s['foliage'] = { layers }; }, ['foliage'])).toEqual(['PP3230 /foliage/layers/0/on']);
    // The old spelling fails naming "on".
    expect(ground((s) => { s['foliage'] = { layers: [{ kind: 'tree', layer: 'grass' }] }; }, ['foliage'])).toEqual(['PP3230 /foliage/layers/0/layer']);
    expect(ground((s) => { s['foliage'] = { layers: [{ kind: 'tre' }] }; }, ['foliage'])).toEqual(['PP3230 /foliage/layers/0/kind']);
    expect(ground((s) => { s['wind'] = { gusts: 3 }; }, ['wind'])).toEqual(['PP3236 /wind/gusts']);
  });
});
