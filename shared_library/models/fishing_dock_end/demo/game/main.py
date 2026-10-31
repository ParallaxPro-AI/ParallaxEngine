"""Demo host for the fishing_dock_end model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fishing_dock_end_demo", title="fishing_dock_end demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
