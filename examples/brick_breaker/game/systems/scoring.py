from parallax import System, on, system
from parallax.combat import Damaged

from game.components import Brick
from game.config import Rules
from game.events import BallLaunched, BallLost, BallReturned, StageCleared
from game.resources import Mods, Run


@system("scoring")
class Scoring(System):
    """Scores every brick hit, with a combo bonus that grows until the orb next
    leaves the paddle, plus a bonus for clearing a stage."""

    @on(Damaged, where=lambda event: event.entity.has(Brick))
    def brick_hit(self, ctx, event: Damaged):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.combo += 1
        points = rules.brick_score + run.combo * rules.combo_score
        run.score += int(points * ctx.get(Mods).score_mult)

    @on(BallLaunched)
    def launched(self, ctx, event: BallLaunched):
        ctx.get(Run).combo = 0

    @on(BallLost)
    def lost(self, ctx, event: BallLost):
        """The next serve starts a fresh combo, as the template's serve did."""
        ctx.get(Run).combo = 0

    @on(BallReturned)
    def returned(self, ctx, event: BallReturned):
        ctx.get(Run).combo = 0

    @on(StageCleared)
    def stage_cleared(self, ctx, event: StageCleared):
        ctx.get(Run).score += ctx.config(Rules).clear_bonus
