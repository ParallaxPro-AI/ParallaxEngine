from parallax import Entity, event
from parallax.voxels import Cell3


@event("break_requested", target="by")
class BreakRequested:
    """The player finished mining `cell`; the world decides what happens."""
    cell: Cell3
    by: Entity


@event("place_requested", target="by")
class PlaceRequested:
    """The player wants their selected item placed in `cell`."""
    cell: Cell3
    by: Entity


@event("harvested", target="by")
class Harvested:
    by: Entity
