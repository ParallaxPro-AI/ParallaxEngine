"""Cars: getting in and out, driving, crash damage and repair, the radio and the engine note.

What counts as stealing a car is the police feature's call; this one only says who got in what.
"""

from parallax import Feature
from project import Scenes

from features.driving.actions import DrivingControls
from features.driving.components import CarCondition
from features.driving.events import VehicleWrecked
from features.driving.queries import nearest_free_car, player_car
from features.driving.systems import Radio
from features.driving.tags import Lent

driving = Feature(
    "driving",
    requires=["on_foot", "phone"],
    systems=[Radio],
    scenes=[Scenes.sunset_bay],
    doc="Entering and driving vehicles, crash damage, the radio. Built on the vehicles plugin.",
)

__all__ = ["CarCondition", "DrivingControls", "Lent", "VehicleWrecked", "driving", "nearest_free_car", "player_car"]
