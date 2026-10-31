"""Demo host for the menu_board_aframe model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="menu_board_aframe_demo", title="menu_board_aframe demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
