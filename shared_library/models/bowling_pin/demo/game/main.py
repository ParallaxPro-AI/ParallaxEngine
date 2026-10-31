"""Demo host for the bowling_pin model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bowling_pin_demo", title="bowling_pin demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
