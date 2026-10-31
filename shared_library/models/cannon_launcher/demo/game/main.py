"""Demo host for the cannon_launcher model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cannon_launcher_demo", title="cannon_launcher demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
