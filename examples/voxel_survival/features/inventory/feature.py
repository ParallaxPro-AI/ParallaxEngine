"""Inventory: stacks, the hotbar, crafting, chests, furnaces and items on the ground."""

from parallax import Feature
from project import Scenes

from features.inventory.actions import use_slot
from features.inventory.components import Equipment, Furnace, Hotbar, Inventory, Pickup
from features.inventory.events import ItemCrafted, ItemStored, LootDropped
from features.inventory.holding import give, selected, spend_selected
from features.inventory.stacks import count_of, is_empty, transact
from features.inventory.systems.loot import Loot
from features.inventory.systems.slot_padding import SlotPadding
from features.inventory.ui import ChestPanel, CraftingPanel, FurnacePanel, picture, stack_view

inventory = Feature(
    "inventory",
    systems=[SlotPadding, Loot],
    scenes=[Scenes.greenwood],
    doc="Stacks, hotbar, recipes, chests, furnaces and pickups.",
)

__all__ = [
    "inventory", "Inventory", "Hotbar", "Equipment", "Furnace", "Pickup",
    "CraftingPanel", "ChestPanel", "FurnacePanel", "stack_view", "picture", "use_slot",
    "LootDropped", "ItemCrafted", "ItemStored",
    "count_of", "is_empty", "transact", "give", "selected", "spend_selected",
]
