"""Demo host for the reactor_core_column model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="reactor_core_column_demo", title="reactor_core_column demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
