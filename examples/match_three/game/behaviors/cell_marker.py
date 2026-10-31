from parallax import Behavior, behavior, param
from parallax.grid import GridCell
from parallax.values import Cell

from game.resources import BoardState


@behavior("cell_marker", requires=[GridCell])
class CellMarker(Behavior):
    """A frame drawn over one cell the board state points at: the selected gem, or
    one half of a hint. Its `GridCell` snaps it to that cell; it is hidden while
    there is nothing to point at."""

    shows: str = param("selection", choices=["selection", "hint_first", "hint_second"])

    def update(self, ctx, dt):
        cell = self.target(ctx.get(BoardState))
        self.entity.visible = cell is not None
        if cell is not None:
            self.entity.get(GridCell).cell = cell

    def target(self, board: BoardState) -> Cell | None:
        if self.shows == "selection":
            return board.selected
        index = 0 if self.shows == "hint_first" else 1
        return board.hint[index] if board.hint else None
