from parallax import System, on, system
from project import Scenes

from game.config import Rules
from game.descent import award, mods
from game.events import SwapMade, WaveCleared
from game.resources import Run


@system("scoring", scenes=[Scenes.board])
class Scoring(System):
    """Spends a move per swap and scores every cascade wave. Each wave deeper in a
    cascade multiplies its clears by one more `chain_step`."""

    @on(SwapMade)
    def spend_move(self, ctx, event):
        run = ctx.get(Run)
        run.moves_left -= 1
        run.refunded = False

    @on(WaveCleared)
    def score_wave(self, ctx, event):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        bonus = mods(run)
        multiplier = 1 + (rules.chain_step + bonus.cascade_bonus) * (event.chain - 1)
        cleared = event.gems * rules.points_per_gem + event.crust * rules.points_per_crust
        award(ctx, cleared * multiplier + event.forged * rules.points_per_special)
        if event.forged and bonus.refund_on_special and not run.refunded:
            run.moves_left += 1
            run.refunded = True
