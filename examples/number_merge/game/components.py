"""Per-entity data. A tile's place on the board is its `GridCell`; this is its number."""

from parallax import component, field


@component("tile")
class Tile:
    """A numbered tile."""
    value: int = field(2, min=2)
