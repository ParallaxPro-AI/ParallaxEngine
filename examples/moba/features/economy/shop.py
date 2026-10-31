"""Shop arithmetic: upgrades are discounted by the components you already own."""

from typing import NamedTuple

from parallax import ContentRef

from game.content import ItemDef, StatBlock


class Quote(NamedTuple):
    price: int
    consumed: list[ContentRef[ItemDef]]


def quote(item: ContentRef[ItemDef], owned: list[ContentRef[ItemDef]]) -> Quote:
    """What `item` costs given `owned`: each owned component it builds from is
    consumed and its cost credited."""
    remaining = list(owned)
    consumed = []
    for part in item.data.builds_from:
        if part in remaining:
            remaining.remove(part)
            consumed.append(part)
    credit = sum(part.data.cost for part in consumed)
    return Quote(price=max(0, item.data.cost - credit), consumed=consumed)


def item_stats(owned: list[ContentRef[ItemDef]]) -> StatBlock:
    return sum((item.data.stats for item in owned), StatBlock())
