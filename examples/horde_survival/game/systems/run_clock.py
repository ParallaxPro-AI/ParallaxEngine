from parallax import System, system
from project import Scenes

from game.events import RunEnded
from game.resources import Run
from game.rules import Rules, run_live, scales


@system("run_clock", scenes=[Scenes.arena], when=run_live)
class RunClock(System):
    """The ember clock: survival points tick in, a lapsed kill chain snaps back to x1,
    and at the bell the circle holds."""

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.score += rules.survive_points * dt * scales(ctx).score
        if run.combo > 1 and ctx.time.now - run.last_kill_at > rules.combo_window:
            run.combo = 1.0
        if ctx.time.scene_time >= rules.run_seconds:
            ctx.emit(RunEnded(survived=True))
