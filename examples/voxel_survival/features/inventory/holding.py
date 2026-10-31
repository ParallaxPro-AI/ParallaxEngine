"""Reading and spending what a player holds. Shared with the world and survival features."""

from parallax import ContentRef, Entity

from features.inventory.components import Hotbar, Inventory
from features.inventory.stacks import transact
from game.content import ItemDef, Stack


def selected(holder: Entity) -> Stack:
    return holder.get(Inventory).slots[holder.get(Hotbar).selected]


def spend_selected(holder: Entity) -> None:
    """Use up one of the selected item."""
    inventory = holder.get(Inventory)
    index = holder.get(Hotbar).selected
    stack = inventory.slots[index]
    slots = list(inventory.slots)
    slots[index] = Stack(stack.item, stack.count - 1) if stack.count > 1 else Stack()
    inventory.slots = slots


def give(holder: Entity, item: ContentRef[ItemDef], count: int) -> bool:
    """Add to the holder's inventory; False (and nothing changes) if it doesn't fit."""
    inventory = holder.get(Inventory)
    result = transact(inventory.slots, give=[Stack(item, count)])
    if result is None:
        return False
    inventory.slots = result
    return True
