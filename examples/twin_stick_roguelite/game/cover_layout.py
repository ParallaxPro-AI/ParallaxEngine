"""The cover inside a fight room: a small wave-function-collapse tile solver.

The room's interior is a `size` x `size` grid of cells. Every tile names the socket on
each of its four sides ("o" open floor, "w" a wall run); two neighbours fit when the
sides they share carry the same socket. Open, pillar and crate tiles are open all round,
so they stand anywhere; the wall tiles only let a run END in an end tile or bend in a
corner, so cover is always whole wall segments, never a dangling block. Pinned cells
(the outer ring for the doorways, the centre for the boss and the key) are open.

Solve: pin, propagate, then repeatedly collapse the undecided cell with the fewest
options (a weighted pick) and propagate again; a contradiction restarts the grid.

A pure module (only `parallax.values`), so the tests can call it directly.
"""

import random
from dataclasses import dataclass

from parallax.values import Cell

SIDES = [("n", "s", Cell(0, -1)), ("e", "w", Cell(1, 0)), ("s", "n", Cell(0, 1)), ("w", "e", Cell(-1, 0))]
"""(this tile's side, the neighbour's facing side, the step to the neighbour)."""


@dataclass
class TileSpec:
    id: str
    weight: float
    edges: dict[str, str]
    """Socket per side: "n", "e", "s", "w"."""


def pinned_open(size: int, centre: int) -> list[Cell]:
    """The outer ring plus the `centre` x `centre` block in the middle."""
    low = (size - centre) // 2
    cells = []
    for row in range(size):
        for col in range(size):
            ring = row == 0 or col == 0 or row == size - 1 or col == size - 1
            middle = low <= row < low + centre and low <= col < low + centre
            if ring or middle:
                cells.append(Cell(col, row))
    return cells


def solve(tiles: list[TileSpec], size: int, pins: dict[Cell, int], restarts: int) -> dict[Cell, int] | None:
    """A tile index per cell, or None when every restart hit a contradiction."""
    fits = _fits(tiles)
    for _ in range(restarts):
        grid = _attempt(tiles, fits, size, pins)
        if grid is not None:
            return grid
    return None


def _fits(tiles: list[TileSpec]) -> dict[str, list[list[int]]]:
    """fits[side][a] = the tiles that may sit on tile a's `side`."""
    out = {}
    for side, facing, _ in SIDES:
        out[side] = [[b for b, other in enumerate(tiles) if other.edges[facing] == tile.edges[side]]
                     for tile in tiles]
    return out


def _attempt(tiles, fits, size, pins):
    every = list(range(len(tiles)))
    options = {}
    for row in range(size):
        for col in range(size):
            cell = Cell(col, row)
            options[cell] = [pins[cell]] if cell in pins else list(every)
    if not _propagate(options, fits, list(options.keys())):
        return None
    while True:
        open_cells = [cell for cell, left in options.items() if len(left) > 1]
        if not open_cells:
            return {cell: left[0] for cell, left in options.items()}
        fewest = min([len(options[cell]) for cell in open_cells])
        cell = random.choice([cell for cell in open_cells if len(options[cell]) == fewest])
        left = options[cell]
        options[cell] = [random.choices(left, weights=[tiles[t].weight for t in left])[0]]
        if not _propagate(options, fits, [cell]):
            return None


def _propagate(options, fits, queue) -> bool:
    while queue:
        cell = queue.pop()
        for side, _, step in SIDES:
            there = cell + step
            if there not in options:
                continue
            allowed = set()
            for tile in options[cell]:
                for other in fits[side][tile]:
                    allowed.add(other)
            kept = [tile for tile in options[there] if tile in allowed]
            if not kept:
                return False
            if len(kept) < len(options[there]):
                options[there] = kept
                queue.append(there)
    return True


def reachable_open(cover: dict[Cell, bool], size: int) -> list[Cell]:
    """Open cells joined to the outer ring (a wall run can pocket a cell off)."""
    seen = {Cell(0, 0)}
    stack = [Cell(0, 0)]
    while stack:
        here = stack.pop()
        for _, _, step in SIDES:
            there = here + step
            if 0 <= there.col < size and 0 <= there.row < size and there not in seen and not cover[there]:
                seen.add(there)
                stack.append(there)
    return list(seen)
