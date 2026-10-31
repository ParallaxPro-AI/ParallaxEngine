from parallax import System, on, system

from game.events import BallLost, RunEnded, StageCleared
from game.progress import lives_left
from game.resources import Best, Run


@system("outcome")
class Outcome(System):
    """Ends the run when the last orb drops or the final stage is cleared and records
    the best score. `GameOverPanel` opens by itself once the run is over. Listed
    after `Scoring`, so the final clear bonus counts toward the best score."""

    @on(BallLost)
    def ball_lost(self, ctx, event: BallLost):
        ctx.get(Run).balls_lost += 1
        if lives_left(ctx) == 0:
            self.end(ctx, won=False)

    @on(StageCleared, where=lambda event: event.final)
    def gauntlet_cleared(self, ctx, event: StageCleared):
        self.end(ctx, won=True)

    def end(self, ctx, *, won: bool):
        run = ctx.get(Run)
        best = ctx.get(Best)
        run.won = won
        run.new_best = run.score > best.score
        best.score = max(best.score, run.score)
        ctx.emit(RunEnded(won=won))
