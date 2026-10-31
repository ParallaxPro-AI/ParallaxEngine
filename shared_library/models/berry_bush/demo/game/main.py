"""Demo host for the berry_bush model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="berry_bush_demo", title="berry_bush demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
