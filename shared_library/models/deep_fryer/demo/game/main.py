"""Demo host for the deep_fryer model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="deep_fryer_demo", title="deep_fryer demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
