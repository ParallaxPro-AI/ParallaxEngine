from parallax import System, on, system
from project import Scenes

from game.config import Rules

from game.events import MatchEnded
from game.resources import Match, Record, Result


@system("results", scenes=[Scenes.well])
class Results(System):
    """Banks each finished match in the lifetime record. The result card opens by
    itself once the last disc has landed (`GameOver`'s `when=`)."""

    @on(MatchEnded)
    def conclude(self, ctx, event: MatchEnded):
        record = ctx.get(Record)
        ctx.get(Match).streak_before = record.streak
        if event.result is Result.WIN:
            record.wins += 1
            record.streak += 1
            record.best_streak = max(record.best_streak, record.streak)
            ctx.audio.play(ctx.config(Rules).sounds.win, volume=0.5)
        elif event.result is Result.LOSS:
            record.losses += 1
            record.streak = 0
            ctx.audio.play(ctx.config(Rules).sounds.lose, volume=0.45)
        else:
            record.draws += 1
            record.streak = 0
