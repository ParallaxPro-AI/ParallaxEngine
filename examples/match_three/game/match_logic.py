"""The match-three rules as pure functions over plain boards.

Nothing here touches an entity or the engine: a board is the gem kind id on every
cell, so every rule can be read, and tested, on its own. `Cell` is the pure value
type from `parallax.values`; row 0 is the top row, as on screen.
"""

import random
from dataclasses import dataclass
from enum import Enum

from parallax.values import Cell

MATCH = 3
"""A straight run this long clears."""
LINE_RUN = 4
"""A run this long forges a line gem."""
BOMB_RUN = 5
"""A run this long (or two runs crossing) forges a bomb gem."""


class Special(Enum):
    """A charged gem, listed weakest first: when two forges land on one cell, the
    stronger one wins."""
    NONE = "none"
    LINE = "line"
    """Detonates its whole row and column."""
    BOMB = "bomb"
    """Detonates a square around itself."""


def stronger(a: Special, b: Special) -> Special:
    """The stronger of two specials, by declaration order."""
    order = list(Special)
    return max(a, b, key=order.index)


@dataclass(frozen=True)
class Board:
    """The gem kind on every cell of a cols x rows board (missing = empty)."""
    cols: int
    rows: int
    kinds: dict[Cell, str]

    def contains(self, cell: Cell) -> bool:
        return 0 <= cell.col < self.cols and 0 <= cell.row < self.rows

    def cells(self) -> list[Cell]:
        return [Cell(col, row) for row in range(self.rows) for col in range(self.cols)]

    def swapped(self, a: Cell, b: Cell) -> "Board":
        kinds = dict(self.kinds)
        kinds[a], kinds[b] = self.kinds[b], self.kinds[a]
        return Board(self.cols, self.rows, kinds)


@dataclass(frozen=True)
class Run:
    cells: tuple[Cell, ...]
    horizontal: bool


@dataclass(frozen=True)
class Wave:
    """One step of a cascade: what clears, and which cells survive as new specials."""
    clears: frozenset[Cell]
    forged: dict[Cell, Special]
    detonated: bool
    """An existing special went off (the camera shakes)."""


def lines(board: Board) -> list[tuple[list[Cell], bool]]:
    """Every row, then every column, as (cells, horizontal)."""
    across = [([Cell(col, row) for col in range(board.cols)], True) for row in range(board.rows)]
    down = [([Cell(col, row) for row in range(board.rows)], False) for col in range(board.cols)]
    return across + down


def find_runs(board: Board) -> list[Run]:
    runs = []
    for line, horizontal in lines(board):
        start = 0
        while start < len(line):
            kind = board.kinds.get(line[start])
            end = start + 1
            while end < len(line) and kind is not None and board.kinds.get(line[end]) == kind:
                end += 1
            if kind is not None and end - start >= MATCH:
                runs.append(Run(tuple(line[start:end]), horizontal))
            start = end
    return runs


def has_match(board: Board) -> bool:
    return len(find_runs(board)) > 0


def find_swap(board: Board) -> tuple[Cell, Cell] | None:
    """A swap that makes a match (the hint), or None if the board is dead."""
    for cell in board.cells():
        for other in (cell + Cell.RIGHT, cell + Cell.DOWN):
            if board.contains(other) and has_match(board.swapped(cell, other)):
                return cell, other
    return None


def plan_wave(board: Board, specials: dict[Cell, Special], focus: Cell | None,
              bomb_radius: int) -> Wave:
    """Resolve every run on the board at once.

    A run of four forges a line gem and a run of five a bomb, on the swapped cell if
    the run contains it (`focus`), else in the middle. A cell in both a horizontal and
    a vertical run forges a bomb. Everything else in a run clears, and any special
    caught in the clear detonates, chaining into the specials its blast reaches."""
    runs = find_runs(board)
    forged: dict[Cell, Special] = {}
    for run in runs:
        if len(run.cells) >= LINE_RUN:
            anchor = focus if focus in run.cells else run.cells[len(run.cells) // 2]
            special = Special.BOMB if len(run.cells) >= BOMB_RUN else Special.LINE
            _forge(forged, specials, anchor, special)
    across = {cell for run in runs if run.horizontal for cell in run.cells}
    down = {cell for run in runs if not run.horizontal for cell in run.cells}
    for cell in across & down:
        _forge(forged, specials, cell, Special.BOMB)

    matched = (across | down) - forged.keys()
    clears, detonated = _detonate(board, specials, matched, forged, bomb_radius)
    return Wave(frozenset(clears), forged, detonated)


def _forge(forged: dict[Cell, Special], specials: dict[Cell, Special], cell: Cell,
           special: Special) -> None:
    """An existing special is never overwritten; it detonates instead."""
    if specials.get(cell, Special.NONE) is Special.NONE:
        forged[cell] = stronger(forged.get(cell, Special.NONE), special)


def _detonate(board: Board, specials: dict[Cell, Special], matched: set[Cell],
              forged: dict[Cell, Special], bomb_radius: int) -> tuple[set[Cell], bool]:
    clears: set[Cell] = set()
    queue = list(matched)
    detonated = False
    while queue:
        cell = queue.pop()
        if cell in clears:
            continue
        clears.add(cell)
        special = specials.get(cell, Special.NONE)
        if special is not Special.NONE:
            detonated = True
            for hit in blast(board, cell, special, bomb_radius):
                if hit in board.kinds and hit not in forged:
                    queue.append(hit)
    return clears, detonated


def blast(board: Board, cell: Cell, special: Special, bomb_radius: int) -> list[Cell]:
    if special is Special.LINE:
        area = ([Cell(col, cell.row) for col in range(board.cols)]
                + [Cell(cell.col, row) for row in range(board.rows)])
    else:
        span = range(-bomb_radius, bomb_radius + 1)
        area = [cell + Cell(dc, dr) for dr in span for dc in span]
    return [c for c in area if board.contains(c)]


def deal(cols: int, rows: int, kinds: list[str]) -> Board:
    """A random board with no ready-made match and at least one legal swap.
    Needs at least three kinds (two are ever excluded per cell)."""
    while True:
        dealt: dict[Cell, str] = {}
        for row in range(rows):
            for col in range(cols):
                cell = Cell(col, row)
                dealt[cell] = random.choice([k for k in kinds if not _completes_run(dealt, cell, k)])
        board = Board(cols, rows, dealt)
        if find_swap(board) is not None:
            return board


def _completes_run(dealt: dict[Cell, str], cell: Cell, kind: str) -> bool:
    """Whether `kind` here would finish a run with the two cells to the left or above
    (the cells already dealt, top row first)."""
    left = all(dealt.get(cell + Cell.LEFT * i) == kind for i in (1, 2))
    above = all(dealt.get(cell + Cell.UP * i) == kind for i in (1, 2))
    return left or above


def reshuffle(board: Board) -> dict[Cell, Cell]:
    """Where every gem should move so the board has no match and at least one swap."""
    cells = board.cells()
    while True:
        targets = cells[:]
        random.shuffle(targets)
        moves = dict(zip(cells, targets))
        shuffled = Board(board.cols, board.rows, {moves[cell]: kind for cell, kind in board.kinds.items()})
        if not has_match(shuffled) and find_swap(shuffled) is not None:
            return moves
