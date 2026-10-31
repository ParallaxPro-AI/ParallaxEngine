"""Progress: the homestead objectives and lifetime stats."""

from parallax import Feature
from project import Scenes

from features.progress.resources import Lifetime, Progress, next_objective
from features.progress.systems.objectives import Objectives

progress = Feature(
    "progress",
    requires=["world", "inventory", "survival", "creatures"],
    systems=[Objectives],
    scenes=[Scenes.greenwood],
    doc="Objectives and lifetime stats.",
)

__all__ = ["progress", "Progress", "Lifetime", "next_objective"]
