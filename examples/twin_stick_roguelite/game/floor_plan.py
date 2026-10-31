"""Random floor plans: a tree of rooms grown on a grid from the start room.

The boss takes the dead end farthest from the start, the shop and the optional
gauntlet take the next dead ends, and a few extra doors ("loops") join ordinary rooms
so the floor isn't a pure tree. Lock 0 shuts every door of the boss room; deep floors
add more locks, each shutting every door of another random room. Each lock's key lies
in an ordinary combat room, re-rolled until a keeper who picks keys up on entering
their rooms can reach every room (`solvable`), so a key never sits behind its own lock.

A pure module: it uses only the value types from `parallax.values`, so the tests can
call it directly.
"""

import random
from collections import deque
from dataclasses import dataclass

from parallax.values import Cell

START = Cell(0, 0)
STEPS = [Cell(1, 0), Cell(-1, 0), Cell(0, 1), Cell(0, -1)]
"""The four neighbours. Written out because `Cell.UP` depends on a grid's row order."""


def link(a: Cell, b: Cell) -> frozenset[Cell]:
    return frozenset((a, b))


@dataclass
class FloorPlan:
    kinds: dict[Cell, str]
    """Room kind per cell: start, combat, shop, gauntlet or boss."""
    links: set[frozenset[Cell]]
    """Pairs of neighbouring cells joined by a door."""
    locks: dict[Cell, int]
    """Locked room -> its lock number (0 is the boss)."""
    keys: dict[int, Cell]
    """Lock number -> the room holding its key."""

    def linked(self, a: Cell, b: Cell) -> bool:
        return link(a, b) in self.links

    def lock_of(self, a: Cell, b: Cell) -> int | None:
        """The lock on the door between a and b: the lower-numbered lock of either room."""
        return door_lock(self.locks, a, b)


def door_lock(locks: dict[Cell, int], a: Cell, b: Cell) -> int | None:
    found = [locks[cell] for cell in (a, b) if cell in locks]
    return min(found) if found else None


def plan_floor(rooms: int, grid_radius: int, loops: float, gauntlet: bool, locks: int = 1) -> FloorPlan:
    cells = [START]
    links: set[frozenset[Cell]] = set()
    while len(cells) < rooms:
        here = random.choice(cells)
        there = here + random.choice(STEPS)
        if there not in cells and max(abs(there.col), abs(there.row)) <= grid_radius:
            cells.append(there)
            links.add(link(here, there))

    depth = _depths(links)
    by_depth = sorted((cell for cell in cells if cell != START), key=lambda cell: -depth[cell])
    dead_ends = [cell for cell in by_depth if _doors(cell, links) == 1]
    others = [cell for cell in by_depth if cell not in dead_ends]

    kinds = {cell: "combat" for cell in cells}
    kinds[START] = "start"
    specials = ["boss", "shop"] + (["gauntlet"] if gauntlet else [])
    for kind, cell in zip(specials, dead_ends + others):
        kinds[cell] = kind

    _add_loops(kinds, links, loops)
    locked, keys = _place_locks(kinds, links, locks)
    return FloorPlan(kinds=kinds, links=links, locks=locked, keys=keys)


def _place_locks(kinds: dict[Cell, str], links: set[frozenset[Cell]], count: int):
    """Lock 0 on the boss, then random rooms; each key in a combat room, kept only while
    the floor stays solvable (a few re-rolls, then fewer locks)."""
    locked: dict[Cell, int] = {}
    keys: dict[int, Cell] = {}
    boss = [cell for cell, kind in kinds.items() if kind == "boss"][0]
    attempts = 0
    while len(keys) < count and attempts < count * 40:
        attempts += 1
        number = len(keys)
        if number == 0:
            target = boss
        else:
            target = random.choice([cell for cell in kinds if cell != START and cell not in locked])
        holders = [cell for cell, kind in kinds.items()
                   if kind == "combat" and cell != target and cell not in keys.values()]
        if not holders:
            break
        key_room = random.choice(holders)
        locked[target] = number
        keys[number] = key_room
        if not solvable(kinds, links, locked, keys):
            locked.pop(target)
            keys.pop(number)
    return locked, keys


def solvable(kinds: dict[Cell, str], links: set[frozenset[Cell]],
             locks: dict[Cell, int], keys: dict[int, Cell]) -> bool:
    """Every room is reachable when keys are picked up on entering their rooms."""
    held = set()
    reached = {START}
    grew = True
    while grew:
        grew = False
        for number, cell in keys.items():
            if cell in reached and number not in held:
                held.add(number)
                grew = True
        for pair in links:
            a, b = tuple(pair)
            lock = door_lock(locks, a, b)
            if lock is not None and lock not in held:
                continue
            if (a in reached) != (b in reached):
                reached.add(b if a in reached else a)
                grew = True
    return len(reached) == len(kinds)


def _doors(cell: Cell, links: set[frozenset[Cell]]) -> int:
    return sum(1 for pair in links if cell in pair)


def _depths(links: set[frozenset[Cell]]) -> dict[Cell, int]:
    depth = {START: 0}
    frontier = deque([START])
    while frontier:
        here = frontier.popleft()
        for direction in STEPS:
            there = here + direction
            if there not in depth and link(here, there) in links:
                depth[there] = depth[here] + 1
                frontier.append(there)
    return depth


def _add_loops(kinds: dict[Cell, str], links: set[frozenset[Cell]], chance: float) -> None:
    """Extra doors only between start/combat rooms, so special rooms stay dead ends."""
    ordinary = {cell for cell, kind in kinds.items() if kind in ("start", "combat")}
    for cell in ordinary:
        for direction in (Cell(1, 0), Cell(0, 1)):
            there = cell + direction
            if there in ordinary and link(cell, there) not in links and random.random() < chance:
                links.add(link(cell, there))
