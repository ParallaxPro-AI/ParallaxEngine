"""Gold, the bag, worn gear, the merchant's shop, pickups and potions.

Knows nothing about fighting: combat pays into the purse and reads worn gear through this surface.
"""

from parallax import Feature
from project import Scenes

from features.inventory.bag import give
from features.inventory.config import Economy
from features.inventory.content import GearDef, ItemDef, LootTableDef, Slot, Stat
from features.inventory.gear import grant_gear, worn_pieces
from features.inventory.loot import scatter_loot
from features.inventory.resources import Bag, Gear, Purse
from features.inventory.shop import upgrade_bonus
from features.inventory.systems import Pickups, Potions
from features.inventory.ui import GearPanel, ShopPanel

inventory = Feature(
    "inventory",
    requires=["hero"],
    systems=[Pickups, Potions],
    scenes=[Scenes.sundermere],
    doc="Purse, bag and gear; the merchant's wares and permanent upgrades; pickups; drinking potions.",
)

__all__ = [
    "Bag", "Economy", "Gear", "GearDef", "GearPanel", "ItemDef", "LootTableDef", "Purse", "ShopPanel", "Slot", "Stat",
    "give", "grant_gear", "inventory", "scatter_loot", "upgrade_bonus", "worn_pieces",
]
