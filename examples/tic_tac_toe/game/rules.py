"""Noughts and crosses as pure Python, and a perfect opponent.

Squares are `Cell(col, row)` on a 3×3 board — the same values the board's
`Grid` uses, so nothing converts between the rules and the screen. `Cells`
stores them row by row; only this module indexes it. A cell holds a `Mark` or
None. The only SDK import is the pure value type `parallax.values.Cell`.
"""

from enum import Enum

from parallax.values import Cell


class Mark(Enum):
    SUN = "sun"
    """The player; moves first."""
    MOON = "moon"
    """The computer."""

    @property
    def other(self) -> "Mark":
        return Mark.MOON if self is Mark.SUN else Mark.SUN


Cells = tuple[Mark | None, ...]

SIZE = 3
ALL_CELLS = tuple(Cell(col, row) for row in range(SIZE) for col in range(SIZE))
EMPTY_GRID: Cells = (None,) * len(ALL_CELLS)
LINES = (
    *(tuple(Cell(col, row) for col in range(SIZE)) for row in range(SIZE)),
    *(tuple(Cell(col, row) for row in range(SIZE)) for col in range(SIZE)),
    tuple(Cell(i, i) for i in range(SIZE)),
    tuple(Cell(SIZE - 1 - i, i) for i in range(SIZE)),
)


def _index(cell: Cell) -> int:
    return cell.row * SIZE + cell.col


def mark_at(cells: Cells, cell: Cell) -> Mark | None:
    return cells[_index(cell)]


def turn(cells: Cells) -> Mark:
    return Mark.SUN if cells.count(Mark.SUN) == cells.count(Mark.MOON) else Mark.MOON


def empty_cells(cells: Cells) -> list[Cell]:
    return [cell for cell in ALL_CELLS if mark_at(cells, cell) is None]


def place(cells: Cells, at: Cell, mark: Mark) -> Cells:
    i = _index(at)
    return cells[:i] + (mark,) + cells[i + 1:]


def winning_line(cells: Cells) -> tuple[Cell, ...] | None:
    for line in LINES:
        marks = {mark_at(cells, cell) for cell in line}
        if len(marks) == 1 and None not in marks:
            return line
    return None


def is_full(cells: Cells) -> bool:
    return None not in cells


def best_cells(cells: Cells, mark: Mark) -> list[Cell]:
    """Every cell that ties for the best minimax value for `mark`, so the caller
    can break ties at random and not play the same game twice."""
    scores = {at: -_negamax(place(cells, at, mark), mark.other, 1) for at in empty_cells(cells)}
    best = max(scores.values())
    return [at for at, score in scores.items() if score == best]


def _negamax(cells: Cells, to_move: Mark, depth: int) -> int:
    """Value for `to_move`. A win is worth more the sooner it lands and a loss
    hurts less the later it lands, so the computer takes the quickest win and
    drags out a lost game. The whole tree is searched; it is tiny."""
    if winning_line(cells):
        return depth - 10  # the player who just moved has won
    if is_full(cells):
        return 0
    return max(-_negamax(place(cells, at, to_move), to_move.other, depth + 1) for at in empty_cells(cells))
