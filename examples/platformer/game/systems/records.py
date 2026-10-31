"""Per-level records on the profile."""

from parallax import System, on, system

from game.components import Level
from game.events import LevelFinished
from game.resources import Attempt, Profile


@system("records", scenes=[Level])
class Records(System):
    """The only writer of the per-level records. A cleared level keeps its best
    score, its best star count and the most keepsakes ever found in it."""

    @on(LevelFinished)
    def finished(self, ctx, event: LevelFinished):
        if not event.won:
            return
        attempt = ctx.get(Attempt)
        profile = ctx.get(Profile)
        level = event.level
        attempt.new_best = attempt.score > profile.best.get(level, 0)
        profile.best[level] = max(profile.best.get(level, 0), attempt.score)
        profile.stars[level] = max(profile.stars.get(level, 0), attempt.stars)
        profile.keepsakes[level] = max(profile.keepsakes.get(level, 0), attempt.keepsakes)
