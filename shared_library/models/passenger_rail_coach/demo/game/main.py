"""Demo host for the passenger_rail_coach model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="passenger_rail_coach_demo", title="passenger_rail_coach demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
