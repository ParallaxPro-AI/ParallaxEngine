"""Demo host for the tc_wall_long model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tc_wall_long_demo", title="tc_wall_long demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
