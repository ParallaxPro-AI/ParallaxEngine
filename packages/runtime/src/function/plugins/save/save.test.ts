import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, KeyValueStore, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, GameDefinition, KernelPlugin, Schema } from '../../kernel/index.js';
import { SAVE_SERVICE, STREAMING_SERVICE } from '../../services/index.js';
import { streaming } from '../streaming/index.js';
import type { MigrationStep, SaveDocument } from '../../services/index.js';
import { memoryStore, migrateDocument, parseStored, persistence, PROFILE_KEY, save, SLOT_PREFIX, UNREADABLE_PROFILE_KEY, stringify } from './index.js';
import type { SaveEngine } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const HEALTH: Schema = { current: t.number({ default: 10 }), max: t.number({ default: 10 }) };
const TARGET: Schema = { of: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null } };
const DATA = {
  'prefabs/crate.prefab.json': { components: { health: {} }, behaviors: { counter: {} } },
  'prefabs/coin.prefab.json': { components: { health: {} } },
  'prefabs/pointer.prefab.json': { components: { target: {} } },
  'scenes/main/scene.json': { entities: [
    { id: 'crate', prefab: 'crate', at: [1, 0, 0] },
    { id: 'coin', prefab: 'coin', at: [5, 0, 0] },
    { id: 'pointer', prefab: 'pointer' },
    { prefab: 'coin', at: [9, 0, 0] },
  ] },
  'scenes/other/scene.json': { entities: [] },
};

const COUNTER: BehaviorDef = {
  id: 'counter', params: {}, state: { count: t.int({ default: 0 }) }, requires: [], handlers: [], create: () => ({}),
};

function definition(): GameDefinition {
  return {
    components: [{ id: 'health', schema: HEALTH }, { id: 'target', schema: TARGET }],
    resources: [
      { id: 'run', schema: { gold: t.int({ default: 0 }), level: t.int({ default: 1 }), seen: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null } } },
      { id: 'record', keep: 'profile', schema: { best: t.int({ default: 0 }) } },
      { id: 'mode', schema: { hard: t.bool({ default: false, keep: 'session' }) } },
    ],
    events: [],
    behaviors: [COUNTER],
    systems: [],
  };
}

interface Game {
  readonly kernel: Kernel;
  readonly save: SaveEngine;
  readonly store: KeyValueStore;
}

function game(options: { store?: KeyValueStore; saveVersion?: number; migrations?: MigrationStep[]; plugins?: KernelPlugin[]; data?: Record<string, unknown> } = {}): Game {
  const store = options.store ?? memoryStore();
  const project = loadProject(files(options.data ?? DATA));
  expect(project.diagnostics).toEqual([]);
  const slots = save({ seed: () => 42 });
  const kernel = new Kernel({
    project,
    game: definition(),
    plugins: [persistence({ store, saveVersion: options.saveVersion ?? 1, migrations: () => options.migrations ?? [] }), slots, ...(options.plugins ?? [])],
  });
  kernel.start('main');
  return { kernel, save: slots.engine, store };
}

function placed(kernel: Kernel, id: string): EntityId {
  const record = [...kernel.world.live()].find((r) => r.placedId === id);
  if (record === undefined) throw new Error(`no placed ${id}`);
  return record.id;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParallaxError) return error.diagnostic.code;
    throw error;
  }
  throw new Error('expected a coded error');
}

describe('profile (persistence plugin)', () => {
  it('loads keep="profile" fields at install and writes them back when they change', () => {
    const store = memoryStore();
    const first = game({ store });
    first.kernel.resource('record')['best'] = 7;
    first.kernel.resource('run')['gold'] = 3;
    first.kernel.step(1 / 60);
    const written = parseStored(store.get(PROFILE_KEY)!, 'profile', '');
    expect(written.resources).toEqual({ record: { best: 7 } });

    const second = game({ store });
    expect(second.kernel.resource('record')['best']).toBe(7);
    expect(second.kernel.resource('run')['gold']).toBe(0);
  });

  it('does not write an unchanged profile', () => {
    const store = memoryStore();
    const { kernel } = game({ store });
    kernel.step(1 / 60);
    const writes: string[] = [];
    const spy: KeyValueStore = { ...store, set: (k, v) => { writes.push(k); store.set(k, v); } };
    const again = game({ store: spy });
    again.kernel.step(1 / 60);
    again.kernel.step(1 / 60);
    expect(writes).toEqual([]);
  });

  it('refuses a bad save_version', () => {
    expect(code(() => game({ saveVersion: 0 }))).toBe('PP3951');
  });

  it('sets aside a profile it cannot read and starts fresh, so the game still starts', () => {
    for (const text of ['{not json', JSON.stringify({ version: 1, scene: '', seed: null, entities: {}, resources: { record: { gone: 1 } }, modifiers: {} })]) {
      const store = memoryStore();
      store.set(PROFILE_KEY, text);
      const { kernel } = game({ store });
      expect(kernel.resource('record')['best']).toBe(0);
      expect(store.get(UNREADABLE_PROFILE_KEY)).toBe(text);
      kernel.resource('record')['best'] = 2;
      kernel.step(1 / 60);
      expect(parseStored(store.get(PROFILE_KEY)!, 'profile', '').resources).toEqual({ record: { best: 2 } });
    }
  });
});

describe('slot saves', () => {
  it('round-trips run fields, the placed-entity diff and behavior state through a load', () => {
    const { kernel, save: slots, store } = game();
    kernel.resource('run')['gold'] = 12;
    kernel.resource('run')['seen'] = placed(kernel, 'crate');
    kernel.resource('mode')['hard'] = true;
    const crate = placed(kernel, 'crate');
    kernel.world.require(crate).components.get('health')!['current'] = 4;
    kernel.world.require(crate).transform.position = new Vec3(2, 3, 4);
    kernel.world.require(crate).tags.add('cracked');
    (kernel.world.require(crate).behaviors[0]!.instance as Record<string, unknown>)['count'] = 9;
    kernel.world.require(placed(kernel, 'pointer')).components.get('target')!['of'] = crate;
    kernel.destroy(placed(kernel, 'coin'));
    kernel.step(1 / 60);

    slots.save('one');
    const doc = parseStored(store.get(`${SLOT_PREFIX}one`)!, 'slot', '');
    expect(doc).toMatchObject({ version: 1, scene: 'main', seed: 42, resources: { run: { gold: 12, level: 1, seen: 'crate' } } });
    expect(doc.entities).toEqual({
      crate: {
        health: { current: 4 },
        counter: { count: 9 },
        transform: { position: [2, 3, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        tags: ['cracked'],
      },
      coin: { destroyed: true },
      pointer: { target: { of: 'crate' } },
    });

    kernel.resource('run')['gold'] = 0;
    expect(slots.load('one')).toBe(true);
    kernel.step(1 / 60);
    const loaded = placed(kernel, 'crate');
    expect(loaded).not.toBe(crate);
    expect(kernel.resource('run')['gold']).toBe(12);
    expect(kernel.resource('run')['seen']).toBe(loaded);
    expect(kernel.resource('mode')['hard']).toBe(true);
    const record = kernel.world.require(loaded);
    expect(record.components.get('health')).toMatchObject({ current: 4, max: 10 });
    expect(record.transform.position.x).toBe(2);
    expect([...record.tags]).toEqual(['cracked']);
    expect((record.behaviors[0]!.instance as Record<string, unknown>)['count']).toBe(9);
    expect([...kernel.world.live()].some((r) => r.placedId === 'coin')).toBe(false);
    expect(kernel.world.require(placed(kernel, 'pointer')).components.get('target')!['of']).toBe(loaded);
  });

  it('saves a reference to a spawned entity as None', () => {
    const { kernel, save: slots, store } = game();
    const target = kernel.world.require(placed(kernel, 'pointer')).components.get('target')!;
    target['of'] = placed(kernel, 'crate');
    slots.save('auto');
    expect(parseStored(store.get(`${SLOT_PREFIX}auto`)!, 'slot', '').entities).toEqual({ pointer: { target: { of: 'crate' } } });
    target['of'] = kernel.spawn('coin').id;
    slots.save('auto');
    // None is what the scene authored, so the entity has no difference left to save.
    expect(parseStored(store.get(`${SLOT_PREFIX}auto`)!, 'slot', '').entities).toEqual({});
  });

  it('lists, checks and deletes slots; an empty slot loads nothing', () => {
    const { save: slots } = game();
    expect(slots.exists('a')).toBe(false);
    expect(slots.load('a')).toBe(false);
    slots.save('b');
    slots.save('a');
    expect(slots.slots()).toEqual(['a', 'b']);
    slots.delete('a');
    expect(slots.slots()).toEqual(['b']);
    expect(code(() => slots.save(''))).toBe('PP3950');
  });

  it('keeps each slot\'s info: scene, the run\'s play time, wall-clock time, label and order', () => {
    let clock = 1_700_000_000;
    const store = memoryStore();
    const project = loadProject(files(DATA));
    const slots = save({ seed: () => 42 });
    const kernel = new Kernel({
      project, game: definition(),
      plugins: [persistence({ store, saveVersion: 1, migrations: () => [], wallClock: () => clock }), slots],
    });
    kernel.start('main');
    const steps = (n: number): void => { for (let i = 0; i < n; i++) kernel.step(1 / 60); };
    steps(120);
    expect(slots.engine.info('a')).toBeUndefined();
    slots.engine.save('a', 'Before the gate');
    expect(slots.engine.info('a')).toEqual({ scene: 'main', play_time: expect.closeTo(2, 9), saved_at: 1_700_000_000, label: 'Before the gate', order: 1 });
    steps(60);
    clock += 60;
    slots.engine.save('b');
    expect(slots.engine.info('b')).toMatchObject({ play_time: expect.closeTo(3, 9), saved_at: 1_700_000_060, label: '', order: 2 });
    slots.engine.save('a');
    expect(slots.engine.info('a')!.order).toBe(3);
    // A new run starts its play time at 0; loading a slot continues the slot's.
    // (A load happens at the end of its frame: the clock starts there.)
    kernel.requestScene('other', { newRun: true });
    steps(1);
    expect(slots.engine.playTime()).toBe(0);
    steps(30);
    expect(slots.engine.playTime()).toBeCloseTo(0.5, 9);
    slots.engine.load('b');
    steps(1);
    expect(slots.engine.playTime()).toBeCloseTo(3, 9);
    // A checkpoint retry keeps counting; snapshots keep the clock.
    slots.engine.checkpoint();
    steps(30);
    const snapshot = kernel.snapshot();
    slots.engine.restoreCheckpoint();
    steps(1);
    expect(slots.engine.playTime()).toBeCloseTo(3.5, 9);
    kernel.restore(snapshot);
    expect(slots.engine.playTime()).toBeCloseTo(3.5, 9);
    steps(30);
    expect(slots.engine.playTime()).toBeCloseTo(4, 9);
    // A slot stored without info (an older build) shows its scene.
    store.set(SLOT_PREFIX + 'old', stringify({ version: 1, scene: 'other', seed: null, resources: {}, modifiers: {}, entities: {} }));
    expect(slots.engine.info('old')).toEqual({ scene: 'other', play_time: 0, saved_at: null, label: '', order: 0 });
    expect(code(() => slots.engine.save('c', 3))).toBe('PP3950');
  });

  it('drops a pending load when the game loads another scene in the same frame', () => {
    const { kernel, save: slots } = game();
    kernel.resource('run')['gold'] = 5;
    slots.save('x');
    kernel.resource('run')['gold'] = 1;
    slots.load('x');
    kernel.requestScene('other');
    kernel.step(1 / 60);
    expect(kernel.scene?.id).toBe('other');
    expect(kernel.resource('run')['gold']).toBe(1);
  });

  it('returns to a checkpoint', () => {
    const { kernel, save: slots } = game();
    expect(slots.restoreCheckpoint()).toBe(false);
    kernel.resource('run')['level'] = 3;
    slots.checkpoint();
    kernel.resource('run')['level'] = 9;
    expect(slots.restoreCheckpoint()).toBe(true);
    kernel.step(1 / 60);
    expect(kernel.resource('run')['level']).toBe(3);
  });

  it('saves and loads registered sections; reserved and repeated keys are refused', () => {
    let facts: unknown = { met: false };
    let registered = false;
    const story: KernelPlugin = {
      id: 'story',
      install(kernel) {
        kernel.observeScenes({
          loading: () => {
            const service = kernel.tryService(SAVE_SERVICE);
            if (service === undefined || registered) return;
            registered = true;
            service.register({ key: 'facts', save: () => facts as never, load: (data) => { facts = data ?? { met: false }; } });
            expect(code(() => service.register({ key: 'facts', save: () => null, load: () => {} }))).toBe('PP3958');
            expect(code(() => service.register({ key: 'resources', save: () => null, load: () => {} }))).toBe('PP3958');
            expect(code(() => service.register({ key: 'environment', save: () => null, load: () => {} }))).toBe('PP3958');
          },
        });
      },
    };
    const { kernel, save: slots, store } = game({ plugins: [story] });
    facts = { met: true };
    slots.save('s');
    expect(parseStored(store.get(`${SLOT_PREFIX}s`)!, 'slot', '')['facts']).toEqual({ met: true });
    facts = { met: false };
    slots.load('s');
    kernel.step(1 / 60);
    expect(facts).toEqual({ met: true });
  });

  it('keeps its baseline and checkpoint across a kernel snapshot', () => {
    const { kernel, save: slots, store } = game();
    kernel.resource('run')['level'] = 4;
    slots.checkpoint();
    const snapshot = kernel.snapshot();
    kernel.resource('run')['level'] = 1;
    kernel.restore(snapshot);
    kernel.world.require(placed(kernel, 'crate')).components.get('health')!['current'] = 2;
    slots.save('after');
    expect(parseStored(store.get(`${SLOT_PREFIX}after`)!, 'slot', '').entities).toEqual({ crate: { health: { current: 2 } } });
    expect(slots.restoreCheckpoint()).toBe(true);
    kernel.step(1 / 60);
    expect(kernel.resource('run')['level']).toBe(4);
  });

  it('refuses a save naming an entity the scene no longer places', () => {
    const { kernel, save: slots, store } = game();
    const doc: SaveDocument = { version: 1, scene: 'main', seed: null, resources: {}, modifiers: {}, entities: { ghost: { health: { current: 1 } } } };
    store.set(`${SLOT_PREFIX}old`, stringify(doc));
    slots.load('old');
    expect(code(() => kernel.step(1 / 60))).toBe('PP3957');
  });
});

describe('migrations', () => {
  const rename: MigrationStep = {
    from: 1, to: 2, name: 'rename_coins',
    run: (s) => {
      const run = s.resources['run'] as Record<string, unknown>;
      run['gold'] = run['coins'];
      delete run['coins'];
    },
  };

  it('migrates an old slot on load', () => {
    const store = memoryStore();
    const old: SaveDocument = { version: 1, scene: 'main', seed: null, resources: { run: { coins: 30 } }, modifiers: {}, entities: {} };
    store.set(`${SLOT_PREFIX}auto`, stringify(old));
    const { kernel, save: slots } = game({ store, saveVersion: 2, migrations: [rename] });
    expect(slots.load('auto')).toBe(true);
    kernel.step(1 / 60);
    expect(kernel.resource('run')['gold']).toBe(30);
  });

  it('names a missing step, a newer save and a broken chain', () => {
    const doc = (): SaveDocument => ({ version: 1, scene: 'main', seed: null, resources: { run: { coins: 1 } }, modifiers: {}, entities: {} });
    expect(code(() => migrateDocument(doc(), 3, [rename], 'slot'))).toBe('PP3952');
    expect(code(() => migrateDocument({ ...doc(), version: 4 }, 3, [], 'slot'))).toBe('PP3953');
    expect(code(() => migrateDocument(doc(), 2, [rename, { ...rename, name: 'again' }], 'slot'))).toBe('PP3951');
    expect(code(() => migrateDocument(doc(), 2, [{ ...rename, to: 1 }], 'slot'))).toBe('PP3951');
    expect(code(() => migrateDocument(doc(), 2, [{ ...rename, to: 5 }], 'slot'))).toBe('PP3951');
    expect(migrateDocument(doc(), 2, [rename], 'slot')).toMatchObject({ version: 2, resources: { run: { gold: 1 } } });
  });
});

describe('open worlds (streamed placements)', () => {
  // Cells of 100 m, radius 150; the camera starts at the origin.
  const OPEN = {
    'prefabs/eye.prefab.json': { components: { camera: {} } },
    'prefabs/crate.prefab.json': { components: { health: {} }, behaviors: { counter: {} } },
    'scenes/ow/scene.json': { entities: [] },
    'scenes/ow/world.json': { cell_size: 100, streaming: { radius: 150 } },
    'scenes/ow/regions/a/region.json': {},
    'scenes/ow/regions/a/entities/eye.json': { prefab: 'eye', at: [0, 5, 0], always_loaded: true },
    'scenes/ow/regions/a/entities/near.json': { prefab: 'crate', at: [50, 0, 50] },
    'scenes/ow/regions/b/region.json': {},
    'scenes/ow/regions/b/entities/far.json': { prefab: 'crate', at: [450, 0, 20] },
    'scenes/ow/regions/b/entities/doomed.json': { prefab: 'crate', at: [460, 0, 30] },
  };

  function openWorld(store: KeyValueStore = memoryStore()): Game {
    const project = loadProject(files(OPEN));
    expect(project.diagnostics).toEqual([]);
    const slots = save({ seed: () => null });
    const base = definition();
    const kernel = new Kernel({
      project,
      game: { ...base, components: [...base.components, { id: 'camera', schema: {} }] },
      // As in a runtime: streaming is core, before the game's save plugin.
      plugins: [persistence({ store, saveVersion: 1, migrations: () => [] }), streaming(), slots],
    });
    kernel.start('ow');
    return { kernel, save: slots.engine, store };
  }

  const live = (kernel: Kernel, id: string): EntityId | undefined => [...kernel.world.live()].find((r) => r.alive && r.placedId === id)?.id;
  const health = (kernel: Kernel, id: string): Record<string, unknown> => kernel.world.require(live(kernel, id)!).components.get('health')!;

  it('saves streamed-out placements from their held state, and destroyed ones as destroyed', () => {
    const { kernel, save: slots, store } = openWorld();
    expect(live(kernel, 'far')).toBeUndefined();
    health(kernel, 'near')['current'] = 4;
    kernel.world.require(live(kernel, 'eye')!).transform.position = new Vec3(450, 5, 20);
    kernel.step(1 / 60);
    expect([live(kernel, 'near'), live(kernel, 'far') !== undefined]).toEqual([undefined, true]);
    health(kernel, 'far')['current'] = 2;
    kernel.destroy(live(kernel, 'doomed')!);
    kernel.step(1 / 60);
    slots.save('w');
    const doc = parseStored(store.get(`${SLOT_PREFIX}w`)!, 'slot', '');
    expect(doc.entities).toEqual({
      eye: { transform: { position: [450, 5, 20], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      near: { health: { current: 4 } },
      far: { health: { current: 2 } },
      doomed: { destroyed: true },
    });
  });

  it('applies entries of placements outside the loaded world when they stream in', () => {
    const store = memoryStore();
    const first = openWorld(store);
    health(first.kernel, 'near')['current'] = 4;
    first.kernel.world.require(live(first.kernel, 'eye')!).transform.position = new Vec3(450, 5, 20);
    first.kernel.step(1 / 60);
    health(first.kernel, 'far')['current'] = 2;
    first.kernel.destroy(live(first.kernel, 'doomed')!);
    first.kernel.step(1 / 60);
    first.save.save('w');
    const saved = parseStored(store.get(`${SLOT_PREFIX}w`)!, 'slot', '').entities;

    const { kernel, save: slots } = openWorld(store);
    expect(slots.load('w')).toBe(true);
    kernel.step(1 / 60);
    // The scene loads with the eye at the origin; its entry moves it, and the next pass streams around it:
    // near (whose entry applied at load) goes out holding it, far and doomed get theirs as they come in.
    const world = kernel.service(STREAMING_SERVICE).current()!;
    expect(live(kernel, 'near')).toBeUndefined();
    expect(world.held().get('near')!.components['health']!['current']).toBe(4);
    expect(health(kernel, 'far')['current']).toBe(2);
    expect(live(kernel, 'doomed')).toBeUndefined();
    expect(world.destroyed().has('doomed')).toBe(true);
    expect(slots.capture().entities).toEqual(saved);
  });

  it('keeps a waiting entry in later saves until its placement streams in', () => {
    const store = memoryStore();
    const doc: SaveDocument = {
      version: 1, scene: 'ow', seed: null, resources: {}, modifiers: {}, entities: { far: { health: { current: 7 } } },
    };
    store.set(`${SLOT_PREFIX}w`, stringify(doc));
    const { kernel, save: slots } = openWorld(store);
    slots.load('w');
    kernel.step(1 / 60);
    expect(live(kernel, 'far')).toBeUndefined();
    expect(slots.capture().entities).toEqual({ far: { health: { current: 7 } } });
    kernel.world.require(live(kernel, 'eye')!).transform.position = new Vec3(450, 5, 20);
    kernel.step(1 / 60);
    expect(health(kernel, 'far')['current']).toBe(7);
    health(kernel, 'far')['current'] = 3;
    expect(slots.capture().entities).toMatchObject({ far: { health: { current: 3 } } });
  });
});
