"""Contracts for Mara and Mike, and the services the jobs pay for (armour, repairs, a loading permit) and
saving at the safehouse.

Each contract is a story-plugin quest (content/quest) extended with its contact and pay, whose steps use this
feature's custom verbs — `in_car`, `pick_up`, `hold_still`, `lose_heat`, `deliver` — so jobs share the
quest tracker, markers, step events and save path with any other story. The getaway's runner exists only
while its quest is active (world.json).
"""

from parallax import Feature
from project import Scenes

from features.missions.actions import BoardControls, JobControls
from features.missions.config import JobRules
from features.missions.objective import objective
from features.missions.systems import GetawayClock, Jobs
from features.missions.ui import ContractsPanel

missions = Feature(
    "missions",
    requires=["interiors", "phone", "on_foot", "driving", "police"],
    systems=[Jobs, GetawayClock],
    scenes=[Scenes.sunset_bay],
    doc="The contract board, contract quests and their verbs, paid services and safehouse saves.",
)

__all__ = ["BoardControls", "ContractsPanel", "JobControls", "JobRules", "missions", "objective"]
