"""Demo host for the fruit_bowl model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fruit_bowl_demo", title="fruit_bowl demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
