from parallax import System, on, system
from project import Scenes

from game.config import Sounds
from game.board import COMPUTER, HUMAN
from game.events import MatchEnded
from game.resources import Record


@system("results", scenes=[Scenes.board])
class Results(System):
    """Banks each finished match in the lifetime record. The result card opens by
    itself once the last move has landed (`GameOver`'s `when=`)."""

    @on(MatchEnded)
    def conclude(self, ctx, event: MatchEnded):
        record = ctx.get(Record)
        if event.winner == HUMAN:
            record.wins += 1
            ctx.audio.play(ctx.config(Sounds).win, volume=0.6)
        elif event.winner == COMPUTER:
            record.losses += 1
            ctx.audio.play(ctx.config(Sounds).lose, volume=0.5)
        else:
            record.draws += 1
            ctx.audio.play(ctx.config(Sounds).win, volume=0.4)
