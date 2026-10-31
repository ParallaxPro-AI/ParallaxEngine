import random

from parallax import Behavior, behavior, param
from parallax.grid import Cell
from project import Prefabs

from game.lawn import current_level, lawn


@behavior("sky_pollen")
class SkyPollen(Behavior):
    """Drops a pollen mote from the sky over a random open cell every `interval` seconds.
    Lives on a placed entity in the garden scene, so it stops when the scene ends."""

    interval: float = param(11, unit="s")
    amount: int = param(25, min=1)
    height: float = param(9, unit="m")

    def start(self, ctx):
        ctx.time.every(self.interval, lambda: self.drop(ctx))

    def drop(self, ctx):
        grid = lawn(ctx)
        cell = Cell(random.randrange(grid.cols), random.choice(current_level(ctx).lanes))
        ctx.world.spawn(
            Prefabs.pollen_mote,
            at=grid.center(cell).with_y(self.height),
            params={"pollen_mote": {"amount": self.amount}},
        )
