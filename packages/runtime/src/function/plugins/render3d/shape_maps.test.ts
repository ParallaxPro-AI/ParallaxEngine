/** Shape tiling and normal maps (`uv_scale`, `normal_map`, `normal_strength`) and `Model.rotation_offset`, drawn. */

import { describe, expect, it } from 'vitest';
import { MESH_INSTANCE_STRIDE, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { Frame3d, ProjectFiles } from '../../../core/index.js';
import { compose, loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { writeGlb } from '../models/testing.js';
import { render3d } from './index.js';

const DT = 1 / 60;
const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
const CAMERA = { components: { camera: { fov: 60 } } };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

async function frameOf(prefabs: Record<string, unknown>, entities: unknown[], binary: Record<string, Uint8Array> = {}, extra: Record<string, unknown> = {}): Promise<Frame3d> {
  const project = files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
    ...Object.fromEntries(Object.keys(binary).map((path) => [path, ''])),
    ...extra,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project });
  const kernel = new Kernel({
    project: loaded, game: NO_GAME, fixedStep: DT, context: {},
    plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles(binary) }), plugin],
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  return surface.last!;
}

function code(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(() => 'no error', (e: unknown) => {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  });
}

const IMAGES = { 'assets/images/planks.png': '', 'assets/images/planks_n.png': '' };

describe('Shape tiling and normal maps', () => {
  it('tiles the texture and binds the normal map as linear data, with its strength', async () => {
    const frame = await frameOf({
      cam: CAMERA,
      floor: { components: { shape: { kind: 'box', texture: 'images/planks', uv_scale: [8, 4], normal_map: 'images/planks_n', normal_strength: 0.5 } } },
      plain: { components: { shape: { kind: 'sphere', texture: 'images/planks' } } },
    }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { prefab: 'floor' }, { prefab: 'plain', at: [3, 0, 0] }], {}, IMAGES);
    const floor = frame.meshes.find((m) => m.geometry.id === 'shape:box')!.material;
    expect(floor.uvScale).toEqual([8, 4]);
    expect(floor.normalTexture?.source).toEqual({ kind: 'file', path: 'assets/images/planks_n.png' });
    expect(floor.normalTexture?.colorSpace).toBe('linear');
    expect(floor.normalScale).toBe(0.5);
    expect(floor.baseColorTexture?.colorSpace).toBe('srgb');
    const plain = frame.meshes.find((m) => m.geometry.id === 'shape:sphere')!.material;
    expect(plain.uvScale).toBeUndefined();
    expect(plain.normalTexture ?? null).toBeNull();
  });

  it('rejects non-positive tiling', async () => {
    expect(await code(() => frameOf({ cam: CAMERA, bad: { components: { shape: { kind: 'box', uv_scale: [0, 1] } } } },
      [{ id: 'cam', prefab: 'cam' }, { prefab: 'bad' }]))).toBe('PP3800');
  });

  it('draws no normal map when its file is absent in a data-only run', async () => {
    const project = files({
      'prefabs/cam.prefab.json': CAMERA,
      'prefabs/floor.prefab.json': { components: { shape: { kind: 'box', normal_map: 'images/missing_n' } } },
      'scenes/main/scene.json': { entities: [{ id: 'cam', prefab: 'cam' }, { prefab: 'floor' }] },
    });
    const surface = new RecordingSurface3d();
    const plugin = render3d({ surface, files: project, assetFiles: false });
    const kernel = new Kernel({
      project: loadProject(project), game: NO_GAME, fixedStep: DT, context: {},
      plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}) }), plugin],
    });
    kernel.start('main');
    kernel.step(DT);
    const box = surface.last!.meshes.find((m) => m.geometry.id === 'shape:box')!;
    expect(box.material.normalTexture ?? null).toBeNull();
  });
});

describe('Model.rotation_offset', () => {
  const GLB = writeGlb({
    nodes: [{ name: 'tri', mesh: 0 }],
    meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], material: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
  });

  it('turns the model about its origin before its offset', async () => {
    const frame = await frameOf({
      cam: CAMERA,
      turned: { components: { model: { model: 'models/tri', offset: [0, 1, 0], rotation_offset: [0, 90, 0] } } },
    }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { prefab: 'turned', at: [5, 0, 0] }], { 'assets/models/tri.glb': GLB });
    const mesh = frame.meshes.find((m) => m.geometry.id.includes('tri.glb'))!;
    expect(mesh.count).toBe(1);
    const q = Quat.from_euler(new Vec3(0, 90, 0));
    const expected = compose(5, 1, 0, q.x, q.y, q.z, q.w, 1, 1, 1);
    const got = [...mesh.instances.subarray(0, 16)];
    expected.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 5));
    expect(mesh.instances.length).toBe(MESH_INSTANCE_STRIDE);
  });
});
