from parallax import System, on, system
from project import Prefabs, Scenes

from game.board import center, position
from game.chess.moves import moves_from
from game.components import Highlight
from game.events import SelectionChanged
from game.resources import Selection


@system("highlights", scenes=[Scenes.board])
class Highlights(System):
    """Rings the picked-up piece and marks where it can go: a dot on an empty
    square, a ring around a piece it can take."""

    @on(SelectionChanged)
    def redraw(self, ctx, event):
        for highlight in ctx.world.query(tagged=Highlight):
            highlight.destroy()
        square = ctx.get(Selection).square
        if square is None:
            return
        now = position(ctx)
        ctx.world.spawn(Prefabs.selection, at=center(ctx, square))
        targets = {move.target: move for move in moves_from(now, square)}  # four promotions share one square
        for target, move in targets.items():
            takes = bool(now.board[target]) or move.en_passant
            ctx.world.spawn(Prefabs.capture_ring if takes else Prefabs.move_dot, at=center(ctx, target))
