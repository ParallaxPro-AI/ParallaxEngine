import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { JsonObject, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { CELL_SIZE, FOLIAGE_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import { terrain } from '../terrain/index.js';
import { defaultSpecies, foliage, readFoliageSpec } from './index.js';

const TERRAIN: JsonObject = {
  size: [200, 200], max_height: 6, seed: 3, layers: ['grass', 'road', 'rock'], default_layer: 'grass',
  paths: [{ paint: 'road', points: [[-100, 0], [100, 0]], width: 10, feather: 1 }],
  holes: [{ center: [60, 60], radius: 6 }],
};

function scene(blocks: { terrain?: JsonObject; foliage?: JsonObject }, id = 'level'): SceneDoc {
  const plugins: Record<string, JsonObject> = {};
  if (blocks.terrain !== undefined) plugins['terrain'] = blocks.terrain;
  if (blocks.foliage !== undefined) plugins['foliage'] = blocks.foliage;
  return { id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities: [], regions: new Map(), plugins };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const empty: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
function kernelWith(scenes: SceneDoc[], plugins: KernelPlugin[] = [foliage(), terrain()]): Kernel {
  const project: Project = {
    prefabs: new Map(), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(), content: new Map(),
    locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const kernel = new Kernel({ project, game: empty, plugins });
  kernel.start(scenes[0]!.id);
  return kernel;
}

const TREES = { id: 'trees', kind: 'tree', density: 0.02, on: 'grass', avoid: 'road', seed: 4, spacing: 3 };

describe('foliage block', () => {
  it('reads layers with defaults per kind', () => {
    const [tree, grass] = readFoliageSpec(scene({ foliage: { layers: [TREES, { kind: 'grass', on: 'grass' }] } }));
    // No species: one per layer, picked by seed and position (the platform engine's rule).
    expect(tree).toMatchObject({ id: 'trees', kind: 'tree', species: defaultSpecies('tree', 4, 0), max: 5000, minWeight: 0.5, avoidWeight: 0.35, avoid: ['road'], collide: false, scale: [0.8, 1.2] });
    expect(grass).toMatchObject({ id: 'grass_1', kind: 'grass', density: 30, bladeHeight: [0.35, 0.85], drawRadius: 50 });
  });

  it('rejects bad data with PP3230 and a pointer', () => {
    const pointer = (layers: JsonObject[]): string | undefined => {
      try { readFoliageSpec(scene({ foliage: { layers } })); } catch (e) { return (e as ParallaxError).diagnostic.pointer; }
      return undefined;
    };
    expect(pointer([{ kind: 'shrub' }])).toBe('/foliage/layers/0/kind');
    expect(pointer([{ kind: 'tree', species: 'pin' }])).toBe('/foliage/layers/0/species');
    expect(pointer([{ kind: 'model' }])).toBe('/foliage/layers/0/model');
    expect(pointer([{ kind: 'grass', max: 3 }])).toBe('/foliage/layers/0/max');
    expect(pointer([{ kind: 'tree', densty: 3 }])).toBe('/foliage/layers/0/densty');
    expect(pointer([{ kind: 'rock', id: 'a' }, { kind: 'rock', id: 'a' }])).toBe('/foliage/layers/1/id');
    expect(pointer([{ kind: 'rock', area: { center: [0, 0] } }])).toBe('/foliage/layers/0/area');
    // Old spellings name the new key.
    expect(pointer([{ kind: 'rock', layer: 'grass' }])).toBe('/foliage/layers/0/layer');
    expect(pointer([{ kind: 'rock', size: [0.3, 2] }])).toBe('/foliage/layers/0/size');
  });
});

describe('scatter', () => {
  it('is deterministic, follows its layers, and avoids roads, holes and exclusions', () => {
    const block = { layers: [{ ...TREES, exclude: [{ center: [-50, -50], radius: 20 }] }] };
    const a = kernelWith([scene({ terrain: TERRAIN, foliage: block })]);
    const b = kernelWith([scene({ terrain: TERRAIN, foliage: block })], [terrain(), foliage()]);
    const la = a.service(FOLIAGE_SERVICE).layers()[0]!;
    const lb = b.service(FOLIAGE_SERVICE).layers()[0]!;
    expect(la.count).toBeGreaterThan(400);
    expect(la.count).toBeLessThan(900);
    expect([...la.x]).toEqual([...lb.x]);
    expect([...la.yaw]).toEqual([...lb.yaw]);
    const field = a.service(TERRAIN_SERVICE).current()!;
    for (let k = 0; k < la.count; k++) {
      const x = la.x[k]!;
      const z = la.z[k]!;
      expect(Math.abs(z)).toBeGreaterThan(5);
      expect(Math.hypot(x + 50, z + 50)).toBeGreaterThan(20);
      expect(field.holeAt(x, z)).toBe(false);
      expect(la.y[k]).toBeCloseTo(field.heightAt(x, z), 4);
    }
  });

  it('keeps instances spacing apart, and thins evenly to max', () => {
    const k = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [{ ...TREES, avoid: [], density: 0.2, max: 300 }] } })]);
    const l = k.service(FOLIAGE_SERVICE).layers()[0]!;
    // `max` caps the candidates; suitability (the road's edge here) thins a few of them.
    expect(l.count).toBeLessThanOrEqual(300);
    expect(l.count).toBeGreaterThan(250);
    let west = 0;
    for (let i = 0; i < l.count; i++) if (l.x[i]! < 0) west++;
    expect(west / l.count).toBeGreaterThan(0.35);
    expect(west / l.count).toBeLessThan(0.65);
    const dense = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [{ ...TREES, avoid: [], density: 0.2 }] } })]).service(FOLIAGE_SERVICE).layers()[0]!;
    let closest = Infinity;
    for (let i = 0; i < dense.count; i += 3) {
      for (let j = 0; j < dense.count; j++) {
        if (i !== j) closest = Math.min(closest, Math.hypot(dense.x[i]! - dense.x[j]!, dense.z[i]! - dense.z[j]!));
      }
    }
    expect(closest).toBeGreaterThanOrEqual(3 - 1e-3);
  });

  it('groups instances into cells for culling', () => {
    const l = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [TREES] } })]).service(FOLIAGE_SERVICE).layers()[0]!;
    let total = 0;
    for (const cell of l.cells) {
      expect(cell.maxX - cell.minX).toBe(CELL_SIZE);
      for (let i = cell.start; i < cell.start + cell.count; i++) {
        expect(l.x[i]).toBeGreaterThanOrEqual(cell.minX);
        expect(l.x[i]).toBeLessThan(cell.maxX);
        expect(l.y[i]).toBeGreaterThanOrEqual(cell.minY);
      }
      total += cell.count;
    }
    expect(total).toBe(l.count);
  });

  it('without terrain, a layer needs an area and sits on y = 0', () => {
    const area = { center: [0, 0], size: [40, 40] };
    const l = kernelWith([scene({ foliage: { layers: [{ kind: 'rock', density: 0.05, area }] } })], [foliage()]).service(FOLIAGE_SERVICE).layers()[0]!;
    expect(l.count).toBeGreaterThan(40);
    expect([...l.y].every((y) => y === 0)).toBe(true);
    expect(code(() => kernelWith([scene({ foliage: { layers: [{ kind: 'rock' }] } })], [foliage()]).service(FOLIAGE_SERVICE).layers())).toBe('PP3230');
    expect(code(() => kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [{ kind: 'rock', on: 'gras' }] } })]).service(FOLIAGE_SERVICE).layers())).toBe('PP3230');
  });

  it('grass density follows its terrain layer', () => {
    const g = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [{ kind: 'grass', on: 'grass', avoid: 'road' }] } })]).service(FOLIAGE_SERVICE).grass()[0]!;
    expect(g.densityAt(30, 40)).toBe(1);
    expect(g.densityAt(30, 0)).toBe(0);
    expect(g.densityAt(60, 60)).toBe(0);
  });

  it('grass thins over a ragged band at a layer edge, not along a ruled line', () => {
    const g = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [{ kind: 'grass', on: 'grass', avoid: 'road' }] } })]).service(FOLIAGE_SERVICE).grass()[0]!;
    // Along the road (half-width 5, feather 1), find where density first reaches 0.5 at each x.
    const edges: number[] = [];
    let partial = 0;
    for (let x = -40; x <= 40; x += 1.3) {
      for (let z = 4; z <= 9; z += 0.05) {
        const d = g.densityAt(x, z);
        if (d > 0 && d < 1) partial++;
        if (d >= 0.5) {
          edges.push(z);
          break;
        }
      }
    }
    expect(partial).toBeGreaterThan(100);
    // The half-density line wanders along the road instead of keeping one distance.
    expect(Math.max(...edges) - Math.min(...edges)).toBeGreaterThan(0.15);
  });

  it('a layer without a species grows the one the platform engine picked for the same data', () => {
    // Old templates → their ported examples: iron_valley's trees were oak, canyon_carver's birch, dust_bowl's dead.
    expect(defaultSpecies('tree', 122, 1)).toBe('broadleaf');
    expect(defaultSpecies('tree', 112, 2)).toBe('birch');
    expect(defaultSpecies('tree', 133, 2)).toBe('dead');
    expect(defaultSpecies('bush', 123, 2)).toBe('round');
  });

    it('rocks scatter with a skewed spread of sizes', () => {
    const layer = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [{ id: 'rocks', kind: 'rock', density: 0.05, on: 'grass', seed: 9 }] } })])
      .service(FOLIAGE_SERVICE).layers()[0]!;
    const scales = [...layer.scale].sort((a, b) => a - b);
    expect(scales[scales.length - 1]! / scales[0]!).toBeGreaterThan(2.2);
    // Many small, a few large: the median sits below the middle of the range.
    expect(scales[scales.length >> 1]!).toBeLessThan((scales[0]! + scales[scales.length - 1]!) / 2);
  });
});

describe('removal and queries', () => {
  it('near() finds standing instances nearest first; remove() fells one, and snapshots keep it felled', () => {
    const kernel = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [TREES] } })]);
    const service = kernel.service(FOLIAGE_SERVICE);
    const hits = service.near(30, 40, 20);
    expect(hits.length).toBeGreaterThan(2);
    for (let i = 1; i < hits.length; i++) expect(Math.hypot(hits[i]!.x - 30, hits[i]!.z - 40)).toBeGreaterThanOrEqual(Math.hypot(hits[i - 1]!.x - 30, hits[i - 1]!.z - 40));
    const target = hits[0]!;
    const before = service.revision;
    service.remove(target.layer, target.index);
    expect(service.revision).toBeGreaterThan(before);
    expect(service.near(30, 40, 20)[0]!.index).not.toBe(target.index);
    expect(code(() => service.remove(target.layer, target.index))).toBe('PP3231');
    expect(code(() => service.remove('tres', 0))).toBe('PP3231');
    const snapshot = kernel.snapshot();
    expect(snapshot.plugins['foliage']).toEqual({ trees: [target.index] });
    kernel.restore(snapshot);
    expect(service.layers()[0]!.alive[target.index]).toBe(0);
  });

  it('a crater under a tree sets it back on the ground', () => {
    const kernel = kernelWith([scene({ terrain: TERRAIN, foliage: { layers: [TREES] } })]);
    const tree = kernel.service(FOLIAGE_SERVICE).near(30, 40, 30)[0]!;
    kernel.service(TERRAIN_SERVICE).deform({ kind: 'crater', x: tree.x, z: tree.z, radius: 5, depth: 2, rim: 0, layer: null });
    const layer = kernel.service(FOLIAGE_SERVICE).layers()[0]!;
    expect(layer.y[tree.index]).toBeCloseTo(kernel.service(TERRAIN_SERVICE).current()!.heightAt(tree.x, tree.z), 4);
    expect(layer.y[tree.index]).toBeLessThan(tree.y - 1);
  });
});
