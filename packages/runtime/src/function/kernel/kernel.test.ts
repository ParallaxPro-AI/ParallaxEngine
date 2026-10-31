import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../core/index.js';
import type { EntityId, ProjectFiles } from '../../core/index.js';
import { loadProject } from '../../resource/index.js';
import { componentEntity } from './definitions.js';
import type { BehaviorDef, Condition, EventDef, GameDefinition, Handler, KernelPlugin, LogicInstance, SystemDef } from './definitions.js';
import { Kernel, KERNEL_EVENTS, serviceKey } from './kernel.js';
import type { SceneRequest } from './kernel.js';
import { t } from './schema.js';
import type { Schema } from './schema.js';

// ── Test helpers ───────────────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** A log every hook writes to, so tests can assert exact order. */
type Log = string[];

function behavior(id: string, log: Log, extra: Partial<BehaviorDef> & { methods?: Record<string, (this: LogicInstance, ...a: never[]) => void> } = {}): BehaviorDef {
  return {
    id,
    params: {},
    state: {},
    requires: [],
    handlers: [],
    ...extra,
    create: () => ({
      start(this: LogicInstance) { log.push(`${id}.start(${String(this['entity'])})`); },
      update(this: LogicInstance) { log.push(`${id}.update(${String(this['entity'])})`); },
      end(this: LogicInstance) { log.push(`${id}.end(${String(this['entity'])})`); },
      ...extra.methods,
    }),
  };
}

function system(id: string, log: Log, extra: Partial<SystemDef> & { methods?: Record<string, (...a: never[]) => void> } = {}): SystemDef {
  return {
    id,
    scenes: [],
    handlers: [],
    ...extra,
    create: () => ({
      start: () => log.push(`${id}.start`),
      update: () => log.push(`${id}.update`),
      ...extra.methods,
    }),
  };
}

function game(overrides: Partial<GameDefinition>): GameDefinition {
  return { components: [], resources: [], events: [], behaviors: [], systems: [], ...overrides };
}

function kernel(data: Record<string, unknown>, def: GameDefinition, scene = 'main', request: SceneRequest = {}, context: unknown = {}): Kernel {
  const project = loadProject(files(data));
  expect(project.diagnostics).toEqual([]);
  const k = new Kernel({ project, game: def, context });
  k.start(scene, request);
  return k;
}

const HEALTH: Schema = { current: t.number({ default: 10 }), max: t.number({ default: 10, min: 1 }) };
const on = (event: EventDef, method: string, extra: Partial<Handler> = {}): Handler => ({ event, method, ...extra });

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('instantiation', () => {
  it('builds components from prefab data, overrides and schema defaults', () => {
    const k = kernel({
      'prefabs/brick.prefab.json': { components: { health: { max: 3 } }, tags: ['brick'] },
      'scenes/main/scene.json': { entities: [
        { prefab: 'brick', at: [1, 2] },
        { prefab: 'brick', at: [3, 4], components: { health: { current: 1 } }, tags: ['cracked'] },
      ] },
    }, game({ components: [{ id: 'health', schema: HEALTH }] }));

    const rows = k.world.query(['health'], { tagged: ['brick'] });
    expect(rows.map(([, h]) => h)).toEqual([{ current: 10, max: 3 }, { current: 1, max: 3 }]);
    expect(k.world.query(['health'], { tagged: ['cracked'] })).toHaveLength(1);
    expect(k.world.query(['health'], { without: ['cracked'] })).toHaveLength(1);
  });

  it('takes 2D draw order from the prefab z and expands placement grids', () => {
    const k = kernel({
      'prefabs/coin.prefab.json': { z: 2 },
      'scenes/main/scene.json': { entities: [{ prefab: 'coin', grid: { cols: 3, rows: 2, spacing: [1.5, 1], origin: [8, 3] } }] },
    }, game({}));
    const positions = [...k.world.live()].map((r) => [r.transform.position.x, r.transform.position.y, r.transform.position.z]);
    expect(positions).toEqual([[8, 3, 2], [9.5, 3, 2], [11, 3, 2], [8, 2, 2], [9.5, 2, 2], [11, 2, 2]]);
  });

  it('gives behaviors their params and state, and checks requires', () => {
    const seen: unknown[] = [];
    const def = behavior('mover', [], {
      params: { speed: t.number({ default: 1 }) },
      state: { travelled: t.number({ default: 0 }) },
      requires: ['health'],
      methods: { start(this: LogicInstance) { seen.push([this['speed'], this['travelled']]); } },
    });
    kernel({
      'prefabs/p.prefab.json': { components: { health: {} }, behaviors: { mover: { speed: 4 } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'p', params: { mover: { speed: 9 } } }] },
    }, game({ components: [{ id: 'health', schema: HEALTH }], behaviors: [def] }));
    expect(seen).toEqual([[9, 0]]);

    expect(() => kernel({
      'prefabs/p.prefab.json': { behaviors: { mover: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'p' }] },
    }, game({ components: [{ id: 'health', schema: HEALTH }], behaviors: [def] }))).toThrow(/PP3103/);
  });

  it('rejects unknown components, unknown fields and out-of-range values', () => {
    const scene = (components: unknown): Record<string, unknown> => ({
      'prefabs/p.prefab.json': { components },
      'scenes/main/scene.json': { entities: [{ prefab: 'p' }] },
    });
    const def = game({ components: [{ id: 'health', schema: HEALTH }] });
    expect(() => kernel(scene({ helth: {} }), def)).toThrow(/PP2050[\s\S]*Did you mean "health"/);
    expect(() => kernel(scene({ health: { maxx: 1 } }), def)).toThrow(/PP4104/);
    expect(() => kernel(scene({ health: { max: 0 } }), def)).toThrow(/PP4103/);
  });

  it('parents children and composes world transforms', () => {
    const k = kernel({
      'prefabs/turret.prefab.json': {},
      'prefabs/tank.prefab.json': { children: [{ name: 'turret', prefab: 'turret', at: [0, 1, 0] }] },
      'scenes/main/scene.json': { entities: [{ prefab: 'tank', at: [10, 0, 0], rotation: [0, 90, 0] }] },
    }, game({}));
    const [tank, turret] = [...k.world.live()];
    expect(turret!.childName).toBe('turret');
    expect(turret!.parent).toBe(tank!.id);
    expect(turret!.transform.worldPosition().is_close(new Vec3(10, 1, 0))).toBe(true);
    turret!.transform.position = new Vec3(0, 1, 2);
    // Yaw 90° turns local +z toward world +x.
    expect(turret!.transform.worldPosition().is_close(new Vec3(12, 1, 0))).toBe(true);
  });

  it('resolves entity references to placed ids once the scene exists', () => {
    const k = kernel({
      'prefabs/cam.prefab.json': { components: { camera: { follow: 'hero' } } },
      'prefabs/hero.prefab.json': {},
      'scenes/main/scene.json': { entities: [{ prefab: 'cam' }, { prefab: 'hero', id: 'hero' }] },
    }, game({ components: [{ id: 'camera', schema: { follow: { type: { kind: 'entity' }, default: null } } }] }));
    const [[, camera]] = k.world.query(['camera']) as [[EntityId, { follow: unknown }]];
    const hero = [...k.world.live()].find((r) => r.placedId === 'hero')!;
    expect(camera.follow).toBe(hero.id);
  });
});

describe('frame order', () => {
  it('runs systems in list order, then behaviors in spawn order, every phase', () => {
    const log: Log = [];
    const k = kernel({
      'prefabs/a.prefab.json': { behaviors: { first: {}, second: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'a' }, { prefab: 'a' }] },
    }, game({ behaviors: [behavior('first', log), behavior('second', log)], systems: [system('s1', log), system('s2', log)] }));
    const [e1, e2] = [...k.world.live()].map((r) => r.id);
    expect(log).toEqual(['s1.start', 's2.start', `first.start(${e1})`, `second.start(${e1})`, `first.start(${e2})`, `second.start(${e2})`]);
    log.length = 0;
    k.step(1 / 60);
    expect(log).toEqual(['s1.update', 's2.update', `first.update(${e1})`, `second.update(${e1})`, `first.update(${e2})`, `second.update(${e2})`]);
  });

  it('runs fixed steps at the fixed rate and drops a runaway backlog', () => {
    let fixedSteps = 0;
    const k = kernel({ 'scenes/main/scene.json': {} },
      game({ systems: [system('physicsish', [], { methods: { fixed_update: () => { fixedSteps++; } } })] }));
    k.step(1 / 30);
    expect(fixedSteps).toBe(2);
    k.step(10); // a stalled tab: capped at 5, not 600
    expect(fixedSteps).toBe(7);
  });

  it('freezes game time and logic, except systems that run while frozen', () => {
    const log: Log = [];
    const k = kernel({ 'scenes/main/scene.json': {} },
      game({ systems: [system('game', log), system('menu_bg', log, { runsWhileFrozen: true })] }));
    log.length = 0;
    k.setFrozen(true);
    k.step(0.5);
    expect(log).toEqual(['menu_bg.update']);
    expect(k.time.now).toBe(0);
    k.setFrozen(false);
    k.step(0.5);
    expect(k.time.now).toBe(0.5);
  });
});

describe('destroy', () => {
  it('removes from queries at once, ends at phase end, takes children along', () => {
    const log: Log = [];
    let k!: Kernel;
    const killer = system('killer', log, {
      methods: {
        update: () => {
          const parent = k.world.query(['health'])[0]![0];
          k.destroy(parent);
          log.push(`rows after destroy: ${k.world.query(['health']).length}`);
        },
      },
    });
    k = kernel({
      'prefabs/part.prefab.json': { behaviors: { tracker: {} } },
      'prefabs/ship.prefab.json': { components: { health: {} }, behaviors: { tracker: {} }, children: [{ name: 'gun', prefab: 'part' }] },
      'scenes/main/scene.json': { entities: [{ prefab: 'ship' }] },
    }, game({ components: [{ id: 'health', schema: HEALTH }], behaviors: [behavior('tracker', log)], systems: [killer] }));
    const [ship, gun] = [...k.world.live()].map((r) => r.id);
    log.length = 0;
    k.step(1 / 60);
    expect(log).toEqual(['rows after destroy: 0', `tracker.end(${ship})`, `tracker.end(${gun})`]);
    expect(k.world.count).toBe(0);
  });
});

describe('events', () => {
  const Hit: EventDef = { id: 'hit', target: 'entity' };
  const Scored: EventDef = { id: 'scored' };

  it('delivers at phase end in emission order: systems first, targeted events only to their entity', () => {
    const log: Log = [];
    let k!: Kernel;
    const ears = behavior('ears', log, {
      handlers: [on(Hit, 'hit'), on(Scored, 'scored')],
      methods: {
        hit(this: LogicInstance) { log.push(`ears.hit(${String(this['entity'])})`); },
        scored(this: LogicInstance) { log.push(`ears.scored(${String(this['entity'])})`); },
      },
    });
    const referee = system('referee', log, {
      handlers: [on(Hit, 'hit'), on(Scored, 'scored')],
      methods: {
        update: () => {
          const [, second] = [...k.world.live()];
          k.emit(Hit, { entity: second!.id });
          log.push('emitted');
          k.emit(Scored, {});
        },
        hit: () => log.push('referee.hit'),
        scored: () => log.push('referee.scored'),
      },
    });
    k = kernel({
      'prefabs/a.prefab.json': { behaviors: { ears: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'a' }, { prefab: 'a' }] },
    }, game({ events: [Hit, Scored], behaviors: [ears], systems: [referee] }));
    const [e1, e2] = [...k.world.live()].map((r) => r.id);
    log.length = 0;
    k.step(1 / 60);
    expect(log.filter((l) => !l.includes('update'))).toEqual([
      'emitted', 'referee.hit', `ears.hit(${e2})`, 'referee.scored', `ears.scored(${e1})`, `ears.scored(${e2})`,
    ]);
  });

  it('gates handlers by the unit\'s when, with always= and per-handler filters', () => {
    const log: Log = [];
    let live = false;
    const isLive: Condition = () => live;
    const Started: EventDef = { id: 'round_started' };
    let k!: Kernel;
    const round = system('round', log, {
      when: isLive,
      handlers: [
        on(Started, 'begin', { always: true }),
        on(Scored, 'scored'),
        on(Hit, 'big_hit', { where: (e) => (e['damage'] as number) > 5 }),
      ],
      methods: {
        begin: () => { live = true; log.push('begin'); },
        scored: () => log.push('scored'),
        big_hit: () => log.push('big_hit'),
        update: () => log.push('update'),
      },
    });
    k = kernel({ 'scenes/main/scene.json': {} }, game({ events: [Started, Scored, Hit], systems: [round] }));
    log.length = 0;
    k.emit(Scored, {});
    k.step(1 / 60);
    expect(log).toEqual([]);
    k.emit(Started, {});
    k.emit(Scored, {});
    k.emit(Hit, { damage: 2 });
    k.emit(Hit, { damage: 9 });
    k.step(1 / 60);
    expect(log).toEqual(['begin', 'scored', 'big_hit', 'update']);
  });

  it('stops a later handler in the same frame once an earlier one ends the phase', () => {
    const log: Log = [];
    let over = false;
    const Ended: EventDef = { id: 'run_ended' };
    const banker = system('banker', log, {
      when: () => !over,
      handlers: [on(Ended, 'bank')],
      methods: { bank: () => { over = true; log.push('bank'); } },
    });
    const k = kernel({ 'scenes/main/scene.json': {} }, game({ events: [Ended], systems: [banker] }));
    log.length = 0;
    k.emit(Ended, {});
    k.emit(Ended, {});
    k.step(1 / 60);
    expect(log).toEqual(['bank']);
  });

  it('spawns with name, owner and runtime values set before behaviors start', () => {
    const log: Log = [];
    let k: Kernel | undefined;
    const homing = behavior('homing', log, {
      params: { target: { type: { kind: 'entity' } , default: null }, speed: t.number({ default: 1 }) },
      methods: {
        start(this: LogicInstance) {
          const record = k!.world.get(this['entity'] as EntityId)!;
          log.push(`start ${record.name} owner=${record.owner} target=${String(this['target'])} speed=${String(this['speed'])}`);
          log.push(`health ${JSON.stringify(record.components.get('health'))}`);
        },
      },
    });
    k = kernel({
      'prefabs/missile.prefab.json': { behaviors: { homing: {} } },
      'prefabs/p.prefab.json': {},
      'scenes/main/scene.json': { entities: [{ prefab: 'p', id: 'boss' }] },
    }, game({ components: [{ id: 'health', schema: HEALTH }], behaviors: [homing] }));
    const boss = [...k.world.live()][0]!;
    const missile = k.spawn('missile', {}, {
      name: 'm1', owner: 1, components: { health: { current: 2 } }, params: { homing: { target: boss.id, speed: 9 } },
    });
    expect(log).toEqual([`start m1 owner=1 target=${boss.id} speed=9`, 'health {"current":2,"max":10}']);
    expect(missile.name).toBe('m1');
    expect(() => k!.spawn('missile', {}, { components: { health: { hp: 1 } } })).toThrow(/PP4104/);
  });

  it('decode union fields by the first alternative that accepts the value', () => {
    const FOLLOW = { follow: { type: { kind: 'union' as const, of: [{ kind: 'entity' as const }, { kind: 'list' as const, of: { kind: 'entity' as const } }] }, default: null } };
    const k = kernel({
      'prefabs/p.prefab.json': {},
      'prefabs/cam.prefab.json': { components: { cam: {} } },
      'scenes/main/scene.json': { entities: [
        { prefab: 'p', id: 'a' }, { prefab: 'p', id: 'b' },
        { prefab: 'cam', components: { cam: { follow: ['a', 'b'] } } },
        { prefab: 'cam', components: { cam: { follow: 'a' } } },
      ] },
    }, game({ components: [{ id: 'cam', schema: FOLLOW }] }));
    const [a, b, many, one] = [...k.world.live()];
    expect(many!.components.get('cam')!['follow']).toEqual([a!.id, b!.id]);
    expect(one!.components.get('cam')!['follow']).toBe(a!.id);
    const restored = new Kernel({ project: k.project, game: game({ components: [{ id: 'cam', schema: FOLLOW }] }) });
    restored.restore(k.snapshot());
    expect(restored.world.get(many!.id)!.components.get('cam')!['follow']).toEqual([a!.id, b!.id]);
    expect(() => kernel({ 'prefabs/cam.prefab.json': { components: { cam: { follow: 3 } } }, 'scenes/main/scene.json': { entities: [{ prefab: 'cam' }] } },
      game({ components: [{ id: 'cam', schema: FOLLOW }] }))).toThrow(/PP4102[\s\S]*one of: entity, list/);
  });

  it('take the prefab\'s scale unless the instance gives one', () => {
    const k = kernel({
      'prefabs/rock.prefab.json': { scale: 2 },
      'scenes/main/scene.json': { entities: [{ prefab: 'rock' }, { prefab: 'rock', scale: [1, 3, 1] }] },
    }, game({}));
    expect([...k.world.live()].map((r) => [r.transform.scale.x, r.transform.scale.y])).toEqual([[2, 2], [1, 3]]);
  });

  it('resolve placed ids in behavior params, and keep destroyed entities readable until teardown', () => {
    const log: Log = [];
    const follow = behavior('follow', log, { params: { target: { type: { kind: 'entity' } } } });
    const k = kernel({
      'prefabs/p.prefab.json': {},
      'prefabs/cam.prefab.json': { behaviors: { follow: {} } },
      'scenes/main/scene.json': { entities: [{ prefab: 'p', id: 'hero' }, { prefab: 'cam', params: { follow: { target: 'hero' } } }] },
    }, game({ behaviors: [follow] }));
    const [hero, cam] = [...k.world.live()];
    expect(cam!.behaviors[0]!.instance['target']).toBe(hero!.id);
    k.destroy(hero!.id);
    expect(k.world.get(hero!.id)).toBeUndefined();
    expect(k.world.peek(hero!.id)).toBe(hero);
    k.step(1 / 60);
    expect(k.world.peek(hero!.id)).toBeUndefined();
  });

  it('emits spawned and destroyed for gameplay spawns', () => {
    const seen: string[] = [];
    const watcher = system('watcher', [], {
      handlers: [on(KERNEL_EVENTS.spawned, 'spawned'), on(KERNEL_EVENTS.destroyed, 'destroyed')],
      methods: {
        spawned: (_ctx: never, e: never) => seen.push(`spawned ${String((e as { entity: unknown }).entity)}`),
        destroyed: (_ctx: never, e: never) => seen.push(`destroyed ${String((e as { entity: unknown }).entity)}`),
      },
    });
    const k = kernel({ 'prefabs/p.prefab.json': {}, 'scenes/main/scene.json': {} }, game({ systems: [watcher] }));
    const spawned = k.spawn('p', { at: [1, 1] });
    k.destroy(spawned.id);
    k.step(1 / 60);
    expect(seen).toEqual([`spawned ${spawned.id}`, `destroyed ${spawned.id}`]);
  });
});

describe('the frame clock', () => {
  it('reports how far the frame is between fixed steps (alpha), for render interpolation', () => {
    const k = kernel({ 'scenes/main/scene.json': {} }, game({}));
    expect(k.time.fixedStep).toBeCloseTo(1 / 60);
    k.step(1 / 120);
    expect(k.time.alpha).toBeCloseTo(0.5);
    k.step(1 / 120);
    expect(k.time.alpha).toBeCloseTo(0, 6);
  });
});

describe('timers', () => {
  it('fires in game time and dies with its owner', () => {
    const log: Log = [];
    const k = kernel({ 'prefabs/p.prefab.json': {}, 'scenes/main/scene.json': {} }, game({}));
    const owner = k.spawn('p');
    k.after({ kind: 'game' }, 0.1, () => log.push('once'));
    k.every({ kind: 'game' }, 0.05, () => log.push('tick'));
    k.after({ kind: 'entity', id: owner.id }, 0.05, () => log.push('owned'));
    k.destroy(owner.id);
    for (let i = 0; i < 6; i++) k.step(1 / 60);
    // At 0.1 s "once" and the second "tick" are both due: ties run in scheduling order.
    expect(log).toEqual(['tick', 'once', 'tick']);
    expect(() => k.every({ kind: 'game' }, 0, () => {})).toThrow(/PP3050/);
  });
});

describe('scenes and resources', () => {
  const RUN = { id: 'run', schema: { level: t.int({ default: 1 }), score: t.int({ default: 0 }), best: t.int({ default: 0, keep: 'profile' as const }) } };
  const BOARD = { id: 'board', keep: 'scene' as const, schema: { moves: t.int({ default: 0 }) } };
  const DATA = {
    'prefabs/p.prefab.json': {},
    'scenes/title/scene.json': { entities: [{ prefab: 'p' }] },
    'scenes/level/scene.json': { tags: ['level'], init: { run: { level: 7 } }, entities: [{ prefab: 'p' }, { prefab: 'p' }] },
  };

  it('scopes systems to scenes or scene tags and swaps entities at frame end', () => {
    const log: Log = [];
    const def = game({
      resources: [RUN, BOARD],
      systems: [system('everywhere', log), system('in_levels', log, { scenes: [{ tag: 'level' }] })],
    });
    const k = kernel(DATA, def, 'title');
    expect(log).toEqual(['everywhere.start']);
    k.requestScene('level');
    expect(k.world.count).toBe(1);
    log.length = 0;
    k.step(1 / 60);
    // Systems hold no fields: every system in scope starts fresh with each scene.
    expect(log).toEqual(['everywhere.update', 'everywhere.start', 'in_levels.start']);
    expect(k.scene?.id).toBe('level');
    expect(k.world.count).toBe(2);
    log.length = 0;
    k.step(1 / 60);
    expect(log).toEqual(['everywhere.update', 'in_levels.update']);
  });

  it('applies keep lifetimes, init, and the scene\'s own init when opened directly', () => {
    const k = kernel(DATA, game({ resources: [RUN, BOARD] }), 'level');
    expect(k.resource('run')).toEqual({ level: 7, score: 0, best: 0 });
    Object.assign(k.resource('run'), { score: 50, best: 50 });
    k.resource('board')['moves'] = 3;

    k.requestScene('level', { init: { run: { level: 2 } } });
    k.step(1 / 60);
    expect(k.resource('board')['moves']).toBe(0);
    expect(k.resource('run')).toEqual({ level: 2, score: 50, best: 50 });

    k.requestScene('title', { newRun: true });
    k.step(1 / 60);
    expect(k.resource('run')).toEqual({ level: 1, score: 0, best: 50 });
  });

  it('keeps game time counting across scene loads; the scene clock restarts', () => {
    const k = kernel(DATA, game({ resources: [RUN] }), 'title');
    k.step(0.5);
    expect(k.time.now).toBe(0.5);
    k.requestScene('level', { newRun: true });
    k.step(0.25);
    expect(k.time.now).toBe(0.75);
    expect(k.time.sceneStart).toBe(0.75);
    k.step(0.25);
    expect(k.time.now - k.time.sceneStart).toBe(0.25);
  });

  it('emits scene_loaded after every start, with the new_run flag', () => {
    const log: Log = [];
    const def = game({
      behaviors: [behavior('b', log)],
      systems: [system('listener', log, {
        handlers: [on(KERNEL_EVENTS.sceneLoaded, 'loaded')],
        methods: { loaded: (_c: never, e: never) => log.push(`loaded ${JSON.stringify(e)}`) },
      })],
    });
    kernel({ 'prefabs/p.prefab.json': { behaviors: { b: {} } }, 'scenes/main/scene.json': { entities: [{ prefab: 'p' }] } },
      def, 'main', { newRun: true });
    expect(log.at(-1)).toBe('loaded {"scene":"main","new_run":true}');
    expect(log.at(-2)).toMatch(/^b\.start/);
  });

  it('ends every system timer with the scene; unscoped systems start them again', () => {
    const log: Log = [];
    let k: Kernel | undefined;
    const ticker = system('ticker', log, {
      methods: { start: () => { k?.every({ kind: 'system', system: ticker }, 0.05, () => log.push('tick')); } },
    });
    k = kernel(DATA, game({ resources: [RUN], systems: [ticker] }), 'title');
    k.every({ kind: 'system', system: ticker }, 0.05, () => log.push('tick'));
    k.requestScene('level');
    k.step(1 / 60);
    for (let i = 0; i < 3; i++) k.step(1 / 60);
    expect(log.filter((l) => l === 'tick')).toHaveLength(1);
  });

  it('passes the request (with its seed) to scene observers before anything of the scene exists', () => {
    const k = kernel(DATA, game({ resources: [RUN] }), 'title');
    const seen: unknown[] = [];
    k.observeScenes({ loading: (scene, request) => seen.push([scene.id, request.seed, k.world.count, k.resource('run')['level']]) });
    k.requestScene('level', { seed: 42 });
    k.step(1 / 60);
    expect(seen).toEqual([['level', 42, 0, 7]]);
  });

  it('resets modifiers along with the fields a reset restores', () => {
    const SCORE = { id: 'score', schema: { mult: t.number({ default: 1, modifiable: true }) } };
    const k = kernel(DATA, game({ resources: [SCORE] }), 'title');
    k.modifyResource('score', 'mult', { add: 1, stack: true });
    expect(k.resource('score')['mult']).toBe(2);
    k.requestScene('title', { newRun: true });
    k.step(1 / 60);
    expect(k.resource('score')['mult']).toBe(1);
    k.modifyResource('score', 'mult', { add: 2, key: 'x' });
    k.resetResource('score');
    expect(k.resource('score')['mult']).toBe(1);
    k.resource('score')['mult'] = 3;
    expect(k.resource('score')['mult']).toBe(3);
  });

  it('suggests the closest scene for an unknown one', () => {
    expect(() => kernel(DATA, game({}), 'levle')).toThrow(/PP2045[\s\S]*Did you mean "level"/);
  });
});

describe('plugins', () => {
  it('contribute definitions first, run their systems first, and install against the kernel', () => {
    const log: Log = [];
    const pushes: unknown[] = [];
    const physics: KernelPlugin = {
      id: 'physics2d',
      components: [{
        id: 'rigidbody',
        schema: { mass: t.number({ default: 1 }) },
        methods: {
          impulse(this: Record<string, unknown>, amount: number) { pushes.push([componentEntity(this), this['mass'], amount]); },
        },
      }],
      systems: [system('physics_step', log)],
      install: (k) => { k.addHook('physics', () => log.push('physics hook')); },
    };
    const project = loadProject(files({
      'prefabs/ball.prefab.json': { components: { rigidbody: { mass: 2 } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'ball' }] },
    }));
    const k = new Kernel({ project, game: game({ systems: [system('game_rules', log)] }), plugins: [physics] });
    k.start('main');
    expect(log).toEqual(['physics_step.start', 'game_rules.start']);

    const [[ball, body]] = k.world.query(['rigidbody']) as [[EntityId, { impulse(n: number): void }]];
    body.impulse(5);
    expect(pushes).toEqual([[ball, 2, 5]]);
    expect(Object.keys(body)).toEqual(['mass']);

    log.length = 0;
    k.step(1 / 60);
    expect(log).toEqual(['physics hook', 'physics_step.update', 'game_rules.update']);
  });

  it('accept required fields given at runtime (spawn components, addComponent)', () => {
    const PLACE = { id: 'place', schema: { cell: t.vec2(), tag: t.string({ default: 'x' }) } };
    const k = kernel({ 'prefabs/p.prefab.json': {}, 'scenes/main/scene.json': { entities: [{ prefab: 'p' }] } }, game({ components: [PLACE] }));
    const spawned = k.spawn('p', {}, { components: { place: { cell: 'c' } } });
    expect(spawned.components.get('place')).toEqual({ cell: 'c', tag: 'x' });
    const [e] = [...k.world.live()];
    expect(k.addComponent(e!.id, 'place', { cell: 'd' })).toEqual({ cell: 'd', tag: 'x' });
    expect(() => k.addComponent(e!.id, 'place', {})).toThrow(/PP4105/);
  });

  it('let spawn values supply required fields the prefab leaves out, for components and params', () => {
    const BOARD = { id: 'board', schema: { cols: t.int(), size: t.number({ default: 1 }) } };
    const mover = behavior('mover', [], { params: { speed: t.number() } });
    const k = kernel({
      'prefabs/b.prefab.json': { components: { board: { size: 2 } }, behaviors: { mover: {} } },
      'scenes/main/scene.json': {},
    }, game({ components: [BOARD], behaviors: [mover] }));
    const b = k.spawn('b', {}, { components: { board: { cols: 8 } }, params: { mover: { speed: 3 } } });
    expect(b.components.get('board')).toEqual({ cols: 8, size: 2 });
    expect(b.behaviors[0]!.instance['speed']).toBe(3);
    expect(() => k.spawn('b', {}, { params: { mover: { speed: 3 } } })).toThrow(/PP4105[\s\S]*cols/);
  });

  it('may transform the game\'s own definition before the registry is built', () => {
    const log: Log = [];
    const roles: KernelPlugin = { id: 'roles', define: (g) => ({ ...g, systems: g.systems.filter((d) => d.runsOn !== 'client') }) };
    const project = loadProject(files({ 'scenes/main/scene.json': {} }));
    const k = new Kernel({ project, plugins: [roles], game: game({
      systems: [system('sim', log), system('hud', log, { runsOn: 'client' })],
    }) });
    k.start('main');
    expect(log).toEqual(['sim.start']);
  });

  it('share services through the kernel instead of importing each other', () => {
    interface Heights { at(x: number): number }
    const HEIGHTS = serviceKey<Heights>('heights', 'Add the terrain plugin to Game(plugins=[...]).');
    const provider: KernelPlugin = { id: 'terrain', install: (k) => k.provide(HEIGHTS, { at: (x) => x * 2 }) };
    const project = loadProject(files({ 'scenes/main/scene.json': {} }));
    const k = new Kernel({ project, game: game({}), plugins: [provider] });
    expect(k.service(HEIGHTS).at(3)).toBe(6);
    const bare = new Kernel({ project, game: game({}) });
    expect(bare.tryService(HEIGHTS)).toBeUndefined();
    expect(() => bare.service(HEIGHTS)).toThrow(/PP9005[\s\S]*terrain plugin/);
    expect(() => new Kernel({ project, game: game({}), plugins: [provider, { ...provider, id: 'terrain2' }] })).toThrow(/PP9006/);
  });

  it('let code attach components at runtime with defaults filled in', () => {
    const k = kernel({ 'prefabs/p.prefab.json': {}, 'scenes/main/scene.json': { entities: [{ prefab: 'p' }] } },
      game({ components: [{ id: 'health', schema: HEALTH }] }));
    const [e] = [...k.world.live()];
    expect(k.addComponent(e!.id, 'health', { current: 3 })).toEqual({ current: 3, max: 10 });
    expect(k.world.query(['health'])).toHaveLength(1);
    expect(() => k.addComponent(e!.id, 'health', { hp: 1 })).toThrow(/PP4104/);
    k.removeComponent(e!.id, 'health');
    expect(k.world.query(['health'])).toHaveLength(0);
  });
});
