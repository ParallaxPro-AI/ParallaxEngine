from parallax import Behavior, behavior
from parallax.combat import Health

from features.fighting.feature import Stats
from features.heroes.components import Fountain, Mana


@behavior("fountain_pool", requires=[Fountain])
class FountainPool(Behavior):
    """Rapidly restores health and mana to allied champions standing in it."""

    def update(self, ctx, dt):
        pool = self.entity.get(Fountain)
        for hero, health, mana, stats in ctx.world.query(Health, Mana, Stats).near(self.entity.transform.position, pool.radius):
            if health.dead or ctx.combat.are_enemies(self.entity, hero):
                continue
            health.heal(health.max * pool.health_per_second * dt)
            mana.current = min(stats.max_mana, mana.current + stats.max_mana * pool.mana_per_second * dt)
