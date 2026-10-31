"""What the hero owns. Profile tier: a new game keeps the purse, the bag, the gear and the upgrades."""

from parallax import ContentRef, field, resource
from project import Content

from features.inventory.content import GearDef, ItemDef, Slot, WareDef


@resource("purse", keep="profile")
class Purse:
    gold: int = field(0, min=0)


@resource("bag", keep="profile")
class Bag:
    items: dict[ContentRef[ItemDef], int] = field({}, doc="Item → how many.")


@resource("gear", keep="profile")
class Gear:
    """Every piece found so far, and what is worn in each slot."""

    owned: list[ContentRef[GearDef]] = field([Content.gear.wayfarer_blade, Content.gear.worn_coat])
    worn: dict[Slot, ContentRef[GearDef]] = field(
        {Slot.WEAPON: Content.gear.wayfarer_blade, Slot.ARMOR: Content.gear.worn_coat},
    )


@resource("upgrades", keep="profile")
class Upgrades:
    bought: dict[ContentRef[WareDef], int] = field({}, doc="Ware → times bought.")
