import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../diagnostics.js';
import { Cell } from './cell.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : 'not a ParallaxError';
  }
  return undefined;
}

describe('Cell', () => {
  it('implements the arithmetic compiled Python calls', () => {
    const c = new Cell(2, 3);
    expect(c.__add__(Cell.RIGHT).__eq__(new Cell(3, 3))).toBe(true);
    expect(c.__sub__(new Cell(1, 1)).__eq__(new Cell(1, 2))).toBe(true);
    expect(Cell.UP.__mul__(3).__eq__(new Cell(0, -3))).toBe(true);
    expect(Cell.RIGHT.__mul__(-1).__eq__(Cell.LEFT)).toBe(true);
    expect(c.manhattan(new Cell(-1, 5))).toBe(5);
  });

  it('directions are in cell space: UP is row - 1', () => {
    expect(Cell.UP.toJSON()).toEqual([0, -1]);
    expect(Cell.DOWN.toJSON()).toEqual([0, 1]);
    expect(Cell.LEFT.toJSON()).toEqual([-1, 0]);
    expect(Cell.RIGHT.toJSON()).toEqual([1, 0]);
  });

  it('is equal and hashes by value (dict keys, sets)', () => {
    expect(new Cell(1, 2).__eq__(new Cell(1, 2))).toBe(true);
    expect(new Cell(1, 2).__eq__(new Cell(2, 1))).toBe(false);
    expect(new Cell(1, 2).__eq__([1, 2])).toBe(false);
    expect(new Cell(1, 2).__hash__()).toBe(new Cell(1, 2).__hash__());
    expect(new Cell(1, 2).__hash__()).not.toBe(new Cell(2, 1).__hash__());
  });

  it('round-trips its JSON form [col, row]', () => {
    expect(JSON.stringify({ at: new Cell(4, -1) })).toBe('{"at":[4,-1]}');
    expect(Cell.fromJSON([4, -1], 'x').__eq__(new Cell(4, -1))).toBe(true);
    expect(code(() => Cell.fromJSON([1.5, 2], 'x'))).toBe('PP4102');
    expect(code(() => Cell.fromJSON([1, 2, 3], 'x'))).toBe('PP4102');
    expect(String(new Cell(1, 2))).toBe('Cell(1, 2)');
  });

  it('is immutable and integer-only, with coded errors', () => {
    const c = new Cell(1, 2);
    expect(code(() => { c.col = 5; })).toBe('PP3020');
    expect(c.col).toBe(1);
    expect(code(() => new Cell(0.5, 1))).toBe('PP3022');
    expect(code(() => c.__mul__(1.5))).toBe('PP3022');
    expect(code(() => c.__add__(null as unknown as Cell))).toBe('PP3022');
  });
});
