from parallax import System, on, system

from game.events import GobblerCaught, LevelCleared, RunEnded
from game.progress import lives_left
from game.resources import Best, Run


@system("outcome")
class Outcome(System):
    """Ends the run when the last life is lost or the deepest level is cleared, and
    keeps the career records: best score and deepest level. `ResultPanel` opens by
    itself once the run is over."""

    @on(GobblerCaught)
    def caught(self, ctx, event: GobblerCaught):
        ctx.get(Run).lives_lost += 1
        if lives_left(ctx) == 0:
            self.end(ctx, won=False)

    @on(LevelCleared)
    def level_cleared(self, ctx, event: LevelCleared):
        best = ctx.get(Best)
        best.level = max(best.level, ctx.get(Run).level_index + 1)
        if event.final:
            self.end(ctx, won=True)

    def end(self, ctx, *, won: bool):
        run = ctx.get(Run)
        best = ctx.get(Best)
        run.won = won
        run.new_best = run.score > best.score
        best.score = max(best.score, run.score)
        ctx.emit(RunEnded(won=won))
