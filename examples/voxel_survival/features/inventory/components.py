"""What an entity carries."""

from parallax import ContentRef, component, field
from project import Content

from game.content import ItemDef, Stack


@component("inventory")
class Inventory:
    """For the player, slots 0..8 are the hotbar."""
    size: int = field(36, min=1)
    slots: list[Stack] = field([], doc="Filled to `size` with empty stacks on spawn.")


@component("hotbar")
class Hotbar:
    size: int = field(9, min=1)
    selected: int = field(0, min=0)


@component("equipment")
class Equipment:
    """The tool used for mining and swinging, independent of the selected hotbar slot."""
    tool: ContentRef[ItemDef] = field(Content.item.bare_hands)


@component("furnace")
class Furnace:
    """A smelting job in progress or waiting to be collected."""
    output: Stack = field(Stack())
    seconds_left: float = field(0, unit="s")


@component("pickup")
class Pickup:
    """A stack lying in the world."""
    stack: Stack = field()
