/**
 * `parallax.grid` and `parallax.combat` as compiled game code sees them: handles, events,
 * the built-in status_effect content kind, Tag-valued sides and damage kinds, Python
 * dicts from `Grid.parse`, and a dying entity's own behavior hearing `Died` — through
 * `createRuntime` with both plugins.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Cell } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { combat, Damaged, DamageHit, Died, EffectApplied, Health, Side, StatModifier, StatusEffectDef, StatusEffects } from './combat.js';
import { Cell as GridModuleCell, CellEntered, grid, Grid, GridCell, GridMover } from './grid.js';
import { Behavior, behavior, createRuntime, Game, kw, on, resetDeclarations, SceneRef, tag } from './index.js';
import type { Context, Entity, GameRuntime } from './index.js';
import { PyDict } from './pyrt/collections.js';

const PROJECT: Record<string, unknown> = {
  'content/status_effect/venom.json': { name: 'Poisoned', damage_per_second: 2, damage_kind: 'poison', tick: 0.5 },
  'content/status_effect/chill.json': { name: 'Chilled', modifiers: [{ component: 'grid_mover', field: 'speed', multiply: 0.5 }] },
  'prefabs/board.prefab.json': { components: { grid: { cols: 4, rows: 3, cell_size: [1, 1] } } },
  'prefabs/imp.prefab.json': {
    components: {
      health: { current: 10, max: 10, flat_armor: 3 }, side: { side: 'red' }, status_effects: {},
      grid_cell: { cell: [0, 0] }, grid_mover: { speed: 4 },
    },
    behaviors: { imp: {} },
  },
  'prefabs/knight.prefab.json': { components: { health: {}, side: { side: 'blue' } } },
  'scenes/field/scene.json': { entities: [{ id: 'board', prefab: 'board' }, { id: 'imp', prefab: 'imp' }, { id: 'knight', prefab: 'knight' }] },
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const heard: string[] = [];

function start(): { runtime: GameRuntime; placed(id: string): Entity } {
  const Poison = tag('poison');
  class Imp extends Behavior {
    declare entity: Entity;
    hurt(_ctx: Context, e: { amount: number; kind: unknown }) { heard.push(`damaged ${e.amount} ${String(e.kind)}`); }
    died(_ctx: Context, e: { entity: Entity }) {
      heard.push(`died alive=${e.entity.alive} dead=${(this.entity.get(Health) as { dead: boolean }).dead}`);
    }
    entered(_ctx: Context, e: { cell: Cell }) { heard.push(`entered ${String(e.cell)}`); }
    afflicted(_ctx: Context, e: { effect: { id: string } }) { heard.push(`effect ${e.effect.id}`); }
  }
  on(Damaged)(Imp.prototype.hurt);
  on(Died)(Imp.prototype.died);
  on(CellEntered)(Imp.prototype.entered);
  on(EffectApplied)(Imp.prototype.afflicted);
  behavior('imp')(Imp);
  // def venom_pierces(ctx, hit): if hit.kind == Poison: hit.ignores_armor = True
  const venomPierces = (_ctx: unknown, hit: DamageHit): void => {
    if (Poison.__eq__(hit.kind)) hit.ignores_armor = true;
  };
  const game = new Game(kw({
    id: 'arena', title: 'Arena', sdk: '1.0', mode: '3d', start_scene: new SceneRef('field'),
    plugins: [combat(kw({ modifiers: [venomPierces], min_damage: 1 })), grid()],
  }));
  const project = loadProject(files(PROJECT));
  expect(project.diagnostics).toEqual([]);
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: files(PROJECT), surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  runtime.start();
  const placed = (id: string): Entity => runtime.wrap([...runtime.kernel.world.live()].find((r) => r.placedId === id)!.id);
  return { runtime, placed };
}

beforeEach(() => {
  resetDeclarations();
  heard.length = 0;
});

describe('parallax.grid and parallax.combat in a running game', () => {
  it('exposes handles for the components, Cell, and the built-in content kind', () => {
    expect([Grid, GridCell, GridMover, Health, Side, StatusEffects].map((h) => h.__component_id__))
      .toEqual(['grid', 'grid_cell', 'grid_mover', 'health', 'side', 'status_effects']);
    expect(GridModuleCell).toBe(Cell);
    expect((StatusEffectDef as unknown as { __content_kind__: string }).__content_kind__).toBe('status_effect');
    const m = new (StatModifier as unknown as new (...a: unknown[]) => { multiply: number; add: number })(kw({ component: 'x', field: 'y' }));
    expect([m.multiply, m.add]).toEqual([1, 0]);
    expect(() => combat(kw({ modifier: [] }))).toThrow(/PP3030/);
  });

  it('runs sides, damage kinds, effects and death the way compiled game code sees them', () => {
    const { runtime, placed } = start();
    const ctx = runtime.ctx as Context & { combat: { are_enemies(a: Entity, b: Entity): boolean } };
    const imp = placed('imp');
    const knight = placed('knight');
    expect(ctx.combat.are_enemies(imp, knight)).toBe(true);
    expect((imp.get(Side) as { side: unknown }).side).toEqual(tag('red'));

    const health = imp.get(Health) as { damage(...a: unknown[]): number; current: number };
    expect(health.damage(2, kw({ source: knight }))).toBe(1); // flat armor 3, min_damage 1
    const venom = ctx.content(StatusEffectDef).get('venom');
    (imp.get(StatusEffects) as { apply(...a: unknown[]): void }).apply(venom, 1, kw({ strength: 2 }));
    runtime.step(1 / 60);
    for (let i = 0; i < 60; i++) runtime.step(1 / 60);
    expect(health.current).toBe(10 - 1 - 4); // two ticks of 2 × 2 × 0.5, through armor
    expect(heard).toEqual(['damaged 1 null', 'effect venom', 'damaged 2 Tag(poison)', 'damaged 2 Tag(poison)']);

    const chill = ctx.content(StatusEffectDef).get('chill');
    (imp.get(StatusEffects) as { apply(...a: unknown[]): void }).apply(chill, 5);
    expect((imp.get(GridMover) as { speed: number }).speed).toBe(2);

    heard.length = 0;
    const mover = imp.get(GridMover) as { go(c: Cell): void };
    mover.go(Cell.RIGHT);
    for (let i = 0; i < 31; i++) runtime.step(1 / 60);
    expect(heard).toEqual(['effect chill', 'entered Cell(1, 0)']);
    const board = placed('board').get(Grid) as { first_at(c: Cell): Entity | null; parse(l: string[]): PyDict };
    expect(board.first_at(new Cell(1, 0))).toBe(imp);
    const layout = board.parse(['.#', '#']);
    expect(layout).toBeInstanceOf(PyDict);
    expect(layout.__getitem__(new Cell(1, 0))).toBe('#');

    heard.length = 0;
    (imp.get(Health) as { kill(...a: unknown[]): void }).kill(kw({ source: knight }));
    runtime.step(1 / 60);
    expect(heard).toEqual(['died alive=true dead=true']);
    expect(imp.alive).toBe(false);
  });
});
