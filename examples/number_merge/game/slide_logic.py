"""The slide-and-fuse rule as pure functions over the tiles on a board.

A board is the value on every occupied cell. Nothing here touches an entity or the
engine; `Cell` is the pure value type from `parallax.values`, row 0 on top."""

from dataclasses import dataclass

from parallax.values import Cell

Tiles = dict[Cell, int]
DIRECTIONS = (Cell.UP, Cell.DOWN, Cell.LEFT, Cell.RIGHT)


@dataclass(frozen=True)
class Move:
    """One tile's journey. An `absorbed` tile slides into an equal tile and is gone."""
    start: Cell
    end: Cell
    absorbed: bool


@dataclass(frozen=True)
class Merge:
    cell: Cell
    value: int
    """The fused tile's new value."""


@dataclass(frozen=True)
class Slide:
    moves: list[Move]
    merges: list[Merge]

    @property
    def changed(self) -> bool:
        return any(move.start != move.end for move in self.moves)


@dataclass
class _Landed:
    cell: Cell
    value: int
    fused: bool


def lines_toward(cols: int, rows: int, step: Cell) -> list[list[Cell]]:
    """Every line along the slide, each ordered from the wall the tiles slide toward."""
    if step.col:
        order = list(range(cols)) if step.col < 0 else list(reversed(range(cols)))
        return [[Cell(col, row) for col in order] for row in range(rows)]
    order = list(range(rows)) if step.row < 0 else list(reversed(range(rows)))
    return [[Cell(col, row) for row in order] for col in range(cols)]


def slide(tiles: Tiles, cols: int, rows: int, step: Cell) -> Slide:
    """Push every tile as far as it goes. Two equal tiles that meet fuse into one of
    double value, and a tile fuses at most once per slide."""
    moves: list[Move] = []
    merges: list[Merge] = []
    for line in lines_toward(cols, rows, step):
        landed: list[_Landed] = []
        for cell in line:
            value = tiles.get(cell)
            if value is None:
                continue
            last = landed[-1] if landed else None
            if last is not None and last.value == value and not last.fused:
                last.value *= 2
                last.fused = True
                moves.append(Move(cell, last.cell, absorbed=True))
                merges.append(Merge(last.cell, last.value))
            else:
                landing = line[len(landed)]
                landed.append(_Landed(landing, value, fused=False))
                moves.append(Move(cell, landing, absorbed=False))
    return Slide(moves, merges)


def can_slide(tiles: Tiles, cols: int, rows: int) -> bool:
    return any(slide(tiles, cols, rows, step).changed for step in DIRECTIONS)
