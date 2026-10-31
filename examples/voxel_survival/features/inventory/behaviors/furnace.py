from parallax import Behavior, Light, behavior, on, param

from features.inventory.components import Furnace
from features.inventory.resources import OpenStation
from game.events import Used


@behavior("furnace", requires=[Furnace, Light])
class FurnaceBurner(Behavior):
    """Counts down the smelting job and glows while it burns. Using the furnace
    makes it the open station, so the furnace panel shows it."""

    glow: float = param(2.5, doc="Light intensity while smelting.")

    def update(self, ctx, dt):
        furnace = self.entity.get(Furnace)
        furnace.seconds_left = max(0.0, furnace.seconds_left - dt)
        self.entity.get(Light).intensity = self.glow if furnace.seconds_left > 0 else 0

    @on(Used)
    def used(self, ctx, event: Used):
        ctx.get(OpenStation).station = self.entity
