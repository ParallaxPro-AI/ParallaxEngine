/**
 * grid — boards, tile maps and anything laid out in cells (sdk/parallax/grid.pyi). Contributes the `grid`, `grid_cell` and `grid_mover` components and
 * the `cell_entered` event; moves movers in `update` and keeps snapped pieces on their
 * cells in `late_update` (one engine system, before the game's).
 *
 * One `grid(...)` value serves one kernel (its component methods are bound to it).
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { gridComponents } from './components.js';
import type { GridHost } from './components.js';
import { GRID_EVENTS, GridState } from './state.js';

export { GRID, GRID_CELL, GRID_MOVER } from './board.js';
export { GRID_CELL_SCHEMA, GRID_MOVER_SCHEMA, GRID_SCHEMA, shortestPath } from './components.js';
export type { GridHost } from './components.js';
export { GRID_EVENTS } from './state.js';
export type { GridSnapshot } from './state.js';

export interface GridOptions {
  /** Builds the Python dict `Grid.parse` returns (the api supplies its `dict`). */
  readonly host: GridHost;
}

export function grid(options: GridOptions): KernelPlugin {
  let state: GridState | undefined;
  let installedOn: Kernel | undefined;
  const current = (): GridState => {
    if (state === undefined) fail('PP9750', 'The grid plugin is used before its kernel was built');
    return state;
  };
  const system: SystemDef = {
    id: 'grid.movers',
    scenes: [],
    handlers: [],
    create: () => ({
      update: (_ctx: unknown, dt: number) => current().update(dt),
      late_update: () => current().snapAll(),
    }),
  };

  return {
    id: 'grid',
    components: gridComponents(current, options.host),
    events: Object.values(GRID_EVENTS),
    systems: [system],
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP9751', 'This grid plugin is already installed in another kernel', { fix: 'Call grid() once per kernel.' });
      }
      installedOn = kernel;
      const created = new GridState(kernel);
      state = created;
      kernel.observeEntities({
        added: (records) => created.added(records),
        removed: (records) => created.removed(records),
        changed: (record) => created.changed(record),
      });
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved),
  };
}
