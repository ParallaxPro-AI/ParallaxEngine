from parallax import Behavior, behavior, on

from features.inventory.components import Inventory
from features.inventory.resources import OpenStation
from game.events import Used


@behavior("chest", requires=[Inventory])
class Chest(Behavior):
    """Using a chest makes it the open station, so the chest panel shows it."""

    @on(Used)
    def used(self, ctx, event: Used):
        ctx.get(OpenStation).station = self.entity
