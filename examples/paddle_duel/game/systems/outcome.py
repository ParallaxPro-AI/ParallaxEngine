from parallax import System, on, system

from game.events import DuelLost, DuelWon, RunEnded
from game.resources import Best, Run


@system("outcome")
class Outcome(System):
    """Ends the run when a rival wins a duel or the last rival falls and records the
    best score. `GameOverPanel` opens by itself once the run is over. Listed after
    `Scoring`, so the final duel bonus counts toward the best score."""

    @on(DuelLost)
    def duel_lost(self, ctx, event: DuelLost):
        self.end(ctx, won=False)

    @on(DuelWon, where=lambda event: event.final)
    def gauntlet_cleared(self, ctx, event: DuelWon):
        self.end(ctx, won=True)

    def end(self, ctx, *, won: bool):
        run = ctx.get(Run)
        best = ctx.get(Best)
        run.won = won
        best.score = max(best.score, run.score)
        ctx.emit(RunEnded(won=won))
