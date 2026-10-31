"""Demo host for the treant_small model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="treant_small_demo", title="treant_small demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
