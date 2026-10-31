/**
 * render3d as a provider and a consumer of world services: the model geometry service
 * (glTF triangles for physics3d's mesh/convex colliders, including data-only runs), clip
 * lengths resolved against the playing entity's model, and the voxels service's chunks
 * drawn as meshes (with physics3d colliding against the same chunks).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, Geometry3d, MeshBatch, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { MODEL_GEOMETRY_SERVICE, PHYSICS3D_SERVICE, VOXELS_SERVICE } from '../../services/index.js';
import type { ModelGeometry, VoxelChunkMesh, VoxelSurface, VoxelWorldView } from '../../services/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { streaming } from '../streaming/index.js';
import { visuals } from '../visuals/index.js';
import { voxels } from '../voxels/index.js';
import { models } from '../models/index.js';
import { blockColor, render3d, UNTEXTURED_TRANSPARENT_ALPHA } from './index.js';
import type { Render3dPlugin } from './index.js';
import { standInCharacter, writeGlb } from '../models/testing.js';

const DT = 1 / 60;
const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

/** A 2 × 2 quad (glTF space, facing up), on a node lifted 1 m and scaled 2 × in x and z. */
const GROUND = writeGlb({
  nodes: [{ name: 'ground', mesh: 0, translation: [0, 1, 0], scale: [2, 1, 2] }],
  meshes: [{ positions: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 2, 1, 0, 3, 2] }],
});

function normalOf(g: ModelGeometry, t: number): [number, number, number] {
  const v = (i: number): number[] => [0, 1, 2].map((k) => g.vertices[g.indices[t * 3 + i]! * 3 + k]!);
  const [a, b, c] = [v(0), v(1), v(2)];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
}

function bounds(g: ModelGeometry): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.vertices.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, g.vertices[i]!);
    max[i % 3] = Math.max(max[i % 3]!, g.vertices[i]!);
  }
  return { min, max };
}

interface World {
  readonly kernel: Kernel;
  readonly plugin: Render3dPlugin;
  readonly surface: RecordingSurface3d;
  id(placed: string): EntityId;
  steps(n: number): void;
}

async function world(
  data: { prefabs: Record<string, unknown>; entities: unknown[] },
  binary: Record<string, Uint8Array>,
  options: { assetFiles?: boolean; physics?: boolean } = {},
): Promise<World> {
  const project = files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
    ...Object.fromEntries((options.assetFiles ?? true ? Object.keys(binary) : []).map((path) => [path, ''])),
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project, assetFiles: options.assetFiles ?? true });
  const vis = visuals({ dimension: '3d' });
  const modelData = models({ files: project, binary: new MemoryBinaryFiles(binary), assetFiles: options.assetFiles ?? true });
  const plugins: KernelPlugin[] = [vis, modelData, plugin, ...(options.physics === true ? [physics3d()] : [])];
  const kernel = new Kernel({ project: loaded, game: NO_GAME, plugins, context: {}, fixedStep: DT });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  return {
    kernel, plugin, surface,
    id: (placed) => [...kernel.world.live()].find((r) => r.placedId === placed)!.id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const BALL = { components: { rigidbody: {}, collider: { shape: 'sphere', radius: 0.5 } } };

describe('the model geometry service', () => {
  it('gives a model\'s triangles in model space: node transforms applied, front faces counter-clockwise', async () => {
    const w = await world({ prefabs: {}, entities: [] }, { 'assets/models/ground.glb': GROUND });
    const source = w.kernel.service(MODEL_GEOMETRY_SERVICE);
    // No entity names it yet: the first call requests it.
    expect(source.geometry('models/ground')).toBeUndefined();
    await w.plugin.engine.whenLoaded();
    const g = source.geometry('models/ground')!;
    expect(g.indices).toHaveLength(6);
    expect(bounds(g)).toEqual({ min: [-2, 1, -2], max: [2, 1, 2] });
    for (let t = 0; t < 2; t++) expect(normalOf(g, t)[1]).toBeGreaterThan(0);
    // The geometry is built once; a file path or a bare name is not a reference.
    expect(source.geometry('models/ground')).toBe(g);
    expect(code(() => source.geometry('assets/models/ground.glb'))).toBe('PP2063');
    expect(code(() => source.geometry('ground'))).toBe('PP2063');
    expect(code(() => source.geometry('models/nope'))).toBe('PP2063');
  });

  it('skinned meshes come in their rest pose (here the bind pose)', async () => {
    const w = await world({ prefabs: { hero: { components: { model: { model: 'models/hero' } } } }, entities: [] },
      { 'assets/models/hero.glb': standInCharacter(['walk'], 1) });
    const source = w.kernel.service(MODEL_GEOMETRY_SERVICE);
    expect(bounds(source.geometry('models/hero')!)).toEqual({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] });
  });

  it('physics3d builds mesh and convex colliders from it', async () => {
    const w = await world({
      prefabs: {
        ground: { components: { model: { model: 'models/ground' }, collider: { shape: 'mesh' } } },
        crate: { components: { model: { model: 'models/hero' }, rigidbody: {}, collider: { shape: 'convex' } } },
        ball: BALL,
      },
      entities: [{ prefab: 'ground', id: 'g' }, { prefab: 'ball', id: 'ball', at: [1, 4, 1] }, { prefab: 'crate', id: 'crate', at: [-1, 3, -1] }],
    }, { 'assets/models/ground.glb': GROUND, 'assets/models/hero.glb': standInCharacter([], 1) }, { physics: true });
    w.steps(120);
    const at = (id: string): Vec3 => w.kernel.world.require(w.id(id)).transform.position;
    expect(at('ball').y).toBeCloseTo(1.5, 1);
    // The crate's hull is its 1 m box, feet at its origin: it rests on the ground at y = 1.
    expect(at('crate').y).toBeCloseTo(1, 1);
    expect(w.kernel.service(PHYSICS3D_SERVICE).bounds(w.id('crate'))!.halfExtents.y).toBeCloseTo(0.5);
  });

  it('in a data-only run (no model files) a model is null: its collider has no shape and nothing fails', async () => {
    const w = await world({
      prefabs: {
        ground: { components: { model: { model: 'models/ground' }, collider: { shape: 'mesh' } } },
        rock: { components: { model: { model: 'models/rock' }, rigidbody: {}, collider: { shape: 'convex' } } },
        ball: BALL,
      },
      entities: [{ prefab: 'ground', id: 'g' }, { prefab: 'rock', id: 'rock', at: [5, 0, 0] }, { prefab: 'ball', id: 'ball', at: [0, 4, 0] }],
    }, {}, { assetFiles: false, physics: true });
    expect(w.kernel.service(MODEL_GEOMETRY_SERVICE).geometry('models/ground')).toBeNull();
    w.steps(60);
    expect(w.kernel.world.require(w.id('ball')).transform.position.y).toBeLessThan(0);
    expect(w.kernel.service(PHYSICS3D_SERVICE).bounds(w.id('rock'))).toBeUndefined();
  });
});

describe('clip lengths for play_once', () => {
  it('a bare clip name resolves against the playing entity\'s own model', async () => {
    const w = await world({
      prefabs: {
        a: { components: { model: { model: 'models/a' } } },
        b: { components: { model: { model: 'models/b' } } },
        none: { components: {} },
      },
      entities: [{ prefab: 'a', id: 'a' }, { prefab: 'b', id: 'b' }, { prefab: 'none', id: 'none' }],
    }, { 'assets/models/a.glb': standInCharacter(['wave'], 1), 'assets/models/b.glb': standInCharacter(['wave'], 2) });
    expect(w.plugin.clipLength('wave', w.id('a'))).toBe(1);
    expect(w.plugin.clipLength('wave', w.id('b'))).toBe(2);
    expect(w.plugin.clipLength('models/b#wave', w.id('a'))).toBe(2);
    // Without the entity the lengths disagree.
    expect(code(() => w.plugin.clipLength('wave'))).toBe('PP3806');
    expect(code(() => w.plugin.clipLength('wav', w.id('a')))).toBe('PP3805');
    expect(code(() => w.plugin.clipLength('wave', w.id('none')))).toBe('PP3805');
    expect(w.plugin.clipLength('models/a#wave', w.id('none'))).toBe(1);
  });
});

// ── Voxels ─────────────────────────────────────────────────────────────────────

const NONE: VoxelSurface = { positions: new Float32Array(), normals: new Float32Array(), uvs: new Float32Array(), blocks: new Uint16Array(), indices: new Uint32Array() };

/** Quads as a surface: each quad is four corners counter-clockwise from outside, a normal and a block. */
function surface(quads: ReadonlyArray<{ corners: number[]; normal: number[]; block: number }>): VoxelSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const blocks: number[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    positions.push(...q.corners);
    for (let i = 0; i < 4; i++) { normals.push(...q.normal); blocks.push(q.block); }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(positions.length / 3 * 2), blocks: new Uint16Array(blocks), indices: new Uint32Array(indices) };
}

const TOP = (x: number, z: number, y: number, block: number) => ({ corners: [x, y, z, x, y, z + 1, x + 1, y, z + 1, x + 1, y, z], normal: [0, 1, 0], block });
/** The -z side of block (x, y, z): seen from -z, counter-clockwise. */
const SIDE = (x: number, y: number, z: number, block: number) => ({ corners: [x, y, z, x, y + 1, z, x + 1, y + 1, z, x + 1, y, z], normal: [0, 0, -1], block });

function chunk(cx: number, version: number, opaque: VoxelSurface, transparent: VoxelSurface = NONE): VoxelChunkMesh {
  return { key: `${cx},0,0`, cx, cy: 0, cz: 0, version, opaque, transparent, collision: { vertices: new Float32Array(), indices: new Uint32Array() } };
}

const TYPES = [
  undefined,
  { index: 1, id: 'stone', texture: 'images/stone', hardness: 1, solid: true, transparent: false, light: 0, prefab: null, prefabRenders: false },
  { index: 2, id: 'dirt', texture: null, hardness: 1, solid: true, transparent: false, light: 0, prefab: null, prefabRenders: false },
  { index: 3, id: 'water', texture: null, hardness: 1, solid: false, transparent: true, light: 0, prefab: null, prefabRenders: false },
];

function voxelMeshes(meshes: readonly MeshBatch[]): MeshBatch[] {
  return meshes.filter((m) => m.geometry.id.startsWith('voxels:'));
}

describe('voxel chunks drawn by render3d', () => {
  it('one mesh per (chunk, block, surface) at the chunk center; textured, fallback-colored and blended blocks; cached by version', async () => {
    let worldVersion = 1;
    let chunks: VoxelChunkMesh[] = [
      chunk(0, 1, surface([TOP(0, 0, 4, 1), TOP(1, 0, 4, 2), SIDE(5, 3, 0, 2)]), surface([TOP(2, 2, 3, 3)])),
      chunk(1, 1, surface([TOP(16, 0, 4, 1)])),
    ];
    const view = (): VoxelWorldView => ({
      version: worldVersion, scene: 'main', chunkSize: 16, yMin: 0, yMax: 16, renderDistance: 4, saveEdits: false, mode: 'blocks',
      blocks: () => TYPES, blockAt: () => 0, isSolid: () => false, densityAt: () => 0, active: () => chunks, exportEdits: () => ({}), loadEdits: () => {},
    });
    const provider: KernelPlugin = { id: 'voxels', install: (k) => k.provide(VOXELS_SERVICE, { current: () => view() }) };
    const project = files({ 'scenes/main/scene.json': { entities: [] }, 'assets/images/stone.png': '' });
    const surface3d = new RecordingSurface3d();
    const plugin = render3d({ surface: surface3d, files: project });
    const kernel = new Kernel({
      project: loadProject(project), game: NO_GAME, plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}) }), plugin, provider],
      context: {}, fixedStep: DT,
    });
    kernel.start('main');
    kernel.step(DT);
    let meshes = voxelMeshes(surface3d.last!.meshes);
    expect(meshes.map((m) => m.geometry.id.split(':').slice(3).join(':'))).toEqual([
      '0,0,0:1:stone:opaque', '0,0,0:1:dirt:opaque', '0,0,0:1:water:transparent', '1,0,0:1:stone:opaque',
    ]);
    const [stone, dirt, water, far] = meshes as [MeshBatch, MeshBatch, MeshBatch, MeshBatch];
    // Placed at the chunk's center; positions relative to it.
    expect([...stone.instances.subarray(12, 15)]).toEqual([8, 8, 8]);
    expect([...far.instances.subarray(12, 15)]).toEqual([24, 8, 8]);
    expect([...stone.geometry.positions.subarray(0, 3)]).toEqual([-8, -4, -8]);
    expect(stone.material.baseColorTexture!.source).toEqual({ kind: 'file', path: 'assets/images/stone.png' });
    expect(stone.material.baseColorTexture!.filter).toBe('nearest');
    expect(stone.material.baseColorTexture!.wrapU).toBe('repeat');
    expect(stone.material.baseColor).toEqual([1, 1, 1, 1]);
    expect(stone.castShadows).toBe(true);
    expect(dirt.material.baseColorTexture).toBeNull();
    expect(dirt.material.baseColor).toEqual([...blockColor('dirt'), 1]);
    expect(water.material.alphaMode).toBe('blend');
    expect(water.material.baseColor).toEqual([...blockColor('water'), UNTEXTURED_TRANSPARENT_ALPHA]);
    expect(water.castShadows).toBe(false);
    expect(dirt.geometry.indices).toHaveLength(12);
    expect(stone.material.doubleSided).toBe(false);
    // The side face: v runs down the block (top edge v = -4 ≡ 0), u along +x as seen from -z.
    const side = dirt.geometry;
    const uvAt = (g: Geometry3d, x: number, y: number, z: number): number[] => {
      for (let i = 0; i < g.positions.length / 3; i++) {
        if (g.positions[i * 3] === x - 8 && g.positions[i * 3 + 1] === y - 8 && g.positions[i * 3 + 2] === z - 8) return [g.uvs[i * 2]!, g.uvs[i * 2 + 1]!];
      }
      throw new Error('no such vertex');
    };
    expect(uvAt(side, 5, 4, 0)).toEqual([5, -4]);
    expect(uvAt(side, 6, 4, 0)).toEqual([6, -4]);
    expect(uvAt(side, 5, 3, 0)).toEqual([5, -3]);

    // Unchanged chunks keep their geometry objects (the surface keeps its GPU buffers).
    kernel.step(DT);
    expect(voxelMeshes(surface3d.last!.meshes)[0]!.geometry).toBe(stone.geometry);
    // A new chunk version rebuilds that chunk; a chunk that left is dropped.
    chunks = [chunk(0, 2, surface([TOP(0, 0, 5, 1)]))];
    kernel.step(DT);
    meshes = voxelMeshes(surface3d.last!.meshes);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.geometry).not.toBe(stone.geometry);
    expect(meshes[0]!.geometry.positions[1]).toBe(-3);
    // A rebuilt world rebuilds even an unchanged chunk version.
    const before = meshes[0]!.geometry;
    worldVersion = 2;
    kernel.step(DT);
    expect(voxelMeshes(surface3d.last!.meshes)[0]!.geometry).not.toBe(before);
  });

  it('the voxels plugin\'s real world: front faces face their normals, and physics3d stands a ball on the grass', async () => {
    const project = files({
      'content/block/grass.json': { name: 'Grass', texture: 'images/grass' },
      'assets/images/grass.png': '',
      'content/block/dirt.json': { name: 'Dirt' },
      'content/block/glass.json': { name: 'Glass', transparent: true },
      'prefabs/eye.prefab.json': { components: { camera: {} } },
      'prefabs/ball.prefab.json': BALL,
      'scenes/w/scene.json': {
        voxels: { y_range: [-8, 16], render_distance: 1, generator: { type: 'landscape', base_height: 0, strata: [{ block: 'grass', depth: 1 }, { block: 'dirt' }] } },
        entities: [{ id: 'eye', prefab: 'eye', at: [0.5, 6, 0.5] }, { id: 'ball', prefab: 'ball', at: [3.5, 4, 3.5] }],
      },
    });
    const loaded = loadProject(project);
    expect(loaded.diagnostics).toEqual([]);
    const surface3d = new RecordingSurface3d();
    const plugin = render3d({ surface: surface3d, files: project });
    const game: GameDefinition = { ...NO_GAME, components: [{ id: 'crate', schema: { items: t.int({ default: 0 }) } }] };
    const plugins: KernelPlugin[] = [
      visuals({ dimension: '3d' }), voxels({ chunkSize: 8, saveEdits: false, host: { block: (_k, id) => id } }), streaming(),
      models({ files: project, binary: new MemoryBinaryFiles({}) }), plugin, physics3d(),
    ];
    const kernel = new Kernel({ project: loaded, game, plugins, context: {}, fixedStep: DT });
    kernel.start('w');
    for (let i = 0; i < 90; i++) kernel.step(DT);
    const ball = [...kernel.world.live()].find((r) => r.placedId === 'ball')!;
    expect(ball.transform.position.y).toBeCloseTo(1.5, 1);

    const meshes = voxelMeshes(surface3d.last!.meshes);
    expect(meshes.length).toBeGreaterThan(0);
    const grass = meshes.filter((m) => m.geometry.id.includes(':grass:'));
    expect(grass.length).toBeGreaterThan(0);
    expect(grass[0]!.material.baseColorTexture!.source).toEqual({ kind: 'file', path: 'assets/images/grass.png' });
    for (const m of meshes) {
      const g = m.geometry;
      for (let t = 0; t < g.indices.length; t += 3) {
        const v = (i: number): number[] => [0, 1, 2].map((k) => g.positions[g.indices[t + i]! * 3 + k]!);
        const [a, b, c] = [v(0), v(1), v(2)];
        const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
        const cross = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
        const n = [0, 1, 2].map((k) => g.normals[g.indices[t]! * 3 + k]!);
        expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
      }
    }
  });
});
