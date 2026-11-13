import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { Json, JsonObject, Project } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { VOXELS_SERVICE } from '../../services/index.js';
import { streaming } from '../streaming/index.js';
import { BlockTable, FilledWorld, Landscape, readVoxelSpec, voxels } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const FLAT: JsonObject = {
  y_range: [-8, 24],
  render_distance: 2,
  generator: { type: 'landscape', base_height: 0, strata: [{ block: 'grass', depth: 1 }, { block: 'dirt', depth: 2 }, { block: 'stone' }] },
};

const ROOM: JsonObject = {
  ...FLAT,
  fills: [
    { block: 'stone', from: [5, 1, 5], to: [-5, 4, -5] },
    { block: null, from: [-4, 1, -4], to: [4, 4, 4] },
    { block: 'glass', from: [0, 2, 5], to: [0, 3, 5] },
    { block: null, from: [0, 0, 0], to: [0, 0, 0] },
  ],
};

function project(voxelBlock: JsonObject): Project {
  return loadProject(files({
    'content/block/stone.json': { name: 'Stone' },
    'content/block/dirt.json': { name: 'Dirt' },
    'content/block/grass.json': { name: 'Grass' },
    'content/block/glass.json': { name: 'Glass', transparent: true },
    'content/block/chest.json': { name: 'Chest', prefab: 'chest' },
    'prefabs/chest.prefab.json': { components: {} },
    'prefabs/eye.prefab.json': { components: { camera: {} } },
    'scenes/w/scene.json': { voxels: voxelBlock, entities: [{ id: 'eye', prefab: 'eye', at: [0.5, 4, 0.5] }] },
  }));
}

const scene = (block: JsonObject) => ({
  id: 'w', path: 'scenes/w/scene.json', tags: [], ui: [], init: {}, entities: [], regions: new Map(), plugins: { voxels: block },
});

describe('voxels fills', () => {
  const table = new BlockTable(project(FLAT));

  it('reads boxes in any corner order and rejects bad ones', () => {
    const spec = readVoxelSpec(scene(ROOM), table)!;
    expect(spec.fills[0]).toMatchObject({ min: [-5, 1, -5], max: [5, 4, 5] });
    expect(spec.fills[1]!.block).toBe(0);
    expect(readVoxelSpec(scene(FLAT), table)!.fills).toEqual([]);
    const bad = (fills: Json, mode = 'blocks') => {
      try { readVoxelSpec(scene({ y_range: [0, 8], mode, fills }), table); } catch (e) { return (e as ParallaxError).diagnostic; }
      throw new Error('accepted');
    };
    expect(bad([{ block: 'stoen', from: [0, 0, 0], to: [1, 1, 1] }])).toMatchObject({ code: 'PP3620', pointer: '/voxels/fills/0/block' });
    expect(bad([{ from: [0, 0, 0], to: [1, 1, 1] }]).pointer).toBe('/voxels/fills/0/block');
    expect(bad([{ block: 'stone', from: [0, 0.5, 0], to: [1, 1, 1] }]).pointer).toBe('/voxels/fills/0/from');
    expect(bad([{ block: 'stone', from: [0, 0, 0], too: [1, 1, 1] }]).pointer).toBe('/voxels/fills/0/too');
    expect(bad([{ block: 'chest', from: [0, 0, 0], to: [1, 1, 1] }]).code).toBe('PP3627');
    expect(bad({}).pointer).toBe('/voxels/fills');
    const plain = new BlockTable(loadProject(files({ 'content/block/stone.json': { name: 'Stone' } })));
    try {
      readVoxelSpec(scene({ y_range: [0, 8], mode: 'smooth', fills: [] }), plain);
      throw new Error('accepted');
    } catch (e) {
      expect((e as ParallaxError).diagnostic.pointer).toBe('/voxels/fills');
    }
  });

  it('lays boxes over the generated world in order, as generated blocks, not edits', () => {
    const plugin = voxels({ chunkSize: 8, saveEdits: true, host: { block: (_k, id) => `ref:${id}` } });
    const game: GameDefinition = {
      components: [{ id: 'camera', schema: { follow: t.json({ default: null }) } }],
      resources: [], events: [], behaviors: [], systems: [],
    };
    const kernel = new Kernel({ project: project(ROOM), game, plugins: [plugin, streaming()] });
    kernel.start('w');
    const v = plugin.engine;
    const world = () => kernel.service(VOXELS_SERVICE).current()!;
    expect(v.get(5, 1, 5)).toBe('stone');
    expect(v.get(-5, 4, 0)).toBe('stone');
    expect(v.get(0, 2, 0)).toBeNull();
    expect(v.get(0, 2, 5)).toBe('glass');
    expect(v.get(0, 0, 0)).toBeNull();
    expect(v.get(1, 0, 0)).toBe('grass');
    expect(v.get(6, 1, 0)).toBeNull();
    expect(v.surfaceHeight(5, 0)).toBe(5);
    expect(world().exportEdits()).toEqual({ format: 1, scenes: {} });
    v.set(5, 2, 0, null, null);
    v.set(5, 2, 0, 'stone', null);
    expect(world().exportEdits()).toEqual({ format: 1, scenes: {} });
    v.set(0, 2, 5, null, null);
    expect(world().exportEdits()).toEqual({ format: 1, scenes: { w: [[0, 2, 5, null]] } });
    kernel.step(1 / 60);
    // The room's walls are meshed and collide.
    expect(world().active().some((m) => m.collision.indices.length > 0)).toBe(true);
  });

  it('fills chunks exactly as single cells ask, with or without a generator', () => {
    const fills = [
      { block: 3, min: [-9, -2, 4], max: [20, 3, 6] },
      { block: 0, min: [0, 0, 0], max: [2, 9, 9] },
      { block: 1, min: [0, 30, 0], max: [2, 40, 2] },
    ] as const;
    const land = new Landscape(readVoxelSpec(scene(FLAT), table)!.generator!, -8, 24);
    for (const base of [land, undefined]) {
      const world = new FilledWorld(base, fills, -8, 24);
      const n = 8;
      for (const [cx, cy, cz] of [[0, 0, 0], [-1, -1, 0], [2, 0, 0], [1, 1, 1], [0, 2, 0], [0, 3, 0]] as const) {
        const out = new Uint16Array(n * n * n);
        world.fill(cx * n, cy * n, cz * n, n, out);
        for (let i = 0; i < out.length; i++) {
          const lx = i % n;
          const lz = Math.floor(i / n) % n;
          const ly = Math.floor(i / (n * n));
          expect(out[i]).toBe(world.blockAt(cx * n + lx, cy * n + ly, cz * n + lz));
        }
      }
    }
  });
});
