/**
 * A tilemap's grid, read from the `tilemap` component's fields (sdk `Tilemap`): `rows` are
 * strings, top row first, one character per cell; ' ' and '.' are empty; every other
 * character names an entry of `tiles`. Cell (col, row) covers local
 * offset + [col·w, (col+1)·w] × [(n-1-row)·h, (n-row)·h] — the entity's position (plus
 * `offset`) is the map's bottom-left corner, +y up. render2d draws the cells, physics2d builds the colliders of
 * the solid ones; both read the grid through this one parser so they never disagree.
 */

import { fail } from '../diagnostics.js';

export const EMPTY_TILES = ' .';

export interface TileCell {
  readonly col: number;
  readonly row: number;
  /** The `tiles` key. */
  readonly key: string;
}

export interface TileGrid {
  /** Local position of the bottom-left corner. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly rows: number;
  readonly cols: number;
  readonly cells: readonly TileCell[];
}

/** Local center of a cell (meters from the map's bottom-left corner). */
export function cellCenter(grid: TileGrid, col: number, row: number): readonly [number, number] {
  return [grid.offsetX + (col + 0.5) * grid.width, grid.offsetY + (grid.rows - 1 - row + 0.5) * grid.height];
}

/** Parse the grid; PP3615 for a character with no tile, PP3616 for a bad size or rows. */
export function tileGrid(fields: Readonly<Record<string, unknown>>, where: string): TileGrid {
  const size = fields['tile_size'] as { x: number; y: number } | undefined;
  const width = size?.x ?? NaN;
  const height = size?.y ?? NaN;
  if (!(width > 0 && height > 0)) fail('PP3616', `${where}.tile_size is (${width}, ${height}); both must be above 0`);
  const offset = fields['offset'] as { x: number; y: number } | undefined;
  const rows = fields['rows'];
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'string')) {
    fail('PP3616', `${where}.rows must be a list of strings (top row first, one character per tile)`);
  }
  const tiles = (fields['tiles'] ?? {}) as Readonly<Record<string, unknown>>;
  const cells: TileCell[] = [];
  let cols = 0;
  (rows as string[]).forEach((line, row) => {
    const chars = [...line];
    cols = Math.max(cols, chars.length);
    chars.forEach((key, col) => {
      if (EMPTY_TILES.includes(key)) return;
      if (!(key in tiles)) {
        fail('PP3615', `${where}.rows[${row}] column ${col} is "${key}", which is not in tiles`, {
          fix: `Tiles: ${Object.keys(tiles).map((k) => `"${k}"`).join(', ') || '(none)'}; use " " or "." for an empty cell.`,
        });
      }
      cells.push({ col, row, key });
    });
  });
  return { offsetX: offset?.x ?? 0, offsetY: offset?.y ?? 0, width, height, rows: rows.length, cols, cells };
}

/**
 * Solid cells merged into horizontal runs (one box per run of adjacent solid cells in a
 * row): fewer colliders, and no seams for a body sliding along a floor.
 */
export function solidRuns(grid: TileGrid, solid: (key: string) => boolean): { col: number; row: number; length: number }[] {
  const runs: { col: number; row: number; length: number }[] = [];
  const byRow = new Map<number, number[]>();
  for (const c of grid.cells) {
    if (!solid(c.key)) continue;
    const list = byRow.get(c.row) ?? [];
    list.push(c.col);
    byRow.set(c.row, list);
  }
  for (const [row, list] of [...byRow].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a - b);
    let start = list[0]!;
    let prev = start;
    for (const col of [...list.slice(1), Infinity]) {
      if (col === prev + 1) { prev = col; continue; }
      runs.push({ col: start, row, length: prev - start + 1 });
      start = col;
      prev = col;
    }
  }
  return runs;
}
