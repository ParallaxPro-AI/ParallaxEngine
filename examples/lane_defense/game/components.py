"""Per-entity data and tags.

There is no grid array: a plant is a `Planted` entity with a `GridCell` on the lawn's
`Grid`, so "what's in this cell" is the grid's index and a destroyed plant frees its
cell without any bookkeeping.
"""

from parallax import ContentRef, component, field, tag

from game.content import HuskDef, PlantDef

Garden = tag("garden")
"""Side of every plant (combat sides: area damage never hurts your own side)."""
Husks = tag("husks")
"""Side of every husk."""
PollenMote = tag("pollen_mote")
"""A mote of pollen waiting to be collected (clicking one never uses the armed tool)."""


@component("planted")
class Planted:
    """A plant standing on the lawn (its cell is its `GridCell`)."""

    kind: ContentRef[PlantDef] = field()


@component("husk")
class Husk:
    """A husk walking one lane. Its tier's numbers are `kind.data`; `speed` starts as the
    tier's and a chill lowers it as a stat modifier."""

    kind: ContentRef[HuskDef] = field()
    lane: int = field(0, min=0)
    speed: float = field(0, unit="m/s", modifiable=True)
    vaulted: bool = field(False, doc="A sprinter that already hopped its plant (kept by checkpoints).")
    chewing: bool = field(False, doc="Stopped at a plant, biting (its legs stay still).")
