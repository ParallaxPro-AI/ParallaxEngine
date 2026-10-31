"""The rules of four-in-a-row as pure Python, and the computer's search.

The well is 7 columns by 6 rows of `Cell(col, row)`, row 0 at the bottom (the
well's `Grid` uses `row_order="up"` to match). `Cells` stores them row by row;
only this module indexes it. A cell holds a `Disc` or None. Amber always drops
first, so whose turn it is follows from the disc counts. The only SDK import is
the pure value type `parallax.values.Cell`.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from parallax.values import Cell

COLS = 7
ROWS = 6
DIRECTIONS = (Cell(1, 0), Cell(0, 1), Cell(1, 1), Cell(1, -1))
WIN = 10_000_000
INFINITY = WIN * 10


class Disc(Enum):
    AMBER = "amber"
    TEAL = "teal"

    @property
    def other(self) -> "Disc":
        return Disc.TEAL if self is Disc.AMBER else Disc.AMBER


Cells = tuple[Disc | None, ...]

EMPTY_WELL: Cells = (None,) * (COLS * ROWS)


def _index(cell: Cell) -> int:
    return cell.row * COLS + cell.col


def in_well(cell: Cell) -> bool:
    return 0 <= cell.col < COLS and 0 <= cell.row < ROWS


def disc_at(cells: Cells, cell: Cell) -> Disc | None:
    return cells[_index(cell)]


def turn(cells: Cells) -> Disc:
    return Disc.AMBER if cells.count(Disc.AMBER) == cells.count(Disc.TEAL) else Disc.TEAL


def is_full(cells: Cells) -> bool:
    return None not in cells


def landing(cells: Cells, col: int) -> Cell | None:
    """The lowest empty cell in a column, or None if it is full."""
    return next((Cell(col, row) for row in range(ROWS) if disc_at(cells, Cell(col, row)) is None), None)


def open_columns(cells: Cells) -> list[int]:
    return [col for col in range(COLS) if disc_at(cells, Cell(col, ROWS - 1)) is None]


def drop(cells: Cells, col: int, disc: Disc) -> tuple[Cells, Cell]:
    """The well after dropping `disc` down an open column, and the cell it landed in."""
    at = landing(cells, col)
    i = _index(at)
    return cells[:i] + (disc,) + cells[i + 1:], at


def winning_run(cells: Cells, at: Cell) -> list[Cell]:
    """The line of four or more through `at` in one colour, or [] if there is none."""
    for step in DIRECTIONS:
        run = _ray(cells, at, step * -1)[::-1] + [at] + _ray(cells, at, step)
        if len(run) >= 4:
            return run
    return []


def _ray(cells: Cells, start: Cell, step: Cell) -> list[Cell]:
    disc, run = disc_at(cells, start), []
    cell = start + step
    while in_well(cell) and disc_at(cells, cell) == disc:
        run.append(cell)
        cell = cell + step
    return run


def _windows() -> list[tuple[int, ...]]:
    """Every four-cell line in the well, as storage indexes (the search's hot loop)."""
    return [
        tuple(_index(Cell(col, row) + step * k) for k in range(4))
        for row in range(ROWS) for col in range(COLS) for step in DIRECTIONS
        if in_well(Cell(col, row) + step * 3)
    ]


WINDOWS = _windows()


# ── the computer's search ────────────────────────────────────────────────────

class Heuristic(Protocol):
    """How a non-final well is scored for one side. The game passes its config
    record (`HeuristicWeights`) straight in; this module only names the fields."""
    centre: float
    """Per disc in the centre column."""
    open_three: float
    """Per window holding three of mine and one gap."""
    open_two: float
    """Per window holding two of mine and two gaps."""
    threat: float
    """Per window holding three of theirs and one gap (negative)."""


@dataclass
class _Search:
    heuristic: Heuristic
    nodes_left: int


def best_column(cells: Cells, disc: Disc, *, depth: int, node_budget: int, heuristic: Heuristic) -> int:
    """Depth-limited negamax with alpha-beta. When the node budget runs out the
    remaining leaves are scored by the heuristic instead of searched."""
    search = _Search(heuristic, node_budget)
    best, alpha = None, -INFINITY
    for col in _centre_first(cells):
        score = _score_drop(cells, col, disc, depth, -INFINITY, -alpha, search)
        if best is None or score > alpha:
            best, alpha = col, score
    return best


def _score_drop(cells: Cells, col: int, disc: Disc, depth: int,
                alpha: float, beta: float, search: _Search) -> float:
    after, at = drop(cells, col, disc)
    if winning_run(after, at):
        return WIN + depth  # sooner wins score higher
    return -_negamax(after, disc.other, depth - 1, alpha, beta, search)


def _negamax(cells: Cells, disc: Disc, depth: int,
             alpha: float, beta: float, search: _Search) -> float:
    search.nodes_left -= 1
    columns = _centre_first(cells)
    if not columns:
        return 0  # a full well is a draw
    if depth <= 0 or search.nodes_left < 0:
        return _score_well(cells, disc, search.heuristic)
    for col in columns:
        alpha = max(alpha, _score_drop(cells, col, disc, depth, -beta, -alpha, search))
        if alpha >= beta:
            break
    return alpha


def _centre_first(cells: Cells) -> list[int]:
    return sorted(open_columns(cells), key=lambda col: abs(col - COLS // 2))


def _score_well(cells: Cells, me: Disc, heuristic: Heuristic) -> float:
    them = me.other
    centre = [disc_at(cells, Cell(COLS // 2, row)) for row in range(ROWS)]
    score = heuristic.centre * (centre.count(me) - centre.count(them))
    for window in WINDOWS:
        discs = [cells[i] for i in window]
        mine, theirs, gaps = discs.count(me), discs.count(them), discs.count(None)
        if mine == 3 and gaps == 1:
            score += heuristic.open_three
        elif mine == 2 and gaps == 2:
            score += heuristic.open_two
        if theirs == 3 and gaps == 1:
            score += heuristic.threat
    return score
