from parallax import System, clamp, move_toward, on, system
from project import Scenes

from game.config import PaceTuning
from game.events import GobblerCaught, LevelCleared, StalkerEaten
from game.resources import Pace


@system("pace", scenes=[Scenes.maze])
class PaceTuner(System):
    """Adaptive difficulty. Getting caught eases the Stalkers; eating them or clearing
    a level quickly pushes the pace up; a slow clear eases it. Each nudge moves the
    target, and the pace settles on it over `smooth_seconds`; between nudges the target
    drifts back toward its start."""

    def update(self, ctx, dt):
        pace = ctx.get(Pace)
        tuning = ctx.config(PaceTuning)
        pace.target = move_toward(pace.target, tuning.start, tuning.drift_per_minute / 60 * dt)
        pace.level += (pace.target - pace.level) * min(1.0, dt / tuning.smooth_seconds)

    @on(GobblerCaught)
    def caught(self, ctx, event: GobblerCaught):
        self.nudge(ctx, ctx.config(PaceTuning).on_caught)

    @on(StalkerEaten)
    def stalker_eaten(self, ctx, event: StalkerEaten):
        self.nudge(ctx, ctx.config(PaceTuning).on_stalker_eaten)

    @on(LevelCleared)
    def level_cleared(self, ctx, event: LevelCleared):
        tuning = ctx.config(PaceTuning)
        if event.seconds < tuning.fast_clear_seconds:
            self.nudge(ctx, tuning.on_fast_clear)
        elif event.seconds > tuning.slow_clear_seconds:
            self.nudge(ctx, tuning.on_slow_clear)

    def nudge(self, ctx, amount: float):
        pace = ctx.get(Pace)
        tuning = ctx.config(PaceTuning)
        pace.target = clamp(pace.target + amount, tuning.lowest, tuning.highest)
