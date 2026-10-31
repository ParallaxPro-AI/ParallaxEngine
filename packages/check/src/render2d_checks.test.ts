import { describe, expect, it } from 'vitest';
import { loadProject } from '@parallax/runtime/resource';
import { CheckContext } from './context.js';
import type { Declarations } from './declarations.js';
import { memoryFiles } from './files.js';
import { checkShapes2d } from './render2d_checks.js';

function found(prefabs: Record<string, unknown>, scene?: unknown[]): string[] {
  const added: Record<string, string> = {};
  for (const [id, components] of Object.entries(prefabs)) added[`prefabs/${id}.prefab.json`] = JSON.stringify({ components });
  if (scene !== undefined) added['scenes/main/scene.json'] = JSON.stringify({ entities: scene });
  const files = memoryFiles(added);
  const ctx = new CheckContext(files, loadProject(files), { engine: { components: {}, content: {} }, components: {}, content: {}, tags: {} } as unknown as Declarations, { assetFiles: false });
  checkShapes2d(ctx);
  return ctx.out.map((d) => `${d.code} ${d.path ?? ''}${d.pointer ?? ''}`);
}

describe('2D shape checks', () => {
  it('passes drawable shapes', () => {
    expect(found({
      peak: { shape: { kind: 'polygon', points: [[-1, 0], [1, 0], [0, 2]] } },
      halo: { shape: { kind: 'ring', thickness: 0.2 } },
      plain: { shape: { kind: 'ring' } },
    })).toEqual([]);
  });

  it('finds polygons without enough points and flat rings, where they were written', () => {
    expect(found(
      { line: { shape: { kind: 'polygon', points: [[0, 0], [1, 0]] } }, halo: { shape: { kind: 'ring', thickness: 0 } }, peak: { shape: { kind: 'rect' } } },
      [{ prefab: 'peak', components: { shape: { kind: 'polygon' } } }],
    ).sort()).toEqual([
      'PP3608 prefabs/line.prefab.json/components/shape/points',
      'PP3608 prefabs/halo.prefab.json/components/shape/thickness',
      'PP3608 scenes/main/scene.json/entities/0/components/shape/points',
    ].sort());
  });
});
