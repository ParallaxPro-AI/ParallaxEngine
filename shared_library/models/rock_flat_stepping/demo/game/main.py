"""Demo host for the rock_flat_stepping model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rock_flat_stepping_demo", title="rock_flat_stepping demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
