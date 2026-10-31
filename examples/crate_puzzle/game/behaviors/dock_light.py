from parallax import Behavior, Color, Sprite, behavior, param, state
from parallax.grid import GridCell
from project import Assets

from game.components import Pad
from game.level import yard_grid


@behavior("dock_light", requires=[GridCell, Sprite])
class DockLight(Behavior):
    """Tints a crate green while it rests on a dock pad, with a burst the moment it
    lands there."""

    color: Color = param(Color.hex("#d99e52"))
    docked_color: Color = param(Color.hex("#75de85"))
    docked: bool = state(False)

    def start(self, ctx):
        self.docked = self.on_pad(ctx)

    def update(self, ctx, dt):
        docked = self.on_pad(ctx)
        if docked and not self.docked:
            ctx.vfx.play(Assets.vfx.dock_pop, at=self.entity)
        self.docked = docked
        self.entity.get(Sprite).color = self.docked_color if docked else self.color

    def on_pad(self, ctx) -> bool:
        cell = self.entity.get(GridCell).cell
        return yard_grid(ctx.world).first_at(cell, tagged=Pad) is not None
