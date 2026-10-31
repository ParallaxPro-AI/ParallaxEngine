/**
 * `parallax.values.Cell3`: an immutable integer block position. Hashable by value (dict
 * keys, sets), `+`/`-`, JSON form `[x, y, z]`. A cell spans [x, x+1) × [y, y+1) × [z, z+1)
 * in world meters, so `center()` is the middle of the block. Fields hold it with the
 * kernel's `cell3` kind.
 */

import { fail } from '../diagnostics.js';
import { hashNumbers } from '../hash.js';
import { Vec3 } from './vec3.js';

function integer(value: unknown, axis: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return fail('PP3022', `Cell3 ${axis} must be an integer, got ${typeof value === 'number' ? value : String(value)}`, {
    fix: 'Block positions are whole numbers: use ctx.voxels.cell_at(point), or floor() each coordinate.',
  });
}

export class Cell3 {
  static readonly UP = new Cell3(0, 1, 0);
  static readonly DOWN = new Cell3(0, -1, 0);

  readonly #x: number;
  readonly #y: number;
  readonly #z: number;

  constructor(x: number, y: number, z: number) {
    this.#x = integer(x, 'x');
    this.#y = integer(y, 'y');
    this.#z = integer(z, 'z');
  }

  get x(): number { return this.#x; }
  set x(_value: number) { immutable('x'); }
  get y(): number { return this.#y; }
  set y(_value: number) { immutable('y'); }
  get z(): number { return this.#z; }
  set z(_value: number) { immutable('z'); }

  __add__(o: Cell3): Cell3 {
    const other = cell3(o, '+');
    return new Cell3(this.#x + other.#x, this.#y + other.#y, this.#z + other.#z);
  }

  __sub__(o: Cell3): Cell3 {
    const other = cell3(o, '-');
    return new Cell3(this.#x - other.#x, this.#y - other.#y, this.#z - other.#z);
  }

  __eq__(o: unknown): boolean {
    return o instanceof Cell3 && o.#x === this.#x && o.#y === this.#y && o.#z === this.#z;
  }

  __hash__(): number { return hashNumbers(3, this.#x, this.#y, this.#z); }

  /** The middle of the block, in world meters. */
  center(): Vec3 { return new Vec3(this.#x + 0.5, this.#y + 0.5, this.#z + 0.5); }

  toJSON(): [number, number, number] { return [this.#x, this.#y, this.#z]; }
  /** Python `repr`/`str` (pyrt): the same as toString. */
  __repr__(): string { return this.toString(); }

  toString(): string { return `Cell3(${this.#x}, ${this.#y}, ${this.#z})`; }

  /** A cell from its JSON form `[x, y, z]` (saves, snapshots). */
  static fromJSON(value: unknown, where: string): Cell3 {
    if (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isInteger(n))) {
      return new Cell3(value[0] as number, value[1] as number, value[2] as number);
    }
    return fail('PP4102', `${where} must be a block cell [x, y, z] of three integers, got ${JSON.stringify(value)}`);
  }
}

function cell3(value: unknown, op: string): Cell3 {
  if (value instanceof Cell3) return value;
  return fail('PP3022', `Cell3 ${op} needs another Cell3, got ${value === null ? 'None' : String(value)}`);
}

function immutable(axis: string): never {
  return fail('PP3020', `Cell3 is immutable; cannot assign .${axis}`, {
    fix: 'Make a new cell: `Cell3(c.x + 1, c.y, c.z)` or `c + Cell3.UP`.',
  });
}
