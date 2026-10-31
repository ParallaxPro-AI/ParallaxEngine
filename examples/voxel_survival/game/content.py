"""Content registries: blocks, items, recipes, mobs and objectives.

One JSON file per entry under content/<kind>/. Blocks are what the world is made of;
items are what an inventory holds. A block item names the block it places, and a
block names the items it drops, so the two registries meet in exactly two fields.
"""

import random
from enum import Enum

from parallax import Color, ContentRef, Localized, PrefabRef, SoundRef, content, field, record
from parallax.voxels import BlockDef


class ToolKind(Enum):
    HAND = "hand"
    PICKAXE = "pickaxe"
    AXE = "axe"
    SHOVEL = "shovel"
    SWORD = "sword"


class Station(Enum):
    HAND = "hand"
    WORKBENCH = "workbench"
    FURNACE = "furnace"


class Category(Enum):
    TOOLS = "tools"
    BUILD = "build"
    FOOD = "food"


class Trigger(Enum):
    """What completes an objective."""
    MINED = "mined"
    MINED_ORE = "mined_ore"
    CRAFTED = "crafted"
    CRAFTED_TOOL = "crafted_tool"
    PLACED = "placed"
    STORED = "stored"
    HOME_SET = "home_set"
    NIGHT_SURVIVED = "night_survived"
    HARVESTED = "harvested"
    BEACON_HELD = "beacon_held"


@content("item")
class ItemDef:
    name: Localized
    icon: str = field("block", choices=["block", "torch", "food", "seeds", "ingot", "gem",
                                        "pickaxe", "axe", "shovel", "sword", "hand"])
    color: Color = field(Color.WHITE)
    stack_max: int = field(64, min=1)
    places: ContentRef["Block"] | None = field(None)
    hunger: float = field(0, doc="Hunger restored when eaten; food has hunger > 0.")
    heal: float = field(0, doc="Health restored when eaten; negative hurts.")
    tool: ToolKind | None = field(None)
    view: PrefabRef | None = field(None, doc="How it looks held in first person (the template's tool models).")
    tier: int = field(0, min=0)
    mine_speed: float = field(1, min=0, doc="Tool power against blocks that prefer this kind of tool.")
    damage: float = field(5, min=0)
    reach: float = field(5, unit="m")


@record
class Stack:
    """`count` of one item. The empty slot is `Stack()`."""
    item: ContentRef[ItemDef] | None = field(None)
    count: int = field(0, min=0)


@record
class Drop:
    """One line of a loot table."""
    item: ContentRef[ItemDef] = field()
    count: int = field(1, min=1)
    chance: float = field(1, min=0, max=1)


@content("block")
class Block(BlockDef):
    """The voxels plugin's block fields (name, texture, hardness, solid, prefab,
    prefab_renders, …) plus Greenwood's rules for mining, building and farming."""
    color: Color = field(doc="Tints the dust when the block breaks.")
    sound: SoundRef = field(doc="Played when mined or placed.")
    min_tier: int = field(0, min=0, doc="Weakest pickaxe tier that can break it.")
    unbreakable: bool = field(False)
    replaceable: bool = field(False, doc="Placing a block here overwrites it (water).")
    preferred_tool: ToolKind = field(ToolKind.PICKAXE)
    loot: list[Drop] = field([], doc="Rolled when the block is mined.")
    ore: bool = field(False)
    soil: bool = field(False, doc="Crops and saplings may be planted on top.")
    needs_soil: bool = field(False)
    needs_water_within: int = field(0, min=0, unit="blocks")
    upper: ContentRef["Block"] | None = field(None, doc="Second block placed above (doors).")
    is_upper: bool = field(False, doc="Mining it acts on the block below.")


@content("recipe", order="order")
class RecipeDef:
    name: Localized
    order: int = field()
    category: Category = field()
    station: Station = field(Station.HAND)
    inputs: list[Stack] = field([])
    output: Stack = field()
    seconds: float = field(0, unit="s", doc="> 0: smelted in a furnace instead of crafted at once.")


@content("mob")
class MobDef:
    name: Localized
    health: float = field(min=1)
    damage: float = field(min=0)
    attack_range: float = field(unit="m")
    attack_interval: float = field(unit="s")
    windup: float = field(0.65, unit="s", doc="Telegraph before a blow lands.")
    move_speed: float = field(unit="m/s")
    scale: float = field(1)
    color: Color = field(Color.WHITE)
    min_wave: int = field(1, min=1)
    weight: float = field(1, min=0)
    drops: list[Drop] = field([])


@content("objective", order="order")
class ObjectiveDef:
    text: Localized
    order: int = field()
    trigger: Trigger = field()
    item: ContentRef[ItemDef] | None = field(None, doc="Only this item counts (`crafted`).")


def roll(drops: list[Drop]) -> list[Stack]:
    """The stacks a loot table actually yields this time."""
    return [Stack(d.item, d.count) for d in drops if random.random() < d.chance]
