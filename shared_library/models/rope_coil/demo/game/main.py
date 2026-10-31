"""Demo host for the rope_coil model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rope_coil_demo", title="rope_coil demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
