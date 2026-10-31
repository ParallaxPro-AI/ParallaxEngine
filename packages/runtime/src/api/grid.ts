/**
 * `parallax.grid` (sdk/parallax/grid.pyi): the Grid, GridCell and GridMover handles, the
 * CellEntered event, and `Cell` (re-exported from `parallax.values`). The behavior lives
 * in the grid plugin; this module is the Python-facing names for it.
 */

import { Cell } from '../core/index.js';
import {
  GRID, GRID_CELL, GRID_CELL_SCHEMA, GRID_EVENTS, GRID_MOVER, GRID_MOVER_SCHEMA, GRID_SCHEMA, grid as gridPlugin,
} from '../function/plugins/grid/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';
import { dict_of } from './pyrt/collections.js';

export { Cell };

/** `entity.get(Grid)`: cols, rows, cell_size… and center / cell_at / at / parse / path. */
export const Grid = componentHandle({ id: GRID, schema: GRID_SCHEMA }, 'Grid');
/** `GridCell(cell=Cell(1, 2), snap=True)`: places an entity on a grid. */
export const GridCell = componentHandle({ id: GRID_CELL, schema: GRID_CELL_SCHEMA }, 'GridCell');
/** `entity.get(GridMover).go(Cell.LEFT)`: cell-to-cell movement. */
export const GridMover = componentHandle({ id: GRID_MOVER, schema: GRID_MOVER_SCHEMA }, 'GridMover');

export const CellEntered = eventHandle(GRID_EVENTS.cellEntered, 'CellEntered');

/** `parallax.plugins.grid()`: boards and tile maps. */
export function grid(...args: unknown[]): KernelPlugin {
  bindArgs('grid', args, {});
  return gridPlugin({ host: { dict: (entries) => dict_of(entries.flatMap(([cell, ch]) => [cell, ch])) } });
}
