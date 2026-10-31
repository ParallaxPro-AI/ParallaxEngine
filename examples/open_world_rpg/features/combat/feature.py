"""Fighting: the hero's sword and spells, telegraphed enemy encounters, weaknesses, and what kills pay.

Every blow is a plain `Health.damage`; dodges (`Health.protect`), weaknesses (the `weakness` modifier) and
armour (`Health.flat_armor`, with the plugin's minimum hit) live in the combat plugin's pipeline, so
nothing can skip them.
"""

from parallax import Feature
from project import Scenes

from features.combat.components import Spellbook, Threat
from features.combat.content import AbilityDef
from features.combat.modifiers import weakness
from features.combat.resources import HeroHurt, RunStats
from features.combat.systems import Bounties, CombatFeedback, Loadout
from features.combat.tags import Boss, Hostile, Physical, Telegraph

combat = Feature(
    "combat",
    requires=["hero", "inventory"],
    systems=[Loadout, Bounties, CombatFeedback],
    scenes=[Scenes.sundermere],
    doc="Sword and spells, enemy encounters with telegraphed attacks, damage kinds and kill rewards.",
)

__all__ = [
    "AbilityDef", "Boss", "HeroHurt", "Hostile", "Physical", "RunStats", "Spellbook",
    "Telegraph", "Threat", "combat", "weakness",
]
