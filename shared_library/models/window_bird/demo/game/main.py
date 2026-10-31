"""Demo host for the window_bird model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="window_bird_demo", title="window_bird demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
