from parallax import System, on, system
from parallax.combat import Died
from project import Scenes

from game.components import Wisp
from game.events import RunEnded, WaveCleared
from game.resources import Best, Run


@system("outcome", scenes=[Scenes.garden])
class Outcome(System):
    """Ends the run when the Wisp's last petal falls or the Thornmother's wave is
    cleared, and keeps the career records the title screen dares you to beat.
    `ResultPanel` opens by itself once the run is over."""

    def start(self, ctx):
        ctx.get(Best).runs += 1

    @on(WaveCleared)
    def wave_cleared(self, ctx, event: WaveCleared):
        best = ctx.get(Best)
        best.wave = max(best.wave, ctx.get(Run).waves_cleared)
        if event.final:
            best.victories += 1
            self.end(ctx, won=True)

    @on(Died, where=lambda event: event.entity.has(Wisp))
    def wisp_fell(self, ctx, event: Died):
        self.end(ctx, won=False)

    def end(self, ctx, *, won: bool):
        run = ctx.get(Run)
        best = ctx.get(Best)
        run.won = won
        run.new_best = run.score > best.score
        best.score = max(best.score, run.score)
        best.graze = max(best.graze, run.graze)
        ctx.emit(RunEnded(won=won))
