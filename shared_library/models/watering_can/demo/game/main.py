"""Demo host for the watering_can model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="watering_can_demo", title="watering_can demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
