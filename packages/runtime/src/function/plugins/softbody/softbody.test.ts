import { describe, expect, it } from 'vitest';
import { kw, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, KernelPlugin } from '../../kernel/index.js';
import { SOFTBODY_MESHES } from '../../services/index.js';
import { wind } from '../wind/index.js';
import { ClothSim, enclosedVolume, extractRotation, softbody, SoftSim, softSurface } from './index.js';
import { rotationMatrix } from './jelly.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** The physics plugins' collider component, by its SDK fields (no Rapier needed: softbody reads it by id). */
const COLLIDER: ComponentDef = {
  id: 'collider',
  schema: {
    shape: t.enum(['box', 'sphere', 'capsule', 'cylinder', 'mesh', 'convex'], { default: 'box' }),
    size: t.vec3({ default: Vec3.ONE }),
    radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }),
    offset: t.vec3({ default: Vec3.ZERO }),
    trigger: t.bool({ default: false }),
  },
};
const colliders: KernelPlugin = { id: 'test_colliders', components: [COLLIDER] };

const PREFABS = {
  flag: { components: { cloth: { size: [2, 1], cols: 10, rows: 6, pin: 'left' } } },
  curtain: { components: { cloth: { size: [1, 1.5], cols: 8, rows: 10 } } },
  ball: { components: { collider: { shape: 'sphere', radius: 0.5 } } },
  floor: { components: { collider: { shape: 'box', size: [20, 1, 20], offset: [0, -0.5, 0] } } },
  jelly: { components: { soft_body: { shape: 'sphere', size: [1, 1, 1], detail: 2, mass: 2 } } },
  head: { components: { soft_body: { shape: 'sphere', size: [0.6, 0.6, 0.6], detail: 2, anchor: 0.03, gravity_scale: 0, shape_stiffness: 0.03, collide: false } } },
  jelly_box: { components: { soft_body: { shape: 'box', size: [1, 0.6, 1], detail: 1 } } },
  both: { components: { cloth: {}, soft_body: {} } },
};

interface World {
  kernel: Kernel;
  plugin: ReturnType<typeof softbody>;
  id(p: string): EntityId;
  steps(n: number): void;
}

function make(entities: unknown[], options: { wind?: unknown } = {}): World {
  const prefabs = Object.fromEntries(Object.entries(PREFABS).map(([id, p]) => [`prefabs/${id}.prefab.json`, p]));
  const scene: Record<string, unknown> = { entities };
  if (options.wind !== undefined) scene['wind'] = options.wind;
  const project = loadProject(files({ ...prefabs, 'scenes/main/scene.json': scene }));
  expect(project.diagnostics).toEqual([]);
  const plugin = softbody();
  const plugins: KernelPlugin[] = [colliders, ...(options.wind !== undefined ? [wind()] : []), plugin];
  const kernel = new Kernel({ project, plugins, context: {}, fixedStep: DT, game: { components: [], resources: [], events: [], behaviors: [], systems: [] } });
  kernel.start('main');
  return {
    kernel, plugin,
    id: (p) => [...kernel.world.live()].find((r) => r.placedId === p)!.id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

function cloth(w: World, placed: string): ClothSim {
  return w.plugin.simOf(w.id(placed)) as ClothSim;
}

function maxSpeed(x: { p: { v: Float64Array; count: number } }): number {
  let max = 0;
  for (let i = 0; i < x.p.count; i++) max = Math.max(max, Math.hypot(x.p.v[i * 3]!, x.p.v[i * 3 + 1]!, x.p.v[i * 3 + 2]!));
  return max;
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

describe('cloth', () => {
  it('hangs from its pinned edge, stretches little, and settles', () => {
    const w = make([{ prefab: 'curtain', id: 'c', at: [0, 3, 0] }]);
    w.steps(240);
    const sim = cloth(w, 'c');
    const x = sim.p.x;
    // Pinned top row stays on the entity's origin line.
    for (let c = 0; c < sim.cols; c++) expect(x[c * 3 + 1]).toBeCloseTo(3, 9);
    // The bottom row hangs about the cloth's height below, stretched by at most 3 %.
    const bottom = (sim.rows - 1) * sim.cols;
    const drop = 3 - x[bottom * 3 + 1]!;
    expect(drop).toBeGreaterThan(1.45);
    expect(drop).toBeLessThan(1.5 * 1.03);
    expect(maxSpeed(sim)).toBeLessThan(0.05);
    expect(Array.from(x).every(Number.isFinite)).toBe(true);
  });

  it('is deterministic, and a restored snapshot continues exactly', () => {
    const a = make([{ prefab: 'flag', id: 'f', at: [0, 2, 0] }, { prefab: 'ball', at: [1, 1.5, 0.2] }]);
    const b = make([{ prefab: 'flag', id: 'f', at: [0, 2, 0] }, { prefab: 'ball', at: [1, 1.5, 0.2] }]);
    a.steps(90);
    b.steps(90);
    expect(Array.from(cloth(a, 'f').p.x)).toEqual(Array.from(cloth(b, 'f').p.x));
    const snap = a.kernel.snapshot();
    a.steps(30);
    const after = Array.from(cloth(a, 'f').p.x);
    a.kernel.restore(snap);
    a.steps(30);
    expect(Array.from(cloth(a, 'f').p.x)).toEqual(after);
  });

  it('pinned particles follow the entity (a cape on a moving bone)', () => {
    const w = make([{ prefab: 'curtain', id: 'c', at: [0, 3, 0] }]);
    w.steps(10);
    w.kernel.world.get(w.id('c'))!.transform.position = new Vec3(2, 3, 0);
    w.steps(1);
    const sim = cloth(w, 'c');
    expect(sim.p.x[0]).toBeCloseTo(2 - 0.5, 9);
    expect(sim.p.x[(sim.cols - 1) * 3]).toBeCloseTo(2 + 0.5, 9);
    // The free part trails behind and catches up.
    const bottom = (sim.rows - 1) * sim.cols * 3;
    expect(sim.p.x[bottom]!).toBeLessThan(1);
    w.steps(480);
    expect(Math.abs(sim.p.x[bottom]! - 1.5)).toBeLessThan(0.1);
  });

  it('drapes over a sphere without passing through it', () => {
    const w = make([{ prefab: 'curtain', id: 'c', at: [0, 3, -0.3] }, { prefab: 'ball', at: [0, 2, 0] }]);
    w.steps(180);
    const sim = cloth(w, 'c');
    for (let i = 0; i < sim.p.count; i++) {
      const d = Math.hypot(sim.p.x[i * 3]!, sim.p.x[i * 3 + 1]! - 2, sim.p.x[i * 3 + 2]!);
      expect(d).toBeGreaterThan(0.5);
    }
  });

  it('streams downwind', () => {
    const calm = make([{ prefab: 'flag', id: 'f', at: [0, 2, 0] }]);
    const windy = make([{ prefab: 'flag', id: 'f', at: [0, 2, 0] }], { wind: { direction: 0, speed: 8, gusts: 0 } });
    calm.steps(120);
    windy.steps(120);
    const meanZ = (sim: ClothSim): number => {
      let z = 0;
      for (let i = 0; i < sim.p.count; i++) z += sim.p.x[i * 3 + 2]!;
      return z / sim.p.count;
    };
    // The wind blows toward +z (bearing 0); the cloth faces +z, so it's pushed back along z.
    expect(Math.abs(meanZ(cloth(calm, 'f')))).toBeLessThan(1e-6);
    expect(meanZ(cloth(windy, 'f'))).toBeGreaterThan(0.2);
  });

  it('push and changing pin data act at once; structural changes rebuild', () => {
    const w = make([{ prefab: 'curtain', id: 'c', at: [0, 3, 0] }]);
    w.steps(60);
    const fields = w.kernel.world.get(w.id('c'))!.components.get('cloth')! as Fields & { push(...a: unknown[]): void; impulse(...a: unknown[]): void };
    expect(() => fields.impulse(new Vec3(0, 2, 0), new Vec3(0, 0, 3), 1)).toThrow(/renamed to Cloth\.push\(\)/);
    fields.push(new Vec3(0, 0, 3), kw({ at: new Vec3(0, 2, 0), radius: 1 }));
    w.steps(1);
    expect(maxSpeed(cloth(w, 'c'))).toBeGreaterThan(0.5);
    fields['pin'] = 'none';
    w.steps(30);
    expect(cloth(w, 'c').p.x[1]!).toBeLessThan(3 - 0.5);
    const before = cloth(w, 'c');
    fields['cols'] = 5;
    w.steps(1);
    expect(cloth(w, 'c')).not.toBe(before);
    expect(cloth(w, 'c').cols).toBe(5);
  });
});

describe('soft bodies', () => {
  it('rest surfaces are closed, outward and centered', () => {
    for (const shape of ['sphere', 'box', 'capsule'] as const) {
      const s = softSurface(shape, new Vec3(1, shape === 'capsule' ? 2 : 1, 1), 1);
      const v = enclosedVolume(s.positions, s.indices);
      expect(v).toBeGreaterThan(0);
      // Every edge is shared by exactly two triangles.
      const edges = new Map<string, number>();
      for (let f = 0; f < s.indices.length; f += 3) {
        for (let e = 0; e < 3; e++) {
          const a = s.indices[f + e]!;
          const b = s.indices[f + ((e + 1) % 3)]!;
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      expect([...edges.values()].every((n) => n === 2)).toBe(true);
    }
    expect(enclosedVolume(softSurface('box', new Vec3(1, 1, 1), 2).positions, softSurface('box', new Vec3(1, 1, 1), 2).indices)).toBeCloseTo(1, 9);
  });

  it('extracts the rotation of a rotated point set', () => {
    // A = R · Σ q qᵀ for q along the axes: the extracted rotation is R.
    const angle = 1.1;
    const R = [Math.cos(angle), 0, -Math.sin(angle), 0, 1, 0, Math.sin(angle), 0, Math.cos(angle)];
    const q = new Float64Array([0, 0, 0, 1]);
    extractRotation(Float64Array.from(R.map((v, i) => v * [2, 1, 3][Math.floor(i / 3)]!)), q, 50);
    expect(Math.abs(q[1]!)).toBeCloseTo(Math.sin(angle / 2), 6);
    expect(Math.abs(q[3]!)).toBeCloseTo(Math.cos(angle / 2), 6);
  });

  it('falls, lands on the floor, keeps its volume, settles, and its entity follows', () => {
    const w = make([{ prefab: 'floor' }, { prefab: 'jelly', id: 'j', at: [0, 2, 0] }]);
    w.steps(300);
    const sim = w.plugin.simOf(w.id('j')) as SoftSim;
    const [min] = sim.bounds();
    expect(min[1]!).toBeGreaterThan(-0.02);
    expect(min[1]!).toBeLessThan(0.05);
    expect(sim.volume() / sim.restVolume).toBeCloseTo(1, 2);
    expect(maxSpeed(sim)).toBeLessThan(0.25);
    const at = w.kernel.world.get(w.id('j'))!.transform.worldPosition();
    expect(at.y).toBeCloseTo(sim.center[1]!, 9);
    expect(at.y).toBeGreaterThan(0.35);
    expect(at.y).toBeLessThan(0.55);
  });

  it('a poke dents it and shape matching brings it back', () => {
    const w = make([{ prefab: 'floor' }, { prefab: 'jelly_box', id: 'j', at: [0, 0.31, 0] }]);
    w.steps(120);
    const sim = w.plugin.simOf(w.id('j')) as SoftSim;
    // How far the particles are from the best-fit rigid placement of the rest shape.
    const deviation = (): number => {
      sim.fit();
      const R = rotationMatrix(sim.q[0]!, sim.q[1]!, sim.q[2]!, sim.q[3]!);
      let m = 0;
      for (let i = 0; i < sim.p.count; i++) {
        for (let a = 0; a < 3; a++) {
          const goal = sim.center[a]! + R[a]! * sim.rest[i * 3]! + R[3 + a]! * sim.rest[i * 3 + 1]! + R[6 + a]! * sim.rest[i * 3 + 2]!;
          m = Math.max(m, Math.abs(sim.p.x[i * 3 + a]! - goal));
        }
      }
      return m;
    };
    expect(deviation()).toBeLessThan(0.01);
    const fields = w.kernel.world.get(w.id('j'))!.components.get('soft_body') as Fields & { push(...a: unknown[]): void; poke(...a: unknown[]): void; volume_ratio: number };
    expect(() => fields.poke(new Vec3(0, 0.6, 0), new Vec3(0, -4, 0), 0.4)).toThrow(/renamed to SoftBody\.push\(\)/);
    fields.push(new Vec3(0, -4, 0), kw({ at: new Vec3(0, 0.6, 0), radius: 0.4 }));
    w.steps(2);
    expect(deviation()).toBeGreaterThan(0.03);
    w.steps(300);
    expect(deviation()).toBeLessThan(0.01);
    expect(fields.volume_ratio).toBeCloseTo(1, 2);
  });

  it('is deterministic across runs and restores', () => {
    const run = (): number[] => {
      const w = make([{ prefab: 'floor' }, { prefab: 'jelly', id: 'j', at: [0.2, 1.5, 0] }]);
      w.steps(100);
      return Array.from((w.plugin.simOf(w.id('j')) as SoftSim).p.x);
    };
    expect(run()).toEqual(run());
    const w = make([{ prefab: 'floor' }, { prefab: 'jelly', id: 'j', at: [0.2, 1.5, 0] }]);
    w.steps(40);
    const snap = w.kernel.snapshot();
    w.steps(40);
    const after = Array.from((w.plugin.simOf(w.id('j')) as SoftSim).p.x);
    w.kernel.restore(snap);
    w.steps(40);
    expect(Array.from((w.plugin.simOf(w.id('j')) as SoftSim).p.x)).toEqual(after);
  });
});

describe('anchored soft bodies', () => {
  /** Largest distance of a particle from where the entity's transform puts its rest point. */
  const offAnchor = (w: World, sim: SoftSim, placed: string): number => {
    const t = w.kernel.world.get(w.id(placed))!.transform;
    const at = t.worldPosition();
    const q = t.worldRotation();
    let m = 0;
    for (let i = 0; i < sim.p.count; i++) {
      const goal = q.rotate(new Vec3(sim.rest[i * 3]!, sim.rest[i * 3 + 1]!, sim.rest[i * 3 + 2]!)).__add__(at);
      m = Math.max(m, Math.hypot(sim.p.x[i * 3]! - goal.x, sim.p.x[i * 3 + 1]! - goal.y, sim.p.x[i * 3 + 2]! - goal.z));
    }
    return m;
  };

  it('stays on its entity instead of the entity following it', () => {
    const w = make([{ prefab: 'head', id: 'h', at: [0, 1.6, 0] }]);
    w.steps(60);
    const sim = w.plugin.simOf(w.id('h')) as SoftSim;
    expect(offAnchor(w, sim, 'h')).toBeLessThan(1e-3);
    expect(w.kernel.world.get(w.id('h'))!.transform.worldPosition().y).toBe(1.6);
  });

  it('trails and wobbles after its entity moves, then settles on it', () => {
    const w = make([{ prefab: 'head', id: 'h', at: [0, 1.6, 0] }]);
    w.steps(10);
    const sim = w.plugin.simOf(w.id('h')) as SoftSim;
    const t = w.kernel.world.get(w.id('h'))!.transform;
    t.position = new Vec3(0.3, 1.6, 0);
    w.steps(1);
    const handle = w.kernel.world.get(w.id('h'))!.components.get('soft_body') as Fields & { center: Vec3 };
    expect(handle.center.x).toBe(sim.center[0]);
    expect(sim.center[0]!).toBeGreaterThan(0.01);
    expect(sim.center[0]!).toBeLessThan(0.29);
    // It overshoots the new spot (a wobble), then comes to rest on it.
    let peak = 0;
    for (let i = 0; i < 40; i++) { w.steps(1); peak = Math.max(peak, sim.center[0]!); }
    expect(peak).toBeGreaterThan(0.3);
    w.steps(240);
    expect(offAnchor(w, sim, 'h')).toBeLessThan(2e-3);
    expect(t.worldPosition().x).toBeCloseTo(0.3, 9);
  });

  it('a push dents one side and it ripples back to its rest shape on the entity', () => {
    const w = make([{ prefab: 'head', id: 'h', at: [0, 1.6, 0] }]);
    w.steps(5);
    const sim = w.plugin.simOf(w.id('h')) as SoftSim;
    const fields = w.kernel.world.get(w.id('h'))!.components.get('soft_body') as Fields & { push(...a: unknown[]): void };
    fields.push(new Vec3(-6, 0, 0), kw({ at: new Vec3(0.3, 1.6, 0), radius: 0.25 }));
    w.steps(3);
    expect(offAnchor(w, sim, 'h')).toBeGreaterThan(0.02);
    expect(sim.volume() / sim.restVolume).toBeCloseTo(1, 1);
    w.steps(300);
    expect(offAnchor(w, sim, 'h')).toBeLessThan(2e-3);
  });

  it('turns with its entity', () => {
    const w = make([{ prefab: 'head', id: 'h', at: [0, 1.6, 0] }]);
    w.steps(5);
    const sim = w.plugin.simOf(w.id('h')) as SoftSim;
    const t = w.kernel.world.get(w.id('h'))!.transform;
    t.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    w.steps(480);
    expect(offAnchor(w, sim, 'h')).toBeLessThan(2e-3);
  });
});

describe('meshes service', () => {
  it('hands renderers one world-space mesh per body, rewritten in place', () => {
    const w = make([{ prefab: 'flag', id: 'f', at: [0, 2, 0] }, { prefab: 'jelly', id: 'j', at: [3, 2, 0] }]);
    const service = w.kernel.service(SOFTBODY_MESHES);
    const first = service.meshes();
    expect(first.map((m) => m.key)).toEqual([...first.map((m) => m.key)].sort());
    expect(first).toHaveLength(2);
    const geometry = first[0]!.parts[0]!.geometry;
    const version = geometry.version!;
    w.steps(3);
    const again = service.meshes();
    expect(again[0]!.parts[0]!.geometry).toBe(geometry);
    expect(geometry.version!).toBeGreaterThan(version);
    expect(again[0]!.parts[0]!.material.doubleSided).toBe(true);
    expect(again.every((m) => m.world.every((v, i) => v === (i % 5 === 0 ? 1 : 0)))).toBe(true);
    expect(geometry.positions.length).toBe(10 * 6 * 3);
  });

  it('an entity with both components is PP3310', () => {
    const w = make([{ prefab: 'both' }]);
    expect(code(() => w.steps(1))).toBe('PP3310');
  });
});
