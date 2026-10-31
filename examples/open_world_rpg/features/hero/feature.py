"""The hero: walking and dodging, health and mana recovery, experience, and rising again.

Everything another feature may use is imported here; nothing else in this folder is public.
"""

from parallax import Feature
from project import Scenes

from features.hero.actions import HeroControls
from features.hero.components import Dodge, Hero, Mana
from features.hero.config import HeroCurve
from features.hero.events import HeroRespawned, XpGained
from features.hero.progression import xp_to_next
from features.hero.resources import Checkpoint, Progression, Respawn
from features.hero.systems import Leveling, Respawning, rise_point

hero = Feature(
    "hero",
    systems=[Leveling, Respawning],
    scenes=[Scenes.sundermere],
    doc="The player character: movement, dodge, regeneration, experience and respawning at shrines.",
)

__all__ = [
    "Checkpoint", "Dodge", "Hero", "HeroControls", "HeroCurve", "HeroRespawned", "Mana", "Progression", "Respawn",
    "XpGained", "hero", "rise_point", "xp_to_next",
]
