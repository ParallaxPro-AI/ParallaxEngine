"""The main story: chapters (story-plugin quests with this game's rewards), NPC conversations, the journal and
the Shadow Rift.

Chapters (content/quest) carry titles, steps, objective text and markers from the story plugin, plus
the rewards, the respawn shrine, the ability taught and the rift; world.json wakes each chapter's layer
while it is active. Conversations live in story/*.yarn.
"""

from parallax import Feature
from project import Scenes

from features.quests.actions import QuestControls
from features.quests.config import ShadowRift
from features.quests.components import Merchant
from features.quests.content import Chapter
from features.quests.objectives import objective_line
from features.quests.resources import Doom, Ending, Focus, Outcome
from features.quests.rift import rift_running
from features.quests.systems import Chapters, Deadline, Interaction
from features.quests.ui import JournalPanel

quests = Feature(
    "quests",
    requires=["hero", "inventory", "combat"],
    systems=[Interaction, Chapters, Deadline],
    scenes=[Scenes.sundermere],
    doc="Chapters, talking to NPCs, the journal and the final countdown.",
)

__all__ = [
    "Chapter", "Doom", "Ending", "Focus", "JournalPanel", "Merchant", "Outcome", "QuestControls", "ShadowRift", "objective_line", "quests",
    "rift_running",
]
