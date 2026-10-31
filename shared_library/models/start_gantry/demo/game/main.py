"""Demo host for the start_gantry model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="start_gantry_demo", title="start_gantry demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
