"""Demo host for the space_heater model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="space_heater_demo", title="space_heater demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
