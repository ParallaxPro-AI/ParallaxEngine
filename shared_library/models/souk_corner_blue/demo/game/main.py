"""Demo host for the souk_corner_blue model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="souk_corner_blue_demo", title="souk_corner_blue demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
