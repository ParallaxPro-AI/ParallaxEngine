from parallax import Behavior, Color, Shape, behavior, param

from game.lawn import lane_z, lawn, tool_fits
from game.resources import Irrigation, Planting, Tool


@behavior("cell_highlight", requires=[Shape])
class CellHighlight(Behavior):
    """Marks the hovered cell while a tool is armed: green where it would work, red
    where it would not, aqua for the watering can."""

    fits: Color = param(Color.hex("#aaf39580"))
    blocked: Color = param(Color.hex("#ff959580"))
    water: Color = param(Color.hex("#aaf3e780"))

    def update(self, ctx, dt):
        planting = ctx.get(Planting)
        self.entity.visible = planting.tool is not Tool.NONE and planting.hover is not None
        if not self.entity.visible:
            return
        self.entity.transform.position = lawn(ctx).center(planting.hover).with_y(0.14)
        if not tool_fits(ctx, planting.hover):
            color = self.blocked
        else:
            color = self.water if planting.tool is Tool.WATER else self.fits
        self.entity.get(Shape).color = color


@behavior("water_strip")
class WaterStrip(Behavior):
    """Lies along the watered row."""

    def update(self, ctx, dt):
        row = ctx.get(Irrigation).row
        self.entity.visible = row >= 0
        if row >= 0:
            self.entity.transform.position = self.entity.transform.position.with_z(lane_z(ctx, row))
