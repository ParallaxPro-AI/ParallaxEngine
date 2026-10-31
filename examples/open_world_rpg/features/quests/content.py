"""Chapters of the main story: the story plugin's quests, extended with what this game adds to them."""

from parallax import ContentRef, EntityRef, content, field
from parallax.story import QuestDef

from features.combat.feature import AbilityDef
from features.inventory.feature import ItemDef


@content("quest", order="number")
class Chapter(QuestDef):
    """One beat of the main story (content/quest/<id>.json), in story order.

    The plugin's fields carry the title, the steps, their objective text and markers; world.json wakes the
    chapter's layer while it is active. This game adds the shrine the hero rises at from now on, what
    finishing it pays, the ability it teaches, and whether it opens the Shadow Rift. The chapter after the
    last one is victory.
    """

    number: int = field(min=1)
    checkpoint: EntityRef | None = field(None, doc="Shrine the hero rises at from now on.")
    opens_rift: bool = field(False)
    reward_xp: int = field(0, min=0)
    reward_gold: int = field(0, min=0)
    reward_items: list[ContentRef[ItemDef]] = field([])
    teaches: ContentRef[AbilityDef] | None = field(None)
