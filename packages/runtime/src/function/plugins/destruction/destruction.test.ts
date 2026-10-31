import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, EventDef, Fields, LogicInstance } from '../../kernel/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { DESTRUCTION_EVENTS, destruction, fractureBox } from './index.js';
import type { DestructionNamespace } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function listener(log: Fields[], events: Record<string, EventDef>): BehaviorDef {
  return {
    id: 'watch', params: {}, state: {}, requires: [],
    handlers: Object.entries(events).map(([method, event]) => ({ event, method })),
    create: () => Object.fromEntries(Object.keys(events).map((method) => [method, (_ctx: unknown, e: Fields) => { log.push({ method, ...e }); }])) as LogicInstance,
  };
}

const PREFABS = {
  floor: { components: { collider: { shape: 'box', size: [40, 1, 40], offset: [0, -0.5, 0] } } },
  crate: {
    components: {
      rigidbody: { mass: 5 }, collider: { shape: 'box', size: [1, 1, 1] },
      breakable: { health: 1, impact_threshold: 3000, pieces: 'chunk', fracture: 6 },
    },
    behaviors: { watch: {} },
  },
  chunk: { components: { rigidbody: { mass: 0.5 }, collider: { shape: 'box', size: [1, 1, 1] } } },
  barrel: { components: { collider: { shape: 'cylinder', radius: 0.4, height: 1 }, breakable: { health: 10, pieces: 'staves' } }, behaviors: { watch: {} } },
  staves: { components: {}, children: [{ name: 'a', at: [0.3, 0, 0], components: { rigidbody: {}, collider: { shape: 'box', size: [0.1, 1, 0.1] } } }, { name: 'b', at: [-0.3, 0, 0], components: { rigidbody: {}, collider: { shape: 'box', size: [0.1, 1, 0.1] } } }] },
  rock: { components: { rigidbody: { mass: 50 }, collider: { shape: 'sphere', radius: 0.3 } } },
};

function make(entities: unknown[]): { kernel: Kernel; ns: DestructionNamespace; log: Fields[]; id(p: string): EntityId; steps(n: number): void } {
  const prefabs = Object.fromEntries(Object.entries(PREFABS).map(([id, p]) => [`prefabs/${id}.prefab.json`, p]));
  const project = loadProject(files({ ...prefabs, 'scenes/main/scene.json': { entities } }));
  expect(project.diagnostics).toEqual([]);
  const log: Fields[] = [];
  const plugin = destruction();
  const kernel = new Kernel({
    project, plugins: [physics3d(), plugin], context: {}, fixedStep: DT,
    game: { components: [], resources: [], events: [], behaviors: [listener(log, { damaged: DESTRUCTION_EVENTS.damaged, broken: DESTRUCTION_EVENTS.broken })], systems: [] },
  });
  const ns = plugin.namespace!.create(kernel) as DestructionNamespace;
  kernel.start('main');
  return {
    kernel, ns, log,
    id: (p) => [...kernel.world.live()].find((r) => r.placedId === p)!.id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const chunks = (kernel: Kernel): number => [...kernel.world.live()].filter((r) => r.prefab === 'chunk').length;

describe('destruction', () => {
  it('fractures deterministically into boxes that fill the original', () => {
    const half = new Vec3(0.5, 1, 0.25);
    const pieces = fractureBox(half, 7, 42);
    expect(pieces).toHaveLength(7);
    const volume = pieces.reduce((v, p) => v + p.size.x * p.size.y * p.size.z, 0);
    expect(volume).toBeCloseTo(1, 9);
    expect(fractureBox(half, 7, 42)).toEqual(pieces);
  });

  it('a hard enough impact breaks a crate into scaled pieces that fly apart', () => {
    const g = make([{ prefab: 'floor' }, { prefab: 'crate', id: 'crate', at: [0, 0.5, 0] }, { prefab: 'rock', id: 'rock', at: [0, 5, 0] }]);
    const crate = g.id('crate');
    g.steps(30);
    // Resting on the floor (49 N) is far under the threshold.
    expect(g.log).toEqual([]);
    let broke = -1;
    for (let i = 0; i < 90 && broke < 0; i++) {
      g.steps(1);
      if (g.kernel.world.require(crate).visible === false) broke = i;
    }
    expect(broke).toBeGreaterThan(0);
    const broken = g.log.find((e) => e['method'] === 'broken')!;
    expect(broken['force'] as number).toBeGreaterThan(3000);
    expect(g.log.find((e) => e['method'] === 'damaged')!['amount'] as number).toBeGreaterThan(1);
    const pieces = [...g.kernel.world.live()].filter((r) => r.prefab === 'chunk');
    expect(pieces).toHaveLength(6);
    const volume = pieces.reduce((v, r) => v + r.transform.scale.x * r.transform.scale.y * r.transform.scale.z, 0);
    expect(volume).toBeCloseTo(1, 6);
    g.steps(30);
    expect(chunks(g.kernel)).toBe(6);
  });

  it('damage() and blasts wear health down; a pre-fractured prefab is placed whole, turned as it was', () => {
    const g = make([{ prefab: 'floor' }, { prefab: 'barrel', id: 'barrel', at: [0, 0.5, 0], rotation: [0, 90, 0] }]);
    const barrel = g.kernel.world.require(g.id('barrel'));
    g.steps(1);
    (barrel.components.get('breakable') as Fields & { damage(n: number): void }).damage(4);
    expect(barrel.components.get('breakable')!['health']).toBe(6);
    expect(g.ns.blast(new Vec3(0, 0.5, 2), 4, 4)).toEqual([g.id('barrel')]);
    expect(barrel.components.get('breakable')!['health']).toBeCloseTo(4, 6);
    g.ns.blast(new Vec3(0, 0.5, 0), 4, 10);
    expect(barrel.visible).toBe(false);
    g.steps(1);
    expect(g.kernel.world.isAlive(barrel.id)).toBe(false);
    const staves = [...g.kernel.world.live()].find((r) => r.prefab === 'staves')!;
    const a = g.kernel.world.require(staves.children[0]!);
    // Child "a" at local +x, turned 90° about y: it ends up towards -z.
    expect(a.transform.worldPosition().z).toBeLessThan(-0.2);
    expect(g.log.map((e) => e['method'])).toEqual(['damaged', 'damaged', 'damaged', 'broken']);
  });

  it('breaks the same way after a snapshot restore', () => {
    const run = (): number[] => {
      const g = make([{ prefab: 'floor' }, { prefab: 'crate', id: 'crate', at: [0, 0.5, 0] }, { prefab: 'rock', id: 'rock', at: [0, 5, 0] }]);
      g.steps(10);
      const snap = g.kernel.snapshot();
      g.steps(70);
      const first = [...g.kernel.world.live()].filter((r) => r.prefab === 'chunk').map((r) => r.transform.scale.x);
      g.kernel.restore(snap);
      g.steps(70);
      const second = [...g.kernel.world.live()].filter((r) => r.prefab === 'chunk').map((r) => r.transform.scale.x);
      expect(second.length).toBe(6);
      expect(second.sort()).toEqual(first.sort());
      return second;
    };
    expect(run()).toEqual(run());
  });
});
