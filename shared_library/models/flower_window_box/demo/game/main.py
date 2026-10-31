"""Demo host for the flower_window_box model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="flower_window_box_demo", title="flower_window_box demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
