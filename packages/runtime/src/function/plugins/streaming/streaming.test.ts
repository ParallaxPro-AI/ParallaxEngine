import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { Project } from '../../../resource/index.js';
import { Kernel, KERNEL_EVENTS, t } from '../../kernel/index.js';
import type { BehaviorDef, Fields, GameDefinition, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { SAVE_SERVICE, STORY_SERVICE, STREAMING_SERVICE } from '../../services/index.js';
import type { QuestStatus, SaveSection, StreamedWorld } from '../../services/index.js';
import { streaming } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const DT = 1 / 60;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : `not a ParallaxError: ${String(error)}`;
  }
  return undefined;
}

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const W = 'scenes/ow';

/** Cells of 100 m; radius 150. The camera and hero start at the origin. */
function openWorld(extra: Record<string, unknown> = {}): Project {
  return loadProject(files({
    'prefabs/eye.prefab.json': { components: { camera: {} } },
    'prefabs/hero.prefab.json': { components: { hp: { value: 10 } } },
    'prefabs/crate.prefab.json': { components: { hp: { value: 3 } }, behaviors: { counter: {} } },
    [`${W}/scene.json`]: { entities: [{ id: 'sign', prefab: 'crate', at: [900, 0, 900] }] },
    [`${W}/world.json`]: {
      cell_size: 100,
      streaming: { radius: 150 },
      layers: { base: {}, night: {}, raid: { active_when: { quest_active: 'raid' } } },
    },
    [`${W}/regions/near/region.json`]: {},
    [`${W}/regions/near/entities/eye.json`]: { prefab: 'eye', at: [0, 5, 0], always_loaded: true, components: { camera: { follow: 'hero' } } },
    [`${W}/regions/near/entities/hero.json`]: { prefab: 'hero', at: [0, 0, 0], always_loaded: true },
    [`${W}/regions/near/entities/box_near.json`]: { prefab: 'crate', at: [50, 0, 50] },
    [`${W}/regions/far/region.json`]: {},
    [`${W}/regions/far/entities/box_far.json`]: { prefab: 'crate', at: [450, 0, 20] },
    [`${W}/regions/far/entities/lamp.json`]: { prefab: 'crate', at: [20, 0, 20], layer: 'night' },
    [`${W}/regions/far/entities/raider.json`]: { prefab: 'crate', at: [-20, 0, 20], layer: 'raid' },
    'scenes/plain/scene.json': { entities: [{ id: 'box', prefab: 'crate', at: [0, 0, 0] }] },
    ...extra,
  }));
}

interface Setup {
  readonly kernel: Kernel;
  readonly destroyed: Fields[];
  readonly quests: Map<string, string>;
  world(): StreamedWorld;
  id(placed: string): EntityId | undefined;
  hero(): EntityId;
  move(placed: string, x: number, z: number): void;
  step(n?: number): void;
}

function setup(p: Project = openWorld(), plugins: KernelPlugin[] = []): Setup {
  const destroyed: Fields[] = [];
  const quests = new Map<string, string>();
  const listener: SystemDef = {
    id: 'listener', scenes: [], handlers: [{ event: KERNEL_EVENTS.destroyed, method: 'gone' }],
    create: () => ({ gone: (_ctx: unknown, e: Fields) => destroyed.push(e) }),
  };
  const counter: BehaviorDef = {
    id: 'counter', params: {}, state: { ticks: t.int({ default: 0 }) }, requires: [], handlers: [],
    create: () => ({ update(this: Fields) { (this['ticks'] as number)++; } }) as never,
  };
  const story: KernelPlugin = {
    id: 'fake_story',
    install: (k) => k.provide(STORY_SERVICE, {
      questStatus: (q: string) => (quests.get(q) ?? 'inactive') as QuestStatus,
      fact: () => false,
      markers: () => [],
      players: () => [],
    }),
  };
  const game: GameDefinition = {
    components: [
      { id: 'camera', schema: { follow: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null } } },
      { id: 'hp', schema: { value: t.number({ default: 1 }) } },
    ],
    resources: [], events: [], behaviors: [counter], systems: [listener],
  };
  const kernel = new Kernel({
    project: p, game, plugins: [streaming(), story, ...plugins],
    entities: { wrap: (id) => id, unwrap: (h) => (typeof h === 'number' ? h as EntityId : undefined) },
  });
  kernel.start('ow');
  const id = (placed: string): EntityId | undefined => {
    for (const r of kernel.world.live()) if (r.placedId === placed) return r.id;
    return undefined;
  };
  return {
    kernel, destroyed, quests,
    world: () => kernel.service(STREAMING_SERVICE).current()!,
    id,
    hero: () => id('hero')!,
    move: (placed, x, z) => { kernel.world.get(id(placed)!)!.transform.position = new Vec3(x, 0, z); },
    step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

describe('streaming', () => {
  it('loads only what is near a source and in an active layer', () => {
    const s = setup();
    expect(s.id('box_near')).toBeDefined();
    expect(s.id('lamp')).toBeDefined();
    expect(s.id('box_far')).toBeUndefined();
    expect(s.id('raider')).toBeUndefined();
    // Placements in scene.json never stream.
    expect(s.id('sign')).toBeDefined();
    expect(s.world().isLoaded('box_far')).toBe(false);
    expect(s.world().isLoaded('sign')).toBeUndefined();
    expect(s.world().layers()).toEqual([
      { id: 'base', state: 'active', declarative: false },
      { id: 'night', state: 'active', declarative: false },
      { id: 'raid', state: 'loaded', declarative: true },
    ]);
    // Authored entities that start streamed out never ran: no end, no destroyed event.
    s.step();
    expect(s.destroyed).toEqual([]);
  });

  it('streams entities out with their state and back in as they were', () => {
    const s = setup();
    s.step(10);
    const box = s.id('box_near')!;
    const hp = s.kernel.world.get(box)!.components.get('hp')!;
    hp['value'] = 1.5;
    s.kernel.world.get(box)!.tags.add('dented');
    const ticks = s.kernel.world.get(box)!.behaviors[0]!.instance['ticks'];
    expect(ticks).toBe(10);
    s.move('hero', 600, 0);
    s.move('eye', 600, 0);
    s.step();
    expect(s.id('box_near')).toBeUndefined();
    expect(s.id('box_far')).toBeDefined();
    expect(s.destroyed).toContainEqual({ entity: box, unloaded: true });
    expect(s.world().held().get('box_near')!.components['hp']).toEqual({ value: 1.5 });

    s.move('hero', 0, 0);
    s.move('eye', 0, 0);
    s.step();
    const back = s.kernel.world.get(s.id('box_near')!)!;
    expect(back.id).not.toBe(box);
    expect(back.components.get('hp')!['value']).toBe(1.5);
    expect(back.tags.has('dented')).toBe(true);
    expect(back.behaviors[0]!.instance['ticks']).toBe(11);
    expect(s.world().held().has('box_near')).toBe(false);
  });

  it('streams by an entity\'s current cell, with half a cell of slack before unloading', () => {
    const s = setup();
    const box = s.id('box_near')!;
    // Cell (2, 0) starts 200 m away: past the 150 m radius but inside 150 + 50.
    s.kernel.world.get(box)!.transform.position = new Vec3(210, 0, 10);
    s.step();
    expect(s.id('box_near')).toBe(box);
    s.kernel.world.get(box)!.transform.position = new Vec3(310, 0, 10);
    s.step();
    expect(s.id('box_near')).toBeUndefined();
    expect(s.world().held().get('box_near')!.position.x).toBe(310);
    // Its held position, not its authored one, decides when it comes back.
    s.move('hero', 250, 0);
    s.step();
    expect(s.kernel.world.get(s.id('box_near')!)!.transform.position.x).toBe(310);
  });

  it('never brings back a streamed entity the game destroyed', () => {
    const s = setup();
    s.kernel.destroy(s.id('box_near')!);
    s.step();
    expect(s.world().destroyed().has('box_near')).toBe(true);
    s.move('hero', 600, 0);
    s.move('eye', 600, 0);
    s.step();
    expect(s.id('box_far')).toBeDefined();
    s.move('hero', 0, 0);
    s.move('eye', 0, 0);
    s.step();
    expect(s.id('box_near')).toBeUndefined();
  });

  it('follows active_when every frame and refuses to switch it from code', () => {
    const s = setup();
    s.quests.set('raid', 'active');
    s.step();
    expect(s.id('raider')).toBeDefined();
    expect(s.world().layerState('raid')).toBe('active');
    s.quests.set('raid', 'completed');
    s.step();
    expect(s.id('raider')).toBeUndefined();
    expect(s.world().layerState('raid')).toBe('loaded');
    expect(code(() => s.world().setLayerState('raid', 'active'))).toBe('PP3631');
    expect(code(() => s.world().layerState('raidd'))).toBe('PP3630');
  });

  it('switches imperative layers at once; unloaded forgets held state', () => {
    const s = setup();
    const lamp = s.id('lamp')!;
    s.kernel.world.get(lamp)!.components.get('hp')!['value'] = 9;
    s.world().setLayerState('night', 'loaded');
    expect(s.id('lamp')).toBeUndefined();
    expect(s.world().held().get('lamp')!.components['hp']).toEqual({ value: 9 });
    s.world().setLayerState('night', 'active');
    expect(s.kernel.world.get(s.id('lamp')!)!.components.get('hp')!['value']).toBe(9);
    s.world().setLayerState('night', 'unloaded');
    expect(s.world().held().has('lamp')).toBe(false);
    s.world().setLayerState('night', 'active');
    expect(s.kernel.world.get(s.id('lamp')!)!.components.get('hp')!['value']).toBe(3);
  });

  it('keeps imperative layer states across scene loads until new_run=True', () => {
    const s = setup();
    s.world().setLayerState('night', 'loaded');
    s.kernel.requestScene('plain');
    s.step();
    expect(s.kernel.service(STREAMING_SERVICE).current()).toBeNull();
    s.kernel.requestScene('ow');
    s.step();
    expect(s.world().layerState('night')).toBe('loaded');
    expect(s.id('lamp')).toBeUndefined();
    s.kernel.requestScene('ow', { newRun: true });
    s.step();
    expect(s.world().layerState('night')).toBe('active');
    expect(s.id('lamp')).toBeDefined();
  });

  it('snapshots and restores loaded, held and layer state', () => {
    const s = setup();
    s.kernel.world.get(s.id('lamp')!)!.components.get('hp')!['value'] = 7;
    s.world().setLayerState('night', 'loaded');
    s.move('hero', 600, 0);
    s.step();
    const snap = s.kernel.snapshot();
    s.move('hero', 0, 0);
    s.world().setLayerState('night', 'active');
    s.step();
    s.kernel.restore(snap);
    expect(s.world().layerState('night')).toBe('loaded');
    expect(s.world().isLoaded('box_far')).toBe(true);
    expect(s.world().held().get('lamp')!.components['hp']).toEqual({ value: 7 });
    expect(JSON.stringify(s.kernel.snapshot())).toBe(JSON.stringify(snap));
    s.world().setLayerState('night', 'active');
    s.move('hero', 0, 0);
    s.step();
    expect(s.kernel.world.get(s.id('lamp')!)!.components.get('hp')!['value']).toBe(7);
  });

  it('saves imperative layer states through the save service', () => {
    const sections: SaveSection[] = [];
    const saver: KernelPlugin = { id: 'fake_save', install: (k) => k.provide(SAVE_SERVICE, { register: (sec) => sections.push(sec) }) };
    const s = setup(openWorld(), [saver]);
    s.world().setLayerState('night', 'unloaded');
    expect(sections[0]!.key).toBe('world_layers');
    const saved = sections[0]!.save();
    expect(saved).toEqual({ ow: { night: 'unloaded' } });
    sections[0]!.load(undefined);
    expect(s.world().layerState('night')).toBe('active');
    expect(s.id('lamp')).toBeDefined();
    sections[0]!.load(saved);
    expect(s.id('lamp')).toBeUndefined();
    expect(code(() => sections[0]!.load({ ow: { night: 'asleep' } }))).toBe('PP3635');
  });

  it('rejects bad world data with coded diagnostics', () => {
    const bad = (extra: Record<string, unknown>) => code(() => setup(openWorld(extra)));
    expect(bad({ [`${W}/world.json`]: { cell_size: 100, layers: { a: { active_when: { quest_activ: 'x' } } } } })).toBe('PP3632');
    expect(bad({ [`${W}/world.json`]: { cell_size: 100, streaming: { radius: -1 }, layers: {} } })).toBe('PP3634');
    expect(bad({ [`${W}/world.json`]: { cell_size: 100, layers: { base: {} } } })).toBe('PP3633');
  });
});

// ── The examples' open worlds ──────────────────────────────────────────────────

const EXAMPLES = '../../../../../../examples/';
const raw = import.meta.glob('../../../../../../examples/{open_world_sandbox,open_world_rpg}/**/*.json', {
  query: '?raw', import: 'default', eager: true,
});

function example(name: string): Project {
  const prefix = `${EXAMPLES}${name}/`;
  const paths = Object.keys(raw).filter((p) => p.startsWith(prefix));
  return loadProject({ list: () => paths.map((p) => p.slice(prefix.length)).sort(), read: (path) => raw[prefix + path]! });
}

/** Every component field and behavior param the data uses, as an optional JSON field (as kernel/examples.test.ts does). */
function permissiveGame(p: Project): GameDefinition {
  const components = new Map<string, Set<string>>();
  const behaviors = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: object): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const instance = (inst: { components: Readonly<Record<string, object>>; params: Readonly<Record<string, object>> }): void => {
    for (const [id, fields] of Object.entries(inst.components)) note(components, id, fields);
    for (const [id, params] of Object.entries(inst.params)) note(behaviors, id, params);
  };
  for (const prefab of p.prefabs.values()) {
    for (const [id, fields] of Object.entries(prefab.components)) note(components, id, fields);
    for (const use of prefab.behaviors) note(behaviors, use.use, use.params);
    prefab.children.forEach(instance);
  }
  for (const scene of p.scenes.values()) scene.entities.forEach(instance);
  const schema = (fields: Set<string>) => Object.fromEntries([...fields].map((f) => [f, { type: { kind: 'json' as const }, default: null }]));
  return {
    components: [...components].map(([id, fields]) => ({ id, schema: schema(fields) })),
    behaviors: [...behaviors].map(([id, params]) => ({
      id, params: schema(params), state: {}, requires: [], handlers: [], create: () => ({}),
    })),
    resources: [], events: [], systems: [],
  };
}

describe('example open worlds', () => {
  for (const [name, scene, camera, quest, layered] of [
    ['open_world_sandbox', 'sunset_bay', 'camera', 'closing_window', 'canal_runner'],
    ['open_world_rpg', 'sundermere', 'camera', 'shadow_dungeon', 'malakar'],
  ] as const) {
    it(`${name}: streams ${scene} around the camera and follows its quest layers`, () => {
      const p = example(name);
      const doc = p.scenes.get(scene)!;
      const quests = new Map<string, string>();
      const story: KernelPlugin = {
        id: 'fake_story',
        install: (k) => k.provide(STORY_SERVICE, {
          questStatus: (q: string) => (quests.get(q) ?? 'inactive') as QuestStatus,
          fact: () => false,
          markers: () => [],
          players: () => [],
        }),
      };
      const kernel = new Kernel({ project: p, game: permissiveGame(p), plugins: [streaming(), story] });
      kernel.start(scene);
      const world = kernel.service(STREAMING_SERVICE).current()!;
      const live = (): Set<string> => new Set([...kernel.world.live()].flatMap((r) => (r.placedId === undefined ? [] : [r.placedId])));
      const streamed = doc.entities.filter((e) => e.region !== undefined && e.id !== undefined && !e.alwaysLoaded);
      const free = streamed.filter((e) => e.layer === undefined || e.layer === 'base');
      expect(free.length).toBeGreaterThan(5);
      // The examples' maps fit in the radius from the start: every ungated placement is in.
      for (const e of free) expect(live().has(e.id!), e.id).toBe(true);
      expect(live().has(layered)).toBe(false);
      quests.set(quest, 'active');
      kernel.step(DT);
      expect(live().has(layered)).toBe(true);

      // Carry every source far away: the ungated streamed placements leave, with state held…
      const cam = [...kernel.world.live()].find((r) => r.placedId === camera)!;
      for (const r of kernel.world.live()) if (r.placedId !== undefined && doc.entities.find((e) => e.id === r.placedId)?.alwaysLoaded) {
        r.transform.position = new Vec3(5000, 0, 5000);
      }
      expect(cam.transform.position.x).toBe(5000);
      kernel.step(DT);
      for (const e of streamed) expect(live().has(e.id!), e.id).toBe(false);
      expect(world.held().size).toBe(streamed.filter((e) => e.layer === undefined || world.layerState(e.layer) === 'active').length);
      // …and come back where they were.
      for (const r of kernel.world.live()) if (r.placedId !== undefined && doc.entities.find((e) => e.id === r.placedId)?.alwaysLoaded) {
        const at = doc.entities.find((e) => e.id === r.placedId)!.at!;
        r.transform.position = new Vec3(at[0]!, at[1]!, at[2]!);
      }
      kernel.step(DT);
      for (const e of free) expect(live().has(e.id!), e.id).toBe(true);
      expect(world.held().size).toBe(0);
      const snap = kernel.snapshot();
      kernel.restore(snap);
      expect(JSON.stringify(kernel.snapshot())).toBe(JSON.stringify(snap));
    });
  }
});
