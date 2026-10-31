"""Demo host for the basic_dining_chair model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="basic_dining_chair_demo", title="basic_dining_chair demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
