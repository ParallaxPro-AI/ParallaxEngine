import { describe, expect, it } from 'vitest';
import { loadProject } from '@parallax/runtime/resource';
import { CheckContext } from './context.js';
import type { Declarations } from './declarations.js';
import { memoryFiles } from './files.js';
import { checkVoxels } from './voxel_checks.js';

function found(blocks: Record<string, unknown>): string[] {
  const added: Record<string, string> = {};
  for (const [id, entry] of Object.entries(blocks)) added[`content/block/${id}.json`] = JSON.stringify({ name: id, ...entry as object });
  const files = memoryFiles(added);
  const ctx = new CheckContext(files, loadProject(files), { engine: { components: {}, content: {} }, components: {}, content: {}, tags: {} } as unknown as Declarations, { assetFiles: false });
  checkVoxels(ctx);
  return ctx.out.map((d) => `${d.code} ${d.path ?? ''}${d.pointer ?? ''}`);
}

describe('block texture checks', () => {
  it('passes one image handle, per-face textures and no texture', () => {
    expect(found({
      stone: { texture: 'images/stone' },
      grass: { texture: { side: 'images/grass_side', top: 'images/grass_top', bottom: 'images/dirt' } },
      log: { texture: { side: 'images/bark', top: 'images/rings' } },
      glass: {},
    })).toEqual([]);
  });

  it('finds per-face textures without a side, with an unknown face, or not a path', () => {
    expect(found({
      a: { texture: { top: 'images/t' } },
      b: { texture: { side: 'images/s', front: 'images/f' } },
      c: { texture: { side: 3 } },
      d: { texture: ['images/s'] },
    })).toEqual([
      'PP3622 content/block/a.json/texture',
      'PP3622 content/block/b.json/texture',
      'PP3622 content/block/c.json/texture',
      'PP3622 content/block/d.json/texture',
    ]);
  });
});
