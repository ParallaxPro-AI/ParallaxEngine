"""Demo host for the camping_tent model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="camping_tent_demo", title="camping_tent demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
