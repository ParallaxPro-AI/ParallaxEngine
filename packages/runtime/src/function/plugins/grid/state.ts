/**
 * The grid plugin's state outside components: the occupancy index ("what is at this
 * cell" is a lookup), the spawn order that makes every answer deterministic, and the
 * movers' legs between cells.
 *
 * Index upkeep. A GridCell's `cell` and `grid` fields become accessors when the plugin
 * first sees the component (spawn, `entity.add`, restore): assigning either re-files the
 * piece at once, so `grid.at(cell)` is right on the next line. Pieces leave the index
 * when their component is removed or their entity is torn down.
 */

import { Cell, fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import { cellArg, describe, tagId } from './args.js';
import { boardFields, cellCenter, contains, GRID, GRID_CELL, GRID_MOVER, onPlane } from './board.js';
import type { Board } from './board.js';

export const GRID_EVENTS = {
  cellEntered: { id: 'cell_entered', target: 'entity' },
} as const satisfies Record<string, EventDef>;

/** Progress is compared against 1 with this slack (a sum of float frame times). */
const ARRIVAL_TOLERANCE = 1e-9;

interface Piece {
  readonly fields: Fields;
  /** The grid it is filed under, and its cell key there; undefined while unfiled. */
  grid: EntityId | undefined;
  key: string | undefined;
}

interface Leg {
  readonly from: Cell;
  readonly to: Cell;
  progress: number;
  /** The frame it started: a turn requested in that frame re-plans it from `from`. */
  readonly frame: number;
}

interface Mover {
  heading: Cell | null;
  /** go(): keep stepping along `heading`; step(): stop after the leg (and any queued step). */
  continuous: boolean;
  queued: Cell | null;
  leg: Leg | null;
}

interface SavedMover {
  readonly id: number;
  readonly heading: [number, number] | null;
  readonly continuous: boolean;
  readonly queued: [number, number] | null;
  readonly leg: { readonly from: [number, number]; readonly to: [number, number]; readonly progress: number } | null;
}

export interface GridSnapshot {
  readonly movers: readonly SavedMover[];
}

function keyOf(cell: Cell): string {
  return `${cell.col},${cell.row}`;
}

export class GridState {
  readonly kernel: Kernel;
  readonly #seq = new Map<EntityId, number>();
  #nextSeq = 0;
  /** grid entity → cell key → pieces (in filing order; answers sort by spawn order). */
  readonly #boards = new Map<EntityId, Map<string, EntityId[]>>();
  readonly #pieces = new Map<EntityId, Piece>();
  readonly #movers = new Map<EntityId, Mover>();

  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }

  // ── Entity lifecycle ─────────────────────────────────────────────────────────

  added(records: readonly EntityRecord[]): void {
    for (const record of records) this.#seq.set(record.id, this.#nextSeq++);
    for (const record of records) this.#reconcile(record, true);
  }

  changed(record: EntityRecord): void {
    this.#reconcile(record, true);
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) this.#forget(record.id);
  }

  #reconcile(record: EntityRecord, snap: boolean): void {
    const fields = record.components.get(GRID_CELL);
    const piece = this.#pieces.get(record.id);
    if (piece !== undefined && piece.fields !== fields) {
      this.#unfile(record.id, piece);
      this.#pieces.delete(record.id);
    }
    if (fields !== undefined && !this.#pieces.has(record.id)) this.#adopt(record.id, fields, snap);
    if (!record.components.has(GRID)) this.#dropBoard(record.id);
    if (!record.components.has(GRID_MOVER)) this.#movers.delete(record.id);
  }

  #forget(id: EntityId): void {
    const piece = this.#pieces.get(id);
    if (piece !== undefined) this.#unfile(id, piece);
    this.#pieces.delete(id);
    this.#dropBoard(id);
    this.#movers.delete(id);
    this.#seq.delete(id);
  }

  #dropBoard(id: EntityId): void {
    if (!this.#boards.delete(id)) return;
    for (const piece of this.#pieces.values()) {
      if (piece.grid === id) {
        piece.grid = undefined;
        piece.key = undefined;
      }
    }
  }

  /** Turn `cell` and `grid` into accessors that re-file the piece, and file it. */
  #adopt(id: EntityId, fields: Fields, snap: boolean): void {
    let cell = cellArg(fields['cell'], 'GridCell.cell');
    let grid = fields['grid'] ?? null;
    Object.defineProperty(fields, 'cell', {
      get: () => cell,
      set: (value: unknown) => {
        cell = cellArg(value, 'GridCell.cell');
        this.#file(id, true);
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(fields, 'grid', {
      get: () => grid,
      set: (value: unknown) => {
        grid = value ?? null;
        this.#file(id, true);
      },
      enumerable: true,
      configurable: true,
    });
    this.#pieces.set(id, { fields, grid: undefined, key: undefined });
    this.#file(id, snap);
  }

  #file(id: EntityId, snap: boolean): void {
    const piece = this.#pieces.get(id);
    if (piece === undefined) return;
    this.#unfile(id, piece);
    // A piece of an entity destroyed this phase stays out of the index.
    if (!this.kernel.world.isAlive(id)) return;
    const grid = this.#resolve(piece.fields);
    const key = keyOf(piece.fields['cell'] as Cell);
    let cells = this.#boards.get(grid);
    if (cells === undefined) {
      cells = new Map();
      this.#boards.set(grid, cells);
    }
    const list = cells.get(key);
    if (list === undefined) cells.set(key, [id]);
    else list.push(id);
    piece.grid = grid;
    piece.key = key;
    if (snap && piece.fields['snap'] === true) this.#snap(id, piece);
  }

  #unfile(id: EntityId, piece: Piece): void {
    if (piece.grid === undefined || piece.key === undefined) return;
    const cells = this.#boards.get(piece.grid);
    const list = cells?.get(piece.key);
    if (list !== undefined) {
      list.splice(list.indexOf(id), 1);
      if (list.length === 0) cells!.delete(piece.key);
    }
    piece.grid = undefined;
    piece.key = undefined;
  }

  /** The grid a GridCell belongs to: its `grid`, or else the only Grid in the scene. */
  #resolve(fields: Fields): EntityId {
    const given = fields['grid'];
    if (given === null || given === undefined) {
      const grids = this.kernel.world.query([GRID]);
      if (grids.length === 1) return grids[0]![0];
      if (grids.length === 0) {
        fail('PP7503', 'A GridCell needs a Grid, and there is none in the scene', {
          fix: 'Place or spawn the entity with the Grid first, or set GridCell(grid=...).',
        });
      }
      return fail('PP7504', `A GridCell with grid=None needs exactly one Grid in the scene, but there are ${grids.length}`, {
        fix: 'Say which board it is on: GridCell(cell=..., grid=board_entity).',
      });
    }
    const id = this.kernel.handles.unwrap(given);
    const record = id === undefined ? undefined : this.kernel.world.get(id);
    if (record === undefined || !record.components.has(GRID)) {
      fail('PP7505', `GridCell.grid must be a live entity with a Grid, got ${describe(given)}`, {
        fix: 'Point it at the board entity (the one with the Grid component), or leave it None.',
      });
    }
    return record.id;
  }

  // ── Questions ────────────────────────────────────────────────────────────────

  /** A grid entity's board (also readable while it is being destroyed). */
  board(gridId: EntityId): Board {
    const record = this.kernel.world.peek(gridId);
    const fields = record?.components.get(GRID);
    if (record === undefined || fields === undefined) fail('PP3002', 'This grid\'s entity was destroyed');
    return { fields: boardFields(fields), transform: record.transform };
  }

  /** Live pieces on `gridId` at `cell` with every tag and component, in spawn order. */
  at(gridId: EntityId, cell: Cell, tagged: readonly string[], having: readonly string[]): EntityId[] {
    const ids = this.#boards.get(gridId)?.get(keyOf(cell)) ?? [];
    const world = this.kernel.world;
    return ids
      .filter((id) => {
        const record = world.get(id);
        return record !== undefined && tagged.every((t) => record.tags.has(t)) && having.every((c) => record.components.has(c));
      })
      .sort((a, b) => this.#seq.get(a)! - this.#seq.get(b)!);
  }

  /** True when a live piece on the grid at `cell` (other than `except`) has any of `tags`. */
  blockedAt(gridId: EntityId, cell: Cell, tags: readonly string[], except?: EntityId): boolean {
    if (tags.length === 0) return false;
    for (const id of this.#boards.get(gridId)?.get(keyOf(cell)) ?? []) {
      if (id === except) continue;
      const record = this.kernel.world.get(id);
      if (record !== undefined && tags.some((t) => record.tags.has(t))) return true;
    }
    return false;
  }

  #snap(id: EntityId, piece: Piece): void {
    const record = this.kernel.world.get(id);
    if (record === undefined || piece.grid === undefined) return;
    const board = this.board(piece.grid);
    const node = record.transform;
    node.setWorldPosition(onPlane(board, node.worldPosition(), cellCenter(board, piece.fields['cell'] as Cell)));
  }

  /** Keep snapped pieces on their cell centers (late in the frame, after game updates). */
  snapAll(): void {
    for (const [id, piece] of this.#pieces) {
      if (piece.fields['snap'] !== true || this.#movers.get(id)?.leg != null) continue;
      this.#snap(id, piece);
    }
  }

  // ── Movers ───────────────────────────────────────────────────────────────────

  #piece(id: EntityId, what: string): Piece {
    const piece = this.#pieces.get(id);
    if (piece === undefined) {
      fail('PP7506', `GridMover.${what}: this entity has no GridCell`, {
        fix: 'Give it a GridCell (in the prefab or spawn(components=[GridCell(cell=...)])) so the mover knows where it is.',
      });
    }
    if (piece.grid === undefined) this.#file(id, false);
    return piece;
  }

  #mover(id: EntityId): Mover {
    let mover = this.#movers.get(id);
    if (mover === undefined) {
      mover = { heading: null, continuous: false, queued: null, leg: null };
      this.#movers.set(id, mover);
    }
    return mover;
  }

  /** Can the mover step from `from` by `step`: on the board and not onto a blocking piece. */
  #open(id: EntityId, piece: Piece, from: Cell, step: Cell): boolean {
    const to = from.__add__(step);
    const grid = piece.grid!;
    if (!contains(this.board(grid).fields, to)) return false;
    const fields = this.kernel.world.require(id).components.get(GRID_MOVER)!;
    const blocked = ((fields['blocked'] ?? []) as unknown[]).map((t) => tagId(t, 'GridMover.blocked'));
    return !this.blockedAt(grid, to, blocked, id);
  }

  #startLeg(mover: Mover, from: Cell, step: Cell, progress: number): void {
    mover.heading = step;
    mover.leg = { from, to: from.__add__(step), progress, frame: this.kernel.time.frame };
  }

  step(id: EntityId, step: Cell): boolean {
    const piece = this.#piece(id, 'step()');
    const mover = this.#mover(id);
    if (mover.leg !== null) {
      if (!this.#open(id, piece, mover.leg.to, step)) return false;
      mover.queued = step;
      mover.continuous = false;
      return true;
    }
    const here = piece.fields['cell'] as Cell;
    if (!this.#open(id, piece, here, step)) return false;
    mover.continuous = false;
    mover.queued = null;
    this.#startLeg(mover, here, step, 0);
    return true;
  }

  go(id: EntityId, heading: Cell): void {
    const piece = this.#piece(id, 'go()');
    const mover = this.#mover(id);
    mover.continuous = true;
    mover.queued = null;
    const leg = mover.leg;
    if (leg === null) {
      mover.heading = heading;
      const here = piece.fields['cell'] as Cell;
      if (this.#open(id, piece, here, heading)) this.#startLeg(mover, here, heading, 0);
      return;
    }
    // A turn asked for in the frame the leg began (a CellEntered handler) is taken at the
    // cell just entered; later in a leg, it is taken on arrival.
    if (leg.frame === this.kernel.time.frame && !leg.to.__sub__(leg.from).__eq__(heading)
      && this.#open(id, piece, leg.from, heading)) {
      this.#startLeg(mover, leg.from, heading, leg.progress);
      return;
    }
    mover.heading = heading;
  }

  stop(id: EntityId): void {
    const mover = this.#movers.get(id);
    if (mover === undefined) return;
    mover.leg = null;
    mover.heading = null;
    mover.queued = null;
    mover.continuous = false;
  }

  moving(id: EntityId): boolean {
    return this.#movers.get(id)?.leg != null;
  }

  direction(id: EntityId): Cell | null {
    return this.#movers.get(id)?.heading ?? null;
  }

  /** Advance every moving mover by `dt` seconds, in spawn order. */
  update(dt: number): void {
    const order = [...this.#movers.keys()].sort((a, b) => this.#seq.get(a)! - this.#seq.get(b)!);
    for (const id of order) {
      const mover = this.#movers.get(id);
      const record = this.kernel.world.get(id);
      if (mover?.leg == null || record === undefined) continue;
      const piece = this.#pieces.get(id);
      const fields = record.components.get(GRID_MOVER);
      if (piece === undefined || fields === undefined) continue;
      const speed = fields['speed'] as number;
      mover.leg.progress += Math.max(0, speed) * dt;
      while (mover.leg !== null && mover.leg.progress >= 1 - ARRIVAL_TOLERANCE) this.#arrive(id, record, piece, mover);
      this.#place(record, piece, mover);
    }
  }

  #arrive(id: EntityId, record: EntityRecord, piece: Piece, mover: Mover): void {
    const leg = mover.leg!;
    const leftover = Math.max(0, leg.progress - 1);
    mover.leg = null;
    piece.fields['cell'] = leg.to;
    this.kernel.emit(GRID_EVENTS.cellEntered, { entity: this.kernel.handles.wrap(id), cell: leg.to });
    const next = mover.queued ?? (mover.continuous ? mover.heading : null);
    mover.queued = null;
    if (next !== null && record.alive && this.#open(id, piece, leg.to, next)) this.#startLeg(mover, leg.to, next, leftover);
    if (mover.leg === null) {
      const board = this.board(piece.grid!);
      record.transform.setWorldPosition(onPlane(board, record.transform.worldPosition(), cellCenter(board, leg.to)));
    }
  }

  /** Put a moving mover's transform on its leg (in-plane only). */
  #place(record: EntityRecord, piece: Piece, mover: Mover): void {
    const leg = mover.leg;
    if (leg === null || piece.grid === undefined) return;
    const board = this.board(piece.grid);
    const at = cellCenter(board, leg.from).lerp(cellCenter(board, leg.to), Math.min(1, leg.progress));
    record.transform.setWorldPosition(onPlane(board, record.transform.worldPosition(), at));
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): GridSnapshot {
    const order = [...this.#movers.keys()].sort((a, b) => this.#seq.get(a)! - this.#seq.get(b)!);
    return {
      movers: order.map((id) => {
        const m = this.#movers.get(id)!;
        return {
          id,
          heading: m.heading?.toJSON() ?? null,
          continuous: m.continuous,
          queued: m.queued?.toJSON() ?? null,
          leg: m.leg === null ? null : { from: m.leg.from.toJSON(), to: m.leg.to.toJSON(), progress: m.leg.progress },
        };
      }),
    };
  }

  /** Rebuild from the restored world (index, spawn order) and the saved movers. */
  restore(state: Json): void {
    const saved = state as unknown as GridSnapshot;
    this.#seq.clear();
    this.#nextSeq = 0;
    this.#boards.clear();
    this.#pieces.clear();
    this.#movers.clear();
    const live = [...this.kernel.world.live()];
    for (const record of live) this.#seq.set(record.id, this.#nextSeq++);
    for (const record of live) this.#reconcile(record, false);
    const cell = (value: unknown): Cell => Cell.fromJSON(value, 'saved grid mover');
    for (const m of saved.movers) {
      const id = m.id as EntityId;
      const record = this.kernel.world.get(id);
      if (record === undefined || !record.components.has(GRID_MOVER)) continue;
      this.#movers.set(id, {
        heading: m.heading === null ? null : cell(m.heading),
        continuous: m.continuous,
        queued: m.queued === null ? null : cell(m.queued),
        leg: m.leg === null ? null : { from: cell(m.leg.from), to: cell(m.leg.to), progress: m.leg.progress, frame: -1 },
      });
    }
  }
}
