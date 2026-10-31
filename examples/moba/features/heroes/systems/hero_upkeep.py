from parallax import System, system
from parallax.combat import Health

from features.fighting.feature import Stats
from features.heroes.components import Hero, Mana
from features.heroes.progression import grant_xp
from game.config import MatchRules
from game.resources import playing


@system("hero_upkeep", when=playing)
class HeroUpkeep(System):
    """While the match runs, living champions regenerate mana and earn a trickle of XP."""

    def update(self, ctx, dt):
        xp = ctx.config(MatchRules).xp_per_second * dt
        for hero, _, mana, health, stats in ctx.world.query(Hero, Mana, Health, Stats):
            if health.dead:
                continue
            mana.current = min(stats.max_mana, mana.current + stats.mana_regen * dt)
            grant_xp(ctx, hero, xp)
