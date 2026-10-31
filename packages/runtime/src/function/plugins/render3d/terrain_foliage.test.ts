import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TILE_QUADS } from '../../services/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { foliage } from '../foliage/index.js';
import { terrain } from '../terrain/index.js';
import { visuals } from '../visuals/index.js';
import { wind } from '../wind/index.js';
import { FrameGovernor, levelsAt, swayMatrix } from './foliage.js';
import { foliageImpostor, foliageLook, LOOK_VARIANTS, NOMINAL_HEIGHT } from './foliage_meshes.js';
import { barkTexture, encodePng, leafSprayTexture, stoneTexture } from './foliage_textures.js';
import { growSkeleton, meshTree, TREE_SPECS } from './foliage_tree.js';
import { meshRock, ROCK_SPECS } from './foliage_rock.js';
import { bladeRamp, GRASS_REACH, patchGeometry, SEGMENTS, VARIANTS, variantFor } from './grass.js';
import { FOLIAGE_SPECIES } from '../../services/index.js';
import { models } from '../models/index.js';
import { render3d } from './index.js';
import { windVisuals } from './wind_streaks.js';
import { writeGlb } from '../models/testing.js';
import { frustumPlanes, NO_MORPH, selectTiles } from './terrain_cdlod.js';
import type { TileSource } from './terrain_cdlod.js';
import { tileGeometry } from './terrain.js';
import { perspective, viewMatrix, multiply } from '../../../resource/index.js';

const DT = 1 / 60;
const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const TERRAIN = {
  size: [400, 400], max_height: 20, seed: 5, layers: ['grass', 'road', 'rock', 'sand', 'dirt'], default_layer: 'grass',
  rules: [{ layer: 'rock', slope: [25, 35] }],
  paths: [{ paint: 'road', points: [[-200, 0], [0, 20], [200, 0]], width: 8, flatten: true }],
  paint: [{ layer: 'sand', center: [60, 60], radius: 20 }, { layer: 'dirt', center: [-60, -60], radius: 10 }],
  holes: [{ center: [100.5, -100.5], radius: 3 }],
  brush: [{ id: 'tall', center: [-20, 40], radius: 6, height: 1.8 }],
};

const FOLIAGE = {
  layers: [
    { id: 'trees', kind: 'tree', species: 'pine', density: 0.01, on: 'grass', avoid: 'road', seed: 2 },
    { id: 'rocks', kind: 'rock', density: 0.002, seed: 3 },
    { id: 'meadow', kind: 'grass', density: 30, on: 'grass', avoid: ['road', 'sand'], draw_radius: 40 },
  ],
};

async function world(camera: [number, number, number], rotation: [number, number, number]) {
  const project = files({
    'prefabs/cam.prefab.json': { components: { camera: { fov: 60 } } },
    'scenes/main/scene.json': {
      entities: [{ id: 'cam', prefab: 'cam', at: camera, rotation }],
      terrain: TERRAIN, foliage: FOLIAGE, wind: { direction: 90, speed: 6, gusts: 0.5, streaks: true, debris: 10 },
    },
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project, assetFiles: false });
  const kernel = new Kernel({
    project: loaded, game: NO_GAME, plugins: [terrain(), foliage(), wind(), visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}), assetFiles: false }), plugin], context: {}, fixedStep: DT,
  });
  kernel.start('main');
  kernel.step(DT);
  return { kernel, plugin, surface, steps: (n: number) => { for (let i = 0; i < n; i++) kernel.step(DT); } };
}

describe('CDLOD selection', () => {
  const tiles = (missing: (level: number) => boolean = () => false): TileSource<{ level: number; ix: number; iz: number }> => ({
    levels: 5, originX: -256, originZ: -256, leafSize: 32, width: 512, depth: 512, minHeight: 0, maxHeight: 10,
    get: (level, ix, iz) => (missing(level) ? null : { level, ix, iz }),
    bounds: () => ({ minHeight: 0, maxHeight: 10 }),
  });
  const area = (sel: { level: number }[]): number => sel.reduce((n, s) => n + (32 * 2 ** s.level) ** 2, 0);

  it('partitions the ground into rings: finest at the camera, coarser outward, at most one level apart', () => {
    const sel = selectTiles(tiles(), { cameras: [[0, 5, 0]], frusta: [], rangeScale: 2.5, morphFraction: 0.3 });
    expect(area(sel)).toBe(512 * 512);
    const at = (x: number, z: number) => sel.find((s) => {
      const size = 32 * 2 ** s.level;
      const x0 = -256 + s.ix * size;
      const z0 = -256 + s.iz * size;
      return x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
    })!;
    expect(at(1, 1).level).toBe(0);
    expect(at(250, 250).level).toBeGreaterThan(1);
    // Neighbours along a line differ by at most one level.
    let previous = at(0, 0).level;
    for (let x = 0; x < 256; x += 4) {
      const l = at(x, 0).level;
      expect(Math.abs(l - previous)).toBeLessThanOrEqual(1);
      previous = l;
    }
    expect(sel.find((s) => s.level === 4)?.morphEnd ?? NO_MORPH).toBe(NO_MORPH);
    const fine = sel.find((s) => s.level === 0)!;
    expect(fine.morphEnd).toBe(80);
    expect(fine.morphStart).toBeCloseTo(56, 9);
  });

  it('draws a parent whole while any of its children is still streaming', () => {
    const sel = selectTiles(tiles((level) => level === 0), { cameras: [[0, 5, 0]], frusta: [], rangeScale: 2.5, morphFraction: 0.3 });
    expect(sel.some((s) => s.level === 0)).toBe(false);
    expect(area(sel)).toBe(512 * 512);
  });

  it('culls tiles outside every frustum', () => {
    const view = viewMatrix([0, 5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    const vp = multiply(perspective(60, 1, 0.1, 1000), view);
    const sel = selectTiles(tiles(), { cameras: [[0, 5, 0]], frusta: [frustumPlanes(vp)], rangeScale: 2.5, morphFraction: 0.3 });
    expect(area(sel)).toBeLessThan(512 * 512 * 0.75);
    expect(sel.every((s) => -256 + (s.iz + 1) * 32 * 2 ** s.level > -20)).toBe(true);
  });
});

describe('terrain, foliage, grass and wind in a frame', () => {
  it('draws CDLOD tiles, near trees as meshes and far ones as impostors, grass around the camera, and wind', async () => {
    const s = await world([0, 30, -150], [10, 0, 0]);
    s.steps(30);
    const frame = s.surface.last!;
    const t = frame.terrain!;
    expect(t.materials).toHaveLength(5);
    expect(t.tiles.length).toBeGreaterThan(10);
    const levels = new Set(t.tiles.map((x) => x.level));
    expect(levels.size).toBeGreaterThan(1);
    for (const tile of t.tiles) {
      expect(tile.palette.length).toBeLessThanOrEqual(4);
      expect(tile.geometry.colors!.length).toBe((TILE_QUADS + 1) ** 2 * 4);
    }
    const engine = s.plugin.engine;
    expect(engine.foliage.stats.near).toBeGreaterThan(0);
    expect(engine.foliage.stats.far).toBeGreaterThan(0);
    expect(engine.foliage.stats.culledCells).toBeGreaterThan(0);
    const pineLeaves = (m: { geometry: { id: string } }): boolean => /^foliage:tree:pine:\d:\d:leaves$/.test(m.geometry.id);
    expect(frame.meshes.some(pineLeaves)).toBe(true);
    expect(frame.meshes.some((m) => /^foliage:rock:boulder:\d:\d:stone$/.test(m.geometry.id))).toBe(true);
    expect(frame.impostors?.some((b) => b.source.id.startsWith('impostor:foliage:tree:pine') && b.count > 0)).toBe(true);
    expect(frame.meshes.some((m) => m.geometry.id.startsWith('grass:patch:'))).toBe(true);
    expect(engine.grass.stats.patches).toBeGreaterThan(50);
    expect(frame.lines.length).toBeGreaterThan(10);
    // Leaves lean downwind (+x): the instance matrix's y column has a positive x part.
    const leaves = frame.meshes.find(pineLeaves)!;
    let lean = 0;
    for (let i = 0; i < leaves.count; i++) lean += leaves.instances[i * 20 + 4]!;
    expect(lean / leaves.count).toBeGreaterThan(0);
  });

  it('grass stays in its window and off avoided layers; tiles leave holes out', async () => {
    const s = await world([0, 4, 0], [0, 0, 0]);
    const frame = s.surface.last!;
    // The meadow layer's patches (brush volumes draw their own, darker, patches).
    for (const batch of frame.meshes.filter((m) => m.geometry.id.startsWith('grass:patch:') && m.material.id !== 'grass:0.22,0.36,0.14')) {
      for (let i = 0; i < batch.count; i++) {
        const x = batch.instances[i * 20 + 12]!;
        const z = batch.instances[i * 20 + 14]!;
        expect(Math.hypot(x, z)).toBeLessThanOrEqual(40 * GRASS_REACH[frame.quality.level] + 2);
        expect(Math.abs(z - 20 * (1 - (x / 200) ** 2))).toBeGreaterThan(3);
      }
    }
    expect(s.plugin.engine.grass.stats.brushPatches).toBeGreaterThan(20);
  });
});

describe('wind visuals', () => {
  it('streaks drift downwind and never pass within reach of the camera', () => {
    const settings = { dirX: 1, dirZ: 0, speed: 8, gusts: 0, scale: 40, period: 6, streaks: true, debris: 5 };
    const service = { settings: () => settings, sample: () => new Float64Array(2), mean: () => new Float64Array(2), set: () => undefined };
    const view = { position: [0, 2, 0] } as unknown as Parameters<typeof windVisuals>[1];
    for (let t = 0; t < 20; t += 0.37) {
      const { lines, billboards } = windVisuals(service, view, t);
      expect(billboards[0]!.count).toBe(5);
      for (const line of lines) {
        for (let k = 0; k < line.points.length; k += 3) expect(Math.hypot(line.points[k]!, line.points[k + 1]! - 2, line.points[k + 2]!)).toBeGreaterThan(2.5);
        expect(line.points[0]! - line.points[15]!).toBeGreaterThan(1.9);
      }
    }
    expect(windVisuals({ ...service, settings: () => ({ ...settings, speed: 0 }) }, view, 1).lines).toEqual([]);
  });
});

describe('model foliage', () => {
  it('instances a model file\'s meshes at every near instance, with the node transform', async () => {
    const glb = writeGlb({
      nodes: [{ name: 'post', mesh: 0, translation: [0, 1, 0] }],
      meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], material: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
    });
    const project = files({
      'prefabs/cam.prefab.json': { components: { camera: { fov: 60 } } },
      'assets/models/post.glb': '',
      'scenes/main/scene.json': {
        entities: [{ id: 'cam', prefab: 'cam', at: [0, 3, -20] }],
        foliage: { layers: [{ id: 'posts', kind: 'model', model: 'models/post', density: 0.05, area: { center: [0, 0], size: [20, 20] } }] },
      },
    });
    const surface = new RecordingSurface3d();
    const plugin = render3d({ surface, files: project });
    const kernel = new Kernel({
      project: loadProject(project), game: NO_GAME, plugins: [foliage(), visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({ 'assets/models/post.glb': glb }) }), plugin], context: {}, fixedStep: DT,
    });
    kernel.start('main');
    kernel.step(DT);
    await plugin.engine.whenLoaded();
    kernel.step(DT);
    const batch = surface.last!.meshes.find((m) => m.geometry.id.startsWith('assets/models/post.glb'))!;
    expect(batch.count).toBeGreaterThan(5);
    // Ground position + the node's 1 m lift (scale ≥ 0.8).
    expect(batch.instances[13]).toBeGreaterThan(0.79);
  });
});

describe('tile geometry', () => {
  it('leaves hole quads out and keeps the service split', () => {
    const V = TILE_QUADS + 1;
    const holes = new Uint8Array(TILE_QUADS * TILE_QUADS);
    holes[0] = 1;
    const g = tileGeometry({
      level: 0, ix: 0, iz: 0, x: 0, z: 0, cell: 1, heights: new Float32Array(V * V), morph: new Float32Array(V * V).fill(0.5), normals: new Float32Array(V * V * 3),
      palette: [0], weights: new Float32Array(V * V * 4), dropped: false, holes, minHeight: 0, maxHeight: 0, revision: 0,
    }, 't');
    expect(g.indices.length).toBe((TILE_QUADS * TILE_QUADS - 1) * 6);
    expect([...g.indices.slice(0, 6)]).toEqual([1, V + 2, 2, 1, V + 1, V + 2]);
    expect(g.uvs[0]).toBe(0.5);
    expect(g.max[1]).toBe(0.5);
  });
});

describe('foliage drawing parts', () => {
  const LOOKS = [
    ...FOLIAGE_SPECIES.tree.map((x) => `tree:${x}`), ...FOLIAGE_SPECIES.bush.map((x) => `bush:${x}`),
    ...FOLIAGE_SPECIES.plant.map((x) => `plant:${x}`), ...FOLIAGE_SPECIES.rock.map((x) => `rock:${x}`),
  ];

  it('every built-in species has a look, standing on the ground, in every variant and detail', () => {
    for (const look of LOOKS) {
      expect(NOMINAL_HEIGHT[look]).toBeGreaterThan(0);
      for (let v = 0; v < LOOK_VARIANTS; v++) {
        for (const detail of [0, 1] as const) {
          const parts = foliageLook(look, [0.3, 0.5, 0.2], v, detail);
          expect(parts.length).toBeGreaterThan(0);
          for (const p of parts) {
            expect(p.geometry.indices.length % 3).toBe(0);
            expect(p.geometry.positions.length / 3).toBeLessThan(65536);
            expect(p.geometry.min[1]).toBeGreaterThan(-0.4);
            expect(p.geometry.positions.every((x) => Number.isFinite(x))).toBe(true);
          }
        }
      }
    }
  });

  it('trees are grown to their nominal height, deterministically, and differ by variant', () => {
    for (const look of LOOKS.filter((l) => l.startsWith('tree:') || l.startsWith('bush:'))) {
      const parts = foliageLook(look, [0.3, 0.5, 0.2], 1, 0);
      const top = Math.max(...parts.map((p) => p.geometry.max[1]));
      expect(top / NOMINAL_HEIGHT[look]!).toBeGreaterThan(0.85);
      expect(top / NOMINAL_HEIGHT[look]!).toBeLessThan(1.15);
    }
    const spec = TREE_SPECS['tree:broadleaf']!;
    const a = meshTree(spec, growSkeleton(spec, 42), 0, 1);
    const b = meshTree(spec, growSkeleton(spec, 42), 0, 1);
    const c = meshTree(spec, growSkeleton(spec, 43), 0, 1);
    expect(a.leaves.positions).toEqual(b.leaves.positions);
    expect(a.bark.positions).toEqual(b.bark.positions);
    expect(c.bark.positions).not.toEqual(a.bark.positions);
    const pv0 = foliageLook('tree:pine', [0.2, 0.4, 0.2], 0, 0)[0]!.geometry.positions;
    const pv1 = foliageLook('tree:pine', [0.2, 0.4, 0.2], 1, 0)[0]!.geometry.positions;
    expect(pv0).not.toEqual(pv1);
  });

  it('a broadleaf crown carries hundreds of leaf sprays near and about half as many mid, within a vertex budget', () => {
    const spec = TREE_SPECS['tree:broadleaf']!;
    const skel = growSkeleton(spec, 7);
    expect(skel.branches.length).toBeGreaterThan(40);
    expect(skel.leaves.length).toBeGreaterThan(250);
    const near = meshTree(spec, skel, 0, 1);
    const mid = meshTree(spec, skel, 1, 1);
    // A spray is two crossed quads, both faces: 16 vertices.
    expect(near.leaves.vertexCount % 16).toBe(0);
    expect(mid.leaves.vertexCount).toBeLessThan(near.leaves.vertexCount * 0.7);
    expect(mid.leaves.vertexCount).toBeGreaterThan(near.leaves.vertexCount * 0.3);
    expect(mid.bark.vertexCount).toBeLessThan(near.bark.vertexCount);
    expect(near.bark.vertexCount + near.leaves.vertexCount).toBeLessThan(14000);
    // Leaf normals face out of the crown (the rounded-canopy trick): mostly away from its center.
    const p = near.leaves.positions;
    const n = near.leaves.normals;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < p.length; i += 3) {
      cx += p[i]!;
      cy += p[i + 1]!;
      cz += p[i + 2]!;
    }
    const k = p.length / 3;
    let outward = 0;
    for (let i = 0; i < p.length; i += 3) if ((p[i]! - cx / k) * n[i]! + (p[i + 1]! - cy / k) * n[i + 1]! + (p[i + 2]! - cz / k) * n[i + 2]! > 0) outward++;
    expect(outward / k).toBeGreaterThan(0.85);
  });

  it('a pine is a cone: its laterals shorten toward the top', () => {
    const spec = TREE_SPECS['tree:pine']!;
    const skel = growSkeleton(spec, 3);
    const reach = (lo: number, hi: number): number => {
      let r = 0;
      for (const b of skel.branches) for (const f of b.frames) if (f.o[1] >= lo && f.o[1] < hi) r = Math.max(r, Math.hypot(f.o[0], f.o[2]));
      return r;
    };
    const h = skel.height;
    expect(reach(h * 0.2, h * 0.45)).toBeGreaterThan(reach(h * 0.7, h * 0.95) * 1.5);
  });

  it('rocks are closed welded stone with crevice shading, sunk into the ground', () => {
    for (const spec of Object.values(ROCK_SPECS)) {
      const near = meshRock(spec, 5, 0);
      const mid = meshRock(spec, 5, 1);
      expect(near.triangleCount).toBe(5120);
      expect(mid.triangleCount).toBe(320);
      expect(near.vertexCount).toBe(5120 * 3);
      // Fracture creases: corners there take their face's normal, so some triangles shade flat
      // (two corners with one normal), and the rest stay smooth.
      let flat = 0;
      const nn = near.normals;
      for (let i = 0; i < nn.length; i += 9) if (nn[i] === nn[i + 3] && nn[i + 1] === nn[i + 4] && nn[i + 2] === nn[i + 5]) flat++;
      expect(flat).toBeGreaterThan(20);
      expect(flat).toBeLessThan(5120 * 0.9);
      // Moss: some up-facing corners are greener than they are red.
      let mossy = 0;
      for (let i = 0; i < near.colors.length; i += 4) if (near.colors[i + 1]! > near.colors[i]! * 1.15) mossy++;
      expect(mossy).toBeGreaterThan(20);
      expect(Math.min(...near.positions.filter((_, i) => i % 3 === 1))).toBeLessThan(0);
      const shades = near.colors.filter((_, i) => i % 4 === 1);
      expect(Math.max(...shades) - Math.min(...shades)).toBeGreaterThan(0.15);
      expect(meshRock(spec, 5, 0).positions).toEqual(near.positions);
    }
  });

  it('far instances are impostors baked from the mid-detail parts', () => {
    const source = foliageImpostor('tree:birch', [0.4, 0.5, 0.2], 2);
    expect(source.parts.map((p) => p.geometry.id)).toEqual(foliageLook('tree:birch', [0.4, 0.5, 0.2], 2, 1).map((p) => p.geometry.id));
    expect(source.radius).toBeGreaterThan(NOMINAL_HEIGHT['tree:birch']! * 0.45);
    expect(foliageImpostor('tree:birch', [0.4, 0.5, 0.2], 2)).toBe(source);
  });

  it('levels cross-fade with complementary dithers and the far tier fades out at its end', () => {
    const out: [number, number][] = [];
    levelsAt(10, 40, 100, 300, out);
    expect(out).toEqual([[0, 1]]);
    levelsAt(38, 40, 100, 300, out);
    expect(out.map((l) => l[0])).toEqual([0, 1]);
    expect(out[0]![1]).toBeGreaterThan(0);
    expect(out[1]![1]).toBeLessThan(0);
    // Complementary: the fade-in fraction of one is what the other's fade-out leaves.
    expect(out[0]![1]).toBeCloseTo(1 + out[1]![1], 9);
    levelsAt(60, 40, 100, 300, out);
    expect(out).toEqual([[1, 1]]);
    levelsAt(95, 40, 100, 300, out);
    expect(out.map((l) => l[0])).toEqual([1, 2]);
    levelsAt(200, 40, 100, 300, out);
    expect(out).toEqual([[2, 1]]);
    levelsAt(290, 40, 100, 300, out);
    expect(out[0]![0]).toBe(2);
    expect(out[0]![1]).toBeLessThan(1);
    levelsAt(301, 40, 100, 300, out);
    expect(out).toEqual([]);
    // Plants: no far tier; they fade out at the end of the near distance.
    levelsAt(45, 20, Infinity, 50, out);
    expect(out.map((l) => l[0])).toEqual([1]);
    expect(out[0]![1]).toBeLessThan(1);
  });

  it('the sway matrix bends the top and keeps the base', () => {
    const m = new Float32Array(16);
    swayMatrix(10, 2, 3, 90, 2, 0.1, 0, m, 0);
    // A point at local (0, 5, 0): base (10, 2, 3) + y·(kx·s, s, kz·s).
    expect(m[4]! * 5 + m[12]!).toBeCloseTo(11, 5);
    expect(m[5]! * 5 + m[13]!).toBeCloseTo(12, 5);
    expect(m[6]! * 5 + m[14]!).toBeCloseTo(3, 5);
    expect(m[0]).toBeCloseTo(0, 6);
  });

  it('generated textures are valid PNGs', () => {
    const textures = [...(['broad', 'ovate', 'needle', 'frond', 'lance'] as const).map((a) => leafSprayTexture(a)), ...(['rough', 'birch', 'smooth', 'palm'] as const).map((k) => barkTexture(k)), stoneTexture()];
    expect(new Set(textures.map((t) => t.id)).size).toBe(textures.length);
    for (const t of textures) {
      const bytes = (t.source as { bytes: Uint8Array }).bytes;
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]));
    const idat = png.indexOf(0x49, 33);
    const length = (png[idat - 4]! << 24) | (png[idat - 3]! << 16) | (png[idat - 2]! << 8) | png[idat - 1]!;
    expect([...inflateSync(png.subarray(idat + 4, idat + 4 + length))]).toEqual([0, 255, 0, 0, 255, 0, 255, 0, 128]);
  });

  it('grass patches: curved clumped blades near, single triangles far; variants match density; the governor shrinks distances', () => {
    expect(variantFor(2)).toBe(-1);
    expect(VARIANTS[variantFor(120)]).toBe(128);
    const near = patchGeometry(64, 1);
    const far = patchGeometry(32, 1, true);
    // Near: SEGMENTS rows, (SEGMENTS - 1) quads + a tip triangle, both faces.
    expect(near.indices.length).toBe(64 * 2 * ((SEGMENTS - 1) * 2 + 1) * 3);
    expect(near.positions.length / 3).toBe(64 * 2 * (SEGMENTS * 2 + 1));
    expect(far.indices.length).toBe(32 * 2 * 3);
    expect(near.max[1]).toBe(1);
    // Roots are darker than tips (height ambient occlusion).
    const c = near.colors!;
    expect(c[1]!).toBeLessThan(c[SEGMENTS * 2 * 4 + 1]!);
    // The default ramp ends near the platform engine's linear tip (0.42, 0.62, 0.24): light and warm.
    const ramp = bladeRamp([0.33, 0.52, 0.2]);
    expect(ramp.tip[1]!).toBeGreaterThan(0.5);
    expect(ramp.tip[0]! / ramp.tip[1]!).toBeGreaterThan(0.5);
    expect(ramp.root[1]!).toBeLessThan(ramp.tip[1]! * 0.4);
    expect(patchGeometry(64, 1)).toBe(near);
    expect(patchGeometry(64, 2).positions).not.toEqual(near.positions);
    const g = new FrameGovernor();
    let t = 0;
    for (let i = 0; i < 200; i++) g.frame((t += 0.04));
    expect(g.scale).toBeLessThan(0.5);
    for (let i = 0; i < 400; i++) g.frame((t += 0.008));
    expect(g.scale).toBe(1);
  });
});
