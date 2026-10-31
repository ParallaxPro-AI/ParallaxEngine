"""Demo host for the wall_safe model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wall_safe_demo", title="wall_safe demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
