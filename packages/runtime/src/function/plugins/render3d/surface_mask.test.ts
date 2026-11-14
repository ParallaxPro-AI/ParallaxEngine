import { describe, expect, it } from 'vitest';
import { kw, Vec3 } from '../../../core/index.js';
import type { EntityId, Frame3d, Material3d, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { MATERIAL_FIELDS, MATERIAL_SLOT, offsetOf, packMaterial } from '../../../platform/browser/render3d/layout.js';
import { GLSL_PAINT, WGSL_PAINT } from '../../../platform/browser/render3d/paint_shaders.js';
import { maskOf, visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { render3d } from './index.js';
import { invertAffine, worldToVolume } from './surface_mask.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const map = new Map(Object.entries(contents).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => [...map.keys()].sort(), read: (p) => map.get(p)! };
}

type Mask = Fields & {
  clean(...args: unknown[]): number; paint(...args: unknown[]): number; coverage(...args: unknown[]): number;
  amount_at(...args: unknown[]): number; fill(...args: unknown[]): void; reset(...args: unknown[]): void; ready: boolean; cells: number;
};

async function run(prefabs: Record<string, unknown>, entities: unknown[], extra: Record<string, unknown> = {}): Promise<{
  kernel: Kernel; frame(): Frame3d; id(placed: string): EntityId; step(n?: number): void; mask(placed: string): Mask;
}> {
  const project = files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
    ...extra,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project });
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({
    project: loaded, game, context: {}, fixedStep: DT,
    plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}) }), plugin],
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel,
    frame: () => surface.last!,
    id,
    step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
    mask: (placed) => kernel.world.get(id(placed))!.components.get('surface_mask') as Mask,
  };
}

const CAMERA = { components: { camera: { fov: 60 } } };
const MUD = { name: 'mud', color: '#5b4630', roughness: 0.95 };
const PAINT = { name: 'paint', color: '#f0f0f0', roughness: 0.2, coverage: 0 };

const materialOf = (frame: Frame3d, entity: EntityId): Material3d => frame.meshes.find((b) => b.entities.includes(entity))!.material;

describe('surface masks', () => {
  it('a box starts covered and a brush cleans only the cells around its point', async () => {
    const r = await run(
      { cam: CAMERA, crate: { components: { shape: { kind: 'box', size: [1, 1, 1] }, surface_mask: { layers: [MUD], resolution: 20 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'c', prefab: 'crate', at: [2, 0.5, 0] }],
    );
    const mask = r.mask('c');
    expect(mask.ready).toBe(true);
    expect(mask.cells).toBeGreaterThan(400);
    expect(mask.coverage()).toBeCloseTo(1, 6);
    // The top face's middle, in world space (the crate stands at x = 2).
    const top = new Vec3(2, 1, 0);
    expect(mask.amount_at(top, 'mud')).toBeCloseTo(1, 6);
    const cleaned = mask.clean(top, 0.3, 'mud', kw({ strength: 1, hardness: 1 }));
    expect(cleaned).toBeGreaterThan(0);
    expect(mask.amount_at(top, 'mud')).toBeCloseTo(0, 6);
    expect(mask.amount_at(new Vec3(2, 0, 0), 'mud')).toBeCloseTo(1, 6);
    expect(mask.coverage('mud')).toBeCloseTo(1 - cleaned, 6);
    expect(mask.coverage('mud')).toBeLessThan(1);
    expect(mask.coverage('mud')).toBeGreaterThan(0.85);
  });

  it('an erase reaches a layer only where the layers above it are gone, unless exposed=False', async () => {
    const r = await run(
      { cam: CAMERA, blade: { components: { shape: { kind: 'box', size: [1, 0.1, 0.2] }, surface_mask: { layers: [{ name: 'haze', color: '#999999' }, { name: 'rust', color: '#8a4a20' }], resolution: 40 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'k', prefab: 'blade', at: [0, 0, 0] }],
    );
    const mask = r.mask('k');
    const p = new Vec3(0, 0.05, 0);
    mask.clean(p, 0.1, 'haze', kw({ strength: 1, hardness: 1 }));
    expect(mask.amount_at(p, 'haze')).toBeCloseTo(1, 6);
    mask.clean(p, 0.1, 'rust', kw({ strength: 0.5, hardness: 1 }));
    expect(mask.amount_at(p, 'rust')).toBeCloseTo(0.5, 6);
    mask.clean(p, 0.1, 'haze', kw({ strength: 1, hardness: 1 }));
    expect(mask.amount_at(p, 'haze')).toBeCloseTo(0.5, 6);
    mask.clean(p, 0.1, 'haze', kw({ strength: 0.25, hardness: 1, exposed: false }));
    expect(mask.amount_at(p, 'haze')).toBeCloseTo(0.25, 6);
    // None: every layer, top first, so one strong stroke takes both.
    mask.clean(p, 0.1, kw({ strength: 1, hardness: 1 }));
    expect(mask.amount_at(p)).toBeCloseTo(0, 6);
    expect(mask.coverage(['rust', 'haze'])).toBeLessThan(1);
  });

  it('paint adds to a layer, fill and reset set them back, and an unknown layer is an error', async () => {
    const r = await run(
      { cam: CAMERA, block: { components: { shape: { kind: 'box', size: [2, 1, 4] }, surface_mask: { layers: [MUD, PAINT], resolution: 32 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -8] }, { id: 'block', prefab: 'block', at: [0, 0.5, 0] }],
    );
    const mask = r.mask('block');
    expect(mask.coverage('paint')).toBe(0);
    const side = new Vec3(1, 0.5, 0);
    expect(mask.paint(side, 0.4, 'paint', kw({ hardness: 1 }))).toBeGreaterThan(0);
    expect(mask.amount_at(side, 'paint')).toBeCloseTo(1, 6);
    expect(mask.coverage('paint')).toBeGreaterThan(0);
    mask.fill('mud', 0);
    expect(mask.coverage('mud')).toBe(0);
    mask.reset();
    expect(mask.coverage('mud')).toBeCloseTo(1, 6);
    expect(mask.coverage('paint')).toBe(0);
    expect(() => mask.clean(side, 0.2, 'grime')).toThrow(/no layer "grime"/);
  });

  it('partial starting coverage makes blotches, more of them low down with `below`', async () => {
    const r = await run(
      { cam: CAMERA, wall: { components: { shape: { kind: 'box', size: [4, 4, 0.2] }, surface_mask: { layers: [{ name: 'moss', coverage: 0.5, pattern: 2, below: 1 }], resolution: 64 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -8] }, { id: 'w', prefab: 'wall', at: [0, 2, 0] }],
    );
    const mask = r.mask('w');
    const coverage = mask.coverage('moss');
    expect(coverage).toBeGreaterThan(0.2);
    expect(coverage).toBeLessThan(0.8);
    let low = 0;
    let high = 0;
    for (let x = -1.8; x <= 1.8; x += 0.2) {
      low += mask.amount_at(new Vec3(x, 0.4, -0.1), 'moss');
      high += mask.amount_at(new Vec3(x, 3.6, -0.1), 'moss');
    }
    expect(low).toBeGreaterThan(high);
  });

  it('a model document lays the mask on its triangles; the brush follows the entity as it moves', async () => {
    const slab = {
      format: 'parallax.model', version: 1,
      materials: { stone: { color: '#888888' }, trim: { color: '#444444' } },
      parts: [
        { name: 'top', shape: 'box', position: [0, 0.05, 0], size: [2, 0.1, 1], material: 'stone' },
        { name: 'leg', shape: 'box', position: [0, -0.5, 0], size: [0.2, 1, 0.2], material: 'trim' },
      ],
    };
    const r = await run(
      { cam: CAMERA, slab: { components: { model: { model: 'models/slab' }, surface_mask: { layers: [MUD], resolution: 48, material: 'stone' } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -6] }, { id: 's', prefab: 'slab', at: [0, 1, 0] }],
      { 'assets/models/slab.model.json': slab },
    );
    const mask = r.mask('s');
    expect(mask.ready).toBe(true);
    const record = r.kernel.world.get(r.id('s'))!;
    const state = maskOf(r.kernel, record, mask)!;
    // The volume hugs the stone triangles' bounds (2 × 0.1 × 1 m) with a cell of margin: the trim leg is left out.
    expect(state.cell).toBeCloseTo(2 / 48, 6);
    expect(state.min[1]).toBeCloseTo(-2 / 48, 4);
    expect(mask.amount_at(new Vec3(0.1, 0.5, 0))).toBe(0);
    expect(state.surface.length).toBeLessThan(state.nx * state.ny * state.nz);
    expect(() => {
      const fields = { ...mask, material: 'gold' };
      return maskOf(r.kernel, record, fields as never);
    }).toThrow(/draws nothing with that material/);

    record.transform.position = new Vec3(5, 1, 0);
    r.step();
    mask.clean(new Vec3(5, 1.1, 0), 0.25, kw({ hardness: 1 }));
    expect(mask.amount_at(new Vec3(5, 1.1, 0))).toBeCloseTo(0, 6);
    expect(mask.amount_at(new Vec3(5.8, 1.1, 0))).toBeCloseTo(1, 6);

    // Only the named material is painted; the swapped material carries this frame's volume.
    r.step();
    const drawn = r.frame().meshes.filter((b) => b.entities.includes(record.id));
    const stone = drawn.find((b) => b.material.paint !== undefined)!.material;
    expect(drawn.filter((b) => b.material.paint !== undefined)).toHaveLength(1);
    expect(stone.id).toContain('|paint:');
    const toVolume = stone.paint!.worldToVolume;
    const at = (p: [number, number, number]): number[] => [0, 1, 2].map((row) => toVolume[row]! * p[0] + toVolume[4 + row]! * p[1] + toVolume[8 + row]! * p[2] + toVolume[12 + row]!);
    const corner = at([5 + state.min[0], 1 + state.min[1], state.min[2]]);
    corner.forEach((v) => expect(v).toBeCloseTo(0, 5));
  });

  it('coverage leaves out surfaces sealed inside the model, unless `inside` counts them', async () => {
    // A hollow box: an outer shell 2 m wide with a crate sealed inside it.
    const shell = {
      format: 'parallax.model', version: 1,
      materials: { wall: { color: '#888888' } },
      parts: [
        { name: 'floor', shape: 'box', position: [0, -0.95, 0], size: [2, 0.1, 2], material: 'wall' },
        { name: 'roof', shape: 'box', position: [0, 0.95, 0], size: [2, 0.1, 2], material: 'wall' },
        { name: 'w1', shape: 'box', position: [-0.95, 0, 0], size: [0.1, 2, 2], material: 'wall' },
        { name: 'w2', shape: 'box', position: [0.95, 0, 0], size: [0.1, 2, 2], material: 'wall' },
        { name: 'w3', shape: 'box', position: [0, 0, -0.95], size: [2, 2, 0.1], material: 'wall' },
        { name: 'w4', shape: 'box', position: [0, 0, 0.95], size: [2, 2, 0.1], material: 'wall' },
        { name: 'crate', shape: 'box', position: [0, 0, 0], size: [0.6, 0.6, 0.6], material: 'wall' },
      ],
    };
    const r = await run(
      {
        cam: CAMERA,
        outer: { components: { model: { model: 'models/shell' }, surface_mask: { layers: [MUD], resolution: 40 } } },
        all: { components: { model: { model: 'models/shell' }, surface_mask: { layers: [MUD], resolution: 40, inside: true } } },
      },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -6] }, { id: 'o', prefab: 'outer', at: [0, 1, 0] }, { id: 'a', prefab: 'all', at: [5, 1, 0] }],
      { 'assets/models/shell.model.json': shell },
    );
    const outer = r.mask('o');
    const all = r.mask('a');
    expect(all.cells).toBeGreaterThan(outer.cells);
    // Cleaning the whole outside reaches 0 coverage only when the sealed crate is left out.
    outer.clean(new Vec3(0, 1, 0), 3, kw({ hardness: 1, strength: 1 }));
    all.clean(new Vec3(5, 1, 0), 3, kw({ hardness: 1, strength: 1 }));
    outer.reset();
    all.reset();
    for (const [mask, x] of [[outer, 0], [all, 5]] as const) {
      for (const p of [[0, 2, 0], [0, 0, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
        mask.clean(new Vec3(x + p[0]!, p[1]!, p[2]!), 0.2, kw({ hardness: 1 }));
      }
    }
    expect(outer.coverage()).toBeLessThan(all.coverage());
  });

  it('the cells reach the renderer as a pixels texture whose version moves with each stroke', async () => {
    const r = await run(
      { cam: CAMERA, crate: { components: { shape: { kind: 'box', size: [1, 1, 1] }, surface_mask: { layers: [MUD, PAINT], resolution: 16 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'c', prefab: 'crate', at: [0, 0.5, 0] }],
    );
    const first = materialOf(r.frame(), r.id('c')).paint!;
    expect(first.layers).toHaveLength(2);
    expect(first.layers[0]!.roughness).toBeCloseTo(0.95, 6);
    const source = first.texture.source;
    if (source.kind !== 'pixels') throw new Error('expected a pixels texture');
    expect(source.data.length).toBe(source.width * source.height * 4);
    expect(source.width * source.height).toBeGreaterThanOrEqual(first.grid[0] * first.grid[1] * first.grid[2]);
    // Texel channel 0 is the mud: full everywhere at the start; channel 1 (paint) empty.
    expect(source.data[0]).toBe(255);
    expect(source.data[1]).toBe(0);
    r.mask('c').clean(new Vec3(0, 1, 0), 0.4);
    r.step();
    const second = materialOf(r.frame(), r.id('c')).paint!;
    const next = second.texture.source as typeof source;
    expect(second.texture.id).toBe(first.texture.id);
    expect(next.version).toBeGreaterThan(source.version);
    expect([...next.data].filter((v, i) => i % 4 === 0 && v < 128).length).toBeGreaterThan(0);
  });

  it('packs into the material slot, and the shaders read every field they need', () => {
    const inv = new Float32Array(16);
    expect(invertAffine([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 4, 6, 8, 1], inv)).toBe(true);
    expect([...inv].map((v) => v + 0)).toEqual([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, -2, -3, -4, 1]);
    const state = { nx: 10, ny: 5, nz: 4, cell: 0.1, min: [-0.5, -0.25, -0.2] as const };
    const toVolume = worldToVolume(state as never, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])!;
    expect(toVolume[12]).toBeCloseTo(0.5, 6);
    expect(toVolume[0]).toBeCloseTo(1, 6);

    const base: Material3d = {
      id: 'm', baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 0.5, metallicRoughnessTexture: null,
      emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
    };
    const out = new Float32Array(MATERIAL_SLOT * 2);
    packMaterial(base, out, 1);
    expect(out[MATERIAL_SLOT + offsetOf(MATERIAL_FIELDS, 'paintGrid')]).toBe(0);
    packMaterial({
      ...base,
      paint: {
        texture: { id: 'p', source: { kind: 'pixels', width: 30, height: 10, data: new Uint8Array(1200), version: 1 }, colorSpace: 'linear', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' },
        grid: [10, 5, 4], tiles: 3, cell: 0.1, worldToVolume: toVolume,
        layers: [{ color: [1, 1, 1], roughness: 0.9, metallic: 0.1, pattern: 6, breakup: 0.4 }],
      },
    }, out, 1);
    const o = MATERIAL_SLOT + offsetOf(MATERIAL_FIELDS, 'paintGrid');
    expect([...out.subarray(o, o + 8)].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 5, 4, 3, 0.033, 0.1, 0.1, 1]);
    const c = MATERIAL_SLOT + offsetOf(MATERIAL_FIELDS, 'paintColor');
    expect(out[c + 3]).toBe(6);
    const s = MATERIAL_SLOT + offsetOf(MATERIAL_FIELDS, 'paintSurface');
    expect([out[s], out[s + 1], out[s + 2]].map((v) => Math.round(v! * 100) / 100)).toEqual([0.9, 0.1, 0.4]);
    for (const name of ['paintVolume', 'paintGrid', 'paintAtlas', 'paintColor', 'paintSurface']) {
      expect(WGSL_PAINT).toContain(`material.${name}`);
      expect(GLSL_PAINT).toContain(name);
    }
  });
});
