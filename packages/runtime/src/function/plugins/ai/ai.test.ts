/**
 * The ai plugin in a real kernel with nav (static occlusion, movement): perception with
 * walls and hearing, squad cover, RTS formation moves, flocks, fog of war, the director
 * events, and snapshot/restore in the middle of a behavior.
 */

import { describe, expect, it } from 'vitest';
import { kw, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { JsonObject, Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, EventDef, GameDefinition, SystemDef } from '../../kernel/index.js';
import { AI_SERVICE, FOG_OF_WAR_SERVICE, PERCEPTION_SERVICE } from '../../services/index.js';
import { nav } from '../nav/index.js';
import { terrain } from '../terrain/index.js';
import { weather } from '../weather/index.js';
import { ai, AI_EVENTS, BRAIN, FLOCK, ORDERS, PERCEPTION, formationOffsets, placeSlots } from './index.js';
import type { AiOptions, AiPlugin, TaskAgent } from './index.js';

const ORIGIN = { path: 'x', pointer: '' };

/** Components nav and ai read by id, with their SDK fields (their plugins aren't loaded here). */
const STUBS: ComponentDef[] = [
  {
    id: 'collider', schema: {
      shape: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), radius: t.number({ default: 0.5 }),
      height: t.number({ default: 1 }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }),
      layer: t.string({ default: 'default' }),
    },
  },
  { id: 'side', schema: { side: { type: { kind: 'tag' } } } },
  { id: 'awareness', schema: { level: t.number({ default: 0 }) } },
];

const events: { type: string; payload: Record<string, unknown> }[] = [];
const recorders: SystemDef[] = Object.values(AI_EVENTS).map((e: EventDef) => ({
  id: `rec_${e.id}`, scenes: [], handlers: [{ event: e, method: 'on' }],
  create: () => ({ on: (_ctx: unknown, payload: Record<string, unknown>) => { events.push({ type: e.id, payload: { ...payload } }); } }),
}));

function prefab(id: string, components: Record<string, JsonObject>, tags: string[] = []): PrefabDoc {
  return { id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags, behaviors: [], children: [] };
}

function place(prefabId: string, at: number[], components: Record<string, JsonObject> = {}): Placement {
  return { prefab: prefabId, at, components, tags: [], params: {}, origin: ORIGIN };
}

const PREFABS = [
  prefab('wall', { collider: { shape: 'box', size: [1, 3, 12], offset: [0, 1.5, 0] } }),
  prefab('crate', { collider: { shape: 'box', size: [1.2, 1.2, 1.2], offset: [0, 0.6, 0] } }),
  prefab('guard', { side: { side: 'red' }, perception: { fov: 180, memory: 1, notice_time: 1, calm_time: 2 }, brain: { tree: 'idle' }, awareness: {} }),
  prefab('thief', { side: { side: 'blue' }, detectable: {} }),
  prefab('soldier', { side: { side: 'red' }, squad_member: { squad: 'alpha' }, brain: { tree: 'idle' }, nav_agent: { speed: 4 } }),
  prefab('cover', { cover_point: { height: 1.2 } }),
  prefab('unit', { side: { side: 'blue' }, orders: { stance: 'passive' }, nav_agent: { speed: 5, radius: 0.4, stopping_distance: 0.15, avoid_others: false } }),
  prefab('fish', { flock: { group: 'school', max_speed: 4, min_speed: 2, home: [0, 5, 0], home_radius: 12, wander: 0.2 } }),
  prefab('scout', { side: { side: 'blue' }, vision: { range: 10 } }),
  prefab('patroller', { side: { side: 'red' }, brain: { tree: 'patrol' }, nav_agent: { speed: 3, stopping_distance: 0.3 }, perception: {} }),
];

function sceneDoc(id: string, entities: Placement[]): SceneDoc {
  return { id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities, regions: new Map(), plugins: {} };
}

function project(scenes: SceneDoc[], trees: Record<string, JsonObject> = {}): Project {
  const content = new Map([['behavior_tree', new Map(Object.entries(trees).map(([id, values]) => [id, {
    kind: 'behavior_tree', id, feature: undefined, path: `content/behavior_tree/${id}.json`, values,
  }]))]]);
  return {
    prefabs: new Map(PREFABS.map((p) => [p.id, p])), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(),
    content, locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
}

const IDLE = { root: { type: 'wait', seconds: 1000 } };

function start(scene: SceneDoc, options: AiOptions = {}, trees: Record<string, JsonObject> = { idle: IDLE }): {
  kernel: Kernel; plugin: AiPlugin; byPrefab(id: string): EntityId[];
} {
  events.length = 0;
  const plugin = ai(options);
  const game: GameDefinition = { components: STUBS, resources: [], events: [], behaviors: [], systems: recorders };
  const kernel = new Kernel({ project: project([scene], trees), game, plugins: [nav(), plugin], context: { ctx: true } });
  kernel.start(scene.id);
  const byPrefab = (id: string): EntityId[] => [...kernel.world.live()].filter((r) => r.prefab === id).map((r) => r.id);
  return { kernel, plugin, byPrefab };
}

const at = (k: Kernel, id: EntityId): Vec3 => k.world.require(id).transform.worldPosition();
const move = (k: Kernel, id: EntityId, p: Vec3): void => k.world.require(id).transform.setWorldPosition(p);
const steps = (k: Kernel, seconds: number): void => { for (let i = 0; i < Math.round(seconds * 60); i++) k.step(1 / 60); };
const of = (type: string): Record<string, unknown>[] => events.filter((e) => e.type === type).map((e) => e.payload);
type Bb = { get(k: string): unknown; set(k: string, v: unknown): null; has(k: string): boolean };
const bbOf = (k: Kernel, id: EntityId): Bb => (k.world.require(id).components.get(BRAIN) as unknown as { blackboard: Bb }).blackboard;

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

describe('ai plugin install', () => {
  it('rejects broken trees and unregistered tasks at install, with the file', () => {
    const scene = sceneDoc('s', []);
    const bad = (): unknown => start(scene, {}, { idle: { root: { type: 'sequnce', children: [] } } });
    expect(code(bad)).toBe('PP3252');
    try { bad(); } catch (e) { expect((e as ParallaxError).diagnostic.path).toBe('content/behavior_tree/idle.json'); }
    expect(code(() => start(scene, {}, { idle: { root: { type: 'do', task: 'shoot' } } }))).toBe('PP3253');
    expect(code(() => start(sceneDoc('g', [place('guard', [0, 0, 0])]), {}, { idel: IDLE }))).toBe('no error');
  });

  it('a Brain naming an unknown tree fails on its first tick with a suggestion', () => {
    const { kernel } = start(sceneDoc('g', [place('guard', [0, 0, 0], { brain: { tree: 'idel' } })]));
    try { steps(kernel, 0.1); expect.unreachable(); } catch (e) {
      expect((e as ParallaxError).diagnostic.code).toBe('PP3255');
      expect((e as ParallaxError).diagnostic.fix).toBe('Did you mean "idle"?');
    }
  });

  it('a Perception with no targets tag and no Side is PP3260', () => {
    const { kernel } = start(sceneDoc('g', [place('cover', [0, 0, 0], { perception: {} })]));
    expect(code(() => steps(kernel, 0.5))).toBe('PP3260');
  });
});

describe('perception', () => {
  const SCENE = sceneDoc('p', [place('wall', [0, 0, 0]), place('guard', [-5, 0, 0]), place('thief', [5, 0, 0])]);

  it('walls hide, open sight raises awareness to Spotted, losing sight past memory is LostTarget', () => {
    const { kernel, byPrefab } = start(SCENE);
    const [guard] = byPrefab('guard');
    const [thief] = byPrefab('thief');
    kernel.world.require(guard!).transform.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    expect(kernel.world.require(guard!).transform.worldRotation().rotate(Vec3.FORWARD).x).toBeCloseTo(1);
    steps(kernel, 1);
    expect(of('spotted')).toEqual([]);
    expect(bbOf(kernel, guard!).get('alert')).toBe('unaware');
    // Out from behind the wall (the line now passes its end).
    move(kernel, thief!, new Vec3(2, 0, 12));
    steps(kernel, 0.6);
    const service = kernel.service(PERCEPTION_SERVICE);
    expect(service.awareness(guard!)).toBeGreaterThan(0);
    expect(service.awareness(guard!)).toBeLessThan(1);
    const meter = kernel.world.require(guard!).components.get('awareness')!;
    expect(meter['level']).toBeCloseTo(service.awareness(guard!), 9);
    steps(kernel, 2);
    expect(of('spotted')).toEqual([{ entity: guard, target: thief }]);
    expect(of('suspicious')).toHaveLength(1);
    const bb = bbOf(kernel, guard!);
    expect(bb.get('target')).toBe(thief);
    expect(bb.get('target_visible')).toBe(true);
    expect(bb.get('alert')).toBe('alert');
    expect((bb.get('target_position') as Vec3).z).toBeCloseTo(12);
    // Back behind the wall: hunted at the last known position for `memory`, then lost.
    move(kernel, thief!, new Vec3(5, 0, 0));
    steps(kernel, 0.5);
    expect(bb.get('target_visible')).toBe(false);
    expect(bb.get('alert')).toBe('alert');
    expect((bb.get('target_position') as Vec3).z).toBeCloseTo(12);
    for (let i = 0; i < 120 && of('lost_target').length === 0; i++) kernel.step(1 / 60);
    expect(of('lost_target')).toEqual([{ entity: guard, target: thief, position: new Vec3(2, 0, 12) }]);
    expect(bb.get('alert')).toBe('suspicious');
    // Then it calms down and forgets.
    steps(kernel, 2);
    expect(bb.get('alert')).toBe('unaware');
    expect(bb.has('target')).toBe(false);
  });

  it('a target in a brush volume is unseen from outside it, seen from inside it', () => {
    events.length = 0;
    const scene: SceneDoc = {
      ...sceneDoc('b', [place('guard', [-6, 0, 0], { perception: { fov: 360, notice_time: 0 } }), place('thief', [5, 0, 0])]),
      plugins: { terrain: { size: [40, 40], layers: ['grass'], brush: [{ id: 'tall', center: [5, 0], radius: 3, height: 1.6 }] } },
    };
    const game: GameDefinition = { components: STUBS, resources: [], events: [], behaviors: [], systems: recorders };
    const kernel = new Kernel({ project: project([scene], { idle: IDLE }), game, plugins: [terrain(), nav(), ai()], context: { ctx: true } });
    kernel.start('b');
    const id = (p: string): EntityId => [...kernel.world.live()].find((r) => r.prefab === p)!.id;
    const service = kernel.service(PERCEPTION_SERVICE);
    steps(kernel, 0.5);
    expect(service.awareness(id('guard'))).toBe(0);
    // The guard walks into the same patch: now it sees the thief.
    move(kernel, id('guard'), new Vec3(3.5, 0, 0));
    steps(kernel, 0.5);
    expect(service.awareness(id('guard'))).toBe(1);
    // Out of the brush, the thief is in plain sight from anywhere.
    move(kernel, id('guard'), new Vec3(-6, 0, 0));
    move(kernel, id('thief'), new Vec3(12, 0, 0));
    steps(kernel, 0.5);
    expect(service.known(id('guard'))[0]!.visible).toBe(true);
  });

  it("the weather's visibility limits sight: fog hides a target well inside sight_range", () => {
    const seen = (fog: number): boolean => {
      events.length = 0;
      const scene = sceneDoc('w', [place('guard', [0, 0, 0], { perception: { fov: 360, notice_time: 0 } }), place('thief', [12, 0, 0])]);
      const game: GameDefinition = { components: STUBS, resources: [], events: [], behaviors: [], systems: recorders };
      const sky = weather();
      const kernel = new Kernel({ project: project([scene], { idle: IDLE }), game, plugins: [nav(), ai(), sky], context: { ctx: true } });
      kernel.start('w');
      if (fog > 0) sky.control().set({ seconds: 0, fields: { fog } });
      steps(kernel, 0.5);
      return kernel.service(PERCEPTION_SERVICE).awareness([...kernel.world.live()].find((r) => r.prefab === 'guard')!.id) > 0;
    };
    expect(seen(0)).toBe(true);
    expect(seen(0.4)).toBe(false); // 3 / 0.4 = 7.5 m of visibility
  });

  it('the field of view and close range; Detectable visibility 0 is invisible', () => {
    const { kernel, byPrefab } = start(sceneDoc('f', [place('guard', [0, 0, 0], { perception: { fov: 90, notice_time: 0 } }), place('thief', [0, 0, -8])]));
    const [guard] = byPrefab('guard');
    const [thief] = byPrefab('thief');
    steps(kernel, 0.5);
    expect(of('spotted')).toEqual([]);
    move(kernel, thief!, new Vec3(0, 0, -1.5));
    steps(kernel, 0.5);
    expect(of('spotted')).toHaveLength(1);
    const p = kernel.world.require(guard!).components.get(PERCEPTION) as unknown as { forget(): null; sees(t: unknown): boolean };
    p.forget();
    kernel.world.require(thief!).components.get('detectable')!['visibility'] = 0;
    steps(kernel, 0.5);
    expect(p.sees(thief)).toBe(false);
  });

  it('hearing carries loudness meters, half through walls, and remembers where', () => {
    const { kernel, plugin, byPrefab } = start(SCENE);
    const [guard] = byPrefab('guard');
    const [thief] = byPrefab('thief');
    plugin.api().noise(new Vec3(5, 0, 0), 12, kw({}));
    steps(kernel, 0.5);
    expect(of('heard_noise')).toEqual([]);
    plugin.api().noise(new Vec3(5, 0, 0), 25);
    steps(kernel, 0.5);
    expect(of('heard_noise')).toEqual([{ entity: guard, position: new Vec3(5, 0, 0), source: null, kind: null }]);
    const bb = bbOf(kernel, guard!);
    expect(bb.get('heard_position')).toEqual(new Vec3(5, 0, 0));
    expect(bb.get('alert')).toBe('suspicious');
    // A source the guard perceives gains awareness, but hearing never spots.
    for (let i = 0; i < 10; i++) kernel.service(PERCEPTION_SERVICE).noise(at(kernel, thief!), 40, thief);
    steps(kernel, 0.3);
    expect(kernel.service(PERCEPTION_SERVICE).awareness(guard!)).toBeCloseTo(0.99, 6);
    expect(of('spotted')).toEqual([]);
  });

  it('smoke blocks sight while it lasts', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('s', [place('guard', [0, 0, 0], { perception: { notice_time: 0 } }), place('thief', [0, 0, 10])]));
    plugin.api().block_sight(new Vec3(0, 1.3, 5), 2, 1, kw({ grow: 0, fade: 0.2 }));
    steps(kernel, 0.5);
    expect(of('spotted')).toEqual([]);
    expect(plugin.api().line_of_sight(byPrefab('guard')[0], byPrefab('thief')[0])).toBe(false);
    steps(kernel, 1);
    expect(of('spotted')).toHaveLength(1);
  });
});

describe('squads and tactics', () => {
  const SCENE = sceneDoc('c', [
    place('crate', [-4, 0, 2]), place('crate', [4, 0, 2]),
    place('cover', [-4, 0, 1]), place('cover', [4, 0, 1]), place('cover', [0, 0, 1]),
    place('soldier', [-1, 0, -2]), place('soldier', [1, 0, -2]),
  ]);

  it('assigns each member its own hidden cover; a dead holder frees it', () => {
    const { kernel, plugin, byPrefab } = start(SCENE);
    const [a, b] = byPrefab('soldier');
    const squad = plugin.api().squad('alpha');
    expect(squad.members).toEqual([a, b]);
    expect(squad.assign_cover(new Vec3(0, 0, 20))).toBe(2);
    expect(bbOf(kernel, a!).get('cover')).toEqual(new Vec3(-4, 0, 1));
    expect(bbOf(kernel, b!).get('cover')).toEqual(new Vec3(4, 0, 1));
    kernel.destroy(a!);
    steps(kernel, 0.05);
    expect(plugin.api().find_cover(b, new Vec3(0, 0, 20))).toEqual(new Vec3(4, 0, 1));
    plugin.api().release_cover(b);
    move(kernel, b!, new Vec3(-2, 0, -2));
    expect(plugin.api().find_cover(b, new Vec3(0, 0, 20))).toEqual(new Vec3(-4, 0, 1));
  });

  it('flanks to the requested side with a clear shot; squadmates share a spotted target', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('f', [place('soldier', [0, 0, -10], { perception: { notice_time: 0, fov: 360 } }), place('soldier', [30, 0, -10], { perception: { fov: 1 } }), place('thief', [0, 0, 0])]));
    const [a, b] = byPrefab('soldier');
    const [thief] = byPrefab('thief');
    // a faces +z towards the thief: its right is +x.
    const right = plugin.api().flank_position(a, thief, kw({ side: 'right', distance: 6 }))!;
    expect(right.x).toBeCloseTo(6, 0);
    expect(right.z).toBeCloseTo(0, 0);
    const left = plugin.api().flank_position(a, thief, kw({ side: 'left', distance: 6 }))!;
    expect(left.x).toBeCloseTo(-6, 0);
    steps(kernel, 0.5);
    expect(of('spotted')).toEqual([{ entity: a, target: thief }]);
    const pb = kernel.world.require(b!).components.get(PERCEPTION) as unknown as { alert: string; target: unknown };
    expect(pb.alert).toBe('alert');
    expect(pb.target).toBe(thief);
    expect(plugin.api().squad('alpha').blackboard.get('target')).toBe(thief);
    expect(kernel.service(AI_SERVICE).squads()).toEqual([{ name: 'alpha', members: [a, b], leader: a, formation: 'wedge' }]);
  });
});

describe('RTS orders', () => {
  it('a group move arrives in formation at the slowest unit\'s pace', () => {
    const units = [0, 1, 2, 3, 4, 5].map((i) => place('unit', [-12 + (i % 3) * 1.5, 0, -2 + Math.floor(i / 3) * 3], i === 4 ? { nav_agent: { speed: 3 } } : {}));
    const { kernel, plugin, byPrefab } = start(sceneDoc('r', [...units, place('wall', [0, 0, 12])]));
    const ids = byPrefab('unit');
    plugin.api().command(ids, 'move', new Vec3(10, 0, 0), kw({ formation: 'box', spacing: 2 }));
    let fastest = 0;
    const last = new Map(ids.map((id) => [id, at(kernel, id)]));
    for (let i = 0; i < 60 * 20 && of('order_done').length < ids.length; i++) {
      kernel.step(1 / 60);
      for (const id of ids) {
        const p = at(kernel, id);
        fastest = Math.max(fastest, Math.hypot(p.x - last.get(id)!.x, p.z - last.get(id)!.z) * 60);
        last.set(id, p);
      }
    }
    expect(of('order_done')).toHaveLength(6);
    expect(fastest).toBeLessThanOrEqual(3 + 1e-6);
    const slots = placeSlots(new Vec3(10, 0, 0), { x: 1, z: 0 }, formationOffsets('box', 6, 2), true);
    const used = new Set<number>();
    for (const id of ids) {
      const p = at(kernel, id);
      const near = slots.findIndex((s, i) => !used.has(i) && Math.hypot(s.x - p.x, s.z - p.z) < 0.2);
      expect(near).toBeGreaterThanOrEqual(0);
      used.add(near);
    }
    const o = kernel.world.require(ids[0]!).components.get(ORDERS) as unknown as { order: string };
    expect(o.order).toBe('idle');
  });

  it('attack chases into range and engages; aggressive units acquire enemies on attack-move', () => {
    const { kernel, byPrefab } = start(sceneDoc('a', [place('unit', [0, 0, 0], { orders: { stance: 'aggressive', attack_range: 3, acquire_range: 8 } }), place('guard', [0, 0, 30])]));
    const [unit] = byPrefab('unit');
    const [enemy] = byPrefab('guard');
    const o = kernel.world.require(unit!).components.get(ORDERS) as unknown as {
      attack_move(p: Vec3): null; order: string; engaging: boolean; target: unknown; stop(): null;
    };
    o.attack_move(new Vec3(0, 0, 40));
    for (let i = 0; i < 60 * 10 && !o.engaging; i++) kernel.step(1 / 60);
    expect(o.engaging).toBe(true);
    expect(o.target).toBe(enemy);
    expect(Math.abs(at(kernel, unit!).z - 30)).toBeLessThanOrEqual(3 + 1e-6);
    expect(o.order).toBe('attack_move');
    kernel.destroy(enemy!);
    steps(kernel, 10);
    expect(of('order_done')).toEqual([{ entity: unit, order: 'attack_move' }]);
    expect(at(kernel, unit!).z).toBeCloseTo(40, 0);
  });
});

describe('flocks', () => {
  const school = (): Placement[] => {
    const out: Placement[] = [];
    for (let i = 0; i < 24; i++) out.push(place('fish', [(i % 6) * 1.5 - 4, 5 + (i % 3) * 0.5, Math.floor(i / 6) * 1.5 - 3]));
    return out;
  };

  it('stays cohesive and aligned without collapsing, deterministically', () => {
    const run = (): Vec3[] => {
      const { kernel, byPrefab } = start(sceneDoc('fl', school()));
      steps(kernel, 20);
      return byPrefab('fish').map((id) => at(kernel, id));
    };
    const end = run();
    expect(run()).toEqual(end);
    const c = end.reduce((s, p) => s.__add__(p), Vec3.ZERO).__mul__(1 / end.length);
    expect(Math.max(...end.map((p) => p.distance_to(c)))).toBeLessThan(10);
    // The home leash is soft: the school roams near it.
    expect(Math.hypot(c.x, c.y - 5, c.z)).toBeLessThan(18);
    const nearest = end.map((p, i) => Math.min(...end.filter((_, j) => j !== i).map((q) => q.distance_to(p))));
    expect(nearest.reduce((a, b) => a + b, 0) / nearest.length).toBeGreaterThan(0.5);
  });

  it('flees what it avoids', () => {
    const { kernel, byPrefab } = start(sceneDoc('fl', [place('fish', [0, 5, 0], { flock: { avoid: 'shark', avoid_radius: 6, flee: 3, home: null, wander: 0 } })]));
    const [fish] = byPrefab('fish');
    kernel.world.require(fish!).transform.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    const shark = kernel.spawn('thief', {}, {});
    shark.tags.add('shark');
    shark.transform.setWorldPosition(new Vec3(3, 5, 0));
    // It swims at the shark, turns away (it never stops below min_speed), and leaves.
    steps(kernel, 2);
    expect(at(kernel, fish!).x).toBeLessThan(0);
    const f = kernel.world.require(fish!).components.get(FLOCK) as unknown as { velocity: Vec3 };
    expect(f.velocity.x).toBeLessThan(0);
  });
});

describe('fog of war', () => {
  it('a team sees around walls, remembers explored ground, and reveals ignore walls', () => {
    const { kernel, plugin, byPrefab } = start(sceneDoc('fog', [place('wall', [0, 0, 0]), place('scout', [-5, 0, 0])]), { fogCell: 1 });
    const fog = kernel.service(FOG_OF_WAR_SERVICE);
    steps(kernel, 0.3);
    expect(fog.teams()).toEqual(['blue']);
    expect(fog.visible('blue', -2, 0)).toBe(true);
    // The wall's own near cells are seen; what lies behind them is not.
    expect(fog.visible('blue', -0.6, 0)).toBe(true);
    expect(fog.visible('blue', 3, 0)).toBe(false);
    expect(fog.visible('blue', 3, 8)).toBe(false);
    expect(fog.visible('blue', -5, 9)).toBe(true);
    expect(fog.visible('red', -2, 0)).toBe(false);
    const v = fog.version;
    move(kernel, byPrefab('scout')[0]!, new Vec3(-30, 0, 0));
    steps(kernel, 0.3);
    expect(fog.version).toBeGreaterThan(v);
    expect(fog.visible('blue', -2, 0)).toBe(false);
    expect(fog.explored('blue', -2, 0)).toBe(true);
    plugin.api().fog.reveal('blue', new Vec3(3, 0, 0), 2, 1);
    steps(kernel, 0.1);
    expect(fog.visible('blue', 3, 0)).toBe(true);
    steps(kernel, 1.3);
    expect(fog.visible('blue', 3, 0)).toBe(false);
    expect(fog.explored('blue', 3, 0)).toBe(true);
    const field = fog.field('blue', -3, -1, 4, 1);
    expect(field.cols).toBe(8);
    expect(field.cells[field.cols + 1]).toBe(2);
  });
});

describe('director', () => {
  it('is configured by the plugin and emits its phase changes', () => {
    const { kernel, plugin } = start(sceneDoc('d', []), { director: { peak_seconds: 1, relax_seconds: 1, decay: 1 } });
    const d = plugin.api().director;
    expect(d.phase).toBe('build');
    d.report(1);
    steps(kernel, 0.1);
    expect(d.phase).toBe('peak');
    steps(kernel, 1.1);
    expect(d.phase).toBe('relax');
    expect(d.can_spawn()).toBe(false);
    steps(kernel, 1.2);
    expect(of('director_phase').map((p) => p['phase'])).toEqual(['peak', 'relax', 'build']);
    expect(kernel.service(AI_SERVICE).director()!.phase).toBe('build');
    expect(code(() => start(sceneDoc('n', [])).plugin.api().director.phase)).toBe('PP3281');
  });
});

describe('snapshots', () => {
  const WAYPOINTS = [new Vec3(6, 0, 0), new Vec3(6, 0, 6), new Vec3(0, 0, 6), new Vec3(0, 0, 0)];
  const PATROL = {
    blackboard: { lap: 0 },
    root: {
      type: 'repeat', child: {
        type: 'sequence', children: [
          { type: 'do', task: 'next_waypoint' },
          { type: 'wait', seconds: [0.1, 0.6] },
          { type: 'move_to', key: 'goal' },
          { type: 'add', key: 'lap' },
        ],
      },
    },
  };
  const options = (): AiOptions => ({
    tasks: [{
      name: 'next_waypoint',
      tick: (_ctx: unknown, agent: unknown) => {
        const bb = (agent as TaskAgent).blackboard;
        const i = (bb.get('index', 0) as number) % WAYPOINTS.length;
        bb.set('goal', WAYPOINTS[i]);
        bb.set('index', i + 1);
        return 'success';
      },
    }],
  });

  it('restores a brain, perception and orders mid-behavior and continues identically', () => {
    const scene = sceneDoc('snap', [place('patroller', [0, 0, 0]), place('thief', [3, 0, 3]), place('unit', [-6, 0, 0])]);
    const { kernel, plugin, byPrefab } = start(scene, options(), { idle: IDLE, patrol: PATROL as unknown as JsonObject });
    const [p] = byPrefab('patroller');
    const [unit] = byPrefab('unit');
    (kernel.world.require(unit!).components.get(ORDERS) as unknown as { patrol(points: Vec3[]): null }).patrol([new Vec3(-6, 0, 8), new Vec3(-10, 0, 0)]);
    steps(kernel, 3.3);
    const brain = kernel.world.require(p!).components.get(BRAIN) as unknown as { running: string[]; status: string; describe(): string };
    expect(brain.status).toBe('running');
    const snap = kernel.snapshot();
    const trace = (): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 240; i++) {
        kernel.step(1 / 60);
        if (i % 20 === 0) {
          out.push(`${at(kernel, p!).x.toFixed(6)},${at(kernel, p!).z.toFixed(6)} ${at(kernel, unit!).x.toFixed(6)} ${brain.running.join('|')} ${String(bbOf(kernel, p!).get('lap'))} ${String(bbOf(kernel, p!).get('alert'))}`);
        }
      }
      return out;
    };
    const first = trace();
    kernel.restore(snap);
    expect(trace()).toEqual(first);
    expect(Number(bbOf(kernel, p!).get('lap'))).toBeGreaterThan(0);
    const view = kernel.service(AI_SERVICE).brain(p!)!;
    expect(view.tree).toBe('patrol');
    expect(view.trace).toContain('patrol: running');
    void plugin;
  });
});

