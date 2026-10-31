from parallax import Behavior, behavior, param
from parallax.combat import Health

from game.content import Stat
from game.rules import refit, sailing


@behavior("hull_regen", requires=[Health], when=sailing)
class HullRegen(Behavior):
    """At sea the carpenter mends the hull at `rate`; Bilge Pumps add to it."""

    rate: float = param(1, unit="1/s", doc="Hull points a second before any refit.")

    def update(self, ctx, dt):
        rate = self.rate + refit(ctx, Stat.HULL_REGEN)
        if rate > 0:
            self.entity.get(Health).heal(rate * dt)
