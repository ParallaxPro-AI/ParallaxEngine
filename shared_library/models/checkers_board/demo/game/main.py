"""Demo host for the checkers_board model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="checkers_board_demo", title="checkers_board demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
