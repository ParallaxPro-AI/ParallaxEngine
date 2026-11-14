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
 *
 * `layout="hex"` lays pointy-top hexagons in offset rows ("odd-r"): every odd row is
 * shifted half a cell along +x, `cell_size.x` is the distance between neighbouring
 * centers in a row and `cell_size.y` the distance between rows (x · √3/2 for regular
 * hexagons). A point belongs to the nearest center, so `cell_at` reads hexagons exactly.
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
  readonly layout: 'square' | 'hex';
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

export function isHex(board: BoardFields): boolean {
  return board.layout === 'hex';
}

/** How wide the board is in cells: a hex board's shifted rows stick out half a cell. */
function widthInCells(board: BoardFields): number {
  return board.cols + (isHex(board) && board.rows > 1 ? 0.5 : 0);
}

/** The world-space width and depth of the board, in meters. */
export function boardExtent(board: BoardFields): { width: number; depth: number } {
  return { width: widthInCells(board) * board.cell_size.x, depth: board.rows * board.cell_size.y };
}

/** In-plane coordinates (u along columns, v along the rows' world direction) of a cell's center. */
function cellUV(board: BoardFields, cell: Cell): { u: number; v: number } {
  const w = board.cell_size.x;
  const h = board.cell_size.y;
  const sign = board.row_order === 'down' ? -1 : 1;
  const shift = isHex(board) && cell.row % 2 !== 0 ? 0.5 : 0;
  let u = (cell.col + 0.5 + shift) * w;
  let v = sign * (cell.row + 0.5) * h;
  if (board.origin === 'center') {
    u -= (widthInCells(board) * w) / 2;
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
  const across = origin === 'center' ? u + (widthInCells(board.fields) * size.x) / 2 : u;
  const along = origin === 'center' ? sign * v + (rows * size.y) / 2 : sign * v;
  const cell = isHex(board.fields)
    ? nearestHex(across / size.x, along / size.y, size.y / size.x)
    : new Cell(Math.floor(across / size.x), Math.floor(along / size.y));
  return contains(board.fields, cell) ? cell : undefined;
}

/**
 * The hex whose center is nearest a point given in cells (`x` along columns, `y` along
 * rows), measured as if the hexagons were regular: rows are rescaled from `aspect`
 * (row spacing / column spacing) to √3/2, so the nearest center is the hexagon the point
 * is in. Ties go to the lower row, then the lower column.
 */
function nearestHex(x: number, y: number, aspect: number): Cell {
  const k = Math.sqrt(3) / 2 / aspect;
  const row0 = Math.floor(y);
  let best: Cell | undefined;
  let bestD = Infinity;
  for (let row = row0 - 1; row <= row0 + 1; row++) {
    const shift = row % 2 !== 0 ? 0.5 : 0;
    const col0 = Math.floor(x - shift);
    for (let col = col0 - 1; col <= col0 + 1; col++) {
      const du = x - (col + 0.5 + shift);
      const dv = (y - (row + 0.5)) * aspect * k;
      const d = du * du + dv * dv;
      if (d < bestD - 1e-12) {
        bestD = d;
        best = new Cell(col, row);
      }
    }
  }
  return best!;
}

/** The six neighbours of a hex in offset rows: left, right, then the row above and below. */
export function hexSteps(cell: Cell): Cell[] {
  const odd = cell.row % 2 !== 0;
  const a = odd ? 0 : -1;
  const b = odd ? 1 : 0;
  return [new Cell(-1, 0), new Cell(1, 0), new Cell(a, -1), new Cell(b, -1), new Cell(a, 1), new Cell(b, 1)];
}

function cube(cell: Cell): { x: number; z: number; y: number } {
  const x = cell.col - (cell.row - (cell.row & 1)) / 2;
  const z = cell.row;
  return { x, z, y: -x - z };
}

/**
 * Steps between two cells: on a hex board the hex distance; on a square board the
 * Manhattan distance, or with `diagonal` the king's-move (Chebyshev) distance.
 */
export function cellDistance(board: BoardFields, a: Cell, b: Cell, diagonal: boolean): number {
  if (isHex(board)) {
    const p = cube(a);
    const q = cube(b);
    return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.z - q.z));
  }
  const dc = Math.abs(a.col - b.col);
  const dr = Math.abs(a.row - b.row);
  return diagonal ? Math.max(dc, dr) : dc + dr;
}

/** True when `b` is one step from `a` on this board (any of the eight on a square board). */
export function adjacent(board: BoardFields, a: Cell, b: Cell): boolean {
  if (!isHex(board)) return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)) === 1;
  return cellDistance(board, a, b, false) === 1;
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
