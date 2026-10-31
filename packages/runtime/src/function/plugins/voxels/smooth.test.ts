import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { JobKey, JobRunner, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { JOBS_SERVICE, VOXELS_SERVICE } from '../../services/index.js';
import type { VoxelChunkMesh, VoxelWorldView } from '../../services/index.js';
import { streaming } from '../streaming/index.js';
import { densityFromDistance, marchChunk, meshChunk, voxels, VOXELS_MARCH } from './index.js';
import type { ChunkNeighbourhood } from './index.js';

/** Every directed edge appears once and its reverse once, after welding by position. */
function watertight(meshes: readonly { positions: Float32Array; indices: Uint32Array }[]): boolean {
  const ids = new Map<string, number>();
  const edges = new Map<string, number>();
  for (const m of meshes) {
    const id = (i: number): number => {
      const key = [0, 1, 2].map((k) => Math.round(m.positions[i * 3 + k]! * 1e4)).join(',');
      let v = ids.get(key);
      if (v === undefined) ids.set(key, v = ids.size);
      return v;
    };
    for (let t = 0; t < m.indices.length; t += 3) {
      const v = [id(m.indices[t]!), id(m.indices[t + 1]!), id(m.indices[t + 2]!)];
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
      for (let k = 0; k < 3; k++) {
        const key = `${v[k]}>${v[(k + 1) % 3]}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
  }
  if (edges.size === 0) return false;
  for (const [key, count] of edges) {
    const [a, b] = key.split('>');
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** 27 chunks of a lattice given by a function of world (x, y, z). */
function neighbourhood(size: number, cx: number, cy: number, cz: number, value: (x: number, y: number, z: number) => number): ChunkNeighbourhood {
  const around: Uint16Array[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = new Uint16Array(size ** 3);
        for (let i = 0; i < c.length; i++) {
          const x = (cx + dx) * size + (i % size);
          const z = (cz + dz) * size + (Math.floor(i / size) % size);
          const y = (cy + dy) * size + Math.floor(i / size / size);
          c[i] = value(x, y, z);
        }
        around.push(c);
      }
    }
  }
  return { size, yMin: -1000, yMax: 1000, types: [undefined, { index: 1, id: 'rock', texture: null, hardness: 1, solid: true, transparent: false, light: 0, prefab: null, prefabRenders: false }], around, cx, cy, cz };
}

const sphere = (c: readonly number[], r: number) => (x: number, y: number, z: number): number =>
  (1 << 8) | densityFromDistance(r - Math.hypot(x - c[0]!, y - c[1]!, z - c[2]!));

describe('marching', () => {
  it('a blob inside one chunk is a closed surface facing out', () => {
    const mesh = marchChunk(neighbourhood(16, 0, 0, 0, sphere([8, 8, 8], 5))).opaque;
    expect(watertight([mesh])).toBe(true);
    // Outward: normals point away from the center; radius within a few centimeters.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const d = [mesh.positions[i]! - 8, mesh.positions[i + 1]! - 8, mesh.positions[i + 2]! - 8];
      expect(Math.abs(Math.hypot(d[0]!, d[1]!, d[2]!) - 5)).toBeLessThan(0.1);
      expect(d[0]! * mesh.normals[i]! + d[1]! * mesh.normals[i + 1]! + d[2]! * mesh.normals[i + 2]!).toBeGreaterThan(0);
      expect(mesh.blocks[i / 3]).toBe(1);
    }
  });

  it('a blob across chunk borders closes when the chunks are joined', () => {
    const f = sphere([8, 8, 8], 4.5);
    const parts = [];
    for (const cx of [0, 1]) for (const cy of [0, 1]) for (const cz of [0, 1]) parts.push(marchChunk(neighbourhood(8, cx, cy, cz, f)).opaque);
    expect(parts.filter((p) => p.indices.length > 0)).toHaveLength(8);
    expect(watertight(parts)).toBe(true);
    // Each chunk alone is open at the borders.
    expect(watertight([parts[0]!])).toBe(false);
  });
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const SMOOTH = {
  mode: 'smooth', y_range: [-8, 24], render_distance: 1,
  generator: { type: 'landscape', base_height: 4, amplitude: 3, frequency: 0.08, strata: [{ block: 'grass', depth: 1 }, { block: 'stone' }] },
};

function setup(block: unknown = SMOOTH, jobs?: JobRunner) {
  const project = loadProject(files({
    'content/block/stone.json': { name: 'Stone' },
    'content/block/grass.json': { name: 'Grass' },
    'prefabs/eye.prefab.json': { components: { camera: {} } },
    'scenes/w/scene.json': { voxels: block, entities: [{ prefab: 'eye', at: [4, 10, 4] }] },
  }));
  const game: GameDefinition = { components: [{ id: 'camera', schema: { follow: t.json({ default: null }) } }], resources: [], events: [], behaviors: [], systems: [] };
  const plugin = voxels({ chunkSize: 8, saveEdits: true, host: { block: (_k, id) => `ref:${id}` } });
  const kernel = new Kernel({ project, game, plugins: [plugin, streaming()] });
  if (jobs !== undefined) kernel.provide(JOBS_SERVICE, jobs);
  kernel.start('w');
  return { kernel, plugin, world: (): VoxelWorldView => kernel.service(VOXELS_SERVICE).current()! };
}

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as ParallaxError).diagnostic.code; }
  return undefined;
};

describe('smooth voxel worlds', () => {
  it('generates a smooth surface at the relief, meshed per chunk, closed across the active area', () => {
    const { world, plugin } = setup();
    const w = world();
    expect(w.mode).toBe('smooth');
    const chunks = w.active();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.transparent.indices.length === 0 && c.collision.indices === c.opaque.indices)).toBe(true);
    // The surface height is near the generator's continuous relief, not a whole block.
    const h = plugin.engine.heightAt(3.5, 2.25);
    expect(h).toBeGreaterThan(0);
    expect(h % 1).not.toBe(0);
    expect(plugin.engine.densityAt(new Vec3(3.5, h - 0.5, 2.25))).toBeGreaterThan(0.5);
    expect(plugin.engine.densityAt(new Vec3(3.5, h + 0.5, 2.25))).toBeLessThan(0.5);
    expect(plugin.engine.get(3, Math.floor(h) - 3, 2)).toBe('stone');
  });

  it('dig removes material, remeshes the chunks it touches, and is saved as a diff', () => {
    const { world, plugin, kernel } = setup();
    const before = new Map(world().active().map((c) => [c.key, c.version]));
    const h = plugin.engine.heightAt(4, 4);
    const removed = plugin.engine.carve('dig', new Vec3(4, h, 4), 2.5, 1, null);
    expect([...removed.keys()].sort()).toEqual(['grass', 'stone']);
    expect([...removed.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
    expect(plugin.engine.densityAt(new Vec3(4, h - 1, 4))).toBeLessThan(0.5);
    const after = world().active();
    expect(after.some((c) => (before.get(c.key) ?? -1) !== c.version)).toBe(true);
    // Fill puts material back as the brush's block.
    const added = plugin.engine.carve('fill', new Vec3(4, h - 1, 4), 1.5, 1, 'stone');
    expect([...added.keys()]).toEqual(['stone']);
    expect(plugin.engine.get(4, Math.round(h - 1), 4)).toBe('stone');
    // Edits round-trip through export/load as [x, y, z, material, density].
    const saved = world().exportEdits() as { scenes: Record<string, unknown[][]> };
    expect(saved.scenes['w']![0]).toHaveLength(5);
    const restored = setup();
    restored.world().loadEdits(saved as never);
    expect(restored.plugin.engine.densityAt(new Vec3(4, h - 1, 4))).toBeCloseTo(plugin.engine.densityAt(new Vec3(4, h - 1, 4)), 9);
    // Snapshots hold the edits too.
    const snap = kernel.snapshot();
    plugin.engine.carve('dig', new Vec3(0, h, 0), 2, 1, null);
    kernel.restore(snap);
    expect(plugin.engine.densityAt(new Vec3(0, h - 0.5, 0))).toBeGreaterThan(0.5);
  });

  it('raycasts hit the smooth surface; set writes whole lattice points', () => {
    const { plugin } = setup();
    const h = plugin.engine.heightAt(2, 2);
    const hit = plugin.engine.raycast(new Vec3(2, 20, 2), new Vec3(0, -1, 0), 40)!;
    expect(hit).toBeDefined();
    expect(Math.abs(20 - hit.distance - h)).toBeLessThan(0.05);
    expect(hit.face).toEqual([0, 1, 0]);
    plugin.engine.set(2, 18, 2, 'stone', null);
    expect(plugin.engine.get(2, 18, 2)).toBe('stone');
    expect(plugin.engine.raycast(new Vec3(2, 20, 2), new Vec3(0, -1, 0), 40)!.distance).toBeLessThan(2.5);
  });

  it('rejects block-only data and block-world calls with coded errors', () => {
    expect(code(() => setup({ ...SMOOTH, generator: { ...SMOOTH.generator, trees: { trunk: 'stone', leaves: 'grass', on: 'grass' } } }))).toBe('PP3620');
    expect(code(() => setup({ ...SMOOTH, generator: { ...SMOOTH.generator, tunnels: { y: -4 } } }))).toBe('PP3620');
    expect(code(() => setup({ ...SMOOTH, generator: { ...SMOOTH.generator, slopes: [{ rise: 4, surface: 'stone' }] } }))).toBe('PP3620');
    // A slope without blocks of its own still shapes a smooth world.
    expect(code(() => setup({ ...SMOOTH, generator: { ...SMOOTH.generator, slopes: [{ rise: 4 }] } }))).toBeUndefined();
    expect(code(() => setup({ ...SMOOTH, mode: 'mushy' }))).toBe('PP3620');
    const blocks = setup({ ...SMOOTH, mode: 'blocks' });
    expect(code(() => blocks.plugin.engine.carve('dig', new Vec3(0, 0, 0), 2, 1, null))).toBe('PP3629');
    const smooth = setup();
    expect(code(() => smooth.plugin.engine.carve('dig', new Vec3(0, 0, 0), 0, 1, null))).toBe('PP3629');
  });

  it('meshes through a worker job runner with the same result, a frame later', async () => {
    const inline = setup().world().active();
    const calls: string[] = [];
    const runner: JobRunner = {
      mode: 'workers', threads: 2,
      run: <I, O>(key: JobKey<I, O>, input: I): Promise<O> => {
        calls.push(key.id);
        const fn = key.id === VOXELS_MARCH.id ? marchChunk : meshChunk;
        return Promise.resolve(structuredClone(fn(structuredClone(input) as unknown as ChunkNeighbourhood)) as unknown as O);
      },
      all: () => { throw new Error('unused'); },
      share: (b) => b,
      stats: { jobs: 0, queued: 0, running: 0, failed: 0 } as never,
      dispose: () => {},
    };
    const { world } = setup(SMOOTH, runner);
    expect(world().active()).toHaveLength(0);
    expect(calls.every((c) => c === 'voxels.march')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const viaJobs: VoxelChunkMesh[] = [...world().active()];
    expect(viaJobs.map((c) => c.key)).toEqual(inline.map((c) => c.key));
    viaJobs.forEach((c, i) => expect(c.opaque).toEqual(inline[i]!.opaque));
  });
});
