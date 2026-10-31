"""Survival: hunger, air, eating, beds and dying."""

from parallax import Feature
from project import Scenes

from features.survival.components import Vitals
from features.survival.events import HomeSet, Slept
from features.survival.resources import Run
from features.survival.systems.respawning import Respawning

survival = Feature(
    "survival",
    requires=["inventory"],
    systems=[Respawning],
    scenes=[Scenes.greenwood],
    doc="Hunger, air, food, sleep, home and death.",
)

__all__ = ["survival", "Vitals", "Run", "HomeSet", "Slept"]
