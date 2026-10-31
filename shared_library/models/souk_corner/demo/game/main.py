"""Demo host for the souk_corner model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="souk_corner_demo", title="souk_corner demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
