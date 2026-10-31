"""The pushing rules as pure functions over plain sets of cells.

A move is recorded in the standard Sokoban LURD notation: one letter per step,
lower case for a walk and upper case for a push. That string is the whole history
needed to undo and redo. Nothing here touches an entity or the engine; `Cell` is the
pure value type from `parallax.values`, row 0 on top."""

from dataclasses import dataclass

from parallax.values import Cell

LETTERS: dict[Cell, str] = {Cell.UP: "u", Cell.DOWN: "d", Cell.LEFT: "l", Cell.RIGHT: "r"}
STEPS: dict[str, Cell] = {letter: step for step, letter in LETTERS.items()}


@dataclass(frozen=True)
class Blueprint:
    """A level parsed from its ASCII rows ('#' wall, '.' pad, '$' crate, '@' bot,
    '*' crate on a pad, '+' bot on a pad). Short rows are padded with wall."""
    cols: int
    rows: int
    walls: frozenset[Cell]
    pads: frozenset[Cell]
    crates: frozenset[Cell]
    bot: Cell


def parse(lines: list[str]) -> Blueprint:
    """The first line is the top of the level: row 0, as on a rows-down grid."""
    cols = max(len(line) for line in lines)
    walls, pads, crates = set(), set(), set()
    bot = Cell(0, 0)
    for row, line in enumerate(lines):
        for col, ch in enumerate(line.ljust(cols, "#")):
            cell = Cell(col, row)
            if ch == "#":
                walls.add(cell)
            if ch in ".+*":
                pads.add(cell)
            if ch in "$*":
                crates.add(cell)
            if ch in "@+":
                bot = cell
    return Blueprint(cols, len(lines), frozenset(walls), frozenset(pads), frozenset(crates), bot)


@dataclass(frozen=True)
class Yard:
    """Where everything is right now."""
    walls: frozenset[Cell]
    pads: frozenset[Cell]
    crates: frozenset[Cell]
    bot: Cell

    @property
    def solved(self) -> bool:
        return bool(self.crates) and self.crates <= self.pads


@dataclass(frozen=True)
class Move:
    bot: Cell
    """Where the bot ends up."""
    crate: tuple[Cell, Cell] | None
    """(from, to) of the crate this move shifts, if any."""
    letter: str
    """The LURD letter that records this move."""


def step(yard: Yard, direction: Cell) -> Move | None:
    """Walk one cell, pushing a crate if one is in the way. Blocked by a wall, and
    by a crate with a wall or a second crate behind it. None when blocked."""
    ahead = yard.bot + direction
    if ahead in yard.walls:
        return None
    if ahead not in yard.crates:
        return Move(ahead, None, LETTERS[direction])
    beyond = ahead + direction
    if beyond in yard.walls or beyond in yard.crates:
        return None
    return Move(ahead, (ahead, beyond), LETTERS[direction].upper())


def unstep(yard: Yard, letter: str) -> Move:
    """The move that takes back `letter`: the bot steps back, pulling the crate it
    pushed (if it was a push). The returned letter is the one taken back."""
    direction = STEPS[letter.lower()]
    crate = (yard.bot + direction, yard.bot) if letter.isupper() else None
    return Move(yard.bot - direction, crate, letter)
