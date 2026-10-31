from enum import Enum

from parallax import field, resource
from parallax.values import Cell

from game.well import EMPTY_WELL, Cells


class Result(Enum):
    WIN = "win"
    LOSS = "loss"
    DRAW = "draw"


@resource("match", keep="scene")
class Match:
    """The game in the well. `cells` is the truth; disc entities only draw it.
    Lives for one load of the well scene, so Play again is a plain reload."""
    cells: Cells = field(EMPTY_WELL)
    result: Result | None = field(None)
    winning_line: list[Cell] = field([], doc="The connected four, once there is one.")
    streak_before: int = field(0, doc="The win streak this match started on (the result card's echo).")


@resource("record", keep="profile")
class Record:
    """Lifetime results. A loss or a draw breaks the win streak."""
    wins: int = field(0)
    losses: int = field(0)
    draws: int = field(0)
    streak: int = field(0)
    best_streak: int = field(0)
