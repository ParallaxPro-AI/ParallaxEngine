import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Vec3 } from '../core/index.js';
import { TERRAIN_SERVICE } from '../function/services/index.js';
import type { JsonObject, Project, SceneDoc } from '../resource/index.js';
import { Kernel } from '../function/kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../function/kernel/index.js';
import { FoliageApi, FoliageInstance, foliage } from './foliage.js';
import { kw } from './kwargs.js';
import { terrain, TerrainApi } from './terrain.js';
import { wind, WindApi } from './wind.js';

function scene(id: string, plugins: Record<string, JsonObject>): SceneDoc {
  return { id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities: [], regions: new Map(), plugins };
}

function run(plugins: KernelPlugin[], scenes: SceneDoc[]): { kernel: Kernel; ns: Record<string, unknown> } {
  const project: Project = {
    prefabs: new Map(), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(), content: new Map(),
    locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game, plugins, context: {} });
  kernel.start(scenes[0]!.id);
  const ns: Record<string, unknown> = {};
  for (const p of plugins) if (p.namespace !== undefined) ns[p.namespace.name] = p.namespace.create(kernel);
  return { kernel, ns };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const GROUND: JsonObject = {
  size: [100, 100], base_height: 2, layers: ['grass', 'scorch', 'road'],
  paths: [{ paint: 'road', points: [[-50, 0], [50, 0]], width: 6 }],
  brush: [{ id: 'reeds', center: [20, 20], radius: 5, height: 2 }],
};

describe('ctx.terrain', () => {
  it('answers about layers, holes and brush, and deforms the ground', () => {
    const { ns } = run([terrain()], [scene('t', { terrain: GROUND })]);
    const t = ns['terrain'] as TerrainApi;
    expect(t.contains(new Vec3(10, 0, 10))).toBe(true);
    expect(t.weight_at(new Vec3(0, 0, 0), 'road')).toBe(1);
    expect(code(() => t.weight_at(new Vec3(0, 0, 0), 'rode'))).toBe('PP3206');
    expect(t.brush_at(new Vec3(20, 3, 20))).toBe('reeds');
    expect(t.hidden_by_brush(new Vec3(0, 3, 0), new Vec3(20, 3, 20))).toBe(true);
    expect(t.hidden_by_brush(new Vec3(21, 3, 21), new Vec3(20, 3, 20))).toBe(false);
    t.crater(new Vec3(-20, 0, 20), 5, kw({ depth: 2, layer: 'scorch' }));
    expect(t.height_at(new Vec3(-20, 0, 20))).toBeCloseTo(0, 5);
    expect(t.surface_at(new Vec3(-20, 0, 20))).toBe('scorch');
    t.trench(new Vec3(-40, 0, -20), new Vec3(40, 0, -20), 2, 1);
    expect(t.height_at(new Vec3(0, 0, -20))).toBeCloseTo(1, 5);
    t.flatten(new Vec3(0, 0, -20), 4, kw({ height: 5 }));
    expect(t.height_at(new Vec3(0, 0, -20))).toBeCloseTo(5, 5);
    t.cut_hole(new Vec3(30.5, 0, -30.5), 2);
    expect(t.is_hole(new Vec3(30.5, 0, -30.5))).toBe(true);
    expect(code(() => t.crater(new Vec3(0, 0, 0), -1))).toBe('PP3205');
    expect(code(() => t.crater(new Vec3(0, 0, 0), 2, kw({ layer: 'lava' })))).toBe('PP3206');
  });

  it('tints a layer over game time, and saves the tint by layer name', () => {
    const { kernel, ns } = run([terrain()], [scene('t', { terrain: { ...GROUND, layers: ['grass', { name: 'scorch', tint: [0.5, 0.5, 0.5] }, 'road'] } })]);
    const t = ns['terrain'] as TerrainApi;
    const service = kernel.service(TERRAIN_SERVICE);
    expect(service.tintAt!(1, kernel.time.now)).toEqual([0.5, 0.5, 0.5]);
    expect(service.tintAt!(0, kernel.time.now)).toEqual([1, 1, 1]);
    t.tint('scorch', new Color(1, 1.5, 1), kw({ seconds: 2 }));
    const start = kernel.time.now;
    expect(service.tintAt!(1, start)).toEqual([0.5, 0.5, 0.5]);
    const mid = service.tintAt!(1, start + 1);
    expect(mid[1]).toBeGreaterThan(0.5);
    expect(mid[1]).toBeLessThan(1.5);
    expect(service.tintAt!(1, start + 2)).toEqual([1, 1.5, 1]);
    t.crater(new Vec3(-20, 0, 20), 5, kw({ depth: 2, layer: 'scorch' }));
    const snapshot = kernel.snapshot();
    expect(snapshot.plugins['terrain']).toMatchObject({ tints: { scorch: [1, 1.5, 1] } });
    kernel.restore(snapshot);
    expect(service.tintAt!(1, kernel.time.now)).toEqual([1, 1.5, 1]);
    expect(t.height_at(new Vec3(-20, 0, 20))).toBeCloseTo(0, 5);
    expect(code(() => t.tint('lava', new Color(1, 1, 1)))).toBe('PP3206');
    expect(code(() => t.tint('scorch', 'green'))).toBe('PP3202');
  });
});

describe('ctx.foliage', () => {
  it('finds, counts and removes instances', () => {
    const { ns } = run([terrain(), foliage()], [scene('t', {
      terrain: GROUND, foliage: { layers: [{ id: 'trees', kind: 'tree', density: 0.03, on: 'grass', seed: 1 }] },
    })]);
    const f = ns['foliage'] as FoliageApi;
    const before = f.count('trees');
    expect(before).toBeGreaterThan(20);
    const hits = f.near(new Vec3(0, 0, 30), 20);
    expect(hits[0]).toBeInstanceOf(FoliageInstance);
    expect(hits[0]!.position.y).toBeCloseTo(2, 5);
    f.remove(hits[0]!);
    expect(f.count('trees')).toBe(before - 1);
    expect(f.near(new Vec3(0, 0, 30), 20, kw({ id: 'trees' })).some((h) => h.__eq__(hits[0]))).toBe(false);
    expect(hits[0]!.id).toBe('trees');
    expect(code(() => f.near(new Vec3(0, 0, 30), 20, kw({ layer: 'trees' })))).toBe('PP3030');
    expect(code(() => hits[0]!.layer)).toBe('PP3232');
    expect(code(() => f.count('tres'))).toBe('PP3231');
    expect(code(() => f.remove('trees'))).toBe('PP3232');
  });
});

describe('ctx.wind', () => {
  it('reads and eases the wind', () => {
    const { kernel, ns } = run([wind()], [scene('t', { wind: { direction: 0, speed: 3, gusts: 0 } })]);
    const w = ns['wind'] as WindApi;
    expect(w.speed).toBe(3);
    expect(w.direction.z).toBeCloseTo(1, 12);
    expect(w.at(new Vec3(5, 0, 5)).z).toBeCloseTo(3, 9);
    w.set(kw({ direction: 90, speed: 5, seconds: 1 }));
    for (let i = 0; i < 70; i++) kernel.step(1 / 60);
    expect(w.speed).toBe(5);
    expect(w.direction.x).toBeCloseTo(1, 12);
    w.set(kw({ direction: new Vec3(0, 0, -2) }));
    expect(w.direction.z).toBe(-1);
    expect(code(() => w.set(kw({ speed: 'fast' })))).toBe('PP3237');
  });
});
