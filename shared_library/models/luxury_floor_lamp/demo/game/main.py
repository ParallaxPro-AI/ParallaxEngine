"""Demo host for the luxury_floor_lamp model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="luxury_floor_lamp_demo", title="luxury_floor_lamp demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
