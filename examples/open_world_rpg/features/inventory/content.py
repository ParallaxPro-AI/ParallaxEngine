"""Items, gear, the merchant's wares and loot tables."""

from enum import Enum

from parallax import ContentRef, Localized, PrefabRef, Tag, content, field, record


class Slot(Enum):
    WEAPON = "weapon"
    ARMOR = "armor"
    CHARM = "charm"


class Stat(Enum):
    """What a merchant's upgrade raises."""

    MAX_HEALTH = "max_health"
    MAX_MANA = "max_mana"
    DAMAGE = "damage"
    ATTACK_RATE = "attack_rate"
    DEFENSE = "defense"


@content("item")
class ItemDef:
    """A consumable carried in the bag."""

    name: Localized = field()
    heal: float = field(0, min=0)
    mana: float = field(0, min=0)


@content("gear")
class GearDef:
    """A piece worn in one slot. Its stats add to the hero's; `element` sets the sword's damage kind."""

    name: Localized = field()
    slot: Slot = field(Slot.WEAPON)
    tier: int = field(1, min=1, doc="A drop is worn at once when it out-tiers the worn piece.")
    damage: float = field(0)
    attack_rate: float = field(0, unit="swings/s")
    defense: float = field(0)
    max_health: float = field(0)
    max_mana: float = field(0)
    element: Tag | None = field(None, doc="Elemental weapons are never auto-equipped: that is the player's call.")


@content("ware", order="order")
class WareDef:
    """A line in the merchant's stock: a consumable (`item`) or a permanent upgrade (`stat` + `amount`)."""

    order: int = field(1, min=1, doc="Place on the merchant's shelf.")
    name: Localized = field()
    description: Localized = field()
    price: int = field(min=0)
    price_step: int = field(0, min=0, doc="Added to the price each time it is bought.")
    min_level: int = field(1, min=1)
    item: ContentRef[ItemDef] | None = field(None)
    stat: Stat | None = field(None)
    amount: float = field(0)


@record
class LootEntry:
    """One weighted outcome of a loot roll. No prefab means the roll drops nothing."""

    weight: float = field(min=0)
    prefab: PrefabRef | None = field(None)


@content("loot_table")
class LootTableDef:
    """Weighted drops rolled when an enemy dies."""

    rolls: int = field(1, min=1)
    scatter: float = field(1.5, unit="m")
    entries: list[LootEntry] = field([])
