"""Tags and per-entity data. Where a piece stands and how it moves are the grid
plugin's `GridCell` and `GridMover`."""

from parallax import ContentRef, component, field, tag
from parallax.values import Cell

from game.content import StalkerDef

Wall = tag("wall")
Pip = tag("pip")
Flare = tag("flare")  # flares are pips too: every flare also carries Pip
Gobbler = tag("gobbler")


@component("home")
class Home:
    """The cell a mover returns to at the start of every round."""
    cell: Cell = field()


@component("stalker")
class Stalker:
    kind: ContentRef[StalkerDef] = field()
    eaten: bool = field(False, doc="Eaten Stalkers race back to the door to revive.")
