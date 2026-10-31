/** World-generation data checks over a small fixture game (procgen, smooth voxels). */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('./fixtures/worldgen', import.meta.url));
let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(DIR);
  files = {};
  for (const path of tree.all()) files[path] = tree.read(path);
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

/** Codes and pointers after replacing the world scene's entity `id` components (and optional extra files). */
function codes(id: string | null, components: Record<string, unknown>, extra: Record<string, string> = {}, scene?: Record<string, unknown>): string[] {
  const path = 'scenes/world/scene.json';
  const doc = JSON.parse(files[path]!) as { entities: { id?: string; components?: Record<string, unknown> }[] } & Record<string, unknown>;
  if (id !== null) {
    const entity = doc.entities.find((e) => e.id === id)!;
    entity.components = { ...entity.components, ...components };
  }
  Object.assign(doc, scene ?? {});
  const result = checkFiles(memoryFiles({ ...files, ...extra, [path]: JSON.stringify(doc) }), declarations, { assetFiles: false });
  return result.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.pointer ?? ''}`);
}

describe('procgen checks', () => {
  it('accepts the fixture', () => {
    expect(codes(null, {})).toEqual([]);
  });

  it('reports bad plans, profiles, kits, splines and dungeons at their pointers', () => {
    expect(codes('house', { structure: { floors: [{ plan: ['#####', '#aaa#', '#+.##'] }] } })).toEqual(['PP3650 /entities/2/components/structure/floors/0/plan/2']);
    expect(codes('track', { sweep: { parts: [{ profile: 'rode' }] } })).toEqual(['PP2141 /entities/1/components/sweep/parts/0/profile']);
    expect(codes('house', { structure: { floors: [{ plan: ['#'] }], kit: 'celar' } })).toEqual(['PP2140 /entities/2/components/structure/kit']);
    expect(codes('track', { spline: { points: [[0, 0, 0]] } })).toEqual(['PP3640 /entities/1/components/spline']);
    expect(codes('crypt', { dungeon: { rooms: 4, locks: 3, key_prefab: 'key', gate_prefab: 'gate' } })).toEqual(['PP3660 /entities/3/components/dungeon']);
  });

  it('checks prop kits', () => {
    expect(codes(null, {}, { 'content/prop_kit/cellar.json': JSON.stringify({ props: [{ prefab: 'barel' }] }) })).toEqual(['PP2041 /props/0/prefab']);
    expect(codes(null, {}, { 'content/prop_kit/cellar.json': JSON.stringify({ props: [{ prefab: 'barrel', scale: [2, 1] }] }) })).toEqual(['PP3661 /props/0/scale']);
  });
});
