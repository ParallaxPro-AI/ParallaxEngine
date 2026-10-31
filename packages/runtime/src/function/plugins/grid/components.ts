/**
 * The `grid`, `grid_cell` and `grid_mover` components (sdk/parallax/grid.pyi). Their
 * methods run with `this` = the component's fields; the owner is `componentEntity(this)`.
 *
 * SDK note: `Grid.center` returns the cell center as a world point (a Vec3, same as
 * `world`), because games call `.xy()`, `.z` and `.with_y()` on it; `spawn(at=)` in a 2D
 * game still takes its draw order from the prefab, never from `at`.
 */

import { Cell, fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Schema } from '../../kernel/index.js';
import { bind, boolArg, cellArg, componentFilter, describe, stepArg, tagFilter } from './args.js';
import { boardCells, boardFields, cellAt, cellCenter, contains, DIAGONAL, GRID, GRID_CELL, GRID_MOVER, ORTHOGONAL, parseLayout } from './board.js';
import type { BoardFields } from './board.js';
import type { GridState } from './state.js';

export const GRID_SCHEMA: Schema = {
  cols: t.int({ default: 8, min: 1 }),
  rows: t.int({ default: 8, min: 1 }),
  /** Meters per cell (x, y in 2D; x, z on the ground in 3D). Required. */
  cell_size: t.vec2(),
  plane: t.enum(['xy', 'xz'], { default: 'xy' }),
  origin: t.enum(['center', 'corner'], { default: 'center' }),
  row_order: t.enum(['down', 'up'], { default: 'down' }),
};

/** `cell` is a Cell in code and [col, row] in data. */
export const GRID_CELL_SCHEMA: Schema = {
  grid: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
  cell: t.cell(),
  snap: t.bool({ default: false }),
};

export const GRID_MOVER_SCHEMA: Schema = {
  speed: t.number({ default: 4, modifiable: true }),
  blocked: t.list({ kind: 'tag' }, { default: [] }),
};

/** How a plugin builds a Python dict (`Grid.parse` returns `dict[Cell, str]`). */
export interface GridHost {
  dict(entries: ReadonlyArray<readonly [Cell, string]>): unknown;
}

type State = () => GridState;

function owner(fields: unknown): EntityId {
  return componentEntity(fields as Fields);
}

function entityGetter(state: State): PropertyDescriptor {
  return {
    get(this: Fields): unknown { return state().kernel.handles.wrap(owner(this)); },
    enumerable: false,
  };
}

function point(value: unknown, where: string): Vec3 | Vec2 {
  if (value instanceof Vec3 || value instanceof Vec2) return value;
  return fail('PP7500', `${where} must be a Vec3 or Vec2, got ${describe(value)}`, { fix: 'Pass a world point, e.g. ctx.input.pointer.world.' });
}

function gridMethods(state: State, host: GridHost): object {
  const board = (fields: Fields): { id: EntityId; fields: BoardFields } => ({ id: owner(fields), fields: boardFields(fields) });
  const methods = {
    center(this: Fields, ...args: unknown[]): Vec3 {
      const a = bind('center', args, ['cell'], [], ['cell']);
      return cellCenter(state().board(owner(this)), cellArg(a['cell'], 'center() cell'));
    },
    cell_at(this: Fields, ...args: unknown[]): Cell | null {
      const a = bind('cell_at', args, ['point'], [], ['point']);
      return cellAt(state().board(owner(this)), point(a['point'], 'cell_at() point')) ?? null;
    },
    contains(this: Fields, ...args: unknown[]): boolean {
      const a = bind('contains', args, ['cell'], [], ['cell']);
      return contains(boardFields(this), cellArg(a['cell'], 'contains() cell'));
    },
    neighbors(this: Fields, ...args: unknown[]): Cell[] {
      const a = bind('neighbors', args, ['cell'], ['diagonal'], ['cell']);
      const cell = cellArg(a['cell'], 'neighbors() cell');
      const diagonal = a['diagonal'] === undefined ? false : boolArg(a['diagonal'], 'neighbors() diagonal');
      const b = boardFields(this);
      return [...ORTHOGONAL, ...(diagonal ? DIAGONAL : [])].map((s) => cell.__add__(s)).filter((c) => contains(b, c));
    },
    cells(this: Fields, ...args: unknown[]): Generator<Cell> {
      bind('cells', args, []);
      return boardCells(boardFields(this));
    },
    at(this: Fields, ...args: unknown[]): unknown[] {
      return piecesAt(state, this, 'at', args).map((id) => state().kernel.handles.wrap(id));
    },
    first_at(this: Fields, ...args: unknown[]): unknown {
      const [first] = piecesAt(state, this, 'first_at', args);
      return first === undefined ? null : state().kernel.handles.wrap(first);
    },
    parse(this: Fields, ...args: unknown[]): unknown {
      const a = bind('parse', args, ['layout'], [], ['layout']);
      return host.dict(parseLayout(boardFields(this), a['layout']));
    },
    path(this: Fields, ...args: unknown[]): Cell[] {
      const a = bind('path', args, ['start', 'end'], ['blocked', 'diagonal'], ['start', 'end']);
      const b = board(this);
      const blocked = tagFilter(a['blocked'], 'path() blocked');
      const diagonal = a['diagonal'] === undefined ? false : boolArg(a['diagonal'], 'path() diagonal');
      const open = (c: Cell): boolean => contains(b.fields, c) && !state().blockedAt(b.id, c, blocked);
      return shortestPath(cellArg(a['start'], 'path() start'), cellArg(a['end'], 'path() end'), open, diagonal);
    },
  };
  Object.defineProperty(methods, 'entity', entityGetter(state));
  return methods;
}

function piecesAt(state: State, fields: Fields, name: string, args: readonly unknown[]): EntityId[] {
  const a = bind(name, args, ['cell'], ['tagged', 'having'], ['cell']);
  return state().at(owner(fields), cellArg(a['cell'], `${name}() cell`),
    tagFilter(a['tagged'], `${name}() tagged`), componentFilter(a['having'], `${name}() having`));
}

/**
 * Breadth-first shortest path from `start` to `end` through cells `open` accepts, start
 * and end included ([] when unreachable). Neighbours are tried up, down, left, right
 * (then the diagonals), so ties resolve the same way every run. A diagonal step may not
 * cut a corner past a closed orthogonal neighbour.
 */
export function shortestPath(start: Cell, end: Cell, open: (cell: Cell) => boolean, diagonal: boolean): Cell[] {
  if (!open(end)) return [];
  if (start.__eq__(end)) return [start];
  const steps = [...ORTHOGONAL, ...(diagonal ? DIAGONAL : [])];
  const key = (c: Cell): string => `${c.col},${c.row}`;
  const cameFrom = new Map<string, Cell | null>([[key(start), null]]);
  const queue: Cell[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    for (const step of steps) {
      const next = cell.__add__(step);
      const k = key(next);
      if (cameFrom.has(k) || !open(next)) continue;
      if (step.col !== 0 && step.row !== 0
        && (!open(cell.__add__(new Cell(step.col, 0))) || !open(cell.__add__(new Cell(0, step.row))))) continue;
      cameFrom.set(k, cell);
      if (next.__eq__(end)) {
        const path: Cell[] = [next];
        for (let c = cameFrom.get(k)!; c !== null; c = cameFrom.get(key(c))!) path.unshift(c);
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

function moverMethods(state: State): object {
  const methods = {
    step(this: Fields, ...args: unknown[]): boolean {
      const a = bind('step', args, ['direction'], [], ['direction']);
      return state().step(owner(this), stepArg(a['direction'], 'step() direction'));
    },
    go(this: Fields, ...args: unknown[]): null {
      const a = bind('go', args, ['direction'], [], ['direction']);
      state().go(owner(this), stepArg(a['direction'], 'go() direction'));
      return null;
    },
    stop(this: Fields, ...args: unknown[]): null {
      bind('stop', args, []);
      state().stop(owner(this));
      return null;
    },
  };
  Object.defineProperties(methods, {
    entity: entityGetter(state),
    moving: { get(this: Fields): boolean { return state().moving(owner(this)); }, enumerable: false },
    direction: { get(this: Fields): Cell | null { return state().direction(owner(this)); }, enumerable: false },
  });
  return methods;
}

export function gridComponents(state: State, host: GridHost): ComponentDef[] {
  const cellMethods = {};
  Object.defineProperty(cellMethods, 'entity', entityGetter(state));
  return [
    { id: GRID, schema: GRID_SCHEMA, methods: gridMethods(state, host) },
    { id: GRID_CELL, schema: GRID_CELL_SCHEMA, methods: cellMethods },
    { id: GRID_MOVER, schema: GRID_MOVER_SCHEMA, methods: moverMethods(state) },
  ];
}
