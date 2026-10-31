/**
 * `Shape.emissive_strength`, `Model.scale`, the scene's `sun.shadow_distance` and per-face
 * block textures, drawn.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { Frame3d, MeshBatch, ProjectFiles, Texture3d } from '../../../core/index.js';
import { compose, loadProject, modelOffsetMatrix, modelPointToEntity } from '../../../resource/index.js';
import { emissiveOf } from '../../../resource/models/code_model.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import type { VoxelBlockType, VoxelChunkMesh, VoxelSurface, VoxelWorldView } from '../../services/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { packMaterial } from '../../../platform/browser/render3d/layout.js';
import { MATERIAL_SLOT } from '../../../platform/browser/render3d/layout.js';
import { environment, readEnvironmentSpec } from '../environment/index.js';
import { visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { writeGlb } from '../models/testing.js';
import { BlockTable, readBlockTexture } from '../voxels/index.js';
import { render3d, VoxelDraws } from './index.js';

const DT = 1 / 60;
const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
const CAMERA = { components: { camera: { fov: 60 } } };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

async function frameOf(prefabs: Record<string, unknown>, entities: unknown[], binary: Record<string, Uint8Array> = {}, scene: Record<string, unknown> = {}): Promise<Frame3d> {
  const project = files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities, ...scene },
    ...Object.fromEntries(Object.keys(binary).map((path) => [path, ''])),
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project });
  const kernel = new Kernel({
    project: loaded, game: NO_GAME, fixedStep: DT, context: {},
    plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles(binary) }), environment(), plugin],
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  return surface.last!;
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

describe('Shape.emissive_strength', () => {
  it('carries the strength on the material, and packs emissive past 1 in linear light', async () => {
    const frame = await frameOf({
      cam: CAMERA,
      lava: { components: { shape: { kind: 'box', emissive: '#ffffff', emissive_strength: 4 } } },
      lamp: { components: { shape: { kind: 'sphere', emissive: '#ffffff' } } },
    }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { prefab: 'lava' }, { prefab: 'lamp', at: [3, 0, 0] }]);
    const lava = frame.meshes.find((m) => m.geometry.id === 'shape:box')!.material;
    const lamp = frame.meshes.find((m) => m.geometry.id === 'shape:sphere')!.material;
    expect(lava.emissiveStrength).toBe(4);
    expect(lamp.emissiveStrength).toBeUndefined();
    const out = new Float32Array(MATERIAL_SLOT);
    packMaterial(lava, out, 0);
    expect([...out.subarray(4, 7)]).toEqual([4, 4, 4]);
    packMaterial(lamp, out, 0);
    expect([...out.subarray(4, 7)]).toEqual([1, 1, 1]);
  });
});

describe('model document emissive above 1', () => {
  it('becomes a color at peak 1 and a strength, so it packs past 1 and blooms', () => {
    expect(emissiveOf([4, 2, 0])).toEqual({ emissive: [1, 0.5, 0], emissiveStrength: 4 });
    expect(emissiveOf([0.4, 0.8, 1])).toEqual({ emissive: [0.4, 0.8, 1] });
  });
});

describe('Model.scale', () => {
  const GLB = writeGlb({
    nodes: [{ name: 'tri', mesh: 0 }],
    meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], material: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
  });

  it('sizes the model about its origin before rotation_offset and offset (which stays in entity meters)', async () => {
    const frame = await frameOf({
      cam: CAMERA,
      big: { components: { model: { model: 'models/tri', offset: [0, 1, 0], rotation_offset: [0, 90, 0], scale: 2 } } },
    }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { prefab: 'big', at: [5, 0, 0] }], { 'assets/models/tri.glb': GLB });
    const mesh: MeshBatch = frame.meshes.find((m) => m.geometry.id.includes('tri.glb'))!;
    const q = Quat.from_euler(new Vec3(0, 90, 0));
    const expected = compose(5, 1, 0, q.x, q.y, q.z, q.w, 2, 2, 2);
    expected.forEach((v, i) => expect(mesh.instances[i]).toBeCloseTo(v, 5));
  });

  it('is the same for points (colliders, slicing) as for the matrix, and must be above 0', async () => {
    const fields = { offset: new Vec3(1, 0, 0), rotation_offset: new Vec3(0, 0, 0), scale: 3 };
    expect(modelPointToEntity(fields, 'm')(1, 2, 3)).toEqual([4, 6, 9]);
    expect(modelOffsetMatrix(fields, 'm')[0]).toBe(3);
    // Absent (an older snapshot): 1.
    expect(modelOffsetMatrix({ offset: Vec3.ZERO }, 'm')[0]).toBe(1);
    expect(await code(() => frameOf({ cam: CAMERA, flat: { components: { model: { model: 'models/tri', scale: 0 } } } },
      [{ id: 'cam', prefab: 'cam' }, { prefab: 'flat' }], { 'assets/models/tri.glb': GLB }))).toBe('PP3800');
  });
});

describe('sun.shadow_distance', () => {
  const SUN = { components: { light: { kind: 'directional', intensity: 2, shadows: true } } };
  const ENTITIES = [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { id: 'sun', prefab: 'sun', rotation: [50, 30, 0] }];

  it('sets how far the last cascade reaches (a light entity as the sun too); absent: the quality\'s', async () => {
    const far = await frameOf({ cam: CAMERA, sun: SUN }, ENTITIES, {}, { environment: { sun: { shadow_distance: 400 } } });
    expect(far.environment.shadowDistance).toBe(400);
    expect(far.sunShadow!.cascades.at(-1)!.far).toBeCloseTo(400, 3);
    const plain = await frameOf({ cam: CAMERA, sun: SUN }, ENTITIES);
    expect(plain.environment.shadowDistance ?? null).toBeNull();
    expect(plain.sunShadow!.cascades.at(-1)!.far).toBeCloseTo(plain.quality.shadowDistance, 3);
  });

  it('is checked when the scene loads', () => {
    const spec = (sun: unknown): unknown => {
      const project = loadProject(files({ 'scenes/main/scene.json': { entities: [], environment: { sun } } }));
      try {
        return readEnvironmentSpec(project.scenes.get('main')!).sunShadowDistance;
      } catch (e) {
        if (e instanceof ParallaxError) return e.diagnostic.code;
        throw e;
      }
    };
    expect(spec({ shadow_distance: 250 })).toBe(250);
    expect(spec({ intensity: 1 })).toBeNull();
    expect(spec({ shadow_distance: 0 })).toMatch(/^PP/);
  });
});

describe('per-face block textures', () => {
  const tex = (path: string): Texture3d => ({ id: path, source: { kind: 'file', path }, colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'repeat', filter: 'nearest' });
  const quad = (corners: number[], normal: number[], block: number) => ({ corners, normal, block });
  function surface(quads: ReturnType<typeof quad>[]): VoxelSurface {
    const positions: number[] = []; const normals: number[] = []; const blocks: number[] = []; const indices: number[] = [];
    for (const q of quads) {
      const base = positions.length / 3;
      positions.push(...q.corners);
      for (let i = 0; i < 4; i++) { normals.push(...q.normal); blocks.push(q.block); }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(positions.length / 3 * 2), blocks: new Uint16Array(blocks), indices: new Uint32Array(indices) };
  }
  const TOP = quad([0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0], [0, 1, 0], 1);
  const BOTTOM = quad([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], [0, -1, 0], 1);
  const SIDE = quad([0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0], [0, 0, -1], 1);
  const STONE_TOP = quad([0, 1, 2, 0, 1, 3, 1, 1, 3, 1, 1, 2], [0, 1, 0], 2);
  const NONE = surface([]);

  const grass: VoxelBlockType = {
    index: 1, id: 'grass', texture: 'assets/images/grass_side.png', textureTop: 'assets/images/grass_top.png', textureBottom: 'assets/images/dirt.png',
    hardness: 1, solid: true, transparent: false, light: 0, prefab: null, prefabRenders: false,
  };
  const stone: VoxelBlockType = { index: 2, id: 'stone', texture: 'assets/images/stone.png', hardness: 1, solid: true, transparent: false, light: 0, prefab: null, prefabRenders: false };
  const chunk: VoxelChunkMesh = {
    key: '0,0,0', cx: 0, cy: 0, cz: 0, version: 1, opaque: surface([TOP, SIDE, BOTTOM, STONE_TOP]), transparent: NONE,
    collision: { vertices: new Float32Array(), indices: new Uint32Array() },
  };
  const view: VoxelWorldView = {
    version: 1, scene: 'main', chunkSize: 16, yMin: 0, yMax: 16, renderDistance: 4, saveEdits: false, mode: 'blocks',
    blocks: () => [undefined, grass, stone], blockAt: () => 0, isSolid: () => false, densityAt: () => 0, active: () => [chunk],
    exportEdits: () => ({}), loadEdits: () => {},
  } as VoxelWorldView;

  it('draws a per-face block as side, top and bottom meshes, each with its texture; one-texture blocks stay one mesh', () => {
    const draws = new VoxelDraws().draws(view, tex);
    const named = draws.map((d) => [d.geometry.id.split(':').slice(5).join(':'), d.material.baseColorTexture?.id, d.geometry.indices.length]);
    expect(named).toEqual([
      ['grass:opaque:side', 'assets/images/grass_side.png', 6],
      ['grass:opaque:top', 'assets/images/grass_top.png', 6],
      ['grass:opaque:bottom', 'assets/images/dirt.png', 6],
      ['stone:opaque', 'assets/images/stone.png', 6],
    ]);
  });

  it('reads a path, {side, top, bottom} (top and bottom defaulting to side), or reports the shape', () => {
    expect(readBlockTexture('images/a')).toEqual({ side: 'images/a', top: 'images/a', bottom: 'images/a' });
    expect(readBlockTexture({ side: 's.png', top: 't.png' })).toEqual({ side: 's.png', top: 't.png', bottom: 's.png' });
    expect(readBlockTexture(undefined)).toEqual({ side: null, top: null, bottom: null });
    expect(readBlockTexture({ top: 't.png' })).toMatch(/"side" is required/);
    expect(readBlockTexture({ side: 's.png', north: 'n.png' })).toMatch(/"north" is not a face/);
  });

  it('gives the block type its top and bottom textures only where they differ from the side', () => {
    const table = new BlockTable(loadProject(files({
      'content/block/grass.json': { name: 'Grass', texture: { side: 'images/gs', top: 'images/gt' } },
      'content/block/stone.json': { name: 'Stone', texture: 'images/stone' },
    })));
    const [grass, stone] = [table.type(table.index('grass', 't')), table.type(table.index('stone', 't'))];
    expect(grass).toMatchObject({ texture: 'images/gs', textureTop: 'images/gt' });
    expect(grass.textureBottom).toBeUndefined();
    expect(stone.texture).toBe('images/stone');
    expect(stone.textureTop).toBeUndefined();
    let failed = '';
    try {
      new BlockTable(loadProject(files({ 'content/block/bad.json': { name: 'Bad', texture: { top: 'images/t' } } })));
    } catch (e) {
      if (e instanceof ParallaxError) failed = e.diagnostic.code;
    }
    expect(failed).toBe('PP3622');
  });
});
