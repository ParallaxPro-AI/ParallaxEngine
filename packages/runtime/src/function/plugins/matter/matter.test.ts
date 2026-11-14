import { describe, expect, it } from 'vitest';
import { Color, kw, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, KernelPlugin } from '../../kernel/index.js';
import { MATTER_MESHES } from '../../services/index.js';
import { exchange, settle } from './heat.js';
import { heightOf, LiquidSim, volumeAt } from './liquid.js';
import { buildSolid, centroid, meshVolume, slice } from './mesh.js';
import type { SolidMesh } from './mesh.js';
import { matter } from './index.js';
import { SoftLayer } from './soft.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** Every particle edge of a closed surface is used by exactly two triangles, once each way. */
function closed(m: SolidMesh): boolean {
  const edges = new Map<string, number>();
  for (let t = 0; t < m.tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.vp[m.tris[t + e]!]!;
      const b = m.vp[m.tris[t + ((e + 1) % 3)]!]!;
      if (a === b) continue;
      const key = `${a},${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    const [a, b] = key.split(',');
    if (n !== 1 || edges.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}

const BOX = { shape: 'box', size: [0.12, 0.03, 0.08], round: 0.006, taper: 1, bump: 0, segments: 6, seed: 1 } as const;

describe('solid meshes', () => {
  it('builds closed, outward solids of the right volume for every shape', () => {
    const box = buildSolid({ ...BOX, round: 0 });
    expect(closed(box)).toBe(true);
    expect(meshVolume(box.rest, box.vp, box.tris)).toBeCloseTo(0.12 * 0.03 * 0.08, 7);
    const sphere = buildSolid({ ...BOX, shape: 'sphere', size: [0.1, 0.1, 0.1], segments: 10 });
    expect(closed(sphere)).toBe(true);
    expect(meshVolume(sphere.rest, sphere.vp, sphere.tris) / ((4 / 3) * Math.PI * 0.05 ** 3)).toBeGreaterThan(0.95);
    for (const shape of ['cylinder', 'capsule'] as const) {
      const m = buildSolid({ ...BOX, shape, size: [0.04, 0.2, 0.04], round: 0.005, taper: 0.4 });
      expect(closed(m)).toBe(true);
      expect(meshVolume(m.rest, m.vp, m.tris)).toBeGreaterThan(0);
    }
  });

  it('slices into two closed pieces whose volumes add up, each with a cut face', () => {
    const block = buildSolid(BOX);
    const whole = meshVolume(block.rest, block.vp, block.tris);
    const cut = slice(block, [1, 0, 0], 0.02, 1e-7)!;
    expect(cut).not.toBeNull();
    for (const half of [cut.back, cut.front]) {
      expect(closed(half)).toBe(true);
      expect(half.cap.some((c) => c >= 0)).toBe(true);
    }
    const vb = meshVolume(cut.back.rest, cut.back.vp, cut.back.tris);
    const vf = meshVolume(cut.front.rest, cut.front.vp, cut.front.tris);
    expect(vb + vf).toBeCloseTo(whole, 8);
    expect(vb).toBeGreaterThan(vf);
    // The back piece lies behind the plane, the front ahead of it.
    expect(centroid(cut.back)[0]).toBeLessThan(0.02);
    expect(centroid(cut.front)[0]).toBeGreaterThan(0.02);
  });

  it('cuts again through earlier cut faces (cutting it into cubes), and refuses a sliver or a miss', () => {
    const rod = buildSolid({ ...BOX, shape: 'capsule', size: [0.03, 0.18, 0.03], taper: 0.5 });
    let pieces = [rod];
    for (const y of [-0.04, 0, 0.04]) {
      pieces = pieces.flatMap((p) => {
        const r = slice(p, [0, 1, 0], y, 1e-8);
        return r === null ? [p] : [r.back, r.front];
      });
    }
    expect(pieces.length).toBe(4);
    const lengthwise = slice(pieces[1]!, [1, 0, 0], 0, 1e-8)!;
    expect(closed(lengthwise.back) && closed(lengthwise.front)).toBe(true);
    const total = pieces.reduce((s, p) => s + meshVolume(p.rest, p.vp, p.tris), 0);
    expect(total).toBeCloseTo(meshVolume(rod.rest, rod.vp, rod.tris), 8);
    expect(slice(rod, [0, 1, 0], 0.5, 1e-8)).toBeNull();
    const top = Math.max(...Array.from(rod.rest).filter((_, k) => k % 3 === 1));
    expect(slice(rod, [0, 1, 0], top - 0.0001, 1e-7)).toBeNull();
  });
});

describe('the soft layer', () => {
  it('sags under gravity, keeps its volume, and settles to sleep', () => {
    const gel = buildSolid({ ...BOX, size: [0.08, 0.06, 0.08] });
    const soft = new SoftLayer(gel);
    let moved = 0;
    for (let i = 0; i < 400; i++) soft.step(DT, [0, -9.8, 0], [0, -1, 0], { softness: 0.9, damping: 4 });
    moved = soft.deformation();
    expect(moved).toBeGreaterThan(0.0005);
    expect(moved).toBeLessThan(0.03);
    const n = soft.p.count;
    const ident = Uint32Array.from({ length: n }, (_, i) => i);
    expect(meshVolume(soft.p.x, ident, soft.ptris) / soft.restVolume).toBeGreaterThan(0.97);
    expect(soft.sleeping).toBe(true);
    // A firm solid barely moves.
    const rod = new SoftLayer(buildSolid(BOX));
    for (let i = 0; i < 200; i++) rod.step(DT, [0, -9.8, 0], [0, -1, 0], { softness: 0, damping: 4 });
    expect(rod.deformation()).toBeLessThan(moved / 3);
  });
});

describe('heat', () => {
  it('moves heat between two bodies without overshooting, even over a huge step', () => {
    const q = exchange(200, 20, 100, 300, 50, 1000);
    expect(200 - q / 100).toBeCloseTo(20 + q / 300, 6);
    expect(exchange(20, 20, 1, 1, 10, 1)).toBe(0);
  });

  it('heats the surface before the core, holds a wet surface at 100 °C, and melts with latent heat', () => {
    const node = { surface: 20, core: 20, melted: 0, moisture: 0.1 };
    const body = { mass: 0.25, specificHeat: 3500, surfaceShare: 0.2, internal: 1, meltPoint: null, latentHeat: 0 };
    for (let i = 0; i < 300; i++) settle(node, body, 400 * 0.1, 0, 0.1);
    expect(node.surface).toBeGreaterThan(node.core + 20);
    const wet = { surface: 20, core: 20, melted: 0, moisture: 0.05 };
    for (let i = 0; i < 300; i++) settle(wet, body, 600 * 0.1, 0, 0.1);
    expect(wet.surface).toBeLessThanOrEqual(100.0001);
    expect(wet.moisture).toBeLessThan(0.05);
    const wax = { surface: 20, core: 20, melted: 0, moisture: 0 };
    const softWax = { mass: 0.05, specificHeat: 1600, surfaceShare: 0.3, internal: 0.5, meltPoint: 32, latentHeat: 45000 };
    for (let i = 0; i < 3000; i++) settle(wax, softWax, 15 * 0.1, 0, 0.1);
    expect(wax.melted).toBeGreaterThan(0.5);
    for (let i = 0; i < 8000; i++) settle(wax, softWax, -6 * 0.1, 0, 0.1);
    expect(wax.melted).toBe(0);
  });
});

describe('liquid', () => {
  it('turns a volume into a fill height and back in a flared beaker', () => {
    const beaker = { radius: 0.1, topRadius: 0.13, depth: 0.05, floor: 0.004 };
    for (const v of [0.0001, 0.0008, 0.002]) expect(volumeAt(beaker, heightOf(beaker, v))).toBeCloseTo(v, 9);
  });

  it('stays level when tipped, and spills past the rim', () => {
    const tank = { radius: 0.09, topRadius: 0, depth: 0.12, floor: 0.01 };
    const sim = new LiquidSim();
    const look = { color: [0.5, 0.6, 0.7, 0.6] as const, boil: 0, nearBoil: 0 };
    const upright = { origin: [0, 1, 0] as const, R: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    const g = sim.geometry(upright, tank, 0.06, 0, look)!;
    for (let k = 1; k < g.positions.length / 3 - 1; k++) {
      if (k > 1 + 7 * 36) break;
      expect(g.positions[k * 3 + 1]).toBeCloseTo(1.07, 5);
    }
    expect(sim.spill.rate).toBe(0);
    const a = (60 * Math.PI) / 180;
    const tipped = { origin: [0, 1, 0] as const, R: [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)] };
    sim.geometry(tipped, tank, 0.09, 0, look);
    expect(sim.spill.rate).toBeGreaterThan(0);
  });
});

/** The physics plugins' collider and rigidbody, by their SDK fields (matter reads them by id). */
const COLLIDER: ComponentDef = {
  id: 'collider',
  schema: { shape: t.enum(['box', 'sphere', 'capsule', 'cylinder'], { default: 'box' }), size: t.vec3({ default: Vec3.ONE }), offset: t.vec3({ default: Vec3.ZERO }), radius: t.number({ default: 0.5 }) },
};
const RIGIDBODY: ComponentDef = { id: 'rigidbody', schema: { kind: t.enum(['dynamic', 'kinematic'], { default: 'dynamic' }), mass: t.number({ default: 1 }) } };
const physicsFields: KernelPlugin = { id: 'test_physics', components: [COLLIDER, RIGIDBODY] };

const PREFABS = {
  block: {
    tags: ['material'],
    components: {
      sliceable: { shape: 'box', size: [0.12, 0.03, 0.08], round: 0.005, segments: 6, density: 1050 },
      thermal: { temperature: 5, core: 5 },
      rigidbody: {},
      collider: { shape: 'box', size: [0.12, 0.03, 0.08] },
    },
  },
  tank: { components: { liquid: { radius: 0.1, depth: 0.15, volume: 2 }, thermal: { mass: 1.5, specific_heat: 500, conductivity: 50 } } },
  hot_plate: { components: { heat_source: { kind: 'surface', level: 1, power: 2500, conductance: 12 } } },
  furnace: { components: { heat_source: { kind: 'air', level: 1, temperature: 200, power: 2500, zone: [0.6, 0.5, 0.6], zone_offset: [0, 0, 0] } } },
};

function make(entities: unknown[], timeScale = 1): { kernel: Kernel; id(p: string): EntityId; steps(n: number): void; fields(id: EntityId, c: string): Fields } {
  const prefabs = Object.fromEntries(Object.entries(PREFABS).map(([id, p]) => [`prefabs/${id}.prefab.json`, p]));
  const project = loadProject(files({ ...prefabs, 'scenes/main/scene.json': { entities } }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project, plugins: [physicsFields, matter({ timeScale })], context: {}, fixedStep: DT,
    game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
  });
  kernel.start('main');
  return {
    kernel,
    id: (p) => [...kernel.world.live()].find((r) => r.placedId === p)!.id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
    fields: (id, c) => kernel.world.get(id)!.components.get(c)!,
  };
}

describe('the matter plugin', () => {
  it('slices an entity into a copy of itself: tags, values, fitted collider and mass', () => {
    const w = make([{ id: 'block', prefab: 'block', at: [0, 1, 0] }]);
    w.steps(2);
    const id = w.id('block');
    const s = w.fields(id, 'sliceable') as Fields & { slice(p: Vec3, n: Vec3): unknown; volume: number; cuts: number };
    w.fields(id, 'thermal')['core'] = 42;
    const before = s.volume;
    const piece = s.slice(new Vec3(0.03, 1, 0), new Vec3(1, 0, 0));
    expect(piece).not.toBeNull();
    const twin = w.kernel.handles.unwrap(piece)!;
    const t = w.kernel.world.get(twin)!;
    expect(t.prefab).toBe('block');
    expect(t.tags.has('material')).toBe(true);
    expect(t.components.get('thermal')!['core']).toBe(42);
    const ts = t.components.get('sliceable') as Fields & { volume: number; cuts: number };
    expect(ts.volume + s.volume).toBeCloseTo(before, 9);
    expect(ts.cuts).toBe(1);
    // The pieces sit either side of the cut, their boxes fitted and their mass from volume.
    expect(t.transform.worldPosition().x).toBeGreaterThan(0.03);
    expect(w.kernel.world.get(id)!.transform.worldPosition().x).toBeLessThan(0.03);
    const box = t.components.get('collider')!['size'] as Vec3;
    expect(Math.min(box.x, box.y, box.z)).toBeLessThan(0.031);
    expect(t.components.get('rigidbody')!['mass']).toBeCloseTo(ts.volume * 1050, 6);
    // Both are drawn, with vertex colours.
    const meshes = w.kernel.service(MATTER_MESHES).meshes();
    expect(meshes.length).toBe(2);
    expect(meshes.every((m) => m.parts[0]!.geometry.colors !== null)).toBe(true);
    w.steps(5);
  });

  it('stains the side that faces a direction', () => {
    const w = make([{ id: 'block', prefab: 'block', at: [0, 1, 0] }]);
    w.steps(1);
    const s = w.fields(w.id('block'), 'sliceable') as Fields & { stain(a: number, kw: unknown): void; stain_level(f?: Vec3): number };
    const call = s.stain as unknown as (...a: unknown[]) => void;
    call.call(s, 0.5, kw({ facing: new Vec3(0, -1, 0) }));
    expect(s.stain_level(new Vec3(0, -1, 0))).toBeGreaterThan(0.3);
    expect(s.stain_level(new Vec3(0, 1, 0))).toBe(0);
  });

  it('boils water on a hot plate, then boils it off; a furnace heats its air and what is in it', () => {
    const w = make([
      { id: 'hot_plate', prefab: 'hot_plate', at: [0, 0.9, 0] },
      { id: 'tank', prefab: 'tank', at: [0, 0.92, 0] },
      { id: 'furnace', prefab: 'furnace', at: [3, 0.5, 0] },
      { id: 'block', prefab: 'block', at: [3, 0.5, 0] },
    ], 20);
    const liquid = w.fields(w.id('tank'), 'liquid') as Fields & { boiling: number };
    w.steps(60 * 30);
    expect(liquid['temperature']).toBeCloseTo(100, 3);
    expect(liquid.boiling).toBeGreaterThan(0.2);
    expect(liquid['volume'] as number).toBeLessThan(2);
    const furnace = w.fields(w.id('furnace'), 'heat_source');
    expect(furnace['air_temperature'] as number).toBeGreaterThan(150);
    const block = w.fields(w.id('block'), 'thermal');
    expect(block['temperature'] as number).toBeGreaterThan(block['core'] as number);
    expect(block['core'] as number).toBeGreaterThan(30);
  });

  it('mixes what is poured in by volume', () => {
    const w = make([{ id: 'tank', prefab: 'tank', at: [0, 0, 0] }]);
    w.steps(1);
    const liquid = w.fields(w.id('tank'), 'liquid') as Fields & { add(...a: unknown[]): void };
    liquid['temperature'] = 80;
    liquid.add(2, kw({ temperature: 20, color: new Color(1, 0, 0, 1), kind: 'broth' }));
    expect(liquid['volume']).toBe(4);
    expect(liquid['temperature']).toBeCloseTo(50, 6);
    expect(liquid['kind']).toBe('broth');
  });
});
