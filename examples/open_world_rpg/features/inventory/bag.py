"""Putting things in the bag and taking them out."""

from parallax import Context, ContentRef

from features.inventory.content import ItemDef
from features.inventory.resources import Bag


def give(ctx: Context, item: ContentRef[ItemDef], count: int = 1) -> None:
    items = ctx.get(Bag).items
    items[item] = items.get(item, 0) + count


def take(ctx: Context, item: ContentRef[ItemDef]) -> bool:
    """Removes one; False if there was none."""
    items = ctx.get(Bag).items
    if items.get(item, 0) == 0:
        return False
    items[item] -= 1
    return True
