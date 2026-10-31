"""Demo host for the broken_column model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="broken_column_demo", title="broken_column demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
