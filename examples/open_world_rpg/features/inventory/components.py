"""Per-entity inventory data."""

from parallax import ContentRef, component, field

from features.inventory.content import ItemDef


@component("pickup")
class Pickup:
    """Collected when the hero walks into its trigger: gold, items and a little experience."""

    gold: int = field(0, min=0)
    items: list[ContentRef[ItemDef]] = field([])
    xp: int = field(0, min=0)
