/**
 * Layered walkable surfaces, off-mesh links, tiled rebuilds and crowd avoidance: a second
 * floor reached by stairs, a bridge over a road, jump/climb/drop links (authored on a prefab,
 * in the scene, and automatic from an agent's jump_height/drop_height), a NavObstacle moved
 * across a walking agent's path, and two groups of agents crossing through each other.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { JsonObject, Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, GameDefinition, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { MODEL_GEOMETRY_SERVICE, NAV_SERVICE } from '../../services/index.js';
import type { ModelGeometry } from '../../services/index.js';
import { ARRIVED, findPath, LINK_STARTED, nav, NAV_AGENT } from './index.js';
import type { NavPlugin } from './index.js';
import { avoid } from './crowd.js';
import { NavGrid, Obstacles, TILE } from './world.js';

const ORIGIN = { path: 'x', pointer: '' };

const COLLIDER: ComponentDef = {
  id: 'collider',
  schema: {
    shape: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }),
    layer: t.string({ default: 'default' }),
  },
};
const RIGIDBODY: ComponentDef = { id: 'rigidbody', schema: { kind: t.string({ default: 'dynamic' }) } };
const MODEL: ComponentDef = { id: 'model', schema: { model: t.string({ default: '' }), offset: t.vec3({ default: Vec3.ZERO }) } };

const heard: Array<{ event: string; payload: Record<string, unknown> }> = [];
const listener: SystemDef = {
  id: 'listener', scenes: [], handlers: [{ event: ARRIVED, method: 'arrived' }, { event: LINK_STARTED, method: 'link' }],
  create: () => ({
    arrived: (_ctx: unknown, e: Record<string, unknown>) => heard.push({ event: 'arrived', payload: e }),
    link: (_ctx: unknown, e: Record<string, unknown>) => heard.push({ event: 'link', payload: e }),
  }),
};

function prefab(id: string, components: Record<string, JsonObject>): PrefabDoc {
  return { id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags: [], behaviors: [], children: [] };
}

function place(prefabId: string, at: number[], extra: Partial<Placement> = {}): Placement {
  return { prefab: prefabId, at, components: {}, tags: [], params: {}, origin: ORIGIN, ...extra };
}

/** A solid block from y = 0 up to `top`, `sx` × `sz` m. */
const block = (sx: number, top: number, sz: number): Record<string, JsonObject> => ({ collider: { shape: 'box', size: [sx, top, sz], offset: [0, top / 2, 0] } });

const PREFABS = [
  prefab('floor', { collider: { shape: 'box', size: [80, 0.2, 80], offset: [0, -0.1, 0] } }),
  // A 10 × 10 m storey floor slab, 0.2 m thick, its top 3 m up (open space under it).
  prefab('storey', { collider: { shape: 'box', size: [10, 0.2, 10], offset: [0, 2.9, 0] } }),
  prefab('step', block(0.5, 1, 3)),
  prefab('platform', block(6, 2, 6)),
  prefab('wall', { collider: { shape: 'box', size: [1, 3, 30], offset: [0, 1.5, 0] } }),
  prefab('gap_jump', { nav_link: { start: [0, 0, 0], end: [4.4, 0, 0], kind: 'jump' } }),
  prefab('crate', { collider: { shape: 'box', size: [1, 2, 10], offset: [0, 1, 0] }, rigidbody: { kind: 'kinematic' }, nav_obstacle: {} }),
  prefab('bridge', { model: { model: 'assets/models/bridge.glb' }, collider: { shape: 'mesh' } }),
  prefab('walker', { nav_agent: { speed: 4, radius: 0.4, stopping_distance: 0.3 } }),
  prefab('jumper', { nav_agent: { speed: 4, radius: 0.4, stopping_distance: 0.3, jump_height: 2.2, drop_height: 2.5 } }),
  prefab('dropper', { nav_agent: { speed: 4, radius: 0.4, stopping_distance: 0.3, drop_height: 2.5 } }),
  prefab('crowd', { nav_agent: { speed: 3, radius: 0.4, stopping_distance: 0.3 } }),
];

/**
 * A road bridge as one mesh: a ramp from x = -14 (y 0) up to x = -6 (y 4), a deck at y = 4
 * to x = 6, a ramp down to x = 14; 4 m wide (z -2..2). Its deck is a single surface.
 */
const BRIDGE: ModelGeometry = {
  vertices: new Float32Array([
    -14, 0, -2, -6, 4, -2, -6, 4, 2, -14, 0, 2,
    6, 4, -2, 6, 4, 2,
    14, 0, -2, 14, 0, 2,
  ]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2, 1, 2, 5, 1, 5, 4, 4, 5, 7, 4, 7, 6]),
};

function sceneDoc(id: string, entities: Placement[], plugins: Record<string, JsonObject> = {}): SceneDoc {
  return { id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities, regions: new Map(), plugins };
}

function project(scenes: SceneDoc[]): Project {
  return {
    prefabs: new Map(PREFABS.map((p) => [p.id, p])), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(),
    content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
}

function game(): GameDefinition {
  return { components: [COLLIDER, RIGIDBODY, MODEL], resources: [], events: [], behaviors: [], systems: [listener] };
}

interface Started { kernel: Kernel; plugin: NavPlugin; byPrefab(id: string): EntityId[] }

function start(scene: SceneDoc): Started {
  const geometry: KernelPlugin = {
    id: 'geometry', install: (k) => k.provide(MODEL_GEOMETRY_SERVICE, { geometry: (ref) => (ref === 'assets/models/bridge.glb' ? BRIDGE : null) }),
  };
  const plugin = nav({ cellSize: 0.25 });
  const kernel = new Kernel({ project: project([scene]), game: game(), plugins: [geometry, plugin], context: {} });
  kernel.start(scene.id);
  const byPrefab = (id: string): EntityId[] => [...kernel.world.live()].filter((r) => r.prefab === id).map((r) => r.id);
  return { kernel, plugin, byPrefab };
}

function agent(kernel: Kernel, id: EntityId): { move_to(t: unknown): boolean; moving: boolean; traversing: string | null } {
  return kernel.world.require(id).components.get(NAV_AGENT) as never;
}

const pos = (kernel: Kernel, id: EntityId): Vec3 => kernel.world.require(id).transform.worldPosition();

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

/** Step until the agent arrives (or time runs out); the positions it passed through. */
function walk(kernel: Kernel, id: EntityId, seconds: number): Vec3[] {
  heard.length = 0;
  const trail: Vec3[] = [];
  for (let i = 0; i < seconds * 60 && !heard.some((h) => h.event === 'arrived' && h.payload['entity'] === id); i++) {
    kernel.step(1 / 60);
    trail.push(pos(kernel, id));
  }
  return trail;
}

const arrived = (id: EntityId): boolean => heard.some((h) => h.event === 'arrived' && h.payload['entity'] === id);

/** A storey (top at y = 3 over x, z in -5..5) with stairs down from its +x edge: ten 0.3 m steps to x = 10. */
function building(): Placement[] {
  const steps = Array.from({ length: 10 }, (_, n) => place('step', [5.25 + 0.5 * n, 0, 0], { scale: [1, 3 - 0.3 * n, 1] }));
  return [place('floor', [0, 0, 0]), place('storey', [0, 0, 0]), ...steps];
}

describe('layers: several walkable surfaces per column', () => {
  it('second floor: a path up the stairs to a point on the storey, and one to the ground directly under it', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('house', [...building(), place('walker', [0, 0, -9])]));
    const q = plugin.queries();
    const up = q.path(new Vec3(0, 0, -9), new Vec3(0, 3, 0));
    expect(up.length).toBeGreaterThan(2);
    expect(up[up.length - 1]).toEqual(new Vec3(0, 3, 0));
    // Up the stairs, east of the storey.
    expect(Math.max(...up.map((p) => p.x))).toBeGreaterThan(9);
    const under = q.path(new Vec3(0, 0, -9), new Vec3(0, 0, 0));
    expect(under).toEqual([new Vec3(0, 0, -9), new Vec3(0, 0, 0)]);
    // The service's view of the same cell: standable on both levels.
    const service = kernel.service(NAV_SERVICE);
    expect(service.standable(new Vec3(0, 0, 0), 0.4)).toBe(true);
    expect(service.standable(new Vec3(0, 3, 0), 0.4)).toBe(true);
    expect(service.nearest(new Vec3(1, 3.1, 1), 0.4, 1)!.y).toBe(3);

    const [walker] = byPrefab('walker');
    expect(agent(kernel, walker!).move_to(new Vec3(0, 3, 0))).toBe(true);
    // Directly under the goal is not arriving: it is on the floor above.
    const trail = walk(kernel, walker!, 30);
    expect(arrived(walker!)).toBe(true);
    const end = pos(kernel, walker!);
    expect(end.y).toBeCloseTo(3, 5);
    expect(Math.hypot(end.x, end.z)).toBeLessThanOrEqual(0.3 + 1e-9);
    // Climbed gradually (steps of at most 0.4 m per move).
    for (let i = 1; i < trail.length; i++) expect(Math.abs(trail[i]!.y - trail[i - 1]!.y)).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it('a bridge over a road: the road runs under the deck, the crossing goes over it', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('bridge', [
      place('floor', [0, 0, 0]), place('bridge', [0, 0, 0]), place('walker', [0, 0, -12]), place('walker', [-20, 0, 0]),
    ]));
    const q = plugin.queries();
    // Along the road (x = 0, under the deck): level all the way.
    const road = q.path(new Vec3(0, 0, -12), new Vec3(0, 0, 12));
    expect(road).toEqual([new Vec3(0, 0, -12), new Vec3(0, 0, 12)]);
    // Onto the deck above the same road.
    const deck = q.path(new Vec3(-20, 0, 0), new Vec3(0, 4, 0));
    expect(deck[deck.length - 1]!.y).toBeCloseTo(4, 5);
    expect(deck.every((p) => Math.abs(p.z) < 2)).toBe(true);

    const [car, hiker] = byPrefab('walker');
    expect(agent(kernel, car!).move_to(new Vec3(0, 0, 12))).toBe(true);
    const roadTrail = walk(kernel, car!, 10);
    expect(arrived(car!)).toBe(true);
    expect(roadTrail.every((p) => p.y === 0)).toBe(true);

    expect(agent(kernel, hiker!).move_to(new Vec3(20, 0, 0))).toBe(true);
    expect(agent(kernel, hiker!).move_to(new Vec3(0, 4, 0))).toBe(true);
    const over = walk(kernel, hiker!, 15);
    expect(arrived(hiker!)).toBe(true);
    // On the ramp the agent follows its surface: y = (x + 14) / 2 on the way up.
    for (const p of over) if (p.x > -13 && p.x < -7) expect(Math.abs(p.y - (p.x + 14) / 2)).toBeLessThan(0.15);
    expect(pos(kernel, hiker!).y).toBeCloseTo(4, 3);
  });

  it('bakes keep every layer: a worker search reaches the storey like the live one', () => {
    const { kernel } = start(sceneDoc('house', building()));
    const service = kernel.service(NAV_SERVICE);
    const data = structuredClone(service.bake({ minX: -12, minZ: -12, maxX: 14, maxZ: 12 }, 0.4));
    expect(data.layers).toBe(2);
    const live = service.path(new Vec3(0, 0, -9), new Vec3(0, 3, 0), 0.4)!;
    const baked = findPath(data, { start: { x: 0, y: 0, z: -9 }, goal: { x: 0, y: 3, z: 0 }, snap: 1 })!;
    expect(baked.map((w) => [w.x, w.y, w.z])).toEqual(live.map((w) => [w.x, w.y, w.z]));
  });
});

describe('off-mesh links', () => {
  /** Two 2 m platforms with a 4 m gap between them (x -2..2), on open ground. */
  const PLATFORMS = [place('floor', [0, 0, 0]), place('platform', [-5, 0, 0]), place('platform', [5, 0, 0])];

  it('a NavLink on a prefab: the agent jumps the gap (an arc), firing LinkStarted with the link entity', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('gap', [...PLATFORMS, place('gap_jump', [-2.2, 2, 0]), place('walker', [-6, 2, 0])]));
    const q = plugin.queries();
    const [link] = byPrefab('gap_jump');
    const [walker] = byPrefab('walker');
    const path = q.path(new Vec3(-6, 2, 0), new Vec3(6, 2, 0));
    expect(path.length).toBeGreaterThan(2);
    expect(path.every((p) => p.y === 2)).toBe(true);
    const a = agent(kernel, walker!);
    expect(a.move_to(new Vec3(6, 2, 0))).toBe(true);
    let peak = 0;
    let seen: string | null = null;
    heard.length = 0;
    for (let i = 0; i < 60 * 10 && !arrived(walker!); i++) {
      kernel.step(1 / 60);
      const p = pos(kernel, walker!);
      if (Math.abs(p.x) < 0.5) peak = Math.max(peak, p.y);
      seen ??= a.traversing;
    }
    expect(arrived(walker!)).toBe(true);
    expect(seen).toBe('jump');
    expect(peak).toBeGreaterThan(2.3);
    expect(pos(kernel, walker!).y).toBeCloseTo(2, 5);
    const started = heard.find((h) => h.event === 'link')!;
    expect(started.payload['kind']).toBe('jump');
    expect(started.payload['target']).toBe(link);

    // Disabled (a locked door, a raised drawbridge): no way across.
    kernel.world.require(link!).components.get('nav_link')!['enabled'] = false;
    kernel.step(1 / 60);
    expect(q.reachable(new Vec3(6, 2, 0), new Vec3(-6, 2, 0))).toBe(false);
  });

  it('scene links ("navmesh" links): a ladder climbed from the ground; bad entries are PP3240', () => {
    const ladder = { links: [{ start: [-8.5, 0, 0], end: [-7.5, 2, 0], kind: 'climb', bidirectional: false }] };
    const { kernel, plugin, byPrefab } = start(sceneDoc('ladder', [...PLATFORMS, place('walker', [-14, 0, 0])], { navmesh: ladder }));
    const q = plugin.queries();
    expect(q.reachable(new Vec3(-14, 0, 0), new Vec3(-5, 2, 0))).toBe(true);
    // One way only.
    expect(q.reachable(new Vec3(-5, 2, 0), new Vec3(-14, 0, 0))).toBe(false);
    const [walker] = byPrefab('walker');
    expect(agent(kernel, walker!).move_to(new Vec3(-5, 2, 0))).toBe(true);
    walk(kernel, walker!, 15);
    expect(arrived(walker!)).toBe(true);
    expect(heard.find((h) => h.event === 'link')!.payload['kind']).toBe('climb');
    expect(pos(kernel, walker!).y).toBeCloseTo(2, 5);

    for (const bad of [{ links: [{ start: [0, 0, 0], end: [1, 0, 0], kind: 'swim' }] }, { links: [{ start: [0, 0], end: [1, 0, 0] }] }, { links: [{ start: [0, 0, 0], end: [1, 0, 0], cots: 1 }] }]) {
      expect(code(() => start(sceneDoc('bad', [], { navmesh: bad })))).toBe('PP3240');
    }
  });

  it('automatic links: drop_height drops off a ledge, jump_height jumps back up; a walker can do neither', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('ledges', [...PLATFORMS, place('jumper', [-5, 2, 0]), place('dropper', [-5, 2, 2]), place('walker', [-5, 2, -2])]));
    const q = plugin.queries();
    const [jumper] = byPrefab('jumper');
    const [dropper] = byPrefab('dropper');
    const [walker] = byPrefab('walker');
    const top = new Vec3(-5, 2, 0);
    const ground = new Vec3(-14, 0, 0);
    expect(q.reachable(top, ground)).toBe(false);
    expect(q.reachable(top, ground, walker)).toBe(false);
    expect(q.reachable(top, ground, dropper)).toBe(true);
    expect(q.reachable(ground, top, dropper)).toBe(false);
    expect(q.reachable(ground, top, jumper)).toBe(true);
    // Across the 4 m gap from one platform to the other: too far to jump level, but down and up again.
    expect(q.reachable(top, new Vec3(5, 2, 0), jumper)).toBe(true);
    expect(code(() => q.path(top, ground, 'nobody'))).toBe('PP3244');

    expect(agent(kernel, dropper!).move_to(new Vec3(-14, 0, 2))).toBe(true);
    walk(kernel, dropper!, 10);
    expect(arrived(dropper!)).toBe(true);
    expect(heard.find((h) => h.event === 'link')!.payload['kind']).toBe('drop');
    expect(pos(kernel, dropper!).y).toBeCloseTo(0, 5);

    expect(agent(kernel, jumper!).move_to(new Vec3(5, 2, 0))).toBe(true);
    walk(kernel, jumper!, 20);
    expect(arrived(jumper!)).toBe(true);
    expect(heard.filter((h) => h.event === 'link').map((h) => h.payload['kind'])).toEqual(['drop', 'jump']);
    expect(pos(kernel, jumper!).y).toBeCloseTo(2, 5);
  });
});

describe('tiled rebuilds and dynamic obstacles', () => {
  it('a change rebuilds only the tiles near it; far tiles keep their cached columns', () => {
    const { kernel } = start(sceneDoc('open', [place('floor', [0, 0, 0])]));
    const obstacles = new Obstacles();
    for (const record of kernel.world.live()) obstacles.update(record);
    const grid = new NavGrid(0.25, obstacles, () => null);
    // Warm 40 × 40 m (10 × 10 tiles of 4 m).
    for (let i = -80; i < 80; i += 4) for (let k = -80; k < 80; k += 4) grid.standable(i, k, 0, 0.4);
    const far = grid.columns(-70, -70);
    const before = grid.rebuilt;
    const generation = grid.generation;
    const wall = kernel.spawn('wall', { at: [10, 0, 10], rotation: [0, 90, 0] });
    obstacles.update(kernel.world.require(wall.id));
    expect(grid.columns(-70, -70)).toBe(far);
    const span = TILE * 0.25;
    // A 30 × 1 m wall (plus reach) touches at most ceil(32 / 4) × 2 tiles... of the 100 warmed.
    expect(grid.rebuilt - before).toBeGreaterThan(0);
    expect(grid.rebuilt - before).toBeLessThanOrEqual(Math.ceil(32 / span + 1) * 2);
    expect(grid.dirtySince(generation, { minX: 9, maxX: 11, minZ: 9, maxZ: 11 })).toBe(true);
    expect(grid.dirtySince(generation, { minX: -20, maxX: -18, minZ: -20, maxZ: -18 })).toBe(false);
  });

  it('a NavObstacle (a kinematic crate) moved across a walking agent\'s path: the agent re-plans around it', () => {
    const { kernel, byPrefab } = start(sceneDoc('yard', [place('floor', [0, 0, 0]), place('crate', [0, 0, 30]), place('walker', [-8, 0, 0])]));
    const [crate] = byPrefab('crate');
    const [walker] = byPrefab('walker');
    const service = kernel.service(NAV_SERVICE);
    // Beside the crate, closer than the agent's radius.
    expect(service.standable(new Vec3(0.7, 0, 30), 0.4)).toBe(false);
    expect(agent(kernel, walker!).move_to(new Vec3(8, 0, 0))).toBe(true);
    for (let i = 0; i < 20; i++) kernel.step(1 / 60);
    kernel.world.require(crate!).transform.position = new Vec3(2, 0, 0);
    const trail = walk(kernel, walker!, 15);
    expect(arrived(walker!)).toBe(true);
    expect(Math.max(...trail.map((p) => Math.abs(p.z)))).toBeGreaterThan(5);
    for (const p of trail) if (Math.abs(p.z) < 5 + 0.39) expect(Math.abs(p.x - 2)).toBeGreaterThan(0.5 + 0.39 - 0.05);
    // Switched off (an open door), agents path straight through it.
    kernel.world.require(crate!).components.get('nav_obstacle')!['enabled'] = false;
    expect(service.path(new Vec3(-8, 0, 0), new Vec3(8, 0, 0), 0.4)).toHaveLength(2);
  });
});

describe('crowd avoidance (ORCA)', () => {
  it('two groups crossing at right angles keep clear of each other and all arrive', () => {
    const west = [-1.5, -0.5, 0.5, 1.5].map((z) => place('crowd', [-10, 0, z]));
    const south = [-1.5, -0.5, 0.5, 1.5].map((x) => place('crowd', [x, 0, -10]));
    const { kernel, byPrefab } = start(sceneDoc('square', [place('floor', [0, 0, 0]), ...west, ...south]));
    const ids = byPrefab('crowd');
    ids.forEach((id, n) => {
      const p = pos(kernel, id);
      agent(kernel, id).move_to(n < 4 ? new Vec3(10, 0, p.z) : new Vec3(p.x, 0, 10));
    });
    heard.length = 0;
    let closest = Infinity;
    for (let i = 0; i < 60 * 20 && ids.some((id) => !arrived(id)); i++) {
      kernel.step(1 / 60);
      const at = ids.map((id) => pos(kernel, id));
      for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) closest = Math.min(closest, Math.hypot(at[a]!.x - at[b]!.x, at[a]!.z - at[b]!.z));
    }
    expect(ids.every(arrived)).toBe(true);
    // Radii 0.4 + 0.4: never overlapping by more than the few centimeters a fixed step allows.
    expect(closest).toBeGreaterThan(0.75);
  });

  it('reciprocal: two agents head-on each take half the dodge; an idle one is avoided in full', () => {
    const pair = avoid([
      { id: 1, x: -2, z: 0, y: 0, vx: 2, vz: 0, radius: 0.5, avoids: true, prefVx: 2, prefVz: 0, maxSpeed: 2 },
      { id: 2, x: 2, z: 0, y: 0, vx: -2, vz: 0, radius: 0.5, avoids: true, prefVx: -2, prefVz: 0, maxSpeed: 2 },
    ], 1 / 60, 1.8);
    const a = pair.get(1)!;
    const b = pair.get(2)!;
    // Mirror images: equal and opposite sideways dodges.
    expect(a.z).toBeCloseTo(-b.z, 9);
    expect(Math.abs(a.z)).toBeGreaterThan(0.05);
    const idle = avoid([
      { id: 1, x: -2, z: 0, y: 0, vx: 2, vz: 0, radius: 0.5, avoids: true, prefVx: 2, prefVz: 0, maxSpeed: 2 },
      { id: 2, x: 1, z: 0, y: 0, vx: 0, vz: 0, radius: 0.5, avoids: false, prefVx: 0, prefVz: 0, maxSpeed: 0 },
    ], 1 / 60, 1.8).get(1)!;
    // It alone turns: more than half of a head-on pair's combined dodge at the same closing distance.
    expect(Math.abs(idle.z)).toBeGreaterThan(Math.abs(a.z));
    // On another layer (a bridge above): not a neighbour.
    const above = avoid([
      { id: 1, x: -2, z: 0, y: 0, vx: 1, vz: 0, radius: 0.5, avoids: true, prefVx: 1, prefVz: 0, maxSpeed: 1 },
      { id: 2, x: 2, z: 0, y: 4, vx: -1, vz: 0, radius: 0.5, avoids: true, prefVx: -1, prefVz: 0, maxSpeed: 1 },
    ], 1 / 60, 1.8).get(1)!;
    expect(above).toEqual({ x: 1, z: 0 });
  });
});

