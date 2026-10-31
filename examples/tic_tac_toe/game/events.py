from parallax import event
from parallax.values import Cell

from game.resources import Result
from game.rules import Mark


@event("cell_chosen")
class CellChosen:
    """A player (human or computer) picked a cell. The referee decides if it stands."""
    cell: Cell
    mark: Mark


@event("mark_placed")
class MarkPlaced:
    cell: Cell
    mark: Mark


@event("match_ended")
class MatchEnded:
    result: Result
