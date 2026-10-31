import { fail } from '../diagnostics.js';
import { hashNumbers } from '../hash.js';

function integer(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return fail('PP3022', `Cell ${what} must be an integer, got ${typeof value === 'number' ? value : String(value)}`, {
    fix: 'Cells are whole (col, row) pairs: round first, e.g. Cell(round(x), round(y)).',
  });
}

/**
 * Immutable integer grid cell (col, row) — `parallax.values.Cell`. Hashable by value, so
 * usable as dict keys and in sets. JSON form: [col, row]. Directions are in cell space:
 * `Cell.UP` is row - 1 whatever a grid's `row_order`.
 */
export class Cell {
  static readonly UP = new Cell(0, -1);
  static readonly DOWN = new Cell(0, 1);
  static readonly LEFT = new Cell(-1, 0);
  static readonly RIGHT = new Cell(1, 0);

  readonly #col: number;
  readonly #row: number;

  constructor(col: number, row: number) {
    this.#col = integer(col, 'col');
    this.#row = integer(row, 'row');
  }

  get col(): number { return this.#col; }
  set col(_value: number) { immutable('col'); }
  get row(): number { return this.#row; }
  set row(_value: number) { immutable('row'); }

  __add__(o: Cell): Cell {
    const other = cell(o, '+');
    return new Cell(this.#col + other.#col, this.#row + other.#row);
  }

  __sub__(o: Cell): Cell {
    const other = cell(o, '-');
    return new Cell(this.#col - other.#col, this.#row - other.#row);
  }

  __mul__(k: number): Cell {
    const n = integer(k, 'multiplier');
    return new Cell(this.#col * n, this.#row * n);
  }

  __eq__(o: unknown): boolean { return o instanceof Cell && o.#col === this.#col && o.#row === this.#row; }
  __hash__(): number { return hashNumbers(this.#col, this.#row); }

  manhattan(o: Cell): number {
    const other = cell(o, 'manhattan()');
    return Math.abs(this.#col - other.#col) + Math.abs(this.#row - other.#row);
  }

  /** The stored (JSON) form. */
  toJSON(): [number, number] { return [this.#col, this.#row]; }
  /** Python `repr`/`str` (pyrt): the same as toString. */
  __repr__(): string { return this.toString(); }

  toString(): string { return `Cell(${this.#col}, ${this.#row})`; }

  /** A cell from its JSON form `[col, row]` (data files, saves). */
  static fromJSON(value: unknown, where: string): Cell {
    if (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n))) {
      return new Cell(value[0] as number, value[1] as number);
    }
    return fail('PP4102', `${where} must be a cell [col, row] of two integers, got ${JSON.stringify(value)}`);
  }
}

function cell(value: unknown, op: string): Cell {
  if (value instanceof Cell) return value;
  return fail('PP3022', `Cell ${op} needs another Cell, got ${value === null ? 'None' : String(value)}`);
}

function immutable(axis: string): never {
  fail('PP3020', `Cell is immutable; cannot assign .${axis}`, {
    fix: `Make a new cell: \`Cell(c.col + 1, c.row)\` or \`c + Cell.RIGHT\`.`,
  });
}
