from enum import Enum

from parallax import Behavior, Color, Shape, behavior, param

from features.player.components import Aim
from game.world import the_player


class Shows(Enum):
    TARGET = "target"
    """The aimed block, glowing hotter as it cracks."""
    PLACEMENT = "placement"
    """The cell the selected block would go into."""


@behavior("block_cursor", requires=[Shape])
class BlockCursor(Behavior):
    """A glass box on the aimed block, or (as the placement preview) on the cell the
    selected block would go into. Hidden while there is nothing to show."""

    shows: Shows = param(Shows.TARGET)
    color: Color = param(Color(1, 1, 1, 0.12))
    cracked: Color = param(Color.hex("#ff7a3d"), doc="Glow at the moment the block breaks.")

    def start(self, ctx):
        self.entity.get(Shape).color = self.color

    def late_update(self, ctx, dt):
        aim = the_player(ctx).get(Aim)
        cell = aim.cell if self.shows is Shows.TARGET else aim.place_cell
        self.entity.visible = cell is not None
        if cell is None:
            return
        self.entity.transform.position = cell.center()
        if self.shows is Shows.TARGET:
            self.entity.get(Shape).emissive = Color.BLACK.lerp(self.cracked, aim.progress)
