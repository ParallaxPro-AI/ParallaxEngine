from enum import Enum

from parallax import field, resource

from game.rules import Cells


class Result(Enum):
    WIN = "win"
    LOSS = "loss"
    DRAW = "draw"


@resource("match", keep="scene")
class Match:
    """The game on the board. `cells` is the truth; piece entities only draw it.
    Lives for one load of the board scene, so Play again is a plain reload."""
    cells: Cells = field((None, None, None, None, None, None, None, None, None))
    """Nine squares, row by row (`rules.EMPTY_GRID`, spelled out so the default reads statically)."""
    result: Result | None = field(None)


@resource("record", keep="profile")
class Record:
    """Lifetime results. A loss breaks the win streak; a draw leaves it alone."""
    wins: int = field(0)
    losses: int = field(0)
    draws: int = field(0)
    streak: int = field(0)
    best_streak: int = field(0)
