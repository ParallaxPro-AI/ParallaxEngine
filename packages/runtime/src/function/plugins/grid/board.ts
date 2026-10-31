/**
 * Board geometry: where a Grid's cells are in the world. A grid lies in its entity's
 * local plane ("xy" for 2D boards, "xz" for the 3D ground), positioned and rotated with
 * the entity (its scale is ignored: `cell_size` is meters). In-plane, columns run along
 * +x; rows run along -y/-z with `row_order="down"` (row 0 on top, as text reads) and
 * along +y/+z with "up". `origin="center"` puts the board's middle on the entity;
 * "corner" puts the outer corner of cell (0, 0) there.
 *
 * Moving a piece onto a cell changes only its in-plane coordinates: in 2D its z (draw
 * order) is kept, on the ground its height.
 */

import { Cell, fail, Vec2, Vec3 } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import type { TransformNode } from '../../kernel/index.js';
import { describe } from './args.js';

export const GRID = 'grid';
export const GRID_CELL = 'grid_cell';
export const GRID_MOVER = 'grid_mover';

/** A Grid component's fields, read fresh on every use (games resize boards at runtime). */
export interface BoardFields {
  readonly cols: number;
  readonly rows: number;
  readonly cell_size: Vec2;
  readonly plane: 'xy' | 'xz';
  readonly origin: 'center' | 'corner';
  readonly row_order: 'down' | 'up';
}

/** A board: its fields and its entity's transform. */
export interface Board {
  readonly fields: BoardFields;
  readonly transform: TransformNode;
}

export function boardFields(fields: Fields): BoardFields {
  const board = fields as unknown as BoardFields;
  const size = board.cell_size;
  if (!(size instanceof Vec2) || !(size.x > 0) || !(size.y > 0)) {
    fail('PP7501', `Grid cell_size must be a Vec2 with positive sides, got ${size instanceof Vec2 ? String(size) : describe(size)}`, {
      fix: 'Set "cell_size": [width, height] in meters, e.g. [1, 1].',
    });
  }
  if (!Number.isInteger(board.cols) || board.cols < 1 || !Number.isInteger(board.rows) || board.rows < 1) {
    fail('PP7501', `A Grid needs at least one column and one row, got ${board.cols} × ${board.rows}`, {
      fix: 'Set cols and rows to whole numbers >= 1.',
    });
  }
  return board;
}

export function contains(board: BoardFields, cell: Cell): boolean {
  return cell.col >= 0 && cell.row >= 0 && cell.col < board.cols && cell.row < board.rows;
}

/** In-plane coordinates (u along columns, v along the rows' world direction) of a cell's center. */
function cellUV(board: BoardFields, cell: Cell): { u: number; v: number } {
  const w = board.cell_size.x;
  const h = board.cell_size.y;
  const sign = board.row_order === 'down' ? -1 : 1;
  let u = (cell.col + 0.5) * w;
  let v = sign * (cell.row + 0.5) * h;
  if (board.origin === 'center') {
    u -= (board.cols * w) / 2;
    v -= (sign * board.rows * h) / 2;
  }
  return { u, v };
}

function localPoint(board: BoardFields, u: number, v: number, normal: number): Vec3 {
  return board.plane === 'xy' ? new Vec3(u, v, normal) : new Vec3(u, normal, v);
}

function planeOf(board: BoardFields, local: Vec3): { u: number; v: number; normal: number } {
  return board.plane === 'xy' ? { u: local.x, v: local.y, normal: local.z } : { u: local.x, v: local.z, normal: local.y };
}

function toWorld(board: Board, local: Vec3): Vec3 {
  return board.transform.worldRotation().rotate(local).__add__(board.transform.worldPosition());
}

function toLocal(board: Board, world: Vec3): Vec3 {
  return board.transform.worldRotation().inverse().rotate(world.__sub__(board.transform.worldPosition()));
}

/** A cell's center as a world point on the board's plane. */
export function cellCenter(board: Board, cell: Cell): Vec3 {
  const { u, v } = cellUV(board.fields, cell);
  return toWorld(board, localPoint(board.fields, u, v, 0));
}

/**
 * The cell under a world point, or undefined off the board. A Vec2 is a point on the
 * board's plane: (x, y) for "xy", (x, z) for "xz".
 */
export function cellAt(board: Board, point: Vec3 | Vec2): Cell | undefined {
  let world: Vec3;
  if (point instanceof Vec3) world = point;
  else {
    const at = board.transform.worldPosition();
    world = board.fields.plane === 'xy' ? new Vec3(point.x, point.y, at.z) : new Vec3(point.x, at.y, point.y);
  }
  const { u, v } = planeOf(board.fields, toLocal(board, world));
  const { cols, rows, cell_size: size, origin, row_order: order } = board.fields;
  const sign = order === 'down' ? -1 : 1;
  const across = origin === 'center' ? u + (cols * size.x) / 2 : u;
  const along = origin === 'center' ? sign * v + (rows * size.y) / 2 : sign * v;
  const cell = new Cell(Math.floor(across / size.x), Math.floor(along / size.y));
  return contains(board.fields, cell) ? cell : undefined;
}

/**
 * Where `current` lands when its in-plane coordinates move to `target`'s (a cell center):
 * the coordinate off the plane (2D draw order, height above the ground) is kept.
 */
export function onPlane(board: Board, current: Vec3, target: Vec3): Vec3 {
  const keep = planeOf(board.fields, toLocal(board, current)).normal;
  const { u, v } = planeOf(board.fields, toLocal(board, target));
  return toWorld(board, localPoint(board.fields, u, v, keep));
}

/** Neighbour offsets: up, down, left, right, then the diagonals. */
export const ORTHOGONAL: readonly Cell[] = [Cell.UP, Cell.DOWN, Cell.LEFT, Cell.RIGHT];
export const DIAGONAL: readonly Cell[] = [
  Cell.UP.__add__(Cell.LEFT), Cell.UP.__add__(Cell.RIGHT), Cell.DOWN.__add__(Cell.LEFT), Cell.DOWN.__add__(Cell.RIGHT),
];

export function* boardCells(board: BoardFields): Generator<Cell> {
  for (let row = 0; row < board.rows; row++) for (let col = 0; col < board.cols; col++) yield new Cell(col, row);
}

/** A text layout as (cell, character) pairs: the first line is the top row. */
export function parseLayout(board: BoardFields, layout: unknown): Array<[Cell, string]> {
  if (typeof layout === 'string') fail('PP7502', 'parse() takes a list of strings, got one string', { fix: 'Split it into lines: text.split("\\n").' });
  const lines = typeof layout === 'object' && layout !== null && Symbol.iterator in layout
    ? [...(layout as Iterable<unknown>)]
    : fail('PP7502', `parse() takes a list of strings, got ${describe(layout)}`, { fix: 'Pass the layout lines, top line first.' });
  if (lines.length > board.rows) {
    fail('PP7502', `The layout has ${lines.length} lines but the grid has ${board.rows} rows`, {
      fix: 'Make the Grid taller (rows) or the layout shorter.',
    });
  }
  const out: Array<[Cell, string]> = [];
  lines.forEach((line, i) => {
    if (typeof line !== 'string') fail('PP7502', `parse() line ${i} must be a string, got ${describe(line)}`);
    const chars = [...line];
    if (chars.length > board.cols) {
      fail('PP7502', `Layout line ${i} has ${chars.length} characters but the grid has ${board.cols} columns`, {
        fix: 'Make the Grid wider (cols) or the line shorter.',
      });
    }
    const row = board.row_order === 'down' ? i : board.rows - 1 - i;
    chars.forEach((ch, col) => out.push([new Cell(col, row), ch]));
  });
  return out;
}
