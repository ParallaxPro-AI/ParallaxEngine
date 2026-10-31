from parallax import System, system
from project import Scenes

from game.board import HUMAN, column_at, human_to_drop
from game.events import DiscChosen


@system("player_drops", scenes=[Scenes.well], when=human_to_drop)
class PlayerDrops(System):
    """Turns a tap over a column into the player's drop."""

    def update(self, ctx, dt):
        pointer = ctx.input.pointer
        if not pointer.pressed:
            return
        column = column_at(ctx, pointer.world)
        if column is not None:
            ctx.emit(DiscChosen(column=column, disc=HUMAN))
