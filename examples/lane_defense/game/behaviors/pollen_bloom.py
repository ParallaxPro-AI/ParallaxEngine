import math

from parallax import Behavior, Model, Settings, behavior, param, vec3
from parallax.grid import GridCell
from project import Prefabs

from game.components import Planted
from game.resources import Irrigation


@behavior("pollen_bloom", requires=[Planted, GridCell])
class PollenBloom(Behavior):
    """Grows a pollen mote every `interval` seconds; more on a watered row."""

    interval: float = param(22, unit="s")
    amount: int = param(25, min=1)
    watered_bonus: float = param(1.5, min=1)

    def start(self, ctx):
        ctx.time.every(self.interval, lambda: self.harvest(ctx))

    def harvest(self, ctx):
        watered = ctx.get(Irrigation).row == self.entity.get(GridCell).cell.row
        amount = round(self.amount * self.watered_bonus) if watered else self.amount
        if not ctx.get(Settings).reduced_motion:  # the template's harvest pulse
            model = self.entity.get(Model)
            model.pose("recoil", 0.16)
            model.pose("recoil", 0, seconds=0.28, ease="out_quad")
        ctx.world.spawn(
            Prefabs.pollen_mote,
            at=self.entity.transform.position + vec3(0, 1.4, 0),
            params={"pollen_mote": {"amount": amount}},
        )
