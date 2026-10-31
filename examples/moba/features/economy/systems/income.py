from parallax import System, system

from features.economy.components import Wallet
from features.economy.resources import Payday
from game.config import MatchRules
from game.resources import playing


@system("income", when=playing)
class Income(System):
    """Every champion earns a steady trickle of gold while the match runs."""

    def update(self, ctx, dt):
        if ctx.get(Payday).timer.tick(dt):
            for _, wallet in ctx.world.query(Wallet):
                wallet.gold += ctx.config(MatchRules).gold_per_second
