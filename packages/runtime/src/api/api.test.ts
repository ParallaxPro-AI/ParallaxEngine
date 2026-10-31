/**
 * The SDK semantics documented in sdk/parallax/__init__.pyi, exercised the way compiled
 * game code calls them: classes with `__annotations__` thunks over `rt` markers, static
 * `field()`/`param()`/`state()` defaults, decorators applied as functions, keyword
 * arguments as a trailing `kw({...})`, tasks as generators.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import type { TaskBody } from '../function/kernel/index.js';
import { KERNEL_EVENTS } from '../function/kernel/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import {
  Actions, Behavior, behavior, button, clamp, Collided, Color, component, config, content, ContentRef, Context, createRuntime, Destroyed, ease,
  Entity, EntityRef, Enum, enum_class, event, field, Game, kw, lerp, Localized, noise2d, on, param, PrefabRef, record, resetDeclarations,
  resource, rt, SceneLoaded, SceneRef, scatter, Spawned, state, System, system, tag, Task, TextRef, Timer, toFieldType,
  Vec2, Vec3,
} from './index.js';
import type { GameRuntime } from './index.js';

const STEP = 1 / 60;

/** Project files; every scene also places a camera (a 2D game draws through one). */
function files(contents: Record<string, unknown>): ProjectFiles {
  const withCamera: Record<string, unknown> = { 'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 8 } } } };
  for (const [p, v] of Object.entries(contents)) {
    const scene = v as { entities?: unknown[] };
    withCamera[p] = p.endsWith('/scene.json') ? { ...scene, entities: [...(scene.entities ?? []), { prefab: 'camera' }] } : v;
  }
  const text = Object.fromEntries(Object.entries(withCamera).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function run(data: Record<string, unknown>, systems: unknown[] = [], start = 'main', seed = 7): GameRuntime {
  const projectFiles = files(data);
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({ id: 'test', title: 'Test', sdk: '1.0', start_scene: new SceneRef(start), mode: '2d', systems }));
  const runtime = createRuntime(game, project, {
    seed, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles, surface: new RecordingSurface2d(),
  });
  runtime.start();
  return runtime;
}

function steps(runtime: GameRuntime, n: number): void {
  for (let i = 0; i < n; i++) runtime.step(STEP);
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { diagnostic?: { code: string } }).diagnostic?.code; }
  return undefined;
}

beforeEach(() => resetDeclarations());

describe('type markers', () => {
  it('map annotations to kernel field types', () => {
    class IngredientC {
      static __annotations__ = { count: () => rt.int };
      static count = field(1);
    }
    const Ingredient = record(IngredientC);
    class Ring extends Enum { static BULL = 'bull'; static OUTER = 'outer'; }
    enum_class(Ring);
    class Item { static __annotations__ = { name: () => rt.str }; }
    const ItemDef = content('item')(Item);

    expect(toFieldType(rt.float)).toEqual({ kind: 'number' });
    expect(toFieldType(rt.list(rt.optional(Vec2)))).toEqual({ kind: 'list', of: { kind: 'optional', of: { kind: 'vec2' } } });
    expect(toFieldType(rt.dict(rt.str, rt.int))).toEqual({ kind: 'dict', of: { kind: 'int' } });
    expect(toFieldType(rt.tuple(rt.float, rt.float))).toEqual({ kind: 'tuple', of: [{ kind: 'number' }, { kind: 'number' }] });
    expect(toFieldType(rt.tuple(rt.float, Color))).toEqual({ kind: 'tuple', of: [{ kind: 'number' }, { kind: 'color' }] });
    expect(toFieldType(rt.literal('a', 'b'))).toEqual({ kind: 'enum', values: ['a', 'b'] });
    expect(toFieldType(rt.generic(ContentRef, ItemDef))).toEqual({ kind: 'ref', to: 'content/item' });
    expect(toFieldType(Ring)).toEqual({ kind: 'enum', values: ['bull', 'outer'] });
    expect(toFieldType(Entity)).toEqual({ kind: 'entity' });
    expect(toFieldType(PrefabRef)).toEqual({ kind: 'ref', to: 'prefab' });
    expect(toFieldType(Localized)).toEqual({ kind: 'string' });
    expect(toFieldType(Ingredient)).toEqual({ kind: 'record', fields: { count: { type: { kind: 'int' }, default: 1 } } });
    expect(code(() => toFieldType(Math))).toBe('PP4109');
    expect((Ring as unknown as { BULL: Enum }).BULL.value).toBe('bull');
  });

  it('bind Python arguments strictly', () => {
    expect(code(() => field(1, kw({ minn: 0 })))).toBe('PP3030');
    expect(code(() => field(1, 2))).toBe('PP3030');
    expect(code(() => component('Bad Id'))).toBe('PP4111');
    class Lane { static __annotations__ = { index: () => rt.int, label: () => rt.str }; static index = field(0); }
    const L = component('lane')(Lane) as unknown as new (...a: unknown[]) => { index: number; label: string };
    expect(code(() => new L(kw({ index: 2 })))).toBe('PP3030');
    expect({ ...new L(3, 'x') }).toEqual({ index: 3, label: 'x' });
    expect(code(() => new L(kw({ label: 'x', idx: 1 })))).toBe('PP3030');
  });
});

describe('a small game', () => {
  const PREFABS = {
    'prefabs/crate.prefab.json': { components: { hp: { max: 3 } }, tags: ['crate'], behaviors: { mover: { speed: 2 } } },
    'prefabs/pair.prefab.json': { children: [{ name: 'left', prefab: 'crate', at: [-1, 0] }, { name: 'right', prefab: 'crate', at: [1, 0] }] },
  };

  function declare(log: string[]) {
    class Hp {
      static __annotations__ = { current: () => rt.int, max: () => rt.int, speed: () => rt.float };
      static current = field(3, kw({ min: 0 }));
      static max = field(3, kw({ min: 1 }));
      static speed = field(1, kw({ modifiable: true, min: 0 }));
    }
    const HpC = component('hp')(Hp);
    class Score {
      static __annotations__ = { points: () => rt.int, best: () => rt.int };
      static points = field(0);
      static best = field(0, kw({ keep: 'profile' }));
    }
    const ScoreR = resource('score')(Score);
    class Hit {
      static __annotations__ = { entity: () => Entity, amount: () => rt.int };
      static amount = field(1);
    }
    const HitE = event('hit', kw({ target: 'entity' }))(Hit);
    class Mover extends Behavior {
      static __annotations__ = { speed: () => rt.float, travelled: () => rt.float };
      static speed = param(1);
      static travelled = state(0);
      declare speed: number;
      declare travelled: number;
      declare entity: Entity;
      start() { log.push(`start ${this.entity.name}`); }
      update(_ctx: Context, dt: number) { this.travelled += this.speed * dt; }
      took(ctx: Context, e: { amount: number }) {
        const hp = this.entity.get(HpC) as { current: number };
        hp.current -= e.amount;
        (ctx.get(ScoreR) as { points: number }).points += e.amount;
        if (hp.current <= 0) this.entity.destroy();
      }
      end() { log.push(`end alive=${this.entity.alive}`); }
    }
    on(HitE)(Mover.prototype.took);
    behavior('mover', kw({ requires: [HpC] }))(Mover);
    return { HpC, ScoreR, HitE };
  }

  it('builds entities from prefabs: params, state, children and names', () => {
    const log: string[] = [];
    declare(log);
    const r = run({ ...PREFABS, 'scenes/main/scene.json': { entities: [{ prefab: 'pair', id: 'pair' }, { prefab: 'crate', at: [5, 0], params: { mover: { speed: 4 } } }] } });
    expect(log).toEqual(['start left', 'start right', 'start crate']);
    const crates = r.ctx.world.query(kw({ tagged: tag('crate') })).to_list() as Entity[];
    expect(crates).toHaveLength(3);
    steps(r, 30);
    expect(crates.map((e) => e.name)).toEqual(['left', 'right', 'crate']);
    const pair = r.ctx.world.placed(new EntityRef('pair'));
    expect(pair.children.map((c) => c.name)).toEqual(['left', 'right']);
    expect(pair.child('right').transform.position.x).toBe(1);
    expect(code(() => pair.child('middle'))).toBe('PP3012');
    expect(r.ctx.world.placement(new EntityRef('pair')).loaded).toBe(pair);
    expect(code(() => r.ctx.world.placed(new EntityRef('nobody')))).toBe('PP3011');
  });

  it('delivers targeted events, destroys immediately and tears down at the end of the phase', () => {
    const log: string[] = [];
    const { HpC, ScoreR, HitE } = declare(log);
    const seen: string[] = [];
    class Watch extends System {
      gone(_ctx: Context, e: { entity: Entity; unloaded: boolean }) { seen.push(`destroyed alive=${e.entity.alive}`); }
    }
    on(Destroyed)(Watch.prototype.gone);
    system('watch')(Watch);
    const r = run({ ...PREFABS, 'scenes/main/scene.json': { entities: [{ prefab: 'crate', at: [0, 0] }, { prefab: 'crate', at: [3, 0] }] } }, [Watch]);
    const [a, b] = r.ctx.world.query(HpC).entities();
    const Hit = HitE as unknown as new (...args: unknown[]) => object;
    r.ctx.emit(new Hit(kw({ entity: a, amount: 2 })));
    steps(r, 1);
    expect((a!.get(HpC) as { current: number }).current).toBe(1);
    expect((b!.get(HpC) as { current: number }).current).toBe(3);
    r.ctx.emit(new Hit(kw({ entity: a, amount: 5 })));
    steps(r, 1);
    expect(a!.alive).toBe(false);
    expect(code(() => a!.transform)).toBe('PP3002');
    expect(r.ctx.world.query(HpC).count()).toBe(1);
    expect(seen).toEqual(['destroyed alive=false']);
    expect(log).toContain('end alive=false');
    expect((r.ctx.get(ScoreR) as { points: number }).points).toBe(7);
    expect(code(() => r.ctx.emit(Hit))).toBe('PP3015');
  });

  it('spawns with components, params, tags and name; get/try_get/has/add/remove', () => {
    const { HpC } = declare([]);
    const Flag = tag('flag');
    const r = run({ ...PREFABS, 'scenes/main/scene.json': { entities: [] } });
    const Hp = HpC as unknown as new (...args: unknown[]) => object;
    const e = r.ctx.world.spawn(new PrefabRef('crate'), kw({
      at: new Vec2(2, 3), components: [new Hp(kw({ current: 1 }))], tags: [Flag], name: 'boxy', params: { mover: { speed: 9 } },
    }));
    expect(e.name).toBe('boxy');
    expect(e.transform.position.__eq__(new Vec3(2, 3, 0))).toBe(true);
    expect(e.get(HpC)).toMatchObject({ current: 1, max: 3 });
    expect(e.has(Flag)).toBe(true);
    e.untag(Flag);
    expect(e.has(Flag)).toBe(false);
    e.add(new Hp(kw({ current: 2, max: 2 })));
    expect(e.get(HpC)).toMatchObject({ current: 2, max: 2 });
    // add() merges the given fields, as spawn(components=) does; the rest keep their values.
    e.add(new Hp(kw({ current: 1 })));
    expect(e.get(HpC)).toMatchObject({ current: 1, max: 2 });
    e.remove(HpC);
    expect(e.try_get(HpC)).toBeNull();
    expect(code(() => e.get(HpC))).toBe('PP3001');
    expect(e.prefab?.id).toBe('crate');
  });

  it('modifiers on component and resource fields', () => {
    const { HpC, ScoreR } = declare([]);
    const r = run({ ...PREFABS, 'scenes/main/scene.json': { entities: [{ prefab: 'crate' }] } });
    const e = r.ctx.world.query(HpC).entities()[0]!;
    e.modify(HpC, 'speed', kw({ multiply: 1.5, key: 'haste', seconds: 0.5 }));
    expect((e.get(HpC) as { speed: number }).speed).toBe(1.5);
    expect(e.base(HpC, 'speed')).toBe(1);
    steps(r, 31);
    expect((e.get(HpC) as { speed: number }).speed).toBe(1);
    expect(code(() => e.modify(HpC, 'current', kw({ add: 1, key: 'x' })))).toBe('PP4106');
    expect(code(() => r.ctx.modify(ScoreR, 'points', kw({ add: 1 })))).toBe('PP4106');
  });

  it('queries: where unpacked, near, nearest, by_distance, single', () => {
    const { HpC } = declare([]);
    const r = run({ ...PREFABS, 'scenes/main/scene.json': { entities: [
      { prefab: 'crate', at: [0, 0] }, { prefab: 'crate', at: [4, 0], components: { hp: { current: 1 } } }, { prefab: 'crate', at: [9, 0] },
    ] } });
    const q = r.ctx.world.query(HpC);
    expect(q.where((_e: unknown, hp: unknown) => (hp as { current: number }).current === 1).count()).toBe(1);
    expect(q.near(new Vec2(1, 0), 3.5).count()).toBe(2);
    const nearest = q.nearest(new Vec2(8, 0)) as [Entity, unknown];
    expect(nearest[0].transform.position.x).toBe(9);
    expect((q.nearest(new Vec2(8, 0), 2) as unknown[]).length).toBe(2);
    expect(q.by_distance(new Vec2(5, 0)).map((row) => (row as [Entity])[0].transform.position.x)).toEqual([4, 9, 0]);
    expect(code(() => q.single())).toBe('PP3010');
    // A 2D game's z is draw order, not space: a Vec3 point (a transform position) compares x/y too.
    expect(q.near(new Vec3(4, 0, 2), 0.5).count()).toBe(1);
    expect((q.nearest(new Vec3(0, 0, 50)) as [Entity])[0].transform.position.x).toBe(0);
  });
});

describe('systems, config, content, text', () => {
  it('runs systems in order with when=, where= and always=, and reads config and content', () => {
    class RulesC {
      static __annotations__ = { lives: () => rt.int, title: () => Localized };
      static lives = field(3);
    }
    const Rules = config('rules')(RulesC);
    class Stage {
      static __annotations__ = { number: () => rt.int, name: () => Localized, color: () => Color };
    }
    const StageDef = content('stage', kw({ order: 'number' }))(Stage);
    class Phase { static __annotations__ = { playing: () => rt.bool }; static playing = field(false); }
    const PhaseR = resource('phase')(Phase);
    class Go { static __annotations__ = { n: () => rt.int }; }
    const GoE = event('go')(Go);
    const log: string[] = [];
    class First extends System {
      start(ctx: Context) {
        const list = ctx.content(StageDef);
        log.push(`stages ${[...list].map((s) => s.id).join(',')}`);
        const first = list.__getitem__(0).data as { name: Localized; color: Color };
        log.push(`name ${ctx.text(first.name)} key ${first.name.key}`);
        log.push(`lives ${(ctx.config(Rules) as { lives: number }).lives}`);
      }
      begin(ctx: Context) { (ctx.get(PhaseR) as { playing: boolean }).playing = true; log.push('begin'); }
      gated(_ctx: Context, e: { n: number }) { log.push(`gated ${e.n}`); }
    }
    on(GoE, kw({ always: true }))(First.prototype.begin);
    on(GoE, kw({ where: (e: { n: number }) => e.n > 1 }))(First.prototype.gated);
    system('first', kw({ when: (ctx: Context) => (ctx.get(PhaseR) as { playing: boolean }).playing }))(First);
    class Second extends System { update() { log.push('second'); } }
    system('second', kw({ after: [First] }))(Second);

    const r = run({
      'config/rules.json': { lives: 5, title: 'Prism' },
      'content/stage/zeta.json': { number: 1, name: 'Dawn', color: '#ff0000' },
      'content/stage/alpha.json': { number: 2, name: 'Dusk', color: '#00ff00' },
      'locale/en.json': { greet: 'Hi {who}' },
      'scenes/main/scene.json': { entities: [] },
    }, [Second, First]);
    expect(log).toEqual(['stages zeta,alpha', 'name Dawn key stage.zeta.name', 'lives 5']);
    expect(code(() => { (r.ctx.config(Rules) as { lives: number }).lives = 1; })).toBe('PP3018');
    // Tests (h.config(Rules, lives=1)) change config for their game; game code sees the same object.
    const rules = r.ctx.config(Rules) as { lives: number; title: string };
    expect(r.overrideConfig(Rules, { lives: 1 })).toBe(rules);
    expect(rules.lives).toBe(1);
    expect(String((rules.title as unknown as { key: string }).key)).toBe('config.rules.title');
    expect(code(() => r.overrideConfig(Rules, { livez: 1 }))).toBe('PP3023');
    expect(code(() => { (r.ctx.content(StageDef).get('zeta').data as { number: number }).number = 1; })).toBe('PP3018');
    expect(code(() => r.ctx.content(StageDef).get('zetta'))).toBe('PP2050');
    expect(r.ctx.text(new TextRef('greet'), kw({ who: 'you' }))).toBe('Hi you');

    log.length = 0;
    const Go_ = GoE as unknown as new (...a: unknown[]) => object;
    r.ctx.emit(new Go_(2));
    steps(r, 1);
    // `begin` (always) opens the phase, so `gated` — evaluated right before it — runs too.
    expect(log).toEqual(['begin', 'gated 2', 'second']);
    log.length = 0;
    r.ctx.emit(new Go_(1));
    steps(r, 1);
    expect(log).toEqual(['begin', 'second']);
  });

  it('scene reload resets keep="run" resources, applies init, reseeds, and reports SceneLoaded', () => {
    class RunC {
      static __annotations__ = { level: () => rt.int, coins: () => rt.int, best: () => rt.int };
      static level = field(1);
      static coins = field(0);
      static best = field(0, kw({ keep: 'profile' }));
    }
    const RunR = resource('run')(RunC);
    const loads: unknown[] = [];
    class Loader extends System {
      loaded(ctx: Context, e: { scene: SceneRef; new_run: boolean }) {
        loads.push([e.scene.id, e.new_run, ctx.seed, (ctx.get(RunR) as { level: number }).level]);
      }
    }
    on(SceneLoaded)(Loader.prototype.loaded);
    system('loader')(Loader);
    const r = run({ 'scenes/main/scene.json': { entities: [] } }, [Loader], 'main', 42);
    const fields = r.ctx.get(RunR) as { level: number; coins: number; best: number };
    fields.coins = 5;
    fields.best = 9;
    const Run_ = RunR as unknown as new (...a: unknown[]) => object;
    r.ctx.scenes.reload(kw({ new_run: true, init: [new Run_(kw({ level: 3 }))], seed: 11 }));
    steps(r, 1);
    expect(loads).toEqual([['main', false, 42, 1], ['main', true, 11, 3]]);
    expect({ ...(r.ctx.get(RunR) as object) }).toEqual({ level: 3, coins: 0, best: 9 });
    expect(r.ctx.scenes.current_is(new SceneRef('main'))).toBe(true);
    r.ctx.reset(RunR);
    expect({ ...(r.ctx.get(RunR) as object) }).toEqual({ level: 1, coins: 0, best: 0 });
  });
});

describe('time, tasks, tweens', () => {
  it('owns timers and tasks by the behavior that started them', () => {
    const log: string[] = [];
    class Fuse extends Behavior {
      declare entity: Entity;
      start(ctx: Context) {
        ctx.time.after(0.1, () => log.push('timer'));
        ctx.run(function* (c: Context, task: Task): TaskBody {
          yield task.seconds(0.05);
          log.push(`task @${c.time.frame}`);
          yield task.seconds(10);
          log.push('never');
        });
      }
    }
    behavior('fuse')(Fuse);
    class Ticker extends System {
      start(ctx: Context) { ctx.time.every(0.25, () => log.push(`tick ${ctx.time.now.toFixed(2)}`)); }
    }
    system('ticker')(Ticker);
    const r = run({ 'prefabs/bomb.prefab.json': { behaviors: { fuse: {} } }, 'scenes/main/scene.json': { entities: [{ prefab: 'bomb' }] } }, [Ticker]);
    steps(r, 4);
    expect(log).toEqual(['task @3']);
    const bomb = [...r.kernel.world.live()][0]!;
    r.kernel.destroy(bomb.id);
    steps(r, 30);
    // The bomb's timer (due at 0.1 s) and its waiting task died with it; the system's ticker runs on.
    expect(log).toEqual(['task @3', 'tick 0.25', 'tick 0.50']);
  });

  it('waits for events, tweens values and transforms, and replaces move tweens', () => {
    class Ping { static __annotations__ = { n: () => rt.int }; }
    const PingE = event('ping')(Ping);
    const got: unknown[] = [];
    const r = run({ 'prefabs/dot.prefab.json': {}, 'scenes/main/scene.json': { entities: [] } });
    r.ctx.run(function* (_c: Context, task: Task): TaskBody {
      got.push((yield task.until(PingE, (e: unknown) => (e as { n: number }).n > 1)) as unknown);
      const spawned = (yield task.until(Spawned)) as { entity: Entity };
      got.push(spawned.entity.name);
    });
    const Ping_ = PingE as unknown as new (...a: unknown[]) => object;
    r.ctx.emit(new Ping_(1));
    steps(r, 1);
    const second = new Ping_(2);
    r.ctx.emit(second);
    steps(r, 2);
    r.ctx.world.spawn(new PrefabRef('dot'), kw({ name: 'd1' }));
    steps(r, 1);
    expect(got).toEqual([second, 'd1']);

    const values: number[] = [];
    r.ctx.tween(0, 10, 0.1, (v: number) => values.push(v));
    steps(r, 8);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(10);
    expect(values).toHaveLength(7);

    const dot = r.ctx.world.spawn(new PrefabRef('dot'));
    const first = dot.transform.move_to(new Vec2(10, 0), 1);
    steps(r, 30);
    const second_ = dot.transform.move_to(new Vec2(0, 5), 0.5, kw({ ease: 'linear' }));
    expect(first.active).toBe(false);
    steps(r, 31);
    expect(second_.active).toBe(false);
    expect(dot.transform.position.is_close(new Vec3(0, 5, 0))).toBe(true);
    expect(code(() => dot.transform.move_to(new Vec2(1, 1), 1, kw({ ease: 'wobble' })))).toBe('PP3033');
  });

  it('Timer counts down, fires once, and repeats', () => {
    expect(code(() => new Timer(0.5))).toBe('PP3017');
    const t = Timer.cooldown(0.5);
    expect(t.done).toBe(true);
    expect(t.tick(0.1)).toBe(false);
    t.restart();
    expect(t.tick(0.3)).toBe(false);
    expect(t.progress).toBeCloseTo(0.6);
    expect(t.tick(0.3)).toBe(true);
    expect(t.tick(0.3)).toBe(false);
    const r = Timer.delay(0.2, kw({ repeat: true }));
    expect([r.tick(0.1), r.tick(0.1), r.tick(0.1), r.tick(0.1)]).toEqual([false, true, false, true]);
  });

  it('a Timer in state() is a per-entity Timer instance', () => {
    const seen: boolean[] = [];
    class Gun extends Behavior {
      static __annotations__ = { cooldown: () => Timer };
      static cooldown = state(Timer.delay(0.5));
      declare cooldown: Timer;
      update(_ctx: Context, dt: number) { seen.push(this.cooldown.tick(dt)); }
    }
    behavior('gun')(Gun);
    const r = run({ 'prefabs/gun.prefab.json': { behaviors: { gun: {} } }, 'scenes/main/scene.json': { entities: [{ prefab: 'gun' }, { prefab: 'gun' }] } });
    steps(r, 30);
    expect(seen.filter(Boolean)).toHaveLength(2);
  });
});

describe('tick="significance"', () => {
  it('updates every frame on screen, 10 Hz off screen near the camera, 2 Hz far; each update gets the time since the last', () => {
    const calls = new Map<string, number[]>();
    class Mote extends Behavior {
      declare entity: Entity;
      update(_ctx: Context, dt: number) {
        const list = calls.get(this.entity.name) ?? [];
        list.push(dt);
        calls.set(this.entity.name, list);
      }
    }
    behavior('mote', kw({ tick: 'significance' }))(Mote);
    const r = run({
      'prefabs/mote.prefab.json': { behaviors: { mote: {} } },
      'scenes/main/scene.json': {
        entities: [{ prefab: 'mote', id: 'seen', at: [0, 0] }, { prefab: 'mote', id: 'near', at: [30, 0] }, { prefab: 'mote', id: 'far', at: [100, 0] }],
      },
    });
    steps(r, 60);
    expect([calls.get('seen')!.length, calls.get('near')!.length, calls.get('far')!.length]).toEqual([60, 10, 2]);
    for (const dts of calls.values()) expect(dts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(code(() => behavior('bad', kw({ tick: 'sometimes' })))).toBe('PP4110');
  });
});

describe('input and ui wiring', () => {
  it('reads input as the running behavior (its seat and entity), and maps engine events to kernel events', () => {
    class Controls extends Actions { static jump = button(kw({ keyboard: 'Space' })); }
    Controls.__init_subclass__();
    const seen: string[] = [];
    class Jumper extends Behavior {
      declare entity: Entity;
      update(ctx: Context) {
        if ((ctx as unknown as { input: { pressed(a: unknown): boolean } }).input.pressed(Controls.jump)) seen.push(this.entity.name);
      }
    }
    behavior('jumper')(Jumper);
    const projectFiles = files({ 'prefabs/hero.prefab.json': { behaviors: { jumper: {} } }, 'scenes/main/scene.json': { entities: [] } });
    const project = loadProject(projectFiles);
    const devices = new HeadlessInput();
    const game = new Game(kw({ id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '2d' }));
    const r = createRuntime(game, project, { seed: 1, devices, audio: new HeadlessAudio(), assets: null, files: projectFiles, surface: new RecordingSurface2d() });
    r.start();
    const hero = r.ctx.world.spawn(new PrefabRef('hero'), kw({ name: 'hero', owner: r.ctx.players[0] }));
    expect(hero.owner).toBe(r.ctx.players[0]);
    devices.tapKey('Space');
    r.step(STEP);
    expect(seen).toEqual(['hero']);
    expect((Collided as unknown as { __event_def__: unknown }).__event_def__).toBe(KERNEL_EVENTS.collided);
    expect(typeof (r.ctx as unknown as { ui: { is_open: unknown } }).ui.is_open).toBe('function');
  });
});

describe('math', () => {
  it('helpers, easing, noise and scatter', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(ease('in_out_quad', 0.5)).toBe(0.5);
    const n = noise2d(1.3, 2.7, kw({ seed: 3, octaves: 3, scale: 4 }));
    expect(n).toBe(noise2d(1.3, 2.7, kw({ seed: 3, octaves: 3, scale: 4 })));
    expect(Math.abs(n)).toBeLessThanOrEqual(1);
    const r = run({ 'scenes/main/scene.json': { entities: [] } });
    const points = scatter(new Vec3(0, 0, 0), 5, 20, kw({ min_spacing: 1 }));
    expect(points.length).toBeGreaterThan(5);
    for (const p of points) expect(p.length()).toBeLessThanOrEqual(5 + 1e-9);
    expect(r.ctx.seed).toBe(7);
  });
});
