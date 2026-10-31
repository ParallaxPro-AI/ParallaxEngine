import { describe, expect, it } from 'vitest';
import { ParallaxError, remoteAssetProblem, Vec3 } from '../../../core/index.js';
import type { JobKey, JobRunner } from '../../../core/index.js';
import type { JsonObject, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { JOBS_SERVICE, TERRAIN_SERVICE, TILE_QUADS } from '../../services/index.js';
import type { TerrainTile } from '../../services/index.js';
import { GROUND_MATERIALS } from './catalog.js';
import type { Field } from './field.js';
import { bakeSplatMap, splatMapWeight } from './splat_map.js';
import type { SplatMap } from './splat_map.js';
import {
  bakeTerrain, bakeTileRelief, buildField, gridOf, morphTargets, paletteOf, pyramidOf, readTerrainSpec, Relief, Splat, terrain, TERRAIN_TILE,
} from './index.js';

function scene(block: JsonObject | undefined, id = 'level'): SceneDoc {
  return {
    id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities: [], regions: new Map(),
    plugins: block === undefined ? {} : { terrain: block },
  };
}

const HILLY: JsonObject = {
  size: [200, 120], base_height: 2, max_height: 30, seed: 9, water_level: 1,
  hills: [{ center: [10, -20], radius: 10, height: 15, feather: 20 }],
  layers: ['grass', 'rock', 'sand', 'road'], default_layer: 'grass',
};

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

function spec(block: JsonObject) {
  return readTerrainSpec(scene(block))!;
}

function field(block: JsonObject = HILLY) {
  return buildField(spec(block), 'level', 1);
}

function same(a: Float32Array, b: Float32Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** FNV-1a over a typed array's bytes. */
function fnv(a: Float32Array): number {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
  return h >>> 0;
}

const bad = (block: JsonObject): ParallaxError => {
  try { readTerrainSpec(scene(block)); } catch (e) { return e as ParallaxError; }
  throw new Error('accepted');
};

describe('terrain block', () => {
  it('reads every part of the format', () => {
    const s = spec({
      size: [100, 80], resolution: 64, base_height: 1,
      noise: [{ kind: 'ridged', amplitude: 12, wavelength: 50, octaves: 4, seed: 3 }, { amplitude: 2, wavelength: 8 }],
      hills: [{ center: [0, 0], radius: 20, height: 9 }, { center: [20, 10], size: [10, 6], rotation: 30, height: -3 }],
      flats: [{ center: [-30, 0], radius: 8, height: 2, mode: 'carve' }],
      holes: [{ points: [[0, 0], [2, 0], [2, 2]] }],
      layers: ['grass', { name: 'road', texture: 'images/road', tile: 3, tint: [1, 0.9, 0.8], roughness: 0.8, detail: { texture: 'images/grain' } },
        { name: 'scree', pattern: 'rock', variation: 0.8, relief: 1.6 }],
      default_layer: 'grass',
      rules: [{ layer: 'road', slope: [20, 30] }],
      paint: [{ layer: 'road', center: [5, 5], radius: 4, noise: 0.5 }],
      paths: [{ paint: 'road', points: [[-40, -30], [0, 0], [40, 30]], width: 6, flatten: true }],
      brush: [{ id: 'tall', center: [10, 10], radius: 5, tags: ['lane'] }],
    });
    expect(s.resolution).toBe(64);
    expect(s.noise.map((n) => [n.kind, n.octaves, n.gain, n.lacunarity, n.seed])).toEqual([['ridged', 4, 0.5, 2, 3], ['fbm', 5, 0.5, 2, 0]]);
    expect(s.hills[1]!.shape).toMatchObject({ kind: 'rect', hx: 5, hz: 3 });
    expect(s.hills.map((h) => h.feather)).toEqual([20, 3]);
    expect(s.flats[0]).toMatchObject({ mode: 'carve', feather: 4 });
    expect(s.layers[1]).toEqual({
      name: 'road', texture: 'images/road', normal: null, tile: 3, tint: [1, 0.9, 0.8], color: null, roughness: 0.8,
      detail: { texture: 'images/grain', tile: 1.5, strength: 0.5 }, pattern: null, variation: 0.5, relief: 1,
    });
    expect(s.layers[2]).toMatchObject({ name: 'scree', texture: null, pattern: 'rock', variation: 0.8, relief: 1.6 });
    expect(s.rules[0]!.slope!.from).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 14);
    expect(s.paths[0]!.flatten).toEqual({ feather: 4, offset: 0 });
    expect(s.brush[0]).toMatchObject({ id: 'tall', height: 1.6, tags: ['lane'] });
    expect(readTerrainSpec(scene(undefined))).toBeUndefined();
  });

  it('a layer named after a ground material draws its hosted texture and normal map unless told otherwise', () => {
    const s = spec({
      size: [10, 10],
      layers: ['grass', { name: 'rock', color: [0.4, 0.4, 0.4] }, { name: 'sand', texture: null }, { name: 'cliff', texture: 'rock_strata', tile: 20 },
        { name: 'bricks', texture: 'images/b', normal: 'images/b_n' }],
    });
    const [grass, rock, sand, cliff, bricks] = s.layers;
    expect(grass).toMatchObject({ texture: GROUND_MATERIALS['leafy_grass']!.albedo, normal: GROUND_MATERIALS['leafy_grass']!.normal, tile: 7 });
    expect(grass!.texture).toMatch(/^https:\/\/r2\.parallaxpro\.ai\/assets\/image_texture\/cf\/a4\/cfa4.*\.jpg$/);
    expect(rock).toMatchObject({ texture: GROUND_MATERIALS['rocky_terrain']!.albedo, color: [0.4, 0.4, 0.4], tile: 12 });
    expect(sand).toMatchObject({ texture: null, normal: null });
    expect(cliff).toMatchObject({ texture: GROUND_MATERIALS['rock_strata']!.albedo, normal: GROUND_MATERIALS['rock_strata']!.normal, tile: 20 });
    expect(bricks).toMatchObject({ texture: 'images/b', normal: 'images/b_n' });
    const byUrl = spec({ size: [3, 3], layers: [{ name: 'x', texture: GROUND_MATERIALS['coast_sand']!.albedo.replace('r2.', '') }] }).layers[0]!;
    expect(byUrl).toMatchObject({ normal: GROUND_MATERIALS['coast_sand']!.normal, tile: 8 });
    expect(byUrl.texture).toBe(GROUND_MATERIALS['coast_sand']!.albedo.replace('r2.', ''));
    for (const m of Object.values(GROUND_MATERIALS)) expect(remoteAssetProblem(m.albedo, 'images') ?? remoteAssetProblem(m.normal, 'images')).toBeUndefined();
    expect(bad({ size: [3, 3], layers: [{ name: 'a', texture: 'rocky_terain' }] }).diagnostic.fix).toContain('"rocky_terrain"');
    expect(bad({ size: [3, 3], layers: [{ name: 'a', texture: null, normal: 'x.png' }] }).diagnostic.pointer).toBe('/terrain/layers/0/normal');
  });

  it('max_height and seed are the short form of one fBm layer', () => {
    expect(spec({ size: [300, 90], max_height: 20, seed: 4, layers: ['a'] }).noise).toEqual([
      { kind: 'fbm', amplitude: 20, wavelength: 100, octaves: 5, gain: 0.5, lacunarity: 2, seed: 4 },
    ]);
    expect(bad({ size: [3, 3], layers: ['a'], max_height: 2, noise: [] }).diagnostic.pointer).toBe('/terrain/max_height');
  });

  it('rejects bad data with PP3200, a pointer and a fix', () => {
    const typo = bad({ size: [1, 1], layers: ['a'], max_heigth: 3 });
    expect(typo.diagnostic).toMatchObject({ code: 'PP3200', pointer: '/terrain/max_heigth', path: 'scenes/level/scene.json' });
    expect(typo.diagnostic.fix).toContain('max_height');
    expect(bad({ layers: ['a'] }).diagnostic.pointer).toBe('/terrain/size');
    expect(bad({ size: [3, 3] }).diagnostic.pointer).toBe('/terrain/layers');
    expect(bad({ size: [3, 3], layers: ['a', 'a'] }).diagnostic.pointer).toBe('/terrain/layers/1');
    const pattern = bad({ size: [3, 3], layers: [{ name: 'a', pattern: 'rocks' }] }).diagnostic;
    expect(pattern).toMatchObject({ pointer: '/terrain/layers/0/pattern' });
    expect(pattern.fix).toContain('"rock"');
    expect(bad({ size: [3, 3], layers: [{ name: 'a', relief: 3 }] }).diagnostic.pointer).toBe('/terrain/layers/0/relief');
    expect(bad({ size: [3, 3], layers: [{ name: 'a', variation: -0.1 }] }).diagnostic.pointer).toBe('/terrain/layers/0/variation');
    expect(bad({ size: [3, 3], layers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }).diagnostic.message).toContain('at most 8');
    expect(bad({ size: [3, 3], layers: ['grass'], default_layer: 'gras' }).diagnostic.fix).toContain('"grass"');
    expect(bad({ size: [3, 3], layers: ['a'], hills: [{ center: [0, 0], radius: -1, height: 1 }] }).diagnostic.pointer).toBe('/terrain/hills/0/radius');
    expect(bad({ size: [3, 3], layers: ['a'], hills: [{ center: [0, 0], radius: 1, size: [1, 1], height: 1 }] }).diagnostic.pointer).toBe('/terrain/hills/0');
    expect(bad({ size: [3, 3], layers: ['a'], seed: 1.5 }).diagnostic.pointer).toBe('/terrain/seed');
    expect(bad({ size: [3, 3], layers: ['a'], paint: [{ layer: 'b', center: [0, 0], radius: 1 }] }).diagnostic.pointer).toBe('/terrain/paint/0/layer');
    expect(bad({ size: [3, 3], layers: ['a'], paths: [{ paint: 'a', points: [[0, 0]], width: 2 }] }).diagnostic.pointer).toBe('/terrain/paths/0/points');
    // The old "layer" key on a path fails naming "paint".
    expect(bad({ size: [3, 3], layers: ['a'], paths: [{ layer: 'a', points: [[0, 0], [1, 1]], width: 2 }] }).diagnostic.fix).toMatch(/"paint"/);
    expect(bad({ size: [3, 3], layers: ['a'], paths: [{ points: [[0, 0], [1, 1]], width: 2 }] }).diagnostic.pointer).toBe('/terrain/paths/0');
    expect(bad({ size: [3, 3], layers: ['a'], rules: [{ layer: 'a', slope: [40, 30] }] }).diagnostic.pointer).toBe('/terrain/rules/0/slope');
    expect(bad({ size: [3, 3], layers: ['a'], rules: [{ layer: 'a' }] }).diagnostic.pointer).toBe('/terrain/rules/0');
    expect(bad({ size: [3, 3], layers: ['a'], noise: [{ kind: 'perlin', amplitude: 1, wavelength: 1 }] }).diagnostic.pointer).toBe('/terrain/noise/0/kind');
    expect(bad({ size: [3, 3], layers: ['a'], brush: [{ id: 'x', center: [0, 0], radius: 1 }, { id: 'x', center: [0, 0], radius: 1 }] }).diagnostic.pointer).toBe('/terrain/brush/1/id');
  });
});

describe('relief', () => {
  it('is deterministic to the bit, and the seed matters', () => {
    const a = field();
    expect(same(a.heights, field().heights)).toBe(true);
    expect(same(a.weights, field().weights)).toBe(true);
    expect(same(a.heights, field({ ...HILLY, seed: 10 }).heights)).toBe(false);
    // A golden checksum: any change to the relief's arithmetic shows up here.
    expect(fnv(a.heights)).toMatchInlineSnapshot(`2793146894`);
  });

  it('samples the relief at vertices, centered on the origin', () => {
    const f = field();
    const relief = new Relief(spec(HILLY));
    expect(f).toMatchObject({ minX: -100, minZ: -60, width: 200, depth: 120 });
    const { columns, rows } = gridOf(spec(HILLY));
    expect([f.columns, f.rows]).toEqual([columns, rows]);
    expect(f.heightAt(-100, -60)).toBeCloseTo(relief.at(-100, -60), 4);
    expect(f.heightAt(100, 60)).toBeCloseTo(relief.at(100, 60), 4);
    expect(f.heightAt(f.minX + 7 * f.cellX, f.minZ + 3 * f.cellZ)).toBe(f.heights[3 * f.columns + 7]);
    expect(f.minHeight).toBeGreaterThanOrEqual(2);
    expect(f.maxHeight).toBeLessThanOrEqual(2 + 30 + 15);
  });

  it('defaults to 1 m cells, at most 512 quads per side; resolution sets it', () => {
    expect(gridOf(spec({ size: [1400, 1150], layers: ['a'] }))).toMatchObject({ columns: 513, rows: 422 });
    expect(gridOf(spec({ size: [40, 10], layers: ['a'] }))).toEqual({ columns: 41, rows: 11, cellX: 1, cellZ: 1 });
    expect(gridOf(spec({ size: [40, 10], resolution: 80, layers: ['a'] }))).toEqual({ columns: 81, rows: 21, cellX: 0.5, cellZ: 0.5 });
  });

  it('noise kinds stay within their amplitude', () => {
    for (const kind of ['fbm', 'ridged', 'billow']) {
      const f = field({ size: [64, 64], noise: [{ kind, amplitude: 10, wavelength: 16, octaves: 6 }], layers: ['a'] });
      expect(f.minHeight).toBeGreaterThanOrEqual(0);
      expect(f.maxHeight).toBeLessThanOrEqual(10);
      expect(f.maxHeight - f.minHeight).toBeGreaterThan(2);
    }
  });

  it('hills ease up over the feather inside their base (a dome by default); flats set, carve and fill', () => {
    const r = new Relief(spec({
      size: [100, 100], layers: ['a'],
      hills: [{ center: [0, 0], radius: 15, height: 10, feather: 10 }, { center: [-30, 30], radius: 10, height: 4 }],
      flats: [{ center: [30, 0], radius: 5, height: 4, feather: 0 }, { center: [-30, 0], radius: 5, height: 4, mode: 'fill' }, { center: [0, 30], radius: 5, height: 4, mode: 'carve' }],
    }));
    expect(r.at(3, 0)).toBe(10);
    expect(r.at(10, 0)).toBeCloseTo(5, 6);
    expect(r.at(15.5, 0)).toBe(0);
    // The default feather is the whole radius: 4 · smootherstep(1 − d / r), the classic dome.
    expect(r.at(-30, 30)).toBe(4);
    expect(r.at(-25, 30)).toBeCloseTo(2, 9);
    expect(r.at(30, 0)).toBe(4);
    expect(r.at(-30, 0)).toBe(4);
    expect(r.at(0, 30)).toBe(0);
  });

  it('a flattened path grades the ground across its width', () => {
    const block: JsonObject = {
      size: [200, 200], noise: [{ amplitude: 30, wavelength: 60 }], layers: ['grass', 'road'],
      paths: [{ paint: 'road', points: [[-90, 0], [0, 0], [90, 0]], width: 8, flatten: { feather: 6, offset: 0.2 } }],
    };
    const graded = new Relief(spec(block));
    const natural = new Relief(spec({ ...block, paths: [] }));
    // Across the road the ground is level; off it, the natural relief returns.
    let crossSlope = 0;
    for (let x = -60; x <= 60; x += 5) crossSlope = Math.max(crossSlope, Math.abs(graded.at(x, 2) - graded.at(x, -2)) / 4);
    expect(crossSlope).toBeLessThan(0.15);
    expect(graded.at(0, 60)).toBe(natural.at(0, 60));
  });
});

describe('splat', () => {
  it('paints, paths and rules each blend over what is there; weights sum to 1', () => {
    const f = field({
      size: [100, 100], layers: ['grass', 'rock', 'road', 'dirt', 'sand', 'snow'], default_layer: 'grass',
      hills: [{ center: [30, 30], radius: 15, height: 30 }],
      rules: [{ layer: 'rock', slope: [25, 35] }, { layer: 'snow', height: [25, 100], feather: 2 }],
      paint: [{ layer: 'sand', center: [-30, -30], radius: 8, feather: 2 }, { layer: 'dirt', center: [-30, -30], radius: 3, strength: 0.5 }],
      paths: [{ paint: 'road', points: [[-50, 10], [50, 10]], width: 4, feather: 1 }],
    });
    expect(f.surfaceAt(-40, 40)).toBe('grass');
    expect(f.surfaceAt(-35, -30)).toBe('sand');
    expect(f.weightAt(-30, -30, 3)).toBeCloseTo(0.5, 5);
    expect(f.weightAt(-30, -30, 4)).toBeCloseTo(0.5, 5);
    expect(f.surfaceAt(-20, 10)).toBe('road');
    expect(f.surfaceAt(-20, 14)).toBe('grass');
    expect(f.surfaceAt(30, 30)).toBe('snow');
    expect(f.surfaceAt(30, 39)).toBe('rock');
    const n = f.layers.length;
    for (let v = 0; v < f.columns * f.rows; v += 7) {
      let sum = 0;
      for (let l = 0; l < n; l++) sum += f.weights[v * n + l]!;
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('the pointwise splat is the grid\'s at vertices, and finer between them', () => {
    const s = spec({ size: [64, 64], layers: ['grass', 'road'], paths: [{ paint: 'road', points: [[-30, 0.3], [30, 0.3]], width: 1.2, feather: 0.2 }] });
    const bake = bakeTerrain(s);
    const splat = new Splat(s);
    const out = new Float32Array(2);
    splat.at(-32 + 10, -32 + 32, 0, 1, out);
    const v = 32 * bake.columns + 10;
    expect(out[1]).toBeCloseTo(bake.weights[v * 2 + 1]!, 6);
    // Half a meter off the centerline: a vertex grid of 1 m can't hold that edge, the point evaluation can.
    splat.at(0, 0.3 + 0.95, 0, 1, out);
    expect(out[1]).toBe(0);
    splat.at(0, 0.3 + 0.5, 0, 1, out);
    expect(out[1]).toBe(1);
  });
});

describe('holes and brush', () => {
  it('authored holes cut quads; queries say so', () => {
    const f = field({ size: [40, 40], layers: ['a'], holes: [{ center: [5.5, 5.5], radius: 2 }] });
    expect(f.holeAt(5.5, 5.5)).toBe(true);
    expect(f.holeAt(0, 0)).toBe(false);
    expect(f.holeAt(500, 0)).toBe(false);
    expect([...f.holes!].reduce((a, b) => a + b, 0)).toBeGreaterThan(8);
    expect(field({ size: [4, 4], layers: ['a'] }).holes).toBeNull();
  });

  it('brush volumes hide what stands in them below their top', () => {
    const f = field({ size: [40, 40], base_height: 1, layers: ['a'], brush: [{ id: 'west', center: [-10, 0], radius: 4, height: 2 }] });
    expect(f.brushAt(-10, 2.5, 1)?.id).toBe('west');
    expect(f.brushAt(-10, 3.5, 1)).toBeNull();
    expect(f.brushAt(10, 1, 0)).toBeNull();
  });
});

describe('deformation', () => {
  const flat: JsonObject = { size: [200, 200], base_height: 5, layers: ['grass', 'scorch'] };

  it('a crater lowers the ground by its depth, raises a rim, paints its layer, and bumps revisions', () => {
    const f = field(flat);
    expect(f.revision).toBe(0);
    f.apply({ kind: 'crater', x: 0.5, z: 0.5, radius: 6, depth: 2, rim: 0.5, layer: 1 });
    expect(f.revision).toBe(1);
    expect(f.heightAt(0.5, 0.5)).toBeCloseTo(3, 1);
    expect(f.heightAt(0.5 + 6.6, 0.5)).toBeGreaterThan(5.3);
    expect(f.heightAt(30, 30)).toBe(5);
    expect(f.chunks.filter((c) => c.revision === 1)).toHaveLength(1);
    expect(f.surfaceAt(0.5, 0.5)).toBe('scorch');
    expect(f.minHeight).toBeLessThan(3.1);
    expect(f.normalAt(3, 0.5).x).toBeLessThan(0);
    expect(f.deformationAt(0.5, 0.5)).toBeCloseTo(-2, 1);
    expect(f.revisionIn(-2, -2, 2, 2)).toBe(1);
    expect(f.revisionIn(80, 80, 90, 90)).toBe(0);
  });

  it('trenches, flattening and cut holes', () => {
    const f = field(flat);
    f.apply({ kind: 'trench', x: -20, z: 0, x2: 20, z2: 0, width: 2, depth: 1.5, feather: 1, layer: null });
    expect(f.heightAt(0, 0)).toBeCloseTo(3.5, 5);
    expect(f.heightAt(0, 5)).toBe(5);
    f.apply({ kind: 'flatten', x: 0, z: 0, radius: 3, height: 5, feather: 0 });
    expect(f.heightAt(0, 0)).toBeCloseTo(5, 5);
    f.apply({ kind: 'hole', x: 10.5, z: 10.5, radius: 1.5 });
    expect(f.holeAt(10.5, 10.5)).toBe(true);
    expect(f.revision).toBe(3);
  });

  const empty: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const project = (scenes: SceneDoc[]): Project => ({
    prefabs: new Map(), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(), content: new Map(),
    locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  });

  it('snapshots hold the edits; restore rebakes and replays them to the same bits', () => {
    const kernel = new Kernel({ project: project([scene(HILLY, 'hills')]), game: empty, plugins: [terrain()] });
    const service = kernel.service(TERRAIN_SERVICE);
    kernel.start('hills');
    service.deform({ kind: 'crater', x: 3, z: 4, radius: 8, depth: 3, rim: 1, layer: 1 });
    const snapshot = kernel.snapshot();
    const before = service.current()!;
    const heights = before.heights.slice();
    expect(snapshot.plugins['terrain']).toEqual([{ kind: 'crater', x: 3, z: 4, radius: 8, depth: 3, rim: 1, layer: 1 }]);
    service.deform({ kind: 'hole', x: 0, z: 0, radius: 3 });
    kernel.restore(snapshot);
    const after = service.current()!;
    expect(after.version).toBeGreaterThan(before.version);
    expect(same(after.heights, heights)).toBe(true);
    expect(after.holeAt(0, 0)).toBe(false);
    expect(service.edits()).toHaveLength(1);
  });

  it('the splat map is baked on first request, finer than the field, and takes deformation paint', async () => {
    const block: JsonObject = {
      size: [40, 20], resolution: 10, layers: ['grass', 'road'],
      paths: [{ paint: 'road', points: [[-20, 0], [20, 0]], width: 1.5, feather: 0.5 }],
    };
    const kernel = new Kernel({ project: project([scene(block, 'strip')]), game: empty, plugins: [terrain()] });
    const service = kernel.service(TERRAIN_SERVICE);
    kernel.start('strip');
    service.deform({ kind: 'crater', x: 10, z: 6, radius: 2, depth: 0.5, rim: 0, layer: 1 });
    expect(service.splatMap()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    const s = service.splatMap()!;
    expect(s.map).toMatchObject({ columns: 41, rows: 21, planes: 1 });
    const map = s.map as SplatMap;
    // The 1.5 m road reads on the 1 m grid (the field's cells are 4 m: it would fall between vertices).
    expect(splatMapWeight(map, 20, 10, 1)).toBeGreaterThan(0.95);
    expect(splatMapWeight(map, 20, 13, 0)).toBeGreaterThan(0.95);
    // The crater made before the bake is painted onto it; one after it bumps the revision.
    expect(splatMapWeight(map, 30, 16, 1)).toBeGreaterThan(0.95);
    const revision = s.revision;
    service.deform({ kind: 'crater', x: -10, z: -6, radius: 2, depth: 0.5, rim: 0, layer: 1 });
    expect(splatMapWeight(map, 10, 4, 1)).toBeGreaterThan(0.95);
    expect(service.splatMap()!.revision).toBeGreaterThan(revision);
    // Deterministic, like the bake.
    const input = (service.current() as Field).splatMapInput();
    expect(bakeSplatMap(input).data).toEqual(bakeSplatMap(input).data);
  });

  it('bad edits are PP3205; no terrain is PP3204', () => {
    const kernel = new Kernel({ project: project([scene(HILLY, 'hills'), scene(undefined, 'menu')]), game: empty, plugins: [terrain()] });
    const service = kernel.service(TERRAIN_SERVICE);
    kernel.start('hills');
    expect(code(() => service.deform({ kind: 'crater', x: 0, z: 0, radius: -1, depth: 1, rim: 0, layer: null }))).toBe('PP3205');
    expect(code(() => service.deform({ kind: 'crater', x: 0, z: 0, radius: 1, depth: 1, rim: 0, layer: 9 }))).toBe('PP3205');
    expect(code(() => service.deform({ kind: 'trench', x: 0, z: 0, x2: Number.NaN, z2: 0, width: 1, depth: 1, feather: 0, layer: null }))).toBe('PP3205');
    kernel.requestScene('menu');
    kernel.step(1 / 60);
    expect(code(() => service.deform({ kind: 'hole', x: 0, z: 0, radius: 1 }))).toBe('PP3204');
  });
});

describe('field queries', () => {
  it('is continuous: no jumps between nearby points anywhere', () => {
    const f = field();
    const steps = 4000;
    let worst = 0;
    for (const z of [-59.3, -12.71, 0, 33.3]) {
      let previous = f.heightAt(-100, z);
      for (let i = 1; i <= steps; i++) {
        const h = f.heightAt(-100 + (200 * i) / steps, z);
        worst = Math.max(worst, Math.abs(h - previous));
        previous = h;
      }
    }
    let steepest = 0;
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.columns - 1; c++) {
        steepest = Math.max(steepest, Math.abs(f.heights[r * f.columns + c + 1]! - f.heights[r * f.columns + c]!) / f.cellX);
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(steepest * (200 / steps) + 1e-5);
  });

  it('normals are the triangles\' and match the height gradient', () => {
    const f = field();
    const n = f.normalAt(12.3, -4.4);
    expect(n.length()).toBeCloseTo(1, 6);
    const e = 1e-4;
    const dx = (f.heightAt(12.3 + e, -4.4) - f.heightAt(12.3 - e, -4.4)) / (2 * e);
    expect(-n.x / n.y).toBeCloseTo(dx, 3);
    expect(f.ground(new Vec3(12.3, 99, -4.4))).toEqual(new Vec3(12.3, f.heightAt(12.3, -4.4), -4.4));
  });

  it('chunks tile every quad once', () => {
    const f = field({ ...HILLY, size: [300, 130] });
    let quads = 0;
    for (const chunk of f.chunks) quads += chunk.columns * chunk.rows;
    expect(quads).toBe((f.columns - 1) * (f.rows - 1));
  });

  it('queries outside the terrain are PP3203; non-finite input PP3202', () => {
    const f = field();
    expect(f.contains(100, 60)).toBe(true);
    expect(f.contains(100.01, 0)).toBe(false);
    expect(code(() => f.heightAt(101, 0))).toBe('PP3203');
    expect(code(() => f.surfaceAt(0, -61))).toBe('PP3203');
    expect(code(() => f.heightAt(Number.NaN, 0))).toBe('PP3202');
  });
});

describe('tiles', () => {
  const empty: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernelWith = (block: JsonObject, extra: KernelPlugin[] = []): Kernel => {
    const project: Project = {
      prefabs: new Map(), scenes: new Map([['t', scene(block, 't')]]), config: new Map(), content: new Map(),
      locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
    };
    const kernel = new Kernel({ project, game: empty, plugins: [terrain(), ...extra] });
    kernel.start('t');
    return kernel;
  };

  it('small maps sample the field at every level; large ones stream finer levels', () => {
    expect(pyramidOf(field({ size: [200, 120], layers: ['a'] }))).toEqual({ leafCell: 1, levels: 4, fieldLevel: 0 });
    const big = pyramidOf(field({ size: [1200, 1200], layers: ['a'] }));
    expect(big.fieldLevel).toBe(1);
    expect(big.leafCell).toBeCloseTo(1200 / 512 / 2, 9);
    expect(TILE_QUADS * big.leafCell * 2 ** (big.levels - 1)).toBeGreaterThanOrEqual(1200);
  });

  it('field tiles match the field at their vertices, with geomorph targets on the parent grid', () => {
    const kernel = kernelWith(HILLY);
    const tiles = kernel.service(TERRAIN_SERVICE).tiles()!;
    const f = kernel.service(TERRAIN_SERVICE).current()!;
    const tile = tiles.get(1, 0, 0)!;
    expect(tile.cell).toBe(2);
    const V = TILE_QUADS + 1;
    expect(tile.heights[3 * V + 5]).toBe(f.heightAt(tile.x + 5 * 2, tile.z + 3 * 2));
    expect(tile.morph[0]).toBe(tile.heights[0]);
    expect(tile.morph[1]).toBeCloseTo((tile.heights[0]! + tile.heights[2]!) / 2, 6);
    expect(tile.morph[V + 1]).toBeCloseTo((tile.heights[0]! + tile.heights[2 * V + 2]!) / 2, 6);
    expect(tile.palette[0]).toBe(0);
    for (let v = 0; v < V * V; v++) expect(tile.weights[v * 4]! + tile.weights[v * 4 + 1]! + tile.weights[v * 4 + 2]! + tile.weights[v * 4 + 3]!).toBeCloseTo(1, 5);
    // Cached until the ground under it changes.
    expect(tiles.get(1, 0, 0)).toBe(tile);
    kernel.service(TERRAIN_SERVICE).deform({ kind: 'crater', x: tile.x + 10, z: tile.z + 10, radius: 4, depth: 2, rim: 0, layer: null });
    const rebuilt = tiles.get(1, 0, 0)!;
    expect(rebuilt).not.toBe(tile);
    expect(rebuilt.heights[5 * V + 5]!).toBeLessThan(tile.heights[5 * V + 5]! - 1.5);
  });

  it('streamed tiles bake the relief at their own resolution (inline without a job runner, budgeted)', () => {
    const block: JsonObject = { size: [1200, 1200], max_height: 40, seed: 2, layers: ['grass', 'road'], paths: [{ paint: 'road', points: [[-500, 0], [500, 0]], width: 6 }] };
    const kernel = kernelWith(block);
    const tiles = kernel.service(TERRAIN_SERVICE).tiles()!;
    const got: (TerrainTile | null)[] = [];
    for (let i = 0; i < 5; i++) got.push(tiles.get(0, 10 + i, 16));
    expect(got.filter((t) => t !== null)).toHaveLength(3);
    const tile = got[0]!;
    const relief = new Relief(spec(block));
    expect(tile.heights[0]).toBeCloseTo(relief.at(tile.x, tile.z), 3);
    expect(tile.palette).toContain(1);
    kernel.step(1 / 60);
    expect(tiles.get(0, 13, 16)).not.toBeNull();
  });

  it('with a job runner, streamed tiles bake in the terrain.tile job', async () => {
    const calls: string[] = [];
    const runner = {
      mode: 'inline', threads: 0,
      run: <I, O>(key: JobKey<I, O>, input: I): Promise<O> => {
        calls.push(key.id);
        return Promise.resolve(structuredClone(bakeTileRelief(structuredClone(input) as never)) as O);
      },
    } as unknown as JobRunner;
    const jobs: KernelPlugin = { id: 'jobs', install: (k) => k.provide(JOBS_SERVICE, runner) };
    const kernel = kernelWith({ size: [1200, 1200], max_height: 40, layers: ['grass'] }, [jobs]);
    const tiles = kernel.service(TERRAIN_SERVICE).tiles()!;
    expect(tiles.get(0, 3, 3)).toBeNull();
    expect(tiles.stats.pending).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([TERRAIN_TILE.id]);
    expect(tiles.get(0, 3, 3)).not.toBeNull();
  });

  it('prebake bakes every terrain scene in the job runner; scenes load from it, bit for bit', async () => {
    const jobs: string[] = [];
    const runner = {
      mode: 'workers', threads: 2,
      all: <I, O>(key: JobKey<I, O>, inputs: readonly I[]): Promise<O[]> => {
        jobs.push(`${key.id}×${inputs.length}`);
        return Promise.resolve(inputs.map((input) => structuredClone(bakeTerrain(structuredClone(input) as never)) as O));
      },
    } as unknown as JobRunner;
    const project: Project = {
      prefabs: new Map(), scenes: new Map([['a', scene(HILLY, 'a')], ['b', scene({ ...HILLY, seed: 2 }, 'b')], ['menu', scene(undefined, 'menu')]]),
      config: new Map(), content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
    };
    const jobsPlugin: KernelPlugin = { id: 'jobs', install: (k) => k.provide(JOBS_SERVICE, runner) };
    const kernel = new Kernel({ project, game: empty, plugins: [terrain(), jobsPlugin] });
    await kernel.service(TERRAIN_SERVICE).prebake();
    expect(jobs).toEqual(['terrain.bake×2']);
    kernel.start('b');
    expect(same(kernel.service(TERRAIN_SERVICE).current()!.heights, field({ ...HILLY, seed: 2 }).heights)).toBe(true);
  });

  it('a tile keeps its four strongest layers and says when it folded others in', () => {
    const V = TILE_QUADS + 1;
    const all = new Float32Array(V * V * 6);
    for (let v = 0; v < V * V; v++) {
      all.set([0.4, 0.2, 0.15, 0.12, 0.1, 0.03], v * 6);
    }
    const p = paletteOf(all, 6);
    expect(p.palette).toEqual([0, 1, 2, 3]);
    expect(p.dropped).toBe(true);
    expect(p.weights[0]! + p.weights[1]! + p.weights[2]! + p.weights[3]!).toBeCloseTo(1, 6);
    expect(morphTargets(new Float32Array(V * V).fill(2))[V + 1]).toBe(2);
  });
});
