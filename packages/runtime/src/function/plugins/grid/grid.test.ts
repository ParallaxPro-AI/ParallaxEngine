import { describe, expect, it } from 'vitest';
import { Cell, ParallaxError, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, Fields, GameDefinition, LogicInstance } from '../../kernel/index.js';
import { grid, GRID_EVENTS, shortestPath } from './index.js';

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

interface GridApi extends Fields {
  readonly entity: unknown;
  center(...args: unknown[]): Vec3;
  cell_at(...args: unknown[]): Cell | null;
  contains(...args: unknown[]): boolean;
  neighbors(...args: unknown[]): Cell[];
  cells(...args: unknown[]): Iterable<Cell>;
  at(...args: unknown[]): unknown[];
  first_at(...args: unknown[]): unknown;
  parse(...args: unknown[]): Map<Cell, string>;
  path(...args: unknown[]): Cell[];
}

interface MoverApi extends Fields {
  step(...args: unknown[]): boolean;
  go(...args: unknown[]): null;
  stop(): null;
  readonly moving: boolean;
  readonly direction: Cell | null;
}

interface Setup {
  readonly kernel: Kernel;
  id(placed: string): EntityId;
  board(placed?: string): GridApi;
  cellOf(id: EntityId): Fields;
  mover(id: EntityId): MoverApi;
  spawn(prefab: string, cell: Cell, over?: Record<string, unknown>): EntityId;
  steps(n: number): void;
}

/** A listener behavior: `fn` runs on each event with the behavior's entity. */
function listener(id: string, fn: (self: EntityId, payload: Fields) => void): BehaviorDef {
  return {
    id,
    params: {},
    state: {},
    requires: [],
    handlers: [{ event: GRID_EVENTS.cellEntered, method: 'entered' }],
    create: () => ({
      entered(this: LogicInstance, _ctx: unknown, payload: Fields) { fn(this['entity'] as EntityId, payload); },
    }) as LogicInstance,
  };
}

function setup(
  prefabs: Record<string, unknown>, entities: unknown[], behaviors: BehaviorDef[] = [],
  components: GameDefinition['components'] = [],
): Setup {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project,
    game: { components, resources: [], events: [], behaviors, systems: [] },
    plugins: [grid({ host: { dict: (entries) => new Map(entries) } })],
    context: {},
    fixedStep: DT,
  });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel,
    id,
    board: (placed = 'board') => kernel.world.require(id(placed)).components.get('grid') as GridApi,
    cellOf: (e) => kernel.world.require(e).components.get('grid_cell')!,
    mover: (e) => kernel.world.require(e).components.get('grid_mover') as MoverApi,
    spawn: (prefab, cell, over = {}) => kernel.spawn(prefab, { components: { grid_cell: { cell: cell.toJSON() }, ...over } }).id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const BOARD = { components: { grid: { cols: 3, rows: 2, cell_size: [2, 1] } } };
const PIECE = { components: {} };

describe('grid geometry', () => {
  it('centers cells around the entity, row 0 on top by default', () => {
    const g = setup({ board: BOARD }, [{ id: 'board', prefab: 'board', at: [10, 20, 5] }]);
    const b = g.board();
    expect(b.center(new Cell(0, 0)).is_close(new Vec3(8, 20.5, 5))).toBe(true);
    expect(b.center(new Cell(2, 1)).is_close(new Vec3(12, 19.5, 5))).toBe(true);
    // Off-board cells still have a center (pieces dropping in from above).
    expect(b.center(new Cell(0, -1)).is_close(new Vec3(8, 21.5, 5))).toBe(true);
    expect(b.center(new Cell(1, 1)).xy().is_close(new Vec2(10, 19.5))).toBe(true);
  });

  it('honours row_order="up" and origin="corner"', () => {
    const g = setup({
      up: { components: { grid: { cols: 3, rows: 2, cell_size: [2, 1], row_order: 'up' } } },
      corner: { components: { grid: { cols: 3, rows: 2, cell_size: [2, 1], origin: 'corner' } } },
    }, [{ id: 'up', prefab: 'up', at: [10, 20] }, { id: 'corner', prefab: 'corner', at: [10, 20] }]);
    expect(g.board('up').center(new Cell(0, 0)).is_close(new Vec3(8, 19.5, 0))).toBe(true);
    expect(g.board('up').center(new Cell(0, 1)).is_close(new Vec3(8, 20.5, 0))).toBe(true);
    expect(g.board('corner').center(new Cell(0, 0)).is_close(new Vec3(11, 19.5, 0))).toBe(true);
    expect(g.board('corner').center(new Cell(1, 1)).is_close(new Vec3(13, 18.5, 0))).toBe(true);
  });

  it('lays "xz" boards on the ground: rows along z, height kept', () => {
    const g = setup({ lawn: { components: { grid: { cols: 9, rows: 5, cell_size: [1.4, 1.4], plane: 'xz', row_order: 'up' } } } },
      [{ id: 'board', prefab: 'lawn', at: [0, 2, 0] }]);
    const b = g.board();
    const c = b.center(new Cell(0, 0));
    expect(c.is_close(new Vec3(-5.6, 2, -2.8))).toBe(true);
    expect(b.center(new Cell(0, 4)).z).toBeCloseTo(2.8);
    expect(b.cell_at(new Vec3(-5.6, 0, -2.8))!.__eq__(new Cell(0, 0))).toBe(true);
    expect(b.cell_at(new Vec2(5.6, 2.8))!.__eq__(new Cell(8, 4))).toBe(true);
    expect(b.cell_at(new Vec3(0, 0, 3.6))).toBeNull();
  });

  it('maps world points back to cells, None off the board, also when rotated', () => {
    const g = setup({ board: BOARD }, [{ id: 'board', prefab: 'board', at: [10, 20], rotation: 90 }]);
    const b = g.board();
    for (const cell of b.cells()) {
      const center = b.center(cell);
      expect(b.cell_at(center)!.__eq__(cell)).toBe(true);
      expect(b.cell_at(center.xy())!.__eq__(cell)).toBe(true);
    }
    expect(b.center(new Cell(0, 0)).is_close(new Vec3(9.5, 18, 0))).toBe(true);
    expect(b.cell_at(new Vec3(100, 0, 0))).toBeNull();
    expect(code(() => b.cell_at(new Cell(0, 0)))).toBe('PP7500');
  });

  it('lists cells row by row, neighbours in a fixed order, and follows a resize', () => {
    const g = setup({ board: BOARD }, [{ id: 'board', prefab: 'board' }]);
    const b = g.board();
    expect([...b.cells()].map(String)).toEqual(['Cell(0, 0)', 'Cell(1, 0)', 'Cell(2, 0)', 'Cell(0, 1)', 'Cell(1, 1)', 'Cell(2, 1)']);
    expect(b.neighbors(new Cell(1, 0)).map(String)).toEqual(['Cell(1, 1)', 'Cell(0, 0)', 'Cell(2, 0)']);
    expect(b.neighbors(new Cell(1, 0), { diagonal: true }).map(String))
      .toEqual(['Cell(1, 1)', 'Cell(0, 0)', 'Cell(2, 0)', 'Cell(0, 1)', 'Cell(2, 1)']);
    expect(b.contains(new Cell(2, 1))).toBe(true);
    expect(b.contains(new Cell(3, 1))).toBe(false);
    b['cols'] = 1;
    b['rows'] = 1;
    expect([...b.cells()].map(String)).toEqual(['Cell(0, 0)']);
    b['cell_size'] = new Vec2(0, 1);
    expect(code(() => b.center(new Cell(0, 0)))).toBe('PP7501');
  });

  it('parses a text layout: the first line is the top row for either row order', () => {
    const g = setup({
      down: { components: { grid: { cols: 3, rows: 3, cell_size: [1, 1] } } },
      up: { components: { grid: { cols: 3, rows: 3, cell_size: [1, 1], row_order: 'up' } } },
    }, [{ id: 'down', prefab: 'down' }, { id: 'up', prefab: 'up' }]);
    const entries = (m: Map<Cell, string>): string[] => [...m].map(([c, ch]) => `${c.col},${c.row}:${ch}`);
    expect(entries(g.board('down').parse(['ab', 'c']))).toEqual(['0,0:a', '1,0:b', '0,1:c']);
    expect(entries(g.board('up').parse(['ab', 'c']))).toEqual(['0,2:a', '1,2:b', '0,1:c']);
    expect(code(() => g.board('down').parse(['abcd']))).toBe('PP7502');
    expect(code(() => g.board('down').parse(['a', 'b', 'c', 'd']))).toBe('PP7502');
    expect(code(() => g.board('down').parse('abc'))).toBe('PP7502');
  });
});

describe('grid occupancy', () => {
  const prefabs = {
    board: { components: { grid: { cols: 4, rows: 4, cell_size: [1, 1] } } },
    crate: { components: {}, tags: ['crate'] },
    wall: { components: {}, tags: ['wall'] },
    stone: { components: { stone: {} } },
    marker: { z: 6, components: { grid_cell: { cell: [0, 0], snap: true } } },
  };
  const stone = { id: 'stone', schema: {} };

  it('answers "what is at this cell" by tag and component, in spawn order', () => {
    const g = setup(prefabs, [{ id: 'board', prefab: 'board' }], [], [stone]);
    const b = g.board();
    const crate = g.spawn('crate', new Cell(1, 1));
    const wall = g.spawn('wall', new Cell(1, 1));
    const s = g.spawn('stone', new Cell(2, 2));
    expect(b.at(new Cell(1, 1))).toEqual([crate, wall]);
    expect(b.at(new Cell(1, 1), { tagged: 'wall' })).toEqual([wall]);
    expect(b.first_at(new Cell(1, 1), { tagged: ['crate'] })).toBe(crate);
    expect(b.first_at(new Cell(2, 2), { having: ['stone'] })).toBe(s);
    expect(b.first_at(new Cell(2, 2), { tagged: 'crate' })).toBeNull();
    expect(b.at(new Cell(3, 3))).toEqual([]);
    expect(code(() => b.at(new Cell(1, 1), { tagged: 5 }))).toBe('PP3004');
  });

  it('re-files a piece the moment its cell is assigned (crate push, gem swap)', () => {
    const g = setup(prefabs, [{ id: 'board', prefab: 'board' }]);
    const b = g.board();
    const a = g.spawn('crate', new Cell(0, 0));
    const c = g.spawn('crate', new Cell(1, 0));
    g.cellOf(a)['cell'] = new Cell(0, 1);
    expect(b.first_at(new Cell(0, 0))).toBeNull();
    expect(b.first_at(new Cell(0, 1))).toBe(a);
    // first.cell, second.cell = b, a
    const [ca, cc] = [g.cellOf(a)['cell'] as Cell, g.cellOf(c)['cell'] as Cell];
    g.cellOf(a)['cell'] = cc;
    g.cellOf(c)['cell'] = ca;
    expect(b.at(new Cell(1, 0))).toEqual([a]);
    expect(b.at(new Cell(0, 1))).toEqual([c]);
    expect(code(() => { g.cellOf(a)['cell'] = [1, 1]; })).toBe('PP7500');
  });

  it('forgets pieces whose GridCell is removed or whose entity is destroyed', () => {
    const g = setup(prefabs, [{ id: 'board', prefab: 'board' }]);
    const b = g.board();
    const a = g.spawn('crate', new Cell(2, 2));
    const c = g.spawn('crate', new Cell(3, 3));
    g.kernel.removeComponent(a, 'grid_cell');
    expect(b.at(new Cell(2, 2))).toEqual([]);
    g.kernel.destroy(c);
    expect(b.at(new Cell(3, 3))).toEqual([]);
    g.steps(1);
    expect(b.at(new Cell(3, 3))).toEqual([]);
  });

  it('snaps pieces with snap=True onto their cell, keeping 2D draw order', () => {
    const g = setup(prefabs, [{ id: 'board', prefab: 'board', at: [1, 1] }, { id: 'm', prefab: 'marker' }]);
    const m = g.id('m');
    const node = g.kernel.world.require(m).transform;
    expect(node.position.is_close(new Vec3(-0.5, 2.5, 6))).toBe(true);
    g.cellOf(m)['cell'] = new Cell(3, 3);
    expect(node.position.is_close(new Vec3(2.5, -0.5, 6))).toBe(true);
    node.position = new Vec3(0, 0, 6);
    g.steps(1);
    expect(node.position.is_close(new Vec3(2.5, -0.5, 6))).toBe(true);
    // Without snap, the grid never moves a transform.
    const crate = g.spawn('crate', new Cell(0, 0));
    expect(g.kernel.world.require(crate).transform.position.is_close(Vec3.ZERO)).toBe(true);
  });

  it('needs exactly one Grid for GridCell(grid=None); grid= picks a board', () => {
    const none = setup({ crate: PIECE }, []);
    expect(code(() => none.spawn('crate', new Cell(0, 0)))).toBe('PP7503');
    const two = setup({ board: BOARD, crate: PIECE }, [{ id: 'a', prefab: 'board' }, { id: 'b', prefab: 'board', at: [10, 0] }]);
    expect(code(() => two.spawn('crate', new Cell(0, 0)))).toBe('PP7504');
    const onB = two.kernel.spawn('crate', { components: { grid_cell: { cell: [0, 0] } } }, {
      components: { grid_cell: { grid: two.id('b') } },
    }).id;
    expect(two.board('b').at(new Cell(0, 0))).toEqual([onB]);
    expect(two.board('a').at(new Cell(0, 0))).toEqual([]);
    expect(code(() => { two.cellOf(onB)['grid'] = onB; })).toBe('PP7505');
  });

  it('finds the shortest open path around blocking pieces', () => {
    const g = setup(prefabs, [{ id: 'board', prefab: 'board' }]);
    const b = g.board();
    for (const row of [0, 1, 2]) g.spawn('wall', new Cell(1, row));
    const path = b.path(new Cell(0, 0), new Cell(2, 0), { blocked: ['wall'] });
    expect(path.map(String)).toEqual([
      'Cell(0, 0)', 'Cell(0, 1)', 'Cell(0, 2)', 'Cell(0, 3)', 'Cell(1, 3)', 'Cell(2, 3)', 'Cell(2, 2)', 'Cell(2, 1)', 'Cell(2, 0)',
    ]);
    expect(b.path(new Cell(0, 0), new Cell(2, 0)).length).toBe(3);
    expect(b.path(new Cell(0, 0), new Cell(1, 0), { blocked: 'wall' })).toEqual([]);
    expect(b.path(new Cell(3, 3), new Cell(3, 3)).map(String)).toEqual(['Cell(3, 3)']);
    // Diagonal steps never cut past a closed corner.
    expect(b.path(new Cell(0, 3), new Cell(2, 2), { blocked: 'wall', diagonal: true }).map(String))
      .toEqual(['Cell(0, 3)', 'Cell(1, 3)', 'Cell(2, 3)', 'Cell(2, 2)']);
  });

  it('shortestPath is breadth-first and deterministic', () => {
    const open = (c: Cell): boolean => c.col >= 0 && c.row >= 0 && c.col < 3 && c.row < 3;
    expect(shortestPath(new Cell(0, 0), new Cell(2, 2), open, false).length).toBe(5);
    expect(shortestPath(new Cell(0, 0), new Cell(2, 2), open, true).map(String)).toEqual(['Cell(0, 0)', 'Cell(1, 1)', 'Cell(2, 2)']);
  });
});

describe('GridMover', () => {
  const maze = [
    '#####',
    '#...#',
    '#.#.#',
    '#...#',
    '#####',
  ];
  const prefabs = {
    board: { components: { grid: { cols: 5, rows: 5, cell_size: [1, 1], origin: 'corner' } } },
    wall: { components: {}, tags: ['wall'] },
    runner: { z: 2, components: { grid_mover: { speed: 5, blocked: ['wall'] } }, behaviors: { log: {} } },
  };

  function mazeSetup(onEntered: (self: EntityId, payload: Fields, g: Setup) => void = () => {}): Setup & { runner: EntityId; log: string[] } {
    const log: string[] = [];
    let g: Setup | undefined;
    g = setup(prefabs, [{ id: 'board', prefab: 'board' }], [listener('log', (self, payload) => {
      log.push(String(payload['cell']));
      expect(payload['entity']).toBe(self);
      onEntered(self, payload, g!);
    })]);
    for (const [cell, ch] of g.board().parse(maze)) if (ch === '#') g.spawn('wall', cell, { grid_cell: { cell: cell.toJSON(), snap: true } });
    const runner = g.spawn('runner', new Cell(1, 1));
    return Object.assign(g, { runner, log });
  }

  it('go() runs down a corridor cell by cell and stops at a wall, keeping its heading', () => {
    const g = mazeSetup();
    const m = g.mover(g.runner);
    expect(m.moving).toBe(false);
    expect(m.direction).toBeNull();
    m.go(Cell.RIGHT);
    expect(m.moving).toBe(true);
    g.steps(6); // 5 cells/s: one cell per 12 frames
    expect(g.log).toEqual([]);
    const pos = g.kernel.world.require(g.runner).transform.position;
    expect(pos.x).toBeCloseTo(1.5 + 0.5);
    expect(pos.z).toBe(2);
    g.steps(6);
    expect(g.log).toEqual(['Cell(2, 1)']);
    expect((g.cellOf(g.runner)['cell'] as Cell).__eq__(new Cell(2, 1))).toBe(true);
    g.steps(30);
    expect(g.log).toEqual(['Cell(2, 1)', 'Cell(3, 1)']);
    expect(m.moving).toBe(false);
    expect(m.direction!.__eq__(Cell.RIGHT)).toBe(true);
    expect(g.kernel.world.require(g.runner).transform.position.is_close(new Vec3(3.5, -1.5, 2))).toBe(true);
    expect(g.board().first_at(new Cell(3, 1))).toBe(g.runner);
  });

  it('a turn asked for in a CellEntered handler is taken at that cell (maze runners)', () => {
    const g = mazeSetup((self, payload, s) => {
      if ((payload['cell'] as Cell).__eq__(new Cell(3, 1))) s.mover(self).go(Cell.DOWN);
    });
    g.mover(g.runner).go(Cell.RIGHT);
    g.steps(60);
    expect(g.log).toEqual(['Cell(2, 1)', 'Cell(3, 1)', 'Cell(3, 2)', 'Cell(3, 3)']);
    expect(g.mover(g.runner).moving).toBe(false);
  });

  it('step() moves one cell, refuses walls and the board edge, and queues one step while moving', () => {
    const g = mazeSetup();
    const m = g.mover(g.runner);
    expect(m.step(Cell.UP)).toBe(false);
    expect(m.step(Cell.LEFT)).toBe(false);
    expect(m.moving).toBe(false);
    expect(m.step(Cell.DOWN)).toBe(true);
    expect(m.step(Cell.RIGHT)).toBe(false); // (1, 2) → (2, 2) is a wall
    expect(m.step(Cell.DOWN)).toBe(true);
    g.steps(40);
    expect(g.log).toEqual(['Cell(1, 2)', 'Cell(1, 3)']);
    expect(m.moving).toBe(false);
    expect(code(() => m.step(new Cell(2, 0)))).toBe('PP7500');
  });

  it('stop() halts it with no heading; speed takes stat modifiers', () => {
    const g = mazeSetup();
    const m = g.mover(g.runner);
    m.go(Cell.RIGHT);
    g.steps(3);
    m.stop();
    expect(m.moving).toBe(false);
    expect(m.direction).toBeNull();
    g.steps(30);
    expect(g.log).toEqual([]);
    g.kernel.modify(g.runner, 'grid_mover', 'speed', { multiply: 2, key: 'haste' });
    m.go(Cell.RIGHT);
    g.steps(6);
    expect(g.log).toEqual(['Cell(2, 1)']);
  });

  it('needs a GridCell on its entity', () => {
    const g = setup({ ...prefabs, loose: { components: { grid_mover: {} } } }, [{ id: 'board', prefab: 'board' }, { id: 'l', prefab: 'loose' }]);
    expect(code(() => g.mover(g.id('l')).go(Cell.UP))).toBe('PP7506');
  });

  it('snapshots and restores mid-leg, re-filing the index', () => {
    const g = mazeSetup();
    g.mover(g.runner).go(Cell.RIGHT);
    g.steps(18);
    const snap = g.kernel.snapshot();
    const json = JSON.parse(JSON.stringify(snap)) as typeof snap;
    g.steps(60);
    const after = [...g.log];
    g.log.length = 0;
    g.kernel.restore(json);
    expect((g.cellOf(g.runner)['cell'] as Cell).__eq__(new Cell(2, 1))).toBe(true);
    expect(g.board().first_at(new Cell(2, 1))).toBe(g.runner);
    expect(g.board().first_at(new Cell(0, 0), { tagged: 'wall' })).not.toBeNull();
    expect(g.mover(g.runner).moving).toBe(true);
    g.steps(60);
    expect(g.log).toEqual(after.slice(1));
    // Assigning after a restore still re-files (accessors are reinstalled).
    g.cellOf(g.runner)['cell'] = new Cell(1, 3);
    expect(g.board().first_at(new Cell(1, 3))).toBe(g.runner);
  });
});

describe('grid plugin', () => {
  it('serves one kernel', () => {
    const plugin = grid({ host: { dict: () => ({}) } });
    const project = loadProject(files({ 'scenes/main/scene.json': { entities: [] } }));
    const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
    new Kernel({ project, game, plugins: [plugin] });
    expect(code(() => new Kernel({ project, game, plugins: [plugin] }))).toBe('PP9751');
  });
});
