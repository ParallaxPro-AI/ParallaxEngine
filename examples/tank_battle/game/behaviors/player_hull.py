from parallax import Behavior, behavior
from parallax.combat import Health
from parallax.vehicles import Vehicle

from game.resources import Loadout


@behavior("player_hull", requires=[Health, Vehicle])
class PlayerHull(Behavior):
    """Rolls out on each battlefield with the hull, armor and top speed the campaign
    has earned, stacked on the prefab's values as one "loadout" modifier each."""

    def start(self, ctx):
        loadout = ctx.get(Loadout)
        self.entity.modify(Health, "max", add=loadout.max_health, key="loadout")
        self.entity.modify(Health, "armor", add=loadout.resist, key="loadout")
        self.entity.modify(Vehicle, "max_speed", multiply=loadout.speed_mul, key="loadout")
        health = self.entity.get(Health)
        health.current = health.max
