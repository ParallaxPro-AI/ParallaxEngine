from parallax import event
from parallax.values import Cell

from game.resources import Result
from game.well import Disc


@event("disc_chosen")
class DiscChosen:
    """A player (human or computer) picked a column. The referee decides if it stands."""
    column: int
    disc: Disc


@event("disc_dropped")
class DiscDropped:
    cell: Cell
    """Where the disc came to rest."""
    disc: Disc


@event("match_ended")
class MatchEnded:
    result: Result
