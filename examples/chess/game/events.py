from parallax import event

from game.chess.status import Ending


@event("match_started")
class MatchStarted:
    """The opening position is on the board."""


@event("move_chosen")
class MoveChosen:
    """A player (human or computer) picked a move. The referee decides if it stands."""
    move: str
    """UCI: `"e2e4"`, `"e7e8q"`."""


@event("move_made")
class MoveMade:
    move: str
    """UCI of the move just played."""
    before: str
    """FEN of the position it was played in."""


@event("match_ended")
class MatchEnded:
    ending: Ending
    winner: str


@event("selection_changed")
class SelectionChanged:
    """The player picked up, swapped or put down a piece."""


@event("resigned")
class Resigned:
    """The player tipped their king (the HUD's Resign button)."""
