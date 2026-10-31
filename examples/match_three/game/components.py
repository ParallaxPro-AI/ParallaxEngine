"""Per-entity data: the gems on the board and the crust frozen onto its cells. Where
each one sits is its `GridCell`."""

from parallax import ContentRef, component, field

from game.content import GemDef
from game.match_logic import Special


@component("gem")
class Gem:
    """A gem. While it slides or falls, its `GridCell` is already its destination;
    the sprite catches up."""
    kind: ContentRef[GemDef] = field()
    special: Special = field(Special.NONE)


@component("crust")
class Crust:
    """Frozen crust on a cell. It belongs to the cell, not the gem: gems fall through
    it, and clearing the gem standing on it chips one layer."""
    layers: int = field(1, min=0)
