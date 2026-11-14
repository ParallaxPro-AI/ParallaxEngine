import { describe, expect, it } from 'vitest';
import { loadProject } from '@parallax/runtime/resource';
import { CheckContext } from './context.js';
import type { Declarations } from './declarations.js';
import { memoryFiles } from './files.js';
import { checkTilemaps } from './tilemap_checks.js';

function found(prefabs: Record<string, unknown>, scene?: unknown[]): string[] {
  const added: Record<string, string> = {};
  for (const [id, components] of Object.entries(prefabs)) added[`prefabs/${id}.prefab.json`] = JSON.stringify({ components });
  if (scene !== undefined) added['scenes/main/scene.json'] = JSON.stringify({ entities: scene });
  const files = memoryFiles(added);
  const ctx = new CheckContext(files, loadProject(files), { engine: { components: {}, content: {} }, components: {}, content: {}, tags: {} } as unknown as Declarations, { assetFiles: false });
  checkTilemaps(ctx);
  return ctx.out.map((d) => `${d.code} ${d.path ?? ''}${d.pointer ?? ''}`);
}

describe('tilemap checks', () => {
  it('finds a row character that is not a tile', () => {
    expect(found({ level: { tilemap: { tiles: { '#': { color: '#888888' } }, rows: ['#.#', '#x#'] } } }))
      .toEqual(['PP3615 prefabs/level.prefab.json/components/tilemap/rows/1']);
  });

  it('reads a placement\'s rows against its prefab\'s tiles', () => {
    const tiles = { tilemap: { tiles: { '#': { color: '#888888' }, '=': { color: '#aa8855', solid: false } }, rows: ['.'] } };
    expect(found({ tiles }, [{ prefab: 'tiles', components: { tilemap: { rows: ['#=#', '###'] } } }])).toEqual([]);
    expect(found({ tiles }, [{ prefab: 'tiles', components: { tilemap: { rows: ['#?#'] } } }]))
      .toEqual(['PP3615 scenes/main/scene.json/entities/0/components/tilemap/rows/0']);
  });
});
