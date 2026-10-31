from parallax import System, on, system
from parallax.combat import Damaged

from features.heroes.feature import Hero
from features.lanes.components import Aggressor
from game.config import MatchRules


@system("champion_aggression")
class ChampionAggression(System):
    """Marks a champion who hits an enemy champion as an aggressor for a few
    seconds; towers turn on aggressors in range."""

    @on(Damaged)
    def hit(self, ctx, event: Damaged):
        attacker = event.source
        if attacker is None or not attacker.has(Hero) or not event.entity.has(Hero):
            return
        attacker.add(Aggressor(until=ctx.time.now + ctx.config(MatchRules).tower_aggro))
