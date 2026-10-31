import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { Json, JsonObject, Project } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { Fields, GameDefinition, SystemDef } from '../../kernel/index.js';
import { SAVE_SERVICE, VOXELS_SERVICE } from '../../services/index.js';
import type { SaveSection, VoxelWorldView } from '../../services/index.js';
import { streaming } from '../streaming/index.js';
import { BLOCK_CHANGED, BlockTable, Cell3, Landscape, readVoxelSpec, VOXEL_BLOCK, voxels } from './index.js';
import { latticeFbm } from './generate.js';
import type { VoxelsPlugin } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const DT = 1 / 60;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : `not a ParallaxError: ${String(error)}`;
  }
  return undefined;
}

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const BLOCKS: Record<string, unknown> = {
  'content/block/stone.json': { name: 'Stone', texture: 'images/stone' },
  'content/block/dirt.json': { name: 'Dirt' },
  'content/block/grass.json': { name: 'Grass' },
  'content/block/water.json': { name: 'Water', solid: false, transparent: true },
  'content/block/glass.json': { name: 'Glass', transparent: true },
  'content/block/torch.json': { name: 'Torch', solid: false, prefab: 'torch', prefab_renders: true },
  'content/block/chest.json': { name: 'Chest', prefab: 'chest' },
  'prefabs/torch.prefab.json': { components: {} },
  'prefabs/chest.prefab.json': { components: { crate: { items: 0 } } },
  'prefabs/eye.prefab.json': { components: { camera: {} } },
};

/** A flat world: grass at y = 0, dirt below, stone from y = -3, air above. */
const FLAT: JsonObject = {
  y_range: [-8, 24],
  render_distance: 2,
  generator: { type: 'landscape', base_height: 0, strata: [{ block: 'grass', depth: 1 }, { block: 'dirt', depth: 2 }, { block: 'stone' }] },
};

function project(voxelBlock: JsonObject | undefined = FLAT, extra: Record<string, unknown> = {}): Project {
  return loadProject(files({
    ...BLOCKS,
    'scenes/w/scene.json': { ...(voxelBlock !== undefined && { voxels: voxelBlock }), entities: [{ id: 'eye', prefab: 'eye', at: [0.5, 4, 0.5] }] },
    'scenes/other/scene.json': { entities: [] },
    ...extra,
  }));
}

interface Setup {
  readonly kernel: Kernel;
  readonly plugin: VoxelsPlugin;
  readonly events: Fields[];
  world(): VoxelWorldView;
  step(n?: number): void;
}

function setup(p: Project = project(), options: { saveEdits?: boolean; extraPlugins?: Parameters<typeof Kernel.prototype.provide>[] } = {}): Setup {
  const events: Fields[] = [];
  const listener: SystemDef = {
    id: 'listener', scenes: [], handlers: [{ event: BLOCK_CHANGED, method: 'changed' }],
    create: () => ({ changed: (_ctx: unknown, e: Fields) => events.push(e) }),
  };
  const game: GameDefinition = {
    components: [
      { id: 'camera', schema: { follow: t.json({ default: null }) } },
      { id: 'crate', schema: { items: t.int({ default: 0 }) } },
    ],
    resources: [], events: [], behaviors: [], systems: [listener],
  };
  const plugin = voxels({ chunkSize: 8, saveEdits: options.saveEdits ?? true, host: { block: (_k, id) => `ref:${id}` } });
  const kernel = new Kernel({ project: p, game, plugins: [plugin, streaming()] });
  kernel.start('w');
  return {
    kernel, plugin, events,
    world: () => kernel.service(VOXELS_SERVICE).current()!,
    step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

describe('voxels scene block', () => {
  const table = new BlockTable(project());
  const scene = (block: JsonObject) => ({
    id: 'w', path: 'scenes/w/scene.json', tags: [], ui: [], init: {}, entities: [], regions: new Map(), plugins: { voxels: block },
  });
  const bad = (block: JsonObject) => {
    try { readVoxelSpec(scene(block), table); } catch (e) { return (e as ParallaxError).diagnostic; }
    throw new Error('accepted');
  };

  it('reads a landscape and rejects bad data with pointers and fixes', () => {
    const spec = readVoxelSpec(scene(FLAT), table)!;
    expect(spec).toMatchObject({ yMin: -8, yMax: 24, renderDistance: 2 });
    expect(spec.generator!.strata.map((s) => s.depth)).toEqual([1, 2, undefined]);
    expect(bad({ y_range: [0, 8], render_distanse: 2 })).toMatchObject({ code: 'PP3620', pointer: '/voxels/render_distanse' });
    expect(bad({ y_range: [0, 8], render_distanse: 2 }).fix).toContain('render_distance');
    expect(bad({}).pointer).toBe('/voxels/y_range');
    expect(bad({ y_range: [8, 0] }).code).toBe('PP3620');
    const unknown = bad({ y_range: [0, 8], generator: { type: 'landscape', strata: [{ block: 'stoen' }] } });
    expect(unknown).toMatchObject({ code: 'PP3620', pointer: '/voxels/generator/strata/0/block' });
    expect(unknown.fix).toContain('"stone"');
    expect(bad({ y_range: [0, 8], generator: { type: 'landscape', strata: [{ block: 'chest' }] } }).code).toBe('PP3627');
    expect(bad({ y_range: [0, 8], generator: { type: 'landscape', strata: [{ block: 'dirt' }, { block: 'stone' }] } }).pointer)
      .toBe('/voxels/generator/strata/0/depth');
    expect(bad({ y_range: [0, 8], generator: { type: 'caves', strata: [{ block: 'stone' }] } }).pointer).toBe('/voxels/generator/type');
    const shaped = (extra: JsonObject) => bad({ y_range: [0, 8], generator: { type: 'landscape', strata: [{ block: 'stone' }], ...extra } });
    expect(shaped({ slopes: [{ direction: 90 }] }).pointer).toBe('/voxels/generator/slopes/0/rise');
    expect(shaped({ slopes: [{ rise: 4, surface: 'stoen' }] }).pointer).toBe('/voxels/generator/slopes/0/surface');
    expect(shaped({ slopes: [{ rise: 4, spires: { block: 'stone', spacing: [2, 9], size: 2 } }] }).pointer).toBe('/voxels/generator/slopes/0/spires/spacing');
    expect(shaped({ galleries: [{ from: [1, 1], to: [1, 1] }] }).pointer).toBe('/voxels/generator/galleries/0/to');
    expect(shaped({ tunnels: { y: -4, widht: 3 } }).pointer).toBe('/voxels/generator/tunnels/widht');
    expect(shaped({ noise: 'perlin' }).pointer).toBe('/voxels/generator/noise');
  });

  it('checks block entries against BlockDef', () => {
    const p = loadProject(files({ 'content/block/odd.json': { name: 'Odd', solid: 'yes' } }));
    expect(code(() => new BlockTable(p))).toBe('PP3622');
    const missing = loadProject(files({ 'content/block/odd.json': { name: 'Odd', prefab: 'nope' } }));
    expect(code(() => new BlockTable(missing))).toBe('PP3622');
  });
});

// ── The real voxel_survival generator ────────────────────────────────────────

const SANDBOX = '../../../../../../examples/voxel_survival/';
const sandboxRaw = import.meta.glob('../../../../../../examples/voxel_survival/{content,scenes,prefabs,features}/**/*.json', {
  query: '?raw', import: 'default', eager: true,
});
const sandbox: Project = loadProject({
  list: () => Object.keys(sandboxRaw).map((p) => p.slice(SANDBOX.length)).sort(),
  read: (path) => sandboxRaw[SANDBOX + path]!,
});

describe('landscape generator (voxel_survival greenwood)', () => {
  const table = new BlockTable(sandbox);
  const spec = readVoxelSpec(sandbox.scenes.get('greenwood')!, table)!;
  const land = new Landscape(spec.generator!, spec.yMin, spec.yMax);
  const id = (b: number): string => (b === 0 ? 'air' : table.type(b).id);

  it('fills chunks exactly as single cells ask', () => {
    const n = 16;
    for (const [cx, cy, cz] of [[0, 0, 0], [-1, 0, 2], [3, -1, -2], [5, 1, 5]] as const) {
      const out = new Uint16Array(n * n * n);
      land.fill(cx * n, cy * n, cz * n, n, out);
      for (let i = 0; i < out.length; i += 7) {
        const lx = i % n;
        const lz = Math.floor(i / n) % n;
        const ly = Math.floor(i / (n * n));
        expect(out[i]).toBe(land.blockAt(cx * n + lx, cy * n + ly, cz * n + lz));
      }
    }
  });

  it('is deterministic and layered as declared', () => {
    const again = new Landscape(spec.generator!, spec.yMin, spec.yMax);
    const counts = new Map<string, number>();
    let water = 0;
    let shore = 0;
    for (let x = -64; x < 64; x++) {
      for (let z = -64; z < 64; z++) {
        const h = land.height(x, z);
        expect(again.height(x, z)).toBe(h);
        expect(id(land.blockAt(x, spec.yMin, z))).toBe('bedrock');
        const top = id(land.blockAt(x, h, z));
        const gallery = x >= 12 && x <= 64 && Math.abs(z + 12) <= 2;
        if (gallery) continue;
        if (h <= 2) { expect(top).toBe('sand'); shore++; } else expect(['grass', 'stone']).toContain(top);
        if (h < 0) { expect(id(land.blockAt(x, 0, z))).toBe('water'); water++; }
        for (let y = spec.yMin; y < spec.yMax; y += 3) {
          const block = id(land.blockAt(x, y, z));
          counts.set(block, (counts.get(block) ?? 0) + 1);
        }
      }
    }
    for (const block of ['grass', 'dirt', 'stone', 'coal_ore', 'iron_ore', 'wood_log', 'leaves', 'bedrock']) {
      expect(counts.get(block) ?? 0, block).toBeGreaterThan(0);
    }
    expect(water + shore).toBeGreaterThan(0);
  });

  it('"lattice" noise gives the template generator\'s hills for the same seed', () => {
    // Reference values from the template's generator (fbm2 and its column heights, seed 1337).
    expect(latticeFbm(0, 0, 1337, 3, 0.035)).toBe(0.47601353779568206);
    expect(latticeFbm(10.5, -3.25, 1337, 3, 0.035)).toBe(0.47790963583945484);
    expect(latticeFbm(123, -456, 1337 + 3907, 2, 0.008)).toBe(0.693074408086578);
    const template: [number, number, number][] = [[0, 0, 3], [5, -3, 3], [-20, 10, 2], [0, -60, 11], [10, -100, 23],
      [60, 0, -9], [90, 5, -10], [-40, -40, 8], [30, -20, 4], [0, 30, 4]];
    for (const [x, z, h] of template) expect(land.height(x, z), `${x}, ${z}`).toBe(h);
  });

  it('is shaped like the template: a meadow at spawn, uplands north, a shore east, tunnels below', () => {
    const top = (x: number, z: number): string => id(land.blockAt(x, land.height(x, z), z));
    const tops = (xs: number[], zs: number[]): string[] => xs.flatMap((x) => zs.map((z) => top(x, z)));
    const range = (a: number, b: number, step = 3): number[] => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);
    const share = (list: string[], block: string): number => list.filter((b) => b === block).length / list.length;
    // Spawn: a low grass meadow around the template's sand flat, no stone uplands yet.
    const meadow = tops(range(-12, 8), range(-8, 12));
    expect(share(meadow, 'grass')).toBeGreaterThan(0.3);
    expect(share(meadow, 'grass') + share(meadow, 'sand')).toBeGreaterThan(0.95);
    // North (-z) rises into stone uplands with spires on top.
    const north = tops(range(-20, 20), range(-130, -110));
    expect(share(north, 'stone')).toBeGreaterThan(0.6);
    const meanHeight = (xs: number[], zs: number[]): number => xs.flatMap((x) => zs.map((z) => land.height(x, z))).reduce((a, b) => a + b, 0) / (xs.length * zs.length);
    expect(meanHeight(range(-20, 20), range(-130, -110)) - meanHeight(range(-12, 8), range(-8, 12))).toBeGreaterThan(8);
    let spires = 0;
    for (const x of range(-40, 40, 1)) for (const z of range(-130, -110, 1)) if (id(land.blockAt(x, land.height(x, z) + 1, z)) === 'stone') spires++;
    expect(spires).toBeGreaterThan(0);
    // East (+x) sinks into a sand shore and water.
    const east = tops(range(80, 100), range(-10, 10));
    expect(share(east, 'sand')).toBeGreaterThan(0.6);
    expect(id(land.blockAt(90, 0, 0))).toMatch(/water|sand/);
    // The gallery opens at the surface east of spawn and drops toward the tunnel level.
    expect(id(land.blockAt(20, land.height(20, -12), -12))).toBe('air');
    expect(id(land.blockAt(60, -11, -12))).toBe('air');
    // A tunnel lane runs along x deep underground: air at its centre line, rock above it.
    let tunnel = 0;
    for (const x of range(-60, 60, 4)) {
      const lane = Math.round(Math.sin(x * 0.035 + 1337 * 0.01) * 10);
      const ty = Math.round(-8 + Math.sin(x * 0.044 + 1337) * 3);
      if (land.height(x, lane) - ty >= 6 && id(land.blockAt(x, ty, lane)) === 'air') tunnel++;
    }
    expect(tunnel).toBeGreaterThan(10);
  });

  it('meshes the area around the player in a kernel', () => {
    // Prefab children's components too (the first-person `eye_camera` carries its `hands` child's `viewmodel`).
    const prefabComponents = [...sandbox.prefabs.values()].flatMap((p) => [p.components, ...p.children.map((c) => c.components)]);
    const game: GameDefinition = {
      components: [...new Set(prefabComponents.flatMap((c) => Object.keys(c)))]
        .map((id) => ({ id, schema: Object.fromEntries(Object.keys(Object.assign({}, ...prefabComponents.map((c) => c[id] ?? {}),
          ...sandbox.scenes.get('greenwood')!.entities.map((e) => e.components[id] ?? {}))).map((f) => [f, t.json({ default: null })])) })),
      resources: [], events: [], systems: [],
      behaviors: [...new Set([...sandbox.prefabs.values()].flatMap((p) => p.behaviors.map((b) => b.use)))].map((id) => ({
        id, params: Object.fromEntries([...new Set([...sandbox.prefabs.values()].flatMap((p) => p.behaviors.filter((b) => b.use === id)
          .flatMap((b) => Object.keys(b.params))).concat(sandbox.scenes.get('greenwood')!.entities.flatMap((e) => Object.keys(e.params[id] ?? {}))))]
          .map((f) => [f, t.json({ default: null })])), state: {}, requires: [], handlers: [], create: () => ({}),
      })),
    };
    const plugin = voxels({ chunkSize: 16, saveEdits: true, host: { block: (_k, id) => id } });
    const kernel = new Kernel({ project: sandbox, game, plugins: [plugin, streaming()] });
    kernel.start('greenwood');
    const world = kernel.service(VOXELS_SERVICE).current()!;
    const began = performance.now();
    const meshes = world.active();
    const ms = performance.now() - began;
    const quads = meshes.reduce((n, m) => n + (m.opaque.indices.length + m.transparent.indices.length) / 6, 0);
    console.log(`greenwood: ${meshes.length} chunk meshes, ${quads} quads, ${Math.round(ms)} ms`);
    expect(meshes.length).toBeGreaterThan(169);
    // The test's chest: on the surface at (3, 3), as tests/test_survival.py places it.
    const y = plugin.engine.surfaceHeight(3, 3);
    plugin.engine.set(3, y, 3, 'chest', null);
    expect(kernel.world.get(plugin.engine.blockEntity(3, y, 3)!)!.prefab).toBe('chest');
  });

  it('grows whole trees on grass and keeps ores below their depth', () => {
    let trees = 0;
    for (let x = -80; x < 80; x++) {
      for (let z = -80; z < 80; z++) {
        const h = land.height(x, z);
        if (id(land.blockAt(x, h + 1, z)) !== 'wood_log') continue;
        // Ruins are laid before trees and win where a wall crosses a trunk.
        if ([2, 3, 4].some((d) => id(land.blockAt(x, h + d, z)) === 'bricks')) continue;
        trees++;
        expect(id(land.blockAt(x, h, z))).toBe('grass');
        let top = h + 1;
        while (id(land.blockAt(x, top + 1, z)) === 'wood_log') top++;
        expect(top - h).toBeGreaterThanOrEqual(4);
        expect(top - h).toBeLessThanOrEqual(6);
        expect(id(land.blockAt(x, top + 1, z))).toBe('leaves');
        expect(id(land.blockAt(x + 2, top, z))).toBe('leaves');
      }
      for (let y = 0; y < 3; y++) {
        const h = land.height(x, 0);
        if (h - y < 2) expect(id(land.blockAt(x, y, 0))).not.toMatch(/_ore$/);
      }
    }
    expect(trees).toBeGreaterThan(10);
  });
});

// ── The plugin in a kernel ─────────────────────────────────────────────────────

describe('voxels plugin', () => {
  it('reads and edits blocks, emitting block_changed once per change', () => {
    const s = setup();
    const v = s.plugin.engine;
    expect(v.get(0, 0, 0)).toBe('grass');
    expect(v.get(0, -1, 0)).toBe('dirt');
    expect(v.get(0, -5, 0)).toBe('stone');
    expect(v.get(0, 1, 0)).toBeNull();
    expect(v.get(0, 99, 0)).toBeNull();
    expect(v.surfaceHeight(3, -7)).toBe(1);

    v.set(2, 1, 2, 'stone', 'player');
    v.set(2, 1, 2, 'stone', null);
    s.step();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ old: null, new: 'ref:stone', source: 'player' });
    expect((s.events[0]!['cell'] as Cell3).__eq__(new Cell3(2, 1, 2))).toBe(true);
    expect(v.surfaceHeight(2, 2)).toBe(2);
    v.set(0, 0, 0, null, null);
    expect(v.get(0, 0, 0)).toBeNull();
    expect(code(() => v.set(0, 24, 0, 'stone', null))).toBe('PP3623');
    expect(code(() => v.set(0, 1, 0, 'stoen', null))).toBe('PP3624');
  });

  it('keeps edits a minimal diff against the generated world', () => {
    const s = setup();
    const v = s.plugin.engine;
    v.set(1, 0, 1, 'stone', null);
    v.set(-9, 5, 4, 'glass', null);
    v.set(1, 0, 1, 'grass', null);
    expect(s.world().exportEdits()).toEqual({ format: 1, scenes: { w: [[-9, 5, 4, 'glass']] } });
  });

  it('spawns and destroys block entities with their cell', () => {
    const s = setup();
    const v = s.plugin.engine;
    v.set(4, 1, 4, 'chest', null);
    const chest = v.blockEntity(4, 1, 4)!;
    const record = s.kernel.world.get(chest)!;
    expect(record.prefab).toBe('chest');
    expect(record.transform.position.__eq__(new Vec3(4.5, 1, 4.5))).toBe(true);
    expect((record.components.get(VOXEL_BLOCK)!['cell'] as Cell3).toJSON()).toEqual([4, 1, 4]);
    v.set(4, 1, 4, 'torch', null);
    const torch = v.blockEntity(4, 1, 4)!;
    expect(torch).not.toBe(chest);
    expect(s.kernel.world.isAlive(chest)).toBe(false);
    v.set(4, 1, 4, null, null);
    expect(v.blockEntity(4, 1, 4)).toBeUndefined();
    s.step();
    expect(s.kernel.world.isAlive(torch)).toBe(false);
  });

  it('raycasts to solid and prefab-drawn blocks, through water', () => {
    const s = setup();
    const v = s.plugin.engine;
    const down = v.raycast(new Vec3(0.5, 5.5, 0.5), new Vec3(0, -1, 0), 10)!;
    expect(down).toMatchObject({ x: 0, y: 0, z: 0, face: [0, 1, 0] });
    expect(down.distance).toBeCloseTo(4.5);
    expect(v.raycast(new Vec3(0.5, 5.5, 0.5), new Vec3(0, -1, 0), 4)).toBeUndefined();
    v.set(0, 2, 0, 'water', null);
    v.set(3, 1, 0, 'torch', null);
    expect(v.raycast(new Vec3(0.5, 5.5, 0.5), new Vec3(0, -2, 0), 10)).toMatchObject({ y: 0 });
    expect(v.raycast(new Vec3(0.5, 1.5, 0.5), new Vec3(1, 0, 0), 10)).toMatchObject({ x: 3, y: 1, face: [-1, 0, 0] });
    expect(v.raycast(new Vec3(0.5, 0.5, 0.5), new Vec3(1, 0, 0), 10)).toMatchObject({ x: 0, distance: 0, face: [-1, 0, 0] });
    expect(v.raycast(new Vec3(0.5, 5, 0.5), new Vec3(0, 1, 0), 100)).toBeUndefined();
    expect(code(() => v.raycast(Vec3.ZERO, Vec3.ZERO, 1))).toBe('PP3629');
  });

  it('meshes chunks around the camera with greedy quads and versions', () => {
    const s = setup();
    const world = s.world();
    const active = world.active();
    // render_distance 2 around the camera's chunk column; y chunks with blocks only.
    const columns = new Set(active.map((m) => `${m.cx},${m.cz}`));
    expect(columns.size).toBe(25);
    const top = active.find((m) => m.cx === 0 && m.cy === 0 && m.cz === 0)!;
    // The flat grass surface of an 8 × 8 chunk is one quad facing up.
    const up: number[] = [];
    for (let i = 0; i < top.opaque.normals.length; i += 3) if (top.opaque.normals[i + 1] === 1) up.push(i / 3);
    expect(up).toHaveLength(4);
    expect(top.opaque.indices).toHaveLength(6);
    expect(top.transparent.indices).toHaveLength(0);
    expect(top.collision.indices).toHaveLength(6);
    expect([...top.opaque.uvs]).toEqual([0, 0, 8, 0, 8, 8, 0, 8]);
    // Counter-clockwise from above: (b - a) × (c - a) points up.
    const p = top.opaque.positions;
    const [a, b, c] = [0, 1, 2].map((k) => new Vec3(p[3 * top.opaque.indices[k]!]!, p[3 * top.opaque.indices[k]! + 1]!, p[3 * top.opaque.indices[k]! + 2]!));
    expect(b!.__sub__(a!).cross(c!.__sub__(a!)).y).toBeGreaterThan(0);
    expect(world.active()).toBe(active);

    // A glass block on the surface: 5 transparent faces, the grass under it is still drawn.
    s.plugin.engine.set(3, 1, 3, 'glass', null);
    const again = world.active().find((m) => m.key === top.key)!;
    expect(again.version).toBeGreaterThan(top.version);
    expect(again.transparent.indices.length / 6).toBe(5);
    expect(again.opaque.indices.length / 6).toBe(1);
    // A torch is drawn by its prefab: no faces, no collision.
    s.plugin.engine.set(3, 1, 3, 'torch', null);
    const torch = world.active().find((m) => m.key === top.key)!;
    expect(torch.transparent.indices).toHaveLength(0);
    expect(torch.collision.indices).toHaveLength(6);
    expect(world.active(1).length).toBeLessThan(world.active().length);
    expect(code(() => world.active(3))).toBe('PP3629');
  });

  it('snapshots and restores edits and block entities', () => {
    const s = setup();
    const v = s.plugin.engine;
    v.set(1, 1, 1, 'chest', null);
    v.set(5, 0, 5, null, null);
    s.step();
    const snap = s.kernel.snapshot();
    v.set(1, 1, 1, null, null);
    v.set(7, 1, 7, 'stone', null);
    s.step();
    s.kernel.restore(snap);
    expect(v.get(1, 1, 1)).toBe('chest');
    expect(v.get(5, 0, 5)).toBeNull();
    expect(v.get(7, 1, 7)).toBeNull();
    const chest = v.blockEntity(1, 1, 1)!;
    expect(s.kernel.world.get(chest)!.components.get(VOXEL_BLOCK)!['cell']).toBeInstanceOf(Cell3);
    expect(JSON.stringify(s.kernel.snapshot())).toBe(JSON.stringify(snap));
  });

  it('keeps edits across scene changes, brings block entities back, and clears them on new_run=True', () => {
    const s = setup();
    const v = s.plugin.engine;
    v.set(1, 1, 1, 'chest', null);
    v.set(2, 1, 1, 'stone', null);
    s.kernel.requestScene('other');
    s.step();
    expect(s.kernel.service(VOXELS_SERVICE).current()).toBeNull();
    expect(code(() => v.get(0, 0, 0))).toBe('PP3625');
    s.kernel.requestScene('w');
    s.step();
    expect(v.get(2, 1, 1)).toBe('stone');
    expect(v.blockEntity(1, 1, 1)).toBeUndefined();
    s.step();
    expect(s.kernel.world.get(v.blockEntity(1, 1, 1)!)!.prefab).toBe('chest');
    s.kernel.requestScene('w', { newRun: true });
    s.step(2);
    expect(v.get(2, 1, 1)).toBeNull();
    expect(v.blockEntity(1, 1, 1)).toBeUndefined();
  });

  it('saves edits through the save service section and loads them back', () => {
    const sections: SaveSection[] = [];
    const p = project();
    const game: GameDefinition = {
      components: [{ id: 'camera', schema: { follow: t.json({ default: null }) } }, { id: 'crate', schema: { items: t.int({ default: 0 }) } }],
      resources: [], events: [], behaviors: [], systems: [],
    };
    const plugin = voxels({ chunkSize: 8, saveEdits: true, host: { block: (_k, id) => id } });
    const saver = { id: 'fake_save', install: (k: Kernel) => k.provide(SAVE_SERVICE, { register: (sec: SaveSection) => sections.push(sec) }) };
    const kernel = new Kernel({ project: p, game, plugins: [plugin, saver, streaming()] });
    kernel.start('w');
    expect(sections.map((x) => x.key)).toEqual(['voxels', 'world_layers']);
    plugin.engine.set(1, 1, 1, 'chest', null);
    plugin.engine.set(3, 0, 3, null, null);
    const saved: Json = sections[0]!.save();
    expect(saved).toEqual({ format: 1, scenes: { w: [[1, 1, 1, 'chest'], [3, 0, 3, null]] } });

    plugin.engine.set(1, 1, 1, null, null);
    plugin.engine.set(6, 1, 6, 'torch', null);
    const torch = plugin.engine.blockEntity(6, 1, 6)!;
    sections[0]!.load(saved);
    expect(plugin.engine.get(6, 1, 6)).toBeNull();
    expect(kernel.world.isAlive(torch)).toBe(false);
    expect(plugin.engine.get(1, 1, 1)).toBe('chest');
    kernel.step(DT);
    expect(kernel.world.get(plugin.engine.blockEntity(1, 1, 1)! as EntityId)!.prefab).toBe('chest');
    expect(code(() => sections[0]!.load({ format: 1, scenes: { w: [[0, 0, 0, 'nope']] } }))).toBe('PP3628');
    sections[0]!.load(undefined);
    expect(plugin.engine.get(1, 1, 1)).toBeNull();
  });
});
