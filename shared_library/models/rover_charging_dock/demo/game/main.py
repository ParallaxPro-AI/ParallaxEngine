"""Demo host for the rover_charging_dock model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rover_charging_dock_demo", title="rover_charging_dock demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
