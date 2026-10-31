"""Demo host for the hot_line model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hot_line_demo", title="hot_line demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
