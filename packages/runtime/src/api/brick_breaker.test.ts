/**
 * Acceptance: the game logic of examples/brick_breaker, hand-compiled to what the
 * transpiler emits (annotation thunks, static field()/param()/state(), decorators as calls,
 * `kw({...})` keywords, generator tasks), running headless on the kernel.
 *
 * Physics, input, UI and combat belong to other plugins, so this version owns stand-ins
 * written as ordinary game code: the orb moves and bounces itself, a paddle behavior
 * tracks the orb, bricks carry a game `Hits` component, and a task drafts the first
 * upgrade the way the draft panel's button would.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import type { TaskBody } from '../function/kernel/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import {
  activeRandom, Behavior, behavior, clamp, Color, component, config, content, ContentRef, createRuntime, Entity, event,
  field, Game, kw, Localized, on, param, PrefabRef, resetDeclarations, resource, rt, SceneRef, state, System, system,
  tag, Vec2, Vec3,
} from './index.js';
import type { Context, ContentList, GameRuntime, Task } from './index.js';

type Fields = Record<string, unknown>;
type Ctor = new (...args: unknown[]) => object;

const PROJECT: Record<string, unknown> = {
  'config/rules.json': { lives: 3, brick_score: 100, combo_score: 25, clear_bonus: 500, draft_size: 2 },
  'content/stage/dawn.json': { number: 1, name: 'Prism Dawn', color: '#73ccff', ball_speed_scale: 1, rows: ['1111', '1111'] },
  'content/stage/core.json': { number: 2, name: 'Prism Core', color: '#ff5577', ball_speed_scale: 1.1, rows: ['2112'] },
  'content/upgrade/wide.json': { name: 'Wide Array', paddle_width: 1.4 },
  'content/upgrade/overclock.json': { name: 'Overclock', score_mult: 1.5 },
  'content/upgrade/spare_orb.json': { name: 'Spare Orb', extra_lives: 1 },
  'locale/en.json': { stage_progress: 'Stage {number}/{total}' },
  'prefabs/brick.prefab.json': { components: { hits: {} }, tags: ['brick'], behaviors: { prism_brick: {} } },
  'prefabs/paddle.prefab.json': { components: { pad: { width: 2.6 } }, tags: ['paddle'], behaviors: { paddle: { speed: 30 } } },
  'prefabs/ball.prefab.json': {
    tags: ['orb'],
    behaviors: { orb: { base_speed: 9, speed_step: 0.25, max_speed: 14, serve_delay: 0.5, lost_below: -7.7 } },
  },
  'scenes/title/scene.json': { entities: [] },
  'scenes/arena/scene.json': { entities: [{ prefab: 'paddle', at: [0, -6.6] }, { prefab: 'ball', at: [0, -6] }] },
};

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

/** The compiled modules of the game: declared in import order, as the loader would. */
function declareGame() {
  // game/components.py
  const Paddle = tag('paddle');
  const Brick = tag('brick');
  const Orb = tag('orb');

  class HitsC {
    static __annotations__ = { current: () => rt.int, max: () => rt.int };
    static current = field(1, kw({ min: 0 }));
    static max = field(1, kw({ min: 1 }));
  }
  const Hits = component('hits')(HitsC) as unknown as Ctor;
  class PadC {
    static __annotations__ = { width: () => rt.float };
    static width = field(2.6, kw({ min: 0.5, modifiable: true }));
  }
  const Pad = component('pad')(PadC);

  // game/config.py
  class RulesC {
    static __annotations__ = {
      lives: () => rt.int, brick_score: () => rt.int, combo_score: () => rt.int, clear_bonus: () => rt.int, draft_size: () => rt.int,
    };
    static lives = field(3, kw({ min: 1 }));
    static brick_score = field(100, kw({ min: 0 }));
    static combo_score = field(25, kw({ min: 0 }));
    static clear_bonus = field(500, kw({ min: 0 }));
    static draft_size = field(3, kw({ min: 1 }));
  }
  const Rules = config('rules')(RulesC);

  // game/content.py
  class StageC {
    static __annotations__ = {
      number: () => rt.int, name: () => Localized, color: () => Color, ball_speed_scale: () => rt.float, rows: () => rt.list(rt.str),
    };
    static number = field(kw({ min: 1 }));
    static ball_speed_scale = field(1.0, kw({ min: 0.1 }));
  }
  const StageDef = content('stage', kw({ order: 'number' }))(StageC);
  class UpgradeC {
    static __annotations__ = { name: () => Localized, paddle_width: () => rt.float, score_mult: () => rt.float, extra_lives: () => rt.int };
    static paddle_width = field(1.0, kw({ min: 0.1 }));
    static score_mult = field(1.0, kw({ min: 0.1 }));
    static extra_lives = field(0, kw({ min: 0 }));
  }
  const UpgradeDef = content('upgrade')(UpgradeC);

  // game/resources.py
  class RunC {
    static __annotations__ = {
      stage_index: () => rt.int, score: () => rt.int, combo: () => rt.int, balls_lost: () => rt.int,
      bricks_left: () => rt.int, serving: () => rt.bool, won: () => rt.bool, ended: () => rt.bool,
    };
    static stage_index = field(0, kw({ min: 0 }));
    static score = field(0, kw({ min: 0 }));
    static combo = field(0, kw({ min: 0 }));
    static balls_lost = field(0, kw({ min: 0 }));
    static bricks_left = field(0, kw({ min: 0 }));
    static serving = field(true);
    static won = field(false);
    static ended = field(false);
  }
  const Run = resource('run')(RunC);
  class ModsC {
    static __annotations__ = { score_mult: () => rt.float, extra_lives: () => rt.int };
    static score_mult = field(1.0, kw({ modifiable: true }));
    static extra_lives = field(0);
  }
  const Mods = resource('mods')(ModsC);
  class DraftC {
    static __annotations__ = {
      offer: () => rt.list(rt.generic(ContentRef, UpgradeDef)), owned: () => rt.list(rt.generic(ContentRef, UpgradeDef)),
    };
    static offer = field([]);
    static owned = field([]);
  }
  const Draft = resource('draft')(DraftC);
  class BestC {
    static __annotations__ = { score: () => rt.int };
    static score = field(0);
  }
  const Best = resource('best', kw({ keep: 'profile' }))(BestC);

  // game/events.py
  class BrickHitC { static __annotations__ = { entity: () => Entity }; }
  const BrickHit = event('brick_hit', kw({ target: 'entity' }))(BrickHitC) as unknown as Ctor;
  class BrickBrokenC { static __annotations__ = { entity: () => Entity }; }
  const BrickBroken = event('brick_broken')(BrickBrokenC) as unknown as Ctor;
  class StageStartedC { static __annotations__ = { index: () => rt.int }; }
  const StageStarted = event('stage_started')(StageStartedC) as unknown as Ctor;
  class StageClearedC { static __annotations__ = { final: () => rt.bool }; }
  const StageCleared = event('stage_cleared')(StageClearedC) as unknown as Ctor;
  const BallLaunched = event('ball_launched')(class BallLaunchedC {}) as unknown as Ctor;
  const BallReturned = event('ball_returned')(class BallReturnedC {}) as unknown as Ctor;
  class BallLostC { static __annotations__ = { at: () => Vec2 }; }
  const BallLost = event('ball_lost')(BallLostC) as unknown as Ctor;
  class UpgradePickedC { static __annotations__ = { upgrade: () => rt.generic(ContentRef, UpgradeDef) }; }
  const UpgradePicked = event('upgrade_picked')(UpgradePickedC) as unknown as Ctor;
  class RunEndedC { static __annotations__ = { won: () => rt.bool }; }
  const RunEnded = event('run_ended')(RunEndedC) as unknown as Ctor;

  // game/progress.py
  const run = (ctx: Context) => ctx.get(Run) as Fields & { stage_index: number; score: number; combo: number; balls_lost: number; bricks_left: number; serving: boolean; won: boolean; ended: boolean };
  const stages = (ctx: Context) => ctx.content(StageDef) as ContentList<{ number: number; name: Localized; color: Color; ball_speed_scale: number; rows: string[] }>;
  const currentStage = (ctx: Context) => stages(ctx).__getitem__(run(ctx).stage_index).data;
  const isFinalStage = (ctx: Context) => run(ctx).stage_index === stages(ctx).__len__() - 1;
  const livesLeft = (ctx: Context) => (ctx.config(Rules) as { lives: number }).lives + (ctx.get(Mods) as { extra_lives: number }).extra_lives - run(ctx).balls_lost;

  // game/behaviors/brick.py
  class PrismBrick extends Behavior {
    declare entity: Entity;
    cracked(ctx: Context) {
      const hits = this.entity.get(Hits) as { current: number };
      hits.current -= 1;
      if (hits.current <= 0) {
        ctx.emit(new BrickBroken(kw({ entity: this.entity })));
        this.entity.destroy();
      }
    }
  }
  on(BrickHit)(PrismBrick.prototype.cracked);
  behavior('prism_brick', kw({ requires: [Hits] }))(PrismBrick);

  // game/behaviors/paddle.py (tracks the orb instead of reading input)
  class PaddleB extends Behavior {
    static __annotations__ = { speed: () => rt.float, half_court: () => rt.float };
    static speed = param(14, kw({ unit: 'm/s' }));
    static half_court = param(8.0);
    declare speed: number;
    declare half_court: number;
    declare entity: Entity;
    update(ctx: Context, dt: number) {
      const orb = ctx.world.query(kw({ tagged: Orb })).first() as Entity | null;
      if (orb === null) return;
      const t = this.entity.transform;
      // Meet the orb a little off-centre, varying over time, so returns change angle.
      const aim = Math.sin(ctx.time.now * 1.3) * 0.9;
      const target = clamp(orb.transform.position.x + aim, -this.half_court, this.half_court);
      const step = clamp(target - t.position.x, -this.speed * dt, this.speed * dt);
      t.position = t.position.__add__(new Vec3(step, 0, 0));
    }
  }
  behavior('paddle', kw({ requires: [Pad] }))(PaddleB);

  // game/behaviors/orb.py (moves and bounces itself instead of a Rigidbody)
  class OrbB extends Behavior {
    static __annotations__ = {
      base_speed: () => rt.float, speed_step: () => rt.float, max_speed: () => rt.float, serve_delay: () => rt.float,
      launch_spread: () => rt.float, rest_height: () => rt.float, lost_below: () => rt.float,
      speed: () => rt.float, velocity: () => Vec2, auto_launch_at: () => rt.float,
    };
    static base_speed = param(9.0, kw({ unit: 'm/s' }));
    static speed_step = param(0.25, kw({ unit: 'm/s' }));
    static max_speed = param(20.0, kw({ unit: 'm/s' }));
    static serve_delay = param(2.2, kw({ unit: 's' }));
    static launch_spread = param(25, kw({ unit: 'deg' }));
    static rest_height = param(0.61);
    static lost_below = param(-7.7);
    static speed = state(0.0);
    static velocity = state(Vec2.ZERO);
    static auto_launch_at = state(0.0);
    declare base_speed: number; declare speed_step: number; declare max_speed: number; declare serve_delay: number;
    declare launch_spread: number; declare rest_height: number; declare lost_below: number;
    declare speed: number; declare velocity: Vec2; declare auto_launch_at: number;
    declare entity: Entity;

    start(ctx: Context) { this.serve(ctx); }

    update(ctx: Context, dt: number) {
      if (run(ctx).ended) return;
      if (run(ctx).serving) { this.wait_on_paddle(ctx); return; }
      const t = this.entity.transform;
      t.position = t.position.__add__(this.velocity.to_vec3().__mul__(dt));
      this.bounce_walls(ctx);
      this.hit_paddle(ctx);
      this.hit_brick(ctx);
      if (t.position.y < this.lost_below) {
        ctx.emit(new BallLost(kw({ at: t.position.xy() })));
        this.serve(ctx);
      }
    }

    stage_started(ctx: Context) { this.serve(ctx); }

    serve(ctx: Context) {
      run(ctx).serving = true;
      this.auto_launch_at = ctx.time.now + this.serve_delay;
      this.velocity = Vec2.ZERO;
    }

    wait_on_paddle(ctx: Context) {
      const paddle = ctx.world.query(kw({ tagged: Paddle })).single() as Entity;
      this.entity.transform.position = paddle.transform.position.__add__(new Vec3(0, this.rest_height, 0));
      if (ctx.time.now >= this.auto_launch_at) this.launch(ctx);
    }

    launch(ctx: Context) {
      const scale = currentStage(ctx).ball_speed_scale;
      this.speed = Math.min(this.base_speed * scale, this.max_speed);
      const side = activeRandom().int(0, 1) === 0 ? -1 : 1;
      this.velocity = Vec2.from_angle(90 + side * this.launch_spread, this.speed);
      run(ctx).serving = false;
      ctx.emit(new BallLaunched());
    }

    bounce_walls(_ctx: Context) {
      const p = this.entity.transform.position;
      if (Math.abs(p.x) > 8.7 && Math.sign(this.velocity.x) === Math.sign(p.x)) this.velocity = this.velocity.with_x(-this.velocity.x);
      if (p.y > 6.7 && this.velocity.y > 0) this.velocity = this.velocity.with_y(-this.velocity.y);
    }

    hit_paddle(ctx: Context) {
      if (this.velocity.y >= 0) return;
      const p = this.entity.transform.position;
      const paddle = ctx.world.query(Pad, kw({ tagged: Paddle })).single() as [Entity, { width: number }];
      const [pe, pad] = paddle;
      const half = pad.width / 2;
      const offset = p.x - pe.transform.position.x;
      if (Math.abs(p.y - pe.transform.position.y) < 0.65 && Math.abs(offset) < half + 0.3) {
        this.speed = Math.min(this.speed + this.speed_step, this.max_speed);
        const kick = clamp(offset / half, -1, 1) * 3.2;
        this.velocity = new Vec2(this.velocity.x + kick, Math.abs(this.velocity.y)).normalized().__mul__(this.speed);
        ctx.emit(new BallReturned());
      }
    }

    hit_brick(ctx: Context) {
      const p = this.entity.transform.position;
      const row = ctx.world.query(Hits, kw({ tagged: Brick }))
        .near(p.xy(), 1.4)
        .where((e: unknown) => {
          const b = (e as Entity).transform.position;
          return Math.abs(b.x - p.x) < 0.95 + 0.3 && Math.abs(b.y - p.y) < 0.35 + 0.3;
        })
        .first() as [Entity, unknown] | null;
      if (row === null) return;
      ctx.emit(new BrickHit(kw({ entity: row[0] })));
      this.velocity = this.velocity.with_y(-this.velocity.y);
    }
  }
  on(StageStarted)(OrbB.prototype.stage_started);
  behavior('orb')(OrbB);

  // game/systems/stages.py
  class Stages extends System {
    start(ctx: Context) { this.build(ctx); }
    next_stage(ctx: Context) { run(ctx).stage_index += 1; this.build(ctx); }
    brick_broken(ctx: Context) {
      const r = run(ctx);
      r.bricks_left -= 1;
      if (r.bricks_left === 0) ctx.emit(new StageCleared(kw({ final: isFinalStage(ctx) })));
    }
    build(ctx: Context) {
      const stage = currentStage(ctx);
      let count = 0;
      stage.rows.forEach((line, r) => {
        [...line].forEach((symbol, c) => {
          if (!/\d/.test(symbol)) return;
          const hp = Number(symbol);
          const at = new Vec2((c - (line.length - 1) / 2) * 2.2, 4.5 - r * 0.9);
          ctx.world.spawn(new PrefabRef('brick'), kw({ at, components: [new Hits(kw({ current: hp, max: hp }))] }));
          count += 1;
        });
      });
      run(ctx).bricks_left = count;
      ctx.emit(new StageStarted(kw({ index: run(ctx).stage_index })));
    }
  }
  on(UpgradePicked)(Stages.prototype.next_stage);
  on(BrickBroken)(Stages.prototype.brick_broken);
  system('stages', kw({ scenes: [new SceneRef('arena')] }))(Stages);

  // game/systems/scoring.py
  class Scoring extends System {
    brick_hit(ctx: Context) {
      const rules = ctx.config(Rules) as { brick_score: number; combo_score: number };
      const r = run(ctx);
      r.combo += 1;
      r.score += Math.trunc((rules.brick_score + r.combo * rules.combo_score) * (ctx.get(Mods) as { score_mult: number }).score_mult);
    }
    reset_combo(ctx: Context) { run(ctx).combo = 0; }
    stage_cleared(ctx: Context) { run(ctx).score += (ctx.config(Rules) as { clear_bonus: number }).clear_bonus; }
  }
  on(BrickHit)(Scoring.prototype.brick_hit);
  on(BallLaunched)(Scoring.prototype.reset_combo);
  on(BallReturned)(Scoring.prototype.reset_combo);
  on(StageCleared)(Scoring.prototype.stage_cleared);
  system('scoring')(Scoring);

  // game/systems/upgrades.py (+ the draft panel's pick, as a task)
  class Upgrades extends System {
    offer(ctx: Context) {
      const draft = ctx.get(Draft) as { offer: unknown[]; owned: unknown[] };
      const pool = [...ctx.content(UpgradeDef)].filter((u) => !draft.owned.some((o) => u.__eq__(o)));
      draft.offer = pool.slice(0, Math.min((ctx.config(Rules) as { draft_size: number }).draft_size, pool.length));
      ctx.run(function* pick(c: Context, task: Task): TaskBody {
        yield task.seconds(0.5);
        const offer = (c.get(Draft) as { offer: ContentRef<unknown>[] }).offer;
        c.emit(new UpgradePicked(kw({ upgrade: offer[0] })));
      });
    }
    take(ctx: Context, e: { upgrade: ContentRef<{ paddle_width: number; score_mult: number; extra_lives: number }> }) {
      const upgrade = e.upgrade.data;
      ctx.modify(Mods, 'score_mult', kw({ multiply: upgrade.score_mult, stack: true }));
      (ctx.get(Mods) as { extra_lives: number }).extra_lives += upgrade.extra_lives;
      const paddle = ctx.world.query(kw({ tagged: Paddle })).single() as Entity;
      paddle.modify(Pad, 'width', kw({ multiply: upgrade.paddle_width, key: `upgrade_${e.upgrade.id}` }));
      const draft = ctx.get(Draft) as { offer: unknown[]; owned: unknown[] };
      draft.owned.push(e.upgrade);
      draft.offer = [];
    }
  }
  on(StageCleared, kw({ where: (e: { final: boolean }) => !e.final }))(Upgrades.prototype.offer);
  on(UpgradePicked)(Upgrades.prototype.take);
  system('upgrades')(Upgrades);

  // game/systems/outcome.py
  class Outcome extends System {
    ball_lost(ctx: Context) {
      run(ctx).balls_lost += 1;
      if (livesLeft(ctx) === 0) this.end(ctx, false);
    }
    cleared(ctx: Context) { this.end(ctx, true); }
    end(ctx: Context, won: boolean) {
      const r = run(ctx);
      const best = ctx.get(Best) as { score: number };
      r.won = won;
      r.ended = true;
      best.score = Math.max(best.score, r.score);
      ctx.emit(new RunEnded(kw({ won })));
    }
  }
  on(BallLost)(Outcome.prototype.ball_lost);
  on(StageCleared, kw({ where: (e: { final: boolean }) => e.final }))(Outcome.prototype.cleared);
  system('outcome')(Outcome);

  // game/main.py
  const game = new Game(kw({
    id: 'brick_breaker', title: 'Prism Smash', sdk: '1.0', mode: '2d',
    systems: [Upgrades, Stages, Scoring, Outcome], start_scene: new SceneRef('arena'),
  }));
  return { game, Run, Mods, Draft, Best, Pad, Hits, Paddle, Brick, StageDef, UpgradeDef, RunEnded, run, stages };
}

beforeEach(() => resetDeclarations());

describe('brick_breaker on the kernel (headless)', () => {
  function play(seed: number): { runtime: GameRuntime; g: ReturnType<typeof declareGame>; ended: Array<{ won: boolean; frame: number }> } {
    resetDeclarations();
    const g = declareGame();
    const projectFiles = files(PROJECT);
    const project = loadProject(projectFiles);
    expect(project.diagnostics).toEqual([]);
    const runtime = createRuntime(g.game, project, {
      seed, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles, surface: new RecordingSurface2d(),
    });
    const ended: Array<{ won: boolean; frame: number }> = [];
    runtime.start();
    for (let frame = 0; frame < 60 * 90 && ended.length === 0; frame++) {
      runtime.step(1 / 60);
      const r = g.run(runtime.ctx);
      if (r.ended) ended.push({ won: r.won, frame });
    }
    return { runtime, g, ended };
  }

  it('plays both stages: bricks break, scores, a drafted upgrade stacks, and the run is won', () => {
    const { runtime, g, ended } = play(1);
    const ctx = runtime.ctx;
    const r = g.run(ctx);

    expect(ended).toHaveLength(1);
    expect(ended[0]!.won).toBe(true);
    expect(r.stage_index).toBe(1);
    expect(r.bricks_left).toBe(0);
    expect(ctx.world.query(g.Hits, kw({ tagged: g.Brick })).count()).toBe(0);

    // The drafted upgrade is the content entry itself, read back through the resource.
    const draft = ctx.get(g.Draft) as { owned: ContentRef<{ name: Localized }>[]; offer: unknown[] };
    expect(draft.offer).toEqual([]);
    expect(draft.owned).toHaveLength(1);
    expect(draft.owned[0]).toBeInstanceOf(ContentRef);
    const picked = draft.owned[0]!;
    expect(picked).toBe(ctx.content(g.UpgradeDef).get('overclock'));
    expect(ctx.text(picked.data.name)).toBe('Overclock');

    // Score: every brick hit counted with its combo, both clear bonuses, and the upgrade multiplier.
    expect(r.score).toBeGreaterThan(2 * 500 + 10 * 100);
    expect((ctx.get(g.Best) as { score: number }).score).toBe(r.score);

    // The modifier stacked on the run resource / paddle (base stays declared).
    const mods = ctx.get(g.Mods) as { score_mult: number };
    const paddle = ctx.world.query(kw({ tagged: g.Paddle })).single() as Entity;
    expect(mods.score_mult).toBe(1.5);
    expect(ctx.base(g.Mods, 'score_mult')).toBe(1);
    expect((paddle.get(g.Pad) as { width: number }).width).toBe(2.6);
    paddle.modify(g.Pad, 'width', kw({ multiply: 1.4, key: 'upgrade_wide' }));
    expect((paddle.get(g.Pad) as { width: number }).width).toBeCloseTo(3.64);
    expect(paddle.base(g.Pad, 'width')).toBe(2.6);

    // Deterministic: the same seed plays the same game.
    const again = play(1);
    expect(again.ended).toEqual(ended);
    expect(again.g.run(again.runtime.ctx).score).toBe(r.score);
  });

  it('a retry (new_run=True) restarts the run but keeps the profile best', () => {
    const { runtime, g } = play(3);
    const ctx = runtime.ctx;
    const best = (ctx.get(g.Best) as { score: number }).score;
    expect(best).toBeGreaterThan(0);
    ctx.scenes.reload(kw({ new_run: true }));
    runtime.step(1 / 60);
    const r = g.run(ctx);
    expect([r.stage_index, r.score, r.ended, r.bricks_left]).toEqual([0, 0, false, 8]);
    expect((ctx.get(g.Best) as { score: number }).score).toBe(best);
    expect((ctx.get(g.Draft) as { owned: unknown[] }).owned).toEqual([]);
    expect(ctx.world.query(g.Hits, kw({ tagged: g.Brick })).count()).toBe(8);
    expect(ctx.text(g.stages(ctx).get('dawn').data.name)).toBe('Prism Dawn');
  });
});
