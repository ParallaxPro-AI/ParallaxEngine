/**
 * The engine's jobs give exactly what calling their functions directly gives, after the
 * round trip through structured clone a worker imposes (InlineJobs clones both ways), and
 * the off-thread pool returns the same results in the same order.
 */

import { describe, expect, it } from 'vitest';
import { encodeBuffer, loadProject, parseModelDocument } from '../resource/index.js';
import { buildModel, readContainer } from '../resource/index.js';
import type { GltfJson } from '../resource/index.js';
import { standInCharacter } from '../function/plugins/models/testing.js';
import { marchChunk, meshChunk } from '../function/plugins/voxels/index.js';
import { bakeTerrain, buildField, fieldOf, readTerrainSpec } from '../function/plugins/terrain/index.js';
import { findPath } from '../function/plugins/nav/index.js';
import type { NavBake } from '../function/services/index.js';
import type { VoxelBlockType } from '../function/services/index.js';
import { InlineJobs, serveJobs, WorkerJobs } from '../platform/index.js';
import type { WorkerLike } from '../platform/index.js';
import type { JobRequest, JobResponse } from '../core/index.js';
import { buffersOf, ENGINE_JOBS, GLTF_BUILD, MODEL_PARSE, NAV_PATHS, TERRAIN_BAKE, VOXELS_MARCH, VOXELS_MESH } from './jobs.js';
import type { VoxelMeshInput } from './jobs.js';

const racing = import.meta.glob('../../../../examples/racing/**/*.json', { query: '?raw', import: 'default', eager: true });

function terrainSpec() {
  const files = new Map(Object.entries(racing).map(([path, text]) => [path.slice('../../../../examples/racing/'.length), text]));
  const project = loadProject({ list: () => [...files.keys()].sort(), read: (p) => files.get(p)! });
  return readTerrainSpec(project.scenes.get('terrain_sprint')!)!;
}

/** A small model document: a mesh part, a primitive, a hinge and a socket. */
const KART = {
  format: 'parallax.model',
  version: 1,
  materials: { body: { color: '#ff0000', metallic: 0, roughness: 0.3 } },
  meshes: { tub: { positions: encodeBuffer('f32', [0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: encodeBuffer('u16', [0, 1, 2]) } },
  parts: [
    { name: 'chassis' },
    { name: 'tub', parent: 'chassis', mesh: 'tub', material: 'body', size: [2, 1, 1] },
    { name: 'wheel', parent: 'chassis', shape: 'cylinder', size: [0.6, 0.3, 0.6], material: 'body' },
  ],
  joints: [{ name: 'spin', part: 'wheel', type: 'hinge', axis: [1, 0, 0] }],
  sockets: [{ name: 'seat', parent: 'chassis', position: [0, 0.6, 0] }],
};

const TYPES: (VoxelBlockType | undefined)[] = [
  undefined,
  { index: 1, id: 'dirt', texture: null, hardness: 1, solid: true, transparent: false, light: 0, prefab: null, prefabRenders: false },
  { index: 2, id: 'glass', texture: null, hardness: 1, solid: true, transparent: true, light: 0, prefab: null, prefabRenders: false },
];

/** 27 chunks of 8³ with a hill of dirt and a glass pane, deterministic. */
function voxelInput(): VoxelMeshInput {
  const size = 8;
  const around: (Uint16Array | null)[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = new Uint16Array(size ** 3);
        for (let i = 0; i < chunk.length; i++) {
          const x = i % size + dx * size;
          const z = Math.floor(i / size) % size + dz * size;
          const y = Math.floor(i / size / size) + dy * size;
          chunk[i] = y < 3 + ((x * 7 + z * 13) % 5) ? 1 : y === 6 && x === 2 ? 2 : 0;
        }
        around.push(chunk);
      }
    }
  }
  return { size, yMin: -8, yMax: 16, types: TYPES, around, cx: 0, cy: 0, cz: 0 };
}

/** A fake module worker: requests are cloned (with transfers) and answered on a later task, like a real one. */
function fakeWorker(): WorkerLike {
  const scope: Parameters<typeof serveJobs>[0] = { onmessage: null, postMessage: () => {} };
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (message: JobRequest, transfer) => {
      const sent = structuredClone(message, { transfer: [...transfer] });
      setTimeout(() => scope.onmessage?.({ data: sent }), 0);
    },
  };
  scope.postMessage = (response: JobResponse, transfer) => {
    const back = structuredClone(response, { transfer });
    setTimeout(() => worker.onmessage?.({ data: back }), 0);
  };
  serveJobs(scope, ENGINE_JOBS);
  return worker;
}

describe('engine jobs', () => {
  const inline = new InlineJobs(ENGINE_JOBS);

  it('model.parse matches parseModelDocument, document and diagnostics', async () => {
    const text = JSON.stringify(KART);
    expect(await inline.run(MODEL_PARSE, { path: 'assets/models/kart.model.json', text }))
      .toEqual(parseModelDocument('assets/models/kart.model.json', text));
    const broken = JSON.stringify({ ...KART, version: 99 });
    const direct = parseModelDocument('assets/models/bad.model.json', broken);
    expect(direct.diagnostics.length).toBeGreaterThan(0);
    expect(await inline.run(MODEL_PARSE, { path: 'assets/models/bad.model.json', text: broken })).toEqual(direct);
  });

  it('gltf.build matches buildModel on a skinned, animated glb', async () => {
    const { json, bin } = readContainer('assets/models/hero.glb', standInCharacter(['idle', 'run']));
    const direct = buildModel('assets/models/hero.glb', json, [bin!]);
    const job = await inline.run(GLTF_BUILD, { path: 'assets/models/hero.glb', json: json as GltfJson, buffers: [bin!.slice()] });
    expect(job).toEqual(direct);
    expect(buffersOf(job).length).toBeGreaterThan(0);
  });

  it('voxels.mesh and voxels.march match meshing inline', async () => {
    const input = voxelInput();
    const direct = meshChunk(input);
    expect(direct.opaque.indices.length).toBeGreaterThan(0);
    expect(direct.transparent.indices.length).toBeGreaterThan(0);
    expect(await inline.run(VOXELS_MESH, input)).toEqual(direct);
    // The same chunks as a smooth lattice: solid cells become density 255 of their block.
    const smooth = { ...input, around: input.around.map((c) => c === null ? null : c.map((b) => (b === 0 ? 0 : (b << 8) | 255))) };
    const marched = marchChunk(smooth);
    expect(marched.opaque.indices.length).toBeGreaterThan(0);
    expect(await inline.run(VOXELS_MARCH, smooth)).toEqual(marched);
  });

  it('terrain.bake matches bakeTerrain for a real scene; fieldOf on the result answers like buildField', async () => {
    const spec = terrainSpec();
    const bake = await inline.run(TERRAIN_BAKE, spec);
    expect(bake).toEqual(bakeTerrain(spec));
    const direct = buildField(spec, 'terrain_sprint', 1);
    const field = fieldOf(bake, 'terrain_sprint', 1);
    expect(field.heights).toEqual(direct.heights);
    expect(field.weights).toEqual(direct.weights);
  });

  it('nav.paths finds the same paths as findPath, in request order (around a wall)', async () => {
    // 40×40 cells of 0.5 m, flat, with a wall at column 20 from row 0 to 34.
    const cols = 40;
    const rows = 40;
    const standable = new Uint8Array(cols * rows).fill(1);
    for (let r = 0; r < 35; r++) standable[r * cols + 20] = 0;
    const bake: NavBake = {
      cell: 0.5, radius: 0.4, i0: 0, k0: 0, cols, rows,
      heights: new Float64Array(cols * rows), implicit: new Uint8Array(cols * rows).fill(1), standable,
    };
    const requests = [
      { start: { x: 2, z: 2 }, goal: { x: 18, z: 2 }, snap: 1 },
      { start: { x: 2, z: 2 }, goal: { x: 3, z: 3 }, snap: 1 },
      { start: { x: 2, z: 2 }, goal: { x: 500, z: 500 }, snap: 1 },
    ];
    const direct = requests.map((r) => findPath(bake, r));
    expect(direct[0]!.length).toBeGreaterThan(2);
    expect(await inline.run(NAV_PATHS, { bake, requests })).toEqual(direct);
    const pool = new WorkerJobs({ create: fakeWorker, table: ENGINE_JOBS, threads: 1, idleSeconds: 0, onProblem: () => {} });
    expect(await pool.run(NAV_PATHS, { bake, requests })).toEqual(direct);
    pool.dispose();
  });

  it('a worker pool gives the same results, in input order, as inline', async () => {
    const pool = new WorkerJobs({ create: fakeWorker, table: ENGINE_JOBS, threads: 2, idleSeconds: 0, onProblem: () => {} });
    const inputs = [voxelInput(), { ...voxelInput(), cx: 1 }, { ...voxelInput(), cy: 1 }];
    const [viaPool, viaInline] = await Promise.all([pool.all(VOXELS_MESH, inputs), inline.all(VOXELS_MESH, inputs)]);
    expect(viaPool).toEqual(viaInline);
    expect(pool.live).toBe(2);
    expect(pool.stats).toEqual({ completed: 3, inline: 0, inlineSeconds: 0 });
    const bakes = await pool.all(TERRAIN_BAKE, [terrainSpec()]);
    expect(bakes[0]!.heights).toEqual(bakeTerrain(terrainSpec()).heights);
    pool.dispose();
  });
});
