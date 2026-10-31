/**
 * The example games' grid data, through the real grid plugin: every prefab and scene of
 * the games that list `grid()` decodes against the plugin's schemas, and the board
 * behaviours those games rely on hold on their own boards (other components get
 * permissive schemas: their plugins are not under test here).
 */

import { describe, expect, it } from 'vitest';
import { Cell, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, Fields, GameDefinition, Schema } from '../../kernel/index.js';
import { grid, GRID_EVENTS } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const PREFIX = '../../../../../../examples/';
const raw = import.meta.glob('../../../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });
const GRID_GAMES = ['brick_breaker', 'chess', 'crate_puzzle', 'maze_chase', 'four_in_a_row', 'match_three', 'lane_defense', 'number_merge', 'tic_tac_toe'];
const OURS = new Set(['grid', 'grid_cell', 'grid_mover']);

function project(name: string): Project {
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(raw)) {
    if (path.startsWith(`${PREFIX}${name}/`)) files.set(path.slice(PREFIX.length + name.length + 1), text);
  }
  const pf: ProjectFiles = { list: () => [...files.keys()].sort(), read: (p) => files.get(p)! };
  const loaded = loadProject(pf);
  expect(loaded.diagnostics).toEqual([]);
  return loaded;
}

/** Permissive schemas for every component and behavior the data uses, except the grid's. */
function permissive(p: Project): GameDefinition {
  const components = new Map<string, Set<string>>();
  const behaviors = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const inst = (i: { components: Readonly<Record<string, JsonObject>>; params: Readonly<Record<string, JsonObject>> }): void => {
    for (const [id, f] of Object.entries(i.components)) note(components, id, f);
    for (const [id, f] of Object.entries(i.params)) note(behaviors, id, f);
  };
  for (const prefab of p.prefabs.values()) {
    for (const [id, f] of Object.entries(prefab.components)) note(components, id, f);
    for (const use of prefab.behaviors) note(behaviors, use.use, use.params);
    prefab.children.forEach(inst);
  }
  for (const scene of p.scenes.values()) scene.entities.forEach(inst);
  const schema = (fields: Set<string>): Schema =>
    Object.fromEntries([...fields].map((f) => [f, { type: { kind: 'json' as const }, default: null }]));
  const defs: ComponentDef[] = [...components].filter(([id]) => !OURS.has(id)).map(([id, f]) => ({ id, schema: schema(f) }));
  const logic: BehaviorDef[] = [...behaviors].map(([id, f]) => ({
    id, params: schema(f), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return { components: defs, behaviors: logic, resources: [], events: [], systems: [] };
}

function kernelFor(name: string, game?: GameDefinition): Kernel {
  const p = project(name);
  return new Kernel({ project: p, game: game ?? permissive(p), plugins: [grid({ host: { dict: (e) => new Map(e) } })], fixedStep: 1 / 60 });
}

function board(kernel: Kernel, id: EntityId): Fields {
  return kernel.world.require(id).components.get('grid')!;
}

describe('example grid data', () => {
  it.each(GRID_GAMES)('%s: every scene loads and every prefab with grid data decodes', (name) => {
    const p = project(name);
    const withGrid = [...p.prefabs.values()].filter((prefab) => Object.keys(prefab.components).some((c) => OURS.has(c)));
    for (const sceneId of p.scenes.keys()) {
      const kernel = kernelFor(name);
      kernel.start(sceneId);
      for (let i = 0; i < 30; i++) kernel.step(1 / 60);
      if (kernel.world.query(['grid']).length !== 1) continue;
      // Pieces first: a second board would make GridCell(grid=None) ambiguous.
      const ordered = [...withGrid].sort((x, y) => Number('grid' in x.components) - Number('grid' in y.components));
      for (const prefab of ordered) {
        const needsCell = !('grid' in prefab.components) && !('cell' in (prefab.components['grid_cell'] ?? {}));
        const record = kernel.spawn(prefab.id, needsCell ? { components: { grid_cell: { cell: [0, 0] } } } : {});
        for (const id of OURS) if (id in prefab.components) expect(record.components.has(id)).toBe(true);
      }
    }
    expect(withGrid.length).toBeGreaterThan(0);
  });

  it('match_three: the scene\'s cell markers snap onto the board and keep their draw order', () => {
    const kernel = kernelFor('match_three');
    kernel.start('board');
    const markers = kernel.world.query(['grid_cell']);
    expect(markers).toHaveLength(3);
    const [boardId, b] = kernel.world.query(['grid'])[0]!;
    const corner = (b as unknown as { center(c: Cell): Vec3 }).center(new Cell(0, 0));
    expect(corner.is_close(new Vec3(-3.675, 3.675, 1))).toBe(true);
    for (const [id, gc] of markers as Array<[EntityId, Fields]>) {
      expect(kernel.world.require(id).transform.position.is_close(new Vec3(corner.x, corner.y, 6))).toBe(true);
      gc['cell'] = new Cell(7, 7);
      expect(kernel.world.require(id).transform.position.is_close(new Vec3(3.675, -3.675, 6))).toBe(true);
    }
    expect((board(kernel, boardId) as unknown as { at(c: Cell): unknown[] }).at(new Cell(7, 7))).toHaveLength(3);
  });

  it('four_in_a_row and chess: row_order="up" boards map taps back to the rules\' cells', () => {
    for (const [name, scene, size] of [['four_in_a_row', 'match', [7, 6]], ['chess', 'match', [8, 8]]] as const) {
      const p = project(name);
      const sceneId = p.scenes.has(scene) ? scene : [...p.scenes.keys()].find((s) => p.scenes.get(s)!.entities.some((e) => e.id !== undefined))!;
      const kernel = kernelFor(name);
      kernel.start(sceneId);
      const rows = kernel.world.query(['grid']);
      expect(rows).toHaveLength(1);
      const b = rows[0]![1] as unknown as { center(c: Cell): Vec3; cell_at(p: unknown): Cell | null };
      expect(b.center(new Cell(0, 0)).y).toBeLessThan(b.center(new Cell(0, size[1] - 1)).y);
      for (let col = 0; col < size[0]; col++) {
        for (let row = 0; row < size[1]; row++) expect(b.cell_at(b.center(new Cell(col, row)).xy())!.__eq__(new Cell(col, row))).toBe(true);
      }
      // four_in_a_row aims a drop with a tap above the well: Cell(col, 4)'s center is on the board.
      expect(b.cell_at(b.center(new Cell(3, 4)))!.col).toBe(3);
    }
  });

  it('lane_defense: the xz lawn has lanes along z, row 0 the far row (row_order "down", as the template reads)', () => {
    const kernel = kernelFor('lane_defense');
    kernel.start('garden');
    const [, b] = kernel.world.query(['grid'])[0]!;
    const lawn = b as unknown as { center(c: Cell): Vec3; cell_at(p: unknown): Cell | null; contains(c: Cell): boolean };
    // The camera looks along +z from z < 0: row 0 is the far lane, row 4 the nearest.
    expect(lawn.center(new Cell(0, 0)).z).toBeCloseTo(2.8);
    expect(lawn.center(new Cell(0, 4)).z).toBeCloseTo(-2.8);
    expect(lawn.center(new Cell(4, 2)).is_close(new Vec3(0, 0, 0))).toBe(true);
    expect(lawn.cell_at(new Vec3(-5.6, 0.3, 2.8))!.__eq__(new Cell(0, 0))).toBe(true);
    expect(lawn.contains(new Cell(1, 2).__add__(new Cell(0, 1)))).toBe(true);
    // A planted seed: GridCell(cell=..., snap=True) frees its cell when destroyed.
    const plant = kernel.spawn('plant', { components: { grid_cell: { cell: [2, 2], snap: true } } }).id;
    expect(kernel.world.require(plant).transform.position.is_close(new Vec3(-2.8, 0, 0))).toBe(true);
    kernel.destroy(plant);
    expect((b as unknown as { first_at(c: Cell): unknown }).first_at(new Cell(2, 2))).toBeNull();
  });

  it('maze_chase: the warren lays out from its ASCII maze and the gobbler runs a corridor', () => {
    const p = project('maze_chase');
    const maze = JSON.parse(raw[`${PREFIX}maze_chase/content/maze/warren.json`]!) as { tile: number; rows: string[] };
    const base = permissive(p);
    const entered: string[] = [];
    const game: GameDefinition = { ...base, behaviors: [...base.behaviors.filter((b) => b.id !== 'gobbler'), {
      id: 'gobbler', params: {}, state: {}, requires: ['grid_cell', 'grid_mover'],
      handlers: [{ event: GRID_EVENTS.cellEntered, method: 'reached' }],
      create: () => ({ reached: (_ctx: unknown, e: Fields) => { entered.push(String(e['cell'])); } }),
    }] };
    const kernel = kernelFor('maze_chase', game);
    kernel.start('maze');
    // `spawn(Prefabs.board, components=[layout(maze)])`: the board prefab names only the plane.
    const boardId = kernel.spawn('board', { components: { grid: { cols: maze.rows[0]!.length, rows: maze.rows.length, cell_size: [maze.tile, maze.tile] } } }).id;
    const b = board(kernel, boardId) as unknown as {
      parse(l: string[]): Map<Cell, string>; first_at(c: Cell, k: object): unknown; contains(c: Cell): boolean;
    };
    const tiles = b.parse(maze.rows);
    let start: Cell | undefined;
    for (const [cell, ch] of tiles) {
      if (ch === '#') kernel.spawn('wall', { components: { grid_cell: { cell: cell.toJSON(), snap: true } } });
      if (ch === 'P') start = cell;
    }
    expect(start!.__eq__(new Cell(9, 13))).toBe(true);
    expect(b.first_at(new Cell(0, 0), { tagged: 'wall' })).not.toBeNull();
    const gobbler = kernel.spawn('gobbler', { components: { grid_cell: { cell: start!.toJSON() } } }).id;
    const mover = kernel.world.require(gobbler).components.get('grid_mover') as unknown as {
      go(c: Cell): void; moving: boolean; direction: Cell | null;
    };
    mover.go(Cell.DOWN);
    for (let i = 0; i < 120; i++) kernel.step(1 / 60);
    expect(entered).toEqual(['Cell(9, 14)', 'Cell(9, 15)', 'Cell(9, 16)', 'Cell(9, 17)', 'Cell(9, 18)', 'Cell(9, 19)']);
    expect(mover.moving).toBe(false);
    expect(mover.direction!.__eq__(Cell.DOWN)).toBe(true);
  });
});
