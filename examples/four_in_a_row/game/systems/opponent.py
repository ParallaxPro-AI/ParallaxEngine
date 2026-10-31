from parallax import System, on, system
from project import Scenes

from game.board import COMPUTER, HUMAN, in_play
from game.config import Rules
from game.events import DiscChosen, DiscDropped
from game.resources import Match
from game.well import best_column


@system("opponent", scenes=[Scenes.well])
class Opponent(System):
    """Plays teal: after each amber drop it takes a thinking beat, then drops
    where a depth-limited minimax search says."""

    @on(DiscDropped, when=in_play, where=lambda event: event.disc is HUMAN)
    def reply(self, ctx, event: DiscDropped):
        ctx.run(teal_move)


async def teal_move(ctx, task):
    """A thinking beat (frozen by the pause menu), then teal's column."""
    rules = ctx.config(Rules)
    await task.seconds(rules.think_seconds)
    column = best_column(
        ctx.get(Match).cells, COMPUTER,
        depth=rules.search_depth, node_budget=rules.node_budget, heuristic=rules.heuristic,
    )
    ctx.emit(DiscChosen(column=column, disc=COMPUTER))
