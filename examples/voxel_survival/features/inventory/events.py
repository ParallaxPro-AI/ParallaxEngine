"""Inventory events. Panel buttons are plain functions (features/inventory/actions.py)."""

from parallax import ContentRef, Entity, Vec3, event

from game.content import ItemDef, Stack


@event("loot_dropped")
class LootDropped:
    """Stacks that should appear in the world at a point (mined blocks, dead mobs)."""
    stacks: list[Stack]
    at: Vec3


@event("item_crafted", target="by")
class ItemCrafted:
    item: ContentRef[ItemDef]
    by: Entity


@event("item_stored")
class ItemStored:
    item: ContentRef[ItemDef]
