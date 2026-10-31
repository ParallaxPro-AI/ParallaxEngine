from parallax import ContentRef, component, field
from parallax.voxels import Cell3

from game.content import Block


@component("aim")
class Aim:
    """What the crosshair is on, written by block_interact and read by the HUD and
    the block cursors."""
    cell: Cell3 | None = field(None)
    place_cell: Cell3 | None = field(None, doc="Where the selected block would go.")
    progress: float = field(0, min=0, max=1, doc="Mining progress on `cell`.")
    too_weak_for: ContentRef[Block] | None = field(None, doc="Set while the tool can't break `cell`.")
